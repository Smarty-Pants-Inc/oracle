import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import type {
  BrowserPromptEpoch,
  BrowserRemotePromptRequestIdentity,
  BrowserRemoteRecoveryMetadata,
  BrowserRuntimeMetadata,
} from "../sessionManager.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { delay } from "../browser/utils.js";
import {
  markBrowserCaptureCleanupPending,
  pendingBrowserCaptureCleanup,
  projectBrowserCaptureFinalization,
} from "../browser/runLifecycle.js";
import {
  findRemoteRecoveryAuthority,
  projectRemoteRecoveryRuntime,
} from "./transactionClientRuntime.js";
import {
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  RemoteSettlementBindResponseSchema,
  RemoteSettlementConflictResponseSchema,
  RemoteTransactionRetryResponseSchema,
  RemoteTransactionSettlementResponseSchema,
  type RemoteBrowserAutomationErrorPayload,
  type RemoteRecoverySettlementOptions,
  type RemoteRunTransactionPayload,
  type RemoteSettlementBindResponse,
  type RemoteSettlementAuthority,
  type RemoteTransactionRetryResponse,
  type RemoteTransactionSettlementResponse,
} from "./types.js";
import {
  parseRemoteHost,
  postRemoteJson,
  resolveRemoteTransportDeadlines,
  type RemoteTransportInterruption,
  type ResolvedRemoteTransportDeadlines,
} from "./clientTransport.js";
import { assertRemoteTransactionToken } from "./transactionToken.js";

export async function settleRemoteBrowserRecovery(
  params: RemoteRecoverySettlementOptions,
): Promise<BrowserCaptureFinalizationResult> {
  const authority = findRemoteRecoveryAuthority(params.runtime);
  const pending = (
    message: string,
    runtime: BrowserRuntimeMetadata = params.runtime,
  ): BrowserCaptureFinalizationResult => pendingBrowserCaptureCleanup(runtime, message);
  if (!authority || authority.protocolVersion !== REMOTE_TRANSACTION_PROTOCOL_VERSION) {
    return pending("Remote cleanup authority is missing or uses an unsupported protocol version.");
  }
  assertRemoteTransactionToken(authority.transactionToken);
  const persistedMode = params.runtime.recoveryCleanupResult?.settlementMode;
  const mode =
    params.mode ??
    persistedMode ??
    (authority.state === "recoverable-error" ? "abort" : "finalize");
  if (persistedMode && persistedMode !== mode) {
    throw settlementModeConflict(mode, persistedMode, params.runtime);
  }
  if (!params.authToken?.trim()) {
    return pending("Remote cleanup authentication is unavailable; configure ORACLE_REMOTE_TOKEN.");
  }
  if (authority.host !== params.configuredHost) {
    return pending(
      `Remote cleanup host mismatch; refusing to send credentials to ${authority.host}.`,
    );
  }
  let endpoint: { hostname: string; port: number };
  try {
    endpoint = parseRemoteHost(params.configuredHost);
  } catch (error) {
    return pending(error instanceof Error ? error.message : String(error));
  }
  const deadlines = resolveRemoteTransportDeadlines(params.deadlines);
  try {
    const settlementRuntime = await bindRemoteBrowserSettlement({
      ...endpoint,
      token: params.authToken,
      host: authority.host,
      transactionToken: authority.transactionToken,
      recoveryState: authority.state,
      mode,
      runtime: params.runtime,
      deadlines,
    });
    return await settleRemoteBrowserTransaction({
      ...endpoint,
      token: params.authToken,
      host: authority.host,
      transactionToken: authority.transactionToken,
      recoveryState: authority.state,
      mode,
      runtime: settlementRuntime,
      deadlines,
    });
  } catch (error) {
    if (
      error instanceof BrowserAutomationError &&
      error.details?.code !== "remote-settlement-binding-transport-failed"
    ) {
      throw error;
    }
    const runtime =
      error instanceof BrowserAutomationError && error.details?.runtime
        ? (error.details.runtime as BrowserRuntimeMetadata)
        : params.runtime;
    return pending(error instanceof Error ? error.message : String(error), runtime);
  }
}

