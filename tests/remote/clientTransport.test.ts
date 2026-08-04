import http from "node:http";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createRemoteBrowserExecutor,
  resumeRemoteBrowserTransaction,
} from "../../src/remote/client.js";
import {
  buildRemotePromptRequestIdentity,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  type RemoteRunPayload,
} from "../../src/remote/types.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { promptIdentitySha256 } from "../../src/browser/actions/promptComposer.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionManager.js";

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
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function runTransactionToken(req: http.IncomingMessage): string | null {
  if (req.method !== "POST") return null;
  return /^\/transactions\/([a-f0-9]{64})\/run$/u.exec(req.url ?? "")?.[1] ?? null;
}

async function listen(server: http.Server): Promise<number> {
  const { promise, resolve, reject } = createDeferred<number>();
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
  const { promise, resolve, reject } = createDeferred<void>();
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

const deadlines = {
  runOverallTimeoutMs: 120,
  controlOverallTimeoutMs: 80,
  artifactOverallTimeoutMs: 100,
  socketIdleTimeoutMs: 40,
  recoveryWindowMs: 120,
};

describe("remote client transport deadlines", () => {
  it("times out held run and retry requests while preserving opaque retry authority", async () => {
    const server = http.createServer(async (req, res) => {
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
      const error = await createRemoteBrowserExecutor({
        host: `127.0.0.1:${port}`,
        token: "secret",
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
            recoveryCleanupResources: [{ recoveryCleanup: { transport: "remote" } }],
            remoteRecovery: { state: "recoverable-error" },
          },
        },
      });
    } finally {
      await close(server);
    }
  });

  it("returns pending settlement authority when finalize holds the socket open", async () => {
    const server = http.createServer(async (req, res) => {
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
      const transaction = await createRemoteBrowserExecutor({
        host: `127.0.0.1:${port}`,
        token: "secret",
        deadlines,
      })({ prompt: "settle", config: {} });
      await expect(transaction.finalize()).resolves.toMatchObject({
        status: "pending",
        runtime: { remoteRecovery: { state: "pending" } },
        error: expect.stringMatching(/idle timeout|overall timeout/i),
      });
    } finally {
      await close(server);
    }
  });

  it("times out a held artifact download without allowing terminal settlement", async () => {
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
    const server = http.createServer(async (req, res) => {
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
      if (req.url?.endsWith("/finalize")) settlementRequests += 1;
      res.statusCode = 404;
      res.end();
    });
    const port = await listen(server);
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-transport-"));
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      const error = await createRemoteBrowserExecutor({
        host: `127.0.0.1:${port}`,
        token: "secret",
        deadlines,
      })({ prompt: "artifact", config: {}, sessionId: "held-artifact" }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({
        name: "BrowserAutomationError",
        details: {
          stage: "remote-artifact-transfer",
          recoverableDisconnect: true,
          runtime: { remoteRecovery: { state: "pending" } },
        },
      });
      expect(settlementRequests).toBe(0);
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await close(server);
      await rm(oracleHome, { recursive: true, force: true });
    }
  });

  it("persists exact pre-receipt authority before sending a run request", async () => {
    const events: string[] = [];
    const persistedRuntimes: BrowserRuntimeMetadata[] = [];
    const server = http.createServer(async (req, res) => {
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
      const transaction = await createRemoteBrowserExecutor({
        host: `127.0.0.1:${port}`,
        token: "secret",
        deadlines,
      })({
        prompt: "persist before network",
        config: {},
        runtimeHintCb: async (runtime) => {
          events.push(`persist:${runtime.remoteRecovery?.state}`);
          persistedRuntimes.push(runtime);
        },
      });

      expect(events.slice(0, 2)).toEqual(["persist:pre-receipt", "network:run"]);
      expect(persistedRuntimes[0]).toMatchObject({
        remoteRecovery: {
          state: "pre-receipt",
          requestIdentity: {
            acceptedPromptSha256: [promptIdentitySha256("persist before network")],
            followUpOrdinal: 0,
            remainingFollowUps: 0,
          },
        },
      });
      expect(persistedRuntimes[0]).not.toHaveProperty("recoveryCleanupResult");
      expect(transaction.runtime.remoteRecovery).toMatchObject({
        state: "pending",
        requestIdentity: {
          acceptedPromptSha256: [promptIdentitySha256("persist before network")],
          followUpOrdinal: 0,
          remainingFollowUps: 0,
        },
      });
    } finally {
      await close(server);
    }
  });

  it("does not send the run request when pre-receipt persistence fails", async () => {
    let runRequests = 0;
    const persistedRuntimes: BrowserRuntimeMetadata[] = [];
    const server = http.createServer((req, res) => {
      if (runTransactionToken(req)) runRequests += 1;
      res.statusCode = 500;
      res.end();
    });
    const port = await listen(server);
    try {
      await expect(
        createRemoteBrowserExecutor({
          host: `127.0.0.1:${port}`,
          token: "secret",
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
      expect(persistedRuntimes[0]?.remoteRecovery).toMatchObject({
        state: "pre-receipt",
        requestIdentity: {
          acceptedPromptSha256: [promptIdentitySha256("must persist first")],
          followUpOrdinal: 0,
          remainingFollowUps: 0,
        },
      });
      expect(persistedRuntimes[0]).not.toHaveProperty("recoveryCleanupResult");
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
    const server = http.createServer(async (req, res) => {
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
    const runtime = {
      remoteRecovery: {
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        host: `127.0.0.1:${port}`,
        transactionToken,
        state: "pre-receipt" as const,
        requestIdentity,
      },
    };
    try {
      const transaction = await resumeRemoteBrowserTransaction({
        runtime,
        configuredHost: `127.0.0.1:${port}`,
        authToken: "secret",
      });
      expect(transaction.answerText).toBe("answer");
      expect(transaction.runtime).toMatchObject({
        promptEpoch: { promptSha256: promptIdentitySha256("resume exact request") },
        remoteRecovery: { state: "pending", requestIdentity },
      });
    } finally {
      await close(server);
    }
  });

  it("rejects a resumed committed epoch that mismatches persisted request identity", async () => {
    const transactionToken = "d".repeat(64);
    const requestIdentity = buildRemotePromptRequestIdentity({
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      prompt: "expected prompt",
      attachments: [],
      browserConfig: {},
      options: {},
    } satisfies RemoteRunPayload);
    const server = http.createServer(async (req, res) => {
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
    const runtime = {
      remoteRecovery: {
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        host: `127.0.0.1:${port}`,
        transactionToken,
        state: "pre-receipt" as const,
        requestIdentity,
      },
    };
    try {
      await expect(
        resumeRemoteBrowserTransaction({
          runtime,
          configuredHost: `127.0.0.1:${port}`,
          authToken: "secret",
        }),
      ).rejects.toMatchObject({
        name: "BrowserAutomationError",
        details: {
          code: "remote-prompt-authority-mismatch",
          recoverableDisconnect: true,
          runtime: { remoteRecovery: { state: "pre-receipt", requestIdentity } },
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
    const server = http.createServer(async (req, res) => {
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
      remoteRecovery: {
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        host: `127.0.0.1:${port}`,
        transactionToken,
        state: "pending",
        requestIdentity,
      },
    };
    try {
      await expect(
        resumeRemoteBrowserTransaction({
          runtime,
          configuredHost: `127.0.0.1:${port}`,
          authToken: "secret",
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

  it("persists one settlement mode before request and retries only that mode", async () => {
    const events: string[] = [];
    let finalizeAttempts = 0;
    let prompt = "settlement mode";
    const server = http.createServer(async (req, res) => {
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
      const transaction = await createRemoteBrowserExecutor({
        host: `127.0.0.1:${port}`,
        token: "secret",
        deadlines,
      })({
        prompt,
        config: {},
        runtimeHintCb: async (runtime) => {
          const mode = runtime.remoteRecovery?.settlementMode;
          if (mode) events.push(`persist:${mode}`);
        },
      });
      const firstFinalization = await transaction.finalize();
      expect(firstFinalization).toMatchObject({
        status: "pending",
        runtime: {
          remoteRecovery: {
            settlementMode: "finalize",
            requestIdentity: {
              acceptedPromptSha256: [promptIdentitySha256(prompt)],
              followUpOrdinal: 0,
              remainingFollowUps: 0,
            },
          },
          recoveryCleanupResources: [
            {
              remoteRecovery: {
                settlementMode: "finalize",
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

  it("posts artifact receipts only after a 0600 durable final artifact exists", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-durable-artifact-"));
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
    let artifactGets = 0;
    let receiptCount = 0;
    let observedAtReceipt: { contents: Buffer; mode: number; partExists: boolean } | undefined;
    const server = http.createServer(async (req, res) => {
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
        await readJson(req);
        let partExists = true;
        await access(`${finalPath}.part`).catch(() => {
          partExists = false;
        });
        observedAtReceipt = {
          contents: await readFile(finalPath),
          mode: (await stat(finalPath)).mode & 0o777,
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
      const executor = createRemoteBrowserExecutor({
        host: `127.0.0.1:${port}`,
        token: "secret",
        deadlines: {
          ...deadlines,
          controlOverallTimeoutMs: 1_000,
          artifactOverallTimeoutMs: 1_000,
          socketIdleTimeoutMs: 500,
        },
      });
      await executor({ prompt: "artifact durable", config: {}, sessionId: "durable-artifact" });
      expect(observedAtReceipt?.contents).toEqual(payload);
      expect(observedAtReceipt?.partExists).toBe(false);
      if (process.platform !== "win32") expect(observedAtReceipt?.mode).toBe(0o600);
      await executor({ prompt: "artifact durable", config: {}, sessionId: "durable-artifact" });
      expect(artifactGets).toBe(1);
      expect(receiptCount).toBe(2);
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await close(server);
      await rm(oracleHome, { recursive: true, force: true });
    }
  });
});
