import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import type {
  DurableRemoteArtifactDeliveryReceipt,
  DurableRemoteArtifactRegistration,
  DurableRemoteStagedCapture,
  RemoteTransactionRecord,
  RemoteTransactionSettlementPhase,
  RemoteTransactionState,
} from "./transactionModel.js";
import {
  REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  REMOTE_TRANSACTION_TOKEN_PATTERN,
  RemotePublicRunResultSchema,
} from "./types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type RemoteTransactionValidationCode =
  | "artifact_ownership_invalid"
  | "artifact_delivery_receipt_invalid"
  | "staged_capture_invalid"
  | "terminal_audit_invalid"
  | "persisted_record_invalid";

export class RemoteTransactionValidationError extends Error {
  constructor(
    readonly code: RemoteTransactionValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "RemoteTransactionValidationError";
  }
}

export interface RemoteTransactionValidationOptions {
  expectedTransactionToken?: string;
  maximumLeaseDurationMs?: number;
}

export function isTerminalRemoteTransactionState(
  state: RemoteTransactionState,
): state is "finalized" | "aborted" | "failed" {
  return state === "finalized" || state === "aborted" || state === "failed";
}

export function authoritativeRemoteSettlementMode(
  record: Pick<RemoteTransactionRecord, "settlementMode" | "runtime" | "terminalAudit">,
): "finalize" | "abort" | undefined {
  return (
    record.settlementMode ??
    record.runtime?.recoveryCleanupResult?.settlementMode ??
    record.terminalAudit?.settlementMode
  );
}

export function remoteTransactionSettlementPhase(
  record: Pick<
    RemoteTransactionRecord,
    "state" | "settlementMode" | "settlementExecutionStartedAt" | "finalization" | "terminalAudit"
  >,
): RemoteTransactionSettlementPhase {
  if (isTerminalRemoteTransactionState(record.state)) return "terminal";
  if (!authoritativeRemoteSettlementMode(record)) return "unbound";
  if (record.settlementExecutionStartedAt || record.finalization) {
    return "executing-or-pending";
  }
  return "mode-bound";
}

export function missingRequiredArtifactDeliveries(
  record: Pick<RemoteTransactionRecord, "artifacts">,
): DurableRemoteArtifactRegistration[] {
  return (record.artifacts ?? []).filter(
    (artifact) => artifact.descriptor.required && !artifact.deliveryReceipt,
  );
}

export function validateRemoteArtifactOwnership(
  record: Pick<RemoteTransactionRecord, "transactionToken" | "runId">,
  artifacts: DurableRemoteArtifactRegistration[],
): void {
  const artifactIds = new Set<string>();
  for (const artifact of artifacts) {
    if (
      artifact.transactionToken !== record.transactionToken ||
      artifact.descriptor.runId !== record.runId ||
      !artifact.canonicalPath ||
      artifactIds.has(artifact.descriptor.artifactId)
    ) {
      throw new RemoteTransactionValidationError(
        "artifact_ownership_invalid",
        "Remote artifact registration is not uniquely owned by its transaction",
      );
    }
    artifactIds.add(artifact.descriptor.artifactId);
    if (artifact.deliveryReceipt) {
      validateRemoteArtifactDeliveryReceipt(artifact, artifact.deliveryReceipt);
    }
  }
}

export function validateRemoteArtifactDeliveryReceipt(
  registration: DurableRemoteArtifactRegistration,
  receipt: DurableRemoteArtifactDeliveryReceipt,
): void {
  if (
    !receipt.receiptId ||
    !Number.isFinite(Date.parse(receipt.deliveredAt)) ||
    !Number.isSafeInteger(receipt.byteSize) ||
    receipt.byteSize !== registration.descriptor.byteSize ||
    receipt.sha256 !== registration.descriptor.sha256
  ) {
    throw new RemoteTransactionValidationError(
      "artifact_delivery_receipt_invalid",
      "Remote artifact delivery receipt does not match registered content",
    );
  }
}

export function validateRemoteStagedCapture(
  record: Pick<
    RemoteTransactionRecord,
    "transactionToken" | "runId" | "requestIdentity" | "stagedCapture"
  >,
  staged: DurableRemoteStagedCapture | undefined = record.stagedCapture,
): void {
  if (!staged) return;
  const epoch = staged.runtime?.promptEpoch;
  if (
    !Number.isFinite(Date.parse(staged.stagedAt)) ||
    !staged.runtime ||
    typeof staged.runtime !== "object" ||
    Array.isArray(staged.runtime) ||
    epoch?.status !== "committed" ||
    !record.requestIdentity.acceptedPromptSha256.includes(epoch.promptSha256) ||
    epoch.followUpOrdinal !== record.requestIdentity.followUpOrdinal ||
    epoch.remainingFollowUps !== record.requestIdentity.remainingFollowUps ||
    staged.runtime.conversationId !== epoch.conversationId
  ) {
    throw new RemoteTransactionValidationError(
      "staged_capture_invalid",
      "Staged remote capture lacks exact prompt and conversation identity",
    );
  }
  RemotePublicRunResultSchema.parse(staged.result);
  validateRemoteArtifactOwnership(record, staged.artifacts ?? []);
}

