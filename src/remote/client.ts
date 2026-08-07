import { randomBytes } from "node:crypto";
import path from "node:path";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open } from "node:fs/promises";
import type { BrowserRunOptions } from "../browserMode.js";
import type {
  BrowserAttachment,
  BrowserLogger,
  BrowserRunResult,
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
  type RemoteArtifactDescriptor,
  type RemoteBrowserRunConfig,
  type RemoteRunTransactionPayload,
  type RemoteTransportDeadlines,
} from "./types.js";
import { RemoteLegacyRunPayloadSchema, type RemoteLegacyTextResult } from "./legacyProtocol.js";
import { checkRemoteHealth } from "./health.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { OwnedBrowserResourceTransaction } from "../browser/ownedBrowserResources.js";
import { createBrowserRunTransaction } from "../browser/runLifecycle.js";
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
  settleRemoteBrowserTransaction,
  settlementModeConflict as remoteSettlementModeConflict,
  unresolvedRemoteTransactionRuntime,
} from "./clientRecovery.js";
import {
  mergeTransferredArtifacts,
  transferRemoteArtifact,
  waiveRemoteArtifactDelivery,
  type TransferRemoteArtifactDeps,
} from "./clientArtifacts.js";
import { assertRemoteTransactionToken } from "./transactionToken.js";
import {
  physicalFileSnapshotFromStats,
  samePhysicalFileSnapshot,
} from "../physicalFileIdentity.js";

export { settleRemoteBrowserRecovery } from "./clientRecovery.js";

export interface RemoteExecutorOptions {
  host: string;
  token?: string;
  legacyToken?: string;
  allowLegacyTextProtocol?: boolean;
  deadlines?: RemoteTransportDeadlines;
}

export interface RemoteExecutorDeps {
  readonly artifactTransferDeps?: TransferRemoteArtifactDeps;
}

export type RemoteBrowserExecutor = (options: BrowserRunOptions) => Promise<BrowserRunResult>;

export type RemoteBrowserTransactionExecutor = (
  options: BrowserRunOptions,
) => Promise<BrowserRunTransaction>;

export function createRemoteBrowserExecutor(
  options: RemoteExecutorOptions,
  deps: RemoteExecutorDeps = {},
): RemoteBrowserExecutor {
  const executeTransaction = createRemoteBrowserTransactionExecutor(options, deps);
  return async (runOptions) => {
    const transaction = await executeTransaction(runOptions);
    const finalization = await transaction.finalize();
    const {
      runtime: _runtime,
      bindSettlement: _bindSettlement,
      finalize: _finalize,
      abort: _abort,
      ...result
    } = transaction;
    if (finalization.status === "pending") {
      result.warnings = [
        ...(result.warnings ?? []),
        {
          code: "direct-finalize-cleanup-pending",
          severity: "warning",
          message: "The assistant answer is complete, but remote browser cleanup remains pending.",
          details: { stage: "remote-browser-capture-finalization" },
        },
      ];
    }
    return result;
  };
}

interface RemoteAttachmentBudget {
  count: number;
  bytes: number;
}

export function createRemoteBrowserTransactionExecutor(
  { host, token, legacyToken, allowLegacyTextProtocol = false, deadlines }: RemoteExecutorOptions,
  deps: RemoteExecutorDeps = {},
): RemoteBrowserTransactionExecutor {
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
    assertRemoteTransactionToken(transactionToken);
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
          rehydrateRemoteBrowserError(remoteError, host, transactionToken, {
            requestIdentity,
            authoritativeRuntime: preReceiptRuntime,
          }),
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
        error.details?.recoverableDisconnect === false
      ) {
        const terminalRuntime = error.details.runtime as BrowserRuntimeMetadata | undefined;
        if (terminalRuntime) await options.runtimeHintCb?.(terminalRuntime);
        throw error;
      } else if (
        error instanceof BrowserAutomationError &&
        error.details?.recoverableDisconnect !== false &&
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
      artifactTransferDeps: deps.artifactTransferDeps,
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

const remoteAttachmentOpenFlags =
  constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);

function isSerializableAttachment(entry: BigIntStats): boolean {
  return (
    entry.isFile() &&
    !entry.isSymbolicLink() &&
    entry.nlink === 1n &&
    entry.size > 0n &&
    entry.size <= BigInt(MAX_REMOTE_ATTACHMENT_BYTES)
  );
}

