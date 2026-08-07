import http from "node:http";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import * as fsPromises from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createRemoteBrowserExecutor,
  createRemoteBrowserTransactionExecutor,
  resumeRemoteBrowserTransaction,
  settleRemoteBrowserRecovery,
} from "../../src/remote/client.js";
import {
  bindRemoteBrowserSettlement,
  settleRemoteBrowserTransaction,
} from "../../src/remote/clientRecovery.js";
import { findRemoteRecoveryAuthority } from "../../src/browser/reattachability.js";
import {
  buildRemotePromptRequestIdentity,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  type RemoteRunPayload,
} from "../../src/remote/types.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { promptIdentitySha256 } from "../../src/browser/actions/committedPrompt.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionManager.js";
import * as fsDurability from "../../src/fsDurability.js";
import {
  REMOTE_HEALTH_CLIENT_NONCE_HEADER,
  REMOTE_PROTOCOL_HEADER,
  REMOTE_REQUEST_PROOF_HEADER,
  REMOTE_SERVER_GENERATION_HEADER,
  RemoteRequestAuthenticator,
  createRemoteHealthAuthenticationProof,
} from "../../src/remote/auth.js";

function committedPromptEpoch(prompt: string) {
  return {
    status: "committed" as const,
    epochId: "epoch-1",
    promptSha256: promptIdentitySha256(prompt),
    baselineTurns: 0,
    followUpOrdinal: 0,
    remainingFollowUps: 0,
    verifiedUserTurnIndex: 0,
    verifiedUserTurnId: "turn-1",
    verifiedUserMessageId: "message-1",
    conversationId: "conversation-1",
  };
}

function runTransactionToken(req: http.IncomingMessage): string | null {
  if (req.method !== "POST") return null;
  return /^\/transactions\/([a-f0-9]{64})\/run$/u.exec(req.url ?? "")?.[1] ?? null;
}

async function listen(server: http.Server): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") reject(new Error("missing test server address"));
    else resolve(address.port);
  });
  return await promise;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close((error) => (error ? reject(error) : resolve()));
  await promise;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("expected JSON object request");
  return Object.fromEntries(Object.entries(parsed));
}
function createAuthenticatedServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
  options: { handleBind?: boolean } = {},
): http.Server {
  const rootKey = "a".repeat(64);
  const serverGeneration = "client-transport-test-generation";
  const authenticator = new RemoteRequestAuthenticator({ rootKey, serverGeneration });
  const server = http.createServer();
  server.on("checkContinue", (req, res) => {
    const authentication = authenticator.authenticate(req);
    if ("statusCode" in authentication) {
      res.writeHead(authentication.statusCode, { "content-type": "application/json" });
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
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_health_challenge" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          version: "test",
          uptimeSeconds: 1,
          capabilities: {
            artifactTransfer: true,
            artifactProtocolVersion: 1,
            transactionProtocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
            maxArtifactBytes: 1,
            maxRequestBytes: 1,
            maxAttachmentBytes: 1,
            maxTotalAttachmentBytes: 1,
            maxAttachments: 1,
            maxPromptChars: 1,
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
      res.writeHead(authentication.statusCode, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: authentication.code }));
      return;
    }
    void (async () => {
      const bindMatch = /^\/transactions\/([a-f0-9]{64})\/bind$/u.exec(req.url ?? "");
      if (options.handleBind !== false && req.method === "POST" && bindMatch) {
        const request = await readJson(req);
        const mode = request.mode === "abort" ? "abort" : "finalize";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            transactionToken: bindMatch[1],
            settlementAuthority: { mode, outcome: "bound", state: "pending" },
            runtime: { cleanup: { status: "pending" } },
          }),
        );
        return;
      }
      await handler(req, res);
    })().catch((error) => {
      if (res.headersSent) res.destroy(error instanceof Error ? error : new Error(String(error)));
      else {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "test_handler_failed" }));
      }
    });
  });
  return server;
}

function transactionEvent(transactionToken: string, prompt: string, artifacts: unknown[] = []) {
  return {
    type: "transaction",
    transaction: {
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      transactionToken,
      runId: "run-1",
      result: {
        answerText: "answer",
        answerMarkdown: "answer",
        tookMs: 1,
        answerTokens: 1,
        answerChars: 6,
      },
      runtime: { promptEpoch: committedPromptEpoch(prompt), cleanup: { status: "pending" } },
      artifacts,
      state: "pending",
    },
  };
}

function finalizedSettlement(transactionToken: string, prompt: string) {
  return {
    transactionToken,
    state: "finalized" as const,
    settlementAuthority: {
      mode: "finalize" as const,
      outcome: "completed" as const,
      state: "finalized" as const,
    },
    finalization: {
      status: "completed" as const,
      runtime: {
        promptEpoch: committedPromptEpoch(prompt),
        cleanup: { status: "completed" as const },
      },
    },
  };
}
function remoteRecovery(runtime: BrowserRuntimeMetadata | undefined) {
  return runtime?.recoveryCleanupResources?.find((resource) => resource.remoteRecovery)
    ?.remoteRecovery;
}

function recoveryRuntime(
  host: string,
  transactionToken: string,
  settlementMode?: "finalize" | "abort",
): BrowserRuntimeMetadata {
  return {
    conversationId: "persisted-conversation",
    recoveryCleanupResult: {
      status: "pending",
      ...(settlementMode ? { settlementMode } : {}),
    },
    recoveryCleanupResources: [
      {
        remoteRecovery: {
          protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
          host,
          transactionToken,
          state: "recoverable-error",
        },
        recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
      },
    ],
  };
}

const deadlines = {
  runOverallTimeoutMs: 120,
  controlOverallTimeoutMs: 80,
  artifactOverallTimeoutMs: 100,
  socketIdleTimeoutMs: 40,
  recoveryWindowMs: 120,
};

