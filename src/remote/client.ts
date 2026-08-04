import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import type { BrowserRunOptions, BrowserRunResult } from "../browserMode.js";
import type {
  BrowserAttachment,
  BrowserCaptureFinalizationResult,
  BrowserLogger,
  BrowserRunTransaction,
  SavedBrowserFile,
} from "../browser/types.js";
import type {
  BrowserPromptEpoch,
  BrowserRemotePromptRequestIdentity,
  BrowserRemoteRecoveryMetadata,
  BrowserRuntimeMetadata,
} from "../sessionManager.js";
import { syncDirectoryIfSupported } from "../sessionManager.js";
import {
  appendArtifacts,
  resolveSessionArtifactsDir,
  sanitizeArtifactFilename,
  sanitizeArtifactMimeType,
  validateArtifactFile,
} from "../browser/artifacts.js";
import {
  DEFAULT_REMOTE_ARTIFACT_OVERALL_TIMEOUT_MS,
  DEFAULT_REMOTE_CONTROL_OVERALL_TIMEOUT_MS,
  DEFAULT_REMOTE_RUN_OVERALL_TIMEOUT_MS,
  DEFAULT_REMOTE_SOCKET_IDLE_TIMEOUT_MS,
  MAX_REMOTE_ARTIFACT_BYTES,
  MAX_REMOTE_ATTACHMENT_BYTES,
  MAX_REMOTE_ATTACHMENTS,
  MAX_REMOTE_EVENT_BYTES,
  MAX_REMOTE_PROMPT_CHARS,
  MAX_REMOTE_REQUEST_BYTES,
  MAX_REMOTE_TOTAL_ATTACHMENT_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  buildRemotePromptRequestIdentity,
  RemoteArtifactDescriptorSchema,
  RemoteArtifactDeliveryReceiptRequestSchema,
  RemoteRunEventSchema,
  RemoteTransactionRetryResponseSchema,
  RemoteRunPayloadSchema,
  RemoteTransactionSettlementResponseSchema,
  type RemoteArtifactDescriptor,
  type RemoteAttachmentPayload,
  type RemoteBrowserAutomationErrorPayload,
  type RemoteBrowserRunConfig,
  type RemotePublicRuntime,
  type RemoteRecoverySettlementOptions,
  type RemoteRunEvent,
  type RemoteRunPayload,
  type RemoteRunTransactionPayload,
  type RemoteTransactionRetryResponse,
  type RemoteTransactionSettlementResponse,
  type RemoteTransportDeadlines,
} from "./types.js";
import { parsePlaintextRemoteEndpoint } from "./remoteServiceConfig.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { delay } from "../browser/utils.js";

export interface RemoteExecutorOptions {
  host: string;
  token?: string;
  deadlines?: RemoteTransportDeadlines;
}

interface RemoteAttachmentBudget {
  count: number;
  bytes: number;
}
interface ResolvedRemoteTransportDeadlines {
  runOverallTimeoutMs: number;
  controlOverallTimeoutMs: number;
  artifactOverallTimeoutMs: number;
  socketIdleTimeoutMs: number;
  recoveryWindowMs: number;
}
interface RequestDeadlineGuard {
  clear: () => void;
  watchResponse: (res: http.IncomingMessage) => void;
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

class RemoteTransportInterruption extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RemoteTransportInterruption";
  }
}
function resolveRemoteTransportDeadlines(
  configured: RemoteTransportDeadlines | undefined,
  browserTimeoutMs?: number,
): ResolvedRemoteTransportDeadlines {
  const readDeadline = (value: number | undefined, fallback: number, label: string): number => {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
      throw new BrowserAutomationError(`${label} must be a positive integer.`, {
        stage: "remote-connection",
      });
    }
    return resolved;
  };
  return {
    runOverallTimeoutMs: readDeadline(
      configured?.runOverallTimeoutMs,
      Math.max(DEFAULT_REMOTE_RUN_OVERALL_TIMEOUT_MS, (browserTimeoutMs ?? 0) + 120_000),
      "Remote run overall timeout",
    ),
    controlOverallTimeoutMs: readDeadline(
      configured?.controlOverallTimeoutMs,
      DEFAULT_REMOTE_CONTROL_OVERALL_TIMEOUT_MS,
      "Remote control overall timeout",
    ),
    artifactOverallTimeoutMs: readDeadline(
      configured?.artifactOverallTimeoutMs,
      DEFAULT_REMOTE_ARTIFACT_OVERALL_TIMEOUT_MS,
      "Remote artifact overall timeout",
    ),
    socketIdleTimeoutMs: readDeadline(
      configured?.socketIdleTimeoutMs,
      DEFAULT_REMOTE_SOCKET_IDLE_TIMEOUT_MS,
      "Remote socket idle timeout",
    ),
    recoveryWindowMs: readDeadline(configured?.recoveryWindowMs, 30_000, "Remote recovery window"),
  };
}

function attachRequestDeadlines(
  req: http.ClientRequest,
  params: { overallTimeoutMs: number; idleTimeoutMs: number; operation: string },
): RequestDeadlineGuard {
  const overallTimer = setTimeout(() => {
    req.destroy(
      new Error(`${params.operation} exceeded its ${params.overallTimeoutMs}ms overall timeout`),
    );
  }, params.overallTimeoutMs);
  overallTimer.unref();
  req.setTimeout(params.idleTimeoutMs, () => {
    req.destroy(
      new Error(`${params.operation} exceeded its ${params.idleTimeoutMs}ms idle timeout`),
    );
  });
  return {
    clear: () => clearTimeout(overallTimer),
    watchResponse: (res) => {
      res.setTimeout(params.idleTimeoutMs, () => {
        res.destroy(
          new Error(`${params.operation} exceeded its ${params.idleTimeoutMs}ms idle timeout`),
        );
      });
    },
  };
}

