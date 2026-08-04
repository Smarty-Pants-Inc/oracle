import { describe, expect, test, vi } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { createRemoteServer } from "../../src/remote/server.js";
import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import {
  createRemoteBrowserExecutor,
  settleRemoteBrowserRecovery,
} from "../../src/remote/client.js";
import type { BrowserRunResult, BrowserRunTransaction } from "../../src/browserMode.js";
import type { BrowserSessionConfig } from "../../src/sessionManager.js";
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
import { promptIdentitySha256 } from "../../src/browser/actions/promptComposer.js";

const CAN_LISTEN_LOCALHOST =
  spawnSync(
    process.execPath,
    [
      "-e",
      `
      const net = require('net');
      const s = net.createServer();
      s.on('error', () => process.exit(1));
      s.listen(0, '127.0.0.1', () => s.close(() => process.exit(0)));
    `,
    ],
    { stdio: "ignore" },
  ).status === 0;

function committedPromptEpoch(
  prompt: string,
  conversationId = "remote-conversation",
  followUpOrdinal = 0,
) {
  return {
    status: "committed" as const,
    epochId: `epoch-${followUpOrdinal}`,
    promptSha256: promptIdentitySha256(prompt),
    baselineTurns: 0,
    followUpOrdinal,
    remainingFollowUps: 0,
    verifiedUserTurnIndex: followUpOrdinal,
    verifiedUserTurnId: `turn-${followUpOrdinal}`,
    verifiedUserMessageId: `message-${followUpOrdinal}`,
    conversationId,
  };
}