function sameSerializableAttachment(left: BigIntStats, right: BigIntStats): boolean {
  return (
    samePhysicalFileSnapshot(
      physicalFileSnapshotFromStats(left),
      physicalFileSnapshotFromStats(right),
    ) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink
  );
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
    let handle: FileHandle | undefined;
    let namedBeforeRead: BigIntStats;
    let fileStat: BigIntStats;
    let content: Buffer;
    try {
      try {
        namedBeforeRead = await lstat(attachment.path, { bigint: true });
        handle = await open(attachment.path, remoteAttachmentOpenFlags);
        fileStat = await handle.stat({ bigint: true });
      } catch (error) {
        throw new BrowserAutomationError(
          `Unable to inspect remote browser attachment ${attachment.displayPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { stage: "remote-request", attachment: attachment.displayPath },
          error,
        );
      }
      if (!isSerializableAttachment(namedBeforeRead) || !isSerializableAttachment(fileStat)) {
        throw new BrowserAutomationError(
          `Remote browser attachment exceeds the ${MAX_REMOTE_ATTACHMENT_BYTES}-byte per-file limit: ${attachment.displayPath}`,
          { stage: "remote-request", attachment: attachment.displayPath },
        );
      }
      if (!sameSerializableAttachment(namedBeforeRead, fileStat)) {
        throw new BrowserAutomationError(
          `Remote browser attachment changed while it was being read: ${attachment.displayPath}`,
          { stage: "remote-request", attachment: attachment.displayPath },
        );
      }
      if (budget.bytes + Number(fileStat.size) > MAX_REMOTE_TOTAL_ATTACHMENT_BYTES) {
        throw new BrowserAutomationError(
          "Remote browser attachments exceed the aggregate protocol size limit.",
          { stage: "remote-request" },
        );
      }
      try {
        content = await handle.readFile();
      } catch (error) {
        throw new BrowserAutomationError(
          `Unable to read remote browser attachment ${attachment.displayPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { stage: "remote-request", attachment: attachment.displayPath },
          error,
        );
      }
      let afterRead: BigIntStats;
      let namedAfterRead: BigIntStats;
      try {
        afterRead = await handle.stat({ bigint: true });
        await handle.close();
        handle = undefined;
        namedAfterRead = await lstat(attachment.path, { bigint: true });
      } catch {
        throw new BrowserAutomationError(
          `Remote browser attachment changed while it was being read: ${attachment.displayPath}`,
          { stage: "remote-request", attachment: attachment.displayPath },
        );
      }
      if (
        content.byteLength !== Number(fileStat.size) ||
        !isSerializableAttachment(afterRead) ||
        !sameSerializableAttachment(fileStat, afterRead) ||
        !isSerializableAttachment(namedAfterRead) ||
        !sameSerializableAttachment(afterRead, namedAfterRead)
      ) {
        throw new BrowserAutomationError(
          `Remote browser attachment changed while it was being read: ${attachment.displayPath}`,
          { stage: "remote-request", attachment: attachment.displayPath },
        );
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
    budget.count += 1;
    budget.bytes += content.byteLength;
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
  artifactTransferDeps?: TransferRemoteArtifactDeps;
}): Promise<BrowserRunTransaction> {
  const authority = findRemoteRecoveryAuthority(params.runtime);
  if (!authority || authority.protocolVersion !== REMOTE_TRANSACTION_PROTOCOL_VERSION) {
    throw new BrowserAutomationError(
      "Persisted remote transaction authority is missing or uses an unsupported protocol version.",
      { stage: "remote-resume", recoverableDisconnect: true, runtime: params.runtime },
    );
  }
  assertRemoteTransactionToken(authority.transactionToken);
  if (!params.authToken) {
    throw new BrowserAutomationError(
      "Remote transaction authentication is unavailable; provide --remote-token or configure ORACLE_REMOTE_TOKEN.",
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
    artifactTransferDeps: params.artifactTransferDeps,
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
  artifactTransferDeps?: TransferRemoteArtifactDeps;
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
  const runtime = projectRemoteRecoveryRuntime(
    params.receipt.runtime,
    remoteRecovery,
    params.authoritativeRuntime,
  );
  const initialRuntime = params.settlementMode
    ? bindRemoteSettlementMode(runtime, params.settlementMode)
    : runtime;
  const pendingManualCopyWaivers = new Map<string, RemoteArtifactDescriptor>();
  let settlement!: OwnedBrowserResourceTransaction;
  const persistManualCopyWaiver = async (descriptor: RemoteArtifactDescriptor): Promise<void> => {
    await waiveRemoteArtifactDelivery({
      hostname: params.hostname,
      port: params.port,
      token: params.token,
      descriptor,
      transactionToken: params.receipt.transactionToken,
      deadlines: params.deadlines,
    });
    pendingManualCopyWaivers.delete(descriptor.artifactId);
  };
  const persistPendingManualCopyWaivers = async (): Promise<void> => {
    let lastError: unknown;
    for (const descriptor of pendingManualCopyWaivers.values()) {
      try {
        await persistManualCopyWaiver(descriptor);
      } catch (error) {
        lastError = error;
      }
    }
    if (pendingManualCopyWaivers.size === 0) return;
    throw new BrowserAutomationError(
      "Remote required-artifact manual-copy waiver remains retryable; captured text and cleanup authority are preserved.",
      {
        stage: "remote-artifact-transfer",
        code: "remote-artifact-manual-copy-waiver-pending",
        recoverableDisconnect: true,
        transactionToken: params.receipt.transactionToken,
        runtime: settlement.runtime(),
      },
      lastError,
    );
  };
  settlement = new OwnedBrowserResourceTransaction(
    {
      settlementModeConflict: (requestedMode, boundMode, runtime) =>
        remoteSettlementModeConflict(requestedMode, boundMode, runtime),
      bindSettlementAuthority: async (mode, pendingRuntime) => {
        if (mode === "finalize" && pendingManualCopyWaivers.size > 0) {
          await persistPendingManualCopyWaivers();
        }
        return params.settlementMode
          ? pendingRuntime
          : await bindRemoteBrowserSettlement({
              hostname: params.hostname,
              port: params.port,
              token: params.token,
              host: params.host,
              transactionToken: params.receipt.transactionToken,
              recoveryState: findRemoteRecoveryAuthority(pendingRuntime)?.state ?? "pending",
              mode,
              runtime: pendingRuntime,
              deadlines: params.deadlines,
            });
      },
      persistSettlementBinding: async (mode, boundRuntime) => {
        try {
          await params.options.runtimeHintCb?.(boundRuntime, params.receipt.result.modelSelection);
        } catch (error) {
          throw new BrowserAutomationError(
            `Failed to persist remote ${mode} settlement authority.`,
            {
              stage: "remote-runtime-persistence",
              code: "settlement-authority-persistence-failed",
              recoverableDisconnect: true,
              runtime: boundRuntime,
            },
            error,
          );
        }
        return boundRuntime;
      },
      settleResources: async (mode, pendingRuntime) => {
        if (mode === "finalize" && pendingManualCopyWaivers.size > 0) {
          await persistPendingManualCopyWaivers();
        }
        return await settleRemoteBrowserTransaction({
          hostname: params.hostname,
          port: params.port,
          token: params.token,
          host: params.host,
          transactionToken: params.receipt.transactionToken,
          recoveryState: findRemoteRecoveryAuthority(pendingRuntime)?.state ?? "pending",
          mode,
          runtime: pendingRuntime,
          deadlines: params.deadlines,
        });
      },
    },
    initialRuntime,
  );
  const transaction = createBrowserRunTransaction(params.receipt.result, settlement);

  try {
    await params.options.runtimeHintCb?.(initialRuntime, params.receipt.result.modelSelection);
  } catch (error) {
    throw new BrowserAutomationError(
      "Failed to persist the received remote transaction authority; the pre-receipt authority remains recoverable.",
      {
        stage: "remote-runtime-persistence",
        recoverableDisconnect: true,
        runtime: initialRuntime,
      },
      error,
    );
  }
  const artifactSessionId = params.options.sessionId?.trim() || params.receipt.transactionToken;
  const transferredFiles: SavedBrowserFile[] = [];
  const transferFailures: string[] = [];
  for (const descriptor of params.receipt.artifacts) {
    try {
      const transferred = await transferRemoteArtifact(
        {
          hostname: params.hostname,
          port: params.port,
          token: params.token,
          descriptor,
          transactionToken: params.receipt.transactionToken,
          sessionId: artifactSessionId,
          log: params.options.log,
          deadlines: params.deadlines,
        },
        params.artifactTransferDeps,
      );
      transferredFiles.push(transferred);
    } catch (error) {
      const filename = sanitizeArtifactFilename(descriptor.filename, "artifact.bin");
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
      let failure = `${filename}: ${reason}`;
      if (descriptor.required) {
        pendingManualCopyWaivers.set(descriptor.artifactId, descriptor);
        try {
          await persistManualCopyWaiver(descriptor);
        } catch (waiverError) {
          const waiverReason = (
            waiverError instanceof Error ? waiverError.message : String(waiverError)
          ).slice(0, 1024);
          failure += ` Manual-copy waiver remains pending: ${waiverReason}`;
        }
      }
      params.options.log?.(
        `[browser] Oracle captured the browser text response, but bridge artifact transfer failed for ${failure}`,
      );
      transferFailures.push(failure);
    }
  }
  Object.assign(
    transaction,
    mergeTransferredArtifacts(
      params.receipt.result,
      transferredFiles,
      transferFailures,
      params.host,
    ),
  );
  return transaction;
}

function legacyTextTransaction(result: RemoteLegacyTextResult): BrowserRunTransaction {
  const settlement = new OwnedBrowserResourceTransaction(
    {
      settleResources: async (_mode, runtime) => ({ status: "completed", runtime }),
    },
    {},
  );
  return createBrowserRunTransaction(result, settlement);
}
