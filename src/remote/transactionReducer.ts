import { isDeepStrictEqual } from "node:util";
import { projectRuntimeAfterChromeTargetLoss } from "../browser/publicationSettlementCoordinator.js";
import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import { markBrowserCaptureCleanupPending } from "../browser/ownedBrowserResources.js";
import { hasRestartDurableChromeTargetCleanupAuthority } from "../browser/targetCloseAuthority.js";
import { deriveRemoteArtifactNamespace } from "./transactionModel.js";
import type {
  AppliedRemoteTransactionTransition,
  DurableRemoteStagedCapture,
  RemoteTransactionBeginRecord,
  RemoteTransactionRecord,
  RemoteTransactionReducerContext,
  RemoteTransactionSettlementAuthority,
  RemoteTransactionTransition,
  RemoteTransactionTransitionType,
} from "./transactionModel.js";
import {
  assertCapturePromotionMatchesStage,
  assertPublishedPromptIdentity,
  assertValidRemoteStagedCapture,
  captureModelSelectionIdentity,
  commitCapture,
  mergeCaptureWarnings,
  projectRunningRecordToFailure,
  redactTerminalRecord,
  RemoteTransactionTransitionError,
  sameArtifactDeliveryReceipt,
  sameArtifactManualCopyWaiver,
} from "./transactionReducerSupport.js";
import {
  authoritativeRemoteSettlementMode,
  isTerminalRemoteTransactionState,
  missingRequiredArtifactDeliveries,
  remoteTransactionSettlementPhase,
  validateRemoteArtifactDeliveryReceipt,
  validateRemoteArtifactManualCopyWaiver,
  validateRemoteArtifactOwnership,
  validateRemoteTransactionRecord,
} from "./transactionValidation.js";
import { REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES } from "./types.js";

export { RemoteTransactionTransitionError } from "./transactionReducerSupport.js";

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
  "begin-artifact-namespace-initialization": (record, transition, context) => {
    if (record.state !== "running" || record.runId !== transition.runId) {
      throw new Error("Remote artifact namespace initialization is not owned by the exact run");
    }
    assertCurrentController(record, context, "initialize artifact namespace");
    if (record.artifactNamespaceState !== "uninitialized") {
      throw new Error("Remote artifact namespace initialization has already started");
    }
    record.artifactNamespaceState = "initializing";
    return { persist: true, outcome: undefined };
  },
  "bind-artifact-namespace-identity": (record, transition, context) => {
    if (
      record.state !== "running" ||
      record.runId !== transition.runId ||
      record.artifactNamespaceState !== "initializing"
    ) {
      throw new Error("Remote artifact namespace identity is not owned by the initializing run");
    }
    assertCurrentController(record, context, "bind artifact namespace identity");
    if (
      record.artifactNamespaceIdentity &&
      !isDeepStrictEqual(record.artifactNamespaceIdentity, transition.identity)
    ) {
      throw new Error("Remote artifact namespace physical identity changed during initialization");
    }
    if (record.artifactNamespaceIdentity) return { persist: false, outcome: undefined };
    record.artifactNamespaceIdentity = transition.identity;
    return { persist: true, outcome: undefined };
  },
  "rollback-artifact-namespace-initialization": (record, transition, context) => {
    if (
      record.state !== "running" ||
      record.runId !== transition.runId ||
      record.artifactNamespaceState !== "initializing"
    ) {
      throw new Error("Remote artifact namespace rollback is not owned by the initializing run");
    }
    assertCurrentController(record, context, "roll back artifact namespace initialization");
    if (
      record.artifactNamespaceIdentity &&
      (!transition.identity ||
        !isDeepStrictEqual(record.artifactNamespaceIdentity, transition.identity))
    ) {
      throw new Error(
        "Remote artifact namespace rollback identity does not match durable authority",
      );
    }
    record.artifactNamespaceState = "uninitialized";
    delete record.artifactNamespaceIdentity;
    return { persist: true, outcome: undefined };
  },
  "complete-artifact-namespace-initialization": (record, transition, context) => {
    if (
      record.state !== "running" ||
      record.runId !== transition.runId ||
      record.artifactNamespaceState !== "initializing" ||
      !record.artifactNamespaceIdentity
    ) {
      throw new Error("Remote artifact namespace cannot complete without exact physical authority");
    }
    assertCurrentController(record, context, "complete artifact namespace initialization");
    record.artifactNamespaceState = "initialized";
    return { persist: true, outcome: undefined };
  },
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
      if (
        existing.artifacts === undefined &&
        stagedCapture.artifacts?.length === 0 &&
        !stagedCapture.result.warnings?.some(
          (warning) => warning.code === "remote-artifact-manual-copy-required",
        )
      ) {
        throw new RemoteTransactionTransitionError(
          "staged_capture_artifact_manifest_incomplete",
          "An artifact-bearing staged capture requires an explicit manual-copy fallback",
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
      transition.projectTargetSelectionLoss
        ? projectRuntimeAfterChromeTargetLoss(runtime)
        : runtime,
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
    registration.manualCopyWaiver = undefined;
    registration.deliveryReceipt = transition.receipt;
    return { persist: true, outcome: transition.receipt };
  },
  "record-artifact-manual-copy-waiver": (record, transition, context) => {
    if (record.state !== "pending" || !record.result || !record.runtime) {
      throw new Error(
        `Cannot record artifact manual-copy waiver from transaction state ${record.state}`,
      );
    }
    if (record.settlementMode) {
      throw new Error("Cannot record artifact manual-copy waiver after settlement is bound");
    }
    if (Date.parse(record.leaseExpiresAt ?? "") <= context.now()) {
      throw new Error("Cannot record artifact manual-copy waiver for an expired transaction lease");
    }
    const registration = record.artifacts?.find(
      (artifact) => artifact.descriptor.artifactId === transition.artifactId,
    );
    if (!registration) throw new Error("Remote artifact registration does not exist");
    if (!registration.descriptor.required) {
      throw new Error("Only required artifacts may receive a manual-copy waiver");
    }
    validateRemoteArtifactManualCopyWaiver(
      {
        transactionToken: registration.transactionToken,
        artifactId: registration.descriptor.artifactId,
        byteSize: registration.descriptor.byteSize,
        sha256: registration.descriptor.sha256,
      },
      transition.waiver,
    );
    if (registration.deliveryReceipt) return { persist: false, outcome: null };
    if (registration.manualCopyWaiver) {
      if (!sameArtifactManualCopyWaiver(registration.manualCopyWaiver, transition.waiver)) {
        throw new Error("Remote artifact already has a different manual-copy waiver");
      }
      return { persist: false, outcome: registration.manualCopyWaiver };
    }
    registration.manualCopyWaiver = transition.waiver;
    return { persist: true, outcome: transition.waiver };
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
          `${missingDeliveries.length} required artifact delivery receipt(s) or manual-copy waiver(s) are missing`,
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
          `${missingDeliveries.length} required artifact delivery receipt(s) or manual-copy waiver(s) are missing`,
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
    const restartDurableCleanup = hasRestartDurableChromeTargetCleanupAuthority(
      record.runtime,
      record.transactionToken,
    );
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
    artifactNamespaceState: "uninitialized",
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