export function createRemoteBrowserExecutor({ host, token, deadlines }: RemoteExecutorOptions) {
  return async function remoteBrowserExecutor(
    options: BrowserRunOptions,
  ): Promise<BrowserRunTransaction> {
    if (options.prompt.length > MAX_REMOTE_PROMPT_CHARS) {
      throw new BrowserAutomationError("Remote browser prompt exceeds the protocol size limit.", {
        stage: "remote-request",
      });
    }
    if (
      options.fallbackSubmission &&
      options.fallbackSubmission.prompt.length > MAX_REMOTE_PROMPT_CHARS
    ) {
      throw new BrowserAutomationError(
        "Remote fallback browser prompt exceeds the protocol size limit.",
        { stage: "remote-request" },
      );
    }
    const attachmentBudget: RemoteAttachmentBudget = { count: 0, bytes: 0 };
    const attachments = await serializeAttachments(options.attachments ?? [], attachmentBudget);
    const fallbackAttachments = options.fallbackSubmission
      ? await serializeAttachments(options.fallbackSubmission.attachments ?? [], attachmentBudget)
      : undefined;
    const transactionToken = randomBytes(32).toString("hex");
    const payload = RemoteRunPayloadSchema.parse({
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      prompt: options.prompt,
      attachments,
      fallbackSubmission: options.fallbackSubmission
        ? {
            prompt: options.fallbackSubmission.prompt,
            attachments: fallbackAttachments ?? [],
          }
        : undefined,
      browserConfig: projectRemoteBrowserRunConfig(options),
      options: {
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        verbose: options.verbose,
        sessionId: options.sessionId,
        followUpPrompts: options.followUpPrompts,
        keepConversationTab: options.config?.keepBrowser === true,
      },
    });
    const { hostname, port } = parseRemoteHost(host);
    const resolvedDeadlines = resolveRemoteTransportDeadlines(deadlines, options.config?.timeoutMs);
    const requestIdentity = buildRemotePromptRequestIdentity(payload);
    const preReceiptAuthority: BrowserRemoteRecoveryMetadata = {
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      host,
      transactionToken,
      state: "pre-receipt",
      requestIdentity,
    };
    const preReceiptRuntime = projectRemoteRuntime(
      { cleanup: { status: "pending" } },
      preReceiptAuthority,
    );
    try {
      await options.runtimeHintCb?.(preReceiptRuntime);
    } catch (error) {
      throw new BrowserAutomationError(
        "Failed to persist remote transaction authority before sending the run request.",
        { stage: "remote-runtime-persistence", recoverableDisconnect: false },
        error,
      );
    }
    let receipt: RemoteRunTransactionPayload;
    try {
      receipt = await streamRemoteRun({
        hostname,
        port,
        token,
        transactionToken,
        payload,
        options,
        host,
        requestIdentity,
        deadlines: resolvedDeadlines,
      });
    } catch (error) {
      if (error instanceof RemoteTransportInterruption) {
        receipt = await recoverRemoteRunTransaction({
          hostname,
          port,
          token,
          transactionToken,
          host,
          requestIdentity,
          interruption: error,
          deadlines: resolvedDeadlines,
        });
      } else if (error instanceof BrowserAutomationError && !error.details?.runtime) {
        const runtime = unresolvedRemoteTransactionRuntime(preReceiptAuthority, error.message);
        throw new BrowserAutomationError(
          error.message,
          {
            ...error.details,
            recoverableDisconnect: true,
            runtime,
            remoteRecovery: runtime.remoteRecovery,
          },
          error,
        );
      } else {
        throw error;
      }
    }
    assertPromptEpochMatchesRequestIdentity(
      receipt.runtime.promptEpoch,
      requestIdentity,
      preReceiptRuntime,
    );
    return await buildRemoteBrowserTransaction({
      receipt,
      hostname,
      port,
      token,
      host,
      requestIdentity,
      options,
      deadlines: resolvedDeadlines,
    });
  };
}

export async function settleRemoteBrowserRecovery(
  params: RemoteRecoverySettlementOptions,
): Promise<BrowserCaptureFinalizationResult> {
  const authority = findRemoteRecoveryAuthority(params.runtime);
  const pending = (
    message: string,
    runtime: BrowserRuntimeMetadata = params.runtime,
  ): BrowserCaptureFinalizationResult => ({
    status: "pending",
    runtime: {
      ...runtime,
      recoveryCleanupResult: { status: "failed", error: message },
    },
    error: message,
  });
  if (!authority || authority.protocolVersion !== REMOTE_TRANSACTION_PROTOCOL_VERSION) {
    return pending("Remote cleanup authority is missing or uses an unsupported protocol version.");
  }
  const mode =
    params.mode ??
    authority.settlementMode ??
    (authority.state === "recoverable-error" ? "abort" : "finalize");
  if (authority.settlementMode && authority.settlementMode !== mode) {
    throw settlementModeConflict(mode, authority.settlementMode, params.runtime);
  }
  const settlementRuntime = bindRemoteSettlementMode(params.runtime, mode);
  if (!params.authToken?.trim()) {
    return pending(
      "Remote cleanup authentication is unavailable; configure ORACLE_REMOTE_TOKEN.",
      settlementRuntime,
    );
  }
  if (authority.host !== params.configuredHost) {
    return pending(
      `Remote cleanup host mismatch; refusing to send credentials to ${authority.host}.`,
      settlementRuntime,
    );
  }
  let endpoint: { hostname: string; port: number };
  try {
    endpoint = parseRemoteHost(params.configuredHost);
  } catch (error) {
    return pending(error instanceof Error ? error.message : String(error), settlementRuntime);
  }
  return await settleRemoteBrowserTransaction({
    ...endpoint,
    token: params.authToken,
    host: authority.host,
    transactionToken: authority.transactionToken,
    recoveryState: authority.state,
    mode,
    runtime: settlementRuntime,
    deadlines: resolveRemoteTransportDeadlines(params.deadlines),
  });
}

function projectRemoteBrowserRunConfig(options: BrowserRunOptions): RemoteBrowserRunConfig {
  const config = options.config ?? {};
  return {
    chatgptUrl: config.chatgptUrl ?? config.url,
    timeoutMs: config.timeoutMs,
    inputTimeoutMs: config.inputTimeoutMs,
    attachmentTimeoutMs: config.attachmentTimeoutMs,
    assistantRecheckDelayMs: config.assistantRecheckDelayMs,
    assistantRecheckTimeoutMs: config.assistantRecheckTimeoutMs,
    desiredModel: config.desiredModel,
    modelStrategy: config.modelStrategy,
    thinkingTime: config.thinkingTime,
    researchMode: config.researchMode,
    archiveConversations: config.archiveConversations,
    resumeConversationUrl: config.resumeConversationUrl,
  };
}

