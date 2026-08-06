import http from "node:http";
import { describe, expect, it } from "vitest";
import { checkRemoteHealth } from "../../src/remote/health.js";
import { REMOTE_TRANSACTION_PROTOCOL_VERSION } from "../../src/remote/types.js";
import {
  REMOTE_HEALTH_CLIENT_NONCE_HEADER,
  RemoteRequestAuthenticator,
  assertRemoteCredential,
  createRemoteAuthenticatedRequest,
  createRemoteHealthAuthenticationProof,
  generateRemoteCredential,
  verifyRemoteHealthAuthenticationProof,
  verifyRemoteRequestProof,
} from "../../src/remote/auth.js";

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
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close((error) => (error ? reject(error) : resolve()));
  await promise;
}

describe("remote HMAC authentication", () => {
  it("accepts only exact 32-byte lowercase hexadecimal credentials", () => {
    const generated = generateRemoteCredential();
    expect(generated).toMatch(/^[0-9a-f]{64}$/u);
    expect(assertRemoteCredential("a".repeat(64))).toBe("a".repeat(64));

    for (const invalid of [
      "",
      " ",
      "dictionary-word",
      "A".repeat(64),
      "a".repeat(63),
      "g".repeat(64),
    ]) {
      expect(() => assertRemoteCredential(invalid)).toThrow(
        /exactly 64 lowercase hexadecimal characters \(32 bytes\)/i,
      );
    }
  });

  it("binds health proofs to the root key and client nonce", () => {
    const clientNonce = "a".repeat(64);
    const proof = createRemoteHealthAuthenticationProof({
      rootKey: "a".repeat(64),
      serverGeneration: "generation-1",
      clientNonce,
    });
    expect(verifyRemoteHealthAuthenticationProof("a".repeat(64), clientNonce, proof)).toBe(true);
    expect(verifyRemoteHealthAuthenticationProof("b".repeat(64), clientNonce, proof)).toBe(false);
    expect(verifyRemoteHealthAuthenticationProof("a".repeat(64), "b".repeat(64), proof)).toBe(
      false,
    );
  });

  it("verifies request MACs and rejects nonce replay", () => {
    const path = `/transactions/${"a".repeat(64)}/bind`;
    const body = Buffer.from(JSON.stringify({ mode: "finalize" }));
    const authentication = createRemoteAuthenticatedRequest({
      rootKey: "a".repeat(64),
      serverGeneration: "generation-1",
      method: "POST",
      path,
      body,
    });
    const authenticator = new RemoteRequestAuthenticator({
      rootKey: "a".repeat(64),
      serverGeneration: "generation-1",
    });
    const request = {
      method: "POST",
      url: path,
      headers: authentication.headers,
    } as http.IncomingMessage;
    const verified = authenticator.authenticate(request);
    expect(verified).not.toHaveProperty("statusCode");
    if ("statusCode" in verified) throw new Error(verified.code);
    expect(
      verifyRemoteRequestProof({
        rootKey: "a".repeat(64),
        method: "POST",
        path,
        authentication,
        proof: verified.requestProof,
      }),
    ).toBe(true);
    expect(
      authenticator.authenticate({
        method: "POST",
        url: path,
        headers: authentication.headers,
      } as http.IncomingMessage),
    ).toEqual({ statusCode: 409, code: "request_replayed" });
  });
});