export async function recoverRemoteRunTransaction(params: {
  hostname: string;
  port: number;
  token?: string;
  transactionToken: string;
  host: string;
  requestIdentity?: BrowserRemotePromptRequestIdentity;
  expectedSettlementMode?: "finalize" | "abort";
  authoritativeRuntime: BrowserRuntimeMetadata;
  interruption: RemoteTransportInterruption;
  deadlines: ResolvedRemoteTransportDeadlines;
}): Promise<RemoteRunTransactionPayload> {
  assertRemoteTransactionToken(params.transactionToken);
  const recoveryAuthority = (state: "pre-receipt" | "recoverable-error") =>
    ({
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      host: params.host,
      transactionToken: params.transactionToken,
      state,
      requestIdentity: params.requestIdentity,
    }) satisfies BrowserRemoteRecoveryMetadata;
  const deadline = Date.now() + params.deadlines.recoveryWindowMs;
  const retryPreReceiptAbsence =
    findRemoteRecoveryAuthority(params.authoritativeRuntime)?.state === "pre-receipt";
  let lastRetryProvedAbsent = false;
  let lastReachableAt = Date.now();
  while (Date.now() < deadline) {
    lastRetryProvedAbsent = false;
    try {
      const response = await postRemoteJson({
        hostname: params.hostname,
        port: params.port,
        path: `/transactions/${encodeURIComponent(params.transactionToken)}/retry`,
        token: params.token,
        body: {},
        overallTimeoutMs: params.deadlines.controlOverallTimeoutMs,
        idleTimeoutMs: params.deadlines.socketIdleTimeoutMs,
        operation: "Remote retry request",
      });
      lastReachableAt = Date.now();
      if (response.statusCode === 404) {
        if (!retryPreReceiptAbsence) throw terminalRetryNotRetainedError(params);
        lastRetryProvedAbsent = true;
        await delay(500);
        continue;
      }
      if (response.statusCode === 202) {
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
            params.expectedSettlementMode,
            params.authoritativeRuntime,
          ),
        });
      }
      const retry = RemoteTransactionRetryResponseSchema.parse(
        response.json,
      ) as RemoteTransactionRetryResponse;
      if (retry.status === "terminal") {
        throw terminalRetryOutcomeError(retry, params);
      }
      if (retry.status === "running") {
        await delay(500);
        continue;
      }
      if (retry.status === "error") {
        throw rehydrateRemoteBrowserError(retry.error, params.host, params.transactionToken, {
          requestIdentity: params.requestIdentity,
          expectedSettlementMode: params.expectedSettlementMode,
          authoritativeRuntime: params.authoritativeRuntime,
        });
      }
      assertRemoteTransactionOwnership(retry.transaction, params.transactionToken);
      return retry.transaction;
    } catch (error) {
      if (error instanceof BrowserAutomationError) {
        if (error.details?.runtime || error.details?.code === "remote-settlement-mode-conflict") {
          throw error;
        }
        const runtime = unresolvedRemoteTransactionRuntime(
          recoveryAuthority("recoverable-error"),
          error.message,
          params.expectedSettlementMode,
          params.authoritativeRuntime,
        );
        throw new BrowserAutomationError(
          error.message,
          {
            ...error.details,
            recoverableDisconnect: true,
            runtime,
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
              params.expectedSettlementMode,
              params.authoritativeRuntime,
            ),
          },
          params.interruption,
        );
      }
      await delay(500);
    }
  }
  if (lastRetryProvedAbsent) {
    throw terminalRetryNotRetainedError(
      params,
      "Remote transaction record did not appear before the pre-receipt recovery deadline.",
    );
  }
  const message = "Remote browser transaction did not become recoverable before its deadline.";
  throw new BrowserAutomationError(
    message,
    {
      stage: "remote-retry",
      transactionToken: params.transactionToken,
      recoverableDisconnect: true,
      runtime: unresolvedRemoteTransactionRuntime(
        recoveryAuthority("recoverable-error"),
        message,
        params.expectedSettlementMode,
        params.authoritativeRuntime,
      ),
    },
    params.interruption,
  );
}

