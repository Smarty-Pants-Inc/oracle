import http from "node:http";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtemp,
  rm,
  mkdir,
  chmod,
  writeFile,
  stat,
  realpath,
  open,
  readFile,
  rename,
  type FileHandle,
} from "node:fs/promises";
import chalk from "chalk";
import { z } from "zod";
import type {
  BrowserAttachment,
  BrowserCaptureFinalizationResult,
  BrowserLogger,
  CookieParam,
} from "../browser/types.js";
import { runBrowserMode } from "../browserMode.js";
import type { BrowserRunResult, BrowserRunTransaction } from "../browserMode.js";
import type {
  RemoteArtifactCapabilities,
  RemoteArtifactDescriptor,
  RemoteBrowserAutomationErrorPayload,
  RemoteBrowserRunConfig,
  RemoteRunPayload,
  RemoteRunEvent,
  RemoteRunTransactionPayload,
  RemoteTransactionRetryResponse,
  RemoteTransactionSettlementResponse,
} from "./types.js";
import {
  MAX_REMOTE_ARTIFACT_BYTES,
  MAX_REMOTE_ATTACHMENT_BYTES,
  MAX_REMOTE_ATTACHMENTS,
  MAX_REMOTE_PROMPT_CHARS,
  MAX_REMOTE_REQUEST_BYTES,
  MAX_REMOTE_TOTAL_ATTACHMENT_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
} from "./types.js";
import { getCookies, type Cookie } from "@steipete/sweet-cookie";
import { CHATGPT_URL } from "../browser/constants.js";
import { getCliVersion } from "../version.js";
import { getOracleHomeDir } from "../oracleHome.js";
import { normalizeChatgptUrl } from "../browser/utils.js";
import {
  computeFileSha256,
  sanitizeArtifactFilename,
  sanitizeArtifactMimeType,
  validateArtifactFile,
} from "../browser/artifacts.js";
import type {
  BrowserRuntimeMetadata,
  BrowserRunWarning,
  BrowserSessionConfig,
  SessionArtifact,
} from "../sessionManager.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { retryBrowserRecoveryCleanup } from "../browser/reattach.js";
import { acquireManualChromeOwner } from "../browser/manualChromeOwner.js";
import { resolveBrowserConfig } from "../browser/config.js";

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
  transactionStoreDir?: string;
  retryCleanup?: typeof retryBrowserRecoveryCleanup;
}

interface RemoteServerInstance {
  port: number;
  token: string;
  close(): Promise<void>;
}

interface RegisteredRemoteArtifact {
  descriptor: RemoteArtifactDescriptor;
  filePath: string;
  device: number;
  inode: number;
  expiresAt: number;
}

type RemoteTransactionState =
  | "running"
  | "pending"
  | "finalized"
  | "aborted"
  | "recoverable-error"
  | "failed";

interface RemoteTransactionRecord {
  protocolVersion: typeof REMOTE_TRANSACTION_PROTOCOL_VERSION;
  transactionToken: string;
  runId: string;
  createdAt: string;
  updatedAt: string;
  state: RemoteTransactionState;
  result?: BrowserRunResult;
  runtime?: BrowserRuntimeMetadata;
  artifacts?: RemoteArtifactDescriptor[];
  error?: RemoteBrowserAutomationErrorPayload;
  settlementMode?: "finalize" | "abort";
  publicationAcknowledgedAt?: string;
  finalization?: BrowserCaptureFinalizationResult;
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
const REMOTE_ARTIFACT_TTL_MS = 30 * 60 * 1000;
const REMOTE_TRANSACTION_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

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
};

