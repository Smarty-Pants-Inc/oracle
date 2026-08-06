import { randomBytes } from "node:crypto";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { BrowserRunOptions } from "../browserMode.js";
import type {
  BrowserAttachment,
  BrowserCaptureFinalizationResult,
  BrowserLogger,
  BrowserRunTransaction,
  SavedBrowserFile,
} from "../browser/types.js";
import type {
  BrowserRemotePromptRequestIdentity,
  BrowserRemoteRecoveryMetadata,
  BrowserRuntimeMetadata,
} from "../sessionManager.js";
import { sanitizeArtifactFilename } from "../browser/artifacts.js";
import { assertRemoteCredential } from "./auth.js";
import {
  MAX_REMOTE_ATTACHMENT_BYTES,
  MAX_REMOTE_ATTACHMENTS,
  MAX_REMOTE_PROMPT_CHARS,
  MAX_REMOTE_TOTAL_ATTACHMENT_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  buildRemotePromptRequestIdentity,
  RemoteRunPayloadSchema,
  type RemoteAttachmentPayload,
  type RemoteBrowserRunConfig,
  type RemoteRunTransactionPayload,
  type RemoteTransportDeadlines,
} from "./types.js";
import { RemoteLegacyRunPayloadSchema, type RemoteLegacyTextResult } from "./legacyProtocol.js";
import { checkRemoteHealth } from "./health.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { pendingBrowserCaptureCleanup } from "../browser/runLifecycle.js";
import {
  findRemoteRecoveryAuthority,
  projectRemoteRecoveryRuntime,
} from "./transactionClientRuntime.js";
import {
  parseRemoteHost,
  RemoteTransportInterruption,
  resolveRemoteTransportDeadlines,
  streamLegacyRemoteRun,
  streamRemoteRun,
  type ResolvedRemoteTransportDeadlines,
} from "./clientTransport.js";
import {
  assertPromptEpochIdentity,
  assertPromptEpochMatchesRequestIdentity,
  assertRemoteTransactionOwnership,
  bindRemoteSettlementMode,
  bindRemoteBrowserSettlement,
  recoverRemoteRunTransaction,
  rehydrateRemoteBrowserError,
  settlementModeConflict,
  settleRemoteBrowserTransaction,
  unresolvedRemoteTransactionRuntime,
} from "./clientRecovery.js";
import { mergeTransferredArtifacts, transferRemoteArtifact } from "./clientArtifacts.js";

export { settleRemoteBrowserRecovery } from "./clientRecovery.js";

export interface RemoteExecutorOptions {
  host: string;
  token?: string;
  legacyToken?: string;
  allowLegacyTextProtocol?: boolean;
  deadlines?: RemoteTransportDeadlines;
}

interface RemoteAttachmentBudget {
  count: number;
  bytes: number;
}

