import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import type { BrowserRuntimeMetadata } from "../sessionManager.js";
import type {
  DurableRemoteAutomationError,
  RemoteMaterializedSettlementAuthorityTransactionRecord,
  RemotePendingCaptureTransactionRecord,
  RemoteRecoverableTransactionRecord,
  RemoteSettlementPendingTransactionRecord,
  RemoteSettledTransactionRecord,
  RemoteTerminalTransactionRecord,
  RemoteTransactionSettlementBinding,
} from "./transactionModel.js";
import {
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  RemoteBrowserAutomationErrorSchema,
  RemoteRunTransactionPayloadSchema,
  RemoteSettlementBindResponseSchema,
  RemoteTransactionRetryResponseSchema,
  RemoteTransactionSettlementResponseSchema,
  type RemoteBrowserAutomationErrorPayload,
  type RemotePublicRuntime,
  type RemoteRunTransactionPayload,
  type RemoteSettlementBindResponse,
  type RemoteTransactionRetryResponse,
  type RemoteTransactionSettlementResponse,
} from "./types.js";
const REMOTE_PENDING_SETTLEMENT_MESSAGE =
  "Remote browser cleanup remains pending; retry the same settlement mode.";

export function projectRemotePublicRuntime(
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

export function remoteTransactionPayload(
  record: RemotePendingCaptureTransactionRecord,
): RemoteRunTransactionPayload {
  return RemoteRunTransactionPayloadSchema.parse({
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    transactionToken: record.transactionToken,
    runId: record.runId,
    result: record.result,
    runtime: projectRemotePublicRuntime(record.runtime, "pending", true),
    artifacts: record.artifacts.map((artifact) => artifact.descriptor),
    state: record.state,
  });
}

export function settlementResponse(
  record: RemoteSettlementPendingTransactionRecord | RemoteSettledTransactionRecord,
  finalization: BrowserCaptureFinalizationResult,
): RemoteTransactionSettlementResponse {
  const cleanupStatus = finalization.status === "completed" ? "completed" : "pending";
  const mode =
    record.state === "finalized" || record.state === "aborted" || record.state === "failed"
      ? record.terminalAudit.settlementMode
      : record.settlementMode;
  if (!mode) throw new Error("Remote settlement response lacks bound mode authority");
  const state = finalization.status === "completed" ? record.state : "pending";
  return RemoteTransactionSettlementResponseSchema.parse({
    transactionToken: record.transactionToken,
    state,
    settlementAuthority: {
      mode,
      outcome: finalization.status === "completed" ? "completed" : "bound",
      state: record.state,
    },
    finalization: {
      status: finalization.status,
      runtime: projectRemotePublicRuntime(finalization.runtime, cleanupStatus),
      ...(finalization.status === "pending" ? { error: REMOTE_PENDING_SETTLEMENT_MESSAGE } : {}),
    },
  });
}

export function settlementBindingResponse(
  record: RemoteTransactionSettlementBinding["record"],
  settlementAuthority: {
    mode: "finalize" | "abort";
    outcome: "bound" | "completed";
    state: RemoteTransactionSettlementBinding["record"]["state"];
  },
  finalization?: Extract<BrowserCaptureFinalizationResult, { status: "completed" }>,
): RemoteSettlementBindResponse {
  const runtime = finalization?.runtime ?? record.runtime;
  if (!runtime) throw new Error("Remote settlement binding lacks durable runtime authority");
  return RemoteSettlementBindResponseSchema.parse({
    transactionToken: record.transactionToken,
    settlementAuthority,
    runtime: projectRemotePublicRuntime(
      runtime,
      settlementAuthority.outcome === "completed" ? "completed" : "pending",
    ),
  });
}

export function remoteBrowserAutomationError(
  record: RemoteRecoverableTransactionRecord | RemoteTerminalTransactionRecord,
): RemoteBrowserAutomationErrorPayload {
  if (record.state === "recoverable-error") {
    return projectRemoteBrowserAutomationError(
      record.error,
      record.runtime,
      record.transactionToken,
      record.settlementMode,
    );
  }
  const terminal = terminalRemoteBrowserAutomationError(record);
  if (terminal) return terminal;
  throw new Error("Remote error transaction is missing error metadata");
}

export function remotePendingSettlementError(
  record: RemoteMaterializedSettlementAuthorityTransactionRecord,
): RemoteBrowserAutomationErrorPayload {
  return RemoteBrowserAutomationErrorSchema.parse({
    name: "BrowserAutomationError",
    category: "browser-automation",
    message: "Remote browser cleanup remains pending in its exact settlement mode.",
    code: "remote-settlement-pending",
    stage: "remote-settlement",
    recoverableDisconnect: true,
    recoveryToken: record.transactionToken,
    settlementMode: record.settlementMode,
    runtime: projectRemotePublicRuntime(record.runtime, "pending"),
  });
}

export function terminalTransactionRetryResponse(
  record: RemoteTerminalTransactionRecord,
): Extract<RemoteTransactionRetryResponse, { status: "terminal" }> {
  if (record.state === "finalized" || record.state === "aborted") {
    const error = terminalRemoteBrowserAutomationError(record);
    return parseTerminalRetryResponse({
      status: "terminal",
      transactionToken: record.transactionToken,
      outcome: {
        state: record.state,
        finalization: {
          status: "completed",
          runtime: projectRemotePublicRuntime(record.finalization.runtime, "completed"),
        },
        ...(record.state === "aborted" && error ? { error } : {}),
      },
    });
  }
  const error = terminalRemoteBrowserAutomationError(record);
  if (!error) throw new Error("Terminal failed transaction lacks redacted error metadata");
  return parseTerminalRetryResponse({
    status: "terminal",
    transactionToken: record.transactionToken,
    outcome: { state: "failed", error },
  });
}

function parseTerminalRetryResponse(
  value: unknown,
): Extract<RemoteTransactionRetryResponse, { status: "terminal" }> {
  const response = RemoteTransactionRetryResponseSchema.parse(value);
  if (response.status !== "terminal") {
    throw new Error("Terminal retry projection produced a nonterminal response");
  }
  return response;
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

function terminalRemoteBrowserAutomationError(
  record: RemoteTerminalTransactionRecord,
): RemoteBrowserAutomationErrorPayload | undefined {
  const failed = record.state === "failed";
  const abortedFailure =
    record.state === "aborted" &&
    Boolean(record.terminalAudit.errorCode || record.terminalAudit.errorStage);
  if (!failed && !abortedFailure) return undefined;
  return RemoteBrowserAutomationErrorSchema.parse({
    name: "BrowserAutomationError",
    category: "browser-automation",
    message: "Remote browser automation failed and cleanup is complete.",
    code: publicProtocolLabel(record.terminalAudit.errorCode),
    stage: publicProtocolLabel(record.terminalAudit.errorStage),
    recoverableDisconnect: false,
  });
}

function publicProtocolLabel(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9_-]{1,128}$/u.test(value) ? value : undefined;
}