export async function createRemoteServer(
  options: RemoteServerOptions = {},
  deps: RemoteServerDeps = {},
): Promise<RemoteServerInstance> {
  const runBrowser = deps.runBrowser ?? runBrowserMode;
  const retryCleanup = deps.retryCleanup ?? retryBrowserRecoveryCleanup;
  const server = http.createServer();
  const logger = options.logger ?? console.log;
  const authToken = options.token ?? randomBytes(16).toString("hex");
  const startedAt = Date.now();
  const verbose = process.argv.includes("--verbose") || process.env.ORACLE_SERVE_VERBOSE === "1";
  const color = process.stdout.isTTY
    ? (formatter: (msg: string) => string, msg: string) => formatter(msg)
    : (_formatter: (msg: string) => string, msg: string) => msg;
  const transactionStoreDir =
    deps.transactionStoreDir ?? path.join(getOracleHomeDir(), "remote-transactions");
  await mkdir(transactionStoreDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(transactionStoreDir, 0o700);
  await syncDirectory(transactionStoreDir);

  // Remote Chrome is single-flight, while captured transactions remain independently settleable.
  let busy = false;
  const artifactRegistry = new Map<string, RegisteredRemoteArtifact>();
  const activeTransactions = new Map<string, BrowserRunTransaction>();
  const transactionLocks = new Map<string, Promise<void>>();

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

      const artifactMatch = matchArtifactRequest(req);
      if (artifactMatch) {
        await serveRemoteArtifact({
          req,
          res,
          authToken,
          artifactRegistry,
          logger,
          verbose,
          runId: artifactMatch.runId,
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
        if (transactionMatch.action === "retry") {
          await serveRemoteTransactionRetry({
            res,
            transactionStoreDir,
            transactionToken: transactionMatch.transactionToken,
          });
          return;
        }
        await serveRemoteTransactionSettlement({
          req,
          res,
          logger,
          transactionStoreDir,
          transactionToken: transactionMatch.transactionToken,
          mode: transactionMatch.action,
          activeTransactions,
          transactionLocks,
          retryCleanup,
        });
        return;
      }

      if (req.method !== "POST" || req.url !== "/runs") {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (!authenticateRemoteRequest(req, res, authToken, logger, verbose, "/runs")) return;
      if (busy) {
        if (verbose) {
          logger(
            `[serve] Busy: rejecting new run from ${formatSocket(req)} while another run is active`,
          );
        }
        sendJson(res, 409, { error: "busy" });
        return;
      }

      busy = true;
      try {
        await handleRemoteRunRequest({
          req,
          res,
          options,
          runBrowser,
          logger,
          verbose,
          transactionStoreDir,
          artifactRegistry,
          activeTransactions,
        });
      } finally {
        busy = false;
      }
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
  server.listen(options.port ?? 0, options.host ?? "0.0.0.0", () => {
    server.off("error", rejectListen);
    listenDeferred.resolve();
  });
  await listenDeferred.promise;

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine server address.");
  }
  const reachable = formatReachableAddresses(address.address, address.port);
  const primary = reachable[0] ?? `${address.address}:${address.port}`;
  const extras = reachable.slice(1);
  const also = extras.length ? `, also [${extras.join(", ")}]` : "";
  logger(color(chalk.cyanBright.bold, `Listening at ${primary}${also}`));
  logger(color(chalk.yellowBright, `Access token: ${authToken}`));
  logger("Leave this terminal running; press Ctrl+C to stop oracle serve.");

  return {
    port: address.port,
    token: authToken,
    async close() {
      const closeDeferred = createDeferred<void>();
      server.close((error) => (error ? closeDeferred.reject(error) : closeDeferred.resolve()));
      await closeDeferred.promise;
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

const RemoteAttachmentPayloadSchema = z
  .object({
    fileName: z.string().min(1).max(255),
    displayPath: z.string().min(1).max(4096),
    sizeBytes: z.number().int().positive().max(MAX_REMOTE_ATTACHMENT_BYTES).optional(),
    contentBase64: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_REMOTE_ATTACHMENT_BYTES * 4) / 3) + 4),
  })
  .strict()
  .superRefine((attachment, context) => {
    const encoded = attachment.contentBase64;
    if (
      encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
      encoded.slice(0, -2).includes("=")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "attachment is not canonical base64",
      });
      return;
    }
    const decodedSize = Buffer.from(encoded, "base64").byteLength;
    if (decodedSize <= 0 || decodedSize > MAX_REMOTE_ATTACHMENT_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "attachment exceeds size limit" });
    } else if (attachment.sizeBytes !== undefined && attachment.sizeBytes !== decodedSize) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "attachment size does not match payload",
      });
    }
  })
  .transform((attachment) => ({
    ...attachment,
    sizeBytes: Buffer.from(attachment.contentBase64, "base64").byteLength,
  }));

function isTrustedChatGptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.port &&
      !url.username &&
      !url.password &&
      (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com")
    );
  } catch {
    return false;
  }
}

const RemoteBrowserRunConfigSchema = z
  .object({
    chatgptUrl: z
      .string()
      .min(1)
      .max(2048)
      .refine(isTrustedChatGptUrl, "chatgptUrl must be an HTTPS ChatGPT origin")
      .nullable()
      .optional(),
    timeoutMs: z.number().int().positive().max(86_400_000).optional(),
    inputTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
    attachmentTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
    assistantRecheckDelayMs: z.number().int().nonnegative().max(3_600_000).optional(),
    assistantRecheckTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
    desiredModel: z.string().min(1).max(128).nullable().optional(),
    modelStrategy: z.enum(["select", "current", "ignore"]).optional(),
    thinkingTime: z.enum(["light", "standard", "extended", "heavy"]).optional(),
    researchMode: z.enum(["off", "deep"]).optional(),
    archiveConversations: z.enum(["auto", "always", "never"]).optional(),
    resumeConversationUrl: z
      .string()
      .min(1)
      .max(2048)
      .refine(isTrustedChatGptUrl, "resumeConversationUrl must be an HTTPS ChatGPT origin")
      .nullable()
      .optional(),
  })
  .strict();