export function createRemoteBrowserExecutor({
  host,
  token,
  legacyToken,
  allowLegacyTextProtocol = false,
  deadlines,
}: RemoteExecutorOptions) {
  if (token !== undefined) assertRemoteCredential(token, "Remote v3 HMAC root key");
  if (legacyToken !== undefined) {
    assertRemoteCredential(legacyToken, "Remote legacy bearer credential");
  }
  if (allowLegacyTextProtocol && token && legacyToken && token === legacyToken) {
    throw new Error(
      "Legacy text protocol requires a bearer credential distinct from the v3 HMAC root key.",
    );
  }
  return async function remoteBrowserExecutor(
    options: BrowserRunOptions,
  ): Promise<BrowserRunTransaction> {
    const explicitTabRef = options.config?.browserTabRef?.trim();
    if (explicitTabRef) {
      throw new BrowserAutomationError(
        `Explicit browser tab ${explicitTabRef} cannot be combined with remote browser execution because the remote protocol cannot carry exact tab authority.`,
        {
          stage: "remote-request",
          code: "explicit-browser-tab-unsupported",
          browserTabRef: explicitTabRef,
          remoteHost: host,
        },
      );
    }
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
    if (allowLegacyTextProtocol) {
      const health = await checkRemoteHealth({
        host,
        token,
        legacyToken,
        allowLegacyTextProtocol: true,
        timeoutMs: resolvedDeadlines.controlOverallTimeoutMs,
        idleTimeoutMs: resolvedDeadlines.socketIdleTimeoutMs,
      });
      if (!health.ok) {
        throw new BrowserAutomationError(
          `Remote protocol negotiation failed: ${health.error ?? "unavailable"}`,
          { stage: "remote-connection", statusCode: health.statusCode },
        );
      }
      if (health.protocol === "legacy-text-v1") {
        if (!legacyToken) {
          throw new BrowserAutomationError(
            "Legacy text compatibility requires a distinct scoped legacy bearer credential.",
            { stage: "remote-authentication" },
          );
        }
        options.log?.(
          "[browser] WARNING: explicit legacy text compatibility is active; endpoint identity is not generation-bound and generated files require manual host transfer.",
        );
        const legacyResult = await streamLegacyRemoteRun({
          hostname,
          port,
          legacyToken,
          payload: RemoteLegacyRunPayloadSchema.parse({
            prompt: payload.prompt,
            attachments: payload.attachments,
            fallbackSubmission: payload.fallbackSubmission,
            browserConfig: {
              ...payload.browserConfig,
              keepBrowser: payload.options.keepConversationTab,
            },
            options: {
              heartbeatIntervalMs: Math.max(
                25,
                Math.min(
                  payload.options.heartbeatIntervalMs ?? Number.POSITIVE_INFINITY,
                  Math.max(25, Math.floor(resolvedDeadlines.socketIdleTimeoutMs / 2)),
                ),
              ),
              verbose: payload.options.verbose,
              sessionId: payload.options.sessionId,
              followUpPrompts: payload.options.followUpPrompts,
            },
          }),
          options,
          deadlines: resolvedDeadlines,
        });
        return legacyTextTransaction(legacyResult);
      }
    }
    const preReceiptAuthority: BrowserRemoteRecoveryMetadata = {
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      host,
      transactionToken,
      state: "pre-receipt",
      requestIdentity,
    };
    const preReceiptRuntime = projectRemoteRecoveryRuntime(
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
        deadlines: resolvedDeadlines,
        assertTransactionOwnership: (transaction) =>
          assertRemoteTransactionOwnership(transaction, transactionToken),
        rehydrateError: (remoteError) =>
          rehydrateRemoteBrowserError(remoteError, host, transactionToken, { requestIdentity }),
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
          authoritativeRuntime: preReceiptRuntime,
          interruption: error,
          deadlines: resolvedDeadlines,
        });
      } else if (
        error instanceof BrowserAutomationError &&
        !error.details?.runtime &&
        error.details?.code !== "remote-settlement-mode-conflict"
      ) {
        const runtime = unresolvedRemoteTransactionRuntime(preReceiptAuthority, error.message);
        throw new BrowserAutomationError(
          error.message,
          {
            ...error.details,
            recoverableDisconnect: true,
            runtime,
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
      authoritativeRuntime: preReceiptRuntime,
      options,
      deadlines: resolvedDeadlines,
    });
  };
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
  if (!params.authToken) {
    throw new BrowserAutomationError(
      "Remote transaction authentication is unavailable; configure ORACLE_REMOTE_TOKEN.",
      { stage: "remote-resume", recoverableDisconnect: true, runtime: params.runtime },
    );
  }
  assertRemoteCredential(params.authToken, "Remote v3 HMAC root key");
  if (authority.host !== params.configuredHost) {
    throw new BrowserAutomationError(
      `Remote transaction host mismatch; refusing to send credentials to ${authority.host}.`,
      { stage: "remote-resume", recoverableDisconnect: true, runtime: params.runtime },
    );
  }
  const endpoint = parseRemoteHost(params.configuredHost);
  const deadlines = resolveRemoteTransportDeadlines(undefined);
  const settlementMode = params.runtime.recoveryCleanupResult?.settlementMode;
  const receipt = await recoverRemoteRunTransaction({
    ...endpoint,
    token: params.authToken,
    transactionToken: authority.transactionToken,
    host: authority.host,
    requestIdentity: authority.requestIdentity,
    expectedSettlementMode: settlementMode,
    authoritativeRuntime: params.runtime,
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
    settlementMode,
    authoritativeRuntime: params.runtime,
    options: {
      sessionId: params.sessionId,
      log: params.log,
      runtimeHintCb: params.runtimeHintCb,
    },
    deadlines,
  });
}