describe("remote client transport deadlines", () => {
  it("rejects malformed modern and legacy executor credentials before use", () => {
    for (const token of [
      "",
      " ",
      "dictionary-word",
      "A".repeat(64),
      "a".repeat(63),
      "g".repeat(64),
    ]) {
      expect(() =>
        createRemoteBrowserTransactionExecutor({ host: "127.0.0.1:9473", token }),
      ).toThrow(/exactly 64 lowercase hexadecimal characters \(32 bytes\)/i);
    }
    expect(() =>
      createRemoteBrowserTransactionExecutor({
        host: "127.0.0.1:9473",
        legacyToken: "weak",
        allowLegacyTextProtocol: true,
      }),
    ).toThrow(/exactly 64 lowercase hexadecimal characters \(32 bytes\)/i);
  });

  it("serializes ordinary attachments from their opened file handle", async () => {
    const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "oracle-remote-attachment-"));
    const attachmentPath = path.join(directory, "attachment.txt");
    const contents = Buffer.from("trusted attachment");
    await fsPromises.writeFile(attachmentPath, contents);
    let receivedAttachments: unknown;
    const server = createAuthenticatedServer(async (req, res) => {
      const transactionToken = runTransactionToken(req);
      if (!transactionToken) {
        res.statusCode = 404;
        res.end();
        return;
      }
      receivedAttachments = (await readJson(req)).attachments;
      res.setHeader("content-type", "application/x-ndjson");
      res.end(`${JSON.stringify(transactionEvent(transactionToken, "attachment"))}\n`);
    });
    const port = await listen(server);
    try {
      await createRemoteBrowserTransactionExecutor({
        host: `127.0.0.1:${port}`,
        token: "a".repeat(64),
        deadlines,
      })({
        prompt: "attachment",
        attachments: [{ path: attachmentPath, displayPath: "attachment.txt" }],
        config: {},
      });
      expect(receivedAttachments).toEqual([
        {
          fileName: "attachment.txt",
          displayPath: "attachment.txt",
          sizeBytes: contents.byteLength,
          contentBase64: contents.toString("base64"),
        },
      ]);
    } finally {
      await close(server);
      await fsPromises.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "mutates the opened file",
      changeWhen: "read" as const,
      change: async (attachmentPath: string) => {
        await fsPromises.writeFile(
          attachmentPath,
          Buffer.alloc(Buffer.byteLength("trusted attachment"), 0x78),
        );
      },
    },
    {
      name: "swaps the named path",
      changeWhen: "close" as const,
      change: async (attachmentPath: string, directory: string) => {
        const replacementPath = path.join(directory, "replacement.txt");
        await fsPromises.writeFile(
          replacementPath,
          Buffer.alloc(Buffer.byteLength("trusted attachment"), 0x78),
        );
        await fsPromises.rename(replacementPath, attachmentPath);
      },
    },
    {
      name: "adds a hardlink",
      changeWhen: "read" as const,
      change: async (attachmentPath: string, directory: string) => {
        await fsPromises.link(attachmentPath, path.join(directory, "attachment-link.txt"));
      },
    },
  ])("does not send replacement attachment bytes when it $name", async ({ change, changeWhen }) => {
    const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "oracle-remote-attachment-"));
    const attachmentPath = path.join(directory, "attachment.txt");
    await fsPromises.writeFile(attachmentPath, "trusted attachment");
    let runRequests = 0;
    const server = createAuthenticatedServer(async (req, res) => {
      if (runTransactionToken(req)) runRequests += 1;
      res.statusCode = 500;
      res.end();
    });
    const port = await listen(server);
    const actualFs = await vi.importActual<typeof fsPromises>("node:fs/promises");
    let changed = false;
    let closedBeforeChange = false;
    const applyChange = async (): Promise<void> => {
      await change(attachmentPath, directory);
      changed = true;
    };
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      open: async (...args: Parameters<typeof actualFs.open>) => {
        const handle = await actualFs.open(...args);
        return new Proxy(handle, {
          get(target, property) {
            if (property === "readFile") {
              return async (...readArgs: Parameters<typeof target.readFile>) => {
                if (!changed && changeWhen === "read") await applyChange();
                return await target.readFile(...readArgs);
              };
            }
            if (property === "close") {
              return async (...closeArgs: Parameters<typeof target.close>) => {
                const result = await target.close(...closeArgs);
                if (!changed && changeWhen === "close") {
                  closedBeforeChange = true;
                  await applyChange();
                }
                return result;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    }));
    // The client captures built-in ESM bindings, so reload it after installing this test-only seam.
    const { createRemoteBrowserExecutor: isolatedCreateRemoteBrowserExecutor } =
      await import("../../src/remote/client.js");
    try {
      await expect(
        isolatedCreateRemoteBrowserExecutor({
          host: `127.0.0.1:${port}`,
          token: "a".repeat(64),
          deadlines,
        })({
          prompt: "attachment",
          attachments: [{ path: attachmentPath, displayPath: "attachment.txt" }],
          config: {},
        }),
      ).rejects.toThrow(/attachment changed while it was being read/i);
      expect(changed).toBe(true);
      expect(closedBeforeChange).toBe(changeWhen === "close");
      expect(runRequests).toBe(0);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
      await close(server);
      await fsPromises.rm(directory, { recursive: true, force: true });
    }
  });

  it("times out held run and retry requests while preserving opaque retry authority", async () => {
    const server = createAuthenticatedServer(async (req, res) => {
      if (runTransactionToken(req)) {
        await readJson(req);
        return;
      }
      if (req.url?.endsWith("/retry")) return;
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(server);
    try {
      const error = await createRemoteBrowserTransactionExecutor({
        host: `127.0.0.1:${port}`,
        token: "a".repeat(64),
        deadlines,
      })({ prompt: "timeout", config: {} }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({
        name: "BrowserAutomationError",
        details: {
          recoverableDisconnect: true,
          runtime: {
            recoveryCleanupResources: [{ remoteRecovery: { state: "recoverable-error" } }],
          },
        },
      });
      expect(error).not.toHaveProperty("details.runtime.remoteRecovery");
      expect(error).not.toHaveProperty(
        "details.runtime.recoveryCleanupResources.0.recoveryCleanup.transport",
      );
    } finally {
      await close(server);
    }
  });

  it("returns pending settlement authority when finalize holds the socket open", async () => {
    const server = createAuthenticatedServer(async (req, res) => {
      const transactionToken = runTransactionToken(req);
      if (transactionToken) {
        const request = await readJson(req);
        expect(request).not.toHaveProperty("transactionToken");
        res.setHeader("content-type", "application/x-ndjson");
        res.end(`${JSON.stringify(transactionEvent(transactionToken, String(request.prompt)))}\n`);
        return;
      }
      if (req.url?.endsWith("/finalize")) return;
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(server);
    try {
      const transaction = await createRemoteBrowserTransactionExecutor({
        host: `127.0.0.1:${port}`,
        token: "a".repeat(64),
        deadlines,
      })({ prompt: "settle", config: {} });
      const finalization = await transaction.finalize();
      expect(finalization).toMatchObject({
        status: "pending",
        runtime: {
          recoveryCleanupResources: [{ remoteRecovery: { state: "pending" } }],
          recoveryCleanupResult: { settlementMode: "finalize" },
        },
        error: expect.stringMatching(/idle timeout|overall timeout/i),
      });
      expect(finalization.runtime).not.toHaveProperty("remoteRecovery");
    } finally {
      await close(server);
    }
  });

  it("auto-finalizes only after preserving artifact publication on download failure", async () => {
    const artifact = Buffer.from("artifact");
    const descriptor = {
      artifactId: "artifact-1",
      runId: "run-1",
      kind: "file" as const,
      filename: "result.bin",
      byteSize: artifact.byteLength,
      sha256: createHash("sha256").update(artifact).digest("hex"),
      sourceUrlKind: "browser-download" as const,
      transferStatus: "ready" as const,
      required: true,
    };
    let settlementRequests = 0;
    let waiverRequests = 0;
    const server = createAuthenticatedServer(async (req, res) => {
      const transactionToken = runTransactionToken(req);
      if (transactionToken) {
        const request = await readJson(req);
        expect(request).not.toHaveProperty("transactionToken");
        res.setHeader("content-type", "application/x-ndjson");
        res.end(
          `${JSON.stringify(transactionEvent(transactionToken, String(request.prompt), [descriptor]))}\n`,
        );
        return;
      }
      if (req.url?.includes("/artifacts/") && req.method === "GET") return;
      const waiver =
        /^\/transactions\/([a-f0-9]{64})\/artifacts\/artifact-1\/manual-copy-waiver$/u.exec(
          req.url ?? "",
        );
      if (req.method === "POST" && waiver) {
        waiverRequests += 1;
        expect(await readJson(req)).toEqual({
          sha256: descriptor.sha256,
          byteSize: descriptor.byteSize,
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, artifactId: descriptor.artifactId }));
        return;
      }
      const finalize = /^\/transactions\/([a-f0-9]{64})\/finalize$/u.exec(req.url ?? "");
      if (req.method === "POST" && finalize) {
        settlementRequests += 1;
        expect(await readJson(req)).toEqual({ durablePublication: true });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(finalizedSettlement(finalize[1]!, "artifact")));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(server);
    const host = `127.0.0.1:${port}`;
    const oracleHome = await fsPromises.mkdtemp(path.join(os.tmpdir(), "oracle-remote-transport-"));
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      const result = await createRemoteBrowserExecutor({
        host,
        token: "a".repeat(64),
        deadlines,
      })({ prompt: "artifact", config: {}, sessionId: "held-artifact" });
      expect(result).toMatchObject({
        answerText: "answer",
        answerMarkdown: "answer",
        warnings: [
          {
            code: "remote-artifact-manual-copy-required",
            severity: "warning",
            message: expect.stringContaining(`remote browser host ${host}`),
          },
        ],
      });
      expect(result.warnings?.[0]?.message).toMatch(/copy the generated file\(s\) manually/i);
      expect(result.warnings?.[0]?.message).toContain("result.bin");
      expect(result).not.toHaveProperty("artifacts");
      expect(result).not.toHaveProperty("savedFiles");
      expect(result).not.toHaveProperty("runtime");
      expect(result).not.toHaveProperty("bindSettlement");
      expect(result).not.toHaveProperty("finalize");
      expect(result).not.toHaveProperty("abort");
      expect(settlementRequests).toBe(1);
      expect(waiverRequests).toBe(1);
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await close(server);
      await fsPromises.rm(oracleHome, { recursive: true, force: true });
    }
  });

  it("keeps finalize pending when a required artifact waiver cannot persist", async () => {
    const artifact = Buffer.from("artifact");
    const descriptor = {
      artifactId: "artifact-waiver-pending",
      runId: "run-1",
      kind: "file" as const,
      filename: "pending.bin",
      byteSize: artifact.byteLength,
      sha256: createHash("sha256").update(artifact).digest("hex"),
      sourceUrlKind: "browser-download" as const,
      transferStatus: "ready" as const,
      required: true,
    };
    let waiverRequests = 0;
    let settlementRequests = 0;
    const server = createAuthenticatedServer(async (req, res) => {
      const transactionToken = runTransactionToken(req);
      if (transactionToken) {
        const request = await readJson(req);
        res.setHeader("content-type", "application/x-ndjson");
        res.end(
          `${JSON.stringify(transactionEvent(transactionToken, String(request.prompt), [descriptor]))}\n`,
        );
        return;
      }
      if (req.method === "GET" && req.url?.includes("/artifacts/artifact-waiver-pending")) {
        res.statusCode = 503;
        res.end("artifact unavailable");
        return;
      }
      if (req.method === "POST" && req.url?.endsWith("/manual-copy-waiver")) {
        waiverRequests += 1;
        await readJson(req);
        res.statusCode = 503;
        res.end("waiver store unavailable");
        return;
      }
      if (req.method === "POST" && req.url?.endsWith("/finalize")) settlementRequests += 1;
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(server);
    const oracleHome = await fsPromises.mkdtemp(path.join(os.tmpdir(), "oracle-waiver-pending-"));
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      const transaction = await createRemoteBrowserTransactionExecutor({
        host: `127.0.0.1:${port}`,
        token: "a".repeat(64),
        deadlines,
      })({ prompt: "waiver pending", config: {}, sessionId: "waiver-pending" });
      expect(transaction).toMatchObject({
        answerText: "answer",
        warnings: [
          expect.objectContaining({
            code: "remote-artifact-manual-copy-required",
            message: expect.stringContaining("Manual-copy waiver remains pending"),
          }),
        ],
      });
      const finalization = await transaction.finalize();
      expect(finalization).toMatchObject({
        status: "pending",
        error: expect.stringContaining("manual-copy waiver remains retryable"),
        runtime: {
          recoveryCleanupResult: { settlementMode: "finalize" },
          recoveryCleanupResources: [{ remoteRecovery: { state: "pending" } }],
        },
      });
      expect(waiverRequests).toBe(2);
      expect(settlementRequests).toBe(0);
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await close(server);
      await fsPromises.rm(oracleHome, { recursive: true, force: true });
    }
  });

  it("persists exact pre-receipt authority before sending a run request", async () => {
    const events: string[] = [];
    const persistedRuntimes: BrowserRuntimeMetadata[] = [];
    const server = createAuthenticatedServer(async (req, res) => {
      const transactionToken = runTransactionToken(req);
      if (!transactionToken) {
        res.statusCode = 404;
        res.end();
        return;
      }
      events.push("network:run");
      const request = await readJson(req);
      res.setHeader("content-type", "application/x-ndjson");
      res.end(`${JSON.stringify(transactionEvent(transactionToken, String(request.prompt)))}\n`);
    });
    const port = await listen(server);
    try {
      const transaction = await createRemoteBrowserTransactionExecutor({
        host: `127.0.0.1:${port}`,
        token: "a".repeat(64),
        deadlines,
      })({
        prompt: "persist before network",
        config: {},
        runtimeHintCb: async (runtime) => {
          events.push(`persist:${remoteRecovery(runtime)?.state}`);
          persistedRuntimes.push(runtime);
        },
      });

      expect(events.slice(0, 2)).toEqual(["persist:pre-receipt", "network:run"]);
      expect(remoteRecovery(persistedRuntimes[0])).toMatchObject({
        state: "pre-receipt",
        requestIdentity: {
          acceptedPromptSha256: [promptIdentitySha256("persist before network")],
          followUpOrdinal: 0,
          remainingFollowUps: 0,
        },
      });
      expect(persistedRuntimes[0]).not.toHaveProperty("remoteRecovery");
      expect(persistedRuntimes[0]).not.toHaveProperty("recoveryCleanupResult");
      expect(remoteRecovery(transaction.runtime)).toMatchObject({
        state: "pending",
        requestIdentity: {
          acceptedPromptSha256: [promptIdentitySha256("persist before network")],
          followUpOrdinal: 0,
          remainingFollowUps: 0,
        },
      });
      expect(transaction.runtime).not.toHaveProperty("remoteRecovery");
    } finally {
      await close(server);
    }
  });

  it("projects an initial streamed terminal error over pre-receipt authority", async () => {
    const persistedRuntimes: BrowserRuntimeMetadata[] = [];
    const server = createAuthenticatedServer(async (req, res) => {
      const transactionToken = runTransactionToken(req);
      if (!transactionToken) {
        res.statusCode = 404;
        res.end();
        return;
      }
      await readJson(req);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(
        `${JSON.stringify({
          type: "error",
          error: {
            name: "BrowserAutomationError",
            category: "browser-automation",
            message: "remote run failed terminally",
            code: "remote-run-terminal",
            stage: "remote-run",
            recoverableDisconnect: false,
          },
        })}\n`,
      );
    });
    const port = await listen(server);
    try {
      const caught = await createRemoteBrowserTransactionExecutor({
        host: `127.0.0.1:${port}`,
        token: "a".repeat(64),
        deadlines,
      })({
        prompt: "terminal initial run",
        config: {},
        runtimeHintCb: async (runtime) => {
          persistedRuntimes.push(runtime);
        },
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(caught).toMatchObject({
        name: "BrowserAutomationError",
        message: "remote run failed terminally",
        details: {
          code: "remote-run-terminal",
          stage: "remote-run",
          recoverableDisconnect: false,
          runtime: {},
        },
      });
      expect(persistedRuntimes).toHaveLength(2);
      expect(remoteRecovery(persistedRuntimes[0])).toMatchObject({ state: "pre-receipt" });
      expect(persistedRuntimes[1]).toEqual({});
      expect(caught).not.toHaveProperty("details.runtime.recoveryCleanupResources");
      expect(caught).not.toHaveProperty("details.runtime.recoveryCleanupResult");
      expect(persistedRuntimes[1]).not.toHaveProperty("recoveryCleanupResources");
      expect(persistedRuntimes[1]).not.toHaveProperty("recoveryCleanupResult");
    } finally {
      await close(server);
    }
  });

  it("retries a pre-receipt 404 until the transaction record appears", async () => {
    let transactionToken: string | null = null;
    let acceptedPrompt = "";
    let retryRequests = 0;
    const server = createAuthenticatedServer(async (req, res) => {
      const runToken = runTransactionToken(req);
      if (runToken) {
        transactionToken = runToken;
        acceptedPrompt = String((await readJson(req)).prompt);
        req.socket.destroy();
        return;
      }
      const retryToken = transactionToken;
      if (retryToken && req.url === `/transactions/${retryToken}/retry`) {
        retryRequests += 1;
        await readJson(req);
        res.setHeader("content-type", "application/json");
        if (retryRequests === 1) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "transaction_not_retained" }));
          return;
        }
        res.end(
          JSON.stringify({
            status: "transaction",
            transaction: transactionEvent(retryToken, acceptedPrompt).transaction,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(server);
    try {
      const transaction = await createRemoteBrowserTransactionExecutor({
        host: `127.0.0.1:${port}`,
        token: "a".repeat(64),
        deadlines: {
          ...deadlines,
          runOverallTimeoutMs: 500,
          controlOverallTimeoutMs: 500,
          socketIdleTimeoutMs: 250,
          recoveryWindowMs: 2_000,
        },
      })({ prompt: "record appears after retry", config: {} });

      expect(retryRequests).toBe(2);
      expect(transaction.answerText).toBe("answer");
      expect(remoteRecovery(transaction.runtime)).toMatchObject({ state: "pending" });
    } finally {
      await close(server);
    }
  });

  it("proves pre-receipt absence only after the recovery deadline", async () => {
    let transactionToken: string | null = null;
    let retryRequests = 0;
    const server = createAuthenticatedServer(async (req, res) => {
      const runToken = runTransactionToken(req);
      if (runToken) {
        transactionToken = runToken;
        await readJson(req);
        req.socket.destroy();
        return;
      }
      const retryToken = transactionToken;
      if (retryToken && req.url === `/transactions/${retryToken}/retry`) {
        retryRequests += 1;
        await readJson(req);
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "transaction_not_retained" }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(server);
    try {
      const caught = await createRemoteBrowserTransactionExecutor({
        host: `127.0.0.1:${port}`,
        token: "a".repeat(64),
        deadlines: {
          ...deadlines,
          runOverallTimeoutMs: 500,
          controlOverallTimeoutMs: 500,
          socketIdleTimeoutMs: 250,
          recoveryWindowMs: 900,
        },
      })({ prompt: "record never appears", config: {} }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(retryRequests).toBeGreaterThan(1);
      expect(caught).toMatchObject({
        message:
          "Remote transaction record did not appear before the pre-receipt recovery deadline.",
        details: {
          code: "remote-transaction-not-retained",
          recoverableDisconnect: false,
        },
      });
      expect(caught).not.toHaveProperty("details.runtime.recoveryCleanupResources");
      expect(caught).not.toHaveProperty("details.runtime.recoveryCleanupResult");
    } finally {
      await close(server);
    }
  });

  it("does not send the run request when pre-receipt persistence fails", async () => {
    let runRequests = 0;
    const persistedRuntimes: BrowserRuntimeMetadata[] = [];
    const server = createAuthenticatedServer((req, res) => {
      if (runTransactionToken(req)) runRequests += 1;
      res.statusCode = 500;
      res.end();
    });
    const port = await listen(server);
    try {
      await expect(
        createRemoteBrowserTransactionExecutor({
          host: `127.0.0.1:${port}`,
          token: "a".repeat(64),
          deadlines,
        })({
          prompt: "must persist first",
          config: {},
          runtimeHintCb: async (runtime) => {
            persistedRuntimes.push(runtime);
            throw new Error("metadata fsync failed");
          },
        }),
      ).rejects.toMatchObject({
        name: "BrowserAutomationError",
        details: { stage: "remote-runtime-persistence", recoverableDisconnect: false },
      });
      expect(runRequests).toBe(0);
      expect(persistedRuntimes).toHaveLength(1);
      expect(remoteRecovery(persistedRuntimes[0])).toMatchObject({
        state: "pre-receipt",
        requestIdentity: {
          acceptedPromptSha256: [promptIdentitySha256("must persist first")],
          followUpOrdinal: 0,
          remainingFollowUps: 0,
        },
      });
      expect(persistedRuntimes[0]).not.toHaveProperty("remoteRecovery");
      expect(persistedRuntimes[0]).not.toHaveProperty("recoveryCleanupResult");
    } finally {
      await close(server);
    }
  });

  it("rejects explicit tab authority before remote persistence or request dispatch", async () => {
    let requests = 0;
    const runtimeHintCb = vi.fn();
    const server = createAuthenticatedServer((_req, res) => {
      requests += 1;
      res.statusCode = 500;
      res.end();
    });
    const port = await listen(server);
    const remoteHost = `127.0.0.1:${port}`;
    try {
      await expect(
        createRemoteBrowserTransactionExecutor({
          host: remoteHost,
          token: "a".repeat(64),
          deadlines,
        })({
          prompt: "must preserve explicit target authority",
          config: { browserTabRef: "explicit-target" },
          runtimeHintCb,
        }),
      ).rejects.toMatchObject({
        name: "BrowserAutomationError",
        details: {
          stage: "remote-request",
          code: "explicit-browser-tab-unsupported",
          browserTabRef: "explicit-target",
          remoteHost,
        },
      });
      expect(runtimeHintCb).not.toHaveBeenCalled();
      expect(requests).toBe(0);
    } finally {
      await close(server);
    }
  });

  it("rehydrates an abort-bound recoverable error into one authority and one settlement field", async () => {
    const server = createAuthenticatedServer(async (req, res) => {
      const transactionToken = runTransactionToken(req);
      if (!transactionToken) {
        res.statusCode = 404;
        res.end();
        return;
      }
      await readJson(req);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(
        `${JSON.stringify({
          type: "error",
          error: {
            name: "BrowserAutomationError",
            category: "browser-automation",
            message: "remote capture cleanup is pending",
            recoverableDisconnect: true,
            recoveryToken: transactionToken,
            settlementMode: "abort",
            runtime: { cleanup: { status: "pending" } },
          },
        })}\n`,
      );
    });
    const port = await listen(server);
    try {
      const caught = await createRemoteBrowserTransactionExecutor({
        host: `127.0.0.1:${port}`,
        token: "a".repeat(64),
      })({ prompt: "abort-bound error", config: {} }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(caught).toMatchObject({
        name: "BrowserAutomationError",
        details: {
          recoverableDisconnect: true,
          runtime: {
            recoveryCleanupResult: { settlementMode: "abort" },
            recoveryCleanupResources: [{ remoteRecovery: { state: "recoverable-error" } }],
          },
        },
      });
      expect(caught).not.toHaveProperty("details.remoteRecovery");
      expect(caught).not.toHaveProperty("details.runtime.remoteRecovery");
      expect(caught).not.toHaveProperty(
        "details.runtime.recoveryCleanupResources.0.remoteRecovery.settlementMode",
      );
    } finally {
      await close(server);
    }
  });

  it("rejects a wire settlement mode that conflicts with persisted cleanup result", async () => {
    const transactionToken = "f".repeat(64);
    const server = createAuthenticatedServer(async (req, res) => {
      if (req.url !== `/transactions/${transactionToken}/retry`) {
        res.statusCode = 404;
        res.end();
        return;
      }
      await readJson(req);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          status: "error",
          error: {
            name: "BrowserAutomationError",
            category: "browser-automation",
            message: "remote capture cleanup is pending",
            recoverableDisconnect: true,
            recoveryToken: transactionToken,
            settlementMode: "abort",
            runtime: { cleanup: { status: "pending" } },
          },
        }),
      );
    });
    const port = await listen(server);
    const authority = {
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      host: `127.0.0.1:${port}`,
      transactionToken,
      state: "recoverable-error" as const,
    };
    try {
      await expect(
        resumeRemoteBrowserTransaction({
          runtime: {
            recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
            recoveryCleanupResources: [
              {
                remoteRecovery: authority,
                recoveryCleanup: {
                  ownsTarget: false,
                  profileKind: "none",
                  keepBrowser: false,
                },
              },
            ],
          },
          configuredHost: `127.0.0.1:${port}`,
          authToken: "a".repeat(64),
        }),
      ).rejects.toMatchObject({
        name: "BrowserAutomationError",
        details: {
          stage: "remote-protocol",
          code: "remote-settlement-mode-conflict",
          recoverableDisconnect: true,
          runtime: { recoveryCleanupResult: { settlementMode: "finalize" } },
        },
      });
    } finally {
      await close(server);
    }
  });

  it.each([
    [
      "finalized",
      "finalize",
      {
        state: "finalized",
        finalization: { status: "completed", runtime: { cleanup: { status: "completed" } } },
      },
      "remote-transaction-finalized",
    ],
    [
      "aborted",
      "abort",
      {
        state: "aborted",
        finalization: { status: "completed", runtime: { cleanup: { status: "completed" } } },
      },
      "remote-transaction-aborted",
    ],
    [
      "failed",
      undefined,
      {
        state: "failed",
        error: {
          name: "BrowserAutomationError",
          category: "browser-automation",
          message: "remote failure",
          code: "remote-terminal-failure",
          recoverableDisconnect: false,
        },
      },
      "remote-terminal-failure",
    ],
  ] as const)(
    "consumes a retained %s retry outcome exactly once",
    async (_state, mode, outcome, code) => {
      const transactionToken = "1".repeat(64);
      let retryRequests = 0;
      const server = createAuthenticatedServer(async (req, res) => {
        if (req.url !== `/transactions/${transactionToken}/retry`) {
          res.statusCode = 404;
          res.end();
          return;
        }
        retryRequests += 1;
        await readJson(req);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "terminal", transactionToken, outcome }));
      });
      const port = await listen(server);
      const host = `127.0.0.1:${port}`;
      try {
        const caught = await resumeRemoteBrowserTransaction({
          runtime: recoveryRuntime(host, transactionToken, mode),
          configuredHost: host,
          authToken: "a".repeat(64),
        }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(retryRequests).toBe(1);
        expect(caught).toMatchObject({
          name: "BrowserAutomationError",
          details: {
            code,
            recoverableDisconnect: false,
            runtime: { conversationId: "persisted-conversation" },
          },
        });
        expect(caught).not.toHaveProperty("details.runtime.recoveryCleanupResources");
        expect(caught).not.toHaveProperty("details.runtime.recoveryCleanupResult");
      } finally {
        await close(server);
      }
    },
  );

  it("treats a pruned terminal retry as definitive and clears remote authority", async () => {
    const transactionToken = "2".repeat(64);
    let retryRequests = 0;
    const server = createAuthenticatedServer(async (req, res) => {
      if (req.url === `/transactions/${transactionToken}/retry`) {
        retryRequests += 1;
        await readJson(req);
      }
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(server);
    const host = `127.0.0.1:${port}`;
    try {
      const caught = await resumeRemoteBrowserTransaction({
        runtime: recoveryRuntime(host, transactionToken, "abort"),
        configuredHost: host,
        authToken: "a".repeat(64),
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(retryRequests).toBe(1);
      expect(caught).toMatchObject({
        details: {
          code: "remote-transaction-not-retained",
          recoverableDisconnect: false,
        },
      });
      expect(caught).not.toHaveProperty("details.runtime.recoveryCleanupResources");
      expect(caught).not.toHaveProperty("details.runtime.recoveryCleanupResult");
    } finally {
      await close(server);
    }
  });

  it("stops retrying after a server conflict while preserving exact remote authority", async () => {
    const transactionToken = "3".repeat(64);
    let retryRequests = 0;
    const server = createAuthenticatedServer(async (req, res) => {
      if (req.url === `/transactions/${transactionToken}/retry`) {
        retryRequests += 1;
        await readJson(req);
      }
      res.writeHead(409, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "transaction_settlement_conflict",
          settlementAuthority: { mode: "abort", outcome: "bound", state: "pending" },
        }),
      );
    });
    const port = await listen(server);
    const host = `127.0.0.1:${port}`;
    try {
      await expect(
        resumeRemoteBrowserTransaction({
          runtime: recoveryRuntime(host, transactionToken, "abort"),
          configuredHost: host,
          authToken: "a".repeat(64),
        }),
      ).rejects.toMatchObject({
        details: {
          statusCode: 409,
          recoverableDisconnect: true,
          runtime: { recoveryCleanupResult: { settlementMode: "abort" } },
        },
      });
      expect(retryRequests).toBe(1);
    } finally {
      await close(server);
    }
  });

  it("binds request identity to the final accepted prompt and follow-up ordinal", () => {
    expect(
      buildRemotePromptRequestIdentity({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        prompt: "primary",
        attachments: [],
        fallbackSubmission: { prompt: "fallback", attachments: [] },
        browserConfig: {},
        options: {},
      }),
    ).toEqual({
      acceptedPromptSha256: [promptIdentitySha256("primary"), promptIdentitySha256("fallback")],
      followUpOrdinal: 0,
      remainingFollowUps: 0,
    });
    expect(
      buildRemotePromptRequestIdentity({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        prompt: "primary",
        attachments: [],
        fallbackSubmission: { prompt: "fallback", attachments: [] },
        browserConfig: {},
        options: { followUpPrompts: ["follow one", "follow two"] },
      }),
    ).toEqual({
      acceptedPromptSha256: [promptIdentitySha256("follow two")],
      followUpOrdinal: 2,
      remainingFollowUps: 0,
    });
  });

  it("resumes pre-receipt authority without a local committed epoch", async () => {
    const transactionToken = "c".repeat(64);
    const requestIdentity = buildRemotePromptRequestIdentity({
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      prompt: "resume exact request",
      attachments: [],
      browserConfig: {},
      options: {},
    } satisfies RemoteRunPayload);
    const server = createAuthenticatedServer(async (req, res) => {
      if (req.url === `/transactions/${transactionToken}/retry`) {
        await readJson(req);
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            status: "transaction",
            transaction: transactionEvent(transactionToken, "resume exact request").transaction,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(server);
    const runtime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          remoteRecovery: {
            protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
            host: `127.0.0.1:${port}`,
            transactionToken,
            state: "pre-receipt",
            requestIdentity,
          },
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
        },
      ],
    };
    try {
      const transaction = await resumeRemoteBrowserTransaction({
        runtime,
        configuredHost: `127.0.0.1:${port}`,
        authToken: "a".repeat(64),
      });
      expect(transaction.answerText).toBe("answer");
      expect(transaction.runtime).toMatchObject({
        promptEpoch: { promptSha256: promptIdentitySha256("resume exact request") },
        recoveryCleanupResources: [{ remoteRecovery: { state: "pending", requestIdentity } }],
      });
      expect(transaction.runtime).not.toHaveProperty("remoteRecovery");
    } finally {
      await close(server);
    }
  });

  it.each([
    ["explicit local session", "recovering-local-session", "recovering-local-session"],
    ["opaque transaction fallback", undefined, "f".repeat(64)],
  ] as const)(
    "stores resumed artifacts before receipting with %s",
    async (_case, sessionId, artifactSessionId) => {
      const tmpHome = await fsPromises.mkdtemp(
        path.join(os.tmpdir(), "oracle-remote-resume-artifact-"),
      );
      setOracleHomeDirOverrideForTest(tmpHome);
      const transactionToken = "f".repeat(64);
      const prompt = "resume artifact into local session";
      const payload = Buffer.from("recovered artifact");
      const descriptor = {
        artifactId: "artifact-1",
        runId: "run-1",
        kind: "file" as const,
        filename: "result.bin",
        mimeType: "application/octet-stream",
        byteSize: payload.length,
        sha256: createHash("sha256").update(payload).digest("hex"),
        validation: { type: "generic" as const, ok: true },
        sourceUrlKind: "browser-download" as const,
        transferStatus: "ready" as const,
        required: true,
      };
      let receipted = false;
      const server = createAuthenticatedServer(async (req, res) => {
        if (req.url === `/transactions/${transactionToken}/retry`) {
          await readJson(req);
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              status: "transaction",
              transaction: transactionEvent(transactionToken, prompt, [descriptor]).transaction,
            }),
          );
          return;
        }
        if (
          req.method === "GET" &&
          req.url === `/transactions/${transactionToken}/artifacts/${descriptor.artifactId}`
        ) {
          res.setHeader("content-length", String(payload.length));
          res.setHeader("x-oracle-artifact-sha256", descriptor.sha256);
          res.end(payload);
          return;
        }
        if (
          req.method === "POST" &&
          req.url === `/transactions/${transactionToken}/artifacts/${descriptor.artifactId}/receipt`
        ) {
          await readJson(req);
          const localArtifact = path.join(
            tmpHome,
            "sessions",
            artifactSessionId,
            "artifacts",
            "artifact-artifact-1.bin",
          );
          await expect(fsPromises.readFile(localArtifact)).resolves.toEqual(payload);
          receipted = true;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      const port = await listen(server);
      const host = `127.0.0.1:${port}`;
      const runtime: BrowserRuntimeMetadata = {
        recoveryCleanupResources: [
          {
            remoteRecovery: {
              protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
              host,
              transactionToken,
              state: "pre-receipt",
              requestIdentity: {
                acceptedPromptSha256: [promptIdentitySha256(prompt)],
                followUpOrdinal: 0,
                remainingFollowUps: 0,
              },
            },
            recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
          },
        ],
      };

      try {
        const transaction = await resumeRemoteBrowserTransaction({
          runtime,
          configuredHost: host,
          authToken: "a".repeat(64),
          ...(sessionId ? { sessionId } : {}),
        });
        expect(receipted).toBe(true);
        expect(transaction.savedFiles?.[0]?.path).toBe(
          path.join(tmpHome, "sessions", artifactSessionId, "artifacts", "artifact-artifact-1.bin"),
        );
        await expect(
          fsPromises.stat(
            path.join(
              tmpHome,
              "sessions",
              descriptor.runId,
              "artifacts",
              "artifact-artifact-1.bin",
            ),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await close(server);
        setOracleHomeDirOverrideForTest(null);
        await fsPromises.rm(tmpHome, { recursive: true, force: true });
      }
    },
  );

  it("rejects a resumed committed epoch that mismatches persisted request identity", async () => {
    const transactionToken = "d".repeat(64);
    const requestIdentity = buildRemotePromptRequestIdentity({
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      prompt: "expected prompt",
      attachments: [],
      browserConfig: {},
      options: {},
    } satisfies RemoteRunPayload);
    const server = createAuthenticatedServer(async (req, res) => {
      if (req.url === `/transactions/${transactionToken}/retry`) {
        await readJson(req);
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            status: "transaction",
            transaction: transactionEvent(transactionToken, "different prompt").transaction,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(server);
    const runtime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          remoteRecovery: {
            protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
            host: `127.0.0.1:${port}`,
            transactionToken,
            state: "pre-receipt",
            requestIdentity,
          },
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
        },
      ],
    };
    try {
      await expect(
        resumeRemoteBrowserTransaction({
          runtime,
          configuredHost: `127.0.0.1:${port}`,
          authToken: "a".repeat(64),
        }),
      ).rejects.toMatchObject({
        name: "BrowserAutomationError",
        details: {
          code: "remote-prompt-authority-mismatch",
          recoverableDisconnect: true,
          runtime: {
            recoveryCleanupResources: [
              { remoteRecovery: { state: "pre-receipt", requestIdentity } },
            ],
          },
        },
      });
    } finally {
      await close(server);
    }
  });

  it("rejects a resumed transaction that differs from the persisted committed epoch", async () => {
    const transactionToken = "e".repeat(64);
    const prompt = "same prompt";
    const requestIdentity = buildRemotePromptRequestIdentity({
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      prompt,
      attachments: [],
      browserConfig: {},
      options: {},
    } satisfies RemoteRunPayload);
    const persistedPromptEpoch = {
      ...committedPromptEpoch(prompt),
      verifiedUserTurnId: "persisted-turn",
    };
    const server = createAuthenticatedServer(async (req, res) => {
      if (req.url === `/transactions/${transactionToken}/retry`) {
        await readJson(req);
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            status: "transaction",
            transaction: transactionEvent(transactionToken, prompt).transaction,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(server);
    const runtime: BrowserRuntimeMetadata = {
      promptEpoch: persistedPromptEpoch,
      recoveryCleanupResources: [
        {
          remoteRecovery: {
            protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
            host: `127.0.0.1:${port}`,
            transactionToken,
            state: "pending",
            requestIdentity,
          },
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
        },
      ],
    };
    try {
      await expect(
        resumeRemoteBrowserTransaction({
          runtime,
          configuredHost: `127.0.0.1:${port}`,
          authToken: "a".repeat(64),
        }),
      ).rejects.toMatchObject({
        name: "BrowserAutomationError",
        details: {
          code: "remote-prompt-authority-mismatch",
          recoverableDisconnect: true,
          runtime,
        },
      });
    } finally {
      await close(server);
    }
  });

  it.each([
    ["bound", "pending", "transaction_settlement_conflict", true],
    ["completed", "finalized", "transaction_already_settled", false],
  ] as const)(
    "converges an opposite-mode bind conflict to the authoritative %s outcome",
    async (outcome, state, errorCode, recoverableDisconnect) => {
      const prompt = `canonical ${outcome} conflict`;
      let settlementRequests = 0;
      const server = createAuthenticatedServer(
        async (req, res) => {
          const transactionToken = runTransactionToken(req);
          if (transactionToken) {
            const request = await readJson(req);
            res.setHeader("content-type", "application/x-ndjson");
            res.end(
              `${JSON.stringify(transactionEvent(transactionToken, String(request.prompt)))}\n`,
            );
            return;
          }
          const bind = /^\/transactions\/([a-f0-9]{64})\/bind$/u.exec(req.url ?? "");
          if (bind) {
            await readJson(req);
            res.writeHead(409, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: errorCode,
                settlementAuthority: { mode: "finalize", outcome, state },
              }),
            );
            return;
          }
          if (/^\/transactions\/[a-f0-9]{64}\/(finalize|abort)$/u.test(req.url ?? "")) {
            settlementRequests += 1;
          }
          res.statusCode = 404;
          res.end();
        },
        { handleBind: false },
      );
      const port = await listen(server);
      try {
        const transaction = await createRemoteBrowserTransactionExecutor({
          host: `127.0.0.1:${port}`,
          token: "a".repeat(64),
          deadlines,
        })({ prompt, config: {} });
        const caught = await transaction.abort().then(
          () => null,
          (error: unknown) => error,
        );
        expect(caught).toMatchObject({
          name: "BrowserAutomationError",
          details: {
            code: "remote-settlement-mode-conflict",
            recoverableDisconnect,
            settlementAuthority: { mode: "finalize", outcome, state },
          },
        });
        if (outcome === "bound") {
          expect(transaction.runtime).toMatchObject({
            recoveryCleanupResult: { settlementMode: "finalize" },
          });
        } else {
          expect(transaction.runtime).not.toHaveProperty("recoveryCleanupResult");
          expect(transaction.runtime).not.toHaveProperty("recoveryCleanupResources");
        }
        expect(settlementRequests).toBe(0);
      } finally {
        await close(server);
      }
    },
  );

  it("keeps explicit bind failures throwable without starting cleanup", async () => {
    const prompt = "explicit bind persistence";
    let bindRequests = 0;
    let settlementRequests = 0;
    let persistenceAttempts = 0;
    const server = createAuthenticatedServer(
      async (req, res) => {
        const transactionToken = runTransactionToken(req);
        if (transactionToken) {
          const request = await readJson(req);
          res.setHeader("content-type", "application/x-ndjson");
          res.end(
            `${JSON.stringify(transactionEvent(transactionToken, String(request.prompt)))}\n`,
          );
          return;
        }
        const bind = /^\/transactions\/([a-f0-9]{64})\/bind$/u.exec(req.url ?? "");
        if (bind) {
          bindRequests += 1;
          await readJson(req);
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              transactionToken: bind[1],
              settlementAuthority: { mode: "abort", outcome: "bound", state: "pending" },
              runtime: { cleanup: { status: "pending" } },
            }),
          );
          return;
        }
        const abort = /^\/transactions\/([a-f0-9]{64})\/abort$/u.exec(req.url ?? "");
        if (abort) {
          settlementRequests += 1;
          await readJson(req);
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              transactionToken: abort[1],
              state: "aborted",
              settlementAuthority: { mode: "abort", outcome: "completed", state: "aborted" },
              finalization: {
                status: "completed",
                runtime: {
                  promptEpoch: committedPromptEpoch(prompt),
                  cleanup: { status: "completed" },
                },
              },
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end();
      },
      { handleBind: false },
    );
    const port = await listen(server);
    try {
      const transaction = await createRemoteBrowserTransactionExecutor({
        host: `127.0.0.1:${port}`,
        token: "a".repeat(64),
        deadlines,
      })({
        prompt,
        config: {},
        runtimeHintCb: async (runtime) => {
          if (!runtime.recoveryCleanupResult?.settlementMode) return;
          persistenceAttempts += 1;
          if (persistenceAttempts === 1) throw new Error("metadata fsync failed");
        },
      });

      await expect(transaction.bindSettlement("abort")).rejects.toMatchObject({
        details: { code: "settlement-authority-persistence-failed" },
      });
      expect(transaction.runtime).toMatchObject({
        recoveryCleanupResult: { settlementMode: "abort" },
      });
      expect(bindRequests).toBe(1);
      expect(settlementRequests).toBe(0);

      await expect(transaction.abort()).resolves.toMatchObject({ status: "completed" });
      expect(persistenceAttempts).toBe(2);
      expect(bindRequests).toBe(1);
      expect(settlementRequests).toBe(1);
    } finally {
      await close(server);
    }
  });

  it("persists one settlement mode before request and retries only that mode", async () => {
    const events: string[] = [];
    let finalizeAttempts = 0;
    let prompt = "settlement mode";
    const server = createAuthenticatedServer(async (req, res) => {
      const transactionToken = runTransactionToken(req);
      if (transactionToken) {
        const request = await readJson(req);
        prompt = String(request.prompt);
        res.setHeader("content-type", "application/x-ndjson");
        res.end(`${JSON.stringify(transactionEvent(transactionToken, prompt))}\n`);
        return;
      }
      const settlement = /^\/transactions\/([a-f0-9]{64})\/(finalize|abort)$/u.exec(req.url ?? "");
      if (settlement) {
        await readJson(req);
        events.push(`network:${settlement[2]}`);
        if (settlement[2] === "abort") {
          res.statusCode = 500;
          res.end("abort must not be requested");
          return;
        }
        finalizeAttempts += 1;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            finalizeAttempts === 1
              ? {
                  transactionToken: settlement[1],
                  state: "pending",
                  settlementAuthority: {
                    mode: "finalize",
                    outcome: "bound",
                    state: "pending",
                  },
                  finalization: {
                    status: "pending",
                    runtime: {
                      promptEpoch: committedPromptEpoch(prompt),
                      cleanup: { status: "pending" },
                    },
                    error: "retry finalize",
                  },
                }
              : {
                  transactionToken: settlement[1],
                  state: "finalized",
                  settlementAuthority: {
                    mode: "finalize",
                    outcome: "completed",
                    state: "finalized",
                  },
                  finalization: {
                    status: "completed",
                    runtime: {
                      promptEpoch: committedPromptEpoch(prompt),
                      cleanup: { status: "completed" },
                    },
                  },
                },
          ),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(server);
    try {
      const transaction = await createRemoteBrowserTransactionExecutor({
        host: `127.0.0.1:${port}`,
        token: "a".repeat(64),
        deadlines: { ...deadlines, controlOverallTimeoutMs: 1_000, socketIdleTimeoutMs: 500 },
      })({
        prompt,
        config: {},
        runtimeHintCb: async (runtime) => {
          const mode = runtime.recoveryCleanupResult?.settlementMode;
          if (mode) events.push(`persist:${mode}`);
        },
      });
      const firstFinalization = await transaction.finalize();
      expect(firstFinalization).toMatchObject({
        status: "pending",
        runtime: {
          recoveryCleanupResult: { settlementMode: "finalize" },
          recoveryCleanupResources: [
            {
              remoteRecovery: {
                requestIdentity: {
                  acceptedPromptSha256: [promptIdentitySha256(prompt)],
                  followUpOrdinal: 0,
                  remainingFollowUps: 0,
                },
              },
            },
          ],
        },
      });
      expect(firstFinalization.runtime).not.toHaveProperty("remoteRecovery");
      expect(remoteRecovery(firstFinalization.runtime)).not.toHaveProperty("settlementMode");
      expect(events.slice(-2)).toEqual(["persist:finalize", "network:finalize"]);
      await expect(transaction.abort()).rejects.toMatchObject({
        details: { code: "settlement-mode-conflict" },
      });
      expect(events).not.toContain("network:abort");
      await expect(transaction.finalize()).resolves.toMatchObject({ status: "completed" });
      expect(events.filter((event) => event === "network:finalize")).toHaveLength(2);
    } finally {
      await close(server);
    }
  });

  it("retries settlement authority persistence before any finalize request", async () => {
    const events: string[] = [];
    let settlementPersistenceAttempts = 0;
    const prompt = "settlement persistence retry";
    const server = createAuthenticatedServer(async (req, res) => {
      const transactionToken = runTransactionToken(req);
      if (transactionToken) {
        const request = await readJson(req);
        res.setHeader("content-type", "application/x-ndjson");
        res.end(`${JSON.stringify(transactionEvent(transactionToken, String(request.prompt)))}\n`);
        return;
      }
      const settlement = /^\/transactions\/([a-f0-9]{64})\/(finalize|abort)$/u.exec(req.url ?? "");
      if (settlement) {
        await readJson(req);
        events.push(`network:${settlement[2]}`);
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            transactionToken: settlement[1],
            state: settlement[2] === "finalize" ? "finalized" : "aborted",
            settlementAuthority: {
              mode: settlement[2],
              outcome: "completed",
              state: settlement[2] === "finalize" ? "finalized" : "aborted",
            },
            finalization: {
              status: "completed",
              runtime: {
                promptEpoch: committedPromptEpoch(prompt),
                cleanup: { status: "completed" },
              },
            },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(server);
    try {
      const transaction = await createRemoteBrowserTransactionExecutor({
        host: `127.0.0.1:${port}`,
        token: "a".repeat(64),
        deadlines,
      })({
        prompt,
        config: {},
        runtimeHintCb: async (runtime) => {
          const mode = runtime.recoveryCleanupResult?.settlementMode;
          if (!mode) return;
          settlementPersistenceAttempts += 1;
          events.push(`persist:${mode}:${settlementPersistenceAttempts}`);
          if (settlementPersistenceAttempts === 1) {
            throw new Error("metadata fsync failed");
          }
        },
      });

      await expect(transaction.finalize()).resolves.toMatchObject({
        status: "pending",
        runtime: { recoveryCleanupResult: { settlementMode: "finalize" } },
        error: expect.stringContaining("persist remote finalize settlement authority"),
      });
      expect(transaction.runtime.recoveryCleanupResult).toMatchObject({
        settlementMode: "finalize",
      });
      expect(events).toEqual(["persist:finalize:1"]);

      await expect(transaction.abort()).rejects.toMatchObject({
        details: { code: "settlement-mode-conflict" },
      });
      expect(events).toEqual(["persist:finalize:1"]);

      await expect(transaction.finalize()).resolves.toMatchObject({ status: "completed" });
      expect(events).toEqual(["persist:finalize:1", "persist:finalize:2", "network:finalize"]);
    } finally {
      await close(server);
    }
  });

  it("replaces a corrupt cached artifact before posting its durable receipt", async () => {
    const oracleHome = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "oracle-remote-durable-artifact-"),
    );
    setOracleHomeDirOverrideForTest(oracleHome);
    const payload = Buffer.from("durable artifact");
    const descriptor = {
      artifactId: "artifact-1",
      runId: "run-1",
      kind: "file" as const,
      filename: "result.bin",
      byteSize: payload.byteLength,
      sha256: createHash("sha256").update(payload).digest("hex"),
      sourceUrlKind: "browser-download" as const,
      transferStatus: "ready" as const,
      required: true,
    };
    const finalPath = path.join(
      oracleHome,
      "sessions",
      "durable-artifact",
      "artifacts",
      "artifact-artifact-1.bin",
    );
    const artifactsDirectory = path.dirname(finalPath);
    const sessionDirectory = path.dirname(artifactsDirectory);
    await fsPromises.mkdir(artifactsDirectory, { recursive: true });
    await fsPromises.writeFile(finalPath, "corrupt artifact");
    const durabilityEvents: string[] = [];
    const originalSyncDirectory = fsDurability.syncDirectory;
    const syncDirectory = vi
      .spyOn(fsDurability, "syncDirectory")
      .mockImplementation(async (directory) => {
        durabilityEvents.push(`sync:${directory}`);
        await originalSyncDirectory(directory);
      });
    let artifactGets = 0;
    let receiptCount = 0;
    let observedAtReceipt: { contents: Buffer; mode: number; partExists: boolean } | undefined;
    const server = createAuthenticatedServer(async (req, res) => {
      const transactionToken = runTransactionToken(req);
      if (transactionToken) {
        const request = await readJson(req);
        res.setHeader("content-type", "application/x-ndjson");
        res.end(
          `${JSON.stringify(transactionEvent(transactionToken, String(request.prompt), [descriptor]))}\n`,
        );
        return;
      }
      if (req.method === "GET" && req.url?.includes("/artifacts/artifact-1")) {
        artifactGets += 1;
        res.setHeader("x-oracle-artifact-sha256", descriptor.sha256);
        res.end(payload);
        return;
      }
      if (req.method === "POST" && req.url?.endsWith("/artifacts/artifact-1/receipt")) {
        durabilityEvents.push("receipt");
        await readJson(req);
        let partExists = true;
        await fsPromises.access(`${finalPath}.part`).catch(() => {
          partExists = false;
        });
        observedAtReceipt = {
          contents: await fsPromises.readFile(finalPath),
          mode: (await fsPromises.stat(finalPath)).mode & 0o777,
          partExists,
        };
        receiptCount += 1;
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(server);
    try {
      const executor = createRemoteBrowserTransactionExecutor({
        host: `127.0.0.1:${port}`,
        token: "a".repeat(64),
        deadlines: {
          ...deadlines,
          controlOverallTimeoutMs: 1_000,
          artifactOverallTimeoutMs: 1_000,
          socketIdleTimeoutMs: 500,
        },
      });
      const transaction = await executor({
        prompt: "artifact durable",
        config: {},
        sessionId: "durable-artifact",
      });
      expect(transaction).toMatchObject({
        answerText: "answer",
        artifacts: [{ path: finalPath, sizeBytes: payload.length, sha256: descriptor.sha256 }],
        savedFiles: [{ path: finalPath, sizeBytes: payload.length, sha256: descriptor.sha256 }],
      });
      expect(transaction.warnings).toBeUndefined();
      expect(observedAtReceipt?.contents).toEqual(payload);
      expect(observedAtReceipt?.partExists).toBe(false);
      const receiptIndex = durabilityEvents.indexOf("receipt");
      expect(receiptIndex).toBeGreaterThanOrEqual(0);
      const parentSessionSyncIndex = durabilityEvents.indexOf(`sync:${sessionDirectory}`);
      const artifactsSyncIndex = durabilityEvents.indexOf(`sync:${artifactsDirectory}`);
      expect(parentSessionSyncIndex).toBeGreaterThanOrEqual(0);
      expect(artifactsSyncIndex).toBeGreaterThanOrEqual(0);
      expect(parentSessionSyncIndex).toBeLessThan(receiptIndex);
      expect(artifactsSyncIndex).toBeLessThan(receiptIndex);
      if (process.platform !== "win32") expect(observedAtReceipt?.mode).toBe(0o600);
      await executor({ prompt: "artifact durable", config: {}, sessionId: "durable-artifact" });
      expect(artifactGets).toBe(1);
      expect(receiptCount).toBe(2);
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await close(server);
      await fsPromises.rm(oracleHome, { recursive: true, force: true });
      syncDirectory.mockRestore();
    }
  });

  it("preserves text when local artifact publication fails before downloading", async () => {
    const oracleHome = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "oracle-remote-artifact-io-"),
    );
    setOracleHomeDirOverrideForTest(oracleHome);
    const payload = Buffer.from("artifact");
    const descriptor = {
      artifactId: "artifact-io",
      runId: "run-1",
      kind: "file" as const,
      filename: "result.bin",
      byteSize: payload.byteLength,
      sha256: createHash("sha256").update(payload).digest("hex"),
      sourceUrlKind: "browser-download" as const,
      transferStatus: "ready" as const,
      required: true,
    };
    const finalPath = path.join(
      oracleHome,
      "sessions",
      "artifact-io",
      "artifacts",
      "artifact-artifact-io.bin",
    );
    const artifactsDirectory = path.dirname(finalPath);
    await fsPromises.mkdir(artifactsDirectory, { recursive: true });
    await fsPromises.writeFile(finalPath, "corrupt!");
    let artifactGets = 0;
    let settlementRequests = 0;
    let waiverRequests = 0;
    const server = createAuthenticatedServer(async (req, res) => {
      const transactionToken = runTransactionToken(req);
      if (transactionToken) {
        const request = await readJson(req);
        res.setHeader("content-type", "application/x-ndjson");
        res.end(
          `${JSON.stringify(transactionEvent(transactionToken, String(request.prompt), [descriptor]))}\n`,
        );
        return;
      }
      if (req.method === "GET" && req.url?.includes("/artifacts/artifact-io")) {
        artifactGets += 1;
        res.setHeader("x-oracle-artifact-sha256", descriptor.sha256);
        res.end(payload);
        return;
      }
      const waiver =
        /^\/transactions\/([a-f0-9]{64})\/artifacts\/artifact-io\/manual-copy-waiver$/u.exec(
          req.url ?? "",
        );
      if (req.method === "POST" && waiver) {
        waiverRequests += 1;
        expect(await readJson(req)).toEqual({
          sha256: descriptor.sha256,
          byteSize: descriptor.byteSize,
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, artifactId: descriptor.artifactId }));
        return;
      }
      const finalize = /^\/transactions\/([a-f0-9]{64})\/finalize$/u.exec(req.url ?? "");
      if (req.method === "POST" && finalize) {
        settlementRequests += 1;
        expect(await readJson(req)).toEqual({ durablePublication: true });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(finalizedSettlement(finalize[1]!, "artifact I/O")));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(server);
    const host = `127.0.0.1:${port}`;
    const originalSyncDirectory = fsDurability.syncDirectory;
    let injectedFailure = false;
    const syncDirectory = vi
      .spyOn(fsDurability, "syncDirectory")
      .mockImplementation(async (directory) => {
        await originalSyncDirectory(directory);
        if (directory === artifactsDirectory && !injectedFailure) {
          injectedFailure = true;
          throw Object.assign(new Error("injected artifact cache I/O failure"), { code: "EIO" });
        }
      });
    try {
      const transaction = await createRemoteBrowserTransactionExecutor({
        host,
        token: "a".repeat(64),
        deadlines,
      })({ prompt: "artifact I/O", config: {}, sessionId: "artifact-io" });
      expect(transaction).toMatchObject({
        answerText: "answer",
        warnings: [
          {
            code: "remote-artifact-manual-copy-required",
            severity: "warning",
            message: expect.stringContaining("injected artifact cache I/O failure"),
          },
        ],
      });
      expect(transaction.warnings?.[0]?.message).toContain(`remote browser host ${host}`);
      expect(transaction).not.toHaveProperty("artifacts");
      expect(transaction).not.toHaveProperty("savedFiles");
      expect(artifactGets).toBe(0);
      await expect(transaction.finalize()).resolves.toMatchObject({ status: "completed" });
      expect(settlementRequests).toBe(1);
      expect(waiverRequests).toBe(1);
    } finally {
      syncDirectory.mockRestore();
      setOracleHomeDirOverrideForTest(null);
      await close(server);
      await fsPromises.rm(oracleHome, { recursive: true, force: true });
    }
  });
  it("rejects route-confusion transaction tokens before remote transport", async () => {
    const validToken = "d".repeat(64);
    const confusedToken = `${validToken}/bind?ignored=`;
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests += 1;
      res.statusCode = 500;
      res.end();
    });
    const port = await listen(server);
    const host = `127.0.0.1:${port}`;
    const invalidRuntime = recoveryRuntime(host, confusedToken);
    try {
      expect(() => findRemoteRecoveryAuthority(invalidRuntime)).toThrow(
        /exactly 64 lowercase hexadecimal characters/i,
      );
      expect(findRemoteRecoveryAuthority(recoveryRuntime(host, validToken))).toMatchObject({
        transactionToken: validToken,
      });
      await expect(
        resumeRemoteBrowserTransaction({
          runtime: invalidRuntime,
          configuredHost: host,
          authToken: "a".repeat(64),
        }),
      ).rejects.toMatchObject({ details: { code: "invalid-remote-transaction-token" } });
      await expect(
        bindRemoteBrowserSettlement({
          hostname: "127.0.0.1",
          port,
          token: "a".repeat(64),
          host,
          transactionToken: confusedToken,
          recoveryState: "recoverable-error",
          mode: "finalize",
          runtime: invalidRuntime,
          deadlines,
        }),
      ).rejects.toMatchObject({ details: { code: "invalid-remote-transaction-token" } });
      for (const mode of ["finalize", "abort"] as const) {
        await expect(
          settleRemoteBrowserTransaction({
            hostname: "127.0.0.1",
            port,
            token: "a".repeat(64),
            host,
            transactionToken: confusedToken,
            recoveryState: "recoverable-error",
            mode,
            runtime: invalidRuntime,
            deadlines,
          }),
        ).rejects.toMatchObject({ details: { code: "invalid-remote-transaction-token" } });
      }
      await expect(
        settleRemoteBrowserRecovery({
          runtime: invalidRuntime,
          configuredHost: host,
          authToken: "a".repeat(64),
          deadlines,
        }),
      ).rejects.toMatchObject({ details: { code: "invalid-remote-transaction-token" } });
      expect(requests).toBe(0);
    } finally {
      await close(server);
    }
  });
});
