import http from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import chalk from "chalk";
import type { BrowserLogger, BrowserRunTransaction } from "../browser/types.js";
import {
  acquireCrashRecoverableFilesystemLock,
  type CrashRecoverableFilesystemLockDeps,
} from "../browser/filesystemLock.js";
import { resumeBrowserSession, retryBrowserRecoveryCleanup } from "../browser/reattach.js";
import type { ChromeProcessIdentity } from "../browser/chromeProcessIdentity.js";
import type {
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
import { attachRemoteRequestRouter, type RemoteControllerOperation } from "./serverRouting.js";
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
  assertRemoteTransactionStoreRootAuthority,
  initializeRemoteTransactionStoreRoot,
  protectRemoteTransactionStoreRoot,
  remoteTransactionHeadDirectory,
} from "./transactionStoreRoot.js";
import type { WindowsPrivateTreeAuthority } from "./windowsPrivateTreeAcl.js";
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
  transactionIntegrityKeyPath?: string;
  transactionAuthorityDir?: string;
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
  controllerLockDeps?: CrashRecoverableFilesystemLockDeps;
  transactionStorePlatform?: NodeJS.Platform;
  windowsPrivateTreeAuthority?: WindowsPrivateTreeAuthority;
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
  const transactionIntegrityKeyPath =
    deps.transactionIntegrityKeyPath ??
    path.join(path.dirname(transactionStoreDir), ".remote-transaction-integrity.key");
  const transactionAuthorityDir = remoteTransactionHeadDirectory(
    transactionIntegrityKeyPath,
    deps.transactionAuthorityDir,
  );
  const controllerGeneration = deps.controllerGeneration ?? randomUUID();
  const requestAuthenticator = new RemoteRequestAuthenticator({
    rootKey: authToken,
    serverGeneration: controllerGeneration,
  });
  const transactionStoreRootOptions = {
    directory: transactionStoreDir,
    integrityKeyPath: transactionIntegrityKeyPath,
    authorityDirectory: transactionAuthorityDir,
    platform: deps.transactionStorePlatform,
    windowsPrivateTreeAuthority: deps.windowsPrivateTreeAuthority,
  };
  const transactionStoreRoot = await initializeRemoteTransactionStoreRoot(
    transactionStoreRootOptions,
  );
  const transactionStorePlatform = deps.transactionStorePlatform ?? process.platform;
  if (transactionStorePlatform !== "win32") {
    await protectRemoteTransactionStoreRoot(transactionStoreRootOptions, transactionStoreRoot);
  }
  const controllerLock = await acquireCrashRecoverableFilesystemLock(
    path.join(transactionStoreRoot.directory, ".controller.lock"),
    {
      sessionId: `remote-controller:${controllerGeneration}`,
      createParent: false,
      expectedParentIdentity: transactionStoreRoot.storeRootIdentity,
    },
    deps.controllerLockDeps,
  );
  let transactionStore: RemoteTransactionStore;
  try {
    if (transactionStorePlatform === "win32") {
      await protectRemoteTransactionStoreRoot(transactionStoreRootOptions, transactionStoreRoot);
    }
    await assertRemoteTransactionStoreRootAuthority(transactionStoreRoot);
    transactionStore = await RemoteTransactionStore.open({
      directory: transactionStoreDir,
      integrityKeyPath: transactionIntegrityKeyPath,
      authorityDirectory: transactionAuthorityDir,
      leaseDurationMs: deps.transactionLeaseDurationMs,
      now: deps.transactionStoreNow,
      controllerGeneration,
      rootAuthority: transactionStoreRoot,
      platform: deps.transactionStorePlatform,
      windowsPrivateTreeAuthority: deps.windowsPrivateTreeAuthority,
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
  const admittedTransactions = new Map<string, { controllerGeneration: string }>();
  const remoteTransactionRetryWork = new Map<string, Promise<unknown>>();
  let lifecycleState: "open" | "draining" | "closed" = "open";
  let settlementAdmissionOpen = true;
  let controllerSettlementComplete = false;
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
    retryCleanup: (runtime, mode, ownerId) => {
      const cleanup = injectedRetryCleanup ?? retryBrowserRecoveryCleanup;
      return cleanup(
        runtime,
        cleanupLogger,
        injectedRetryCleanup
          ? { ownerId }
          : {
              ownerId,
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
  const admitRemoteTransaction = (transactionToken: string): (() => void) | null => {
    if (admittedTransactions.has(transactionToken)) return null;
    const admission = { controllerGeneration };
    admittedTransactions.set(transactionToken, admission);
    return () => {
      if (admittedTransactions.get(transactionToken) === admission) {
        admittedTransactions.delete(transactionToken);
      }
    };
  };
  const isRemoteTransactionAdmitted = (transactionToken: string): boolean =>
    admittedTransactions.get(transactionToken)?.controllerGeneration === controllerGeneration;
  const runRemoteTransactionRetryWork = async <T>(
    transactionToken: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const existing = remoteTransactionRetryWork.get(transactionToken);
    if (existing) return (await existing) as T;
    const inFlight = Promise.resolve().then(operation);
    remoteTransactionRetryWork.set(transactionToken, inFlight);
    const clear = () => {
      if (remoteTransactionRetryWork.get(transactionToken) === inFlight) {
        remoteTransactionRetryWork.delete(transactionToken);
      }
    };
    void inFlight.then(clear, clear);
    return await inFlight;
  };
  const admitControllerOperation = (operation: RemoteControllerOperation): (() => void) | null => {
    if (
      lifecycleState === "closed" ||
      (lifecycleState === "draining" &&
        (operation !== "settlement-continuation" || !settlementAdmissionOpen))
    ) {
      return null;
    }
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
    if (lifecycleState !== "open" && !allowDuringClose) {
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
    const finishBrowserWork = startBrowserWork("exclusive", true);
    try {
      return await operation();
    } finally {
      finishBrowserWork();
    }
  };
  const sweepExpiredAuthority = async (waitForExisting = false): Promise<void> => {
    if (lifecycleState !== "open") return;
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
    admitRemoteTransaction,
    isRemoteTransactionAdmitted,
    runRemoteTransactionRetryWork,
    isClosing: () => lifecycleState !== "open",
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
    settlementAdmissionOpen = false;
    try {
      await waitForControllerOperationsToDrain();
      await waitForBrowserWorkToDrain();
      if (!controllerSettlementComplete) {
        const finishBrowserWork = startBrowserWork("exclusive", true);
        try {
          await settleRemoteControllerShutdown({
            transactionStore,
            transactionCoordinator,
            activeTransactions,
            logger,
          });
          controllerSettlementComplete = true;
        } finally {
          finishBrowserWork();
        }
      }
      await waitForControllerOperationsToDrain();
      await waitForBrowserWorkToDrain();
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
      lifecycleState = "closed";
    } catch (error) {
      if (!controllerSettlementComplete && !listenerClosed) settlementAdmissionOpen = true;
      throw error;
    }
  };

  return {
    port: address.port,
    token: authToken,
    close() {
      if (lifecycleState === "closed") return Promise.resolve();
      if (closeInFlight) return closeInFlight;
      lifecycleState = "draining";
      let retainedClose: Promise<void>;
      retainedClose = closeRemoteServer().catch((error) => {
        if (closeInFlight === retainedClose) closeInFlight = null;
        throw error;
      });
      closeInFlight = retainedClose;
      return retainedClose;
    },
  };
}