export function validateRemoteTerminalAudit(record: RemoteTransactionRecord): void {
  const audit = record.terminalAudit;
  if (
    !audit ||
    !Number.isFinite(Date.parse(audit.redactedAt)) ||
    !Array.isArray(audit.artifacts) ||
    audit.artifacts.some((artifact) => artifact.runId !== record.runId)
  ) {
    throw new RemoteTransactionValidationError(
      "terminal_audit_invalid",
      "Terminal remote transaction audit is invalid",
    );
  }
  if (
    record.capacityReservationBytes !== undefined ||
    record.requestIdentity ||
    record.browserConfig ||
    record.leaseExpiresAt ||
    record.result ||
    record.runtime ||
    record.runtimeJournaledAt ||
    record.modelSelection ||
    record.artifacts ||
    record.stagedCapture ||
    record.error ||
    record.settlementMode ||
    record.settlementExecutionStartedAt ||
    record.publicationAcknowledgedAt ||
    record.restartRecovery ||
    (record.finalization && record.finalization.status !== "completed")
  ) {
    throw new RemoteTransactionValidationError(
      "terminal_audit_invalid",
      "Terminal remote transaction contains unredacted authority",
    );
  }
  if (record.finalization && !record.finalization.runtime) {
    throw new RemoteTransactionValidationError(
      "terminal_audit_invalid",
      "Terminal finalization lacks redacted runtime metadata",
    );
  }
  if (record.state === "finalized") {
    if (
      audit.settlementMode !== "finalize" ||
      !audit.publicationAcknowledgedAt ||
      !Number.isFinite(Date.parse(audit.publicationAcknowledgedAt)) ||
      !record.finalization
    ) {
      throw new RemoteTransactionValidationError(
        "terminal_audit_invalid",
        "Finalized remote transaction lacks completed finalize settlement",
      );
    }
    return;
  }
  if (record.state === "aborted") {
    if (
      audit.settlementMode !== "abort" ||
      audit.publicationAcknowledgedAt ||
      !record.finalization
    ) {
      throw new RemoteTransactionValidationError(
        "terminal_audit_invalid",
        "Aborted remote transaction lacks completed abort settlement",
      );
    }
    return;
  }
  if (audit.settlementMode) {
    if (
      audit.settlementMode !== "abort" ||
      audit.publicationAcknowledgedAt ||
      !record.finalization
    ) {
      throw new RemoteTransactionValidationError(
        "terminal_audit_invalid",
        "Failed remote transaction cleanup settlement is invalid",
      );
    }
  } else if (record.finalization) {
    throw new RemoteTransactionValidationError(
      "terminal_audit_invalid",
      "Pre-authority failed transaction cannot contain finalization state",
    );
  }
}