const RemoteRunOptionsSchema = z
  .object({
    heartbeatIntervalMs: z.number().int().positive().max(3_600_000).optional(),
    verbose: z.boolean().optional(),
    sessionId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/)
      .optional(),
    followUpPrompts: z.array(z.string().min(1).max(MAX_REMOTE_PROMPT_CHARS)).max(32).optional(),
    keepConversationTab: z.boolean().optional(),
  })
  .strict();
const RemoteRunPayloadSchema = z
  .object({
    protocolVersion: z.literal(REMOTE_TRANSACTION_PROTOCOL_VERSION),
    transactionToken: z.string().regex(REMOTE_TRANSACTION_TOKEN_PATTERN),
    prompt: z.string().min(1).max(MAX_REMOTE_PROMPT_CHARS),
    attachments: z.array(RemoteAttachmentPayloadSchema).max(MAX_REMOTE_ATTACHMENTS),
    fallbackSubmission: z
      .object({
        prompt: z.string().min(1).max(MAX_REMOTE_PROMPT_CHARS),
        attachments: z.array(RemoteAttachmentPayloadSchema).max(MAX_REMOTE_ATTACHMENTS),
      })
      .strict()
      .optional(),
    browserConfig: RemoteBrowserRunConfigSchema,
    options: RemoteRunOptionsSchema,
  })
  .strict()
  .superRefine((payload, context) => {
    const attachments = [
      ...payload.attachments,
      ...(payload.fallbackSubmission?.attachments ?? []),
    ];
    if (attachments.length > MAX_REMOTE_ATTACHMENTS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "remote attachment count exceeds limit",
      });
    }
    const totalBytes = attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0);
    if (totalBytes > MAX_REMOTE_TOTAL_ATTACHMENT_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "remote attachments exceed aggregate size limit",
      });
    }
  });

