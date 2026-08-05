import http from "node:http";
import { pipeline } from "node:stream/promises";
import { homedir, release, tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import chalk from "chalk";
import CDP from "chrome-remote-interface";
import type {
  BrowserAttachment,
  BrowserCaptureFinalizationResult,
  BrowserLogger,
  ChromeClient,
  CookieParam,
} from "../browser/types.js";
import { runBrowserMode } from "../browserMode.js";
import type { BrowserRunResult, BrowserRunTransaction } from "../browserMode.js";
import type {
  RemoteArtifactCapabilities,
  RemoteArtifactDeliveryReceiptRequest,
  RemoteBrowserAutomationErrorPayload,
  RemoteBrowserRunConfig,
  RemotePublicRunResult,
  RemotePublicRuntime,
  RemoteRunPayload,
  RemoteRunEvent,
  RemoteRunTransactionPayload,
  RemoteTransactionRetryResponse,
  RemoteTransactionSettlementResponse,
} from "./types.js";
import {
  DEFAULT_REMOTE_CONTROL_OVERALL_TIMEOUT_MS,
  DEFAULT_REMOTE_RUN_OVERALL_TIMEOUT_MS,
  DEFAULT_REMOTE_SOCKET_IDLE_TIMEOUT_MS,
  MAX_REMOTE_ARTIFACT_BYTES,
  MAX_REMOTE_ATTACHMENT_BYTES,
  MAX_REMOTE_ATTACHMENTS,
  MAX_REMOTE_PROMPT_CHARS,
  MAX_REMOTE_TOTAL_ATTACHMENT_BYTES,
  MAX_REMOTE_REQUEST_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  REMOTE_TRANSACTION_TOKEN_PATTERN,
  buildRemotePromptRequestIdentity,
  RemoteAbortRequestSchema,
  RemoteArtifactDeliveryReceiptRequestSchema,
  RemoteFinalizeRequestSchema,
  RemoteRetryRequestSchema,
  RemoteBrowserAutomationErrorSchema,
  RemoteRunTransactionPayloadSchema,
  RemoteTransactionSettlementResponseSchema,
  RemotePublicRunResultSchema,
  RemoteRunPayloadSchema,
} from "./types.js";
import { getCookies, type Cookie } from "@steipete/sweet-cookie";
import { CHATGPT_URL } from "../browser/constants.js";
import { getCliVersion } from "../version.js";
import { getOracleHomeDir } from "../oracleHome.js";
import { delay, normalizeChatgptUrl, estimateTokenCount } from "../browser/utils.js";
import { sanitizeArtifactFilename, sanitizeArtifactMimeType } from "../browser/artifacts.js";
import type {
  BrowserRemotePromptRequestIdentity,
  BrowserRuntimeMetadata,
  BrowserSessionConfig,
  SessionArtifact,
} from "../sessionManager.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  resumeBrowserSession,
  retryBrowserRecoveryCleanup,
  type ReattachResult,
} from "../browser/reattach.js";
import { acquireManualChromeOwner } from "../browser/manualChromeOwner.js";
import { resolveBrowserConfig } from "../browser/config.js";
import { acquireCrashRecoverableFilesystemLock } from "../browser/filesystemLock.js";
import {
  inspectChromeProcessIdentity,
  readOracleChromeOwner,
  sameChromeProcessIdentity,
  type ChromeProcessIdentity,
  type ProfileStateLogger,
  type RecordedChromeTerminationOutcome,
} from "../browser/profileState.js";
import { RemoteArtifactStore, RemoteArtifactUnavailableError } from "./artifactStore.js";
import {
  type DurableRemoteAutomationError,
  RemoteTransactionCapacityError,
  type RemoteTransactionRecord,
  type ReconcileRemoteTransactionResult,
  RemoteTransactionStore,
} from "./transactionStore.js";
import {
  RemoteTransactionConflictError,
  RemoteTransactionCoordinator,
} from "./transactionCoordinator.js";
import {
  assertLoopbackRemoteBind,
  REMOTE_PLAINTEXT_TRANSPORT_GUIDANCE,
} from "./remoteServiceConfig.js";

export interface RemoteServerOptions {
  host?: string;
  port?: number;
  token?: string;
  logger?: (message: string) => void;
  manualLoginDefault?: boolean;
  manualLoginProfileDir?: string;
}

interface RemoteServerDeps {
  runBrowser?: (options: Parameters<typeof runBrowserMode>[0]) => Promise<BrowserRunTransaction>;
  resumeBrowser?: typeof resumeBrowserSession;
  transactionStoreDir?: string;
  retryCleanup?: typeof retryBrowserRecoveryCleanup;
  exactChromeCleanup?: typeof terminateRemoteChromeWithExactControl;
  controllerGeneration?: string;
  transactionLeaseDurationMs?: number;
  transactionStoreNow?: () => number;
  leaseSweepIntervalMs?: number;
}