function browserTransaction(
  prompt: string,
  result: BrowserRunResult,
  runtime: BrowserRunTransaction["runtime"] = {},
  callbacks: {
    finalize?: BrowserRunTransaction["finalize"];
    abort?: BrowserRunTransaction["abort"];
  } = {},
  followUpOrdinal = 0,
): BrowserRunTransaction {
  const conversationId = result.conversationId?.trim() || "remote-conversation";
  const capturedRuntime: BrowserRunTransaction["runtime"] = {
    ...runtime,
    conversationId,
    promptEpoch: committedPromptEpoch(prompt, conversationId, followUpOrdinal),
  };
  return {
    ...result,
    conversationId,
    runtime: capturedRuntime,
    finalize:
      callbacks.finalize ?? (async () => ({ status: "completed", runtime: capturedRuntime })),
    abort: callbacks.abort ?? (async () => ({ status: "completed", runtime: capturedRuntime })),
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("remote browser service", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "streams logs and returns results via client executor",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-test-"));
      const attachmentPath = path.join(tmpDir, "note.txt");
      const fallbackAttachmentPath = path.join(tmpDir, "fallback.txt");
      await writeFile(attachmentPath, "hello world", "utf8");
      await writeFile(fallbackAttachmentPath, "fallback world", "utf8");

      const transactionStoreDir = path.join(tmpDir, "remote-transactions");
      const hostRuntime: BrowserRunTransaction["runtime"] = {
        browserTransport: "cdp",
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeTargetId: "remote-target",
        conversationId: "remote-conversation",
        recoveryCleanupResources: [
          {
            chromeHost: "127.0.0.1",
            chromePort: 9222,
            chromeTargetId: "remote-target",
            conversationId: "remote-conversation",
            recoveryCleanup: {
              transport: "local",
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
            },
          },
        ],
      };
      const finalize = vi.fn(async () => ({ status: "completed" as const, runtime: hostRuntime }));
      const runLog: string[] = [];
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async (options) => {
            runLog.push(options.prompt);
            expect(options.sessionId).toBe("remote-session-id");
            expect(options.followUpPrompts).toEqual(["follow up"]);
            expect(options.attachments).toHaveLength(1);
            const attachment = options.attachments?.[0];
            if (!attachment) {
              throw new Error("missing attachment");
            }
            const stored = await readFile(attachment.path, "utf8");
            expect(stored).toBe("hello world");
            expect(options.fallbackSubmission?.prompt).toBe("fallback prompt");
            expect(options.fallbackSubmission?.attachments).toHaveLength(1);
            const fallbackAttachment = options.fallbackSubmission?.attachments[0];
            if (!fallbackAttachment) {
              throw new Error("missing fallback attachment");
            }
            const fallbackStored = await readFile(fallbackAttachment.path, "utf8");
            expect(fallbackStored).toBe("fallback world");
            options.log?.("uploading attachment");
            const result: BrowserRunResult = {
              answerText: "hi",
              answerMarkdown: "hi",
              tookMs: 1000,
              answerTokens: 42,
              answerChars: 2,
            };
            return browserTransaction("follow up", result, hostRuntime, { finalize }, 1);
          },
          transactionStoreDir,
        },
      );

      const executor = createRemoteBrowserExecutor({
        host: `127.0.0.1:${server.port}`,
        token: "secret",
      });
      const clientLogs: string[] = [];
      const result = await executor({
        prompt: "remote",
        attachments: [{ path: attachmentPath, displayPath: "note.txt", sizeBytes: 11 }],
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [
            { path: fallbackAttachmentPath, displayPath: "fallback.txt", sizeBytes: 14 },
          ],
        },
        config: {},
        sessionId: "remote-session-id",
        followUpPrompts: ["follow up"],
        log: (message?: string) => {
          if (message) clientLogs.push(message);
        },
      });

      expect(clientLogs.some((entry) => entry.includes("uploading attachment"))).toBe(true);
      expect(result.answerText).toBe("hi");
      expect(runLog).toEqual(["remote"]);
      expect(finalize).not.toHaveBeenCalled();
      expect(result.runtime).toMatchObject({
        promptEpoch: {
          status: "committed",
          promptSha256: promptIdentitySha256("follow up"),
          followUpOrdinal: 1,
          verifiedUserTurnId: "turn-1",
          verifiedUserMessageId: "message-1",
          conversationId: "remote-conversation",
        },
        recoveryCleanupResources: [
          {
            recoveryCleanup: { transport: "remote" },
            remoteRecovery: { state: "pending" },
          },
        ],
        remoteRecovery: { state: "pending" },
      });
      expect(JSON.stringify(result.runtime)).not.toContain("remote-target");
      expect(JSON.stringify(result.runtime)).not.toContain("9222");
      const recordName = (await readdir(transactionStoreDir)).find((name) =>
        name.endsWith(".json"),
      );
      if (!recordName) throw new Error("missing durable remote transaction record");
      if (process.platform !== "win32") {
        expect((await stat(transactionStoreDir)).mode & 0o777).toBe(0o700);
        expect((await stat(path.join(transactionStoreDir, recordName))).mode & 0o777).toBe(0o600);
      }
      const pendingRecord = JSON.parse(
        await readFile(path.join(transactionStoreDir, recordName), "utf8"),
      );
      expect(pendingRecord).toMatchObject({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        state: "pending",
        result: { answerText: "hi" },
        runtime: { chromePort: 9222, chromeTargetId: "remote-target" },
        requestIdentity: {
          acceptedPromptSha256: [promptIdentitySha256("follow up")],
          followUpOrdinal: 1,
          remainingFollowUps: 0,
        },
        browserConfig: {
          chatgptUrl: "https://chatgpt.com/",
          remoteChrome: null,
          attachRunning: false,
        },
        leaseExpiresAt: expect.any(String),
      });
      await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
      await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
      expect(finalize).toHaveBeenCalledTimes(1);
      const finalizedRecord = JSON.parse(
        await readFile(path.join(transactionStoreDir, recordName), "utf8"),
      );
      expect(finalizedRecord).toMatchObject({
        state: "finalized",
        terminalAudit: {
          settlementMode: "finalize",
          publicationAcknowledgedAt: expect.any(String),
        },
      });
      expect(finalizedRecord).not.toHaveProperty("result");
      expect(finalizedRecord).not.toHaveProperty("runtime");
      expect(finalizedRecord).not.toHaveProperty("artifacts");
      expect(finalizedRecord).not.toHaveProperty("settlementMode");
      expect(finalizedRecord).not.toHaveProperty("publicationAcknowledgedAt");
      expect(finalizedRecord).not.toHaveProperty("requestIdentity");
      expect(finalizedRecord).not.toHaveProperty("browserConfig");
      expect(finalizedRecord).not.toHaveProperty("leaseExpiresAt");
      expect(JSON.stringify(finalizedRecord)).not.toContain("remote-target");
      expect(JSON.stringify(finalizedRecord)).not.toContain("answerText");

      const healthUnauthorized = await httpGetJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/health",
      });
      expect(healthUnauthorized.statusCode).toBe(401);

      const healthOk = await httpGetJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/health",
        token: "secret",
      });
      expect(healthOk.statusCode).toBe(200);
      expect(healthOk.json?.ok).toBe(true);
      expect(typeof healthOk.json?.version).toBe("string");
      expect(healthOk.json?.capabilities).toMatchObject({
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
      });

      const artifactUnauthorized = await httpGetJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: `/transactions/${"a".repeat(64)}/artifacts/artifact-id`,
      });
      expect(artifactUnauthorized.statusCode).toBe(401);

      const malformedArtifactPath = await httpGetJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/transactions/%E0%A4%A/artifacts/artifact-id",
        token: "secret",
      });
      expect(malformedArtifactPath.statusCode).toBe(404);

      const healthAfterMalformedPath = await httpGetJson({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/health",
        token: "secret",
      });
      expect(healthAfterMalformedPath.statusCode).toBe(200);

      await server.close();
      await rm(tmpDir, { recursive: true, force: true });
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "keeps manual-login Chrome but requests completed run-tab cleanup",
    async () => {
      const manualLoginProfileDir = "/tmp/oracle-manual-login-profile-test";
      const cleanupPolicies: Array<boolean | undefined> = [];
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          manualLoginDefault: true,
          manualLoginProfileDir,
        },
        {
          runBrowser: async (options) => {
            expect(options.config).toMatchObject({
              manualLogin: true,
              manualLoginProfileDir,
              keepBrowser: true,
            });
            cleanupPolicies.push(options.closeOwnedTabOnComplete);
            return browserTransaction(options.prompt, {
              answerText: "done",
              answerMarkdown: "done",
              tookMs: 1,
              answerTokens: 1,
              answerChars: 4,
            });
          },
        },
      );

      try {
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        });
        const result = await executor({
          prompt: "remote manual-login cleanup",
          config: {},
        });

        expect(result.answerText).toBe("done");
        await result.finalize();

        const explicitlyKept = await executor({
          prompt: "remote manual-login explicit keep",
          config: { keepBrowser: true },
        });

        expect(explicitlyKept.answerText).toBe("done");
        await explicitlyKept.finalize();
        expect(cleanupPolicies).toEqual([true, false]);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "transfers saved browser file artifacts to the client session directory",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-artifact-test-"));
      const clientHome = path.join(tmpDir, "client-home");
      setOracleHomeDirOverrideForTest(clientHome);
      const hostArtifactPath = path.join(
        clientHome,
        "sessions",
        "host-session",
        "artifacts",
        "host-result.zip",
      );
      const secondHostArtifactPath = path.join(
        clientHome,
        "sessions",
        "second-host-session",
        "artifacts",
        "host-result.zip",
      );
      const emptyZip = Buffer.from([
        0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      await mkdir(path.dirname(hostArtifactPath), { recursive: true });
      await mkdir(path.dirname(secondHostArtifactPath), { recursive: true });
      await writeFile(hostArtifactPath, emptyZip);
      await writeFile(secondHostArtifactPath, emptyZip);

      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async (options) => {
            const result: BrowserRunResult = {
              answerText: "done",
              answerMarkdown: "done",
              tookMs: 1000,
              answerTokens: 1,
              answerChars: 4,
              savedFiles: [
                {
                  kind: "file",
                  path: hostArtifactPath,
                  label: "Download",
                  mimeType: "application/octet-stream",
                  sizeBytes: emptyZip.length,
                  sourceUrl: "sandbox:/mnt/data/result.zip",
                  url: "browser-download",
                  finalUrl: "browser-download",
                  filename: "result.zip",
                },
                {
                  kind: "file",
                  path: secondHostArtifactPath,
                  label: "Download another result",
                  mimeType: "application/zip",
                  sizeBytes: emptyZip.length,
                  sourceUrl: "sandbox:/mnt/data/result.zip",
                  url: "browser-download",
                  finalUrl: "browser-download",
                  filename: "result.zip",
                },
              ],
              artifacts: [
                {
                  kind: "file",
                  path: hostArtifactPath,
                  label: "result.zip",
                  mimeType: "application/zip",
                  sizeBytes: emptyZip.length,
                  sourceUrl: "sandbox:/mnt/data/result.zip",
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
      expect(artifact?.path).not.toBe(hostArtifactPath);
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
        label: "host-result.zip",
        filename: expect.stringMatching(/^artifact-[A-Za-z0-9_-]+\.zip$/u),
      });
      await expect(readFile(duplicate!.path)).resolves.toEqual(emptyZip);
      await expect(stat(hostArtifactPath)).resolves.toMatchObject({ size: emptyZip.length });
      await expect(stat(secondHostArtifactPath)).resolves.toMatchObject({
        size: emptyZip.length,
      });

      await server.close();
      await rm(tmpDir, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    },
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
              recoveryCleanupResources: [{ recoveryCleanup: { transport: "remote" } }],
              remoteRecovery: { state: "recoverable-error" },
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
              recoveryCleanupResources: [{ recoveryCleanup: { transport: "remote" } }],
              remoteRecovery: { state: "recoverable-error" },
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
              recoveryCleanupResources: [{ recoveryCleanup: { transport: "remote" } }],
              remoteRecovery: { state: "pending" },
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

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "rejects authority-bearing config and oversized attachments before browser execution",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-dto-test-"));
      const runBrowser = vi.fn(async () =>
        browserTransaction("remote test", {
          answerText: "unexpected",
          answerMarkdown: "unexpected",
          tookMs: 1,
          answerTokens: 1,
          answerChars: 10,
        }),
      );
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        { runBrowser, transactionStoreDir: path.join(tmpDir, "transactions") },
      );

      try {
        const authorityResponse = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${"1".repeat(64)}/run`,
          token: "secret",
          body: {
            ...remoteRunPayload(),
            browserConfig: { remoteChrome: { host: "attacker.invalid", port: 9222 } },
          },
        });
        expect(authorityResponse).toMatchObject({
          statusCode: 400,
          json: { error: "authority_fields_rejected" },
        });

        const oversizeResponse = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${"2".repeat(64)}/run`,
          token: "secret",
          body: {
            ...remoteRunPayload(),
            attachments: [
              {
                fileName: "oversize.bin",
                displayPath: "oversize.bin",
                sizeBytes: MAX_REMOTE_ATTACHMENT_BYTES + 1,
                contentBase64: "YQ==",
              },
            ],
          },
        });
        expect(oversizeResponse.statusCode).toBe(413);
        expect(runBrowser).not.toHaveBeenCalled();
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "preserves a durable pending transaction when the response disconnects before acknowledgement",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-disconnect-test-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const runStarted = createDeferred<void>();
      const continueRun = createDeferred<void>();
      const runtime: BrowserRunTransaction["runtime"] = {
        chromePort: 9222,
        chromeTargetId: "disconnect-target",
        recoveryCleanupResources: [
          {
            chromePort: 9222,
            chromeTargetId: "disconnect-target",
            recoveryCleanup: {
              transport: "local",
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
            },
          },
        ],
      };
      const finalize = vi.fn(async () => ({ status: "completed" as const, runtime }));
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async (options) => {
            runStarted.resolve();
            options.log?.("capture started");
            await continueRun.promise;
            return browserTransaction(
              options.prompt,
              {
                answerText: "durable answer",
                answerMarkdown: "durable answer",
                tookMs: 1,
                answerTokens: 2,
                answerChars: 14,
              },
              runtime,
              { finalize },
            );
          },
        },
      );
      const transactionToken = "3".repeat(64);

      try {
        const disconnected = postJsonAndDisconnect({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/run`,
          token: "secret",
          body: remoteRunPayload(),
        });
        await runStarted.promise;
        await disconnected;
        continueRun.resolve();

        let retryResponse: Awaited<ReturnType<typeof httpPostJson>> | null = null;
        await vi.waitFor(async () => {
          retryResponse = await httpPostJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: `/transactions/${transactionToken}/retry`,
            token: "secret",
            body: {},
          });
          expect(retryResponse).toMatchObject({
            statusCode: 200,
            json: {
              status: "transaction",
              transaction: { state: "pending", result: { answerText: "durable answer" } },
            },
          });
        });
        expect(finalize).not.toHaveBeenCalled();
        const recordName = (await readdir(transactionStoreDir)).find((name) =>
          name.endsWith(".json"),
        );
        if (!recordName) throw new Error("missing disconnected transaction record");
        expect(
          JSON.parse(await readFile(path.join(transactionStoreDir, recordName), "utf8")),
        ).toMatchObject({ state: "pending", runtime: { chromeTargetId: "disconnect-target" } });

        const settlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/finalize`,
          token: "secret",
          body: { durablePublication: true },
        });
        expect(settlement).toMatchObject({ statusCode: 200, json: { state: "finalized" } });
        expect(finalize).toHaveBeenCalledTimes(1);
      } finally {
        continueRun.resolve();
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "retries pending remote finalization from durable cleanup authority",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-finalize-retry-"));
      const runtime: BrowserRunTransaction["runtime"] = {
        chromePort: 9222,
        recoveryCleanupResources: [
          {
            chromePort: 9222,
            recoveryCleanup: {
              transport: "local",
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
            },
          },
        ],
      };
      let finalizationAttempt = 0;
      const finalize = vi.fn(async () => {
        finalizationAttempt += 1;
        return finalizationAttempt === 1
          ? {
              status: "pending" as const,
              runtime: {
                ...runtime,
                recoveryCleanupResult: { status: "failed" as const, error: "Chrome still busy" },
              },
              error: "Chrome still busy",
            }
          : { status: "completed" as const, runtime };
      });
      const retryCleanup = vi.fn(async () => ({ status: "completed" as const, runtime }));
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir: path.join(tmpDir, "transactions"),
          retryCleanup,
          runBrowser: async (options) =>
            browserTransaction(
              options.prompt,
              {
                answerText: "done",
                answerMarkdown: "done",
                tookMs: 1,
                answerTokens: 1,
                answerChars: 4,
              },
              runtime,
              { finalize },
            ),
        },
      );

      try {
        const transaction = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        })({ prompt: "retry cleanup", config: {} });
        const firstFinalization = await transaction.finalize();
        expect(firstFinalization).toMatchObject({
          status: "pending",
          runtime: { remoteRecovery: { state: "pending" } },
        });
        await expect(
          settleRemoteBrowserRecovery({
            runtime: firstFinalization.runtime,
            configuredHost: "attacker.invalid:9443",
            authToken: "secret",
          }),
        ).resolves.toMatchObject({
          status: "pending",
          error: expect.stringContaining("refusing to send credentials"),
        });
        expect(retryCleanup).not.toHaveBeenCalled();
        await expect(
          settleRemoteBrowserRecovery({
            runtime: firstFinalization.runtime,
            configuredHost: `127.0.0.1:${server.port}`,
            authToken: "secret",
          }),
        ).resolves.toMatchObject({ status: "completed" });
        await expect(transaction.finalize()).resolves.toMatchObject({ status: "completed" });
        expect(finalize).toHaveBeenCalledTimes(2);
        expect(retryCleanup).not.toHaveBeenCalled();
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "preserves browser-WSS runtime authority through the same remote transaction contract",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-wss-test-"));
      const runtime: BrowserRunTransaction["runtime"] = {
        recoveryCleanupResources: [
          {
            chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/older-wss-authority",
            chromeTargetId: "older-wss-target",
            recoveryCleanup: {
              transport: "local",
              ownsTarget: false,
              profileKind: "none",
              keepBrowser: true,
            },
          },
          {
            chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/wss-authority",
            chromeTargetId: "wss-target",
            recoveryCleanup: {
              transport: "local",
              ownsTarget: false,
              profileKind: "none",
              keepBrowser: true,
            },
          },
        ],
      };
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir: path.join(tmpDir, "transactions"),
          runBrowser: async (options) =>
            browserTransaction(
              options.prompt,
              {
                answerText: "wss",
                answerMarkdown: "wss",
                tookMs: 1,
                answerTokens: 1,
                answerChars: 3,
              },
              runtime,
            ),
        },
      );

      try {
        const transaction = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        })({ prompt: "WSS contract", config: {} });
        expect(transaction.runtime).toMatchObject({
          promptEpoch: {
            promptSha256: promptIdentitySha256("WSS contract"),
            conversationId: "remote-conversation",
          },
          recoveryCleanupResources: [
            {
              recoveryCleanup: { transport: "remote" },
              remoteRecovery: { state: "pending" },
            },
          ],
          remoteRecovery: { state: "pending" },
        });
        expect(JSON.stringify(transaction.runtime)).not.toContain("wss-authority");
        expect(JSON.stringify(transaction.runtime)).not.toContain("wss-target");
        expect(JSON.stringify(transaction.runtime)).not.toContain("9222");
        const finalization = await transaction.finalize();
        expect(finalization).toMatchObject({ status: "completed" });
        expect(finalization.runtime.recoveryCleanupResources).toBeUndefined();
        expect(finalization.runtime.remoteRecovery).toBeUndefined();
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "rehydrates and settles structured recoverable browser disconnect errors",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-error-test-"));
      const recoverableRuntime: BrowserRunTransaction["runtime"] = {
        conversationId: "remote-conversation",
        promptEpoch: committedPromptEpoch("recover"),
        recoveryCleanupResources: [
          {
            chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/recoverable",
            chromeTargetId: "recoverable-target",
            recoveryCleanup: {
              transport: "local",
              ownsTarget: false,
              profileKind: "none",
              keepBrowser: true,
            },
          },
        ],
      };
      const retryCleanup = vi.fn(async () => ({
        status: "completed" as const,
        runtime: recoverableRuntime,
      }));
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir: path.join(tmpDir, "transactions"),
          retryCleanup,
          runBrowser: async () => {
            throw new BrowserAutomationError("Browser WebSocket disconnected", {
              stage: "wait-for-answer",
              recoverableDisconnect: true,
              runtime: recoverableRuntime,
            });
          },
        },
      );

      try {
        const caught = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        })({ prompt: "recover", config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(caught).toMatchObject({
          name: "BrowserAutomationError",
          details: {
            stage: "wait-for-answer",
            recoverableDisconnect: true,
            remoteRecovery: { state: "recoverable-error" },
            runtime: {
              promptEpoch: {
                promptSha256: promptIdentitySha256("recover"),
                verifiedUserTurnId: "turn-0",
                verifiedUserMessageId: "message-0",
                conversationId: "remote-conversation",
              },
              recoveryCleanupResources: [{ recoveryCleanup: { transport: "remote" } }],
              remoteRecovery: { state: "recoverable-error" },
            },
          },
        });
        if (!(caught instanceof BrowserAutomationError)) {
          throw new Error("expected a recoverable BrowserAutomationError");
        }
        const runtime = caught.details?.runtime as BrowserRunTransaction["runtime"] | undefined;
        if (!runtime?.remoteRecovery) throw new Error("missing remote recovery authority");

        await expect(
          settleRemoteBrowserRecovery({
            runtime,
            configuredHost: `127.0.0.1:${server.port}`,
            authToken: "secret",
          }),
        ).resolves.toMatchObject({ status: "completed" });
        expect(retryCleanup).toHaveBeenCalledOnce();
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "captures a recoverable answer after controller restart using journaled host authority",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-restart-capture-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      let transactionToken = "";
      const prompt = "recover after restart";
      const runtime: BrowserRunTransaction["runtime"] = {
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeTargetId: "restart-target",
        conversationId: "remote-conversation",
        promptEpoch: committedPromptEpoch(prompt),
        recoveryCleanupResources: [
          {
            chromeHost: "127.0.0.1",
            chromePort: 9222,
            chromeTargetId: "restart-target",
            conversationId: "remote-conversation",
            promptEpoch: committedPromptEpoch(prompt),
            recoveryCleanup: {
              transport: "local",
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
            },
          },
        ],
      };
      const first = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async () => {
            throw new BrowserAutomationError("Browser disconnected", {
              stage: "wait-for-answer",
              recoverableDisconnect: true,
              runtime,
            });
          },
        },
      );
      try {
        const caught = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${first.port}`,
          token: "secret",
        })({ prompt, config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(caught).toMatchObject({ details: { recoverableDisconnect: true } });
        transactionToken = remoteRecoveryTransactionToken(caught);
      } finally {
        await first.close();
      }

      const finalize = vi.fn(async () => ({ status: "completed" as const, runtime }));
      const abort = vi.fn(async () => ({ status: "completed" as const, runtime }));
      const resumeBrowser = vi.fn(
        async (
          journaledRuntime: BrowserRunTransaction["runtime"],
          browserConfig: BrowserSessionConfig | undefined,
        ) => {
          expect(journaledRuntime).toMatchObject({
            chromePort: 9222,
            chromeTargetId: "restart-target",
          });
          expect(browserConfig).toMatchObject({
            chatgptUrl: "https://chatgpt.com/",
            remoteChrome: null,
            attachRunning: false,
          });
          return {
            answerText: "recovered answer",
            answerMarkdown: "recovered answer",
            runtime: journaledRuntime,
            finalize,
            abort,
          };
        },
      );
      const restarted = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        { transactionStoreDir, resumeBrowser },
      );
      try {
        const retry = await httpPostJson({
          hostname: "127.0.0.1",
          port: restarted.port,
          path: `/transactions/${transactionToken}/retry`,
          token: "secret",
          body: {},
        });
        expect(retry).toMatchObject({
          statusCode: 200,
          json: {
            status: "transaction",
            transaction: {
              state: "pending",
              result: { answerText: "recovered answer" },
            },
          },
        });
        expect(JSON.stringify(retry.json)).not.toContain("restart-target");
        expect(JSON.stringify(retry.json)).not.toContain("9222");
        expect(resumeBrowser).toHaveBeenCalledOnce();

        const settlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: restarted.port,
          path: `/transactions/${transactionToken}/finalize`,
          token: "secret",
          body: { durablePublication: true },
        });
        expect(settlement).toMatchObject({ statusCode: 200, json: { state: "finalized" } });
        expect(finalize).toHaveBeenCalledOnce();
        expect(abort).not.toHaveBeenCalled();
      } finally {
        await restarted.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "rejects and aborts a recovered answer with mismatched committed request identity",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-identity-mismatch-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      let transactionToken = "";
      const prompt = "identity-bound prompt";
      const runtime: BrowserRunTransaction["runtime"] = {
        conversationId: "remote-conversation",
        promptEpoch: committedPromptEpoch(prompt),
      };
      const mismatchedRuntime: BrowserRunTransaction["runtime"] = {
        conversationId: "remote-conversation",
        promptEpoch: committedPromptEpoch("different prompt"),
      };
      const abort = vi.fn(async () => ({
        status: "completed" as const,
        runtime: mismatchedRuntime,
      }));
      const resumeBrowser = vi.fn(async () => ({
        answerText: "wrong answer",
        answerMarkdown: "wrong answer",
        runtime: mismatchedRuntime,
        finalize: vi.fn(async () => ({ status: "completed" as const, runtime: mismatchedRuntime })),
        abort,
      }));
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          resumeBrowser,
          runBrowser: async () => {
            throw new BrowserAutomationError("Browser disconnected", {
              stage: "wait-for-answer",
              recoverableDisconnect: true,
              runtime,
            });
          },
        },
      );
      try {
        const caught = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        })({ prompt, config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(caught).toMatchObject({ details: { recoverableDisconnect: true } });
        transactionToken = remoteRecoveryTransactionToken(caught);

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
            error: { code: "remote-prompt-authority-mismatch", recoverableDisconnect: false },
          },
        });
        expect(abort).toHaveBeenCalledOnce();
        const record = await RemoteTransactionStore.open({
          directory: transactionStoreDir,
        }).then((store) => store.read(transactionToken));
        expect(record).toMatchObject({ state: "failed" });
        expect(record).not.toHaveProperty("requestIdentity");
        expect(record).not.toHaveProperty("browserConfig");
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "serializes concurrent authenticated retries into one browser recovery",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-retry-single-flight-"));
      let transactionToken = "";
      const prompt = "single flight recovery";
      const runtime: BrowserRunTransaction["runtime"] = {
        conversationId: "remote-conversation",
        promptEpoch: committedPromptEpoch(prompt),
      };
      const recoveryStarted = createDeferred<void>();
      const releaseRecovery = createDeferred<void>();
      const resumeBrowser = vi.fn(async () => {
        recoveryStarted.resolve();
        await releaseRecovery.promise;
        return {
          answerText: "one answer",
          answerMarkdown: "one answer",
          runtime,
          finalize: vi.fn(async () => ({ status: "completed" as const, runtime })),
          abort: vi.fn(async () => ({ status: "completed" as const, runtime })),
        };
      });
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir: path.join(tmpDir, "transactions"),
          resumeBrowser,
          runBrowser: async () => {
            throw new BrowserAutomationError("Browser disconnected", {
              stage: "wait-for-answer",
              recoverableDisconnect: true,
              runtime,
            });
          },
        },
      );
      try {
        const caught = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "secret",
        })({ prompt, config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(caught).toMatchObject({ details: { recoverableDisconnect: true } });
        transactionToken = remoteRecoveryTransactionToken(caught);

        const retryRequest = () =>
          httpPostJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: `/transactions/${transactionToken}/retry`,
            token: "secret",
            body: {},
          });
        const firstRetry = retryRequest();
        await recoveryStarted.promise;
        const secondRetry = retryRequest();
        releaseRecovery.resolve();
        const responses = await Promise.all([firstRetry, secondRetry]);
        expect(responses).toEqual([
          expect.objectContaining({
            statusCode: 200,
            json: expect.objectContaining({ status: "transaction" }),
          }),
          expect.objectContaining({
            statusCode: 200,
            json: expect.objectContaining({ status: "transaction" }),
          }),
        ]);
        expect(resumeBrowser).toHaveBeenCalledOnce();
      } finally {
        releaseRecovery.resolve();
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "serializes direct settlement against active browser work",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-settlement-gate-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const now = Date.now();
      const transactionStoreNow = () => now;
      const store = await openSeedTransactionStore(transactionStoreDir, 5_000, transactionStoreNow);
      const settlementToken = "e".repeat(64);
      const runToken = "f".repeat(64);
      const settlementRuntime = await seedRemoteTransaction(store, settlementToken, {
        prompt: "settlement waits for browser authority",
      });
      if (!settlementRuntime) throw new Error("missing seeded settlement runtime");
      const runStarted = createDeferred<void>();
      const releaseRun = createDeferred<void>();
      const retryCleanup = vi.fn(
        async (
          runtime: BrowserRunTransaction["runtime"],
          _logger: unknown,
          _deps: unknown,
          mode?: "finalize" | "abort",
        ) => {
          if (!mode) throw new Error("missing settlement mode");
          return { status: "completed" as const, runtime };
        },
      );
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          controllerGeneration: TEST_CONTROLLER_GENERATION,
          transactionLeaseDurationMs: 5_000,
          transactionStoreNow,
          leaseSweepIntervalMs: 1_000,
          retryCleanup,
          runBrowser: async (options) => {
            runStarted.resolve();
            await releaseRun.promise;
            return browserTransaction(options.prompt, {
              answerText: "active answer",
              answerMarkdown: "active answer",
              tookMs: 1,
              answerTokens: 2,
              answerChars: 13,
            });
          },
        },
      );
      try {
        const runRequest = httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${runToken}/run`,
          token: "secret",
          body: remoteRunPayload(),
        });
        await runStarted.promise;
        const busySettlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${settlementToken}/abort`,
          token: "secret",
          body: {},
        });
        expect(busySettlement).toMatchObject({ statusCode: 409, json: { error: "busy" } });
        expect(retryCleanup).not.toHaveBeenCalled();

        releaseRun.resolve();
        await expect(runRequest).resolves.toMatchObject({ statusCode: 200 });
        const settled = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${settlementToken}/abort`,
          token: "secret",
          body: {},
        });
        expect(settled).toMatchObject({ statusCode: 200, json: { state: "aborted" } });
        expect(retryCleanup).toHaveBeenCalledOnce();
        expect(retryCleanup.mock.calls[0]?.[3]).toBe("abort");
      } finally {
        releaseRun.resolve();
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "settles expired authority in abort or finalize mode and redacts pre-authority runs",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-expired-leases-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const leaseDurationMs = 20;
      let now = Date.now();
      const transactionStoreNow = () => now;
      const store = await openSeedTransactionStore(
        transactionStoreDir,
        leaseDurationMs,
        transactionStoreNow,
      );
      const abortToken = "7".repeat(64);
      const preAuthorityToken = "8".repeat(64);
      const finalizeToken = "9".repeat(64);
      const unacknowledgedFinalizeToken = "a".repeat(64);
      await seedRemoteTransaction(store, abortToken, {
        prompt: "expired running authority",
        state: "running",
      });
      await seedRemoteTransaction(store, preAuthorityToken, {
        prompt: "expired before authority",
        state: "running",
        runtime: null,
      });
      await seedRemoteTransaction(store, finalizeToken, {
        prompt: "expired finalize cleanup",
        settlementMode: "finalize",
        publicationAcknowledged: true,
      });
      await seedRemoteTransaction(store, unacknowledgedFinalizeToken, {
        prompt: "expired unacknowledged finalize cleanup",
        settlementMode: "finalize",
      });
      now += leaseDurationMs + 1;
      const cleanupModes: Array<"finalize" | "abort"> = [];
      const retryCleanup = vi.fn(
        async (
          runtime: BrowserRunTransaction["runtime"],
          _logger: unknown,
          _deps: unknown,
          mode?: "finalize" | "abort",
        ) => {
          if (!mode) throw new Error("missing settlement mode");
          cleanupModes.push(mode);
          return { status: "completed" as const, runtime };
        },
      );
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          controllerGeneration: TEST_CONTROLLER_GENERATION,
          transactionLeaseDurationMs: leaseDurationMs,
          transactionStoreNow,
          leaseSweepIntervalMs: 1_000,
          retryCleanup,
        },
      );
      try {
        expect(cleanupModes).toEqual(["abort", "finalize"]);
        expect(await store.read(abortToken)).toMatchObject({
          state: "aborted",
          terminalAudit: { settlementMode: "abort" },
        });
        const failed = await store.read(preAuthorityToken);
        expect(failed).toMatchObject({ state: "failed" });
        expect(failed).not.toHaveProperty("runtime");
        expect(failed).not.toHaveProperty("requestIdentity");
        expect(failed).not.toHaveProperty("browserConfig");
        expect(await store.read(finalizeToken)).toMatchObject({ state: "finalized" });
        expect(await store.read(unacknowledgedFinalizeToken)).toMatchObject({
          state: "pending",
          settlementMode: "finalize",
        });
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "retains pending expired cleanup, retries it periodically, and clears the timer on close",
    async () => {
      vi.useFakeTimers();
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-pending-sweep-"));
      try {
        const transactionStoreDir = path.join(tmpDir, "transactions");
        const leaseDurationMs = 15;
        const transactionToken = "b".repeat(64);
        let now = Date.now();
        const transactionStoreNow = () => now;
        const store = await openSeedTransactionStore(
          transactionStoreDir,
          leaseDurationMs,
          transactionStoreNow,
        );
        await seedRemoteTransaction(store, transactionToken, {
          prompt: "pending cleanup retention",
          settlementMode: "abort",
        });
        now += leaseDurationMs + 1;
        const retryCleanup = vi.fn(
          async (
            runtime: BrowserRunTransaction["runtime"],
            _logger: unknown,
            _deps: unknown,
            mode?: "finalize" | "abort",
          ) => {
            if (!mode) throw new Error("missing settlement mode");
            return {
              status: "pending" as const,
              runtime: {
                ...runtime,
                recoveryCleanupResult: { status: "failed" as const, error: `${mode} pending` },
              },
              error: `${mode} pending`,
            };
          },
        );
        const server = await createRemoteServer(
          { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
          {
            transactionStoreDir,
            controllerGeneration: TEST_CONTROLLER_GENERATION,
            transactionLeaseDurationMs: leaseDurationMs,
            transactionStoreNow,
            leaseSweepIntervalMs: 5,
            retryCleanup,
          },
        );
        try {
          expect(retryCleanup).toHaveBeenCalledOnce();
          now += leaseDurationMs + 1;
          await vi.advanceTimersByTimeAsync(5);
          await vi.waitFor(() => {
            expect(retryCleanup.mock.calls.length).toBeGreaterThanOrEqual(2);
          });
          expect(retryCleanup.mock.calls.every((call) => call[3] === "abort")).toBe(true);
          expect(await store.read(transactionToken)).toMatchObject({
            state: "pending",
            settlementMode: "abort",
            finalization: { status: "pending" },
          });

          await server.close();
          const attemptsAfterClose = retryCleanup.mock.calls.length;
          now += leaseDurationMs * 3;
          await vi.advanceTimersByTimeAsync(leaseDurationMs * 3);
          expect(retryCleanup).toHaveBeenCalledTimes(attemptsAfterClose);
        } finally {
          await server.close();
        }
      } finally {
        vi.useRealTimers();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "renews authenticated retry, artifact, receipt, and settlement requests only after auth",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-auth-renewal-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const transactionToken = "c".repeat(64);
      let now = Date.now();
      const transactionStoreNow = () => now;
      const store = await openSeedTransactionStore(transactionStoreDir, 5_000, transactionStoreNow);
      await seedRemoteTransaction(store, transactionToken, { prompt: "renew exact lease" });
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          transactionStoreDir,
          controllerGeneration: TEST_CONTROLLER_GENERATION,
          transactionLeaseDurationMs: 5_000,
          transactionStoreNow,
          leaseSweepIntervalMs: 1_000,
        },
      );
      try {
        const initialLease = (await store.read(transactionToken))?.leaseExpiresAt;
        const unauthorizedRetry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/retry`,
          body: {},
        });
        expect(unauthorizedRetry.statusCode).toBe(401);
        expect((await store.read(transactionToken))?.leaseExpiresAt).toBe(initialLease);

        now += 10;
        const authenticatedRetry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/retry`,
          token: "secret",
          body: {},
        });
        expect(authenticatedRetry.statusCode).toBe(200);
        const retryLease = (await store.read(transactionToken))?.leaseExpiresAt;
        expect(Date.parse(retryLease ?? "")).toBeGreaterThan(Date.parse(initialLease ?? ""));

        const unauthorizedArtifact = await httpGetJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/artifacts/missing-artifact`,
        });
        expect(unauthorizedArtifact.statusCode).toBe(401);
        expect((await store.read(transactionToken))?.leaseExpiresAt).toBe(retryLease);

        now += 10;
        const authenticatedArtifact = await httpGetJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/artifacts/missing-artifact`,
          token: "secret",
        });
        expect(authenticatedArtifact.statusCode).toBe(404);
        const artifactLease = (await store.read(transactionToken))?.leaseExpiresAt;
        expect(Date.parse(artifactLease ?? "")).toBeGreaterThan(Date.parse(retryLease ?? ""));

        const unauthorizedReceipt = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/artifacts/missing-artifact/receipt`,
          body: { sha256: "d".repeat(64), byteSize: 1 },
        });
        expect(unauthorizedReceipt.statusCode).toBe(401);
        expect((await store.read(transactionToken))?.leaseExpiresAt).toBe(artifactLease);

        now += 10;
        const receipt = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/artifacts/missing-artifact/receipt`,
          token: "secret",
          body: { sha256: "d".repeat(64), byteSize: 1 },
        });
        expect(receipt.statusCode).toBe(404);
        const receiptLease = (await store.read(transactionToken))?.leaseExpiresAt;
        expect(Date.parse(receiptLease ?? "")).toBeGreaterThan(Date.parse(artifactLease ?? ""));

        const unauthorizedSettlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/finalize`,
          body: {},
        });
        expect(unauthorizedSettlement.statusCode).toBe(401);
        expect((await store.read(transactionToken))?.leaseExpiresAt).toBe(receiptLease);

        now += 10;
        const invalidSettlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/finalize`,
          token: "secret",
          body: {},
        });
        expect(invalidSettlement.statusCode).toBe(400);
        const settlementLease = (await store.read(transactionToken))?.leaseExpiresAt;
        expect(Date.parse(settlementLease ?? "")).toBeGreaterThan(Date.parse(receiptLease ?? ""));
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "holds one crash-recoverable controller lock per durable transaction store",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-controller-lock-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const options = { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} };
      const first = await createRemoteServer(options, { transactionStoreDir });
      try {
        await expect(createRemoteServer(options, { transactionStoreDir })).rejects.toThrow(
          /lock|owner|active/i,
        );
      } finally {
        await first.close();
      }
      const restarted = await createRemoteServer(options, { transactionStoreDir });
      await restarted.close();
      await rm(tmpDir, { recursive: true, force: true });
    },
  );
});