export function validateRemoteTransactionRecord(
  record: RemoteTransactionRecord,
  options: RemoteTransactionValidationOptions = {},
): void {
  if (
    record.protocolVersion !== REMOTE_TRANSACTION_PROTOCOL_VERSION ||
    !REMOTE_TRANSACTION_TOKEN_PATTERN.test(record.transactionToken) ||
    (options.expectedTransactionToken &&
      record.transactionToken !== options.expectedTransactionToken) ||
    typeof record.runId !== "string" ||
    !record.runId ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt)) ||
    !["running", "pending", "finalized", "aborted", "recoverable-error", "failed"].includes(
      record.state,
    )
  ) {
    invalidRecord("Invalid remote transaction record");
  }
  if (typeof record.controllerGeneration !== "string" || !record.controllerGeneration) {
    invalidRecord("Remote transaction record is missing controller generation");
  }
  if (
    (record.state === "running" &&
      record.capacityReservationBytes !== REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES) ||
    (record.state !== "running" && record.capacityReservationBytes !== undefined)
  ) {
    invalidRecord("Remote transaction capacity reservation does not match its state");
  }

  if (isTerminalRemoteTransactionState(record.state)) {
    validateRemoteTerminalAudit(record);
    return;
  }

  const requestIdentity = record.requestIdentity;
  if (
    !requestIdentity ||
    !Array.isArray(requestIdentity.acceptedPromptSha256) ||
    requestIdentity.acceptedPromptSha256.length === 0 ||
    requestIdentity.acceptedPromptSha256.length > 64 ||
    !requestIdentity.acceptedPromptSha256.every((sha256) => SHA256_PATTERN.test(sha256)) ||
    !Number.isSafeInteger(requestIdentity.followUpOrdinal) ||
    requestIdentity.followUpOrdinal < 0 ||
    requestIdentity.remainingFollowUps !== 0 ||
    !record.browserConfig ||
    typeof record.browserConfig !== "object" ||
    Array.isArray(record.browserConfig) ||
    typeof record.leaseExpiresAt !== "string" ||
    !Number.isFinite(Date.parse(record.leaseExpiresAt))
  ) {
    invalidRecord("Nonterminal remote transaction is missing bounded request authority");
  }
  if (
    record.runtimeJournaledAt !== undefined &&
    (!record.runtime || !Number.isFinite(Date.parse(record.runtimeJournaledAt)))
  ) {
    invalidRecord("Remote transaction runtime journal is invalid");
  }
  if (record.runtime && (typeof record.runtime !== "object" || Array.isArray(record.runtime))) {
    invalidRecord("Remote transaction runtime authority is invalid");
  }
  if (
    record.settlementExecutionStartedAt !== undefined &&
    (!record.settlementMode || !Number.isFinite(Date.parse(record.settlementExecutionStartedAt)))
  ) {
    invalidRecord("Remote transaction settlement execution marker is invalid");
  }
  if (record.finalization && !record.settlementExecutionStartedAt) {
    invalidRecord("Remote transaction finalization lacks durable execution authority");
  }
  if (record.finalization) validatePendingFinalization(record.finalization);
  validateRemoteArtifactOwnership(record, record.artifacts ?? []);
  validateRemoteStagedCapture(record);
  validateLeaseBound(record, options.maximumLeaseDurationMs);

  switch (record.state) {
    case "running":
      if (
        (record.stagedCapture && !record.runtime) ||
        record.result ||
        record.artifacts ||
        record.error ||
        record.settlementMode ||
        record.publicationAcknowledgedAt ||
        record.finalization ||
        record.restartRecovery
      ) {
        invalidRecord("Running remote transaction contains post-capture state");
      }
      return;
    case "pending":
      if (
        !record.runtime ||
        !record.result ||
        record.stagedCapture ||
        record.error ||
        record.restartRecovery
      ) {
        invalidRecord("Pending remote transaction requires runtime and captured result only");
      }
      if (!record.settlementMode) {
        if (record.publicationAcknowledgedAt || record.finalization) {
          invalidRecord("Unbound pending transaction contains settlement state");
        }
        return;
      }
      const pendingRuntimeMode = record.runtime.recoveryCleanupResult?.settlementMode;
      if (pendingRuntimeMode && pendingRuntimeMode !== record.settlementMode) {
        invalidRecord("Bound pending transaction runtime lost its exact settlement mode");
      }
      if (record.settlementMode === "finalize") {
        if (!record.publicationAcknowledgedAt) {
          if (remoteTransactionSettlementPhase(record) !== "mode-bound") {
            invalidRecord("Finalize-bound transaction lacks publication or artifact durability");
          }
        } else if (
          !Number.isFinite(Date.parse(record.publicationAcknowledgedAt)) ||
          missingRequiredArtifactDeliveries(record).length > 0
        ) {
          invalidRecord("Finalize-bound transaction lacks publication or artifact durability");
        }
      } else if (record.publicationAcknowledgedAt) {
        invalidRecord("Abort-bound transaction cannot acknowledge answer publication");
      }
      return;
    case "recoverable-error":
      if (
        !record.runtime ||
        !record.error ||
        !record.error.recoverableDisconnect ||
        record.result ||
        record.artifacts ||
        record.modelSelection ||
        record.publicationAcknowledgedAt ||
        record.settlementMode === "finalize" ||
        (record.finalization && record.settlementMode !== "abort")
      ) {
        invalidRecord("Recoverable remote transaction lacks exact runtime failure authority");
      }
      const recoveryRuntimeMode = record.runtime.recoveryCleanupResult?.settlementMode;
      if (
        record.settlementMode === "abort" &&
        recoveryRuntimeMode &&
        recoveryRuntimeMode !== "abort"
      ) {
        invalidRecord("Abort-bound recovery runtime lost its exact settlement mode");
      }
      return;
  }
}

function validatePendingFinalization(finalization: BrowserCaptureFinalizationResult): void {
  if (
    finalization.status !== "pending" ||
    typeof finalization.error !== "string" ||
    !finalization.error ||
    !finalization.runtime ||
    typeof finalization.runtime !== "object" ||
    Array.isArray(finalization.runtime)
  ) {
    invalidRecord("Nonterminal remote transaction finalization must remain pending");
  }
}

function validateLeaseBound(
  record: RemoteTransactionRecord,
  maximumLeaseDurationMs: number | undefined,
): void {
  if (maximumLeaseDurationMs === undefined) return;
  const updatedAt = Date.parse(record.updatedAt);
  const leaseExpiresAt = Date.parse(record.leaseExpiresAt);
  if (
    !Number.isFinite(leaseExpiresAt) ||
    leaseExpiresAt <= updatedAt ||
    leaseExpiresAt - updatedAt > maximumLeaseDurationMs
  ) {
    invalidRecord("Remote transaction lease exceeds the configured bound");
  }
}

function invalidRecord(message: string): never {
  throw new RemoteTransactionValidationError("persisted_record_invalid", message);
}
