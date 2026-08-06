import { isDeepStrictEqual } from "node:util";
import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import { markBrowserCaptureCleanupPending } from "../browser/runLifecycle.js";
import { hasRestartDurableChromeTargetCleanupAuthority } from "../browser/targetCloseAuthority.js";
import type { BrowserModelSelectionEvidence, BrowserRuntimeMetadata } from "../sessionManager.js";
import { deriveRemoteArtifactNamespace } from "./transactionModel.js";
import type {
  AppliedRemoteTransactionTransition,
  DurableRemoteArtifactDeliveryReceipt,
  DurableRemoteArtifactRegistration,
  DurableRemoteAutomationError,
  DurableRemoteCaptureWarning,
  DurableRemoteStagedCapture,
  RemoteTransactionBeginRecord,
  RemoteTransactionSettlementAuthority,
  RemoteTransactionRecord,
  RemoteTransactionReducerContext,
  RemoteTransactionTransition,
  RemoteTransactionTransitionType,
} from "./transactionModel.js";
import {
  authoritativeRemoteSettlementMode,
  isTerminalRemoteTransactionState,
  missingRequiredArtifactDeliveries,
  RemoteTransactionValidationError,
  validateRemoteArtifactDeliveryReceipt,
  validateRemoteArtifactOwnership,
  remoteTransactionSettlementPhase,
  validateRemoteStagedCapture,
  validateRemoteTransactionRecord,
} from "./transactionValidation.js";
import {
  REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES,
  type RemotePublicRunResult,
} from "./types.js";

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

type RemoteTransactionReduction<Type extends RemoteTransactionTransitionType> = Omit<
  AppliedRemoteTransactionTransition<Type>,
  "record"
>;

type RemoteTransactionReducer<Type extends RemoteTransactionTransitionType> = (
  record: RemoteTransactionRecord,
  transition: RemoteTransactionTransition<Type>,
  context: RemoteTransactionReducerContext,
) => RemoteTransactionReduction<Type>;

