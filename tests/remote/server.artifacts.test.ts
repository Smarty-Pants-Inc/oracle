import { describe, expect, test, vi } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readdir, rm, readFile, stat } from "node:fs/promises";
import { createRemoteServer } from "../../src/remote/server.js";
import {
  REMOTE_HEALTH_CLIENT_NONCE_HEADER,
  REMOTE_PROTOCOL_HEADER,
  REMOTE_REQUEST_PROOF_HEADER,
  REMOTE_SERVER_GENERATION_HEADER,
  RemoteRequestAuthenticator,
  createRemoteHealthAuthenticationProof,
} from "../../src/remote/auth.js";
import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import { createRemoteBrowserExecutor } from "../../src/remote/client.js";
import type { BrowserRunResult } from "../../src/browserMode.js";
import type { BrowserRunTransaction } from "../../src/browser/types.js";
import { writeBinaryBrowserArtifact } from "../../src/browser/artifacts.js";
import {
  MAX_REMOTE_ARTIFACT_BYTES,
  MAX_REMOTE_ATTACHMENT_BYTES,
  MAX_REMOTE_ATTACHMENTS,
  MAX_REMOTE_PROMPT_CHARS,
  MAX_REMOTE_REQUEST_BYTES,
  MAX_REMOTE_TOTAL_ATTACHMENT_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  type RemoteArtifactDescriptor,
} from "../../src/remote/types.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import {
  completedBrowserCaptureCleanup,
  type BrowserCaptureSettlementAdapters,
} from "../../src/browser/runLifecycle.js";
import {
  CAN_LISTEN_LOCALHOST,
  browserTransaction,
  committedPromptEpoch,
  createArtifactDescriptor,
  lifecycleBrowserTransaction,
} from "./serverTestBuilders.js";
import { httpPostJson, readIncomingBody } from "./serverTestHttp.js";
import { remoteRecoveryTransactionToken } from "./serverTestTransactions.js";

