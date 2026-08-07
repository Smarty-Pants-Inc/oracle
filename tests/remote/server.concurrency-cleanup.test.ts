import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createRemoteBrowserTransactionExecutor } from "../../src/remote/client.js";
import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import type { BrowserRunTransaction } from "../../src/browser/types.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import {
  CAN_LISTEN_LOCALHOST,
  browserTransaction,
  createTestRemoteServer,
  committedPromptEpoch,
  remoteRunPayload,
} from "./serverTestBuilders.js";
import { httpPostJson } from "./serverTestHttp.js";
import {
  TEST_CONTROLLER_GENERATION,
  openSeedTransactionStore,
  readAuthenticatedTransactionRecord,
  remoteRecoveryTransactionToken,
  seedRemoteTransaction,
} from "./serverTestTransactions.js";

describe("remote browser service", { timeout: 15_000 }, () => {
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
      const recoveryStarted = Promise.withResolvers<void>();
      const releaseRecovery = Promise.withResolvers<void>();
      const resumeBrowser = vi.fn(async () => {
        recoveryStarted.resolve();
        await releaseRecovery.promise;
        return {
          answerText: "one answer",
          answerMarkdown: "one answer",
          runtime,
          bindSettlement: vi.fn(async () => runtime),
          finalize: vi.fn(async () => ({ status: "completed" as const, runtime })),
          abort: vi.fn(async () => ({ status: "completed" as const, runtime })),
        };
      });
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
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
        const caught = await createRemoteBrowserTransactionExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "a".repeat(64),
        })({ prompt, config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(caught).toMatchObject({ details: { recoverableDisconnect: true } });
        transactionToken = remoteRecoveryTransactionToken(caught);

        const renewLease = vi.spyOn(RemoteTransactionStore.prototype, "renewLease");
        try {
          const retryRequest = () =>
            httpPostJson({
              hostname: "127.0.0.1",
              port: server.port,
              path: `/transactions/${transactionToken}/retry`,
              token: "a".repeat(64),
              body: {},
            });
          const firstRetry = retryRequest();
          await recoveryStarted.promise;
          const secondRetry = retryRequest();
          await vi.waitFor(() => expect(renewLease).toHaveBeenCalledTimes(2));
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
          renewLease.mockRestore();
        }
      } finally {
        releaseRecovery.resolve();
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    15_000,
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
      const runStarted = Promise.withResolvers<void>();
      const releaseRun = Promise.withResolvers<void>();
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
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
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
          token: "a".repeat(64),
          body: remoteRunPayload(),
        });
        await runStarted.promise;
        const busySettlement = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${settlementToken}/abort`,
          token: "a".repeat(64),
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
          token: "a".repeat(64),
          body: {},
        });
        expect(settled).toMatchObject({ statusCode: 200, json: { state: "aborted" } });
        expect(retryCleanup).toHaveBeenCalledOnce();
        expect(retryCleanup.mock.calls[0]?.[3]).toBe("abort");
        expect(retryCleanup.mock.calls[0]?.[2]).toMatchObject({ ownerId: settlementToken });
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
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
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
        expect(
          await readAuthenticatedTransactionRecord(transactionStoreDir, abortToken),
        ).toMatchObject({
          state: "aborted",
          terminalAudit: { settlementMode: "abort" },
        });
        const failed = await readAuthenticatedTransactionRecord(
          transactionStoreDir,
          preAuthorityToken,
        );
        expect(failed).toMatchObject({ state: "failed" });
        expect(failed).not.toHaveProperty("runtime");
        expect(failed).not.toHaveProperty("requestIdentity");
        expect(failed).not.toHaveProperty("browserConfig");
        expect(
          await readAuthenticatedTransactionRecord(transactionStoreDir, finalizeToken),
        ).toMatchObject({
          state: "finalized",
        });

        const abortRetry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${abortToken}/retry`,
          token: "a".repeat(64),
          body: {},
        });
        expect(abortRetry).toMatchObject({
          statusCode: 200,
          json: {
            status: "terminal",
            transactionToken: abortToken,
            outcome: { state: "aborted", finalization: { status: "completed" } },
          },
        });
        const finalizeRetry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${finalizeToken}/retry`,
          token: "a".repeat(64),
          body: {},
        });
        expect(finalizeRetry).toMatchObject({
          statusCode: 200,
          json: {
            status: "terminal",
            transactionToken: finalizeToken,
            outcome: { state: "finalized", finalization: { status: "completed" } },
          },
        });
        const failedRetry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${preAuthorityToken}/retry`,
          token: "a".repeat(64),
          body: {},
        });
        expect(failedRetry).toMatchObject({
          statusCode: 200,
          json: {
            status: "terminal",
            transactionToken: preAuthorityToken,
            outcome: { state: "failed", error: { recoverableDisconnect: false } },
          },
        });
        expect(JSON.stringify([abortRetry.json, finalizeRetry.json, failedRetry.json])).not.toMatch(
          /target-|requestIdentity|browserConfig|leaseExpiresAt/u,
        );
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
        const leaseSweepIntervalMs = 1_000_000;
        const periodicSweepStarted = Promise.withResolvers<void>();
        const releasePeriodicSweep = Promise.withResolvers<void>();
        let cleanupAttempts = 0;
        let forceCleanupCompletion = false;
        const retryCleanup = vi.fn(
          async (
            runtime: BrowserRunTransaction["runtime"],
            _logger: unknown,
            _deps: unknown,
            mode?: "finalize" | "abort",
          ) => {
            if (!mode) throw new Error("missing settlement mode");
            cleanupAttempts += 1;
            if (cleanupAttempts === 2) {
              periodicSweepStarted.resolve();
              await releasePeriodicSweep.promise;
            }
            if (forceCleanupCompletion || cleanupAttempts >= 4) {
              return { status: "completed" as const, runtime };
            }
            return {
              status: "pending" as const,
              runtime: {
                ...runtime,
                recoveryCleanupResult: {
                  status: "failed" as const,
                  error: `${mode} pending ${cleanupAttempts}`,
                },
              },
              error: `${mode} pending ${cleanupAttempts}`,
            };
          },
        );
        const server = await createTestRemoteServer(
          { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
          {
            transactionStoreDir,
            controllerGeneration: TEST_CONTROLLER_GENERATION,
            transactionLeaseDurationMs: leaseDurationMs,
            transactionStoreNow,
            leaseSweepIntervalMs,
            retryCleanup,
          },
        );
        try {
          expect(retryCleanup).toHaveBeenCalledOnce();
          now += leaseDurationMs + 1;
          const timerAdvance = vi.advanceTimersByTimeAsync(leaseSweepIntervalMs);
          await periodicSweepStarted.promise;
          const busyRetry = await httpPostJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: `/transactions/${transactionToken}/retry`,
            token: "a".repeat(64),
            body: {},
          });
          expect(busyRetry).toMatchObject({ statusCode: 409, json: { error: "busy" } });
          releasePeriodicSweep.resolve();
          await timerAdvance;
          let retryResponse:
            | { statusCode: number; json: Record<string, unknown> | null }
            | undefined;
          await vi.waitFor(
            async () => {
              const candidate = await httpPostJson({
                hostname: "127.0.0.1",
                port: server.port,
                path: `/transactions/${transactionToken}/retry`,
                token: "a".repeat(64),
                body: {},
              });
              expect(candidate.statusCode).toBe(200);
              retryResponse = candidate;
            },
            { timeout: 5_000 },
          );
          if (!retryResponse) throw new Error("pending settlement retry did not acquire authority");
          expect(retryCleanup).toHaveBeenCalledTimes(3);
          expect(retryCleanup.mock.calls.every((call) => call[3] === "abort")).toBe(true);
          expect(
            await readAuthenticatedTransactionRecord(transactionStoreDir, transactionToken),
          ).toMatchObject({
            state: "pending",
            settlementMode: "abort",
            finalization: { status: "pending" },
          });
          expect(retryResponse).toMatchObject({
            statusCode: 200,
            json: {
              status: "error",
              error: {
                code: "remote-settlement-pending",
                recoverableDisconnect: true,
                recoveryToken: transactionToken,
                settlementMode: "abort",
                runtime: { cleanup: { status: "pending" } },
              },
            },
          });
          expect(JSON.stringify(retryResponse.json)).not.toMatch(/target-|chromePort|chromeHost/u);

          await server.close();
          const attemptsAfterClose = retryCleanup.mock.calls.length;
          now += leaseDurationMs * 3;
          await vi.advanceTimersByTimeAsync(leaseSweepIntervalMs * 3);
          expect(retryCleanup).toHaveBeenCalledTimes(attemptsAfterClose);
        } finally {
          releasePeriodicSweep.resolve();
          forceCleanupCompletion = true;
          await server.close();
        }
      } finally {
        vi.useRealTimers();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