async function serializeAttachments(
  attachments: BrowserAttachment[],
  budget: RemoteAttachmentBudget,
): Promise<RemoteAttachmentPayload[]> {
  if (budget.count + attachments.length > MAX_REMOTE_ATTACHMENTS) {
    throw new BrowserAutomationError(
      "Remote browser attachment count exceeds the protocol limit.",
      {
        stage: "remote-request",
      },
    );
  }
  const serialized: RemoteAttachmentPayload[] = [];
  for (const attachment of attachments) {
    const fileStat = await stat(attachment.path).catch((error) => {
      throw new BrowserAutomationError(
        `Unable to inspect remote browser attachment ${attachment.displayPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { stage: "remote-request", attachment: attachment.displayPath },
        error,
      );
    });
    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > MAX_REMOTE_ATTACHMENT_BYTES) {
      throw new BrowserAutomationError(
        `Remote browser attachment exceeds the ${MAX_REMOTE_ATTACHMENT_BYTES}-byte per-file limit: ${attachment.displayPath}`,
        { stage: "remote-request", attachment: attachment.displayPath },
      );
    }
    if (budget.bytes + fileStat.size > MAX_REMOTE_TOTAL_ATTACHMENT_BYTES) {
      throw new BrowserAutomationError(
        "Remote browser attachments exceed the aggregate protocol size limit.",
        { stage: "remote-request" },
      );
    }
    budget.count += 1;
    budget.bytes += fileStat.size;
    const content = await readFile(attachment.path).catch((error) => {
      throw new BrowserAutomationError(
        `Unable to read remote browser attachment ${attachment.displayPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { stage: "remote-request", attachment: attachment.displayPath },
        error,
      );
    });
    if (content.byteLength !== fileStat.size) {
      throw new BrowserAutomationError(
        `Remote browser attachment changed while it was being read: ${attachment.displayPath}`,
        { stage: "remote-request", attachment: attachment.displayPath },
      );
    }
    serialized.push({
      fileName: path.basename(attachment.path),
      displayPath: attachment.displayPath,
      sizeBytes: content.byteLength,
      contentBase64: content.toString("base64"),
    });
  }
  return serialized;
}

function parseRemoteHost(input: string): { hostname: string; port: number } {
  try {
    return parsePlaintextRemoteEndpoint(input);
  } catch (error) {
    throw new BrowserAutomationError(
      `Invalid remote host: ${input} (${error instanceof Error ? error.message : String(error)})`,
      { stage: "remote-connection" },
      error,
    );
  }
}

async function streamRemoteRun(params: {
  hostname: string;
  port: number;
  token?: string;
  transactionToken: string;
  payload: RemoteRunPayload;
  options: BrowserRunOptions;
  host: string;
  requestIdentity: BrowserRemotePromptRequestIdentity;
  deadlines: ResolvedRemoteTransportDeadlines;
}): Promise<RemoteRunTransactionPayload> {
  const body = Buffer.from(JSON.stringify(RemoteRunPayloadSchema.parse(params.payload)));
  if (body.byteLength > MAX_REMOTE_REQUEST_BYTES) {
    throw new BrowserAutomationError("Remote browser request exceeds the protocol size limit.", {
      stage: "remote-request",
      transactionToken: params.transactionToken,
    });
  }
  const deferred = createDeferred<RemoteRunTransactionPayload>();
  let settled = false;
  let receipt: RemoteRunTransactionPayload | null = null;
  let deadlineGuard: RequestDeadlineGuard | null = null;
  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true;
    deadlineGuard?.clear();
    if (receipt) {
      deferred.resolve(receipt);
      return;
    }
    deferred.reject(
      error instanceof BrowserAutomationError
        ? error
        : new RemoteTransportInterruption(
            error instanceof Error
              ? error.message
              : "Remote browser stream ended before the durable transaction receipt.",
            error,
          ),
    );
  };
  const req = http.request(
    {
      hostname: params.hostname,
      port: params.port,
      path: `/transactions/${encodeURIComponent(params.transactionToken)}/run`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
      },
    },
    (res) => {
      deadlineGuard?.watchResponse(res);
      if (res.statusCode !== 200) {
        collectError(res)
          .then((message) =>
            finish(
              new BrowserAutomationError(message, {
                stage: "remote-http",
                statusCode: res.statusCode,
                transactionToken: params.transactionToken,
              }),
            ),
          )
          .catch(finish);
        return;
      }
      res.setEncoding("utf8");
      let buffer = "";
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (Buffer.byteLength(line, "utf8") > MAX_REMOTE_EVENT_BYTES) {
            res.destroy();
            finish(
              new BrowserAutomationError(
                "Remote transaction event exceeded the protocol size limit.",
                { stage: "remote-protocol" },
              ),
            );
            return;
          }
          if (line) {
            try {
              const event = RemoteRunEventSchema.parse(JSON.parse(line)) as RemoteRunEvent;
              if (event.type === "log") {
                params.options.log?.(event.message);
              } else if (event.type === "artifact-progress") {
                if (params.options.verbose) {
                  params.options.log?.(
                    `[browser] Artifact ${event.artifactId} ${event.phase}${
                      event.receivedBytes !== undefined && event.totalBytes !== undefined
                        ? ` ${event.receivedBytes}/${event.totalBytes} bytes`
                        : ""
                    }`,
                  );
                }
              } else if (event.type === "transaction") {
                assertRemoteTransactionOwnership(event.transaction, params.transactionToken);
                receipt = event.transaction;
                finish();
                res.destroy();
                return;
              } else {
                finish(
                  rehydrateRemoteBrowserError(event.error, params.host, params.transactionToken, {
                    requestIdentity: params.requestIdentity,
                  }),
                );
              }
            } catch (error) {
              finish(
                new BrowserAutomationError(
                  `Invalid remote transaction event: ${error instanceof Error ? error.message : String(error)}`,
                  { stage: "remote-protocol" },
                  error,
                ),
              );
              return;
            }
          }
          newlineIndex = buffer.indexOf("\n");
        }
        if (Buffer.byteLength(buffer, "utf8") > MAX_REMOTE_EVENT_BYTES) {
          res.destroy();
          finish(
            new BrowserAutomationError(
              "Remote transaction event exceeded the protocol size limit.",
              {
                stage: "remote-protocol",
              },
            ),
          );
        }
      });
      res.on("end", () => finish());
      res.on("aborted", () => finish(new Error("Remote response aborted")));
      res.on("error", finish);
    },
  );
  deadlineGuard = attachRequestDeadlines(req, {
    overallTimeoutMs: params.deadlines.runOverallTimeoutMs,
    idleTimeoutMs: params.deadlines.socketIdleTimeoutMs,
    operation: "Remote run request",
  });
  req.on("error", finish);
  req.end(body);
  return await deferred.promise;
}