function terminalRetryOutcomeError(
  retry: Extract<RemoteTransactionRetryResponse, { status: "terminal" }>,
  params: {
    transactionToken: string;
    expectedSettlementMode?: "finalize" | "abort";
    authoritativeRuntime: BrowserRuntimeMetadata;
  },
): BrowserAutomationError {
  if (retry.transactionToken !== params.transactionToken) {
    return new BrowserAutomationError("Remote terminal retry token did not match the request.", {
      stage: "remote-protocol",
      code: "remote-transaction-token-mismatch",
      transactionToken: params.transactionToken,
      recoverableDisconnect: true,
      runtime: params.authoritativeRuntime,
    });
  }
  const terminalMode =
    retry.outcome.state === "finalized"
      ? "finalize"
      : retry.outcome.state === "aborted"
        ? "abort"
        : undefined;
  const publicRuntime =
    retry.outcome.state === "failed"
      ? ({ cleanup: { status: "completed" } } as const)
      : retry.outcome.finalization.runtime;
  const resourceRuntime = projectRemoteRecoveryRuntime(publicRuntime, null);
  const completedRuntime = projectBrowserCaptureFinalization(params.authoritativeRuntime, {
    status: "completed",
    runtime: resourceRuntime,
  }).runtime;
  if (
    terminalMode &&
    params.expectedSettlementMode &&
    terminalMode !== params.expectedSettlementMode
  ) {
    return new BrowserAutomationError(
      "Remote terminal settlement mode conflicts with persisted authority.",
      {
        stage: "remote-protocol",
        code: "remote-settlement-mode-conflict",
        transactionToken: params.transactionToken,
        recoverableDisconnect: false,
        runtime: completedRuntime,
      },
    );
  }
  const error = retry.outcome.state === "finalized" ? undefined : retry.outcome.error;
  return new BrowserAutomationError(
    retry.outcome.state === "finalized"
      ? "Remote transaction was already finalized and its terminal result is no longer resumable."
      : (error?.message ?? "Remote transaction was already aborted."),
    {
      stage: error?.stage ?? "remote-retry",
      code:
        error?.code ??
        (retry.outcome.state === "aborted"
          ? "remote-transaction-aborted"
          : retry.outcome.state === "failed"
            ? "remote-transaction-failed"
            : "remote-transaction-finalized"),
      transactionToken: params.transactionToken,
      recoverableDisconnect: false,
      runtime: completedRuntime,
    },
  );
}

function terminalRetryNotRetainedError(
  params: {
    transactionToken: string;
    authoritativeRuntime: BrowserRuntimeMetadata;
  },
  message = "Remote transaction terminal state is no longer retained by the server.",
): BrowserAutomationError {
  const resourceRuntime = projectRemoteRecoveryRuntime({ cleanup: { status: "completed" } }, null);
  const completedRuntime = projectBrowserCaptureFinalization(params.authoritativeRuntime, {
    status: "completed",
    runtime: resourceRuntime,
  }).runtime;
  return new BrowserAutomationError(message, {
    stage: "remote-retry",
    code: "remote-transaction-not-retained",
    transactionToken: params.transactionToken,
    recoverableDisconnect: false,
    runtime: completedRuntime,
  });
}