describe("remote browser service", { timeout: 15_000 }, () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "keeps an artifact-bearing staged capture recoverable when registration fails",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-pending-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const missingArtifactPath = path.join(
        tmpDir,
        "sessions",
        "artifact-pending-session",
        "artifacts",
        "missing.zip",
      );
      const runtime: BrowserRunTransaction["runtime"] = {
        chromeTargetId: "artifact-pending-target",
        recoveryCleanupResources: [
          {
            chromeTargetId: "artifact-pending-target",
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      setOracleHomeDirOverrideForTest(tmpDir);
      await mkdir(path.dirname(missingArtifactPath), { recursive: true });
      const settleResources = vi.fn<BrowserCaptureSettlementAdapters["settleResources"]>(
        async (_mode, pendingRuntime) => completedBrowserCaptureCleanup(pendingRuntime),
      );
      const resumeBrowser = vi.fn(async (recoveryRuntime: BrowserRunTransaction["runtime"]) => {
        throw new BrowserAutomationError("Required artifact registration remains unavailable", {
          stage: "remote-artifact-preparation",
          code: "remote-artifact-preparation-pending",
          recoverableDisconnect: true,
          runtime: recoveryRuntime,
        });
      });
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          resumeBrowser,
          runBrowser: async (options) =>
            lifecycleBrowserTransaction(
              options.prompt,
              {
                answerText: "captured before artifact failure",
                answerMarkdown: "captured before artifact failure",
                tookMs: 1,
                answerTokens: 4,
                answerChars: 32,
                savedFiles: [
                  {
                    kind: "file",
                    path: missingArtifactPath,
                    label: "missing required artifact",
                    mimeType: "application/zip",
                    sizeBytes: 22,
                    sourceUrl: "sandbox:/mnt/data/missing.zip",
                    url: "browser-download",
                    finalUrl: "browser-download",
                    filename: "missing.zip",
                  },
                ],
              },
              runtime,
              options.runtimeHintCb,
              settleResources,
            ),
        },
      );

      try {
        const caught = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        })({ prompt: "preserve answer after artifact failure", config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(caught).toMatchObject({
          name: "BrowserAutomationError",
          details: {
            code: "remote-artifact-manifest-incomplete",
            recoverableDisconnect: true,
          },
        });
        const transactionToken = remoteRecoveryTransactionToken(caught);
        const pendingRecord = await RemoteTransactionStore.open({
          directory: transactionStoreDir,
        }).then((store) => store.read(transactionToken));
        expect(pendingRecord).toMatchObject({
          state: "recoverable-error",
          error: {
            code: "remote-artifact-manifest-incomplete",
            recoverableDisconnect: true,
          },
          stagedCapture: {
            result: {
              answerText: "captured before artifact failure",
              warnings: [expect.objectContaining({ code: "remote-artifact-preparation-pending" })],
            },
          },
        });
        expect(pendingRecord).not.toHaveProperty("result");
        expect(pendingRecord).not.toHaveProperty("artifacts");
        expect(pendingRecord?.stagedCapture).not.toHaveProperty("artifacts");
        expect(settleResources).not.toHaveBeenCalled();

        const retry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/retry`,
          token: "secret",
          body: {},
        });
        expect(retry).toMatchObject({
          statusCode: 200,
          json: {
            status: "error",
            error: {
              code: "remote-artifact-preparation-pending",
              recoverableDisconnect: true,
            },
          },
        });
        expect(resumeBrowser).toHaveBeenCalledOnce();
        const afterRetry = await RemoteTransactionStore.open({
          directory: transactionStoreDir,
        }).then((store) => store.read(transactionToken));
        expect(afterRetry).toMatchObject({ state: "recoverable-error" });
        expect(afterRetry).not.toHaveProperty("result");
        expect(afterRetry?.stagedCapture).not.toHaveProperty("artifacts");
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "does not promote an artifact-bearing capture when manifest enrichment cannot persist",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-enrichment-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const artifactPayload = Buffer.from([
        0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      const runtime: BrowserRunTransaction["runtime"] = {
        chromeTargetId: "artifact-enrichment-target",
        recoveryCleanupResources: [
          {
            chromeTargetId: "artifact-enrichment-target",
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      setOracleHomeDirOverrideForTest(tmpDir);
      const originalStageCapture = RemoteTransactionStore.prototype.stageCapture;
      const stageCapture = vi
        .spyOn(RemoteTransactionStore.prototype, "stageCapture")
        .mockImplementation(function (
          this: RemoteTransactionStore,
          params: Parameters<RemoteTransactionStore["stageCapture"]>[0],
        ) {
          if (params.artifacts?.length) {
            return Promise.reject(new Error("simulated artifact manifest persistence failure"));
          }
          return originalStageCapture.call(this, params);
        });
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async (options) => {
            const artifact = await writeBinaryBrowserArtifact({
              sessionId: options.sessionId,
              artifactWriteAuthority: options.artifactWriteAuthority,
              kind: "file",
              filename: "result.zip",
              contents: artifactPayload,
              label: "result.zip",
              mimeType: "application/zip",
              sourceUrl: "sandbox:/mnt/data/result.zip",
            });
            if (!artifact) throw new Error("Expected artifact enrichment fixture");
            const result: BrowserRunResult = {
              answerText: "artifact enrichment answer",
              answerMarkdown: "artifact enrichment answer",
              tookMs: 1,
              answerTokens: 3,
              answerChars: 26,
              savedFiles: [
                {
                  ...artifact,
                  kind: "file",
                  url: "browser-download",
                  finalUrl: "browser-download",
                  filename: path.basename(artifact.path),
                },
              ],
            };
            const transaction = browserTransaction(options.prompt, result, runtime);
            await options.preArchiveCaptureCb?.(result, transaction.runtime);
            return transaction;
          },
        },
      );

      try {
        const caught = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        })({ prompt: "artifact enrichment persistence", config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(caught).toMatchObject({
          name: "BrowserAutomationError",
          details: {
            code: "remote-artifact-manifest-incomplete",
            recoverableDisconnect: true,
          },
        });
        const transactionToken = remoteRecoveryTransactionToken(caught);
        const record = await RemoteTransactionStore.open({
          directory: transactionStoreDir,
        }).then((store) => store.read(transactionToken));
        expect(record).toMatchObject({
          state: "recoverable-error",
          stagedCapture: { result: { answerText: "artifact enrichment answer" } },
        });
        expect(record).not.toHaveProperty("result");
        expect(record).not.toHaveProperty("artifacts");
        expect(record?.stagedCapture).not.toHaveProperty("artifacts");
        expect(stageCapture.mock.calls.filter(([params]) => params.artifacts?.length)).toHaveLength(
          2,
        );
      } finally {
        stageCapture.mockRestore();
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
  );
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "transfers saved browser file artifacts to the client session directory",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-test-"));
      const clientHome = path.join(tmpDir, "client-home");
      setOracleHomeDirOverrideForTest(clientHome);
      const hostArtifactPaths: string[] = [];
      const emptyZip = Buffer.from([
        0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);

      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async (options) => {
            const firstHostArtifact = await writeBinaryBrowserArtifact({
              sessionId: options.sessionId,
              artifactWriteAuthority: options.artifactWriteAuthority,
              kind: "file",
              filename: "host-result.zip",
              contents: emptyZip,
              label: "Download",
              mimeType: "application/octet-stream",
              sourceUrl: "sandbox:/mnt/data/result.zip",
            });
            const secondHostArtifact = await writeBinaryBrowserArtifact({
              sessionId: options.sessionId,
              artifactWriteAuthority: options.artifactWriteAuthority,
              kind: "file",
              filename: "host-result.zip",
              contents: emptyZip,
              label: "Download another result",
              mimeType: "application/zip",
              sourceUrl: "sandbox:/mnt/data/result.zip",
            });
            if (!firstHostArtifact || !secondHostArtifact) {
              throw new Error("Expected exact host artifact fixtures");
            }
            hostArtifactPaths.push(firstHostArtifact.path, secondHostArtifact.path);
            const result: BrowserRunResult = {
              answerText: "done",
              answerMarkdown: "done",
              tookMs: 1000,
              answerTokens: 1,
              answerChars: 4,
              savedFiles: [
                {
                  ...firstHostArtifact,
                  kind: "file",
                  url: "browser-download",
                  finalUrl: "browser-download",
                  filename: path.basename(firstHostArtifact.path),
                },
                {
                  ...secondHostArtifact,
                  kind: "file",
                  url: "browser-download",
                  finalUrl: "browser-download",
                  filename: path.basename(secondHostArtifact.path),
                },
              ],
              artifacts: [
                {
                  ...firstHostArtifact,
                  kind: "file",
                  label: "result.zip",
                  mimeType: "application/zip",
                },
              ],
              warnings: [
                {
                  code: "chatgpt-ui-warning",
                  severity: "warning",
                  message: "host-only warning /Users/private/profile",
                },
              ],
            };
            return browserTransaction(options.prompt, result);
          },
        },
      );

      const executor = createRemoteBrowserExecutor({
        host: `127.0.0.1:${server.port}`,
        token: "secret",
      });
      const result = await executor({
        prompt: "remote",
        config: {},
        sessionId: "remote-artifact-session",
      });

      expect(result.answerText).toBe("done");
      await result.finalize();
      expect(result.warnings).toEqual([
        {
          code: "chatgpt-ui-warning",
          severity: "warning",
          message: "Remote browser host reported a warning.",
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("host-only warning /Users/private/profile");
      expect(result.artifacts).toHaveLength(2);
      const artifactsDir = path.join(
        clientHome,
        "sessions",
        "remote-artifact-session",
        "artifacts",
      );
      const artifact = result.artifacts?.[0];
      expect(path.dirname(artifact!.path)).toBe(artifactsDir);
      expect(path.basename(artifact!.path)).toMatch(/^artifact-[A-Za-z0-9_-]+\.zip$/u);
      expect(artifact?.path).not.toBe(hostArtifactPaths[0]);
      expect(artifact).toMatchObject({
        kind: "file",
        label: "host-result.zip",
        mimeType: "application/octet-stream",
        sizeBytes: emptyZip.length,
        sourceUrl: "bridge-artifact",
        validation: { type: "zip", ok: true },
        transfer: { status: "completed", bytes: emptyZip.length },
        origin: { mode: "bridge" },
      });
      expect(artifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
      await expect(readFile(artifact!.path)).resolves.toEqual(emptyZip);
      const duplicate = result.artifacts?.[1];
      expect(path.dirname(duplicate!.path)).toBe(artifactsDir);
      expect(path.basename(duplicate!.path)).toMatch(/^artifact-[A-Za-z0-9_-]+\.zip$/u);
      expect(duplicate!.path).not.toBe(artifact!.path);
      expect(duplicate).toMatchObject({
        kind: "file",
        label: "host-result-2.zip",
        filename: expect.stringMatching(/^artifact-[A-Za-z0-9_-]+\.zip$/u),
      });
      await expect(readFile(duplicate!.path)).resolves.toEqual(emptyZip);
      await expect(stat(hostArtifactPaths[0]!)).resolves.toMatchObject({ size: emptyZip.length });
      await expect(stat(hostArtifactPaths[1]!)).resolves.toMatchObject({ size: emptyZip.length });

      await server.close();
      await rm(tmpDir, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    },
    15_000,
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "rejects untrusted artifact identifiers before creating local paths",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-invalid-artifact-"));
      setOracleHomeDirOverrideForTest(tmpDir);
      const payload = Buffer.from("zip");
      const bridge = await createFakeArtifactBridge({
        descriptor: createArtifactDescriptor(payload, { artifactId: "../../escape" }),
        payload,
      });

      try {
        await expect(
          createRemoteBrowserExecutor({
            host: `127.0.0.1:${bridge.port}`,
            token: "secret",
          })({ prompt: "remote", config: {}, sessionId: "invalid-artifact-session" }),
        ).rejects.toMatchObject({
          name: "BrowserAutomationError",
          details: {
            stage: "remote-protocol",
            recoverableDisconnect: true,
            runtime: {
              recoveryCleanupResources: [
                {
                  recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
                  remoteRecovery: { state: "recoverable-error" },
                },
              ],
            },
          },
        });
        expect(bridge.artifactRequests()).toBe(0);
      } finally {
        await bridge.close();
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "rejects a durable receipt bound to a different transaction token",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-token-binding-"));
      setOracleHomeDirOverrideForTest(tmpDir);
      const payload = Buffer.from("zip");
      const bridge = await createFakeArtifactBridge({
        descriptor: createArtifactDescriptor(payload),
        payload,
        transactionTokenOverride: "f".repeat(64),
      });

      try {
        await expect(
          createRemoteBrowserExecutor({
            host: `127.0.0.1:${bridge.port}`,
            token: "secret",
          })({ prompt: "remote", config: {}, sessionId: "wrong-token-session" }),
        ).rejects.toMatchObject({
          name: "BrowserAutomationError",
          details: {
            stage: "remote-protocol",
            recoverableDisconnect: true,
            runtime: {
              recoveryCleanupResources: [
                {
                  recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
                  remoteRecovery: { state: "recoverable-error" },
                },
              ],
            },
          },
        });
        expect(bridge.artifactRequests()).toBe(0);
      } finally {
        await bridge.close();
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
  );
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "stops chunked artifact downloads that exceed the declared size",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-oversize-artifact-"));
      setOracleHomeDirOverrideForTest(tmpDir);
      const declared = Buffer.from("zip");
      const bridge = await createFakeArtifactBridge({
        descriptor: createArtifactDescriptor(declared),
        payload: Buffer.from("zip plus undeclared bytes"),
      });

      try {
        await expect(
          createRemoteBrowserExecutor({
            host: `127.0.0.1:${bridge.port}`,
            token: "secret",
          })({ prompt: "remote", config: {}, sessionId: "oversize-artifact-session" }),
        ).rejects.toMatchObject({
          name: "BrowserAutomationError",
          message: expect.stringContaining("artifact exceeded declared size"),
          details: {
            stage: "remote-artifact-transfer",
            recoverableDisconnect: true,
            runtime: {
              recoveryCleanupResources: [
                {
                  recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
                  remoteRecovery: { state: "pending" },
                },
              ],
            },
          },
        });
        expect(bridge.artifactRequests()).toBe(1);
        const artifactDir = path.join(tmpDir, "sessions", "oversize-artifact-session", "artifacts");
        expect(await readdir(artifactDir).catch(() => [])).toEqual([]);
      } finally {
        await bridge.close();
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
  );
});
function createAuthenticatedTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>,
): http.Server {
  const rootKey = "secret";
  const serverGeneration = "remote-server-test-generation";
  const authenticator = new RemoteRequestAuthenticator({ rootKey, serverGeneration });
  const server = http.createServer();
  server.on("checkContinue", (req, res) => {
    const authentication = authenticator.authenticate(req);
    if ("statusCode" in authentication) {
      res.writeHead(authentication.statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: authentication.code }));
      return;
    }
    res.writeEarlyHints({
      link: "</health>; rel=preconnect",
      [REMOTE_SERVER_GENERATION_HEADER]: authentication.serverGeneration,
      [REMOTE_REQUEST_PROOF_HEADER]: authentication.requestProof,
    });
    res.writeContinue();
    server.emit("request", req, res);
  });
  server.on("request", (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const protocol = String(req.headers[REMOTE_PROTOCOL_HEADER] ?? "");
      const clientNonce = String(req.headers[REMOTE_HEALTH_CLIENT_NONCE_HEADER] ?? "");
      if (
        protocol !== String(REMOTE_TRANSACTION_PROTOCOL_VERSION) ||
        !/^[a-f0-9]{64}$/u.test(clientNonce)
      ) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "authentication_required" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          version: "test",
          uptimeSeconds: 1,
          capabilities: {
            artifactTransfer: true,
            artifactProtocolVersion: 1,
            transactionProtocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
            maxArtifactBytes: MAX_REMOTE_ARTIFACT_BYTES,
            maxRequestBytes: MAX_REMOTE_REQUEST_BYTES,
            maxAttachmentBytes: MAX_REMOTE_ATTACHMENT_BYTES,
            maxTotalAttachmentBytes: MAX_REMOTE_TOTAL_ATTACHMENT_BYTES,
            maxAttachments: MAX_REMOTE_ATTACHMENTS,
            maxPromptChars: MAX_REMOTE_PROMPT_CHARS,
            transportSecurity: "loopback-http",
            boundedRequestDeadlines: true,
            boundedTransactionStore: true,
          },
          authentication: createRemoteHealthAuthenticationProof({
            rootKey,
            serverGeneration,
            clientNonce,
          }),
        }),
      );
      return;
    }
    const authentication = authenticator.verified(req) ?? authenticator.authenticate(req);
    if ("statusCode" in authentication) {
      res.writeHead(authentication.statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: authentication.code }));
      return;
    }
    void handler(req, res).catch((error) => {
      if (res.headersSent) res.destroy(error instanceof Error ? error : new Error(String(error)));
      else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "test_handler_failed" }));
      }
    });
  });
  return server;
}

async function createFakeArtifactBridge({
  descriptor,
  payload,
  transactionTokenOverride,
}: {
  descriptor: RemoteArtifactDescriptor;
  payload: Buffer;
  transactionTokenOverride?: string;
}): Promise<{
  port: number;
  artifactRequests(): number;
  close(): Promise<void>;
}> {
  let artifactRequestCount = 0;
  let activeTransactionToken: string | null = null;
  let activePromptEpoch = committedPromptEpoch("remote");
  const server = createAuthenticatedTestServer(async (req, res) => {
    const runMatch = /^\/transactions\/([a-f0-9]{64})\/run$/u.exec(req.url ?? "");
    if (req.method === "POST" && runMatch) {
      const routeTransactionToken = runMatch[1]!;
      const runPayload = JSON.parse(await readIncomingBody(req)) as {
        prompt: string;
        transactionToken?: unknown;
      };
      if (runPayload.transactionToken !== undefined) {
        throw new Error("transaction token must not be serialized in the run body");
      }
      activeTransactionToken = routeTransactionToken;
      activePromptEpoch = committedPromptEpoch(runPayload.prompt);
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(
        `${JSON.stringify({
          type: "transaction",
          transaction: {
            protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
            transactionToken: transactionTokenOverride ?? routeTransactionToken,
            runId: descriptor.runId,
            result: {
              answerText: "done",
              answerMarkdown: "done",
              tookMs: 1,
              answerTokens: 1,
              answerChars: 4,
            },
            runtime: { promptEpoch: activePromptEpoch, cleanup: { status: "pending" } },
            artifacts: [descriptor],
            state: "pending",
          },
        })}\n`,
      );
      return;
    }
    const bindMatch = /^\/transactions\/([a-f0-9]{64})\/bind$/u.exec(req.url ?? "");
    if (req.method === "POST" && bindMatch) {
      const body = JSON.parse(await readIncomingBody(req)) as { mode?: unknown };
      const mode = body.mode === "abort" ? "abort" : "finalize";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          transactionToken: bindMatch[1],
          settlementAuthority: { mode, outcome: "bound", state: "pending" },
          runtime: { promptEpoch: activePromptEpoch, cleanup: { status: "pending" } },
        }),
      );
      return;
    }
    const settlementMatch = /^\/transactions\/([a-f0-9]{64})\/(finalize|abort)$/.exec(
      req.url ?? "",
    );
    if (req.method === "POST" && settlementMatch) {
      await readIncomingBody(req);
      const mode = settlementMatch[2] === "abort" ? "abort" : "finalize";
      const state = mode === "finalize" ? "finalized" : "aborted";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          transactionToken: settlementMatch[1],
          state,
          settlementAuthority: { mode, outcome: "completed", state },
          finalization: {
            status: "completed",
            runtime: { promptEpoch: activePromptEpoch, cleanup: { status: "completed" } },
          },
        }),
      );
      return;
    }
    const artifactPath = activeTransactionToken
      ? `/transactions/${activeTransactionToken}/artifacts/${encodeURIComponent(descriptor.artifactId)}`
      : null;
    if (req.method === "POST" && artifactPath && req.url === `${artifactPath}/receipt`) {
      await readIncomingBody(req);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && artifactPath && req.url === artifactPath) {
      artifactRequestCount += 1;
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "X-Oracle-Artifact-Sha256": descriptor.sha256,
      });
      res.write(payload);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const listenDeferred = Promise.withResolvers<void>();
  server.once("error", listenDeferred.reject);
  server.listen(0, "127.0.0.1", listenDeferred.resolve);
  await listenDeferred.promise;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake artifact bridge did not bind a TCP port");
  }
  return {
    port: address.port,
    artifactRequests: () => artifactRequestCount,
    close: async () => {
      const closeDeferred = Promise.withResolvers<void>();
      server.close((error) => (error ? closeDeferred.reject(error) : closeDeferred.resolve()));
      await closeDeferred.promise;
    },
  };
}