type RemoteTransactionReducers = {
  [Type in RemoteTransactionTransitionType]: RemoteTransactionReducer<Type>;
};
const reducers: RemoteTransactionReducers = {
  "renew-lease": (record, _transition, context) => {
    if (isTerminalRemoteTransactionState(record.state)) {
      throw new Error(`Cannot renew lease for terminal transaction in state ${record.state}`);
    }
    if (Date.parse(record.leaseExpiresAt ?? "") <= context.now()) {
      throw new Error("Cannot renew an expired remote transaction lease");
    }
    return { persist: true, outcome: undefined };
  },
  "journal-runtime": (record, transition, context) => {
    if (record.state !== "running") {
      throw new Error(`Cannot journal runtime for transaction in state ${record.state}`);
    }
    assertCurrentController(record, context, "journal runtime");
    record.runtime = transition.runtime;
    record.runtimeJournaledAt = context.nowIso();
    record.modelSelection = transition.modelSelection;
    return { persist: true, outcome: undefined };
  },
  "journal-recovery-runtime": (record, transition, context) => {
    if (record.state !== "recoverable-error") {
      throw new Error(`Cannot journal recovery runtime for transaction in state ${record.state}`);
    }
    assertCurrentController(record, context, "journal recovery runtime");
    if (record.settlementMode) {
      throw new Error("Cannot journal recovery runtime after cleanup settlement is bound");
    }
    record.runtime = transition.runtime;
    record.runtimeJournaledAt = context.nowIso();
    return { persist: true, outcome: undefined };
  },
  "persist-settlement-runtime": (record, transition, context) => {
    const acceptsSettlementRuntime =
      record.state === "pending" ||
      (record.state === "recoverable-error" && record.settlementMode === "abort");
    if (!acceptsSettlementRuntime) {
      throw new Error(`Cannot persist settlement runtime for transaction in state ${record.state}`);
    }
    assertCurrentController(record, context, "persist settlement runtime");
    const runtimeSettlementMode = transition.runtime.recoveryCleanupResult?.settlementMode;
    if (!record.settlementMode) {
      throw new Error("Cannot persist settlement runtime without a durable settlement binding");
    }
    if (runtimeSettlementMode !== record.settlementMode) {
      throw new RemoteTransactionTransitionError(
        "transaction_settlement_conflict",
        "Settlement runtime does not match the exact durable settlement mode",
        {
          mode: record.settlementMode,
          outcome: "bound",
          state: record.state,
        },
      );
    }
    record.runtime = transition.runtime;
    record.runtimeJournaledAt = context.nowIso();
    return { persist: true, outcome: undefined };
  },
  "stage-capture": (record, transition, context) => {
    if (
      record.state !== "running" &&
      !(record.state === "recoverable-error" && !record.settlementMode)
    ) {
      throw new Error(`Cannot stage capture from transaction state ${record.state}`);
    }
    if (record.state === "running") assertCurrentController(record, context, "stage capture");
    if (record.runId !== transition.runId) {
      throw new Error("Remote capture run identity changed before durable staging");
    }
    const stagedCapture: DurableRemoteStagedCapture = {
      result: transition.result,
      runtime: transition.runtime,
      modelSelection: transition.modelSelection,
      artifacts: transition.artifacts,
      stagedAt: context.nowIso(),
    };
    assertValidRemoteStagedCapture(record, stagedCapture);
    if (record.stagedCapture) {
      const existing = record.stagedCapture;
      if (existing.artifacts === undefined && stagedCapture.artifacts?.length === 0) {
        throw new RemoteTransactionTransitionError(
          "staged_capture_artifact_manifest_incomplete",
          "An artifact-bearing staged capture cannot be completed with an empty manifest",
        );
      }
      assertCapturePromotionMatchesStage(existing, stagedCapture.result, stagedCapture.runtime);
      if (
        !isDeepStrictEqual(
          captureModelSelectionIdentity(existing.modelSelection),
          captureModelSelectionIdentity(stagedCapture.modelSelection),
        )
      ) {
        throw new RemoteTransactionTransitionError(
          "staged_capture_conflict",
          "Remote transaction staged capture model evidence changed",
        );
      }
      if (
        existing.artifacts !== undefined &&
        stagedCapture.artifacts !== undefined &&
        !isDeepStrictEqual(existing.artifacts, stagedCapture.artifacts)
      ) {
        throw new RemoteTransactionTransitionError(
          "staged_capture_conflict",
          "Remote transaction staged capture artifacts changed",
        );
      }
      const enriched: DurableRemoteStagedCapture = {
        ...stagedCapture,
        result: mergeCaptureWarnings(existing.result, stagedCapture.result),
        artifacts: stagedCapture.artifacts ?? existing.artifacts,
        stagedAt: existing.stagedAt,
      };
      assertValidRemoteStagedCapture(record, enriched);
      if (isDeepStrictEqual(existing, enriched)) {
        return { persist: false, outcome: undefined };
      }
      record.stagedCapture = enriched;
      record.runtime = enriched.runtime;
      record.runtimeJournaledAt = context.nowIso();
      record.modelSelection = enriched.modelSelection;
      return { persist: true, outcome: undefined };
    }
    record.stagedCapture = stagedCapture;
    record.runtime = transition.runtime;
    record.runtimeJournaledAt = context.nowIso();
    record.modelSelection = transition.modelSelection;
    return { persist: true, outcome: undefined };
  },
  "promote-staged-capture": (record, transition, context) => {
    if (record.state === "pending" && record.result && record.runtime && !record.stagedCapture) {
      return { persist: false, outcome: undefined };
    }
    if (
      record.state !== "running" &&
      !(record.state === "recoverable-error" && !record.settlementMode)
    ) {
      throw new Error(`Cannot promote staged capture from transaction state ${record.state}`);
    }
    if (record.state === "running") assertCurrentController(record, context, "promote capture");
    const staged = record.stagedCapture;
    if (!staged) throw new Error("Remote transaction does not contain a staged capture");
    if (staged.artifacts === undefined) {
      throw new RemoteTransactionTransitionError(
        "staged_capture_artifact_manifest_incomplete",
        "Remote transaction staged capture lacks a complete artifact manifest",
      );
    }
    const result = transition.result ?? staged.result;
    const runtime = transition.runtime ?? staged.runtime;
    assertCapturePromotionMatchesStage(staged, result, runtime);
    commitCapture(
      record,
      mergeCaptureWarnings(staged.result, result, transition.warning),
      transition.stripTargetAuthority ? projectRuntimeAfterTargetLoss(runtime) : runtime,
      staged.modelSelection,
      staged.artifacts,
      context,
    );
    return { persist: true, outcome: undefined };
  },
  "invalidate-staged-capture": (record, transition, context) => {
    if (record.state !== "running" && record.state !== "recoverable-error") {
      throw new Error(`Cannot invalidate staged capture from transaction state ${record.state}`);
    }
    assertCurrentController(record, context, "invalidate staged capture");
    if (record.settlementMode) {
      throw new Error("Cannot invalidate a capture after cleanup settlement is bound");
    }
    const terminalAbort =
      transition.settlementMode === "abort" &&
      Boolean(transition.runtime) &&
      !transition.error.recoverableDisconnect;
    if (!terminalAbort && Boolean(transition.runtime) !== transition.error.recoverableDisconnect) {
      throw new Error("Capture invalidation recoverability must match runtime authority");
    }
    if (transition.settlementMode && !terminalAbort) {
      throw new Error(
        "Only terminal runtime failures may durably bind abort while recording failure",
      );
    }
    record.controllerGeneration = context.controllerGeneration;
    record.runtime = transition.runtime;
    record.runtimeJournaledAt = transition.runtime ? context.nowIso() : undefined;
    projectRunningRecordToFailure(record, transition.error, true);
    record.settlementMode = transition.settlementMode;
    return { persist: true, outcome: undefined };
  },
  "publish-capture": (record, transition, context) => {
    if (
      record.state !== "running" &&
      !(record.state === "recoverable-error" && !record.settlementMode)
    ) {
      throw new Error(`Cannot publish capture from transaction state ${record.state}`);
    }
    if (record.state === "running") {
      assertCurrentController(record, context, "publish capture");
    }
    if (record.runId !== transition.runId) {
      throw new Error("Remote capture run identity changed before durable commit");
    }
    assertPublishedPromptIdentity(record, transition.runtime);
    validateRemoteArtifactOwnership(record, transition.artifacts);
    let result = transition.result;
    if (record.stagedCapture) {
      if (record.stagedCapture.artifacts === undefined) {
        throw new RemoteTransactionTransitionError(
          "staged_capture_artifact_manifest_incomplete",
          "Published capture cannot bypass incomplete staged artifact registration",
        );
      }
      assertCapturePromotionMatchesStage(
        record.stagedCapture,
        transition.result,
        transition.runtime,
      );
      if (!isDeepStrictEqual(record.stagedCapture.artifacts, transition.artifacts)) {
        throw new RemoteTransactionTransitionError(
          "staged_capture_artifact_mismatch",
          "Published capture artifacts do not match the exact staged capture",
        );
      }
      result = mergeCaptureWarnings(record.stagedCapture.result, transition.result);
    }
    commitCapture(
      record,
      result,
      transition.runtime,
      transition.modelSelection,
      transition.artifacts,
      context,
    );
    return { persist: true, outcome: undefined };
  },
  "record-failure": (record, transition, context) => {
    if (record.state !== "running" && record.state !== "recoverable-error") {
      throw new Error(`Cannot record failure from transaction state ${record.state}`);
    }
    if (record.settlementMode) {
      throw new Error("Cannot replace a failure after cleanup settlement is bound");
    }
    if (!transition.runtime && record.runtime) {
      throw new Error("Cannot discard journaled runtime authority while recording failure");
    }
    const terminalAbort =
      transition.settlementMode === "abort" &&
      Boolean(transition.runtime) &&
      !transition.error.recoverableDisconnect;
    if (!terminalAbort && Boolean(transition.runtime) !== transition.error.recoverableDisconnect) {
      throw new Error("Failure recoverability must match durable runtime authority");
    }
    if (transition.settlementMode && !terminalAbort) {
      throw new Error(
        "Only terminal runtime failures may durably bind abort while recording failure",
      );
    }
    record.controllerGeneration = context.controllerGeneration;
    record.runtime = transition.runtime;
    record.runtimeJournaledAt = transition.runtime ? context.nowIso() : undefined;
    projectRunningRecordToFailure(record, transition.error);
    record.settlementMode = transition.settlementMode;
    return { persist: true, outcome: undefined };
  },
  "record-artifact-delivery": (record, transition, context) => {
    if (record.state !== "pending" || !record.result || !record.runtime) {
      throw new Error(`Cannot record artifact delivery from transaction state ${record.state}`);
    }
    if (record.settlementMode) {
      throw new Error("Cannot record artifact delivery after settlement is bound");
    }
    if (Date.parse(record.leaseExpiresAt ?? "") <= context.now()) {
      throw new Error("Cannot record artifact delivery for an expired transaction lease");
    }
    const registration = record.artifacts?.find(
      (artifact) => artifact.descriptor.artifactId === transition.artifactId,
    );
    if (!registration) throw new Error("Remote artifact registration does not exist");
    validateRemoteArtifactDeliveryReceipt(registration, transition.receipt);
    if (registration.deliveryReceipt) {
      if (!sameArtifactDeliveryReceipt(registration.deliveryReceipt, transition.receipt)) {
        throw new Error("Remote artifact already has a different delivery receipt");
      }
      return { persist: false, outcome: registration.deliveryReceipt };
    }
    registration.deliveryReceipt = transition.receipt;
    return { persist: true, outcome: transition.receipt };
  },
  "bind-settlement": (record, transition, context) => {
    const completed = completedSettlement(record, transition.mode);
    if (completed) {
      return {
        persist: false,
        outcome: { status: "completed", finalization: completed },
      };
    }
    if (record.state === "running") {
      throw new RemoteTransactionTransitionError(
        "transaction_running",
        "Transaction is still running",
      );
    }
    if (record.state === "failed") {
      throw new RemoteTransactionTransitionError(
        "transaction_failed",
        "Transaction did not retain browser cleanup authority",
      );
    }
    if (!record.runtime) throw new Error("Nonterminal transaction lacks runtime authority");
    const authoritativeMode = authoritativeRemoteSettlementMode(record);
    if (authoritativeMode && authoritativeMode !== transition.mode) {
      throw settlementAuthorityConflict(record, authoritativeMode);
    }
    if (record.state === "recoverable-error" && transition.mode === "finalize") {
      throw new RemoteTransactionTransitionError(
        "transaction_has_no_capture",
        "Recoverable browser authority has no durably captured answer to finalize",
      );
    }
    let persist = false;
    if (record.controllerGeneration !== context.controllerGeneration) {
      record.controllerGeneration = context.controllerGeneration;
      persist = true;
    }
    if (record.settlementMode !== transition.mode) {
      record.settlementMode = transition.mode;
      persist = true;
    }
    if (transition.mode === "finalize" && transition.durablePublication) {
      const missingDeliveries = missingRequiredArtifactDeliveries(record);
      if (missingDeliveries.length > 0) {
        throw new RemoteTransactionTransitionError(
          "required_artifact_delivery_incomplete",
          `${missingDeliveries.length} required artifact delivery receipt(s) are missing`,
        );
      }
      if (!record.publicationAcknowledgedAt) {
        record.publicationAcknowledgedAt = context.nowIso();
        persist = true;
      }
    }
    return {
      persist,
      outcome: { status: "bound", cleanupRuntime: record.runtime },
    };
  },
  "begin-settlement-execution": (record, transition, context) => {
    const completed = completedSettlement(record, transition.mode);
    if (completed) {
      return {
        persist: false,
        outcome: { status: "completed", finalization: completed },
      };
    }
    if (record.state === "running") {
      throw new RemoteTransactionTransitionError(
        "transaction_running",
        "Transaction is still running",
      );
    }
    if (record.state === "failed") {
      throw new RemoteTransactionTransitionError(
        "transaction_failed",
        "Transaction did not retain browser cleanup authority",
      );
    }
    const authoritativeMode = authoritativeRemoteSettlementMode(record);
    if (!authoritativeMode) {
      throw new RemoteTransactionTransitionError(
        "transaction_settlement_unbound",
        "Transaction cleanup mode is not durably bound",
      );
    }
    if (authoritativeMode !== transition.mode) {
      throw settlementAuthorityConflict(record, authoritativeMode);
    }
    if (!record.settlementMode) {
      throw new Error("Cannot execute cleanup before materializing its durable settlement binding");
    }
    if (!record.runtime) throw new Error("Bound transaction lacks runtime authority");
    if (transition.mode === "finalize") {
      if (!record.publicationAcknowledgedAt) {
        throw new RemoteTransactionTransitionError(
          "durable_publication_ack_required",
          "Durable answer publication acknowledgement is required",
        );
      }
      const missingDeliveries = missingRequiredArtifactDeliveries(record);
      if (missingDeliveries.length > 0) {
        throw new RemoteTransactionTransitionError(
          "required_artifact_delivery_incomplete",
          `${missingDeliveries.length} required artifact delivery receipt(s) are missing`,
        );
      }
    }
    const cleanupRuntime = markBrowserCaptureCleanupPending(record.runtime, transition.mode);
    const controllerChanged = record.controllerGeneration !== context.controllerGeneration;
    const executionStarted = !record.settlementExecutionStartedAt;
    record.controllerGeneration = context.controllerGeneration;
    record.settlementExecutionStartedAt ??= context.nowIso();
    if (
      isDeepStrictEqual(cleanupRuntime, record.runtime) &&
      !controllerChanged &&
      !executionStarted
    ) {
      return {
        persist: false,
        outcome: { status: "executing", cleanupRuntime: record.runtime },
      };
    }
    record.runtime = cleanupRuntime;
    return {
      persist: true,
      outcome: { status: "executing", cleanupRuntime },
    };
  },
  "complete-settlement": (record, transition, context) => {
    const completed = completedSettlement(record, transition.mode);
    if (completed) return { persist: false, outcome: undefined };
    const authoritativeMode = authoritativeRemoteSettlementMode(record);
    if (authoritativeMode && authoritativeMode !== transition.mode) {
      throw settlementAuthorityConflict(record, authoritativeMode);
    }
    if (!record.settlementMode) {
      throw new Error("Cannot complete cleanup without its exact durable settlement binding");
    }
    if (remoteTransactionSettlementPhase(record) === "mode-bound") {
      throw new Error("Cannot complete cleanup before durable settlement execution begins");
    }
    if (!record.runtime) throw new Error("Bound transaction lacks runtime authority");
    if (transition.finalization.status === "pending") {
      const finalizationMode =
        transition.finalization.runtime.recoveryCleanupResult?.settlementMode;
      if (finalizationMode !== transition.mode) {
        throw new Error("Pending cleanup finalization lost its exact durable settlement mode");
      }
    }
    record.controllerGeneration = context.controllerGeneration;
    record.runtime = transition.finalization.runtime;
    record.finalization = transition.finalization;
    if (transition.finalization.status === "completed") {
      record.state = transition.mode === "finalize" ? "finalized" : "aborted";
      if (record.error) record.error = { ...record.error, recoverableDisconnect: false };
    } else {
      record.state = record.error && !record.result ? "recoverable-error" : "pending";
    }
    return { persist: true, outcome: undefined };
  },
  "prepare-controller-shutdown": (record) => {
    if (isTerminalRemoteTransactionState(record.state)) {
      return { persist: false, outcome: { action: "release" } };
    }
    if (record.state === "running") {
      throw new Error("Cannot shut down while a remote transaction is still running");
    }
    if (!record.runtime) throw new Error("Nonterminal transaction lacks runtime authority");
    const restartDurableCleanup = hasRestartDurableChromeTargetCleanupAuthority(record.runtime);
    if (!record.settlementMode) {
      if (restartDurableCleanup) {
        return { persist: false, outcome: { action: "preserve" } };
      }
      if (record.result || record.stagedCapture) {
        throw new Error(
          "Cannot shut down while a durable capture depends on non-restart-durable browser cleanup authority",
        );
      }
      return {
        persist: false,
        outcome: { action: "settle", mode: "abort", durablePublication: false },
      };
    }
    if (record.settlementMode === "finalize" && !record.publicationAcknowledgedAt) {
      if (restartDurableCleanup) {
        return { persist: false, outcome: { action: "preserve" } };
      }
      throw new Error(
        "Cannot shut down while an unacknowledged durable capture depends on non-restart-durable browser cleanup authority",
      );
    }
    return {
      persist: false,
      outcome: {
        action: "settle",
        mode: record.settlementMode,
        durablePublication: record.settlementMode === "finalize",
      },
    };
  },
  "reconcile-controller": (record, transition, context) => {
    const staleRunning = record.state === "running";
    const staleStagedRecovery =
      record.state === "recoverable-error" &&
      Boolean(record.stagedCapture) &&
      !record.settlementMode;
    if (
      (!staleRunning && !staleStagedRecovery) ||
      record.controllerGeneration === context.controllerGeneration
    ) {
      return { persist: false, outcome: null };
    }
    const previousControllerGeneration = record.controllerGeneration;
    const hadRuntimeAuthority = Boolean(record.runtime);
    const error = transition.buildError(record, hadRuntimeAuthority);
    if (error.recoverableDisconnect !== hadRuntimeAuthority) {
      throw new Error("Controller reconciliation error does not match runtime authority");
    }
    record.controllerGeneration = context.controllerGeneration;
    let state: "recoverable-error" | "failed";
    if (staleRunning) {
      state = projectRunningRecordToFailure(record, error);
    } else {
      record.error = error;
      state = "recoverable-error";
    }
    record.restartRecovery = {
      previousControllerGeneration,
      reconciledAt: context.nowIso(),
      reason: "controller-generation-changed",
    };
    return {
      persist: true,
      outcome: {
        transactionToken: record.transactionToken,
        previousControllerGeneration,
        state,
        hadRuntimeAuthority,
      },
    };
  },
  expire: (record, transition, context) => {
    if (
      isTerminalRemoteTransactionState(record.state) ||
      record.leaseExpiresAt !== transition.expectedLeaseExpiresAt ||
      Date.parse(record.leaseExpiresAt ?? "") > context.now()
    ) {
      return { persist: false, outcome: null };
    }
    if (record.state === "running") {
      const hadRuntimeAuthority = Boolean(record.runtime);
      const error = transition.buildError(record, hadRuntimeAuthority);
      if (error.recoverableDisconnect !== hadRuntimeAuthority) {
        throw new Error("Expired transaction error does not match runtime authority");
      }
      projectRunningRecordToFailure(record, error);
      if (!hadRuntimeAuthority) return { persist: true, outcome: null };
    }
    if (!record.runtime) throw new Error("Expired transaction lacks runtime cleanup authority");
    const runtimeSettlementMode = record.runtime?.recoveryCleanupResult?.settlementMode;
    const mode = record.settlementMode ?? runtimeSettlementMode ?? "abort";
    if (record.state === "recoverable-error" && mode !== "abort") {
      throw new Error("Recoverable failure cannot expire into finalize settlement");
    }
    if (mode === "finalize" && !record.publicationAcknowledgedAt) {
      return { persist: false, outcome: null };
    }
    record.controllerGeneration = context.controllerGeneration;
    record.settlementMode = mode;
    record.runtime = markBrowserCaptureCleanupPending(record.runtime, mode);
    return {
      persist: true,
      outcome: { mode, durablePublication: mode === "finalize" },
    };
  },
};

