import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import type { RemoteServerInstance } from "../../src/remote/server.js";
import type { WindowsPrivateTreeScope } from "../../src/windowsPrivateFileAcl.js";
import type { BrowserSessionConfig } from "../../src/sessionManager.js";
import {
  CAN_LISTEN_LOCALHOST,
  browserTransaction,
  createTestRemoteServer,
} from "./serverTestBuilders.js";
import { httpGetJson, httpPostJson, httpRaw, prepareTestAuthentication } from "./serverTestHttp.js";
import {
  TEST_CONTROLLER_GENERATION,
  openSeedTransactionStore,
  seedRemoteTransaction,
} from "./serverTestTransactions.js";
import {
  openTestRemoteTransactionStore,
  testWindowsPrivateTreeAuthority,
} from "./testTransactionStore.js";
import {
  REMOTE_BODY_SHA256_HEADER,
  REMOTE_REQUEST_MAC_HEADER,
  remoteBodySha256,
} from "../../src/remote/auth.js";
import { checkRemoteHealth } from "../../src/remote/health.js";

describe("remote browser service", { timeout: 15_000 }, () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "keeps configured and generated v3 root keys out of diagnostics and authenticates the generated key",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-startup-token-"));
      const configuredToken = "f".repeat(64); // gitleaks:allow — synthetic test sentinel
      const configuredLogs: string[] = [];
      const configured = await createTestRemoteServer(
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
        generated = await createTestRemoteServer(
          {
            host: "127.0.0.1",
            port: 0,
            logger: (message) => generatedLogs.push(message),
          },
          { transactionStoreDir: path.join(tmpDir, "generated-transactions") },
        );
        expect(generatedLogs.join("\n")).not.toContain(generated.token);
        expect(generated.token).toMatch(/^[0-9a-f]{64}$/u);
        await expect(
          checkRemoteHealth({
            host: `127.0.0.1:${generated.port}`,
            token: generated.token,
          }),
        ).resolves.toMatchObject({ ok: true, protocol: "transaction-v3" });
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
      await expect(createTestRemoteServer({ token })).rejects.toThrow(
        /exactly 64 lowercase hexadecimal characters \(32 bytes\)/i,
      );
    }
    await expect(
      createTestRemoteServer({ token: "a".repeat(64), legacyToken: "weak" }),
    ).rejects.toThrow(/exactly 64 lowercase hexadecimal characters \(32 bytes\)/i);
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "keeps the legacy bearer scoped to predecessor health and text runs",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-legacy-auth-"));
      const server = await createTestRemoteServer(
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
      const server = await createTestRemoteServer(
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
    "renews route leases only after authentication and body validation",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-auth-renewal-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const integrityKeyPath = path.join(tmpDir, ".remote-transaction-integrity.key");
      const transactionToken = "c".repeat(64);
      let now = Date.now();
      const transactionStoreNow = () => now;
      const store = await openSeedTransactionStore(transactionStoreDir, 5_000, transactionStoreNow);
      await seedRemoteTransaction(store, transactionToken, { prompt: "renew exact lease" });
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        {
          transactionStoreDir,
          controllerGeneration: TEST_CONTROLLER_GENERATION,
          transactionLeaseDurationMs: 5_000,
          transactionStoreNow,
          leaseSweepIntervalMs: 1_000,
          retryCleanup: async (cleanupRuntime) => ({
            status: "completed" as const,
            runtime: cleanupRuntime,
          }),
        },
      );
      const readCurrent = async () => {
        const reader = await openTestRemoteTransactionStore({
          directory: transactionStoreDir,
          integrityKeyPath,
          controllerGeneration: "auth-renewal-reader",
          leaseDurationMs: 5_000,
          now: transactionStoreNow,
        });
        return await reader.read(transactionToken);
      };
      try {
        const initialLease = (await readCurrent())?.leaseExpiresAt;
        const unauthorizedRetry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/retry`,
          body: {},
        });
        expect(unauthorizedRetry.statusCode).toBe(401);
        expect((await readCurrent())?.leaseExpiresAt).toBe(initialLease);

        now += 10;
        const authenticatedRetry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/retry`,
          token: "a".repeat(64),
          body: {},
        });
        expect(authenticatedRetry.statusCode).toBe(200);
        const retryLease = (await readCurrent())?.leaseExpiresAt;
        expect(Date.parse(retryLease ?? "")).toBeGreaterThan(Date.parse(initialLease ?? ""));

        const unauthorizedArtifact = await httpGetJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/artifacts/missing-artifact`,
        });
        expect(unauthorizedArtifact.statusCode).toBe(401);
        expect((await readCurrent())?.leaseExpiresAt).toBe(retryLease);

        now += 10;
        const authenticatedArtifact = await httpGetJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/artifacts/missing-artifact`,
          token: "a".repeat(64),
        });
        expect(authenticatedArtifact.statusCode).toBe(404);
        const artifactLease = (await readCurrent())?.leaseExpiresAt;
        expect(Date.parse(artifactLease ?? "")).toBeGreaterThan(Date.parse(retryLease ?? ""));

        const unauthorizedReceipt = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/artifacts/missing-artifact/receipt`,
          body: { sha256: "d".repeat(64), byteSize: 1 },
        });
        expect(unauthorizedReceipt.statusCode).toBe(401);
        expect((await readCurrent())?.leaseExpiresAt).toBe(artifactLease);

        now += 10;
        const receipt = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/artifacts/missing-artifact/receipt`,
          token: "a".repeat(64),
          body: { sha256: "d".repeat(64), byteSize: 1 },
        });
        expect(receipt.statusCode).toBe(404);
        const receiptLease = (await readCurrent())?.leaseExpiresAt;
        expect(Date.parse(receiptLease ?? "")).toBeGreaterThan(Date.parse(artifactLease ?? ""));

        const unauthorizedSettlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/finalize`,
          body: {},
        });
        expect(unauthorizedSettlement.statusCode).toBe(401);
        expect((await readCurrent())?.leaseExpiresAt).toBe(receiptLease);

        now += 10;
        const invalidSettlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/finalize`,
          token: "a".repeat(64),
          body: {},
        });
        expect(invalidSettlement.statusCode).toBe(400);
        expect((await readCurrent())?.leaseExpiresAt).toBe(receiptLease);
        const binding = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/bind`,
          token: "a".repeat(64),
          body: { mode: "abort", durablePublication: false },
        });
        expect(binding.statusCode).toBe(200);
        const settlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/abort`,
          token: "a".repeat(64),
          body: {},
        });
        expect(settlement).toMatchObject({
          statusCode: 200,
          json: { state: "aborted", finalization: { status: "completed" } },
        });
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "rejects invalid route bodies before durable lease or state changes",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-body-order-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const transactionToken = "d".repeat(64);
      let now = Date.now();
      const transactionStoreNow = () => now;
      const store = await openSeedTransactionStore(transactionStoreDir, 5_000, transactionStoreNow);
      await seedRemoteTransaction(store, transactionToken, {
        prompt: "authenticate exact body first",
      });
      const server = await createTestRemoteServer(
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
        const baseline = await store.read(transactionToken);
        if (!baseline) throw new Error("missing request-order transaction");
        const request = async (params: {
          path: string;
          method: "GET" | "POST";
          signedBody: Buffer;
          sentBody: Buffer;
        }) => {
          now += 10;
          const authentication = await prepareTestAuthentication({
            hostname: "127.0.0.1",
            port: server.port,
            path: params.path,
            token: "a".repeat(64),
            method: params.method,
            body: params.signedBody,
          });
          if (!authentication) throw new Error("missing request-order authentication");
          return await httpRaw({
            hostname: "127.0.0.1",
            port: server.port,
            path: params.path,
            method: params.method,
            body: params.sentBody,
            headers: {
              "Content-Type": "application/json",
              ...authentication.authentication.headers,
            },
          });
        };

        const bind = await request({
          path: `/transactions/${transactionToken}/bind`,
          method: "POST",
          signedBody: Buffer.from(JSON.stringify({ mode: "finalize", durablePublication: true })),
          sentBody: Buffer.from(JSON.stringify({ mode: "abort", durablePublication: false })),
        });
        expect(bind).toMatchObject({
          statusCode: 400,
          body: JSON.stringify({ error: "invalid_settlement_binding_request" }),
        });
        expect(await store.read(transactionToken)).toEqual(baseline);

        const settlementBody = Buffer.from('{"durablePublication":');
        const settlement = await request({
          path: `/transactions/${transactionToken}/finalize`,
          method: "POST",
          signedBody: settlementBody,
          sentBody: settlementBody,
        });
        expect(settlement).toMatchObject({
          statusCode: 400,
          body: JSON.stringify({ error: "invalid_settlement_request" }),
        });
        expect(await store.read(transactionToken)).toEqual(baseline);

        const receipt = await request({
          path: `/transactions/${transactionToken}/artifacts/missing-artifact/receipt`,
          method: "POST",
          signedBody: Buffer.from(JSON.stringify({ sha256: "e".repeat(64), byteSize: 1 })),
          sentBody: Buffer.from(JSON.stringify({ sha256: "f".repeat(64), byteSize: 1 })),
        });
        expect(receipt).toMatchObject({
          statusCode: 400,
          body: JSON.stringify({ error: "invalid_artifact_delivery_receipt" }),
        });
        expect(await store.read(transactionToken)).toEqual(baseline);

        const waiverBody = Buffer.from('{"sha256":');
        const waiver = await request({
          path: `/transactions/${transactionToken}/artifacts/missing-artifact/manual-copy-waiver`,
          method: "POST",
          signedBody: waiverBody,
          sentBody: waiverBody,
        });
        expect(waiver).toMatchObject({
          statusCode: 400,
          body: JSON.stringify({ error: "invalid_artifact_manual_copy_waiver" }),
        });
        expect(await store.read(transactionToken)).toEqual(baseline);

        const unexpectedGetBody = Buffer.from("{}");
        const artifact = await request({
          path: `/transactions/${transactionToken}/artifacts/missing-artifact`,
          method: "GET",
          signedBody: unexpectedGetBody,
          sentBody: unexpectedGetBody,
        });
        expect(artifact.statusCode).toBe(413);
        expect(JSON.parse(artifact.body)).toMatchObject({ error: "request_too_large" });
        expect(await store.read(transactionToken)).toEqual(baseline);
        const pending = await store.read(transactionToken);
        if (!pending?.runtime) throw new Error("missing request-order runtime");
        await store.bindSettlement({
          transactionToken,
          mode: "abort",
          durablePublication: false,
        });
        await store.beginSettlementExecution({ transactionToken, mode: "abort" });
        await store.completeSettlement({
          transactionToken,
          mode: "abort",
          finalization: { status: "completed", runtime: pending.runtime },
        });
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
      const server = await createTestRemoteServer(
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

        const digestMismatch = await httpRaw({
          hostname: "127.0.0.1",
          port: server.port,
          path: retryPath,
          method: "POST",
          body: sentBody,
          headers: {
            "Content-Type": "application/json",
            ...authentication.authentication.headers,
          },
        });
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
    "authenticates malformed transaction bodies before parsing or admitting a run",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-auth-order-"));
      let browserRuns = 0;
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        {
          transactionStoreDir: path.join(tmpDir, "transactions"),
          runBrowser: async () => {
            browserRuns += 1;
            throw new Error("invalid authentication reached the browser handler");
          },
        },
      );
      try {
        const runPath = `/transactions/${"c".repeat(64)}/run`;
        const malformedBody = Buffer.from('{"prompt":');
        const requestAuthentication = await prepareTestAuthentication({
          hostname: "127.0.0.1",
          port: server.port,
          path: runPath,
          token: "a".repeat(64),
          method: "POST",
          body: malformedBody,
        });
        if (!requestAuthentication) throw new Error("missing malformed request authentication");
        expect(requestAuthentication.authentication.headers[REMOTE_BODY_SHA256_HEADER]).toBe(
          remoteBodySha256(malformedBody),
        );
        const authenticatedMac =
          requestAuthentication.authentication.headers[REMOTE_REQUEST_MAC_HEADER];
        if (!authenticatedMac) throw new Error("missing malformed request MAC");
        const invalidFirstNibble = authenticatedMac[0] === "0" ? "1" : "0";
        const invalidMac = `${invalidFirstNibble}${authenticatedMac.slice(1)}`;

        const response = await httpRaw({
          hostname: "127.0.0.1",
          port: server.port,
          path: runPath,
          method: "POST",
          body: malformedBody,
          headers: {
            "Content-Type": "application/json",
            ...requestAuthentication.authentication.headers,
            [REMOTE_REQUEST_MAC_HEADER]: invalidMac,
          },
        });

        expect(response).toMatchObject({
          statusCode: 401,
          body: JSON.stringify({ error: "invalid_request_authentication" }),
        });
        expect(browserRuns).toBe(0);
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
      const first = await createTestRemoteServer(options, { transactionStoreDir });
      try {
        await expect(createTestRemoteServer(options, { transactionStoreDir })).rejects.toThrow(
          /lock|owner|active/i,
        );
      } finally {
        await first.close();
      }
      const restarted = await createTestRemoteServer(options, { transactionStoreDir });
      await restarted.close();
      await rm(tmpDir, { recursive: true, force: true });
    },
  );
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "does not invoke Windows tree authority for a controller that loses lock contention",
    async () => {
      const tmpDir = await mkdtemp(
        path.join(os.tmpdir(), "oracle-remote-controller-windows-lock-"),
      );
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const integrityKeyPath = path.join(tmpDir, ".remote-transaction-integrity.key");
      const windowsPrivateTreeAuthority = vi.fn(testWindowsPrivateTreeAuthority);
      const options = { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} };
      const first = await createTestRemoteServer(options, {
        transactionStoreDir,
        transactionIntegrityKeyPath: integrityKeyPath,
        transactionStorePlatform: "win32",
        windowsPrivateTreeAuthority,
      });
      try {
        const keyBefore = await readFile(integrityKeyPath);
        const recordNamesBefore = (await readdir(transactionStoreDir)).filter((name) =>
          name.endsWith(".json"),
        );
        windowsPrivateTreeAuthority.mockClear();

        await expect(
          createTestRemoteServer(options, {
            transactionStoreDir,
            transactionIntegrityKeyPath: integrityKeyPath,
            transactionStorePlatform: "win32",
            windowsPrivateTreeAuthority,
          }),
        ).rejects.toThrow(/lock|owner|active/i);

        expect(windowsPrivateTreeAuthority).toHaveBeenCalledOnce();
        expect(windowsPrivateTreeAuthority).toHaveBeenCalledWith(
          expect.objectContaining({ initializeRoots: true }),
        );
        await expect(readFile(integrityKeyPath)).resolves.toEqual(keyBefore);
        expect(
          (await readdir(transactionStoreDir)).filter((name) => name.endsWith(".json")),
        ).toEqual(recordNamesBefore);
      } finally {
        await first.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "releases the controller lock when Windows tree authority fails after acquisition",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-controller-windows-acl-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const failingAuthority = vi.fn(async (scope: WindowsPrivateTreeScope) => {
        await testWindowsPrivateTreeAuthority(scope);
        if (!scope.initializeRoots) throw new Error("simulated Windows tree authority failure");
      });
      const options = { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} };
      let recovered: RemoteServerInstance | undefined;
      try {
        await expect(
          createTestRemoteServer(options, {
            transactionStoreDir,
            transactionStorePlatform: "win32",
            windowsPrivateTreeAuthority: failingAuthority,
          }),
        ).rejects.toThrow("simulated Windows tree authority failure");
        expect(failingAuthority).toHaveBeenCalledTimes(2);
        expect(await readdir(transactionStoreDir)).not.toContain(".controller.lock");

        recovered = await createTestRemoteServer(options, {
          transactionStoreDir,
          transactionStorePlatform: "win32",
        });
      } finally {
        await recovered?.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "refuses a controller lock when the prepared transaction-store generation is replaced",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-controller-root-race-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const displacedStoreDir = path.join(tmpDir, "transactions-displaced");
      const options = { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} };
      let racedStartup: Promise<RemoteServerInstance> | undefined;
      let replacement: RemoteServerInstance | undefined;
      try {
        racedStartup = createTestRemoteServer(options, {
          transactionStoreDir,
          controllerLockDeps: {
            beforeLockPublication: async () => {
              await rename(transactionStoreDir, displacedStoreDir);
              await mkdir(transactionStoreDir, { mode: 0o700 });
            },
          },
        });
        await expect(racedStartup).rejects.toThrow("Filesystem lock parent generation changed");
        expect(await readdir(transactionStoreDir)).toEqual([]);
        expect(await readdir(displacedStoreDir)).not.toContain(".controller.lock");
        replacement = await createTestRemoteServer(options, { transactionStoreDir });
      } finally {
        const raced = racedStartup ? await racedStartup.catch(() => undefined) : undefined;
        await raced?.close();
        await replacement?.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "preserves persisted recovery across network credential and controller-generation rotation",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-credential-rotation-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const integrityKeyPath = path.join(tmpDir, ".remote-transaction-integrity.key");
      const transactionToken = "e".repeat(64);
      const first = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        { transactionStoreDir, controllerGeneration: "controller-before-credential-rotation" },
      );
      try {
        await first.close();
        const seeded = await openTestRemoteTransactionStore({
          directory: transactionStoreDir,
          integrityKeyPath,
          controllerGeneration: "credential-rotation-seeder",
        });
        await seedRemoteTransaction(seeded, transactionToken, {
          prompt: "preserve authenticated transaction across credential rotation",
          state: "recoverable-error",
        });
        const beforeRotationEnvelope = JSON.parse(
          await readFile(path.join(transactionStoreDir, `${transactionToken}.json`), "utf8"),
        ) as { revision: number };
        expect(beforeRotationEnvelope.revision).toBeGreaterThan(0);

        const rotated = await createTestRemoteServer(
          { host: "127.0.0.1", port: 0, token: "b".repeat(64), logger: () => {} },
          {
            transactionStoreDir,
            controllerGeneration: "controller-after-credential-rotation",
            retryCleanup: async (cleanupRuntime) => ({
              status: "completed" as const,
              runtime: cleanupRuntime,
            }),
          },
        );
        try {
          await expect(
            prepareTestAuthentication({
              hostname: "127.0.0.1",
              port: rotated.port,
              path: `/transactions/${transactionToken}/bind`,
              token: "a".repeat(64),
              method: "POST",
              body: Buffer.from(JSON.stringify({ mode: "abort", durablePublication: false })),
            }),
          ).rejects.toThrow("remote health generation proof was invalid");
          const afterRejectedEnvelope = JSON.parse(
            await readFile(path.join(transactionStoreDir, `${transactionToken}.json`), "utf8"),
          ) as { revision: number };
          expect(afterRejectedEnvelope.revision).toBe(beforeRotationEnvelope.revision);

          const currentCredential = await httpPostJson({
            hostname: "127.0.0.1",
            port: rotated.port,
            path: `/transactions/${transactionToken}/bind`,
            token: "b".repeat(64),
            body: { mode: "abort", durablePublication: false },
          });
          expect(currentCredential).toMatchObject({
            statusCode: 200,
            json: { transactionToken, settlementAuthority: { mode: "abort" } },
          });
          const afterBindingEnvelope = JSON.parse(
            await readFile(path.join(transactionStoreDir, `${transactionToken}.json`), "utf8"),
          ) as { revision: number; payload: string };
          expect(afterBindingEnvelope.revision).toBe(beforeRotationEnvelope.revision + 2);
          const boundRecord = JSON.parse(
            Buffer.from(afterBindingEnvelope.payload, "base64").toString("utf8"),
          ) as {
            transactionToken: string;
            state: string;
            settlementMode?: string;
            controllerGeneration: string;
          };
          expect(boundRecord).toMatchObject({
            transactionToken,
            state: "recoverable-error",
            settlementMode: "abort",
            controllerGeneration: "controller-after-credential-rotation",
          });
          const settled = await httpPostJson({
            hostname: "127.0.0.1",
            port: rotated.port,
            path: `/transactions/${transactionToken}/abort`,
            token: "b".repeat(64),
            body: {},
          });
          expect(settled).toMatchObject({
            statusCode: 200,
            json: { state: "aborted", finalization: { status: "completed" } },
          });
          const terminalEnvelope = JSON.parse(
            await readFile(path.join(transactionStoreDir, `${transactionToken}.json`), "utf8"),
          ) as { revision: number; payload: string };
          expect(terminalEnvelope.revision).toBe(afterBindingEnvelope.revision + 3);
          expect(
            JSON.parse(Buffer.from(terminalEnvelope.payload, "base64").toString("utf8")),
          ).toMatchObject({ state: "aborted" });
        } finally {
          await rotated.close();
        }
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
