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
} from "../browser/runLifecycle.js";
import {
  findRemoteRecoveryAuthority,
  projectRemoteRecoveryFinalization,
  projectRemoteRecoveryRuntime,
} from "./transactionClientRuntime.js";
import {
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  RemoteTransactionRetryResponseSchema,
  RemoteTransactionSettlementResponseSchema,
  type RemoteBrowserAutomationErrorPayload,
  type RemoteRecoverySettlementOptions,
  type RemoteRunTransactionPayload,
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
  const persistedMode = params.runtime.recoveryCleanupResult?.settlementMode;
  const mode =
    params.mode ??
    persistedMode ??
    (authority.state === "recoverable-error" ? "abort" : "finalize");
  if (persistedMode && persistedMode !== mode) {
    throw settlementModeConflict(mode, persistedMode, params.runtime);
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
  const recoveryAuthority = (state: "pre-receipt" | "recoverable-error") =>
    ({
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      host: params.host,
      transactionToken: params.transactionToken,
      state,
      requestIdentity: params.requestIdentity,
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
      if (response.statusCode === 404) {
        throw terminalRetryNotRetainedError(params);
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
  const completedRuntime = projectRemoteRecoveryFinalization(params.authoritativeRuntime, {
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

function terminalRetryNotRetainedError(params: {
  transactionToken: string;
  authoritativeRuntime: BrowserRuntimeMetadata;
}): BrowserAutomationError {
  const resourceRuntime = projectRemoteRecoveryRuntime({ cleanup: { status: "completed" } }, null);
  const completedRuntime = projectRemoteRecoveryFinalization(params.authoritativeRuntime, {
    status: "completed",
    runtime: resourceRuntime,
  }).runtime;
  return new BrowserAutomationError(
    "Remote transaction terminal state is no longer retained by the server.",
    {
      stage: "remote-retry",
      code: "remote-transaction-not-retained",
      transactionToken: params.transactionToken,
      recoverableDisconnect: false,
      runtime: completedRuntime,
    },
  );
}

export function unresolvedRemoteTransactionRuntime(
  authority: BrowserRemoteRecoveryMetadata,
  error: string,
  settlementMode?: "finalize" | "abort",
  authoritativeRuntime?: BrowserRuntimeMetadata,
): BrowserRuntimeMetadata {
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
    return projectRemoteRecoveryFinalization(params.runtime, resourceFinalization, params.mode);
  } catch (error) {
    const message = `Remote ${params.mode} remains retryable: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return pendingBrowserCaptureCleanup(params.runtime, message, params.mode);
  }
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

export function assertRemoteTransactionOwnership(
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
