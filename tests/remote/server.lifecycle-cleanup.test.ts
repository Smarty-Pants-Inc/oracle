import { describe, expect, test, vi } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { drainRemoteServerShutdown, type RemoteServerInstance } from "../../src/remote/server.js";
import { runBridgeHost } from "../../src/cli/bridge/host.js";
import {
  createRemoteBrowserExecutor,
  resumeRemoteBrowserTransaction,
} from "../../src/remote/client.js";
import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import type { BrowserRunTransaction } from "../../src/browser/types.js";
import { writeBinaryBrowserArtifact } from "../../src/browser/artifacts.js";
import {
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  buildRemotePromptRequestIdentity,
} from "../../src/remote/types.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { promptIdentitySha256 } from "../../src/browser/actions/committedPrompt.js";
import {
  completedBrowserCaptureCleanup,
  pendingBrowserCaptureCleanup,
} from "../../src/browser/ownedBrowserResources.js";
import {
  __test__ as targetCloseAuthorityTest,
  closeChromeTargetWithRetainedCapability,
  retainChromeTargetCloseCapability,
} from "../../src/browser/targetCloseAuthority.js";
import { retryBrowserRecoveryCleanup } from "../../src/browser/reattach.js";
import {
  CAN_LISTEN_LOCALHOST,
  createTestRemoteServer,
  browserTransaction,
  lifecycleBrowserTransaction,
  remoteRunPayload,
} from "./serverTestBuilders.js";
import {
  httpPostJson,
  httpPostNdjson,
  postJsonAndDisconnect,
  prepareTestAuthentication,
  sendTestRequestBody,
} from "./serverTestHttp.js";
import { readAuthenticatedTransactionRecord } from "./serverTestTransactions.js";
import { openTestRemoteTransactionStore } from "./testTransactionStore.js";
import { processIdentity } from "../browser/chromeLifecycleTestHelpers.js";