export function createRemoteTransactionRecord(
  begin: RemoteTransactionBeginRecord,
  context: RemoteTransactionReducerContext,
): RemoteTransactionRecord {
  const updatedAt = context.nowIso();
  const record: RemoteTransactionRecord = {
    ...begin,
    artifactNamespace: deriveRemoteArtifactNamespace(begin),
    updatedAt,
    controllerGeneration: context.controllerGeneration,
    state: "running",
    capacityReservationBytes: REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES,
    leaseExpiresAt: new Date(Date.parse(updatedAt) + context.leaseDurationMs).toISOString(),
  };
  validateRemoteTransactionRecord(record, {
    expectedTransactionToken: record.transactionToken,
    maximumLeaseDurationMs: context.leaseDurationMs,
  });
  return record;
}

export function applyRemoteTransactionTransition<Type extends RemoteTransactionTransitionType>(
  record: RemoteTransactionRecord,
  transition: RemoteTransactionTransition<Type>,
  context: RemoteTransactionReducerContext,
): AppliedRemoteTransactionTransition<Type> {
  validateRemoteTransactionRecord(record, {
    expectedTransactionToken: record.transactionToken,
    maximumLeaseDurationMs: context.leaseDurationMs,
  });
  const nextRecord = structuredClone(record);
  const reducer = reducers[transition.type] as RemoteTransactionReducer<Type>;
  const reduction = reducer(nextRecord, transition, context);
  if (!reduction.persist) return { record, ...reduction };
  finalizeRemoteTransactionTransition(nextRecord, context);
  validateRemoteTransactionRecord(nextRecord, {
    expectedTransactionToken: record.transactionToken,
    maximumLeaseDurationMs: context.leaseDurationMs,
  });
  return { record: nextRecord, ...reduction };
}