async function buildRemoteBrowserTransaction(params: {
  receipt: RemoteRunTransactionPayload;
  hostname: string;
  port: number;
  token?: string;
  host: string;
  requestIdentity?: BrowserRemotePromptRequestIdentity;
  settlementMode?: "finalize" | "abort";
  authoritativeRuntime?: BrowserRuntimeMetadata;
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
        }
      : null;
  let runtime = projectRemoteRecoveryRuntime(
    params.receipt.runtime,
    remoteRecovery,
    params.authoritativeRuntime,
  );
  let selectedSettlementMode = params.settlementMode;
  if (selectedSettlementMode) runtime = bindRemoteSettlementMode(runtime, selectedSettlementMode);
  let settlementBindingPersisted = selectedSettlementMode !== undefined;
  let requiredArtifactDeliveryComplete = !params.receipt.artifacts.some(
    (descriptor) => descriptor.required,
  );
  let transaction!: BrowserRunTransaction;
  let settlementInFlight: {
    mode: "finalize" | "abort";
    promise: Promise<BrowserCaptureFinalizationResult>;
  } | null = null;
  let completedSettlement: BrowserCaptureFinalizationResult | null = null;
  const persistSettlementBinding = async (
    mode: "finalize" | "abort",
  ): Promise<BrowserRuntimeMetadata> => {
    const authoritativeMode =
      runtime.recoveryCleanupResult?.settlementMode ?? selectedSettlementMode;
    if (authoritativeMode && authoritativeMode !== mode) {
      throw settlementModeConflict(mode, authoritativeMode, runtime);
    }
    if (!authoritativeMode) {
      try {
        runtime = await bindRemoteBrowserSettlement({
          hostname: params.hostname,
          port: params.port,
          token: params.token,
          host: params.host,
          transactionToken: params.receipt.transactionToken,
          recoveryState: findRemoteRecoveryAuthority(runtime)?.state ?? "pending",
          mode,
          runtime,
          deadlines: params.deadlines,
        });
        selectedSettlementMode = mode;
        transaction.runtime = runtime;
      } catch (error) {
        if (error instanceof BrowserAutomationError && error.details?.runtime) {
          runtime = error.details.runtime as BrowserRuntimeMetadata;
          transaction.runtime = runtime;
          selectedSettlementMode =
            runtime.recoveryCleanupResult?.settlementMode ??
            (error.details.settlementAuthority as { mode?: "finalize" | "abort" } | undefined)
              ?.mode ??
            selectedSettlementMode;
        }
        throw error;
      }
    }
    if (settlementBindingPersisted) return runtime;
    try {
      await params.options.runtimeHintCb?.(runtime, params.receipt.result.modelSelection);
    } catch (error) {
      throw new BrowserAutomationError(
        `Failed to persist remote ${mode} settlement authority.`,
        {
          stage: "remote-runtime-persistence",
          code: "settlement-authority-persistence-failed",
          recoverableDisconnect: true,
          runtime,
        },
        error,
      );
    }
    settlementBindingPersisted = true;
    return runtime;
  };
  const retryableBindingFailure = (
    error: unknown,
    mode: "finalize" | "abort",
  ): BrowserCaptureFinalizationResult => {
    if (
      error instanceof BrowserAutomationError &&
      (error.details?.code === "settlement-authority-persistence-failed" ||
        error.details?.code === "remote-settlement-binding-transport-failed")
    ) {
      return pendingBrowserCaptureCleanup(runtime, error.message, mode);
    }
    throw error;
  };
  const settle = async (mode: "finalize" | "abort"): Promise<BrowserCaptureFinalizationResult> => {
    const authoritativeMode =
      runtime.recoveryCleanupResult?.settlementMode ?? selectedSettlementMode;
    if (authoritativeMode && authoritativeMode !== mode) {
      throw settlementModeConflict(mode, authoritativeMode, runtime);
    }
    if (completedSettlement) return completedSettlement;
    if (settlementInFlight) {
      if (settlementInFlight.mode !== mode) {
        throw settlementModeConflict(mode, settlementInFlight.mode, runtime);
      }
      return settlementInFlight.promise;
    }
    const attempt = (async (): Promise<BrowserCaptureFinalizationResult> => {
      try {
        await persistSettlementBinding(mode);
      } catch (error) {
        return retryableBindingFailure(error, mode);
      }
      const finalization = await settleRemoteBrowserTransaction({
        hostname: params.hostname,
        port: params.port,
        token: params.token,
        host: params.host,
        transactionToken: params.receipt.transactionToken,
        recoveryState: findRemoteRecoveryAuthority(runtime)?.state ?? "pending",
        mode,
        runtime,
        deadlines: params.deadlines,
      });
      runtime = finalization.runtime;
      transaction.runtime = runtime;
      if (finalization.status === "completed") completedSettlement = finalization;
      return finalization;
    })();
    settlementInFlight = { mode, promise: attempt };
    try {
      return await attempt;
    } finally {
      if (settlementInFlight?.promise === attempt) settlementInFlight = null;
    }
  };
  transaction = {
    ...params.receipt.result,
    runtime,
    bindSettlement: persistSettlementBinding,
    finalize: async () => {
      const authoritativeMode =
        runtime.recoveryCleanupResult?.settlementMode ?? selectedSettlementMode;
      if (authoritativeMode && authoritativeMode !== "finalize") {
        throw settlementModeConflict("finalize", authoritativeMode, runtime);
      }
      if (completedSettlement) return completedSettlement;
      if (!requiredArtifactDeliveryComplete) {
        try {
          await persistSettlementBinding("finalize");
        } catch (error) {
          return retryableBindingFailure(error, "finalize");
        }
        const error =
          "Remote finalize remains retryable until every required artifact is delivered.";
        return pendingBrowserCaptureCleanup(runtime, error, "finalize");
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
      },
      error,
    );
  }
  const artifactSessionId = params.options.sessionId?.trim();
  if (params.receipt.artifacts.length > 0 && !artifactSessionId) {
    throw new BrowserAutomationError(
      "Remote artifact delivery requires the recovering local session identity.",
      {
        stage: "remote-artifact-transfer",
        code: "recovering-session-id-missing",
        recoverableDisconnect: true,
        transactionToken: params.receipt.transactionToken,
        runtime,
      },
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
        sessionId: artifactSessionId as string,
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

function legacyTextTransaction(result: RemoteLegacyTextResult): BrowserRunTransaction {
  let mode: "finalize" | "abort" | undefined;
  const runtime: BrowserRuntimeMetadata = {};
  const bindSettlement = async (requested: "finalize" | "abort") => {
    if (mode && mode !== requested) throw settlementModeConflict(requested, mode, runtime);
    mode = requested;
    return runtime;
  };
  return {
    ...result,
    runtime,
    bindSettlement,
    finalize: async () => ({ status: "completed", runtime: await bindSettlement("finalize") }),
    abort: async () => ({ status: "completed", runtime: await bindSettlement("abort") }),
  };
}