describe("remote browser service", { timeout: 15_000 }, () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST).each(["finalize", "abort"] as const)(
    "persists the exact bound %s runtime before executing live cleanup",
    async (mode) => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), `oracle-remote-${mode}-runtime-`));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const cleanupMarker = path.join(tmpDir, "cleanup-pending");
      await writeFile(cleanupMarker, "owned", "utf8");
      const cleanupModes: Array<"finalize" | "abort"> = [];
      const runtime: BrowserRunTransaction["runtime"] = {
        chromeTargetId: `${mode}-target`,
        recoveryCleanupResources: [
          {
            chromeTargetId: `${mode}-target`,
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async (options) =>
            lifecycleBrowserTransaction(
              options.prompt,
              {
                answerText: mode,
                answerMarkdown: mode,
                tookMs: 1,
                answerTokens: 1,
                answerChars: mode.length,
              },
              runtime,
              options.runtimeHintCb,
              async (settlementMode, pendingRuntime) => {
                cleanupModes.push(settlementMode);
                await rm(cleanupMarker);
                return completedBrowserCaptureCleanup(pendingRuntime);
              },
            ),
        },
      );

      try {
        const transaction = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "a".repeat(64),
        })({ prompt: `${mode} exact settlement`, config: {} });
        expect(existsSync(cleanupMarker)).toBe(true);
        await expect(transaction[mode]()).resolves.toMatchObject({ status: "completed" });
        expect(cleanupModes).toEqual([mode]);
        expect(existsSync(cleanupMarker)).toBe(false);
        const oppositeMode = mode === "finalize" ? "abort" : "finalize";
        await expect(transaction[oppositeMode]()).rejects.toMatchObject({
          details: { code: "settlement-mode-conflict" },
        });

        const recordName = (await readdir(transactionStoreDir)).find((name) =>
          name.endsWith(".json"),
        );
        if (!recordName) throw new Error("missing durable remote transaction record");
        const settledRecord = await readAuthenticatedTransactionRecord(
          transactionStoreDir,
          recordName.slice(0, -".json".length),
        );
        expect(settledRecord).toMatchObject({ terminalAudit: { settlementMode: mode } });
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
      const runStarted = Promise.withResolvers<void>();
      const continueRun = Promise.withResolvers<void>();
      const runtime: BrowserRunTransaction["runtime"] = {
        chromePort: 9222,
        chromeTargetId: "disconnect-target",
        recoveryCleanupResources: [
          {
            chromePort: 9222,
            chromeTargetId: "disconnect-target",
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      const finalize = vi.fn(async () => ({ status: "completed" as const, runtime }));
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
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
          token: "a".repeat(64),
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
            token: "a".repeat(64),
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
        const pendingRecord = await readAuthenticatedTransactionRecord(
          transactionStoreDir,
          transactionToken,
        );
        expect(pendingRecord).toMatchObject({
          state: "pending",
          runtime: { chromeTargetId: "disconnect-target" },
        });

        await vi.waitFor(async () => {
          const settlement = await httpPostJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: `/transactions/${transactionToken}/finalize`,
            token: "a".repeat(64),
            body: { durablePublication: true },
          });
          expect(settlement).toMatchObject({ statusCode: 200, json: { state: "finalized" } });
        });
        expect(finalize).toHaveBeenCalledTimes(1);
      } finally {
        continueRun.resolve();
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    15_000,
  );
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "keeps controller authority until a disconnected receipt mutation settles",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-receipt-drain-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const controllerLockPath = path.join(transactionStoreDir, ".controller.lock");
      const artifactPayload = Buffer.from([
        0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      const transactionToken = "4".repeat(64);
      const mutationStarted = Promise.withResolvers<void>();
      const allowMutationFailure = Promise.withResolvers<void>();
      setOracleHomeDirOverrideForTest(tmpDir);
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async (options) => {
            const artifact = await writeBinaryBrowserArtifact({
              sessionId: options.sessionId,
              artifactWriteAuthority: options.artifactWriteAuthority,
              kind: "file",
              filename: "result.zip",
              contents: artifactPayload,
              label: "receipt artifact",
              mimeType: "application/zip",
              sourceUrl: "sandbox:/mnt/data/result.zip",
            });
            if (!artifact) throw new Error("Expected receipt artifact fixture");
            return browserTransaction(options.prompt, {
              answerText: "durable answer",
              answerMarkdown: "durable answer",
              tookMs: 1,
              answerTokens: 2,
              answerChars: 14,
              savedFiles: [
                {
                  ...artifact,
                  kind: "file",
                  url: "browser-download",
                  finalUrl: "browser-download",
                  filename: path.basename(artifact.path),
                },
              ],
            });
          },
        },
      );
      const recordArtifactDelivery = vi
        .spyOn(RemoteTransactionStore.prototype, "recordArtifactDelivery")
        .mockImplementation(async () => {
          mutationStarted.resolve();
          await allowMutationFailure.promise;
          throw new Error("simulated receipt mutation failure");
        });

      try {
        const run = await httpPostNdjson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/run`,
          token: "a".repeat(64),
          body: remoteRunPayload(),
        });
        const transaction = run.events.find((event) => event.type === "transaction")
          ?.transaction as
          | { artifacts?: Array<{ artifactId: string; sha256: string; byteSize: number }> }
          | undefined;
        const artifact = transaction?.artifacts?.[0];
        if (!artifact) throw new Error("missing durable artifact receipt target");

        const receiptPath = `/transactions/${transactionToken}/artifacts/${artifact.artifactId}/receipt`;
        const receiptBody = Buffer.from(
          JSON.stringify({ sha256: artifact.sha256, byteSize: artifact.byteSize }),
        );
        const receiptAuthentication = await prepareTestAuthentication({
          hostname: "127.0.0.1",
          port: server.port,
          path: receiptPath,
          token: "a".repeat(64),
          method: "POST",
          body: receiptBody,
        });
        const receiptRequest = http.request({
          hostname: "127.0.0.1",
          port: server.port,
          path: receiptPath,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": receiptBody.byteLength,
            Expect: "100-continue",
            ...(receiptAuthentication ? receiptAuthentication.authentication.headers : {}),
          },
        });
        receiptRequest.on("error", () => {});
        sendTestRequestBody({
          req: receiptRequest,
          authentication: receiptAuthentication,
          method: "POST",
          path: receiptPath,
          body: receiptBody,
        });
        await mutationStarted.promise;
        receiptRequest.destroy();

        const close = server.close();
        let closeSettled = false;
        void close.then(
          () => {
            closeSettled = true;
          },
          () => {
            closeSettled = true;
          },
        );
        await Promise.resolve();
        expect(closeSettled).toBe(false);
        expect(existsSync(controllerLockPath)).toBe(true);
        await expect(
          createTestRemoteServer(
            { host: "127.0.0.1", port: 0, token: "e".repeat(64), logger: () => {} },
            { transactionStoreDir },
          ),
        ).rejects.toThrow();

        allowMutationFailure.reject(new Error("allow simulated receipt mutation failure"));
        await close;
        expect(existsSync(controllerLockPath)).toBe(false);
      } finally {
        allowMutationFailure.resolve();
        recordArtifactDelivery.mockRestore();
        await server.close().catch(() => undefined);
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "keeps the bridge tunnel and controller authority until an in-flight run reaches durable shutdown handoff",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-graceful-drain-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const controllerLockPath = path.join(transactionStoreDir, ".controller.lock");
      const connectionPath = path.join(tmpDir, "bridge-connection.json");
      const runStarted = Promise.withResolvers<void>();
      const continueRun = Promise.withResolvers<void>();
      const shutdownRequested = Promise.withResolvers<void>();
      const tunnelStarted = Promise.withResolvers<void>();
      const transactionToken = "5".repeat(64);
      const rejectedTransactionToken = "6".repeat(64);
      const browserWSEndpoint = "ws://127.0.0.1:9222/devtools/browser/graceful-drain-generation";
      const profileDir = path.join(tmpDir, "graceful-drain-profile");
      const baseChromeProcessIdentity = processIdentity(
        profileDir,
        4325,
        "10000000-0000-4000-8000-000000000005",
      );
      const chromeProcessIdentity = {
        ...baseChromeProcessIdentity,
        launchClaim: {
          ...baseChromeProcessIdentity.launchClaim,
          generationId: "graceful-drain-generation",
        },
      };
      const runtime: BrowserRunTransaction["runtime"] = {
        chromePid: chromeProcessIdentity.pid,
        chromeProcessIdentity,
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        chromeTargetId: "graceful-drain-target",
        recoveryCleanupResources: [
          {
            chromePid: chromeProcessIdentity.pid,
            chromeProcessIdentity,
            profileDirectoryIdentity: chromeProcessIdentity.profileDirectory,
            chromeHost: "127.0.0.1",
            chromePort: 9222,
            chromeBrowserWSEndpoint: browserWSEndpoint,
            chromeProfileRoot: profileDir,
            userDataDir: profileDir,
            chromeTargetId: "graceful-drain-target",
            targetCloseCapability: {
              version: 1,
              generationId: "graceful-drain-generation",
              capabilityId: "graceful-drain-capability",
              targetId: "graceful-drain-target",
              browserWSEndpoint,
            },
            acquisition: {
              generationId: chromeProcessIdentity.launchClaim.generationId,
              processLaunchClaim: chromeProcessIdentity.launchClaim,
            },
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async (options) => {
            runStarted.resolve();
            await continueRun.promise;
            return browserTransaction(
              options.prompt,
              {
                answerText: "durable shutdown answer",
                answerMarkdown: "durable shutdown answer",
                tookMs: 1,
                answerTokens: 3,
                answerChars: 23,
              },
              runtime,
            );
          },
        },
      );
      let hostPromise: Promise<void> | undefined;
      let hostSettled = false;
      let lockPresentAtTunnelStop: boolean | undefined;
      let recordAtTunnelStop: Promise<unknown> | undefined;
      let listenerProbeAtTunnelStop: Promise<unknown> | undefined;
      const stopTunnel = vi.fn(() => {
        lockPresentAtTunnelStop = existsSync(controllerLockPath);
        recordAtTunnelStop = readAuthenticatedTransactionRecord(
          transactionStoreDir,
          transactionToken,
        );
        listenerProbeAtTunnelStop = httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${rejectedTransactionToken}/run`,
          body: remoteRunPayload(),
        }).then(
          (response) =>
            new Error(
              `remote listener still accepted work during tunnel teardown: ${JSON.stringify(response)}`,
            ),
          (error: unknown) => error,
        );
      });

      try {
        hostPromise = runBridgeHost(
          {
            bind: `127.0.0.1:${server.port}`,
            token: "a".repeat(64),
            writeConnection: connectionPath,
            ssh: "synthetic-bridge-host",
          },
          {
            serveRemote: async (options, lifecycle) => {
              const token = options?.token;
              if (!token) throw new Error("missing bridge credential");
              await lifecycle?.onReady?.({ port: server.port, token });
              return drainRemoteServerShutdown(server, shutdownRequested.promise, {
                logger: () => {},
                retryDelayMs: 1,
              });
            },
            startReverseTunnel: () => {
              tunnelStarted.resolve();
              return { ready: Promise.resolve(), stop: stopTunnel };
            },
          },
        );
        void hostPromise.then(
          () => {
            hostSettled = true;
          },
          () => {
            hostSettled = true;
          },
        );
        await tunnelStarted.promise;

        const runRequest = httpPostNdjson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/run`,
          token: "a".repeat(64),
          body: remoteRunPayload(),
        });
        await runStarted.promise;
        shutdownRequested.resolve();

        await vi.waitFor(async () => {
          await expect(
            httpPostJson({
              hostname: "127.0.0.1",
              port: server.port,
              path: `/transactions/${rejectedTransactionToken}/run`,
              token: "a".repeat(64),
              body: remoteRunPayload(),
            }),
          ).resolves.toMatchObject({
            statusCode: 503,
            json: { error: "server_closing" },
          });
        });

        const explicitClose = server.close();
        let explicitCloseSettled = false;
        void explicitClose.then(
          () => {
            explicitCloseSettled = true;
          },
          () => {
            explicitCloseSettled = true;
          },
        );
        await Promise.resolve();
        expect(explicitCloseSettled).toBe(false);
        expect(hostSettled).toBe(false);
        expect(stopTunnel).not.toHaveBeenCalled();
        expect(existsSync(controllerLockPath)).toBe(true);

        continueRun.resolve();
        const runResponse = await runRequest;
        expect(runResponse.statusCode).toBe(200);
        expect(runResponse.events.find((event) => event.type === "transaction")).toMatchObject({
          transaction: {
            transactionToken,
            state: "pending",
            result: { answerText: "durable shutdown answer" },
          },
        });

        await explicitClose;
        await hostPromise;
        expect(stopTunnel).toHaveBeenCalledOnce();
        expect(lockPresentAtTunnelStop).toBe(false);
        if (!recordAtTunnelStop) throw new Error("missing transaction read at tunnel teardown");
        await expect(recordAtTunnelStop).resolves.toMatchObject({
          state: "pending",
          result: { answerText: "durable shutdown answer" },
          runtime: { chromeTargetId: "graceful-drain-target" },
        });
        if (!listenerProbeAtTunnelStop) throw new Error("missing listener teardown probe");
        const listenerError = await listenerProbeAtTunnelStop;
        expect(listenerError).toBeInstanceOf(Error);
        expect(["ECONNREFUSED", "ECONNRESET"]).toContain(
          (listenerError as NodeJS.ErrnoException).code,
        );
        await expect(server.close()).resolves.toBeUndefined();
      } finally {
        continueRun.resolve();
        shutdownRequested.resolve();
        await hostPromise?.catch(() => undefined);
        await server.close().catch(() => undefined);
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "preserves restart-durable manual kept target authority across graceful shutdown",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-live-close-drain-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const controllerLockPath = path.join(transactionStoreDir, ".controller.lock");
      const transactionToken = "8".repeat(64);
      const targetId = "manual-kept-target";
      const browserWSEndpoint = "ws://127.0.0.1:9222/devtools/browser/manual-kept-generation";
      const profileDir = path.join(tmpDir, "manual-profile");
      const chromeProcessIdentity = processIdentity(
        profileDir,
        4327,
        "10000000-0000-4000-8000-000000000007",
      );
      const closeTarget = vi.fn(async () => ({ status: "completed" as const }));
      targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
      const targetCloseCapability = retainChromeTargetCloseCapability({
        ownerId: transactionToken,
        generationId: "manual-kept-generation",
        targetId,
        browserWSEndpoint,
        close: closeTarget,
      });
      const runtime: BrowserRunTransaction["runtime"] = {
        chromePid: chromeProcessIdentity.pid,
        chromeProcessIdentity,
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        chromeTargetId: targetId,
        recoveryCleanupResources: [
          {
            chromePid: chromeProcessIdentity.pid,
            chromeProcessIdentity,
            profileDirectoryIdentity: chromeProcessIdentity.profileDirectory,
            chromeHost: "127.0.0.1",
            chromePort: 9222,
            chromeBrowserWSEndpoint: browserWSEndpoint,
            chromeProfileRoot: profileDir,
            userDataDir: profileDir,
            chromeTargetId: targetId,
            targetCloseCapability,
            acquisition: { generationId: "manual-kept-generation" },
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "manual-login",
              keepBrowser: true,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      const finalize = vi.fn(async () => {
        const closeResult = await closeChromeTargetWithRetainedCapability({
          ownerId: transactionToken,
          capability: targetCloseCapability,
          targetId,
          logger: () => {},
        });
        if (closeResult.status !== "completed" && closeResult.status !== "gone") {
          return pendingBrowserCaptureCleanup(runtime, closeResult.reason, "finalize");
        }
        const settledRuntime = { ...runtime };
        delete settledRuntime.chromeTargetId;
        return completedBrowserCaptureCleanup(settledRuntime);
      });
      const shutdownRequested = Promise.withResolvers<void>();
      const shutdownErrors: string[] = [];
      let server: RemoteServerInstance | undefined;
      let drain: Promise<void> | undefined;

      try {
        server = await createTestRemoteServer(
          { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
          {
            transactionStoreDir,
            runBrowser: async (options) =>
              browserTransaction(
                options.prompt,
                {
                  answerText: "manual kept answer",
                  answerMarkdown: "manual kept answer",
                  tookMs: 1,
                  answerTokens: 3,
                  answerChars: 18,
                },
                runtime,
                { finalize },
              ),
          },
        );
        const initial = await httpPostNdjson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${transactionToken}/run`,
          token: "a".repeat(64),
          body: remoteRunPayload(),
        });
        expect(initial.statusCode).toBe(200);

        let drainSettled = false;
        drain = drainRemoteServerShutdown(server, shutdownRequested.promise, {
          logger: (message) => shutdownErrors.push(message),
          retryDelayMs: 250,
        });
        void drain.then(
          () => {
            drainSettled = true;
          },
          () => {
            drainSettled = true;
          },
        );
        shutdownRequested.resolve();
        await drain;

        expect(drainSettled).toBe(true);
        expect(shutdownErrors).toEqual([]);
        expect(existsSync(controllerLockPath)).toBe(false);
        expect(closeTarget).not.toHaveBeenCalled();
        expect(targetCloseAuthorityTest.retainedTargetCloseAuthorityCount()).toBe(1);
        const pendingRecord = await readAuthenticatedTransactionRecord(
          transactionStoreDir,
          transactionToken,
        );
        expect(pendingRecord).toMatchObject({
          state: "pending",
          runtime: {
            chromeTargetId: targetId,
            recoveryCleanupResources: [{ targetCloseCapability }],
          },
        });
      } finally {
        shutdownRequested.resolve();
        if (server) {
          await server.close().catch(() => undefined);
        }
        targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "preserves store-only manual target authority after server restart without live close capability",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-recoverable-close-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const controllerLockPath = path.join(transactionStoreDir, ".controller.lock");
      const controllerGeneration = "controller-with-live-recoverable-target";
      const transactionToken = "7".repeat(64);
      const targetId = "recoverable-manual-kept-target";
      const browserWSEndpoint =
        "ws://127.0.0.1:9222/devtools/browser/recoverable-manual-kept-generation";
      const profileDir = path.join(tmpDir, "manual-profile");
      const chromeProcessIdentity = processIdentity(
        profileDir,
        4328,
        "10000000-0000-4000-8000-000000000008",
      );
      const closeTarget = vi.fn(async () => ({ status: "completed" as const }));
      targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
      const targetCloseCapability = retainChromeTargetCloseCapability({
        ownerId: transactionToken,
        generationId: "recoverable-manual-kept-generation",
        targetId,
        browserWSEndpoint,
        close: closeTarget,
      });
      const runtime: BrowserRunTransaction["runtime"] = {
        chromePid: chromeProcessIdentity.pid,
        chromeProcessIdentity,
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        chromeTargetId: targetId,
        recoveryCleanupResources: [
          {
            chromePid: chromeProcessIdentity.pid,
            chromeProcessIdentity,
            profileDirectoryIdentity: chromeProcessIdentity.profileDirectory,
            chromeHost: "127.0.0.1",
            chromePort: 9222,
            chromeBrowserWSEndpoint: browserWSEndpoint,
            chromeProfileRoot: profileDir,
            userDataDir: profileDir,
            chromeTargetId: targetId,
            targetCloseCapability,
            acquisition: { generationId: "recoverable-manual-kept-generation" },
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "manual-login",
              keepBrowser: true,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      const seededStore = await openTestRemoteTransactionStore({
        directory: transactionStoreDir,
        integrityKeyPath: path.join(
          path.dirname(transactionStoreDir),
          ".remote-transaction-integrity.key",
        ),
        controllerGeneration,
      });
      await seededStore.begin({
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        transactionToken,
        runId: "recoverable-manual-kept-run",
        createdAt: new Date().toISOString(),
        requestIdentity: {
          acceptedPromptSha256: ["a".repeat(64)],
          followUpOrdinal: 0,
          remainingFollowUps: 0,
        },
        browserConfig: { chatgptUrl: "https://chatgpt.com/" },
      });
      await seededStore.journalRuntime(transactionToken, runtime);
      await seededStore.recordRecoverableFailure({
        transactionToken,
        runtime,
        error: {
          name: "BrowserAutomationError",
          category: "browser-automation",
          message: "capture failed before durable publication",
          stage: "wait-for-answer",
          recoverableDisconnect: true,
        },
      });
      const retainChromeEndpointAuthority = vi.fn(async () => ({
        browserWSEndpoint,
        kill: vi.fn(async () => ({
          status: "unsafe" as const,
          pid: chromeProcessIdentity.pid,
          reason: "Manual kept Chrome must remain running",
        })),
        runExactOperation: vi.fn(),
        release: vi.fn(async () => undefined),
      }));
      const retryCleanup = vi.fn<typeof retryBrowserRecoveryCleanup>(
        async (cleanupRuntime, logger, deps = {}, mode) => {
          expect(mode).toBe("abort");
          return await retryBrowserRecoveryCleanup(
            cleanupRuntime,
            logger,
            {
              ownerId: deps.ownerId,
              acquireRecoveryLock: vi.fn(async () => ({
                release: async (complete?: () => Promise<void>) => await complete?.(),
              })),
              recoveryCleanup: {
                verifyProfileDirectoryIdentity: vi.fn(async () => true),
                inspectChromeProcessIdentity: vi.fn(async () => "current" as const),
                retainChromeEndpointAuthority,
                closeChromeTargetWithExactAuthority: closeTarget,
              },
            },
            mode,
          );
        },
      );
      targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
      let server: RemoteServerInstance | undefined;

      try {
        server = await createTestRemoteServer(
          { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
          {
            transactionStoreDir,
            controllerGeneration: "controller-after-restart",
            retryCleanup,
          },
        );
        expect(existsSync(controllerLockPath)).toBe(true);
        expect(targetCloseAuthorityTest.retainedTargetCloseAuthorityCount()).toBe(0);

        await expect(
          httpPostJson({
            hostname: "127.0.0.1",
            port: server.port,
            path: `/transactions/${transactionToken}/abort`,
            token: "a".repeat(64),
            body: {},
          }),
        ).resolves.toMatchObject({
          statusCode: 200,
          json: { state: "pending", finalization: { status: "pending" } },
        });

        expect(retryCleanup).toHaveBeenCalledOnce();
        expect(retainChromeEndpointAuthority).toHaveBeenCalledOnce();
        expect(closeTarget).not.toHaveBeenCalled();
        retryCleanup.mockImplementationOnce(async (cleanupRuntime) => {
          const completedRuntime = { ...cleanupRuntime };
          delete completedRuntime.recoveryCleanupResources;
          delete completedRuntime.recoveryCleanupResult;
          return { status: "completed", runtime: completedRuntime };
        });

        await drainRemoteServerShutdown(server, Promise.resolve(), {
          logger: () => {},
          retryDelayMs: 1,
        });

        expect(retryCleanup).toHaveBeenCalledTimes(2);
        expect(retainChromeEndpointAuthority).toHaveBeenCalledOnce();
        expect(closeTarget).not.toHaveBeenCalled();
        expect(existsSync(controllerLockPath)).toBe(false);
        const terminalRecord = await readAuthenticatedTransactionRecord(
          transactionStoreDir,
          transactionToken,
        );
        expect(terminalRecord).toMatchObject({
          state: "aborted",
          terminalAudit: { settlementMode: "abort" },
          finalization: { status: "completed" },
        });
        expect(terminalRecord).not.toHaveProperty("runtime");
        expect(terminalRecord?.finalization?.runtime).not.toHaveProperty("chromeTargetId");
        expect(terminalRecord?.finalization?.runtime).not.toHaveProperty(
          "recoveryCleanupResources",
        );
      } finally {
        await server?.close().catch(() => undefined);
        targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "preserves an unacknowledged artifact capture across graceful restart and resumes delivery",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-shutdown-handoff-"));
      const oracleHome = path.join(tmpDir, "oracle-home");
      const transactionStoreDir = path.join(tmpDir, "transactions");
      let hostArtifactPath: string | undefined;
      const emptyZip = Buffer.from([
        0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      const payload = remoteRunPayload();
      const requestIdentity = buildRemotePromptRequestIdentity(payload);
      const transactionToken = "4".repeat(64);
      const profileDir = path.join(tmpDir, "shutdown-handoff-profile");
      const browserWSEndpoint = "ws://127.0.0.1:9222/devtools/browser/shutdown-handoff-generation";
      const baseChromeProcessIdentity = processIdentity(
        profileDir,
        4326,
        "10000000-0000-4000-8000-000000000006",
      );
      const chromeProcessIdentity = {
        ...baseChromeProcessIdentity,
        launchClaim: {
          ...baseChromeProcessIdentity.launchClaim,
          generationId: "shutdown-handoff-generation",
        },
      };
      const runtime: BrowserRunTransaction["runtime"] = {
        chromePid: chromeProcessIdentity.pid,
        chromeProcessIdentity,
        chromeHost: "127.0.0.1",
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chromePort: 9222,
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        chromeTargetId: "shutdown-handoff-target",
        recoveryCleanupResources: [
          {
            chromePid: chromeProcessIdentity.pid,
            chromeProcessIdentity,
            profileDirectoryIdentity: chromeProcessIdentity.profileDirectory,
            chromeHost: "127.0.0.1",
            chromeBrowserWSEndpoint: browserWSEndpoint,
            chromePort: 9222,
            chromeProfileRoot: profileDir,
            userDataDir: profileDir,
            acquisition: {
              generationId: chromeProcessIdentity.launchClaim.generationId,
              processLaunchClaim: chromeProcessIdentity.launchClaim,
            },
            chromeTargetId: "shutdown-handoff-target",
            targetCloseCapability: {
              version: 1,
              generationId: "shutdown-handoff-generation",
              capabilityId: "shutdown-handoff-capability",
              targetId: "shutdown-handoff-target",
              browserWSEndpoint,
            },
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      const finalize = vi.fn(async () => ({ status: "completed" as const, runtime }));
      const abort = vi.fn(async () => ({ status: "completed" as const, runtime }));
      let first: RemoteServerInstance | undefined;
      let restarted: RemoteServerInstance | undefined;
      setOracleHomeDirOverrideForTest(oracleHome);

      try {
        first = await createTestRemoteServer(
          { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
          {
            transactionStoreDir,
            controllerGeneration: "controller-before-graceful-shutdown",
            runBrowser: async (options) => {
              const artifact = await writeBinaryBrowserArtifact({
                sessionId: options.sessionId,
                artifactWriteAuthority: options.artifactWriteAuthority,
                kind: "file",
                filename: "handoff-result.zip",
                contents: emptyZip,
                label: "handoff result",
                mimeType: "application/zip",
                sourceUrl: "sandbox:/mnt/data/handoff-result.zip",
              });
              if (!artifact) throw new Error("Expected restart artifact fixture");
              hostArtifactPath = artifact.path;
              return browserTransaction(
                options.prompt,
                {
                  answerText: "restart-safe answer",
                  answerMarkdown: "restart-safe answer",
                  tookMs: 1,
                  answerTokens: 2,
                  answerChars: 19,
                  savedFiles: [
                    {
                      ...artifact,
                      kind: "file",
                      url: "browser-download",
                      finalUrl: "browser-download",
                      filename: path.basename(artifact.path),
                    },
                  ],
                },
                runtime,
                { finalize, abort },
              );
            },
          },
        );
        const port = first.port;
        const host = `127.0.0.1:${port}`;
        const initial = await httpPostNdjson({
          hostname: "127.0.0.1",
          port,
          path: `/transactions/${transactionToken}/run`,
          token: "a".repeat(64),
          body: payload,
        });
        expect(initial.statusCode).toBe(200);
        expect(initial.events.find((event) => event.type === "transaction")).toMatchObject({
          transaction: {
            transactionToken,
            state: "pending",
            result: { answerText: "restart-safe answer" },
            artifacts: [{ required: true }],
          },
        });

        if (!hostArtifactPath) throw new Error("Missing restart artifact path");
        const pendingBeforeClose = await readAuthenticatedTransactionRecord(
          transactionStoreDir,
          transactionToken,
        );
        expect(pendingBeforeClose).toMatchObject({
          state: "pending",
          result: { answerText: "restart-safe answer" },
          runtime: { chromeTargetId: "shutdown-handoff-target" },
          artifacts: [{ canonicalPath: await realpath(hostArtifactPath) }],
        });
        expect(pendingBeforeClose).not.toHaveProperty("settlementMode");
        expect(pendingBeforeClose).not.toHaveProperty("publicationAcknowledgedAt");
        expect(pendingBeforeClose).not.toHaveProperty("finalization");

        await first.close();
        first = undefined;
        expect(finalize).not.toHaveBeenCalled();
        expect(abort).not.toHaveBeenCalled();
        await expect(
          readAuthenticatedTransactionRecord(transactionStoreDir, transactionToken),
        ).resolves.toEqual(pendingBeforeClose);

        const retryCleanup = vi.fn<typeof retryBrowserRecoveryCleanup>(
          async (settlementRuntime, _logger, _deps = {}, mode) => {
            expect(mode).toBe("finalize");
            return { status: "completed" as const, runtime: settlementRuntime };
          },
        );
        restarted = await createTestRemoteServer(
          { host: "127.0.0.1", port, token: "a".repeat(64), logger: () => {} },
          {
            transactionStoreDir,
            controllerGeneration: "controller-after-graceful-shutdown",
            retryCleanup,
          },
        );
        const resumed = await resumeRemoteBrowserTransaction({
          runtime: {
            recoveryCleanupResources: [
              {
                remoteRecovery: {
                  protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
                  host,
                  transactionToken,
                  state: "pre-receipt",
                  requestIdentity,
                },
                recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
              },
            ],
          },
          configuredHost: host,
          authToken: "a".repeat(64),
          sessionId: "shutdown-handoff-client",
        });
        expect(resumed.answerText).toBe("restart-safe answer");
        expect(resumed.artifacts).toHaveLength(1);
        await expect(readFile(resumed.artifacts![0]!.path)).resolves.toEqual(emptyZip);
        const deliveredRecord = await readAuthenticatedTransactionRecord(
          transactionStoreDir,
          transactionToken,
        );
        expect(deliveredRecord).toMatchObject({
          state: "pending",
          result: { answerText: "restart-safe answer" },
          runtime: { chromeTargetId: "shutdown-handoff-target" },
          artifacts: [{ deliveryReceipt: { byteSize: emptyZip.length } }],
        });
        expect(deliveredRecord).not.toHaveProperty("settlementMode");
        expect(deliveredRecord).not.toHaveProperty("publicationAcknowledgedAt");

        await expect(resumed.finalize()).resolves.toMatchObject({ status: "completed" });
        expect(retryCleanup).toHaveBeenCalledOnce();
        expect(retryCleanup.mock.calls[0]?.[3]).toBe("finalize");
        expect(finalize).not.toHaveBeenCalled();
        expect(abort).not.toHaveBeenCalled();
        await expect(resumed.abort()).rejects.toMatchObject({
          name: "BrowserAutomationError",
          details: { code: "settlement-mode-conflict" },
        });
        const finalizedRecord = await readAuthenticatedTransactionRecord(
          transactionStoreDir,
          transactionToken,
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
      } finally {
        await restarted?.close().catch(() => undefined);
        await first?.close().catch(() => undefined);
        await rm(tmpDir, { recursive: true, force: true });
        setOracleHomeDirOverrideForTest(null);
      }
    },
    30_000,
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "retries partial live cleanup only in its durable settlement mode",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-finalize-retry-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const firstCleanupMarker = path.join(tmpDir, "first-cleanup-pending");
      const secondCleanupMarker = path.join(tmpDir, "second-cleanup-pending");
      await writeFile(firstCleanupMarker, "owned", "utf8");
      await writeFile(secondCleanupMarker, "owned", "utf8");
      const runtime: BrowserRunTransaction["runtime"] = {
        chromePort: 9222,
        recoveryCleanupResources: [
          {
            chromePort: 9222,
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      let cleanupAttempts = 0;
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
        {
          transactionStoreDir,
          runBrowser: async (options) =>
            lifecycleBrowserTransaction(
              options.prompt,
              {
                answerText: "done",
                answerMarkdown: "done",
                tookMs: 1,
                answerTokens: 1,
                answerChars: 4,
              },
              runtime,
              options.runtimeHintCb,
              async (settlementMode, pendingRuntime) => {
                cleanupAttempts += 1;
                if (cleanupAttempts === 1) {
                  await rm(firstCleanupMarker);
                  return pendingBrowserCaptureCleanup(
                    pendingRuntime,
                    "Chrome still busy at /private/host/profile via ws://127.0.0.1:9222/private",
                    settlementMode,
                  );
                }
                await rm(secondCleanupMarker);
                return completedBrowserCaptureCleanup(pendingRuntime);
              },
            ),
        },
      );

      try {
        const transaction = await createRemoteBrowserExecutor({
          host: `127.0.0.1:${server.port}`,
          token: "a".repeat(64),
        })({ prompt: "retry cleanup", config: {} });
        const firstFinalization = await transaction.finalize();
        expect(firstFinalization).toMatchObject({
          status: "pending",
          runtime: {
            recoveryCleanupResources: [{ remoteRecovery: { state: "pending" } }],
            recoveryCleanupResult: { status: "failed", settlementMode: "finalize" },
          },
        });
        if (firstFinalization.status !== "pending") {
          throw new Error("expected first remote cleanup finalization to remain pending");
        }
        expect(firstFinalization.error).toBe(
          "Remote browser cleanup remains pending; retry the same settlement mode.",
        );
        expect(firstFinalization.error).not.toContain("/private/host/profile");
        expect(firstFinalization.error).not.toContain("ws://");
        expect(cleanupAttempts).toBe(1);
        expect(existsSync(firstCleanupMarker)).toBe(false);
        expect(existsSync(secondCleanupMarker)).toBe(true);
        await expect(transaction.abort()).rejects.toMatchObject({
          details: { code: "settlement-mode-conflict" },
        });
        expect(cleanupAttempts).toBe(1);

        const recordName = (await readdir(transactionStoreDir)).find((name) =>
          name.endsWith(".json"),
        );
        if (!recordName) throw new Error("missing durable remote transaction record");
        const partialRecord = await readAuthenticatedTransactionRecord(
          transactionStoreDir,
          recordName.slice(0, -".json".length),
        );
        expect(partialRecord).toMatchObject({
          state: "pending",
          settlementMode: "finalize",
          runtime: {
            recoveryCleanupResult: { status: "failed", settlementMode: "finalize" },
          },
          finalization: { status: "pending" },
        });

        const retry = await httpPostJson({
          hostname: "127.0.0.1",
          port: server.port,
          path: `/transactions/${recordName.slice(0, -".json".length)}/retry`,
          token: "a".repeat(64),
          body: {},
        });
        expect(retry).toMatchObject({
          statusCode: 200,
          json: { status: "terminal", outcome: { state: "finalized" } },
        });
        expect(cleanupAttempts).toBe(2);
        expect(existsSync(secondCleanupMarker)).toBe(false);
        await expect(transaction.finalize()).resolves.toMatchObject({ status: "completed" });
        expect(cleanupAttempts).toBe(2);
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
              ownsTarget: false,
              profileKind: "none",
              keepBrowser: true,
            },
          },
          {
            chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/wss-authority",
            chromeTargetId: "wss-target",
            recoveryCleanup: {
              ownsTarget: false,
              profileKind: "none",
              keepBrowser: true,
            },
          },
        ],
      };
      const server = await createTestRemoteServer(
        { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} },
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
          token: "a".repeat(64),
        })({ prompt: "WSS contract", config: {} });
        expect(transaction.runtime).toMatchObject({
          promptEpoch: {
            promptSha256: promptIdentitySha256("WSS contract"),
            conversationId: "remote-conversation",
          },
          recoveryCleanupResources: [
            {
              recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
              remoteRecovery: { state: "pending" },
            },
          ],
        });
        expect(transaction.runtime).not.toHaveProperty("chromePort");
        expect(transaction.runtime).not.toHaveProperty("chromeBrowserWSEndpoint");
        expect(transaction.runtime).not.toHaveProperty("chromeTargetId");
        for (const resource of transaction.runtime.recoveryCleanupResources ?? []) {
          expect(resource).not.toHaveProperty("chromePort");
          expect(resource).not.toHaveProperty("chromeBrowserWSEndpoint");
          expect(resource).not.toHaveProperty("chromeTargetId");
        }
        const finalization = await transaction.finalize();
        expect(finalization).toMatchObject({ status: "completed" });
        expect(finalization.runtime.recoveryCleanupResources).toBeUndefined();
        expect(finalization.runtime).not.toHaveProperty("remoteRecovery");
      } finally {
        await server.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