async function recoverRemoteRunTransaction(params: {
  hostname: string;
  port: number;
  token?: string;
  transactionToken: string;
  host: string;
  requestIdentity?: BrowserRemotePromptRequestIdentity;
  settlementMode?: "finalize" | "abort";
  interruption: RemoteTransportInterruption;
  deadlines: ResolvedRemoteTransportDeadlines;
}): Promise<RemoteRunTransactionPayload> {
  const recoveryAuthority = (state: "pre-receipt" | "recoverable-error") =>
    ({
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      host: params.host,
      transactionToken: params.transactionToken,
      state,
      requestIdentity: params.requestIdentity,
      settlementMode: params.settlementMode,
    }) satisfies BrowserRemoteRecoveryMetadata;
  const deadline = Date.now() + params.deadlines.recoveryWindowMs;
  let lastReachableAt = Date.now();
  while (Date.now() < deadline) {
    try {
      const response = await postRemoteJson({
        hostname: params.hostname,
        port: params.port,
        path: `/transactions/${params.transactionToken}/retry`,
        token: params.token,
        body: {},
        overallTimeoutMs: params.deadlines.controlOverallTimeoutMs,
        idleTimeoutMs: params.deadlines.socketIdleTimeoutMs,
        operation: "Remote retry request",
      });
      lastReachableAt = Date.now();
      if (response.statusCode === 202 || response.statusCode === 404) {
        await delay(500);
        continue;
      }
      if (response.statusCode !== 200) {
        throw new BrowserAutomationError(response.errorMessage, {
          stage: "remote-retry",
          statusCode: response.statusCode,
          transactionToken: params.transactionToken,
          recoverableDisconnect: true,
          runtime: unresolvedRemoteTransactionRuntime(
            recoveryAuthority("recoverable-error"),
            response.errorMessage,
          ),
        });
      }
      const retry = RemoteTransactionRetryResponseSchema.parse(
        response.json,
      ) as RemoteTransactionRetryResponse;
      if (retry.status === "running") {
        await delay(500);
        continue;
      }
      if (retry.status === "error") {
        throw rehydrateRemoteBrowserError(retry.error, params.host, params.transactionToken, {
          requestIdentity: params.requestIdentity,
          settlementMode: params.settlementMode,
        });
      }
      assertRemoteTransactionOwnership(retry.transaction, params.transactionToken);
      return retry.transaction;
    } catch (error) {
      if (error instanceof BrowserAutomationError) {
        if (error.details?.runtime) throw error;
        const runtime = unresolvedRemoteTransactionRuntime(
          recoveryAuthority("recoverable-error"),
          error.message,
        );
        throw new BrowserAutomationError(
          error.message,
          {
            ...error.details,
            recoverableDisconnect: true,
            runtime,
            remoteRecovery: runtime.remoteRecovery,
          },
          error,
        );
      }
      if (Date.now() - lastReachableAt > params.deadlines.recoveryWindowMs) {
        const message = `Remote transaction recovery failed after the response disconnected: ${
          error instanceof Error ? error.message : String(error)
        }`;
        throw new BrowserAutomationError(
          message,
          {
            stage: "remote-retry",
            transactionToken: params.transactionToken,
            recoverableDisconnect: true,
            runtime: unresolvedRemoteTransactionRuntime(
              recoveryAuthority("recoverable-error"),
              message,
            ),
          },
          params.interruption,
        );
      }
      await delay(500);
    }
  }
  const message = "Remote browser transaction did not become recoverable before its deadline.";
  throw new BrowserAutomationError(
    message,
    {
      stage: "remote-retry",
      transactionToken: params.transactionToken,
      recoverableDisconnect: true,
      runtime: unresolvedRemoteTransactionRuntime(recoveryAuthority("recoverable-error"), message),
    },
    params.interruption,
  );
}

function unresolvedRemoteTransactionRuntime(
  authority: BrowserRemoteRecoveryMetadata,
  error: string,
): BrowserRuntimeMetadata {
  const runtime = projectRemoteRuntime(
    { cleanup: { status: "pending" } },
    { ...authority, state: "recoverable-error" },
  );
  return {
    ...runtime,
    recoveryCleanupResult: { status: "failed", error },
  };
}
export async function resumeRemoteBrowserTransaction(params: {
  runtime: BrowserRuntimeMetadata;
  configuredHost: string;
  authToken?: string;
  sessionId?: string;
  log?: BrowserLogger;
  runtimeHintCb?: BrowserRunOptions["runtimeHintCb"];
}): Promise<BrowserRunTransaction> {
  const authority = findRemoteRecoveryAuthority(params.runtime);
  if (!authority || authority.protocolVersion !== REMOTE_TRANSACTION_PROTOCOL_VERSION) {
    throw new BrowserAutomationError(
      "Persisted remote transaction authority is missing or uses an unsupported protocol version.",
      { stage: "remote-resume", recoverableDisconnect: true, runtime: params.runtime },
    );
  }
  if (!params.authToken?.trim()) {
    throw new BrowserAutomationError(
      "Remote transaction authentication is unavailable; configure ORACLE_REMOTE_TOKEN.",
      { stage: "remote-resume", recoverableDisconnect: true, runtime: params.runtime },
    );
  }
  if (authority.host !== params.configuredHost) {
    throw new BrowserAutomationError(
      `Remote transaction host mismatch; refusing to send credentials to ${authority.host}.`,
      { stage: "remote-resume", recoverableDisconnect: true, runtime: params.runtime },
    );
  }
  const endpoint = parseRemoteHost(params.configuredHost);
  const deadlines = resolveRemoteTransportDeadlines(undefined);
  const receipt = await recoverRemoteRunTransaction({
    ...endpoint,
    token: params.authToken,
    transactionToken: authority.transactionToken,
    host: authority.host,
    requestIdentity: authority.requestIdentity,
    settlementMode: authority.settlementMode,
    interruption: new RemoteTransportInterruption("Resuming persisted remote transaction."),
    deadlines,
  });
  const persistedEpoch = params.runtime.promptEpoch;
  if (persistedEpoch) {
    assertPromptEpochIdentity(receipt.runtime.promptEpoch, persistedEpoch, params.runtime);
  } else {
    assertPromptEpochMatchesRequestIdentity(
      receipt.runtime.promptEpoch,
      authority.requestIdentity,
      params.runtime,
    );
  }
  return await buildRemoteBrowserTransaction({
    receipt,
    ...endpoint,
    token: params.authToken,
    host: authority.host,
    requestIdentity: authority.requestIdentity,
    settlementMode: authority.settlementMode,
    options: {
      sessionId: params.sessionId,
      log: params.log,
      runtimeHintCb: params.runtimeHintCb,
    },
    deadlines,
  });
}

function assertPromptEpochIdentity(
  received: BrowserPromptEpoch,
  expected: BrowserPromptEpoch,
  runtime: BrowserRuntimeMetadata,
): void {
  if (
    received.status !== "committed" ||
    expected.status !== "committed" ||
    received.epochId !== expected.epochId ||
    received.promptSha256 !== expected.promptSha256 ||
    received.baselineTurns !== expected.baselineTurns ||
    received.followUpOrdinal !== expected.followUpOrdinal ||
    received.remainingFollowUps !== expected.remainingFollowUps ||
    received.verifiedUserTurnIndex !== expected.verifiedUserTurnIndex ||
    received.verifiedUserTurnId !== expected.verifiedUserTurnId ||
    received.verifiedUserMessageId !== expected.verifiedUserMessageId ||
    received.conversationId !== expected.conversationId
  ) {
    throw new BrowserAutomationError(
      "Remote transaction prompt epoch does not match the persisted conversation authority.",
      {
        stage: "remote-protocol",
        code: "remote-prompt-authority-mismatch",
        recoverableDisconnect: true,
        runtime,
      },
    );
  }
}

