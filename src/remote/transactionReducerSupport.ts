import { isDeepStrictEqual } from "node:util";
import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import type { BrowserModelSelectionEvidence, BrowserRuntimeMetadata } from "../sessionManager.js";
import {
  isTerminalRemoteTransactionState,
  projectRemoteSettlementRuntime,
} from "./transactionModel.js";
import type {
  DurableRemoteArtifactDeliveryReceipt,
  DurableRemoteArtifactManualCopyWaiver,
  DurableRemoteArtifactRegistration,
  DurableRemoteAutomationError,
  DurableRemoteCaptureWarning,
  DurableRemoteStagedCapture,
  DurableRemoteTerminalAudit,
  RemoteNonterminalTransactionRecord,
  RemoteTransactionPersistedEnvelope,
  RemoteTransactionRecord,
  RemoteTransactionReducerContext,
  RemoteTransactionSettlementAuthority,
} from "./transactionModel.js";
import {
  RemoteTransactionValidationError,
  validateRemoteStagedCapture,
} from "./transactionValidation.js";
import type { RemotePublicRunResult } from "./types.js";

export class RemoteTransactionTransitionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly settlementAuthority?: RemoteTransactionSettlementAuthority,
  ) {
    super(message);
    this.name = "RemoteTransactionTransitionError";
  }
}
export function assertValidRemoteStagedCapture(
  record: RemoteNonterminalTransactionRecord,
  staged: DurableRemoteStagedCapture,
): void {
  try {
    validateRemoteStagedCapture(record, staged);
  } catch (error) {
    if (
      error instanceof RemoteTransactionValidationError &&
      error.code === "staged_capture_invalid"
    ) {
      throw new RemoteTransactionTransitionError(
        "staged_capture_identity_mismatch",
        "Staged remote capture does not match the exact prompt and conversation identity",
      );
    }
    throw error;
  }
}

export function assertPublishedPromptIdentity(
  record: Pick<RemoteNonterminalTransactionRecord, "requestIdentity">,
  runtime: BrowserRuntimeMetadata,
): void {
  const epoch = runtime.promptEpoch;
  if (
    epoch?.status !== "committed" ||
    !record.requestIdentity.acceptedPromptSha256.includes(epoch.promptSha256) ||
    epoch.followUpOrdinal !== record.requestIdentity.followUpOrdinal ||
    epoch.remainingFollowUps !== record.requestIdentity.remainingFollowUps ||
    runtime.conversationId !== epoch.conversationId
  ) {
    throw new RemoteTransactionTransitionError(
      "staged_capture_identity_mismatch",
      "Staged remote capture does not match the exact prompt and conversation identity",
    );
  }
}

export function assertCapturePromotionMatchesStage(
  staged: DurableRemoteStagedCapture,
  result: RemotePublicRunResult,
  runtime: BrowserRuntimeMetadata,
): void {
  const stagedCore = captureAnswerIdentity(staged.result);
  const resultCore = captureAnswerIdentity(result);
  const stagedEpoch = staged.runtime.promptEpoch;
  const promotedEpoch = runtime.promptEpoch;
  if (
    !isDeepStrictEqual(stagedCore, resultCore) ||
    stagedEpoch?.status !== "committed" ||
    promotedEpoch?.status !== "committed" ||
    !isDeepStrictEqual(stagedEpoch, promotedEpoch) ||
    staged.runtime.conversationId !== runtime.conversationId ||
    runtime.conversationId !== promotedEpoch.conversationId
  ) {
    throw new RemoteTransactionTransitionError(
      "staged_capture_identity_mismatch",
      "Published remote capture does not match the exact staged answer identity",
    );
  }
}

function captureAnswerIdentity(result: RemotePublicRunResult) {
  return {
    answerText: result.answerText,
    answerMarkdown: result.answerMarkdown,
    answerHtml: result.answerHtml ?? null,
    modelSelection: captureModelSelectionIdentity(result.modelSelection),
    answerTokens: result.answerTokens,
    answerChars: result.answerChars,
  };
}

export function captureModelSelectionIdentity(
  modelSelection: BrowserModelSelectionEvidence | undefined,
) {
  if (!modelSelection) return null;
  return {
    requestedModel: modelSelection.requestedModel ?? null,
    resolvedLabel: modelSelection.resolvedLabel ?? null,
    strategy: modelSelection.strategy ?? null,
    status: modelSelection.status,
    verified: modelSelection.verified,
    source: modelSelection.source,
    capturedAt: modelSelection.capturedAt,
  };
}

export function mergeCaptureWarnings(
  staged: RemotePublicRunResult,
  result: RemotePublicRunResult,
  warning?: DurableRemoteCaptureWarning,
): RemotePublicRunResult {
  const warnings = [...(staged.warnings ?? []), ...(result.warnings ?? [])];
  if (warning) warnings.push({ ...warning, severity: "warning" });
  const uniqueWarnings = warnings.filter(
    (candidate, index) =>
      warnings.findIndex(
        (other) => other.code === candidate.code && other.message === candidate.message,
      ) === index,
  );
  const boundedWarnings = uniqueWarnings.slice(-64);
  return {
    ...result,
    warnings: boundedWarnings.length > 0 ? boundedWarnings : undefined,
  };
}

