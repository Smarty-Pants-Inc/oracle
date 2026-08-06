import { describe, expect, test } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createRemoteServer, type RemoteServerInstance } from "../../src/remote/server.js";
import type { BrowserSessionConfig } from "../../src/sessionManager.js";
import { CAN_LISTEN_LOCALHOST, browserTransaction } from "./serverTestBuilders.js";
import {
  httpGetJson,
  httpPostJson,
  prepareTestAuthentication,
  readIncomingBody,
} from "./serverTestHttp.js";
import {
  TEST_CONTROLLER_GENERATION,
  openSeedTransactionStore,
  seedRemoteTransaction,
} from "./serverTestTransactions.js";

describe("remote browser service", { timeout: 15_000 }, () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "keeps configured and generated v3 root keys out of ordinary startup diagnostics",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-startup-token-"));
      const configuredToken = "f".repeat(64); // gitleaks:allow — synthetic test sentinel
      const configuredLogs: string[] = [];
      const configured = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: configuredToken,
          logger: (message) => configuredLogs.push(message),
        },
        { transactionStoreDir: path.join(tmpDir, "configured-transactions") },
      );
      const generatedLogs: string[] = [];
      let generated: RemoteServerInstance | undefined;
      try {
        expect(configured.token).toBe(configuredToken);
        expect(configuredLogs.join("\n")).not.toContain(configuredToken);
        generated = await createRemoteServer(
          {
            host: "127.0.0.1",
            port: 0,
            logger: (message) => generatedLogs.push(message),
          },
          { transactionStoreDir: path.join(tmpDir, "generated-transactions") },
        );
        expect(generatedLogs.join("\n")).not.toContain(generated.token);
        expect(generated.token).toMatch(/^[0-9a-f]{64}$/u);
      } finally {
        await generated?.close();
        await configured.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
  test("rejects malformed configured modern and legacy credentials before startup", async () => {
    for (const token of [
      "",
      " ",
      "dictionary-word",
      "A".repeat(64),
      "a".repeat(63),
      "g".repeat(64),
    ]) {
      await expect(createRemoteServer({ token })).rejects.toThrow(
        /exactly 64 lowercase hexadecimal characters \(32 bytes\)/i,
      );
    }
    await expect(
      createRemoteServer({ token: "a".repeat(64), legacyToken: "weak" }),
    ).rejects.toThrow(/exactly 64 lowercase hexadecimal characters \(32 bytes\)/i);
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "keeps the legacy bearer scoped to predecessor health and text runs",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-legacy-auth-"));
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "a".repeat(64),
          legacyToken: "c".repeat(64),
          logger: () => {},
        },
        { transactionStoreDir: path.join(tmpDir, "transactions") },
      );
      try {
        await expect(
          httpGetJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: "/health",
            headers: { authorization: `Bearer ${"a".repeat(64)}` },
          }),
        ).resolves.toMatchObject({ statusCode: 401 });
        await expect(
          httpGetJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: "/health",
            headers: { authorization: `Bearer ${"c".repeat(64)}` },
          }),
        ).resolves.toMatchObject({ statusCode: 200, json: { ok: true } });
        await expect(
          httpPostJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: "/runs",
            body: {},
            headers: { authorization: `Bearer ${"a".repeat(64)}` },
          }),
        ).resolves.toMatchObject({ statusCode: 401 });
        await expect(
          httpPostJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: "/runs",
            body: {},
            headers: { authorization: `Bearer ${"c".repeat(64)}` },
          }),
        ).resolves.toMatchObject({ statusCode: 400 });
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "accepts and discards predecessor inline cookies",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-legacy-cookies-"));
      let receivedBrowserConfig: BrowserSessionConfig | undefined;
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "a".repeat(64),
          legacyToken: "c".repeat(64),
          logger: () => {},
        },
        {
          transactionStoreDir: path.join(tmpDir, "transactions"),
          runBrowser: async (options) => {
            receivedBrowserConfig = options.config;
            return browserTransaction(options.prompt, {
              answerText: "answer",
              answerMarkdown: "answer",
              tookMs: 1,
              answerTokens: 1,
              answerChars: 6,
            });
          },
        },
      );
      try {
        const response = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: "/runs",
          headers: { authorization: `Bearer ${"c".repeat(64)}` },
          body: {
            prompt: "legacy cookie payload",
            attachments: [],
            browserConfig: {
              inlineCookies: [
                {
                  name: "__Secure-next-auth.session-token",
                  value: "legacy-cookie",
                  domain: "chatgpt.com",
                  path: "/",
                  secure: true,
                  httpOnly: true,
                  sameSite: "Lax",
                },
              ],
            },
            options: {},
          },
        });

        expect(response.statusCode).toBe(200);
        expect(receivedBrowserConfig).toMatchObject({
          inlineCookies: null,
          inlineCookiesSource: null,
        });
      } finally {
        await server.close();
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
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
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
          token: "a".repeat(64),
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
          token: "a".repeat(64),
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
          token: "a".repeat(64),
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
          token: "a".repeat(64),
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
    "rejects retry bodies with mismatched signed digests and shared size limits",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-retry-body-auth-"));
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        { transactionStoreDir: path.join(tmpDir, "transactions") },
      );
      try {
        const retryPath = `/transactions/${"c".repeat(64)}/retry`;
        const signedBody = Buffer.from("{}");
        const sentBody = Buffer.from('{"unexpected":true}');
        const authentication = await prepareTestAuthentication({
          hostname: "127.0.0.1",
          port: server.port,
          path: retryPath,
          token: "a".repeat(64),
          method: "POST",
          body: signedBody,
        });
        if (!authentication) throw new Error("missing retry request authentication");

        const digestMismatch = await new Promise<{ statusCode: number; body: string }>(
          (resolve, reject) => {
            const request = http.request(
              {
                hostname: "127.0.0.1",
                port: server.port,
                path: retryPath,
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Content-Length": sentBody.byteLength,
                  ...authentication.authentication.headers,
                },
              },
              (response) => {
                void readIncomingBody(response).then(
                  (body) => resolve({ statusCode: response.statusCode ?? 0, body }),
                  reject,
                );
              },
            );
            request.on("error", reject);
            request.end(sentBody);
          },
        );
        expect(digestMismatch.statusCode).toBe(401);
        expect(JSON.parse(digestMismatch.body)).toMatchObject({
          error: "request_body_authentication_failed",
        });

        const oversized = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: retryPath,
          token: "a".repeat(64),
          body: { padding: "x".repeat(4096) },
        });
        expect(oversized).toMatchObject({
          statusCode: 413,
          json: { error: "request_too_large" },
        });
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
      const options = { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} };
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
