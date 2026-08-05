import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import { markBrowserCaptureCleanupPending } from "../browser/runLifecycle.js";
import type { BrowserModelSelectionEvidence, BrowserRuntimeMetadata } from "../sessionManager.js";
import type { RemotePublicRunResult } from "./types.js";
import type {
  DurableRemoteArtifactDeliveryReceipt,
  DurableRemoteArtifactRegistration,
  DurableRemoteAutomationError,
  ExpiredRemoteTransactionSettlement,
  ReconcileRemoteTransactionResult,
  RemoteTransactionControllerShutdownAction,
  RemoteTransactionRecord,
} from "./transactionStore.js";

export class RemoteTransactionTransitionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RemoteTransactionTransitionError";
  }
}

interface RemoteTransactionTransitionDefinitions {
  "renew-lease": {
    params: Record<never, never>;
    outcome: undefined;
  };
  "journal-runtime": {
    params: {
      runtime: BrowserRuntimeMetadata;
      modelSelection?: BrowserModelSelectionEvidence;
    };
    outcome: undefined;
  };
  "journal-recovery-runtime": {
    params: { runtime: BrowserRuntimeMetadata };
    outcome: undefined;
  };
  "persist-settlement-runtime": {
    params: { runtime: BrowserRuntimeMetadata };
    outcome: undefined;
  };
  "publish-capture": {
    params: {
      runId: string;
      result: RemotePublicRunResult;
      runtime: BrowserRuntimeMetadata;
      modelSelection?: BrowserModelSelectionEvidence;
      artifacts: DurableRemoteArtifactRegistration[];
    };
    outcome: undefined;
  };
  "record-failure": {
    params: {
      runtime?: BrowserRuntimeMetadata;
      error: DurableRemoteAutomationError;
    };
    outcome: undefined;
  };
  "record-artifact-delivery": {
    params: {
      artifactId: string;
      receipt: DurableRemoteArtifactDeliveryReceipt;
    };
    outcome: DurableRemoteArtifactDeliveryReceipt;
  };
  "bind-settlement": {
    params: {
      mode: "finalize" | "abort";
      durablePublication: boolean;
    };
    outcome:
      | { status: "bound"; cleanupRuntime: BrowserRuntimeMetadata }
      | { status: "completed"; finalization: BrowserCaptureFinalizationResult };
  };
  "complete-settlement": {
    params: {
      mode: "finalize" | "abort";
      finalization: BrowserCaptureFinalizationResult;
    };
    outcome: undefined;
  };
  "prepare-controller-shutdown": {
    params: Record<never, never>;
    outcome: RemoteTransactionControllerShutdownAction;
  };
  "reconcile-controller": {
    params: {
      buildError: (
        record: RemoteTransactionRecord,
        hadRuntimeAuthority: boolean,
      ) => DurableRemoteAutomationError;
    };
    outcome: ReconcileRemoteTransactionResult | null;
  };
  expire: {
    params: {
      expectedLeaseExpiresAt: string;
      buildError: (
        record: RemoteTransactionRecord,
        hadRuntimeAuthority: boolean,
      ) => DurableRemoteAutomationError;
    };
    outcome: ExpiredRemoteTransactionSettlement | null;
  };
}

export type RemoteTransactionTransitionType = keyof RemoteTransactionTransitionDefinitions;

export type RemoteTransactionTransition<
  Type extends RemoteTransactionTransitionType = RemoteTransactionTransitionType,
> = {
  [Kind in Type]: { type: Kind } & RemoteTransactionTransitionDefinitions[Kind]["params"];
}[Type];

export type RemoteTransactionTransitionOutcome<Type extends RemoteTransactionTransitionType> =
  RemoteTransactionTransitionDefinitions[Type]["outcome"];

export interface AppliedRemoteTransactionTransition<Type extends RemoteTransactionTransitionType> {
  persist: boolean;
  outcome: RemoteTransactionTransitionOutcome<Type>;
}

export interface RemoteTransactionReducerContext {
  controllerGeneration: string;
  now: () => number;
  nowIso: () => string;
}