export function unresolvedRemoteTransactionRuntime(
  authority: BrowserRemoteRecoveryMetadata,
  error: string,
  settlementMode?: "finalize" | "abort",
  authoritativeRuntime?: BrowserRuntimeMetadata,
): BrowserRuntimeMetadata {
  assertRemoteTransactionToken(authority.transactionToken);
  const runtime = projectRemoteRecoveryRuntime(
    { cleanup: { status: "pending" } },
    { ...authority, state: "recoverable-error" },
    authoritativeRuntime,
  );
  return {
    ...runtime,
    recoveryCleanupResult: {
      status: "failed",
      error,
      ...(settlementMode ? { settlementMode } : {}),
    },
  };
}

export function assertPromptEpochIdentity(
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

export function assertPromptEpochMatchesRequestIdentity(
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
function convergeRemoteSettlementAuthority(
  runtime: BrowserRuntimeMetadata,
  authority: RemoteSettlementAuthority,
): BrowserRuntimeMetadata {
  if (authority.outcome === "completed") {
    const resourceRuntime = projectRemoteRecoveryRuntime(
      { cleanup: { status: "completed" } },
      null,
    );
    return projectBrowserCaptureFinalization(
      runtime,
      { status: "completed", runtime: resourceRuntime },
      authority.mode,
    ).runtime;
  }
  const unboundRuntime = { ...runtime };
  delete unboundRuntime.recoveryCleanupResult;
  return markBrowserCaptureCleanupPending(unboundRuntime, authority.mode);
}

export async function bindRemoteBrowserSettlement(params: {
  transactionToken: string;
  recoveryState: BrowserRemoteRecoveryMetadata["state"];
  hostname: string;
  port: number;
  token?: string;
  host: string;
  mode: "finalize" | "abort";
  runtime: BrowserRuntimeMetadata;
  deadlines: ResolvedRemoteTransportDeadlines;
}): Promise<BrowserRuntimeMetadata> {
  assertRemoteTransactionToken(params.transactionToken);
  const response = await postRemoteJson({
    hostname: params.hostname,
    port: params.port,
    path: `/transactions/${encodeURIComponent(params.transactionToken)}/bind`,
    token: params.token,
    body: { mode: params.mode, durablePublication: params.mode === "finalize" },
    overallTimeoutMs: params.deadlines.controlOverallTimeoutMs,
    idleTimeoutMs: params.deadlines.socketIdleTimeoutMs,
    operation: `Remote ${params.mode} binding request`,
  }).catch((error): never => {
    if (
      error instanceof BrowserAutomationError &&
      error.details?.code !== "remote-authentication-transport-failed"
    ) {
      throw error;
    }
    const runtime = markBrowserCaptureCleanupPending(params.runtime, params.mode);
    throw new BrowserAutomationError(
      `Remote ${params.mode} binding remains retryable after a transport failure.`,
      {
        stage: "remote-settlement-binding",
        code: "remote-settlement-binding-transport-failed",
        transactionToken: params.transactionToken,
        recoverableDisconnect: true,
        runtime,
      },
      error,
    );
  });
  if (response.statusCode === 409) {
    const conflict = RemoteSettlementConflictResponseSchema.safeParse(response.json);
    if (!conflict.success) {
      throw new BrowserAutomationError(response.errorMessage, {
        stage: "remote-settlement-binding",
        statusCode: response.statusCode,
        transactionToken: params.transactionToken,
        recoverableDisconnect: true,
        runtime: params.runtime,
      });
    }
    const authoritativeRuntime = convergeRemoteSettlementAuthority(
      params.runtime,
      conflict.data.settlementAuthority,
    );
    throw settlementModeConflict(
      params.mode,
      conflict.data.settlementAuthority.mode,
      authoritativeRuntime,
      conflict.data.settlementAuthority,
    );
  }
  if (response.statusCode !== 200) {
    throw new BrowserAutomationError(response.errorMessage, {
      stage: "remote-settlement-binding",
      statusCode: response.statusCode,
      transactionToken: params.transactionToken,
      recoverableDisconnect: true,
      runtime: params.runtime,
    });
  }
  const binding = RemoteSettlementBindResponseSchema.parse(
    response.json,
  ) as RemoteSettlementBindResponse;
  if (binding.transactionToken !== params.transactionToken) {
    throw new BrowserAutomationError("Remote settlement binding token did not match the request.", {
      stage: "remote-protocol",
      transactionToken: params.transactionToken,
      recoverableDisconnect: true,
      runtime: params.runtime,
    });
  }
  const currentAuthority = findRemoteRecoveryAuthority(params.runtime);
  const remoteRecovery =
    binding.settlementAuthority.outcome === "bound"
      ? ({
          protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
          host: params.host,
          transactionToken: params.transactionToken,
          state: params.recoveryState,
          requestIdentity: currentAuthority?.requestIdentity,
        } satisfies BrowserRemoteRecoveryMetadata)
      : null;
  const resourceRuntime = projectRemoteRecoveryRuntime(binding.runtime, remoteRecovery);
  const authoritativeRuntime =
    binding.settlementAuthority.outcome === "completed"
      ? projectBrowserCaptureFinalization(params.runtime, {
          status: "completed",
          runtime: resourceRuntime,
        }).runtime
      : bindRemoteSettlementMode(
          projectRemoteRecoveryRuntime(binding.runtime, remoteRecovery, params.runtime),
          binding.settlementAuthority.mode,
        );
  if (binding.settlementAuthority.mode !== params.mode) {
    throw settlementModeConflict(
      params.mode,
      binding.settlementAuthority.mode,
      authoritativeRuntime,
      binding.settlementAuthority,
    );
  }
  return authoritativeRuntime;
}

export async function settleRemoteBrowserTransaction(params: {
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
  assertRemoteTransactionToken(params.transactionToken);
  let transportError: unknown;
  const response = await postRemoteJson({
    hostname: params.hostname,
    port: params.port,
    path: `/transactions/${encodeURIComponent(params.transactionToken)}/${params.mode}`,
    token: params.token,
    body: params.mode === "finalize" ? { durablePublication: true } : {},
    overallTimeoutMs: params.deadlines.controlOverallTimeoutMs,
    idleTimeoutMs: params.deadlines.socketIdleTimeoutMs,
    operation: `Remote ${params.mode} request`,
  }).catch((error) => {
    transportError = error;
    return null;
  });
  if (!response) {
    if (
      transportError instanceof BrowserAutomationError &&
      transportError.details?.code !== "remote-authentication-transport-failed"
    ) {
      throw transportError;
    }
    const message = `Remote ${params.mode} remains retryable after a transport failure: ${
      transportError instanceof Error ? transportError.message : String(transportError)
    }`;
    return pendingBrowserCaptureCleanup(params.runtime, message, params.mode);
  }
  if (response.statusCode === 409) {
    const conflict = RemoteSettlementConflictResponseSchema.safeParse(response.json);
    if (!conflict.success) {
      throw new BrowserAutomationError(response.errorMessage, {
        stage: `remote-${params.mode}`,
        statusCode: response.statusCode,
        transactionToken: params.transactionToken,
        recoverableDisconnect: true,
        runtime: params.runtime,
      });
    }
    const authoritativeRuntime = convergeRemoteSettlementAuthority(
      params.runtime,
      conflict.data.settlementAuthority,
    );
    throw settlementModeConflict(
      params.mode,
      conflict.data.settlementAuthority.mode,
      authoritativeRuntime,
      conflict.data.settlementAuthority,
    );
  }
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
  if (
    settlement.settlementAuthority.mode !== params.mode ||
    settlement.settlementAuthority.outcome !==
      (settlement.finalization.status === "completed" ? "completed" : "bound")
  ) {
    throw new BrowserAutomationError(
      "Remote settlement response contradicted its authoritative binding.",
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
      } satisfies BrowserRemoteRecoveryMetadata)
    : null;
  const resourceRuntime = projectRemoteRecoveryRuntime(
    settlement.finalization.runtime,
    remoteRecovery,
  );
  const resourceFinalization =
    settlement.finalization.status === "pending"
      ? pendingBrowserCaptureCleanup(resourceRuntime, settlement.finalization.error, params.mode)
      : ({ status: "completed", runtime: resourceRuntime } as const);
  return projectBrowserCaptureFinalization(params.runtime, resourceFinalization, params.mode);
}

export function bindRemoteSettlementMode(
  runtime: BrowserRuntimeMetadata,
  mode: "finalize" | "abort",
): BrowserRuntimeMetadata {
  if (!findRemoteRecoveryAuthority(runtime)) {
    throw new BrowserAutomationError("Remote settlement authority is missing.", {
      stage: "remote-settlement",
      recoverableDisconnect: true,
      runtime,
    });
  }
  const persistedMode = runtime.recoveryCleanupResult?.settlementMode;
  if (persistedMode && persistedMode !== mode) {
    throw settlementModeConflict(mode, persistedMode, runtime);
  }
  return markBrowserCaptureCleanupPending(runtime, mode);
}

export function settlementModeConflict(
  requestedMode: "finalize" | "abort",
  persistedMode: "finalize" | "abort",
  runtime: BrowserRuntimeMetadata,
  settlementAuthority?: RemoteSettlementAuthority,
): BrowserAutomationError {
  return new BrowserAutomationError(
    `Remote recovery is already bound to ${persistedMode} settlement; refusing ${requestedMode}.`,
    {
      stage: "remote-settlement",
      recoverableDisconnect: settlementAuthority?.outcome !== "completed",
      runtime,
      code: settlementAuthority ? "remote-settlement-mode-conflict" : "settlement-mode-conflict",
      ...(settlementAuthority ? { settlementAuthority } : {}),
    },
  );
}

export function assertRemoteTransactionOwnership(
  transaction: RemoteRunTransactionPayload,
  expectedTransactionToken: string,
): void {
  assertRemoteTransactionToken(expectedTransactionToken);
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

export function rehydrateRemoteBrowserError(
  error: RemoteBrowserAutomationErrorPayload,
  host: string,
  expectedTransactionToken?: string,
  authority: {
    requestIdentity?: BrowserRemotePromptRequestIdentity;
    expectedSettlementMode?: "finalize" | "abort";
    authoritativeRuntime?: BrowserRuntimeMetadata;
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
  assertRemoteTransactionToken(transactionToken);
  const remoteRecovery: BrowserRemoteRecoveryMetadata = {
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    host,
    transactionToken,
    state: "recoverable-error",
    requestIdentity: authority.requestIdentity,
  };
  const runtime = projectRemoteRecoveryRuntime(
    error.runtime,
    remoteRecovery,
    authority.authoritativeRuntime,
  );
  if (
    error.settlementMode &&
    authority.expectedSettlementMode &&
    error.settlementMode !== authority.expectedSettlementMode
  ) {
    return new BrowserAutomationError(
      "Remote recovery settlement mode conflicts with persisted authority.",
      {
        stage: "remote-protocol",
        code: "remote-settlement-mode-conflict",
        transactionToken,
        recoverableDisconnect: true,
        runtime: markBrowserCaptureCleanupPending(runtime, authority.expectedSettlementMode),
      },
    );
  }
  const settlementMode = error.settlementMode ?? authority.expectedSettlementMode;
  const boundRuntime = settlementMode
    ? markBrowserCaptureCleanupPending(runtime, settlementMode)
    : runtime;
  if (expectedTransactionToken && error.recoveryToken !== expectedTransactionToken) {
    return new BrowserAutomationError("Remote recovery token did not match the request.", {
      stage: "remote-protocol",
      transactionToken: expectedTransactionToken,
      recoverableDisconnect: true,
      runtime: boundRuntime,
    });
  }
  return new BrowserAutomationError(error.message, {
    code: error.code,
    stage: error.stage,
    recoverableDisconnect: true,
    runtime: boundRuntime,
  });
}