describe("remote health transport", () => {
  it("rejects malformed modern and legacy credentials before connection use", async () => {
    for (const credentials of [
      { token: "" },
      { token: " " },
      { token: "dictionary-word" },
      { token: "A".repeat(64) },
      { token: "a".repeat(63) },
      { token: "g".repeat(64) },
      { legacyToken: "weak", allowLegacyTextProtocol: true },
    ]) {
      await expect(
        checkRemoteHealth({ host: "127.0.0.1:1", timeoutMs: 50, ...credentials }),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/exactly 64 lowercase hexadecimal characters/i),
      });
    }
  });

  it("refuses non-loopback plaintext before opening a connection", async () => {
    await expect(
      checkRemoteHealth({ host: "192.0.2.40:9473", token: "a".repeat(64), timeoutMs: 50 }),
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
        token: "a".repeat(64),
        timeoutMs: 500,
        idleTimeoutMs: 50,
      });
      expect(health).toMatchObject({ ok: false, error: expect.stringMatching(/idle timeout/i) });
      expect(Date.now() - startedAt).toBeLessThan(450);
    } finally {
      await close(server);
    }
  });

  it("uses the legacy bearer only when compatibility is explicitly enabled", async () => {
    let legacyRequests = 0;
    let totalRequests = 0;
    const server = http.createServer((req, res) => {
      totalRequests += 1;
      if (req.headers.authorization === `Bearer ${"c".repeat(64)}`) {
        legacyRequests += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: "legacy", uptimeSeconds: 1 }));
        return;
      }
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "authentication_required" }));
    });
    const port = await listen(server);
    try {
      await expect(
        checkRemoteHealth({
          host: `127.0.0.1:${port}`,
          token: "a".repeat(64),
          legacyToken: "c".repeat(64),
          timeoutMs: 500,
        }),
      ).resolves.toMatchObject({ ok: false, statusCode: 401 });
      expect(legacyRequests).toBe(0);
      expect(totalRequests).toBe(1);

      await expect(
        checkRemoteHealth({
          host: `127.0.0.1:${port}`,
          token: "a".repeat(64),
          legacyToken: "c".repeat(64),
          allowLegacyTextProtocol: true,
          timeoutMs: 500,
        }),
      ).resolves.toMatchObject({ ok: true, protocol: "legacy-text-v1", version: "legacy" });
      expect(legacyRequests).toBe(1);
      expect(totalRequests).toBe(3);

      await expect(
        checkRemoteHealth({
          host: `127.0.0.1:${port}`,
          token: "d".repeat(64),
          legacyToken: "d".repeat(64),
          allowLegacyTextProtocol: true,
          timeoutMs: 500,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/distinct from the v3 HMAC root key/i),
      });
      expect(totalRequests).toBe(3);
      expect(legacyRequests).toBe(1);
    } finally {
      await close(server);
    }
  });

  it("does not downgrade after a current-protocol proof failure", async () => {
    let legacyRequests = 0;
    const server = http.createServer((req, res) => {
      if (req.headers.authorization === `Bearer ${"c".repeat(64)}`) {
        legacyRequests += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: "legacy", uptimeSeconds: 1 }));
        return;
      }
      const clientNonce = String(req.headers[REMOTE_HEALTH_CLIENT_NONCE_HEADER] ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          version: "current",
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
            rootKey: "b".repeat(64),
            serverGeneration: "generation-1",
            clientNonce,
          }),
        }),
      );
    });
    const port = await listen(server);
    try {
      await expect(
        checkRemoteHealth({
          host: `127.0.0.1:${port}`,
          token: "a".repeat(64),
          legacyToken: "c".repeat(64),
          allowLegacyTextProtocol: true,
          timeoutMs: 500,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/generation proof was invalid/i),
      });
      expect(legacyRequests).toBe(0);
    } finally {
      await close(server);
    }
  });

  it("rejects extra health fields instead of accepting protocol passthrough", async () => {
    const server = http.createServer((req, res) => {
      const clientNonce = String(req.headers[REMOTE_HEALTH_CLIENT_NONCE_HEADER] ?? "");
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
          authentication: createRemoteHealthAuthenticationProof({
            rootKey: "a".repeat(64),
            serverGeneration: "generation-1",
            clientNonce,
          }),
          chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/private",
        }),
      );
    });
    const port = await listen(server);
    try {
      await expect(
        checkRemoteHealth({ host: `127.0.0.1:${port}`, token: "a".repeat(64), timeoutMs: 500 }),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/invalid remote health protocol/i),
      });
    } finally {
      await close(server);
    }
  });
});