function assertPromptEpochMatchesRequestIdentity(
  received: BrowserPromptEpoch,
  requestIdentity: BrowserRemotePromptRequestIdentity | undefined,
  runtime: BrowserRuntimeMetadata,
): void {
  if (
    !requestIdentity ||
    requestIdentity.remainingFollowUps !== 0 ||
    !Number.isInteger(requestIdentity.followUpOrdinal) ||
    requestIdentity.followUpOrdinal < 0 ||
    requestIdentity.followUpOrdinal > 32 ||
    requestIdentity.acceptedPromptSha256.length === 0 ||
    new Set(requestIdentity.acceptedPromptSha256).size !==
      requestIdentity.acceptedPromptSha256.length ||
    !requestIdentity.acceptedPromptSha256.every((digest) => /^[a-f0-9]{64}$/.test(digest)) ||
    received.status !== "committed" ||
    !requestIdentity.acceptedPromptSha256.includes(received.promptSha256) ||
    received.followUpOrdinal !== requestIdentity.followUpOrdinal ||
    received.remainingFollowUps !== requestIdentity.remainingFollowUps
  ) {
    throw new BrowserAutomationError(
      "Remote transaction prompt epoch does not match the persisted request identity.",
      {
        stage: "remote-protocol",
        code: "remote-prompt-authority-mismatch",
        recoverableDisconnect: true,
        runtime,
      },
    );
  }
}

async function buildRemoteBrowserTransaction(params: {
  receipt: RemoteRunTransactionPayload;
  hostname: string;
  port: number;
  token?: string;
  host: string;
  requestIdentity?: BrowserRemotePromptRequestIdentity;
  settlementMode?: "finalize" | "abort";
  options: Pick<BrowserRunOptions, "sessionId" | "log" | "runtimeHintCb">;
  deadlines: ResolvedRemoteTransportDeadlines;
}): Promise<BrowserRunTransaction> {
  const remoteRecovery: BrowserRemoteRecoveryMetadata | null =
    params.receipt.state === "pending"
      ? {
          protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
          host: params.host,
          transactionToken: params.receipt.transactionToken,
          state: "pending",
          requestIdentity: params.requestIdentity,
          settlementMode: params.settlementMode,
        }
      : null;
  let runtime = projectRemoteRuntime(params.receipt.runtime, remoteRecovery);
  let requiredArtifactDeliveryComplete = !params.receipt.artifacts.some(
    (descriptor) => descriptor.required,
  );
  let transaction!: BrowserRunTransaction;
  let settlementMode = params.settlementMode;
  let settlementInFlight: Promise<BrowserCaptureFinalizationResult> | null = null;
  let completedSettlement: BrowserCaptureFinalizationResult | null = null;
  const settle = async (mode: "finalize" | "abort"): Promise<BrowserCaptureFinalizationResult> => {
    if (settlementMode && settlementMode !== mode) {
      throw settlementModeConflict(mode, settlementMode, runtime);
    }
    if (completedSettlement) return completedSettlement;
    if (settlementInFlight) return settlementInFlight;
    settlementMode = mode;
    const attempt = (async (): Promise<BrowserCaptureFinalizationResult> => {
      const boundRuntime = bindRemoteSettlementMode(runtime, mode);
      if (boundRuntime !== runtime) {
        runtime = boundRuntime;
        transaction.runtime = runtime;
        try {
          await params.options.runtimeHintCb?.(runtime, params.receipt.result.modelSelection);
        } catch (error) {
          throw new BrowserAutomationError(
            `Failed to persist remote ${mode} authority before settlement.`,
            {
              stage: "remote-runtime-persistence",
              code: "settlement-authority-persistence-failed",
              recoverableDisconnect: true,
              runtime,
              remoteRecovery: runtime.remoteRecovery,
            },
            error,
          );
        }
      }
      const finalization = await settleRemoteBrowserTransaction({
        hostname: params.hostname,
        port: params.port,
        token: params.token,
        host: params.host,
        transactionToken: params.receipt.transactionToken,
        recoveryState: runtime.remoteRecovery?.state ?? "pending",
        mode,
        runtime,
        deadlines: params.deadlines,
      });
      runtime = finalization.runtime;
      transaction.runtime = runtime;
      if (finalization.status === "completed") completedSettlement = finalization;
      return finalization;
    })();
    settlementInFlight = attempt;
    try {
      return await attempt;
    } finally {
      if (settlementInFlight === attempt) settlementInFlight = null;
    }
  };
  transaction = {
    ...params.receipt.result,
    runtime,
    finalize: async () => {
      if (!requiredArtifactDeliveryComplete) {
        const error =
          "Remote finalize remains retryable until every required artifact is delivered.";
        return {
          status: "pending",
          runtime: {
            ...runtime,
            recoveryCleanupResult: { status: "failed", error },
          },
          error,
        };
      }
      return await settle("finalize");
    },
    abort: () => settle("abort"),
  };

  try {
    await params.options.runtimeHintCb?.(runtime, params.receipt.result.modelSelection);
  } catch (error) {
    throw new BrowserAutomationError(
      "Failed to persist the received remote transaction authority; the pre-receipt authority remains recoverable.",
      {
        stage: "remote-runtime-persistence",
        recoverableDisconnect: true,
        runtime,
        remoteRecovery: runtime.remoteRecovery,
      },
      error,
    );
  }

  const transferredFiles: SavedBrowserFile[] = [];
  const transferFailures: string[] = [];
  for (const descriptor of params.receipt.artifacts) {
    try {
      const transferred = await transferRemoteArtifact({
        hostname: params.hostname,
        port: params.port,
        token: params.token,
        descriptor,
        transactionToken: params.receipt.transactionToken,
        sessionId: params.options.sessionId,
        log: params.options.log,
        deadlines: params.deadlines,
      });
      transferredFiles.push(transferred);
    } catch (error) {
      const filename = sanitizeArtifactFilename(descriptor.filename, "artifact.bin");
      const message = `Oracle captured the browser text response, but bridge artifact transfer failed for ${filename}. Reason: ${
        error instanceof Error ? error.message : String(error)
      }`;
      params.options.log?.(`[browser] ${message}`);
      if (descriptor.required) {
        throw new BrowserAutomationError(message, {
          stage: "remote-artifact-transfer",
          recoverableDisconnect: true,
          transactionToken: params.receipt.transactionToken,
          runtime,
          remoteRecovery: runtime.remoteRecovery,
        });
      }
      transferFailures.push(message);
    }
  }
  requiredArtifactDeliveryComplete = true;
  Object.assign(
    transaction,
    mergeTransferredArtifacts(params.receipt.result, transferredFiles, transferFailures),
  );
  return transaction;
}