type RemoteTransactionReducer<Type extends RemoteTransactionTransitionType> = (
  record: RemoteTransactionRecord,
  transition: RemoteTransactionTransition<Type>,
  context: RemoteTransactionReducerContext,
) => AppliedRemoteTransactionTransition<Type>;

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
      throw new Error(
        "Cannot persist settlement runtime without its exact durable settlement mode",
      );
    }
    record.runtime = transition.runtime;
    record.runtimeJournaledAt = context.nowIso();
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
    assertArtifactRegistrationsOwned(record, transition.artifacts);
    record.controllerGeneration = context.controllerGeneration;
    record.state = "pending";
    record.result = transition.result;
    record.runtime = transition.runtime;
    record.runtimeJournaledAt = context.nowIso();
    record.modelSelection = transition.modelSelection;
    record.artifacts = transition.artifacts.length > 0 ? transition.artifacts : undefined;
    record.error = undefined;
    record.settlementMode = undefined;
    record.publicationAcknowledgedAt = undefined;
    record.finalization = undefined;
    record.restartRecovery = undefined;
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
    if (Boolean(transition.runtime) !== transition.error.recoverableDisconnect) {
      throw new Error("Failure recoverability must match durable runtime authority");
    }
    record.controllerGeneration = context.controllerGeneration;
    record.runtime = transition.runtime;
    record.runtimeJournaledAt = transition.runtime ? context.nowIso() : undefined;
    projectRunningRecordToFailure(record, transition.error);
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
    validateArtifactDeliveryReceipt(registration, transition.receipt);
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
    if (record.state === "finalized" || record.state === "aborted") {
      throw new RemoteTransactionTransitionError(
        "transaction_already_settled",
        `Transaction was already ${record.state}`,
      );
    }
    if (!record.runtime) throw new Error("Nonterminal transaction lacks runtime authority");
    if (record.state === "recoverable-error" && transition.mode === "finalize") {
      throw new RemoteTransactionTransitionError(
        "transaction_has_no_capture",
        "Recoverable browser authority has no durably captured answer to finalize",
      );
    }
    const runtimeSettlementMode = record.runtime.recoveryCleanupResult?.settlementMode;
    const authoritativeMode = record.settlementMode ?? runtimeSettlementMode;
    if (authoritativeMode && authoritativeMode !== transition.mode) {
      throw new RemoteTransactionTransitionError(
        "transaction_settlement_conflict",
        `Transaction is already bound to ${authoritativeMode}`,
      );
    }
    if (transition.mode === "finalize") {
      if (!transition.durablePublication) {
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
      record.publicationAcknowledgedAt ??= context.nowIso();
    }
    record.controllerGeneration = context.controllerGeneration;
    record.settlementMode = transition.mode;
    const cleanupRuntime =
      record.runtime.recoveryCleanupResources?.length || record.runtime.recoveryCleanupResult
        ? record.runtime
        : { ...record.runtime, recoveryCleanupResult: { status: "pending" as const } };
    record.runtime = markBrowserCaptureCleanupPending(cleanupRuntime, transition.mode);
    return { persist: true, outcome: { status: "bound", cleanupRuntime } };
  },
  "complete-settlement": (record, transition, context) => {
    if (record.settlementMode !== transition.mode) {
      throw new Error("Cannot complete cleanup without its exact durable settlement binding");
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
      if (record.error) record.error = { ...record.error, recoverableDisconnect: true };
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
    if (!record.settlementMode) {
      return { persist: false, outcome: { action: "preserve" } };
    }
    if (record.settlementMode === "finalize" && !record.publicationAcknowledgedAt) {
      throw new Error("Finalize-bound transaction lacks durable publication acknowledgement");
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
    if (
      record.state !== "running" ||
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
    const state = projectRunningRecordToFailure(record, error);
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

export function applyRemoteTransactionTransition<Type extends RemoteTransactionTransitionType>(
  record: RemoteTransactionRecord,
  transition: RemoteTransactionTransition<Type>,
  context: RemoteTransactionReducerContext,
): AppliedRemoteTransactionTransition<Type> {
  const reducer = reducers[transition.type] as RemoteTransactionReducer<Type>;
  return reducer(record, transition, context);
}

export function isTerminalRemoteTransactionState(
  state: RemoteTransactionRecord["state"],
): state is "finalized" | "aborted" | "failed" {
  return state === "finalized" || state === "aborted" || state === "failed";
}

export function missingRequiredArtifactDeliveries(
  record: Pick<RemoteTransactionRecord, "artifacts">,
): DurableRemoteArtifactRegistration[] {
  return (record.artifacts ?? []).filter(
    (artifact) => artifact.descriptor.required && !artifact.deliveryReceipt,
  );
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

function completedSettlement(
  record: RemoteTransactionRecord,
  requestedMode: "finalize" | "abort",
): BrowserCaptureFinalizationResult | null {
  if (!isTerminalRemoteTransactionState(record.state)) return null;
  const settledMode = record.terminalAudit?.settlementMode;
  if (settledMode !== requestedMode) {
    if (record.state === "failed" && !settledMode) return null;
    throw new RemoteTransactionTransitionError(
      "transaction_already_settled",
      `Transaction was already ${record.state}`,
    );
  }
  if (!record.finalization || record.finalization.status !== "completed") {
    throw new Error("Terminal remote transaction lacks completed finalization state");
  }
  return record.finalization;
}

function projectRunningRecordToFailure(
  record: RemoteTransactionRecord,
  error: DurableRemoteAutomationError,
): "recoverable-error" | "failed" {
  const state = record.runtime ? "recoverable-error" : "failed";
  record.state = state;
  record.result = undefined;
  record.modelSelection = undefined;
  record.artifacts = undefined;
  record.error = error;
  record.publicationAcknowledgedAt = undefined;
  record.finalization = undefined;
  return state;
}

function assertArtifactRegistrationsOwned(
  record: RemoteTransactionRecord,
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
      throw new Error("Remote artifact registration is not uniquely owned by its transaction");
    }
    artifactIds.add(artifact.descriptor.artifactId);
    if (artifact.deliveryReceipt) {
      validateArtifactDeliveryReceipt(artifact, artifact.deliveryReceipt);
    }
  }
}

function validateArtifactDeliveryReceipt(
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
    throw new Error("Remote artifact delivery receipt does not match registered content");
  }
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
