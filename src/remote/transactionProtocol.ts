import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import type { BrowserRuntimeMetadata } from "../sessionManager.js";
import type { DurableRemoteAutomationError, RemoteTransactionRecord } from "./transactionStore.js";
import {
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  RemoteBrowserAutomationErrorSchema,
  RemoteRunTransactionPayloadSchema,
  RemoteTransactionRetryResponseSchema,
  RemoteTransactionSettlementResponseSchema,
  type RemoteBrowserAutomationErrorPayload,
  type RemotePublicRuntime,
  type RemoteRunTransactionPayload,
  type RemoteTransactionRetryResponse,
  type RemoteTransactionSettlementResponse,
} from "./types.js";

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
  record: RemoteTransactionRecord,
): RemoteRunTransactionPayload {
  if (!record.result || !record.runtime || record.state !== "pending") {
    throw new Error("Remote transaction record is not publishable");
  }
  return RemoteRunTransactionPayloadSchema.parse({
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    transactionToken: record.transactionToken,
    runId: record.runId,
    result: record.result,
    runtime: projectRemotePublicRuntime(record.runtime, "pending", true),
    artifacts: (record.artifacts ?? []).map((artifact) => artifact.descriptor),
    state: record.state,
  });
}

export function settlementResponse(
  record: RemoteTransactionRecord,
  finalization: BrowserCaptureFinalizationResult,
): RemoteTransactionSettlementResponse {
  const cleanupStatus = finalization.status === "completed" ? "completed" : "pending";
  return RemoteTransactionSettlementResponseSchema.parse({
    transactionToken: record.transactionToken,
    state: record.state,
    finalization: {
      status: finalization.status,
      runtime: projectRemotePublicRuntime(finalization.runtime, cleanupStatus),
      ...(finalization.status === "pending" ? { error: finalization.error } : {}),
    },
  });
}

export function remoteBrowserAutomationError(
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
  const terminal = terminalRemoteBrowserAutomationError(record);
  if (terminal) return terminal;
  throw new Error("Remote error transaction is missing error metadata");
}

export function remotePendingSettlementError(
  record: RemoteTransactionRecord,
): RemoteBrowserAutomationErrorPayload {
  if (!record.runtime || !record.settlementMode || record.state === "running") {
    throw new Error("Remote transaction does not retain bound cleanup authority");
  }
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
  record: RemoteTransactionRecord,
): Extract<RemoteTransactionRetryResponse, { status: "terminal" }> {
  if (record.state === "finalized" || record.state === "aborted") {
    if (!record.finalization || record.finalization.status !== "completed") {
      throw new Error("Terminal remote settlement lacks completed finalization metadata");
    }
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
  if (record.state === "failed") {
    const error = terminalRemoteBrowserAutomationError(record);
    if (!error) throw new Error("Terminal failed transaction lacks redacted error metadata");
    return parseTerminalRetryResponse({
      status: "terminal",
      transactionToken: record.transactionToken,
      outcome: { state: "failed", error },
    });
  }
  throw new Error("Nonterminal remote transaction cannot produce a terminal retry response");
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
  record: RemoteTransactionRecord,
): RemoteBrowserAutomationErrorPayload | undefined {
  if (!record.terminalAudit) return undefined;
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