async function handleRemoteRunRequest(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  options: RemoteServerOptions;
  runBrowser: (options: Parameters<typeof runBrowserMode>[0]) => Promise<BrowserRunTransaction>;
  logger: (message: string) => void;
  verbose: boolean;
  transactionStoreDir: string;
  artifactRegistry: Map<string, RegisteredRemoteArtifact>;
  activeTransactions: Map<string, BrowserRunTransaction>;
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

  const existing = await readRemoteTransactionRecord(
    params.transactionStoreDir,
    payload.transactionToken,
  );
  if (existing) {
    sendJson(params.res, 409, {
      error: "transaction_exists",
      state: existing.state,
      transactionToken: payload.transactionToken,
    });
    return;
  }

  const runId = randomUUID();
  const now = new Date().toISOString();
  await createRemoteTransactionRecord(params.transactionStoreDir, {
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    transactionToken: payload.transactionToken,
    runId,
    createdAt: now,
    updatedAt: now,
    state: "running",
  });

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
    runDir = await mkdtemp(path.join(os.tmpdir(), `oracle-serve-${runId}-`));
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

    const effectiveBrowserConfig = buildEffectiveRemoteBrowserConfig(
      payload.browserConfig,
      params.options,
    );
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
    });
    assertBrowserRunTransaction(capture);
    const result = browserRunResultFromTransaction(capture);
    const artifactRegistration = await registerRemoteArtifacts({
      runId,
      result,
      artifactRegistry: params.artifactRegistry,
      logger: params.logger,
    });
    const sanitizedResult = sanitizeResult(result, artifactRegistration.warnings);
    const record: RemoteTransactionRecord = {
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      transactionToken: payload.transactionToken,
      runId,
      createdAt: now,
      updatedAt: new Date().toISOString(),
      state: "pending",
      result: sanitizedResult,
      runtime: capture.runtime,
      artifacts: artifactRegistration.descriptors,
    };
    params.activeTransactions.set(payload.transactionToken, capture);
    await writeRemoteTransactionRecord(params.transactionStoreDir, record);
    durableCapture = true;

    if (artifactRegistration.descriptors.length > 0) {
      sendEvent({
        type: "log",
        message:
          `[browser] ${artifactRegistration.descriptors.length} artifact(s) ready for bridge transfer. ` +
          "If no cloud-local artifact path appears, copy the file manually from the browser host.",
      });
    }
    sendEvent({ type: "transaction", transaction: remoteTransactionPayload(record) });
    params.logger(
      `[serve] Run ${runId} captured durably in ${Date.now() - runStartedAt}ms; awaiting client publication acknowledgement`,
    );
  } catch (rawError) {
    let failedCleanup: BrowserCaptureFinalizationResult | null = null;
    const failedCapture = capture;
    if (failedCapture && !durableCapture) {
      failedCleanup = await failedCapture
        .abort()
        .catch((abortError) => pendingFinalization(failedCapture.runtime, abortError));
      params.activeTransactions.delete(payload.transactionToken);
    }
    const error =
      rawError instanceof BrowserAutomationError
        ? rawError
        : new BrowserAutomationError(
            rawError instanceof Error ? rawError.message : "Remote browser automation failed",
            { stage: "execute-browser" },
            rawError,
          );
    const remoteError = serializeRemoteBrowserAutomationError(error, payload.transactionToken);
    if (failedCleanup?.status === "pending") {
      remoteError.runtime = failedCleanup.runtime;
      remoteError.recoverableDisconnect = true;
      remoteError.recoveryToken = payload.transactionToken;
      remoteError.details = {
        ...(remoteError.details ?? {}),
        capturePublicationFailed: true,
        cleanupError: failedCleanup.error,
      };
    }
    const runtime = remoteError.runtime;
    const recoverable = remoteError.recoverableDisconnect && Boolean(runtime);
    const failedRecord: RemoteTransactionRecord = {
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      transactionToken: payload.transactionToken,
      runId,
      createdAt: now,
      updatedAt: new Date().toISOString(),
      state: recoverable ? "recoverable-error" : "failed",
      runtime,
      error: remoteError,
    };
    await writeRemoteTransactionRecord(params.transactionStoreDir, failedRecord);
    sendEvent({ type: "error", error: remoteError });
    params.logger(
      `[serve] Run ${runId} failed after ${Date.now() - runStartedAt}ms: ${error.message}`,
    );
  } finally {
    if (!params.res.destroyed && !params.res.writableEnded) params.res.end();
    if (runDir) await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
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
): { transactionToken: string; action: "finalize" | "abort" | "retry" } | null {
  if (req.method !== "POST" || !req.url) return null;
  let pathname: string;
  try {
    pathname = new URL(req.url, "http://oracle.local").pathname;
  } catch {
    return null;
  }
  const match = /^\/transactions\/([^/]+)\/(finalize|abort|retry)$/.exec(pathname);
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
    action: match[2] as "finalize" | "abort" | "retry",
  };
}

async function serveRemoteTransactionRetry(params: {
  res: http.ServerResponse;
  transactionStoreDir: string;
  transactionToken: string;
}): Promise<void> {
  const record = await readRemoteTransactionRecord(
    params.transactionStoreDir,
    params.transactionToken,
  );
  if (!record) {
    sendJson(params.res, 404, { error: "transaction_not_found" });
    return;
  }
  let response: RemoteTransactionRetryResponse;
  if (record.state === "running") {
    response = { status: "running" };
    sendJson(params.res, 202, response);
    return;
  }
  if (!record.result) {
    if (!record.error) throw new Error("Remote error transaction is missing error metadata");
    const retryable = record.state === "recoverable-error" || record.state === "pending";
    response = {
      status: "error",
      error: {
        ...record.error,
        details: { ...(record.error.details ?? {}), remoteCleanupState: record.state },
        recoverableDisconnect: retryable,
        recoveryToken: retryable ? record.transactionToken : undefined,
        runtime: record.runtime,
      },
    };
    sendJson(params.res, 200, response);
    return;
  }
  response = { status: "transaction", transaction: remoteTransactionPayload(record) };
  sendJson(params.res, 200, response);
}

