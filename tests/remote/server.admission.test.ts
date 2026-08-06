import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { BrowserRuntimeMetadata } from "../../src/sessionManager.js";
import { recoverRemoteRunTransaction } from "../../src/remote/clientRecovery.js";
import { RemoteTransportInterruption } from "../../src/remote/clientTransport.js";
import { createRemoteServer } from "../../src/remote/server.js";
import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import { REMOTE_TRANSACTION_PROTOCOL_VERSION } from "../../src/remote/types.js";
import {
  CAN_LISTEN_LOCALHOST,
  browserTransaction,
  remoteRunPayload,
} from "./serverTestBuilders.js";
import { httpPostJson } from "./serverTestHttp.js";

describe("remote transaction admission", { timeout: 15_000 }, () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "keeps retry nonterminal while pre-begin maintenance outlives the recovery absence window",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-admission-window-"));
      const transactionStoreDir = path.join(root, "transactions");
      const maintenanceStarted = Promise.withResolvers<void>();
      const releaseMaintenance = Promise.withResolvers<void>();
      const runBrowser = vi.fn(async (options) => {
        return browserTransaction(options.prompt, {
          answerText: "late durable answer",
          answerMarkdown: "late durable answer",
          tookMs: 1,
          answerTokens: 3,
          answerChars: 19,
        });
      });
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        {
          transactionStoreDir,
          controllerGeneration: "controller-admission-window",
          leaseSweepIntervalMs: 60_000,
          runBrowser,
        },
      );
      const sweep = vi
        .spyOn(RemoteTransactionStore.prototype, "listExpiredNonterminalRecords")
        .mockImplementationOnce(async () => {
          maintenanceStarted.resolve();
          await releaseMaintenance.promise;
          return [];
        });

      try {
        const transactionToken = "c".repeat(64);
        const host = `127.0.0.1:${server.port}`;
        const run = httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/run`,
          token: "a".repeat(64),
          body: remoteRunPayload(),
        });
        await maintenanceStarted.promise;

        const caught = await recoverRemoteRunTransaction({
          hostname: "127.0.0.1",
          port: server.port,
          token: "a".repeat(64),
          transactionToken,
          host,
          authoritativeRuntime: {
            recoveryCleanupResources: [
              {
                remoteRecovery: {
                  protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
                  host,
                  transactionToken,
                  state: "pre-receipt",
                },
                recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
              },
            ],
          } satisfies BrowserRuntimeMetadata,
          interruption: new RemoteTransportInterruption("injected run response interruption"),
          deadlines: {
            runOverallTimeoutMs: 150,
            controlOverallTimeoutMs: 250,
            artifactOverallTimeoutMs: 250,
            socketIdleTimeoutMs: 50,
            recoveryWindowMs: 150,
          },
        }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(caught).toMatchObject({
          message: "Remote browser transaction did not become recoverable before its deadline.",
          details: {
            recoverableDisconnect: true,
            runtime: {
              recoveryCleanupResources: [{ remoteRecovery: { state: "recoverable-error" } }],
            },
          },
        });
        expect(caught).not.toMatchObject({
          details: { code: "remote-transaction-not-retained", recoverableDisconnect: false },
        });
        expect(runBrowser).not.toHaveBeenCalled();

        releaseMaintenance.resolve();
        await expect(run).resolves.toMatchObject({ statusCode: 200 });
        expect(runBrowser).toHaveBeenCalledOnce();
        const record = await RemoteTransactionStore.open({
          directory: transactionStoreDir,
          integrityKeyPath: path.join(
            path.dirname(transactionStoreDir),
            ".remote-transaction-integrity.key",
          ),
          controllerGeneration: "admission-window-reader",
        }).then((store) => store.read(transactionToken));
        expect(record).toMatchObject({
          transactionToken,
          controllerGeneration: "controller-admission-window",
        });
      } finally {
        releaseMaintenance.resolve();
        sweep.mockRestore();
        await server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "clears admission when durable begin fails before record creation",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-admission-begin-"));
      const transactionStoreDir = path.join(root, "transactions");
      const transactionToken = "d".repeat(64);
      const runBrowser = vi.fn();
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        {
          transactionStoreDir,
          controllerGeneration: "controller-admission-begin-failure",
          leaseSweepIntervalMs: 60_000,
          runBrowser,
        },
      );
      const begin = vi
        .spyOn(RemoteTransactionStore.prototype, "begin")
        .mockRejectedValueOnce(new Error("injected begin failure before record creation"));

      try {
        const failedRun = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/run`,
          token: "a".repeat(64),
          body: remoteRunPayload(),
        });
        expect(failedRun).toMatchObject({
          statusCode: 500,
          json: { error: "internal_error" },
        });
        expect(runBrowser).not.toHaveBeenCalled();

        const retry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/retry`,
          token: "a".repeat(64),
          body: {},
        });
        expect(retry).toMatchObject({
          statusCode: 404,
          json: { error: "transaction_not_retained", transactionToken },
        });
        const record = await RemoteTransactionStore.open({
          directory: transactionStoreDir,
          integrityKeyPath: path.join(
            path.dirname(transactionStoreDir),
            ".remote-transaction-integrity.key",
          ),
          controllerGeneration: "admission-begin-failure-reader",
        }).then((store) => store.read(transactionToken));
        expect(record).toBeNull();
      } finally {
        begin.mockRestore();
        await server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