function finalizeRemoteTransactionTransition(
  record: RemoteTransactionRecord,
  context: RemoteTransactionReducerContext,
): void {
  const updatedAt = context.nowIso();
  record.updatedAt = updatedAt;
  record.capacityReservationBytes =
    record.state === "running" ? REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES : undefined;
  if (!isTerminalRemoteTransactionState(record.state)) {
    record.leaseExpiresAt = new Date(Date.parse(updatedAt) + context.leaseDurationMs).toISOString();
  }
  redactTerminalRecord(record, updatedAt);
}

function assertCurrentController(
  record: RemoteTransactionRecord,
  context: RemoteTransactionReducerContext,
  operation: string,
): void {
  if (record.controllerGeneration !== context.controllerGeneration) {
    throw new Error(`Cannot ${operation} from a stale remote controller generation`);
  }
}

function settlementAuthorityConflict(
  record: RemoteTransactionRecord,
  mode: "finalize" | "abort",
): RemoteTransactionTransitionError {
  const settlementAuthority: RemoteTransactionSettlementAuthority = {
    mode,
    outcome: "bound",
    state: record.state,
  };
  return new RemoteTransactionTransitionError(
    "transaction_settlement_conflict",
    `Transaction is already bound to ${mode}`,
    settlementAuthority,
  );
}