async function serveRemoteTransactionSettlement(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  logger: (message: string) => void;
  transactionStoreDir: string;
  transactionToken: string;
  mode: "finalize" | "abort";
  activeTransactions: Map<string, BrowserRunTransaction>;
  transactionLocks: Map<string, Promise<void>>;
  retryCleanup: typeof retryBrowserRecoveryCleanup;
}): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    const raw = await readRequestBody(params.req, 4096);
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    sendJson(params.res, 400, { error: "invalid_settlement_request" });
    return;
  }
  if (params.mode === "finalize" && body.durablePublication !== true) {
    sendJson(params.res, 409, { error: "durable_publication_ack_required" });
    return;
  }

  const outcome = await withRemoteTransactionLock(
    params.transactionToken,
    params.transactionLocks,
    async () => {
      const record = await readRemoteTransactionRecord(
        params.transactionStoreDir,
        params.transactionToken,
      );
      if (!record)
        throw new RemoteRequestError(404, "transaction_not_found", "Transaction not found");
      if (record.state === "running") {
        throw new RemoteRequestError(409, "transaction_running", "Transaction is still running");
      }
      if (record.state === "failed") {
        throw new RemoteRequestError(
          409,
          "transaction_failed",
          "Transaction did not capture an answer",
        );
      }
      if (record.state === "recoverable-error" && params.mode === "finalize") {
        throw new RemoteRequestError(
          409,
          "transaction_has_no_capture",
          "Recoverable disconnect has no durably captured answer to finalize",
        );
      }
      if (record.state === "finalized" || record.state === "aborted") {
        const terminalMode = record.state === "finalized" ? "finalize" : "abort";
        if (terminalMode !== params.mode) {
          throw new RemoteRequestError(
            409,
            "transaction_already_settled",
            `Transaction was already ${record.state}`,
          );
        }
        if (!record.finalization) throw new Error("Terminal transaction lacks finalization state");
        return settlementResponse(record);
      }
      const runtime = record.runtime;
      if (!runtime) throw new Error("Pending transaction lacks runtime authority");
      if (record.settlementMode && record.settlementMode !== params.mode) {
        throw new RemoteRequestError(
          409,
          "transaction_settlement_conflict",
          `Transaction is already bound to ${record.settlementMode}`,
        );
      }

      record.settlementMode = params.mode;
      if (params.mode === "finalize" && !record.publicationAcknowledgedAt) {
        record.publicationAcknowledgedAt = new Date().toISOString();
      }
      record.updatedAt = new Date().toISOString();
      await writeRemoteTransactionRecord(params.transactionStoreDir, record);

      const active = params.activeTransactions.get(params.transactionToken);
      let finalization: BrowserCaptureFinalizationResult;
      if (active) {
        params.activeTransactions.delete(params.transactionToken);
        finalization = await active[params.mode]().catch((error) =>
          pendingFinalization(runtime, error),
        );
      } else {
        const cleanupLogger = ((message?: string) => {
          if (typeof message === "string") params.logger(`[serve] ${message}`);
        }) as BrowserLogger;
        finalization = await params
          .retryCleanup(runtime, cleanupLogger)
          .catch((error) => pendingFinalization(runtime, error));
      }

      record.runtime = finalization.runtime;
      record.finalization = finalization;
      record.state =
        finalization.status === "completed"
          ? params.mode === "finalize"
            ? "finalized"
            : "aborted"
          : "pending";
      if (record.error && !record.result) {
        const retryable = record.state === "pending";
        record.error = {
          ...record.error,
          details: { ...(record.error.details ?? {}), remoteCleanupState: record.state },
          recoverableDisconnect: retryable,
          recoveryToken: retryable ? record.transactionToken : undefined,
          runtime: finalization.runtime,
        };
      }
      record.updatedAt = new Date().toISOString();
      await writeRemoteTransactionRecord(params.transactionStoreDir, record);
      return settlementResponse(record);
    },
  ).catch((error) => error);

  if (outcome instanceof RemoteRequestError) {
    sendJson(params.res, outcome.statusCode, { error: outcome.code, message: outcome.message });
    return;
  }
  if (outcome instanceof Error) throw outcome;
  sendJson(params.res, 200, outcome);
}

async function withRemoteTransactionLock<T>(
  transactionToken: string,
  locks: Map<string, Promise<void>>,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = locks.get(transactionToken) ?? Promise.resolve();
  const gate = createDeferred<void>();
  const current = prior.then(() => gate.promise);
  locks.set(transactionToken, current);
  await prior;
  try {
    return await operation();
  } finally {
    gate.resolve();
    if (locks.get(transactionToken) === current) locks.delete(transactionToken);
  }
}

function settlementResponse(record: RemoteTransactionRecord): RemoteTransactionSettlementResponse {
  if (
    !record.finalization ||
    (record.state !== "pending" && record.state !== "finalized" && record.state !== "aborted")
  ) {
    throw new Error("Transaction settlement response is incomplete");
  }
  return {
    transactionToken: record.transactionToken,
    state: record.state,
    finalization: record.finalization,
  };
}

function pendingFinalization(
  runtime: BrowserRuntimeMetadata,
  error: unknown,
): BrowserCaptureFinalizationResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: "pending",
    runtime: {
      ...runtime,
      recoveryCleanupResult: { status: "failed", error: message },
    },
    error: message,
  };
}