type MutableTerminalProjectionRecord = RemoteTransactionPersistedEnvelope & {
  capacityReservationBytes?: number;
  requestIdentity?: NonNullable<RemoteTransactionRecord["requestIdentity"]>;
  browserConfig?: NonNullable<RemoteTransactionRecord["browserConfig"]>;
  leaseExpiresAt?: string;
  result?: NonNullable<RemoteTransactionRecord["result"]>;
  runtime?: BrowserRuntimeMetadata;
  runtimeJournaledAt?: string;
  modelSelection?: BrowserModelSelectionEvidence;
  artifacts?: DurableRemoteArtifactRegistration[];
  stagedCapture?: DurableRemoteStagedCapture;
  error?: DurableRemoteAutomationError;
  settlementMode?: "finalize" | "abort";
  settlementExecutionStartedAt?: string;
  publicationAcknowledgedAt?: string;
  finalization?: NonNullable<RemoteTransactionRecord["finalization"]>;
  restartRecovery?: NonNullable<RemoteTransactionRecord["restartRecovery"]>;
  terminalAudit?: DurableRemoteTerminalAudit;
};

export function commitCapture(
  record: RemoteTransactionRecord,
  result: RemotePublicRunResult,
  runtime: BrowserRuntimeMetadata,
  modelSelection: BrowserModelSelectionEvidence | undefined,
  artifacts: DurableRemoteArtifactRegistration[],
  context: RemoteTransactionReducerContext,
): void {
  record.controllerGeneration = context.controllerGeneration;
  record.state = "pending";
  record.result = result;
  record.runtime = runtime;
  record.runtimeJournaledAt = context.nowIso();
  record.modelSelection = modelSelection;
  record.artifacts = artifacts;
  record.stagedCapture = undefined;
  record.error = undefined;
  record.settlementMode = undefined;
  record.settlementExecutionStartedAt = undefined;
  record.publicationAcknowledgedAt = undefined;
  record.finalization = undefined;
  record.restartRecovery = undefined;
}

export function projectRunningRecordToFailure(
  record: RemoteTransactionRecord,
  error: DurableRemoteAutomationError,
  discardStagedCapture = false,
  settlementMode?: "abort",
): "recoverable-error" | "failed" {
  const state = record.runtime ? "recoverable-error" : "failed";
  record.state = state;
  record.result = undefined;
  record.modelSelection = undefined;
  record.artifacts = undefined;
  if (discardStagedCapture) record.stagedCapture = undefined;
  record.error = error;
  record.publicationAcknowledgedAt = undefined;
  record.finalization = undefined;
  record.settlementMode = settlementMode;
  return state;
}

export function projectRemoteSettlementFinalization(
  record: RemoteTransactionRecord,
  mode: "finalize" | "abort",
  finalization: BrowserCaptureFinalizationResult,
): void {
  record.runtime = projectRemoteSettlementRuntime(finalization.runtime);
  record.finalization = finalization;
  if (finalization.status === "completed") {
    record.state = mode === "finalize" ? "finalized" : "aborted";
    if (record.error) record.error = { ...record.error, recoverableDisconnect: false };
  } else {
    record.state = record.error && !record.result ? "recoverable-error" : "pending";
  }
}

export function redactTerminalRecord(record: RemoteTransactionRecord, redactedAt: string): void {
  if (!isTerminalRemoteTransactionState(record.state)) return;
  const mutable = record as MutableTerminalProjectionRecord;
  const promptEpoch = mutable.runtime?.promptEpoch ?? mutable.finalization?.runtime.promptEpoch;
  mutable.terminalAudit ??= {
    redactedAt,
    settlementMode: mutable.settlementMode,
    publicationAcknowledgedAt: mutable.publicationAcknowledgedAt,
    artifacts: (mutable.artifacts ?? []).map((artifact) => ({
      artifactId: artifact.descriptor.artifactId,
      runId: artifact.descriptor.runId,
      required: artifact.descriptor.required,
      deliveryReceipt: artifact.deliveryReceipt,
      manualCopyWaiver: artifact.manualCopyWaiver,
    })),
    errorCode: mutable.error?.code,
    errorStage: mutable.error?.stage,
  };
  mutable.finalization =
    mutable.finalization?.status === "completed"
      ? {
          status: "completed",
          runtime: promptEpoch ? { promptEpoch } : {},
        }
      : undefined;
  mutable.result = undefined;
  mutable.capacityReservationBytes = undefined;
  Reflect.deleteProperty(mutable, "requestIdentity");
  Reflect.deleteProperty(mutable, "browserConfig");
  Reflect.deleteProperty(mutable, "leaseExpiresAt");
  mutable.runtime = undefined;
  mutable.runtimeJournaledAt = undefined;
  mutable.modelSelection = undefined;
  mutable.artifacts = undefined;
  mutable.stagedCapture = undefined;
  mutable.error = undefined;
  mutable.settlementMode = undefined;
  Reflect.deleteProperty(mutable, "settlementExecutionStartedAt");
  mutable.publicationAcknowledgedAt = undefined;
  mutable.restartRecovery = undefined;
}

export function sameArtifactDeliveryReceipt(
  left: DurableRemoteArtifactDeliveryReceipt,
  right: DurableRemoteArtifactDeliveryReceipt,
): boolean {
  return (
    left.receiptId === right.receiptId &&
    left.byteSize === right.byteSize &&
    left.sha256 === right.sha256
  );
}

export function sameArtifactManualCopyWaiver(
  left: DurableRemoteArtifactManualCopyWaiver,
  right: DurableRemoteArtifactManualCopyWaiver,
): boolean {
  return (
    left.waiverId === right.waiverId &&
    left.disposition === right.disposition &&
    left.byteSize === right.byteSize &&
    left.sha256 === right.sha256
  );
}
