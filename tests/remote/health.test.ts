import http from "node:http";
import { describe, expect, it } from "vitest";
import { checkRemoteHealth } from "../../src/remote/health.js";
import { REMOTE_TRANSACTION_PROTOCOL_VERSION } from "../../src/remote/types.js";
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
  const { promise, resolve, reject } = createDeferred<void>();
  server.close((error) => (error ? reject(error) : resolve()));
  await promise;
}

describe("remote health transport", () => {
  it("refuses non-loopback plaintext before opening a connection", async () => {
    await expect(
      checkRemoteHealth({ host: "192.0.2.40:9473", token: "secret", timeoutMs: 50 }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/loopback-only.*SSH tunnel/i),
    });
  });

  it("bounds a peer that accepts the request and holds the socket open", async () => {
    const server = http.createServer(() => {
      // Intentionally send neither headers nor body.
    });
    const port = await listen(server);
    try {
      const startedAt = Date.now();
      const health = await checkRemoteHealth({
        host: `127.0.0.1:${port}`,
        token: "secret",
        timeoutMs: 500,
        idleTimeoutMs: 50,
      });
      expect(health).toMatchObject({ ok: false, error: expect.stringMatching(/idle timeout/i) });
      expect(Date.now() - startedAt).toBeLessThan(450);
    } finally {
      await close(server);
    }
  });

  it("rejects extra health fields instead of accepting protocol passthrough", async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
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
          chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/private",
        }),
      );
    });
    const port = await listen(server);
    try {
      await expect(
        checkRemoteHealth({ host: `127.0.0.1:${port}`, timeoutMs: 500 }),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/invalid remote health protocol/i),
      });
    } finally {
      await close(server);
    }
  });
});