interface RemoteServerInstance {
  port: number;
  token: string;
  close(): Promise<void>;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const ARTIFACT_PROTOCOL_VERSION = 1;

const ARTIFACT_CAPABILITIES: RemoteArtifactCapabilities = {
  artifactTransfer: true,
  artifactProtocolVersion: ARTIFACT_PROTOCOL_VERSION,
  transactionProtocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
  maxArtifactBytes: MAX_REMOTE_ARTIFACT_BYTES,
  maxRequestBytes: MAX_REMOTE_REQUEST_BYTES,
  maxAttachmentBytes: MAX_REMOTE_ATTACHMENT_BYTES,
  maxTotalAttachmentBytes: MAX_REMOTE_TOTAL_ATTACHMENT_BYTES,
  maxAttachments: MAX_REMOTE_ATTACHMENTS,
  maxPromptChars: MAX_REMOTE_PROMPT_CHARS,
  transportSecurity: "loopback-http",
  boundedRequestDeadlines: true,
  boundedTransactionStore: true,
};

export async function createRemoteServer(
  options: RemoteServerOptions = {},
  deps: RemoteServerDeps = {},
): Promise<RemoteServerInstance> {
  const bindHost = options.host ?? "127.0.0.1";
  assertLoopbackRemoteBind(bindHost);
  const runBrowser = deps.runBrowser ?? runBrowserMode;
  const resumeBrowser = deps.resumeBrowser ?? resumeBrowserSession;
  const injectedRetryCleanup = deps.retryCleanup;
  const server = http.createServer();
  const logger = options.logger ?? console.log;
  const authToken = options.token ?? randomBytes(16).toString("hex");
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
                terminateRecordedChromeForProfile: (profileDir, identity, cleanupLog) =>
                  (deps.exactChromeCleanup ?? terminateRemoteChromeWithExactControl)(
                    runtime,
                    profileDir,
                    identity,
                    cleanupLog,
                  ),
              },
            },
        mode,
      );
    },
  });

  // Remote Chrome and lease settlement are single-flight. Per-record work is additionally
  // serialized by RemoteTransactionStore.
  let browserWorkBusy = false;
  let sweepInFlight: Promise<void> | null = null;
  const runBrowserWork = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (browserWorkBusy) {
      throw new RemoteTransactionConflictError(
        409,
        "busy",
        "Remote browser authority is already in use",
      );
    }
    browserWorkBusy = true;
    try {
      return await operation();
    } finally {
      browserWorkBusy = false;
    }
  };
  const sweepExpiredAuthority = async (waitForExisting = false): Promise<void> => {
    if (sweepInFlight) {
      if (waitForExisting) await sweepInFlight;
      return;
    }
    if (browserWorkBusy) return;
    browserWorkBusy = true;
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
      browserWorkBusy = false;
    }
  };

  let reconciled: ReconcileRemoteTransactionResult[];
  try {
    reconciled = await transactionStore.reconcileStaleRunningRecords({
      buildError: buildControllerRestartError,
    });
    await sweepExpiredAuthority(true);
  } catch (error) {
    await controllerLock.release().catch(() => undefined);
    throw error;
  }
  for (const record of reconciled) {
    logger(
      `[serve] Reconciled stale running transaction ${record.transactionToken.slice(0, 12)} (${record.state}).`,
    );
  }

  if (!process.listenerCount("unhandledRejection")) {
    process.on("unhandledRejection", (reason) => {
      logger(
        `Unhandled promise rejection in remote server: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    });
  }

  server.on("request", async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/status") {
        logger("[serve] Health check /status");
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && req.url === "/health") {
        if (!authenticateRemoteRequest(req, res, authToken, logger, verbose, "/health")) return;
        sendJson(res, 200, {
          ok: true,
          version: getCliVersion(),
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          capabilities: ARTIFACT_CAPABILITIES,
        });
        return;
      }
      if (closing) {
        sendJson(res, 503, { error: "server_closing" });
        return;
      }

      const artifactReceiptMatch = matchArtifactReceiptRequest(req);
      if (artifactReceiptMatch) {
        if (
          !authenticateRemoteRequest(
            req,
            res,
            authToken,
            logger,
            verbose,
            "/transactions/.../artifacts/.../receipt",
          )
        ) {
          return;
        }
        await serveRemoteArtifactReceipt({
          req,
          res,
          artifactStore,
          transactionStore,
          transactionToken: artifactReceiptMatch.transactionToken,
          artifactId: artifactReceiptMatch.artifactId,
        });
        return;
      }

      const artifactMatch = matchArtifactRequest(req);
      if (artifactMatch) {
        await serveRemoteArtifact({
          req,
          res,
          authToken,
          artifactStore,
          transactionStore,
          logger,
          verbose,
          transactionToken: artifactMatch.transactionToken,
          artifactId: artifactMatch.artifactId,
        });
        return;
      }

      const transactionMatch = matchTransactionRequest(req);
      if (transactionMatch) {
        if (
          !authenticateRemoteRequest(
            req,
            res,
            authToken,
            logger,
            verbose,
            `/transactions/${transactionMatch.action}`,
          )
        ) {
          return;
        }
        if (transactionMatch.action === "run") {
          await sweepExpiredAuthority(true);
          if (browserWorkBusy) {
            if (verbose) {
              logger(
                `[serve] Busy: rejecting new run from ${formatSocket(req)} while another run is active`,
              );
            }
            sendJson(res, 409, { error: "busy" });
            return;
          }
          browserWorkBusy = true;
          try {
            await handleRemoteRunRequest({
              req,
              res,
              options,
              runBrowser,
              logger,
              verbose,
              transactionToken: transactionMatch.transactionToken,
              transactionStore,
              artifactStore,
              transactionCoordinator,
            });
          } finally {
            browserWorkBusy = false;
          }
          return;
        }
        if (transactionMatch.action === "retry") {
          await serveRemoteTransactionRetry({
            req,
            res,
            transactionStore,
            artifactStore,
            transactionCoordinator,
            transactionToken: transactionMatch.transactionToken,
            resumeBrowser,
            runBrowserWork,
            logger: cleanupLogger,
          });
          return;
        }
        await serveRemoteTransactionSettlement({
          req,
          res,
          transactionToken: transactionMatch.transactionToken,
          mode: transactionMatch.action,
          transactionStore,
          transactionCoordinator,
          runBrowserWork,
        });
        return;
      }

      res.statusCode = 404;
      res.end();
      return;
    } catch (error) {
      logger(`[serve] Request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error" });
      } else if (!res.destroyed) {
        res.end();
      }
    }
  });
  const listenDeferred = createDeferred<void>();
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
    const closeDeferred = createDeferred<void>();
    server.close((error) => (error ? closeDeferred.reject(error) : closeDeferred.resolve()));
    await closeDeferred.promise.catch(() => undefined);
    await controllerLock.release().catch(() => undefined);
    throw new Error("Unable to determine server address.");
  }
  const leaseSweepIntervalMs = deps.leaseSweepIntervalMs ?? 30_000;
  if (!Number.isSafeInteger(leaseSweepIntervalMs) || leaseSweepIntervalMs <= 0) {
    const closeDeferred = createDeferred<void>();
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
  logger(color(chalk.yellowBright, `Access token: ${authToken}`));
  logger("Leave this terminal running; press Ctrl+C to stop oracle serve.");

  return {
    port: address.port,
    token: authToken,
    async close() {
      if (closed) return;
      if (closing) throw new Error("Remote server close is already in progress");
      closing = true;
      try {
        await sweepInFlight;
        if (browserWorkBusy) {
          throw new Error("Remote server cannot close while browser work is active");
        }
        browserWorkBusy = true;
        try {
          for (const transactionToken of transactionCoordinator.activeTransactionTokens()) {
            const record = await transactionStore.read(transactionToken);
            if (!record) {
              throw new Error("Remote server has live browser authority without a durable record");
            }
            const mode = record.settlementMode ?? "abort";
            const outcome = await transactionCoordinator.settle({
              transactionToken,
              mode,
              durablePublication: mode === "finalize" && Boolean(record.publicationAcknowledgedAt),
            });
            if (outcome.finalization.status !== "completed") {
              throw new Error(
                `Remote server cannot close while transaction ${transactionToken} cleanup remains pending`,
              );
            }
          }
        } finally {
          browserWorkBusy = false;
        }
        if (transactionCoordinator.activeTransactionTokens().length > 0) {
          throw new Error("Remote server cannot close while live transaction authority remains");
        }
        clearInterval(leaseSweepTimer);
        const closeDeferred = createDeferred<void>();
        server.close((error) => (error ? closeDeferred.reject(error) : closeDeferred.resolve()));
        await closeDeferred.promise;
        closed = true;
        await controllerLock.release();
      } finally {
        closing = false;
      }
    },
  };
}

class RemoteRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RemoteRequestError";
  }
}