function createArtifactDescriptor(
  payload: Buffer,
  overrides: Partial<RemoteArtifactDescriptor> = {},
): RemoteArtifactDescriptor {
  return {
    artifactId: "artifact-id",
    runId: "run-id",
    kind: "file",
    filename: "result.zip",
    mimeType: "application/zip",
    byteSize: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex"),
    sourceUrlKind: "sandbox",
    transferStatus: "ready",
    ...overrides,
    required: overrides.required ?? true,
  };
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
  const server = http.createServer((req, res) => {
    void (async () => {
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
      const settlementMatch = /^\/transactions\/([a-f0-9]{64})\/(finalize|abort)$/.exec(
        req.url ?? "",
      );
      if (req.method === "POST" && settlementMatch) {
        await readIncomingBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            transactionToken: settlementMatch[1],
            state: settlementMatch[2] === "finalize" ? "finalized" : "aborted",
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
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  const listenDeferred = createDeferred<void>();
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
      const closeDeferred = createDeferred<void>();
      server.close((error) => (error ? closeDeferred.reject(error) : closeDeferred.resolve()));
      await closeDeferred.promise;
    },
  };
}

async function httpGetJson({
  hostname,
  port,
  path,
  token,
}: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
}): Promise<{ statusCode: number; json: Record<string, unknown> | null }> {
  const deferred = createDeferred<{
    statusCode: number;
    json: Record<string, unknown> | null;
  }>();
  const req = http.request(
    {
      hostname,
      port,
      path,
      method: "GET",
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    },
    (res) => {
      readIncomingBody(res)
        .then((body) => {
          const statusCode = res.statusCode ?? 0;
          let json: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = body.length ? JSON.parse(body) : null;
            json =
              parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          deferred.resolve({ statusCode, json });
        })
        .catch(deferred.reject);
    },
  );
  req.on("error", deferred.reject);
  req.end();
  return await deferred.promise;
}

async function httpPostJson({
  hostname,
  port,
  path,
  token,
  body,
}: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  body: unknown;
}): Promise<{ statusCode: number; json: Record<string, unknown> | null }> {
  const serialized = Buffer.from(JSON.stringify(body));
  const deferred = createDeferred<{
    statusCode: number;
    json: Record<string, unknown> | null;
  }>();
  const req = http.request(
    {
      hostname,
      port,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": serialized.byteLength,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
    (res) => {
      readIncomingBody(res)
        .then((responseBody) => {
          let json: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = responseBody ? JSON.parse(responseBody) : null;
            json =
              parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          deferred.resolve({ statusCode: res.statusCode ?? 0, json });
        })
        .catch(deferred.reject);
    },
  );
  req.on("error", deferred.reject);
  req.end(serialized);
  return await deferred.promise;
}

async function postJsonAndDisconnect({
  hostname,
  port,
  path,
  token,
  body,
}: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  body: unknown;
}): Promise<void> {
  const serialized = Buffer.from(JSON.stringify(body));
  const deferred = createDeferred<void>();
  const req = http.request(
    {
      hostname,
      port,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": serialized.byteLength,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
    (res) => {
      res.destroy();
      deferred.resolve();
    },
  );
  req.on("error", deferred.reject);
  req.end(serialized);
  await deferred.promise;
}

function remoteRunPayload() {
  return {
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    prompt: "remote test",
    attachments: [],
    browserConfig: {},
    options: {},
  };
}

const TEST_CONTROLLER_GENERATION = "server-test-controller";

async function openSeedTransactionStore(
  directory: string,
  leaseDurationMs: number,
  now: () => number,
) {
  return await RemoteTransactionStore.open({
    directory,
    controllerGeneration: TEST_CONTROLLER_GENERATION,
    leaseDurationMs,
    now,
  });
}

async function seedRemoteTransaction(
  store: RemoteTransactionStore,
  transactionToken: string,
  options: {
    prompt: string;
    state?: "running" | "pending" | "recoverable-error";
    runtime?: BrowserRunTransaction["runtime"] | null;
    settlementMode?: "finalize" | "abort";
    publicationAcknowledged?: boolean;
  },
) {
  const state = options.state ?? "pending";
  const runtime =
    options.runtime === null
      ? undefined
      : (options.runtime ?? {
          conversationId: "remote-conversation",
          promptEpoch: committedPromptEpoch(options.prompt),
          recoveryCleanupResources: [
            {
              chromeTargetId: `target-${transactionToken.slice(0, 8)}`,
              conversationId: "remote-conversation",
              promptEpoch: committedPromptEpoch(options.prompt),
              recoveryCleanup: {
                transport: "local" as const,
                ownsTarget: true,
                profileKind: "temporary" as const,
                keepBrowser: false,
              },
            },
          ],
        });
  const now = new Date().toISOString();
  await store.create({
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    transactionToken,
    runId: `run-${transactionToken.slice(0, 8)}`,
    createdAt: now,
    updatedAt: now,
    state,
    requestIdentity: {
      acceptedPromptSha256: [promptIdentitySha256(options.prompt)],
      followUpOrdinal: 0,
      remainingFollowUps: 0,
    },
    browserConfig: {
      chatgptUrl: "https://chatgpt.com",
      url: "https://chatgpt.com",
      remoteChrome: null,
      attachRunning: false,
    },
    ...(runtime ? { runtime } : {}),
    ...(state === "pending"
      ? {
          result: {
            answerText: "durable answer",
            answerMarkdown: "durable answer",
            tookMs: 1,
            answerTokens: 2,
            answerChars: 14,
          },
        }
      : {}),
    ...(options.settlementMode ? { settlementMode: options.settlementMode } : {}),
    ...(options.publicationAcknowledged
      ? { publicationAcknowledgedAt: new Date().toISOString() }
      : {}),
  });
  return runtime;
}

function remoteRecoveryTransactionToken(error: unknown): string {
  if (!(error instanceof BrowserAutomationError)) {
    throw new Error("Expected recoverable BrowserAutomationError");
  }
  const remoteRecovery = error.details?.remoteRecovery as
    | { transactionToken?: unknown }
    | undefined;
  if (
    typeof remoteRecovery?.transactionToken !== "string" ||
    !/^[a-f0-9]{64}$/u.test(remoteRecovery.transactionToken)
  ) {
    throw new Error("Recoverable error is missing exact remote transaction authority");
  }
  return remoteRecovery.transactionToken;
}

async function readIncomingBody(
  stream: NodeJS.ReadableStream & AsyncIterable<Buffer | string>,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
