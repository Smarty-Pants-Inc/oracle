import http from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import chalk from "chalk";
import type { BrowserLogger, BrowserRunTransaction } from "../browser/types.js";
import { acquireCrashRecoverableFilesystemLock } from "../browser/filesystemLock.js";
import { resumeBrowserSession, retryBrowserRecoveryCleanup } from "../browser/reattach.js";
import type {
  ChromeProcessIdentity,
  ProfileDirectoryIdentity,
  ProfileStateLogger,
  RecordedChromeTerminationOutcome,
} from "../browser/profileState.js";
import { runBrowserModeTransaction } from "../browser/browserCoordinator.js";
import { getOracleHomeDir } from "../oracleHome.js";
import type { BrowserRuntimeMetadata } from "../sessionManager.js";
import { RemoteArtifactStore } from "./artifactStore.js";
import {
  assertRemoteCredential,
  generateRemoteCredential,
  RemoteRequestAuthenticator,
} from "./auth.js";
import {
  assertLoopbackRemoteBind,
  REMOTE_PLAINTEXT_TRANSPORT_GUIDANCE,
} from "./remoteServiceConfig.js";
import { attachRemoteRequestRouter } from "./serverRouting.js";
import { terminateRemoteChromeWithExactControl } from "./serverTransactionRuntime.js";
import type { RemoteServerInstance, RemoteServerOptions } from "./serverTypes.js";
import {
  RemoteTransactionConflictError,
  RemoteTransactionCoordinator,
} from "./transactionCoordinator.js";
import {
  reconcileRemoteTransactionAuthority,
  settleRemoteControllerShutdown,
  sweepExpiredRemoteTransactions,
} from "./transactionServer.js";
import type { ReconcileRemoteTransactionResult } from "./transactionModel.js";
import { RemoteTransactionStore } from "./transactionStore.js";
import {
  DEFAULT_REMOTE_CONTROL_OVERALL_TIMEOUT_MS,
  DEFAULT_REMOTE_RUN_OVERALL_TIMEOUT_MS,
  DEFAULT_REMOTE_SOCKET_IDLE_TIMEOUT_MS,
} from "./types.js";

interface RemoteServerDeps {
  runBrowser?: (
    options: Parameters<typeof runBrowserModeTransaction>[0],
  ) => Promise<BrowserRunTransaction>;
  resumeBrowser?: typeof resumeBrowserSession;
  transactionStoreDir?: string;
  retryCleanup?: typeof retryBrowserRecoveryCleanup;
  exactChromeCleanup?: (
    runtime: BrowserRuntimeMetadata,
    profileDir: string,
    identity: ChromeProcessIdentity,
    logger?: ProfileStateLogger,
  ) => Promise<RecordedChromeTerminationOutcome>;
  removeCleanupProfile?: (
    profileDir: string,
    expectedIdentity: ProfileDirectoryIdentity,
  ) => Promise<boolean>;
  controllerGeneration?: string;
  transactionLeaseDurationMs?: number;
  transactionStoreNow?: () => number;
  leaseSweepIntervalMs?: number;
}

