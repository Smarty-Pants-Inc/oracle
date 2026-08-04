import http from "node:http";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createRemoteBrowserExecutor } from "../../src/remote/client.js";
import { REMOTE_TRANSACTION_PROTOCOL_VERSION } from "../../src/remote/types.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

const promptEpoch = {
  status: "committed" as const,
  epochId: "epoch-1",
  promptSha256: "b".repeat(64),
  baselineTurns: 0,
  followUpOrdinal: 0,
  remainingFollowUps: 0,
  verifiedUserTurnIndex: 0,
  verifiedUserTurnId: "turn-1",
  verifiedUserMessageId: "message-1",
  conversationId: "conversation-1",
};
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

function transactionEvent(transactionToken: string, artifacts: unknown[] = []) {
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
      runtime: { promptEpoch, cleanup: { status: "pending" } },
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
        res.end(`${JSON.stringify(transactionEvent(transactionToken))}\n`);
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
        res.end(`${JSON.stringify(transactionEvent(transactionToken, [descriptor]))}\n`);
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
});