async function terminateRemoteChromeWithExactControl(
  runtime: BrowserRuntimeMetadata,
  profileDir: string,
  identity: ChromeProcessIdentity,
  logger?: ProfileStateLogger,
): Promise<RecordedChromeTerminationOutcome> {
  const resource = runtime.recoveryCleanupResources?.find(
    (candidate) =>
      candidate.chromeProcessIdentity &&
      sameChromeProcessIdentity(candidate.chromeProcessIdentity, identity),
  );
  if (!resource) {
    return {
      status: "unsafe",
      pid: identity.pid,
      reason: "Durable cleanup resource does not contain the exact Chrome process generation",
    };
  }
  let owner;
  try {
    owner = await readOracleChromeOwner(profileDir);
  } catch (error) {
    return {
      status: "unsafe",
      pid: identity.pid,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!owner || !sameChromeProcessIdentity(owner.processIdentity, identity)) {
    return {
      status: "unsafe",
      pid: identity.pid,
      reason: "Persisted Chrome owner launch nonce or process identity no longer matches",
    };
  }
  const inspection = await inspectChromeProcessIdentity(profileDir, identity).catch(
    () => "unavailable" as const,
  );
  if (inspection === "exited") return { status: "already-stopped", pid: identity.pid };
  if (inspection !== "current") {
    return {
      status: "unsafe",
      pid: identity.pid,
      reason: "Exact Chrome process generation could not be reverified before cleanup",
    };
  }

  const host = resource.chromeHost ?? "127.0.0.1";
  const port = resource.chromePort ?? owner.port;
  if (port !== owner.port) {
    return {
      status: "unsafe",
      pid: identity.pid,
      reason: "Durable Chrome control port does not match the persisted owner record",
    };
  }
  let browserWSEndpoint = resource.chromeBrowserWSEndpoint;
  if (!browserWSEndpoint) {
    const hostForUrl = host.includes(":") ? `[${host}]` : host;
    try {
      const response = await fetch(`http://${hostForUrl}:${port}/json/version`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const version = (await response.json()) as { webSocketDebuggerUrl?: unknown };
      if (typeof version.webSocketDebuggerUrl !== "string") {
        throw new Error("Chrome did not expose a browser control endpoint");
      }
      browserWSEndpoint = version.webSocketDebuggerUrl;
    } catch (error) {
      return {
        status: "unsafe",
        pid: identity.pid,
        reason: `Exact Chrome control discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  let endpoint: URL;
  try {
    endpoint = new URL(browserWSEndpoint);
  } catch {
    return {
      status: "unsafe",
      pid: identity.pid,
      reason: "Durable Chrome browser control endpoint is invalid",
    };
  }
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== host ||
    Number.parseInt(endpoint.port, 10) !== port ||
    !/^\/devtools\/browser\/[^/]+$/u.test(endpoint.pathname)
  ) {
    return {
      status: "unsafe",
      pid: identity.pid,
      reason: "Durable Chrome browser control endpoint does not match its exact host and port",
    };
  }

  let client: ChromeClient | null = null;
  try {
    client = (await CDP({ target: endpoint.toString(), local: true })) as ChromeClient;
    await client.Browser.getVersion();
    const processInfo = await client.SystemInfo.getProcessInfo();
    const exactBrowser = processInfo.processInfo.some(
      (process) => process.type === "browser" && process.id === identity.pid,
    );
    if (!exactBrowser) {
      return {
        status: "unsafe",
        pid: identity.pid,
        reason: "Chrome control channel is not bound to the persisted process generation",
      };
    }
    const beforeClose = await inspectChromeProcessIdentity(profileDir, identity).catch(
      () => "unavailable" as const,
    );
    if (beforeClose !== "current") {
      return {
        status: "unsafe",
        pid: identity.pid,
        reason: "Exact Chrome process generation changed before Browser.close",
      };
    }
    await client.Browser.close();
  } catch (error) {
    return {
      status: "unsafe",
      pid: identity.pid,
      reason: `Exact Chrome control channel failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await client?.close().catch(() => undefined);
  }

  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    const afterClose = await inspectChromeProcessIdentity(profileDir, identity).catch(
      () => "unavailable" as const,
    );
    if (afterClose === "exited") {
      logger?.(`Stopped exact Chrome process generation ${identity.pid} through Browser.close`);
      return { status: "stopped", pid: identity.pid, signal: "CONTROL_CHANNEL" };
    }
    if (afterClose === "unavailable") break;
    await delay(100);
  }
  return {
    status: "unsafe",
    pid: identity.pid,
    reason: "Exact Chrome process exit could not be proven after Browser.close",
  };
}

async function handleRemoteRunRequest(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  options: RemoteServerOptions;
  runBrowser: (options: Parameters<typeof runBrowserMode>[0]) => Promise<BrowserRunTransaction>;
  logger: (message: string) => void;
  verbose: boolean;
  transactionToken: string;
  transactionStore: RemoteTransactionStore;
  artifactStore: RemoteArtifactStore;
  transactionCoordinator: RemoteTransactionCoordinator;
}): Promise<void> {
  let payload: RemoteRunPayload;
  try {
    const body = await readRequestBody(params.req, MAX_REMOTE_REQUEST_BYTES);
    payload = validateRemoteRunPayload(JSON.parse(body));
  } catch (error) {
    const requestError =
      error instanceof RemoteRequestError
        ? error
        : new RemoteRequestError(400, "invalid_request", "Invalid remote run request");
    sendJson(params.res, requestError.statusCode, {
      error: requestError.code,
      message: requestError.message,
    });
    return;
  }
  const requestIdentity = buildRemotePromptRequestIdentity(payload);
  const effectiveBrowserConfig = buildEffectiveRemoteBrowserConfig(
    payload.browserConfig,
    params.options,
  );

  const existing = await params.transactionStore.read(params.transactionToken);
  if (existing) {
    sendJson(params.res, 409, {
      error: "transaction_exists",
      state: existing.state,
      transactionToken: params.transactionToken,
    });
    return;
  }

  const runId = randomUUID();
  const now = new Date().toISOString();
  try {
    await params.transactionStore.begin({
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      transactionToken: params.transactionToken,
      runId,
      createdAt: now,
      requestIdentity,
      browserConfig: effectiveBrowserConfig,
    });
  } catch (error) {
    if (error instanceof RemoteTransactionCapacityError) {
      sendJson(params.res, 503, {
        error: error.code,
        message: "Remote transaction storage is at capacity; no browser work was started.",
      });
      return;
    }
    throw error;
  }

  params.logger(
    `[serve] Accepted run ${runId} from ${formatSocket(params.req)} (prompt ${payload.prompt.length} chars)`,
  );
  const runStartedAt = Date.now();
  let runDir: string | null = null;
  params.res.writeHead(200, { "Content-Type": "application/x-ndjson" });

  const sendEvent = (event: RemoteRunEvent): boolean => {
    if (params.res.destroyed || params.res.writableEnded) return false;
    return params.res.write(`${JSON.stringify(event)}\n`);
  };
  const automationLogger: BrowserLogger = ((message?: string) => {
    if (typeof message === "string") sendEvent({ type: "log", message });
  }) as BrowserLogger;
  automationLogger.verbose = Boolean(payload.options.verbose);

  let capture: BrowserRunTransaction | null = null;
  let durableCapture = false;
  try {
    runDir = await mkdtemp(path.join(tmpdir(), `oracle-serve-${runId}-`));
    const attachmentDir = path.join(runDir, "attachments");
    await mkdir(attachmentDir, { recursive: true });
    const attachments = await materializeRemoteAttachments(
      payload.attachments,
      attachmentDir,
      "attachment",
    );
    let fallbackSubmission:
      | {
          prompt: string;
          attachments: BrowserAttachment[];
        }
      | undefined;
    if (payload.fallbackSubmission) {
      const fallbackDir = path.join(runDir, "fallback-attachments");
      await mkdir(fallbackDir, { recursive: true });
      fallbackSubmission = {
        prompt: payload.fallbackSubmission.prompt,
        attachments: await materializeRemoteAttachments(
          payload.fallbackSubmission.attachments,
          fallbackDir,
          "fallback-attachment",
        ),
      };
    }

    if (params.verbose && params.options.manualLoginDefault) {
      params.logger(
        `[serve] Enforcing manual-login profile at ${params.options.manualLoginProfileDir ?? "default"} for remote run ${runId}`,
      );
    }

    capture = await params.runBrowser({
      prompt: payload.prompt,
      attachments,
      fallbackSubmission,
      config: effectiveBrowserConfig,
      closeOwnedTabOnComplete: Boolean(
        params.options.manualLoginDefault && !payload.options.keepConversationTab,
      ),
      log: automationLogger,
      heartbeatIntervalMs: payload.options.heartbeatIntervalMs,
      verbose: payload.options.verbose,
      sessionId: payload.options.sessionId,
      followUpPrompts: payload.options.followUpPrompts,
      runtimeHintCb: (runtime, modelSelection) =>
        params.transactionStore
          .journalRuntime(params.transactionToken, runtime, modelSelection)
          .then(() => undefined),
    });
    assertBrowserRunTransaction(capture);
    const capturedTransaction = capture;
    const result = browserRunResultFromTransaction(capturedTransaction);
    assertCapturedPromptIdentity(requestIdentity, result, capturedTransaction.runtime);
    const fileArtifacts: SessionArtifact[] = [
      ...(result.savedFiles ?? []),
      ...(result.artifacts ?? []).filter((artifact) => artifact.kind === "file"),
    ];
    const registrations = await params.artifactStore.prepareRequiredArtifacts({
      transactionToken: params.transactionToken,
      runId,
      artifacts: fileArtifacts,
    });
    const publicResult = projectRemotePublicResult(result);
    const record = await params.transactionStore.publishCapture({
      transactionToken: params.transactionToken,
      runId,
      result: publicResult,
      runtime: capturedTransaction.runtime,
      modelSelection: result.modelSelection,
      artifacts: registrations,
    });
    durableCapture = true;
    params.transactionCoordinator.registerActive(params.transactionToken, capturedTransaction);

    if (registrations.length > 0) {
      sendEvent({
        type: "log",
        message: `[browser] ${registrations.length} required artifact(s) are ready for verified bridge transfer.`,
      });
    }
    sendEvent({ type: "transaction", transaction: remoteTransactionPayload(record) });
    params.logger(
      `[serve] Run ${runId} captured durably in ${Date.now() - runStartedAt}ms; awaiting client publication acknowledgement`,
    );
  } catch (rawError) {
    if (durableCapture) {
      params.logger(
        `[serve] Run ${runId} remains durably pending after response publication failed: ${rawError instanceof Error ? rawError.message : String(rawError)}`,
      );
      return;
    }

    const error =
      rawError instanceof BrowserAutomationError
        ? rawError
        : new BrowserAutomationError(
            rawError instanceof Error ? rawError.message : "Remote browser automation failed",
            { stage: "execute-browser" },
            rawError,
          );
    const failedCapture = capture;
    const errorRuntime = browserRuntimeFromError(error);
    const journaled = await params.transactionStore.read(params.transactionToken);
    const recoverableRuntime = failedCapture?.runtime ?? errorRuntime ?? journaled?.runtime;
    const durableError = serializeDurableBrowserAutomationError(error, Boolean(recoverableRuntime));
    let record = await params.transactionStore.recordRecoverableFailure({
      transactionToken: params.transactionToken,
      runtime: recoverableRuntime,
      error: durableError,
    });
    const cleanupRequired =
      Boolean(failedCapture) ||
      (Boolean(recoverableRuntime) && error.details?.recoverableDisconnect !== true);
    if (cleanupRequired && recoverableRuntime) {
      if (failedCapture) {
        params.transactionCoordinator.registerActive(params.transactionToken, failedCapture);
      }
      record = (
        await params.transactionCoordinator.settle({
          transactionToken: params.transactionToken,
          mode: "abort",
          durablePublication: false,
        })
      ).record;
    }
    sendEvent({ type: "error", error: remoteBrowserAutomationError(record) });
    params.logger(
      `[serve] Run ${runId} failed after ${Date.now() - runStartedAt}ms: ${error.message}`,
    );
  } finally {
    if (runDir) await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    if (!params.res.destroyed && !params.res.writableEnded) params.res.end();
  }
}

function authenticateRemoteRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authToken: string,
  logger: (message: string) => void,
  verbose: boolean,
  endpoint: string,
): boolean {
  if ((req.headers.authorization ?? "") === `Bearer ${authToken}`) return true;
  if (verbose) {
    logger(
      `[serve] Unauthorized ${endpoint} attempt from ${formatSocket(req)} (missing/invalid token)`,
    );
  }
  sendJson(res, 401, { error: "unauthorized" });
  return false;
}

function sendJson(res: http.ServerResponse, statusCode: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(statusCode, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function matchTransactionRequest(
  req: http.IncomingMessage,
): { transactionToken: string; action: "run" | "finalize" | "abort" | "retry" } | null {
  if (req.method !== "POST" || !req.url) return null;
  let pathname: string;
  try {
    pathname = new URL(req.url, "http://oracle.local").pathname;
  } catch {
    return null;
  }
  const match = /^\/transactions\/([^/]+)\/(run|finalize|abort|retry)$/.exec(pathname);
  if (!match) return null;
  let transactionToken: string;
  try {
    transactionToken = decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
  if (!REMOTE_TRANSACTION_TOKEN_PATTERN.test(transactionToken)) return null;
  return {
    transactionToken,
    action: match[2] as "run" | "finalize" | "abort" | "retry",
  };
}

function matchArtifactReceiptRequest(
  req: http.IncomingMessage,
): { transactionToken: string; artifactId: string } | null {
  if (req.method !== "POST" || !req.url) return null;
  let pathname: string;
  try {
    pathname = new URL(req.url, "http://oracle.local").pathname;
  } catch {
    return null;
  }
  const match = /^\/transactions\/([^/]+)\/artifacts\/([^/]+)\/receipt$/.exec(pathname);
  if (!match) return null;
  try {
    const transactionToken = decodeURIComponent(match[1] ?? "");
    const artifactId = decodeURIComponent(match[2] ?? "");
    if (
      !REMOTE_TRANSACTION_TOKEN_PATTERN.test(transactionToken) ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(artifactId)
    ) {
      return null;
    }
    return { transactionToken, artifactId };
  } catch {
    return null;
  }
}

async function serveRemoteTransactionRetry(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  transactionStore: RemoteTransactionStore;
  artifactStore: RemoteArtifactStore;
  transactionCoordinator: RemoteTransactionCoordinator;
  transactionToken: string;
  resumeBrowser: typeof resumeBrowserSession;
  runBrowserWork: <T>(operation: () => Promise<T>) => Promise<T>;
  logger: BrowserLogger;
}): Promise<void> {
  const renewed = await renewAuthenticatedTransactionLease(
    params.transactionStore,
    params.transactionToken,
  );
  if (renewed === "expired") {
    sendJson(params.res, 409, { error: "transaction_lease_expired" });
    return;
  }
  if (!renewed) {
    sendJson(params.res, 404, { error: "transaction_not_found" });
    return;
  }
  try {
    const raw = await readRequestBody(params.req, 4096);
    RemoteRetryRequestSchema.parse(raw ? JSON.parse(raw) : {});
  } catch {
    sendJson(params.res, 400, { error: "invalid_retry_request" });
    return;
  }

  try {
    const record = renewed;
    if (record.state === "running") {
      sendJson(params.res, 202, { status: "running" });
      return;
    }
    if (record.state === "finalized" || record.state === "aborted") {
      sendJson(params.res, 409, {
        error: "transaction_already_settled",
        state: record.state,
        transactionToken: record.transactionToken,
      });
      return;
    }
    if (record.result) {
      const response: RemoteTransactionRetryResponse = {
        status: "transaction",
        transaction: remoteTransactionPayload(record),
      };
      sendJson(params.res, 200, response);
      return;
    }
    if (record.state !== "recoverable-error" || !record.runtime || record.settlementMode) {
      const response: RemoteTransactionRetryResponse = {
        status: "error",
        error: remoteBrowserAutomationError(record),
      };
      sendJson(params.res, 200, response);
      return;
    }

    const recoveryRuntime = record.runtime;
    const outcome = await params.runBrowserWork(async () => {
      const recoveryStartedAt = Date.now();
      let recovered: ReattachResult;
      try {
        recovered = await params.resumeBrowser(
          recoveryRuntime,
          record.browserConfig,
          params.logger,
        );
      } catch (rawError) {
        const error =
          rawError instanceof BrowserAutomationError
            ? rawError
            : new BrowserAutomationError(
                rawError instanceof Error ? rawError.message : "Remote browser recovery failed",
                { stage: "remote-answer-recovery" },
                rawError,
              );
        const failed = await params.transactionStore.recordRecoverableFailure({
          transactionToken: record.transactionToken,
          runtime: browserRuntimeFromError(error) ?? recoveryRuntime,
          error: serializeDurableBrowserAutomationError(error, true),
        });
        const response: RemoteTransactionRetryResponse = {
          status: "error",
          error: remoteBrowserAutomationError(failed),
        };
        return { statusCode: 200, body: response };
      }

      const capture = browserTransactionFromRecoveredSession(
        recovered,
        Date.now() - recoveryStartedAt,
      );
      const result = browserRunResultFromTransaction(capture);
      try {
        assertCapturedPromptIdentity(record.requestIdentity, result, capture.runtime);
        const fileArtifacts: SessionArtifact[] = [
          ...(result.savedFiles ?? []),
          ...(result.artifacts ?? []).filter((artifact) => artifact.kind === "file"),
        ];
        const registrations = await params.artifactStore.prepareRequiredArtifacts({
          transactionToken: record.transactionToken,
          runId: record.runId,
          artifacts: fileArtifacts,
        });
        const published = await params.transactionStore.publishCapture({
          transactionToken: record.transactionToken,
          runId: record.runId,
          result: projectRemotePublicResult(result),
          runtime: capture.runtime,
          modelSelection: result.modelSelection,
          artifacts: registrations,
        });
        params.transactionCoordinator.registerActive(record.transactionToken, capture);
        const response: RemoteTransactionRetryResponse = {
          status: "transaction",
          transaction: remoteTransactionPayload(published),
        };
        return { statusCode: 200, body: response };
      } catch (rawError) {
        const error =
          rawError instanceof BrowserAutomationError
            ? rawError
            : new BrowserAutomationError(
                rawError instanceof Error
                  ? rawError.message
                  : "Recovered remote capture could not be durably published.",
                {
                  stage: "remote-answer-publication",
                  code: "remote-answer-publication-failed",
                },
                rawError,
              );
        await params.transactionStore.recordRecoverableFailure({
          transactionToken: record.transactionToken,
          runtime: capture.runtime,
          error: serializeDurableBrowserAutomationError(error, true),
        });
        params.transactionCoordinator.registerActive(record.transactionToken, capture);
        const failed = (
          await params.transactionCoordinator.settle({
            transactionToken: record.transactionToken,
            mode: "abort",
            durablePublication: false,
          })
        ).record;
        const response: RemoteTransactionRetryResponse = {
          status: "error",
          error: remoteBrowserAutomationError(failed),
        };
        return { statusCode: 200, body: response };
      }
    });
    sendJson(params.res, outcome.statusCode, outcome.body);
  } catch (error) {
    if (error instanceof RemoteTransactionConflictError) {
      sendJson(params.res, error.statusCode, { error: error.code, message: error.message });
      return;
    }
    throw error;
  }
}

async function serveRemoteTransactionSettlement(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  transactionToken: string;
  mode: "finalize" | "abort";
  transactionStore: RemoteTransactionStore;
  transactionCoordinator: RemoteTransactionCoordinator;
  runBrowserWork: <T>(operation: () => Promise<T>) => Promise<T>;
}): Promise<void> {
  const renewed = await renewAuthenticatedTransactionLease(
    params.transactionStore,
    params.transactionToken,
  );
  if (renewed === "expired") {
    sendJson(params.res, 409, { error: "transaction_lease_expired" });
    return;
  }
  if (!renewed) {
    sendJson(params.res, 404, { error: "transaction_not_found" });
    return;
  }
  let durablePublication = false;
  try {
    const raw = await readRequestBody(params.req, 4096);
    const value = raw ? JSON.parse(raw) : {};
    if (params.mode === "finalize") {
      durablePublication = RemoteFinalizeRequestSchema.parse(value).durablePublication;
    } else {
      RemoteAbortRequestSchema.parse(value);
    }
  } catch {
    sendJson(params.res, 400, { error: "invalid_settlement_request" });
    return;
  }

  try {
    const settle = () =>
      params.transactionCoordinator.settle({
        transactionToken: params.transactionToken,
        mode: params.mode,
        durablePublication,
      });
    const outcome =
      renewed.state === "finalized" || renewed.state === "aborted" || renewed.state === "failed"
        ? await settle()
        : await params.runBrowserWork(settle);
    sendJson(params.res, 200, settlementResponse(outcome.record, outcome.finalization));
  } catch (error) {
    if (error instanceof RemoteTransactionConflictError) {
      sendJson(params.res, error.statusCode, { error: error.code, message: error.message });
      return;
    }
    if (error instanceof Error && error.message.includes("does not exist")) {
      sendJson(params.res, 404, { error: "transaction_not_found" });
      return;
    }
    throw error;
  }
}

function browserTransactionFromRecoveredSession(
  recovered: ReattachResult,
  tookMs: number,
): BrowserRunTransaction {
  const extended = recovered as ReattachResult & Partial<BrowserRunResult>;
  return {
    ...extended,
    answerText: recovered.answerText,
    answerMarkdown: recovered.answerMarkdown,
    tookMs:
      typeof extended.tookMs === "number" && Number.isFinite(extended.tookMs)
        ? extended.tookMs
        : Math.max(0, tookMs),
    answerTokens:
      typeof extended.answerTokens === "number" && Number.isSafeInteger(extended.answerTokens)
        ? extended.answerTokens
        : estimateTokenCount(recovered.answerMarkdown || recovered.answerText),
    answerChars: recovered.answerText.length,
    conversationId: recovered.runtime.conversationId,
    runtime: recovered.runtime,
    finalize: recovered.finalize,
    abort: recovered.abort,
  };
}

async function renewAuthenticatedTransactionLease(
  transactionStore: RemoteTransactionStore,
  transactionToken: string,
): Promise<RemoteTransactionRecord | "expired" | null> {
  try {
    return await transactionStore.renewLease(transactionToken);
  } catch (error) {
    const latest = await transactionStore.read(transactionToken);
    if (!latest) return null;
    if (latest.state === "finalized" || latest.state === "aborted" || latest.state === "failed") {
      return latest;
    }
    if (error instanceof Error && error.message.includes("expired remote transaction lease")) {
      return "expired";
    }
    throw error;
  }
}

async function sweepExpiredRemoteTransactions(params: {
  transactionStore: RemoteTransactionStore;
  transactionCoordinator: RemoteTransactionCoordinator;
  logger: (message: string) => void;
}): Promise<void> {
  for (const candidate of await params.transactionStore.listExpiredNonterminalRecords()) {
    const settlement = await params.transactionStore.expire({
      transactionToken: candidate.transactionToken,
      expectedLeaseExpiresAt: candidate.leaseExpiresAt,
      buildError: buildExpiredLeaseError,
    });
    if (!settlement) continue;
    try {
      const outcome = await params.transactionCoordinator.settle({
        transactionToken: candidate.transactionToken,
        mode: settlement.mode,
        durablePublication: settlement.durablePublication,
      });
      params.logger(
        `[serve] Expired transaction ${candidate.transactionToken.slice(0, 12)} settled as ${outcome.record.state}.`,
      );
    } catch (error) {
      params.logger(
        `[serve] Expired transaction ${candidate.transactionToken.slice(0, 12)} remains pending: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function buildExpiredLeaseError(
  record: RemoteTransactionRecord,
  hadRuntimeAuthority: boolean,
): DurableRemoteAutomationError {
  return {
    name: "BrowserAutomationError",
    category: "browser-automation",
    message: hadRuntimeAuthority
      ? `Remote transaction lease expired while run ${record.runId} still owned browser authority.`
      : `Remote transaction lease expired before run ${record.runId} journaled browser authority.`,
    code: hadRuntimeAuthority ? "remote-transaction-lease-expired" : "remote-lease-pre-authority",
    stage: "remote-transaction-lease",
    recoverableDisconnect: hadRuntimeAuthority,
  };
}

function settlementResponse(
  record: RemoteTransactionRecord,
  finalization: BrowserCaptureFinalizationResult,
): RemoteTransactionSettlementResponse {
  const cleanupStatus = finalization.status === "completed" ? "completed" : "pending";
  const response = {
    transactionToken: record.transactionToken,
    state: record.state,
    finalization: {
      status: finalization.status,
      runtime: projectRemotePublicRuntime(finalization.runtime, cleanupStatus),
      ...(finalization.status === "pending" ? { error: finalization.error } : {}),
    },
  };
  return RemoteTransactionSettlementResponseSchema.parse(response);
}

function remoteTransactionPayload(record: RemoteTransactionRecord): RemoteRunTransactionPayload {
  if (
    !record.result ||
    !record.runtime ||
    (record.state !== "pending" && record.state !== "finalized" && record.state !== "aborted")
  ) {
    throw new Error("Remote transaction record is not publishable");
  }
  const cleanupStatus = record.state === "pending" ? "pending" : "completed";
  return RemoteRunTransactionPayloadSchema.parse({
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    transactionToken: record.transactionToken,
    runId: record.runId,
    result: record.result,
    runtime: projectRemotePublicRuntime(record.runtime, cleanupStatus, true),
    artifacts: (record.artifacts ?? []).map((artifact) => artifact.descriptor),
    state: record.state,
  });
}

function validateRemoteRunPayload(value: unknown): RemoteRunPayload {
  const parsed = RemoteRunPayloadSchema.safeParse(value);
  if (parsed.success) return parsed.data as RemoteRunPayload;
  const issue = parsed.error.issues[0];
  const authorityIssue = parsed.error.issues.find(
    (candidate) => candidate.code === "unrecognized_keys",
  );
  if (authorityIssue) {
    const keys = "keys" in authorityIssue ? authorityIssue.keys.join(", ") : "unknown";
    throw new RemoteRequestError(
      400,
      "authority_fields_rejected",
      `Remote request contains unsupported or authority-bearing field(s): ${keys}`,
    );
  }
  const message = issue?.message ?? "Invalid remote run request";
  const statusCode = /exceed|too big|maximum/i.test(message) ? 413 : 400;
  throw new RemoteRequestError(statusCode, "invalid_request", message);
}

function buildEffectiveRemoteBrowserConfig(
  config: RemoteBrowserRunConfig,
  options: RemoteServerOptions,
): BrowserSessionConfig {
  const chatgptUrl = normalizeChatgptUrl(config.chatgptUrl ?? CHATGPT_URL, CHATGPT_URL);
  return {
    ...config,
    chatgptUrl,
    url: chatgptUrl,
    chromeProfile: null,
    chromePath: null,
    chromeCookiePath: null,
    attachRunning: false,
    browserTabRef: null,
    debugPort: null,
    cookieSync: true,
    inlineCookies: null,
    inlineCookiesSource: null,
    remoteChrome: null,
    copyProfileSource: null,
    manualLogin: Boolean(options.manualLoginDefault),
    manualLoginProfileDir: options.manualLoginDefault ? options.manualLoginProfileDir : null,
    manualLoginCookieSync: false,
    keepBrowser: Boolean(options.manualLoginDefault),
  };
}

async function materializeRemoteAttachments(
  attachments: RemoteRunPayload["attachments"],
  directory: string,
  fallbackName: string,
): Promise<BrowserAttachment[]> {
  const materialized: BrowserAttachment[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const safeName = sanitizeName(attachment.fileName || `${fallbackName}-${index + 1}`);
    const filePath = path.join(directory, `${index + 1}-${safeName}`);
    const payload = Buffer.from(attachment.contentBase64, "base64");
    await writeFile(filePath, payload, { mode: 0o600 });
    materialized.push({
      path: filePath,
      displayPath: attachment.displayPath,
      sizeBytes: payload.byteLength,
    });
  }
  return materialized;
}

function assertBrowserRunTransaction(value: unknown): asserts value is BrowserRunTransaction {
  if (
    typeof value !== "object" ||
    value === null ||
    !("runtime" in value) ||
    typeof value.runtime !== "object" ||
    value.runtime === null ||
    !("finalize" in value) ||
    typeof value.finalize !== "function" ||
    !("abort" in value) ||
    typeof value.abort !== "function"
  ) {
    throw new BrowserAutomationError(
      "Remote browser host returned a legacy bare result instead of a capture transaction.",
      { stage: "remote-transaction-protocol", code: "legacy-result-rejected" },
    );
  }
}

function browserRunResultFromTransaction(transaction: BrowserRunTransaction): BrowserRunResult {
  const { runtime: _runtime, finalize: _finalize, abort: _abort, ...result } = transaction;
  return result;
}
function assertCapturedPromptIdentity(
  requestIdentity: BrowserRemotePromptRequestIdentity,
  result: BrowserRunResult,
  runtime: BrowserRuntimeMetadata,
): void {
  const epoch = runtime.promptEpoch;
  const conversationId = result.conversationId?.trim();
  if (
    epoch?.status !== "committed" ||
    !requestIdentity.acceptedPromptSha256.includes(epoch.promptSha256) ||
    epoch.followUpOrdinal !== requestIdentity.followUpOrdinal ||
    epoch.remainingFollowUps !== requestIdentity.remainingFollowUps ||
    !conversationId ||
    conversationId !== epoch.conversationId ||
    runtime.conversationId !== epoch.conversationId
  ) {
    throw new BrowserAutomationError(
      "Remote capture does not match the exact committed prompt and conversation identity.",
      {
        stage: "remote-prompt-authority",
        code: "remote-prompt-authority-mismatch",
      },
    );
  }
}

function browserRuntimeFromError(
  error: BrowserAutomationError,
): BrowserRuntimeMetadata | undefined {
  const candidate = error.details?.runtime;
  return typeof candidate === "object" && candidate !== null
    ? (candidate as BrowserRuntimeMetadata)
    : undefined;
}

function serializeDurableBrowserAutomationError(
  error: BrowserAutomationError,
  recoverableDisconnect: boolean,
): DurableRemoteAutomationError {
  const code = typeof error.details?.code === "string" ? error.details.code : undefined;
  const stage = typeof error.details?.stage === "string" ? error.details.stage : undefined;
  return {
    name: "BrowserAutomationError",
    category: "browser-automation",
    message: error.message,
    code,
    stage,
    recoverableDisconnect,
  };
}

function buildControllerRestartError(
  record: RemoteTransactionRecord,
  hadRuntimeAuthority: boolean,
): DurableRemoteAutomationError {
  return {
    name: "BrowserAutomationError",
    category: "browser-automation",
    message: hadRuntimeAuthority
      ? `Remote controller restarted while run ${record.runId} still owned recoverable browser authority.`
      : `Remote controller restarted before run ${record.runId} acquired browser authority.`,
    code: hadRuntimeAuthority ? "remote-controller-restarted" : "remote-controller-pre-authority",
    stage: "remote-controller-restart",
    recoverableDisconnect: hadRuntimeAuthority,
  };
}

function projectRemotePublicRuntime(
  runtime: BrowserRuntimeMetadata,
  cleanupStatus: "pending" | "completed",
  requireCommittedPrompt = false,
): RemotePublicRuntime {
  const promptEpoch = runtime.promptEpoch?.status === "committed" ? runtime.promptEpoch : undefined;
  if (requireCommittedPrompt && !promptEpoch) {
    throw new Error("Captured remote transaction lacks a committed prompt epoch");
  }
  return cleanupStatus === "pending"
    ? { promptEpoch, cleanup: { status: "pending" } }
    : { promptEpoch, cleanup: { status: "completed" } };
}

function projectRemoteBrowserAutomationError(
  error: DurableRemoteAutomationError,
  runtime: BrowserRuntimeMetadata | undefined,
  transactionToken: string,
  settlementMode?: "finalize" | "abort",
): RemoteBrowserAutomationErrorPayload {
  if (error.recoverableDisconnect && runtime) {
    return RemoteBrowserAutomationErrorSchema.parse({
      name: error.name,
      category: error.category,
      message: "Remote browser automation disconnected with recoverable authority.",
      code: publicProtocolLabel(error.code),
      stage: publicProtocolLabel(error.stage),
      recoverableDisconnect: true,
      recoveryToken: transactionToken,
      settlementMode,
      runtime: projectRemotePublicRuntime(runtime, "pending"),
    });
  }
  return RemoteBrowserAutomationErrorSchema.parse({
    name: error.name,
    category: error.category,
    message: "Remote browser automation failed.",
    code: publicProtocolLabel(error.code),
    stage: publicProtocolLabel(error.stage),
    recoverableDisconnect: false,
  });
}

function publicProtocolLabel(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9_-]{1,128}$/u.test(value) ? value : undefined;
}

function remoteBrowserAutomationError(
  record: RemoteTransactionRecord,
): RemoteBrowserAutomationErrorPayload {
  if (record.error) {
    return projectRemoteBrowserAutomationError(
      record.error,
      record.runtime,
      record.transactionToken,
      record.settlementMode,
    );
  }
  if (
    record.terminalAudit &&
    (record.state === "failed" ||
      (record.state === "aborted" &&
        Boolean(record.terminalAudit.errorCode || record.terminalAudit.errorStage)))
  ) {
    return RemoteBrowserAutomationErrorSchema.parse({
      name: "BrowserAutomationError",
      category: "browser-automation",
      message: "Remote browser automation failed and cleanup is complete.",
      code: record.terminalAudit.errorCode,
      stage: record.terminalAudit.errorStage,
      recoverableDisconnect: false,
    });
  }
  throw new Error("Remote error transaction is missing error metadata");
}

export async function serveRemote(options: RemoteServerOptions = {}): Promise<void> {
  const manualProfileDir =
    options.manualLoginProfileDir ?? path.join(homedir(), ".oracle", "browser-profile");
  const preferManualLogin = options.manualLoginDefault || process.platform === "win32" || isWsl();
  let cookies: CookieParam[] | null = null;
  let opened = false;

  if (isWsl() && process.env.ORACLE_ALLOW_WSL_SERVE !== "1") {
    console.log(
      "WSL detected. For reliable browser automation, run `oracle serve` from Windows PowerShell/Command Prompt so we can use your Windows Chrome profile.",
    );
    console.log(
      "If you want to stay in WSL anyway, set ORACLE_ALLOW_WSL_SERVE=1 and ensure a Linux Chrome is installed, then rerun.",
    );
    console.log(
      "Alternatively, start Windows Chrome with --remote-debugging-port=9222 and use `--remote-chrome <windows-ip>:9222`.",
    );
    return;
  }

  if (!preferManualLogin) {
    // Warm-up: ensure this host has a ChatGPT login before accepting runs.
    const result = await loadLocalChatgptCookies(console.log, CHATGPT_URL);
    cookies = result.cookies;
    opened = result.opened;
  }

  if (!cookies || cookies.length === 0) {
    console.log("No ChatGPT cookies detected on this host.");
    if (preferManualLogin) {
      await mkdir(manualProfileDir, { recursive: true });
      console.log(
        `Cookie extraction is unavailable on this platform. Using manual-login Chrome profile at ${manualProfileDir}. Remote runs will reuse this profile; sign in once when the browser opens.`,
      );
      const bootstrapLogger = ((message?: string) => {
        if (typeof message === "string") console.log(message);
      }) as BrowserLogger;
      const owner = await acquireManualChromeOwner(
        manualProfileDir,
        resolveBrowserConfig({
          manualLogin: true,
          manualLoginProfileDir: manualProfileDir,
          manualLoginCookieSync: false,
          cookieSync: false,
          keepBrowser: true,
          url: CHATGPT_URL,
        }),
        bootstrapLogger,
        "remote-serve-bootstrap",
      );
      console.log(
        `${owner.source === "launched" ? "Launched" : "Reusing"} canonical manual-login Chrome owner on DevTools port ${owner.chrome.port} (pid ${owner.processIdentity.pid}).`,
      );
    } else if (opened) {
      console.log(
        "Opened chatgpt.com for login. Sign in, then restart `oracle serve` to continue.",
      );
      return;
    } else {
      console.log(
        "Please open https://chatgpt.com/ in this host's browser and sign in; then rerun.",
      );
      console.log(
        "Tip: install xdg-utils (xdg-open) to enable automatic browser opening on Linux/WSL.",
      );
      return;
    }
  } else {
    console.log(
      `Detected ${cookies.length} ChatGPT cookies on this host; runs will reuse this session.`,
    );
  }

  const server = await createRemoteServer({
    ...options,
    manualLoginDefault: preferManualLogin,
    manualLoginProfileDir: manualProfileDir,
  });
  const shutdownDeferred = createDeferred<void>();
  const shutdown = () => {
    console.log("Shutting down remote service...");
    server
      .close()
      .catch((error) => console.error("Failed to close remote server:", error))
      .finally(() => shutdownDeferred.resolve());
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await shutdownDeferred.promise;
}

function matchArtifactRequest(
  req: http.IncomingMessage,
): { transactionToken: string; artifactId: string } | null {
  if (req.method !== "GET" || !req.url) return null;
  let pathname: string;
  try {
    pathname = new URL(req.url, "http://oracle.local").pathname;
  } catch {
    return null;
  }
  const match = /^\/transactions\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    const transactionToken = decodeURIComponent(match[1] ?? "");
    const artifactId = decodeURIComponent(match[2] ?? "");
    if (
      !REMOTE_TRANSACTION_TOKEN_PATTERN.test(transactionToken) ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(artifactId)
    ) {
      return null;
    }
    return { transactionToken, artifactId };
  } catch {
    return null;
  }
}

async function serveRemoteArtifact(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  authToken: string;
  artifactStore: RemoteArtifactStore;
  transactionStore: RemoteTransactionStore;
  logger: (message: string) => void;
  verbose: boolean;
  transactionToken: string;
  artifactId: string;
}): Promise<void> {
  if (
    !authenticateRemoteRequest(
      params.req,
      params.res,
      params.authToken,
      params.logger,
      params.verbose,
      "/transactions/.../artifacts/...",
    )
  ) {
    return;
  }
  const renewed = await renewAuthenticatedTransactionLease(
    params.transactionStore,
    params.transactionToken,
  );
  if (renewed === "expired") {
    sendJson(params.res, 409, { error: "transaction_lease_expired" });
    return;
  }
  if (!renewed) {
    sendJson(params.res, 404, { error: "transaction_not_found" });
    return;
  }

  let opened;
  try {
    opened = await params.artifactStore.openForDelivery(params.transactionToken, params.artifactId);
  } catch (error) {
    if (error instanceof RemoteArtifactUnavailableError) {
      sendJson(params.res, 410, { error: error.code });
      return;
    }
    throw error;
  }
  if (!opened) {
    sendJson(params.res, 404, { error: "artifact_not_found" });
    return;
  }

  const { handle, registration } = opened;
  try {
    const fileStat = await handle.stat();
    const descriptor = registration.descriptor;
    const filename = sanitizeArtifactFilename(descriptor.filename, "artifact.bin");
    params.res.writeHead(200, {
      "Content-Type": sanitizeArtifactMimeType(descriptor.mimeType) ?? "application/octet-stream",
      "Content-Length": fileStat.size,
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Oracle-Artifact-Id": descriptor.artifactId,
      "X-Oracle-Artifact-Sha256": descriptor.sha256,
    });
    await pipeline(handle.createReadStream({ start: 0, autoClose: false }), params.res).catch(
      (error) => {
        params.logger(
          `[serve] Artifact transfer failed for ${descriptor.artifactId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function serveRemoteArtifactReceipt(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  artifactStore: RemoteArtifactStore;
  transactionStore: RemoteTransactionStore;
  transactionToken: string;
  artifactId: string;
}): Promise<void> {
  const renewed = await renewAuthenticatedTransactionLease(
    params.transactionStore,
    params.transactionToken,
  );
  if (renewed === "expired") {
    sendJson(params.res, 409, { error: "transaction_lease_expired" });
    return;
  }
  if (!renewed) {
    sendJson(params.res, 404, { error: "transaction_not_found" });
    return;
  }

  let body: RemoteArtifactDeliveryReceiptRequest;
  try {
    const raw = await readRequestBody(params.req, 4096);
    body = RemoteArtifactDeliveryReceiptRequestSchema.parse(raw ? JSON.parse(raw) : {});
  } catch {
    sendJson(params.res, 400, { error: "invalid_artifact_delivery_receipt" });
    return;
  }
  try {
    const receipt = await params.artifactStore.recordDeliveryReceipt({
      transactionToken: params.transactionToken,
      artifactId: params.artifactId,
      sha256: body.sha256,
      byteSize: body.byteSize,
    });
    sendJson(params.res, 200, {
      ok: true,
      artifactId: params.artifactId,
      deliveredAt: receipt.deliveredAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = message.includes("does not exist");
    sendJson(params.res, missing ? 404 : 409, {
      error: missing ? "artifact_not_found" : "artifact_delivery_receipt_conflict",
      message,
    });
  }
}

async function readRequestBody(req: http.IncomingMessage, maximumBytes: number): Promise<string> {
  const contentLengthHeader = req.headers["content-length"];
  const contentLength =
    typeof contentLengthHeader === "string" ? Number(contentLengthHeader) : undefined;
  if (
    contentLength !== undefined &&
    (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maximumBytes)
  ) {
    throw new RemoteRequestError(
      413,
      "request_too_large",
      "Remote request body exceeds size limit",
    );
  }
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    receivedBytes += buffer.byteLength;
    if (receivedBytes > maximumBytes) {
      throw new RemoteRequestError(
        413,
        "request_too_large",
        "Remote request body exceeds size limit",
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, receivedBytes).toString("utf8");
}

function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function projectRemotePublicResult(result: BrowserRunResult): RemotePublicRunResult {
  return RemotePublicRunResultSchema.parse({
    answerText: result.answerText,
    answerMarkdown: result.answerMarkdown,
    answerHtml: result.answerHtml,
    archive: result.archive
      ? {
          mode: result.archive.mode,
          attempted: result.archive.attempted,
          archived: result.archive.archived,
          conversationUrl: result.archive.conversationUrl,
        }
      : undefined,
    modelSelection: result.modelSelection,
    warnings: result.warnings?.map((warning) => ({
      code: publicProtocolLabel(warning.code) ?? "remote-host-warning",
      severity: warning.severity,
      message: "Remote browser host reported a warning.",
    })),
    tookMs: result.tookMs,
    answerTokens: result.answerTokens,
    answerChars: result.answerText.length,
  });
}

function formatSocket(req: http.IncomingMessage): string {
  const socket = req.socket;
  const host = socket.remoteAddress ?? "unknown";
  const port = socket.remotePort ?? "0";
  return `${host}:${port}`;
}

async function loadLocalChatgptCookies(
  logger: (message: string) => void,
  targetUrl: string,
): Promise<{ cookies: CookieParam[] | null; opened: boolean }> {
  try {
    logger("Loading ChatGPT cookies from this host's Chrome profile...");
    const { cookies: rawCookies, warnings } = await getCookies({
      url: targetUrl,
      browsers: ["chrome"],
      mode: "merge",
      chromeProfile: "Default",
      timeoutMs: 5_000,
    });
    if (warnings.length) {
      logger(`Cookie warnings:\n- ${warnings.join("\n- ")}`);
    }
    const cookies = rawCookies.map(toCdpCookie).filter((c): c is CookieParam => Boolean(c));
    if (!cookies || cookies.length === 0) {
      logger("No local ChatGPT cookies found on this host. Please log in once; opening ChatGPT...");
      const opened = triggerLocalLoginPrompt(logger, targetUrl);
      return { cookies: null, opened };
    }
    logger(`Loaded ${cookies.length} local ChatGPT cookies on this host.`);
    return { cookies, opened: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingDbMatch = message.match(/Unable to locate Chrome cookie DB at (.+?)(?:\.|$)/);
    if (missingDbMatch) {
      const lookedPath = missingDbMatch[1];
      logger(
        `Chrome cookies not found at ${lookedPath}. Set --browser-cookie-path to your Chrome profile or log in manually.`,
      );
    } else {
      logger(`Unable to load local ChatGPT cookies on this host: ${message}`);
    }
    if (process.platform === "linux" && isWsl()) {
      logger(
        "WSL hint: Chrome lives under /mnt/c/Users/<you>/AppData/Local/Google/Chrome/User Data/Default; pass --browser-cookie-path to that directory if auto-detect fails.",
      );
    }
    const opened = triggerLocalLoginPrompt(logger, targetUrl);
    return { cookies: null, opened };
  }
}

function toCdpCookie(cookie: Cookie): CookieParam | null {
  if (!cookie?.name) return null;
  const out: CookieParam = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path ?? "/",
    secure: cookie.secure ?? true,
    httpOnly: cookie.httpOnly ?? false,
  };
  if (typeof cookie.expires === "number") out.expires = cookie.expires;
  if (cookie.sameSite === "Lax" || cookie.sameSite === "Strict" || cookie.sameSite === "None") {
    out.sameSite = cookie.sameSite;
  }
  return out;
}

function triggerLocalLoginPrompt(logger: (message: string) => void, url: string): boolean {
  const verbose = process.argv.includes("--verbose") || process.env.ORACLE_SERVE_VERBOSE === "1";
  const openers: Array<{ cmd: string; args?: string[] }> = [];

  if (process.platform === "darwin") {
    openers.push({ cmd: "open" });
  } else if (process.platform === "win32") {
    openers.push({ cmd: "start" });
  } else {
    if (isWsl()) {
      // Prefer wslview when available, then fall back to Windows start.exe to open in the host browser.
      openers.push({ cmd: "wslview" });
      openers.push({ cmd: "cmd.exe", args: ["/c", "start", "", url] });
    }
    openers.push({ cmd: "xdg-open" });
  }

  // Add a cross-platform, low-friction fallback when nothing above is available.
  openers.push({ cmd: "sensible-browser" });

  try {
    // Fire and forget; user completes login in the opened browser window.
    if (verbose) {
      logger(`[serve] Login opener candidates: ${openers.map((o) => o.cmd).join(", ")}`);
    }
    const candidate = openers.find((opener) => canSpawn(opener.cmd));
    if (candidate) {
      const child = spawn(candidate.cmd, candidate.args ?? [url], {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      child.once("error", (error) => {
        if (verbose) {
          logger(
            `[serve] Opener ${candidate.cmd} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        logger(`Please open ${url} in this host's browser and sign in; then rerun.`);
      });
      logger(
        `Opened ${url} locally via ${candidate.cmd}. Please sign in; subsequent runs will reuse the session.`,
      );
      if (verbose && candidate.args) {
        logger(`[serve] Opener args: ${candidate.args.join(" ")}`);
      }
      return true;
    }
    if (verbose) {
      logger("[serve] No available opener found; prompting manual login.");
    }
    return false;
  } catch {
    return false;
  }
}

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  return Boolean(process.env.WSL_DISTRO_NAME || release().toLowerCase().includes("microsoft"));
}

function canSpawn(cmd: string): boolean {
  if (!cmd) return false;
  try {
    if (process.platform === "win32") {
      // `where` returns non-zero when the command is not found.
      const result = spawnSync("where", [cmd], { stdio: "ignore" });
      return result.status === 0;
    }
    // `command -v` is a shell builtin; run through sh. Fallback to `which`.
    const shResult = spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    if (shResult.status === 0) return true;
    const whichResult = spawnSync("which", [cmd], { stdio: "ignore" });
    return whichResult.status === 0;
  } catch {
    return false;
  }
}