function remoteTransactionPayload(record: RemoteTransactionRecord): RemoteRunTransactionPayload {
  if (
    !record.result ||
    !record.runtime ||
    (record.state !== "pending" && record.state !== "finalized" && record.state !== "aborted")
  ) {
    throw new Error("Remote transaction record is not publishable");
  }
  return {
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    transactionToken: record.transactionToken,
    runId: record.runId,
    result: record.result,
    runtime: record.runtime,
    artifacts: record.artifacts ?? [],
    state: record.state,
    finalization: record.finalization,
  };
}

async function createRemoteTransactionRecord(
  transactionStoreDir: string,
  record: RemoteTransactionRecord,
): Promise<void> {
  const targetPath = remoteTransactionRecordPath(transactionStoreDir, record.transactionToken);
  const handle = await open(targetPath, "wx", 0o600).catch((error) => {
    if (readErrorCode(error) === "EEXIST") {
      throw new RemoteRequestError(409, "transaction_exists", "Transaction token already exists");
    }
    throw error;
  });
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(transactionStoreDir);
}

async function writeRemoteTransactionRecord(
  transactionStoreDir: string,
  record: RemoteTransactionRecord,
): Promise<void> {
  record.updatedAt = new Date().toISOString();
  const targetPath = remoteTransactionRecordPath(transactionStoreDir, record.transactionToken);
  const tempPath = path.join(
    transactionStoreDir,
    `.${record.transactionToken}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, targetPath);
    await syncDirectory(transactionStoreDir);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function readRemoteTransactionRecord(
  transactionStoreDir: string,
  transactionToken: string,
): Promise<RemoteTransactionRecord | null> {
  const targetPath = remoteTransactionRecordPath(transactionStoreDir, transactionToken);
  try {
    const parsed = JSON.parse(await readFile(targetPath, "utf8")) as RemoteTransactionRecord;
    if (
      parsed.protocolVersion !== REMOTE_TRANSACTION_PROTOCOL_VERSION ||
      parsed.transactionToken !== transactionToken
    ) {
      throw new Error(`Invalid remote transaction record: ${targetPath}`);
    }
    return parsed;
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function remoteTransactionRecordPath(
  transactionStoreDir: string,
  transactionToken: string,
): string {
  if (!REMOTE_TRANSACTION_TOKEN_PATTERN.test(transactionToken)) {
    throw new RemoteRequestError(400, "invalid_transaction_token", "Invalid transaction token");
  }
  return path.join(transactionStoreDir, `${transactionToken}.json`);
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

function serializeRemoteBrowserAutomationError(
  error: BrowserAutomationError,
  transactionToken: string,
): RemoteBrowserAutomationErrorPayload {
  const rawDetails = error.details ?? {};
  const runtimeCandidate = rawDetails.runtime;
  const runtime =
    typeof runtimeCandidate === "object" && runtimeCandidate !== null
      ? (runtimeCandidate as BrowserRuntimeMetadata)
      : undefined;
  const details = serializableRecord(
    Object.fromEntries(Object.entries(rawDetails).filter(([key]) => key !== "runtime")),
  );
  const stage = typeof rawDetails.stage === "string" ? rawDetails.stage : undefined;
  const recoverableDisconnect = rawDetails.recoverableDisconnect === true && Boolean(runtime);
  return {
    name: "BrowserAutomationError",
    category: "browser-automation",
    message: error.message,
    details,
    stage,
    recoverableDisconnect,
    recoveryToken: recoverableDisconnect && runtime ? transactionToken : undefined,
    runtime,
  };
}

function serializableRecord(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function serveRemote(options: RemoteServerOptions = {}): Promise<void> {
  const manualProfileDir =
    options.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile");
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
): { runId: string; artifactId: string } | null {
  if (req.method !== "GET" || !req.url) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(req.url, "http://oracle.local");
  } catch {
    return null;
  }
  const match = /^\/runs\/([^/]+)\/artifacts\/([^/]+)$/.exec(url.pathname);
  if (!match) {
    return null;
  }
  try {
    return {
      runId: decodeURIComponent(match[1] ?? ""),
      artifactId: decodeURIComponent(match[2] ?? ""),
    };
  } catch {
    return null;
  }
}

async function serveRemoteArtifact(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  authToken: string;
  artifactRegistry: Map<string, RegisteredRemoteArtifact>;
  logger: (message: string) => void;
  verbose: boolean;
  runId: string;
  artifactId: string;
}): Promise<void> {
  if (
    !authenticateRemoteRequest(
      params.req,
      params.res,
      params.authToken,
      params.logger,
      params.verbose,
      "/runs/.../artifacts/...",
    )
  ) {
    return;
  }

  pruneExpiredArtifacts(params.artifactRegistry);
  const key = remoteArtifactKey(params.runId, params.artifactId);
  const artifact = params.artifactRegistry.get(key);
  if (!artifact) {
    sendJson(params.res, 404, { error: "artifact_not_found" });
    return;
  }
  if (Date.now() > artifact.expiresAt) {
    params.artifactRegistry.delete(key);
    sendJson(params.res, 410, { error: "artifact_expired" });
    return;
  }

  const handle = await open(artifact.filePath, "r").catch(() => null);
  if (!handle) {
    sendJson(params.res, 410, { error: "artifact_unavailable" });
    return;
  }
  try {
    const fileStat = await handle.stat();
    const stableIdentity =
      fileStat.isFile() &&
      fileStat.size === artifact.descriptor.byteSize &&
      fileStat.size > 0 &&
      fileStat.size <= MAX_REMOTE_ARTIFACT_BYTES &&
      (artifact.device === 0 || fileStat.dev === artifact.device) &&
      (artifact.inode === 0 || fileStat.ino === artifact.inode);
    if (!stableIdentity) {
      sendJson(params.res, 410, { error: "artifact_identity_changed" });
      return;
    }
    const sha256 = await computeOpenFileSha256(handle);
    if (sha256 !== artifact.descriptor.sha256) {
      sendJson(params.res, 410, { error: "artifact_content_changed" });
      return;
    }

    const filename = sanitizeArtifactFilename(artifact.descriptor.filename, "artifact.bin");
    params.res.writeHead(200, {
      "Content-Type":
        sanitizeArtifactMimeType(artifact.descriptor.mimeType) ?? "application/octet-stream",
      "Content-Length": fileStat.size,
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Oracle-Artifact-Id": artifact.descriptor.artifactId,
      "X-Oracle-Artifact-Sha256": artifact.descriptor.sha256,
    });
    await pipeline(handle.createReadStream({ start: 0, autoClose: false }), params.res).catch(
      (error) => {
        params.logger(
          `[serve] Artifact transfer failed for ${artifact.descriptor.artifactId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function computeOpenFileSha256(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function pruneExpiredArtifacts(artifactRegistry: Map<string, RegisteredRemoteArtifact>): void {
  const now = Date.now();
  for (const [key, artifact] of artifactRegistry) {
    if (artifact.expiresAt <= now) {
      artifactRegistry.delete(key);
    }
  }
}

function remoteArtifactKey(runId: string, artifactId: string): string {
  return `${runId}:${artifactId}`;
}

async function registerRemoteArtifacts(params: {
  runId: string;
  result: BrowserRunResult;
  artifactRegistry: Map<string, RegisteredRemoteArtifact>;
  logger: (message: string) => void;
}): Promise<{ descriptors: RemoteArtifactDescriptor[]; warnings: BrowserRunWarning[] }> {
  pruneExpiredArtifacts(params.artifactRegistry);
  const seen = new Set<string>();
  const fileArtifacts: SessionArtifact[] = [
    ...(params.result.savedFiles ?? []),
    ...(params.result.artifacts ?? []).filter((artifact) => artifact.kind === "file"),
  ];
  const descriptors: RemoteArtifactDescriptor[] = [];
  const warnings: BrowserRunWarning[] = [];
  for (const artifact of fileArtifacts) {
    if (!artifact?.path || seen.has(artifact.path)) {
      continue;
    }
    seen.add(artifact.path);
    const registration = await buildRemoteArtifactRegistration(params.runId, artifact).catch(
      (error) => {
        const filename = sanitizeArtifactFilename(path.basename(artifact.path), "artifact.bin");
        params.logger(
          `[serve] Skipping remote artifact descriptor: ${error instanceof Error ? error.message : String(error)}`,
        );
        warnings.push({
          code: "remote-artifact-registration-failed",
          severity: "warning",
          message:
            `Oracle captured the browser text response, but the bridge host could not prepare ${filename} for transfer. ` +
            "Open the ChatGPT browser on the bridge host, download the ZIP/file shown in the current response, and copy it to a cloud-readable path.",
        });
        return null;
      },
    );
    if (!registration) {
      continue;
    }
    params.artifactRegistry.set(
      remoteArtifactKey(params.runId, registration.descriptor.artifactId),
      {
        descriptor: registration.descriptor,
        filePath: registration.filePath,
        device: registration.device,
        inode: registration.inode,
        expiresAt: Date.now() + REMOTE_ARTIFACT_TTL_MS,
      },
    );
    descriptors.push(registration.descriptor);
  }
  return { descriptors, warnings };
}

async function buildRemoteArtifactRegistration(
  runId: string,
  artifact: SessionArtifact,
): Promise<{
  descriptor: RemoteArtifactDescriptor;
  filePath: string;
  device: number;
  inode: number;
}> {
  if (artifact.path.endsWith(".crdownload")) {
    throw new Error("artifact is still a Chrome partial download");
  }
  const filePath = await resolveRegisteredArtifactPath(artifact.path);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size <= 0) {
    throw new Error("artifact is not a completed non-empty file");
  }
  if (fileStat.size > MAX_REMOTE_ARTIFACT_BYTES) {
    throw new Error("artifact exceeds bridge transfer size limit");
  }
  const filename = sanitizeArtifactFilename(path.basename(filePath), "artifact.bin");
  const mimeType = sanitizeArtifactMimeType(artifact.mimeType);
  // Recompute security metadata from the exact file registered for transfer.
  const validation = await validateArtifactFile({
    path: filePath,
    filename,
    mimeType,
  });
  const sha256 = await computeFileSha256(filePath);
  return {
    filePath,
    device: fileStat.dev,
    inode: fileStat.ino,
    descriptor: {
      artifactId: randomUUID(),
      runId,
      kind: "file",
      filename,
      mimeType,
      byteSize: fileStat.size,
      sha256,
      validation,
      sourceUrlKind: classifySourceUrlKind(artifact.sourceUrl),
      transferStatus: "ready",
    },
  };
}

async function resolveRegisteredArtifactPath(filePath: string): Promise<string> {
  const [resolvedFile, sessionsRoot] = await Promise.all([
    realpath(filePath),
    realpath(path.join(getOracleHomeDir(), "sessions")),
  ]);
  const relative = path.relative(sessionsRoot, resolvedFile);
  const segments = relative.split(path.sep);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    segments.length < 3 ||
    segments[1] !== "artifacts"
  ) {
    throw new Error("artifact is outside Oracle's session artifact boundary");
  }
  return resolvedFile;
}

function classifySourceUrlKind(sourceUrl?: string): RemoteArtifactDescriptor["sourceUrlKind"] {
  if (sourceUrl?.startsWith("sandbox:")) {
    return "sandbox";
  }
  if (sourceUrl === "browser-download") {
    return "browser-download";
  }
  return "chatgpt-file-endpoint";
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

function sanitizeResult(
  result: BrowserRunResult,
  warnings: BrowserRunWarning[] = [],
): BrowserRunResult {
  return {
    ...result,
    // Host-local artifact paths are replaced by authenticated bridge descriptors.
    artifacts: undefined,
    generatedImages: undefined,
    savedImages: undefined,
    downloadableFiles: undefined,
    savedFiles: undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function formatSocket(req: http.IncomingMessage): string {
  const socket = req.socket;
  const host = socket.remoteAddress ?? "unknown";
  const port = socket.remotePort ?? "0";
  return `${host}:${port}`;
}

function formatReachableAddresses(bindAddress: string, port: number): string[] {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  if (bindAddress && bindAddress !== "::" && bindAddress !== "0.0.0.0") {
    if (bindAddress.includes(":")) {
      ipv6.push(`[${bindAddress}]:${port}`);
    } else {
      ipv4.push(`${bindAddress}:${port}`);
    }
  }
  try {
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      if (!entries) continue;
      for (const entry of entries) {
        const iface = entry as
          | { family?: string | number; address: string; internal?: boolean }
          | undefined;
        if (!iface || iface.internal) continue;
        const family =
          typeof iface.family === "string"
            ? iface.family
            : iface.family === 4
              ? "IPv4"
              : iface.family === 6
                ? "IPv6"
                : "";
        if (family === "IPv4") {
          const addr = iface.address;
          if (addr.startsWith("127.")) continue;
          if (addr.startsWith("169.254.")) continue; // APIPA/link-local
          ipv4.push(`${addr}:${port}`);
        } else if (family === "IPv6") {
          const addr = iface.address.toLowerCase();
          if (addr === "::1" || addr.startsWith("fe80:")) continue; // loopback/link-local
          ipv6.push(`[${iface.address}]:${port}`);
        }
      }
    }
  } catch {
    // network interface probing can fail in locked-down environments; ignore
  }
  // de-dup
  return Array.from(new Set([...ipv4, ...ipv6]));
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
  return Boolean(process.env.WSL_DISTRO_NAME || os.release().toLowerCase().includes("microsoft"));
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