function completedSettlement(
  record: RemoteTransactionRecord,
  requestedMode: "finalize" | "abort",
): BrowserCaptureFinalizationResult | null {
  if (!isTerminalRemoteTransactionState(record.state)) return null;
  const settledMode = record.terminalAudit?.settlementMode;
  if (!settledMode) {
    if (record.state === "failed") return null;
    throw new Error("Terminal remote transaction lacks authoritative settlement mode");
  }
  if (settledMode !== requestedMode) {
    throw new RemoteTransactionTransitionError(
      "transaction_already_settled",
      `Transaction was already ${record.state}`,
      { mode: settledMode, outcome: "completed", state: record.state },
    );
  }
  if (!record.finalization || record.finalization.status !== "completed") {
    throw new Error("Terminal remote transaction lacks completed finalization state");
  }
  return record.finalization;
}

function assertValidRemoteStagedCapture(
  record: RemoteTransactionRecord,
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

function assertPublishedPromptIdentity(
  record: Pick<RemoteTransactionRecord, "requestIdentity">,
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

function assertCapturePromotionMatchesStage(
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

function captureModelSelectionIdentity(modelSelection: BrowserModelSelectionEvidence | undefined) {
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

function mergeCaptureWarnings(
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

function commitCapture(
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

function projectRuntimeAfterTargetLoss(runtime: BrowserRuntimeMetadata): BrowserRuntimeMetadata {
  const projected: BrowserRuntimeMetadata = { ...runtime };
  delete projected.chromeTargetId;
  const remainingResources: NonNullable<BrowserRuntimeMetadata["recoveryCleanupResources"]> = [];
  for (const resource of runtime.recoveryCleanupResources ?? []) {
    if (!resource.chromeTargetId) {
      remainingResources.push(resource);
      continue;
    }
    const hasNonTargetAuthority = Boolean(
      resource.chromePid ||
      resource.chromeProcessIdentity ||
      resource.profileDirectoryIdentity ||
      resource.userDataDir ||
      resource.tabLease,
    );
    if (!hasNonTargetAuthority) continue;
    remainingResources.push({
      ...resource,
      chromeTargetId: undefined,
      recoveryCleanup: {
        ...resource.recoveryCleanup,
        ownsTarget: false,
        closeOwnedTargetOnComplete: false,
      },
    });
  }
  if (remainingResources.length > 0) {
    projected.recoveryCleanupResources = remainingResources;
  } else {
    delete projected.browserTransport;
    delete projected.chromePid;
    delete projected.chromeProcessIdentity;
    delete projected.chromePort;
    delete projected.chromeHost;
    delete projected.chromeBrowserWSEndpoint;
    delete projected.chromeProfileRoot;
    delete projected.userDataDir;
    delete projected.recoveryCleanupResources;
    delete projected.recoveryCleanupResult;
  }
  return projected;
}

function projectRunningRecordToFailure(
  record: RemoteTransactionRecord,
  error: DurableRemoteAutomationError,
  discardStagedCapture = false,
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
  return state;
}

function redactTerminalRecord(record: RemoteTransactionRecord, redactedAt: string): void {
  if (!isTerminalRemoteTransactionState(record.state)) return;
  const promptEpoch = record.runtime?.promptEpoch ?? record.finalization?.runtime.promptEpoch;
  record.terminalAudit ??= {
    redactedAt,
    settlementMode: record.settlementMode,
    publicationAcknowledgedAt: record.publicationAcknowledgedAt,
    artifacts: (record.artifacts ?? []).map((artifact) => ({
      artifactId: artifact.descriptor.artifactId,
      runId: artifact.descriptor.runId,
      required: artifact.descriptor.required,
      deliveryReceipt: artifact.deliveryReceipt,
    })),
    errorCode: record.error?.code,
    errorStage: record.error?.stage,
  };
  record.finalization =
    record.finalization?.status === "completed"
      ? {
          status: "completed",
          runtime: promptEpoch ? { promptEpoch } : {},
        }
      : undefined;
  record.result = undefined;
  record.capacityReservationBytes = undefined;
  Reflect.deleteProperty(record, "requestIdentity");
  Reflect.deleteProperty(record, "browserConfig");
  Reflect.deleteProperty(record, "leaseExpiresAt");
  record.runtime = undefined;
  record.runtimeJournaledAt = undefined;
  record.modelSelection = undefined;
  record.artifacts = undefined;
  record.stagedCapture = undefined;
  record.error = undefined;
  record.settlementMode = undefined;
  Reflect.deleteProperty(record, "settlementExecutionStartedAt");
  record.publicationAcknowledgedAt = undefined;
  record.restartRecovery = undefined;
}

function sameArtifactDeliveryReceipt(
  left: DurableRemoteArtifactDeliveryReceipt,
  right: DurableRemoteArtifactDeliveryReceipt,
): boolean {
  return (
    left.receiptId === right.receiptId &&
    left.byteSize === right.byteSize &&
    left.sha256 === right.sha256
  );
}