async function settleRemoteBrowserTransaction(params: {
  transactionToken: string;
  recoveryState: BrowserRemoteRecoveryMetadata["state"];
  hostname: string;
  port: number;
  token?: string;
  host: string;
  mode: "finalize" | "abort";
  runtime: BrowserRuntimeMetadata;
  deadlines: ResolvedRemoteTransportDeadlines;
}): Promise<BrowserCaptureFinalizationResult> {
  try {
    const response = await postRemoteJson({
      hostname: params.hostname,
      port: params.port,
      path: `/transactions/${params.transactionToken}/${params.mode}`,
      token: params.token,
      body: params.mode === "finalize" ? { durablePublication: true } : {},
      overallTimeoutMs: params.deadlines.controlOverallTimeoutMs,
      idleTimeoutMs: params.deadlines.socketIdleTimeoutMs,
      operation: `Remote ${params.mode} request`,
    });
    if (response.statusCode !== 200) {
      throw new BrowserAutomationError(response.errorMessage, {
        stage: `remote-${params.mode}`,
        statusCode: response.statusCode,
        transactionToken: params.transactionToken,
      });
    }
    const settlement = RemoteTransactionSettlementResponseSchema.parse(
      response.json,
    ) as RemoteTransactionSettlementResponse;
    if (settlement.transactionToken !== params.transactionToken) {
      throw new BrowserAutomationError("Remote settlement token did not match the request.", {
        stage: "remote-protocol",
        transactionToken: params.transactionToken,
      });
    }
    const expectedTerminalState = params.mode === "finalize" ? "finalized" : "aborted";
    if (settlement.state !== "pending" && settlement.state !== expectedTerminalState) {
      throw new BrowserAutomationError(
        `Remote settlement state ${settlement.state} is inconsistent with ${params.mode}.`,
        { stage: "remote-protocol", transactionToken: params.transactionToken },
      );
    }
    const keepRecovery = settlement.finalization.status === "pending";
    const currentAuthority = findRemoteRecoveryAuthority(params.runtime);
    const remoteRecovery = keepRecovery
      ? ({
          protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
          host: params.host,
          transactionToken: params.transactionToken,
          state: params.recoveryState,
          requestIdentity: currentAuthority?.requestIdentity,
          settlementMode: params.mode,
        } satisfies BrowserRemoteRecoveryMetadata)
      : null;
    const runtime = projectRemoteRuntime(settlement.finalization.runtime, remoteRecovery);
    if (settlement.finalization.status === "pending") {
      runtime.recoveryCleanupResult = {
        status: "failed",
        error: settlement.finalization.error,
      };
    }
    return { ...settlement.finalization, runtime };
  } catch (error) {
    const message = `Remote ${params.mode} remains retryable: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return {
      status: "pending",
      runtime: {
        ...params.runtime,
        recoveryCleanupResult: { status: "failed", error: message },
      },
      error: message,
    };
  }
}

function projectRemoteRuntime(
  runtime: RemotePublicRuntime,
  remoteRecovery: BrowserRemoteRecoveryMetadata | null,
): BrowserRuntimeMetadata {
  const promptEpoch = runtime.promptEpoch;
  return {
    conversationId: promptEpoch?.conversationId,
    promptEpoch,
    recoveryCleanupResources: remoteRecovery
      ? [
          {
            conversationId: promptEpoch?.conversationId,
            promptEpoch,
            remoteRecovery,
            recoveryCleanup: {
              transport: "remote",
              ownsTarget: false,
              profileKind: "none",
              keepBrowser: false,
            },
          },
        ]
      : undefined,
    ...(remoteRecovery && remoteRecovery.state !== "pre-receipt"
      ? { recoveryCleanupResult: { status: "pending" as const } }
      : {}),
    remoteRecovery: remoteRecovery ?? undefined,
  };
}

function findRemoteRecoveryAuthority(
  runtime: BrowserRuntimeMetadata,
): BrowserRemoteRecoveryMetadata | undefined {
  if (runtime.remoteRecovery) return runtime.remoteRecovery;
  return runtime.recoveryCleanupResources?.find((resource) => resource.remoteRecovery)
    ?.remoteRecovery;
}

function bindRemoteSettlementMode(
  runtime: BrowserRuntimeMetadata,
  mode: "finalize" | "abort",
): BrowserRuntimeMetadata {
  const authority = findRemoteRecoveryAuthority(runtime);
  if (!authority) {
    throw new BrowserAutomationError("Remote settlement authority is missing.", {
      stage: "remote-settlement",
      recoverableDisconnect: true,
      runtime,
    });
  }
  const authorities = [
    runtime.remoteRecovery,
    ...(runtime.recoveryCleanupResources?.map((resource) => resource.remoteRecovery) ?? []),
  ].filter((candidate): candidate is BrowserRemoteRecoveryMetadata => Boolean(candidate));
  const conflicting = authorities.find(
    (candidate) => candidate.settlementMode && candidate.settlementMode !== mode,
  );
  if (conflicting?.settlementMode) {
    throw settlementModeConflict(mode, conflicting.settlementMode, runtime);
  }
  const alreadyBound =
    runtime.remoteRecovery?.settlementMode === mode &&
    (runtime.recoveryCleanupResources ?? []).every(
      (resource) => !resource.remoteRecovery || resource.remoteRecovery.settlementMode === mode,
    );
  if (alreadyBound) return runtime;
  const boundAuthority = { ...authority, settlementMode: mode };
  return {
    ...runtime,
    remoteRecovery: boundAuthority,
    recoveryCleanupResources: runtime.recoveryCleanupResources?.map((resource) =>
      resource.remoteRecovery
        ? {
            ...resource,
            remoteRecovery: { ...resource.remoteRecovery, settlementMode: mode },
          }
        : resource,
    ),
  };
}

function settlementModeConflict(
  requestedMode: "finalize" | "abort",
  persistedMode: "finalize" | "abort",
  runtime: BrowserRuntimeMetadata,
): BrowserAutomationError {
  return new BrowserAutomationError(
    `Remote recovery is already bound to ${persistedMode} settlement; refusing ${requestedMode}.`,
    {
      stage: "remote-settlement",
      code: "settlement-mode-conflict",
      recoverableDisconnect: true,
      runtime,
    },
  );
}

function assertRemoteTransactionOwnership(
  transaction: RemoteRunTransactionPayload,
  expectedTransactionToken: string,
): void {
  if (transaction.transactionToken !== expectedTransactionToken) {
    throw new BrowserAutomationError("Remote transaction token did not match the request.", {
      stage: "remote-protocol",
      transactionToken: expectedTransactionToken,
    });
  }
  if (transaction.artifacts.some((artifact) => artifact.runId !== transaction.runId)) {
    throw new BrowserAutomationError("Remote artifact ownership did not match the transaction.", {
      stage: "remote-protocol",
      transactionToken: expectedTransactionToken,
    });
  }
}

function rehydrateRemoteBrowserError(
  error: RemoteBrowserAutomationErrorPayload,
  host: string,
  expectedTransactionToken?: string,
  authority: {
    requestIdentity?: BrowserRemotePromptRequestIdentity;
    settlementMode?: "finalize" | "abort";
  } = {},
): BrowserAutomationError {
  if (!error.recoverableDisconnect) {
    return new BrowserAutomationError(error.message, {
      code: error.code,
      stage: error.stage,
      recoverableDisconnect: false,
    });
  }
  const transactionToken = expectedTransactionToken ?? error.recoveryToken;
  const remoteRecovery: BrowserRemoteRecoveryMetadata = {
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    host,
    transactionToken,
    state: "recoverable-error",
    requestIdentity: authority.requestIdentity,
    settlementMode: authority.settlementMode,
  };
  const runtime = projectRemoteRuntime(error.runtime, remoteRecovery);
  if (expectedTransactionToken && error.recoveryToken !== expectedTransactionToken) {
    return new BrowserAutomationError("Remote recovery token did not match the request.", {
      stage: "remote-protocol",
      transactionToken: expectedTransactionToken,
      recoverableDisconnect: true,
      remoteRecovery,
      runtime,
    });
  }
  return new BrowserAutomationError(error.message, {
    code: error.code,
    stage: error.stage,
    recoverableDisconnect: true,
    remoteRecovery,
    runtime,
  });
}

interface RemoteJsonResponse {
  statusCode: number;
  json: unknown;
  errorMessage: string;
}

async function postRemoteJson(params: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  body: unknown;
  overallTimeoutMs: number;
  idleTimeoutMs: number;
  operation: string;
}): Promise<RemoteJsonResponse> {
  const body = Buffer.from(JSON.stringify(params.body));
  const deferred = createDeferred<RemoteJsonResponse>();
  let deadlineGuard: RequestDeadlineGuard | null = null;
  const resolve = (response: RemoteJsonResponse) => {
    deadlineGuard?.clear();
    deferred.resolve(response);
  };
  const reject = (error: unknown) => {
    deadlineGuard?.clear();
    deferred.reject(error);
  };
  const req = http.request(
    {
      hostname: params.hostname,
      port: params.port,
      path: params.path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
      },
    },
    (res) => {
      deadlineGuard?.watchResponse(res);
      collectResponseBody(res, 16 * 1024 * 1024)
        .then((raw) => {
          let json: unknown = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            // The status and raw body still produce a typed protocol error at the caller.
          }
          const errorMessage =
            json &&
            typeof json === "object" &&
            "message" in json &&
            typeof json.message === "string"
              ? json.message
              : raw || `Remote host responded with status ${res.statusCode}`;
          resolve({ statusCode: res.statusCode ?? 0, json, errorMessage });
        })
        .catch(reject);
    },
  );
  deadlineGuard = attachRequestDeadlines(req, {
    overallTimeoutMs: params.overallTimeoutMs,
    idleTimeoutMs: params.idleTimeoutMs,
    operation: params.operation,
  });
  req.on("error", reject);
  req.end(body);
  return await deferred.promise;
}

async function collectResponseBody(
  res: http.IncomingMessage,
  maximumBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of res) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    receivedBytes += buffer.byteLength;
    if (receivedBytes > maximumBytes) throw new Error("Remote response exceeded size limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, receivedBytes).toString("utf8");
}

async function transferRemoteArtifact(params: {
  hostname: string;
  port: number;
  token?: string;
  descriptor: RemoteArtifactDescriptor;
  transactionToken: string;
  sessionId?: string;
  log?: BrowserRunOptions["log"];
  deadlines: ResolvedRemoteTransportDeadlines;
}): Promise<SavedBrowserFile> {
  RemoteArtifactDescriptorSchema.parse(params.descriptor);
  const sessionId = params.sessionId ?? params.descriptor.runId;
  const artifactsDir = resolveSessionArtifactsDir(sessionId);
  await mkdir(artifactsDir, { recursive: true });
  const sourceFilename = sanitizeArtifactFilename(
    params.descriptor.filename,
    `artifact-${params.descriptor.artifactId}.bin`,
  );
  const extension = path.extname(sourceFilename).slice(0, 16);
  const publishedFilename = `artifact-${params.descriptor.artifactId}${extension}`;
  const finalPath = path.join(artifactsDir, publishedFilename);
  const partPath = `${finalPath}.part`;
  const artifactPath = `/transactions/${encodeURIComponent(params.transactionToken)}/artifacts/${encodeURIComponent(
    params.descriptor.artifactId,
  )}`;

  let verified = await verifyAndSyncArtifactFile(finalPath, params.descriptor).catch((error) => {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (verified) {
    await syncDirectoryIfSupported(artifactsDir);
    params.log?.(`[browser] Reusing verified artifact ${sourceFilename}.`);
  } else {
    await rm(partPath, { force: true }).catch(() => undefined);
    params.log?.(`[browser] Transferring artifact ${sourceFilename} from bridge host...`);
    await downloadArtifactToFile({
      hostname: params.hostname,
      port: params.port,
      path: artifactPath,
      token: params.token,
      targetPath: partPath,
      descriptor: params.descriptor,
      deadlines: params.deadlines,
    }).catch(async (error) => {
      await rm(partPath, { force: true }).catch(() => undefined);
      throw error;
    });
    try {
      await verifyAndSyncArtifactFile(partPath, params.descriptor);
      await rename(partPath, finalPath);
      await syncDirectoryIfSupported(artifactsDir);
      verified = await verifyAndSyncArtifactFile(finalPath, params.descriptor);
    } catch (error) {
      await rm(partPath, { force: true }).catch(() => undefined);
      throw error;
    }
    params.log?.(`[browser] Transferred artifact to ${finalPath}`);
  }
  if (!verified) throw new Error("artifact durability verification did not complete");

  const validation = await validateArtifactFile({
    path: finalPath,
    filename: sourceFilename,
    mimeType: sanitizeArtifactMimeType(params.descriptor.mimeType),
  });
  if (!validation.ok) {
    throw new Error(`${validation.type} validation failed: ${validation.error ?? "invalid"}`);
  }
  const receipt = await postRemoteJson({
    hostname: params.hostname,
    port: params.port,
    path: `/transactions/${encodeURIComponent(params.transactionToken)}/artifacts/${encodeURIComponent(
      params.descriptor.artifactId,
    )}/receipt`,
    token: params.token,
    body: RemoteArtifactDeliveryReceiptRequestSchema.parse({
      sha256: verified.sha256,
      byteSize: verified.size,
    }),
    overallTimeoutMs: params.deadlines.controlOverallTimeoutMs,
    idleTimeoutMs: params.deadlines.socketIdleTimeoutMs,
    operation: "Remote artifact receipt request",
  });
  if (receipt.statusCode < 200 || receipt.statusCode >= 300) {
    throw new Error(receipt.errorMessage);
  }

  return {
    kind: "file",
    path: finalPath,
    label: sourceFilename,
    mimeType: sanitizeArtifactMimeType(params.descriptor.mimeType),
    sizeBytes: verified.size,
    sourceUrl: "bridge-artifact",
    sha256: verified.sha256,
    validation,
    transfer: { status: "completed", bytes: verified.size },
    origin: { mode: "bridge" },
    url: "bridge-artifact",
    finalUrl: "bridge-artifact",
    filename: publishedFilename,
  };
}

async function downloadArtifactToFile(params: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  targetPath: string;
  descriptor: RemoteArtifactDescriptor;
  deadlines: ResolvedRemoteTransportDeadlines;
}): Promise<void> {
  const deferred = createDeferred<void>();
  let deadlineGuard: RequestDeadlineGuard | null = null;
  const resolve = () => {
    deadlineGuard?.clear();
    deferred.resolve();
  };
  const reject = (error: unknown) => {
    deadlineGuard?.clear();
    deferred.reject(error);
  };
  const req = http.request(
    {
      hostname: params.hostname,
      port: params.port,
      path: params.path,
      method: "GET",
      headers: params.token ? { authorization: `Bearer ${params.token}` } : undefined,
    },
    (res) => {
      deadlineGuard?.watchResponse(res);
      if (res.statusCode !== 200) {
        collectError(res).then((message) => reject(new Error(message)), reject);
        return;
      }
      const headerSha = String(res.headers["x-oracle-artifact-sha256"] ?? "");
      if (headerSha && headerSha !== params.descriptor.sha256) {
        res.resume();
        reject(new Error("artifact sha256 header mismatch"));
        return;
      }
      const contentLengthHeader = res.headers["content-length"];
      const contentLength =
        typeof contentLengthHeader === "string" ? Number(contentLengthHeader) : undefined;
      if (
        contentLength !== undefined &&
        (!Number.isSafeInteger(contentLength) ||
          contentLength <= 0 ||
          contentLength > MAX_REMOTE_ARTIFACT_BYTES ||
          contentLength !== params.descriptor.byteSize)
      ) {
        res.resume();
        reject(new Error("artifact content-length mismatch"));
        return;
      }
      void (async () => {
        const handle = await open(params.targetPath, "wx", 0o600);
        try {
          let receivedBytes = 0;
          for await (const value of res) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            receivedBytes += chunk.length;
            if (
              receivedBytes > params.descriptor.byteSize ||
              receivedBytes > MAX_REMOTE_ARTIFACT_BYTES
            ) {
              throw new Error("artifact exceeded declared size");
            }
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await handle.write(
                chunk,
                offset,
                chunk.length - offset,
                null,
              );
              if (bytesWritten <= 0) throw new Error("artifact write made no progress");
              offset += bytesWritten;
            }
          }
          if (receivedBytes !== params.descriptor.byteSize) {
            throw new Error("artifact size did not match the durable descriptor");
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
      })().then(resolve, reject);
    },
  );
  deadlineGuard = attachRequestDeadlines(req, {
    overallTimeoutMs: params.deadlines.artifactOverallTimeoutMs,
    idleTimeoutMs: params.deadlines.socketIdleTimeoutMs,
    operation: "Remote artifact download",
  });
  req.on("error", reject);
  req.end();
  await deferred.promise;
}

async function verifyAndSyncArtifactFile(
  artifactPath: string,
  descriptor: RemoteArtifactDescriptor,
): Promise<{ size: number; sha256: string }> {
  const handle = await open(artifactPath, "r+");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== descriptor.byteSize) {
      throw new Error("local artifact does not match the durable descriptor");
    }
    const hash = createHash("sha256");
    const input = handle.createReadStream({ autoClose: false, start: 0 });
    for await (const chunk of input) hash.update(chunk);
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error("local artifact changed during durability verification");
    }
    const sha256 = hash.digest("hex");
    if (sha256 !== descriptor.sha256) {
      throw new Error("local artifact sha256 does not match the durable descriptor");
    }
    await handle.chmod(0o600);
    await handle.sync();
    return { size: after.size, sha256 };
  } finally {
    await handle.close();
  }
}

function readErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function mergeTransferredArtifacts(
  result: BrowserRunResult,
  transferredFiles: SavedBrowserFile[],
  transferFailures: string[],
): BrowserRunResult {
  const artifacts = appendArtifacts(result.artifacts, transferredFiles);
  const savedFiles = appendSavedFiles(result.savedFiles, transferredFiles);
  const warnings = [
    ...(result.warnings ?? []),
    ...transferFailures.map((message) => ({
      code: "remote-artifact-transfer-failed",
      severity: "warning" as const,
      message,
    })),
  ];
  return {
    ...result,
    artifacts,
    savedFiles,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function appendSavedFiles(
  existing: SavedBrowserFile[] | undefined,
  additions: SavedBrowserFile[],
): SavedBrowserFile[] | undefined {
  const merged = new Map<string, SavedBrowserFile>();
  for (const artifact of existing ?? []) {
    merged.set(artifact.path, artifact);
  }
  for (const artifact of additions) {
    merged.set(artifact.path, artifact);
  }
  const values = Array.from(merged.values());
  return values.length > 0 ? values : undefined;
}

async function collectError(res: http.IncomingMessage): Promise<string> {
  const raw = await collectResponseBody(res, 1024 * 1024);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      if ("message" in parsed && typeof parsed.message === "string") return parsed.message;
      if ("error" in parsed && typeof parsed.error === "string") return parsed.error;
    }
  } catch {
    // Fall through to the bounded raw response.
  }
  return raw || `Remote host responded with status ${res.statusCode}`;
}