export async function createRemoteServer(
  options: RemoteServerOptions = {},
  deps: RemoteServerDeps = {},
): Promise<RemoteServerInstance> {
  const bindHost = options.host ?? "127.0.0.1";
  assertLoopbackRemoteBind(bindHost);
  const runBrowser = deps.runBrowser ?? runBrowserModeTransaction;
  const resumeBrowser = deps.resumeBrowser ?? resumeBrowserSession;
  const injectedRetryCleanup = deps.retryCleanup;
  const server = http.createServer();
  const logger = options.logger ?? console.log;
  const authToken =
    options.token === undefined
      ? generateRemoteCredential()
      : assertRemoteCredential(options.token, "Remote server v3 HMAC root key");
  const legacyToken =
    options.legacyToken === undefined
      ? undefined
      : assertRemoteCredential(options.legacyToken, "Remote server legacy bearer credential");
  if (legacyToken && legacyToken === authToken) {
    throw new Error(
      "Legacy bearer credential must be distinct from the transaction HMAC root key.",
    );
  }
  const startedAt = Date.now();
  server.headersTimeout = DEFAULT_REMOTE_CONTROL_OVERALL_TIMEOUT_MS;
  server.requestTimeout = DEFAULT_REMOTE_RUN_OVERALL_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;
  server.setTimeout(DEFAULT_REMOTE_SOCKET_IDLE_TIMEOUT_MS, (socket) => socket.destroy());
  const verbose = process.argv.includes("--verbose") || process.env.ORACLE_SERVE_VERBOSE === "1";
  const color = process.stdout.isTTY
    ? (formatter: (msg: string) => string, msg: string) => formatter(msg)
    : (_formatter: (msg: string) => string, msg: string) => msg;
  const transactionStoreDir =
    deps.transactionStoreDir ?? path.join(getOracleHomeDir(), "remote-transactions");
  const controllerGeneration = deps.controllerGeneration ?? randomUUID();
  const requestAuthenticator = new RemoteRequestAuthenticator({
    rootKey: authToken,
    serverGeneration: controllerGeneration,
  });
  const controllerLock = await acquireCrashRecoverableFilesystemLock(
    path.join(transactionStoreDir, ".controller.lock"),
    {
      sessionId: `remote-controller:${controllerGeneration}`,
    },
  );
  let transactionStore: RemoteTransactionStore;
  try {
    transactionStore = await RemoteTransactionStore.open({
      directory: transactionStoreDir,
      leaseDurationMs: deps.transactionLeaseDurationMs,
      now: deps.transactionStoreNow,
      controllerGeneration,
    });
  } catch (error) {
    await controllerLock.release().catch(() => undefined);
    throw error;
  }
  const artifactStore = new RemoteArtifactStore({
    transactionStore,
    sessionsRoot: path.join(getOracleHomeDir(), "sessions"),
  });
  const activeTransactions = new Map<string, BrowserRunTransaction>();
  let closing = false;
  let closed = false;
  let closeInFlight: Promise<void> | null = null;
  let leaseSweepStopped = false;
  let listenerClosed = false;
  let controllerLockReleased = false;
  const cleanupLogger = ((message?: string) => {
    if (typeof message === "string") logger(`[serve] ${message}`);
  }) as BrowserLogger;
  const transactionCoordinator = new RemoteTransactionCoordinator({
    transactionStore,
    activeTransactions,
    retryCleanup: (runtime, mode) => {
      const cleanup = injectedRetryCleanup ?? retryBrowserRecoveryCleanup;
      return cleanup(
        runtime,
        cleanupLogger,
        injectedRetryCleanup
          ? {}
          : {
              recoveryCleanup: {
                terminateExactChromeForProfile: (profileDir, identity, cleanupLog) =>
                  (deps.exactChromeCleanup ?? terminateRemoteChromeWithExactControl)(
                    runtime,
                    profileDir,
                    identity,
                    cleanupLog,
                  ),
                removeProfile: deps.removeCleanupProfile,
              },
            },
        mode,
      );
    },
  });

  // Modern runs may share browser capacity, while legacy runs, recovery, settlement, and sweeps
  // retain exclusive authority. Every acquisition owns an idempotent release so stale completion
  // cannot release a newer work generation.
  let browserWorkCount = 0;
  let browserWorkExclusive = false;
  let browserWorkIdle: { promise: Promise<void>; resolve: () => void } | null = null;
  let sweepInFlight: Promise<void> | null = null;
  let controllerOperationCount = 0;
  let controllerOperationsIdle: { promise: Promise<void>; resolve: () => void } | null = null;
  const admitControllerOperation = (): (() => void) | null => {
    if (closing) return null;
    if (controllerOperationCount === 0) controllerOperationsIdle = Promise.withResolvers<void>();
    controllerOperationCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      controllerOperationCount -= 1;
      if (controllerOperationCount === 0) {
        const idle = controllerOperationsIdle;
        controllerOperationsIdle = null;
        idle?.resolve();
      }
    };
  };
  const waitForControllerOperationsToDrain = async (): Promise<void> => {
    while (controllerOperationCount > 0) {
      const idle = controllerOperationsIdle;
      if (!idle) throw new Error("Remote controller operation drain lost its completion signal");
      await idle.promise;
    }
  };
  const startBrowserWork = (
    mode: "shared-run" | "exclusive" = "exclusive",
    allowDuringClose = false,
  ): (() => void) => {
    if (closing && !allowDuringClose) {
      throw new RemoteTransactionConflictError(
        503,
        "server_closing",
        "Remote server is shutting down",
      );
    }
    if (browserWorkExclusive || (mode === "exclusive" && browserWorkCount > 0)) {
      throw new RemoteTransactionConflictError(
        409,
        "busy",
        "Remote browser authority is already in use",
      );
    }
    if (browserWorkCount === 0) browserWorkIdle = Promise.withResolvers<void>();
    browserWorkCount += 1;
    if (mode === "exclusive") browserWorkExclusive = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      browserWorkCount -= 1;
      if (mode === "exclusive") browserWorkExclusive = false;
      if (browserWorkCount === 0) {
        const idle = browserWorkIdle;
        browserWorkIdle = null;
        idle?.resolve();
      }
    };
  };
  const waitForBrowserWorkToDrain = async (): Promise<void> => {
    while (browserWorkCount > 0) {
      const idle = browserWorkIdle;
      if (!idle) throw new Error("Remote browser work drain lost its completion signal");
      await idle.promise;
    }
  };
  const runBrowserWork = async <T>(operation: () => Promise<T>): Promise<T> => {
    const finishBrowserWork = startBrowserWork();
    try {
      return await operation();
    } finally {
      finishBrowserWork();
    }
  };
  const queueBrowserSettlement = async <T>(operation: () => Promise<T>): Promise<T> => {
    while (browserWorkExclusive) {
      const idle = browserWorkIdle;
      if (!idle) throw new Error("Remote browser work queue lost its completion signal");
      await idle.promise;
    }
    return await runBrowserWork(operation);
  };
  const sweepExpiredAuthority = async (waitForExisting = false): Promise<void> => {
    if (closing) return;
    if (sweepInFlight) {
      if (waitForExisting) await sweepInFlight;
      return;
    }
    if (browserWorkCount > 0) return;
    const finishBrowserWork = startBrowserWork();
    const sweep = sweepExpiredRemoteTransactions({
      transactionStore,
      transactionCoordinator,
      logger,
    });
    sweepInFlight = sweep;
    try {
      await sweep;
    } finally {
      if (sweepInFlight === sweep) sweepInFlight = null;
      finishBrowserWork();
    }
  };

  let reconciled: ReconcileRemoteTransactionResult[];
  try {
    reconciled = await reconcileRemoteTransactionAuthority({
      transactionStore,
      transactionCoordinator,
      logger,
    });
    await sweepExpiredAuthority(true);
  } catch (error) {
    await controllerLock.release().catch(() => undefined);
    throw error;
  }
  for (const record of reconciled) {
    logger(
      `[serve] Reconciled stale transaction ${record.transactionToken.slice(0, 12)} (${record.state}).`,
    );
  }

  if (!process.listenerCount("unhandledRejection")) {
    process.on("unhandledRejection", (reason) => {
      logger(
        `Unhandled promise rejection in remote server: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    });
  }

  attachRemoteRequestRouter(server, {
    options,
    runBrowser,
    resumeBrowser,
    logger,
    cleanupLogger,
    verbose,
    authToken,
    legacyToken,
    controllerGeneration,
    requestAuthenticator,
    startedAt,
    transactionStore,
    artifactStore,
    transactionCoordinator,
    admitControllerOperation,
    isClosing: () => closing,
    isBrowserWorkBusy: () => browserWorkCount > 0,
    isBrowserWorkExclusive: () => browserWorkExclusive,
    startBrowserWork,
    runBrowserWork,
    queueBrowserSettlement,
    sweepExpiredAuthority,
  });

  const listenDeferred = Promise.withResolvers<void>();
  const rejectListen = (error: Error) => listenDeferred.reject(error);
  server.once("error", rejectListen);
  try {
    server.listen(options.port ?? 0, bindHost, () => {
      server.off("error", rejectListen);
      listenDeferred.resolve();
    });
    await listenDeferred.promise;
  } catch (error) {
    await controllerLock.release().catch(() => undefined);
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    const closeDeferred = Promise.withResolvers<void>();
    server.close((error) => (error ? closeDeferred.reject(error) : closeDeferred.resolve()));
    await closeDeferred.promise.catch(() => undefined);
    await controllerLock.release().catch(() => undefined);
    throw new Error("Unable to determine server address.");
  }
  const leaseSweepIntervalMs = deps.leaseSweepIntervalMs ?? 30_000;
  if (!Number.isSafeInteger(leaseSweepIntervalMs) || leaseSweepIntervalMs <= 0) {
    const closeDeferred = Promise.withResolvers<void>();
    server.close((error) => (error ? closeDeferred.reject(error) : closeDeferred.resolve()));
    await closeDeferred.promise.catch(() => undefined);
    await controllerLock.release().catch(() => undefined);
    throw new Error("Invalid remote transaction lease sweep interval");
  }
  const leaseSweepTimer = setInterval(() => {
    void sweepExpiredAuthority().catch((error) => {
      logger(
        `[serve] Expired transaction sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, leaseSweepIntervalMs);
  leaseSweepTimer.unref();

  const boundEndpoint = address.address.includes(":")
    ? `[${address.address}]:${address.port}`
    : `${address.address}:${address.port}`;
  logger(color(chalk.cyanBright.bold, `Listening at ${boundEndpoint}`));
  logger(color(chalk.cyan, REMOTE_PLAINTEXT_TRANSPORT_GUIDANCE));
  logger("Leave this terminal running; press Ctrl+C to stop oracle serve.");

  const closeRemoteServer = async (): Promise<void> => {
    await waitForControllerOperationsToDrain();
    await waitForBrowserWorkToDrain();
    const finishBrowserWork = startBrowserWork("exclusive", true);
    try {
      await settleRemoteControllerShutdown({
        transactionStore,
        transactionCoordinator,
        activeTransactions,
        logger,
      });
    } finally {
      finishBrowserWork();
    }
    if (!leaseSweepStopped) {
      clearInterval(leaseSweepTimer);
      leaseSweepStopped = true;
    }
    if (!listenerClosed) {
      if (server.listening) {
        const closeDeferred = Promise.withResolvers<void>();
        server.close((error) => (error ? closeDeferred.reject(error) : closeDeferred.resolve()));
        await closeDeferred.promise;
      }
      listenerClosed = true;
    }
    if (!controllerLockReleased) {
      await controllerLock.release();
      controllerLockReleased = true;
    }
    closed = true;
  };

  return {
    port: address.port,
    token: authToken,
    close() {
      if (closed) return Promise.resolve();
      if (closeInFlight) return closeInFlight;
      closing = true;
      let retainedClose: Promise<void>;
      retainedClose = closeRemoteServer().catch((error) => {
        if (closeInFlight === retainedClose) closeInFlight = null;
        if (!listenerClosed) closing = false;
        throw error;
      });
      closeInFlight = retainedClose;
      return retainedClose;
    },
  };
}
