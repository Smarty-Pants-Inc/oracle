import { createHash } from "node:crypto";
import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import type { PhysicalFileSnapshot } from "../physicalFileIdentity.js";
import type {
  BrowserModelSelectionEvidence,
  BrowserRemotePromptRequestIdentity,
  BrowserRuntimeMetadata,
  BrowserSessionConfig,
} from "../sessionManager.js";
import {
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  type RemoteArtifactDescriptor,
  type RemotePublicRunResult,
} from "./types.js";

export type RemoteTransactionState =
  | "running"
  | "pending"
  | "finalized"
  | "aborted"
  | "recoverable-error"
  | "failed";
export type RemoteTransactionSettlementMode = "finalize" | "abort";

type RemoteRecoveryCleanupResult = NonNullable<BrowserRuntimeMetadata["recoveryCleanupResult"]>;

export type RemoteSettlementUnboundRuntime = Omit<
  BrowserRuntimeMetadata,
  "recoveryCleanupResult"
> & {
  recoveryCleanupResult?: Omit<RemoteRecoveryCleanupResult, "settlementMode"> & {
    settlementMode?: never;
  };
};

export type RemoteSettlementBoundRuntime<
  Mode extends RemoteTransactionSettlementMode = RemoteTransactionSettlementMode,
> = Omit<BrowserRuntimeMetadata, "recoveryCleanupResult"> & {
  recoveryCleanupResult: Omit<RemoteRecoveryCleanupResult, "settlementMode"> & {
    settlementMode: Mode;
  };
};

export type RemoteSettlementCompatibleRuntime<Mode extends RemoteTransactionSettlementMode> =
  | RemoteSettlementUnboundRuntime
  | RemoteSettlementBoundRuntime<Mode>;

export function projectRemoteSettlementRuntime(
  runtime: BrowserRuntimeMetadata,
): RemoteSettlementUnboundRuntime | RemoteSettlementBoundRuntime {
  const cleanup = runtime.recoveryCleanupResult;
  if (!cleanup) {
    const { recoveryCleanupResult: _omitted, ...unboundRuntime } = runtime;
    return unboundRuntime;
  }
  if (cleanup.settlementMode) {
    return {
      ...runtime,
      recoveryCleanupResult: { ...cleanup, settlementMode: cleanup.settlementMode },
    };
  }
  const { settlementMode: _omitted, ...unboundCleanup } = cleanup;
  return { ...runtime, recoveryCleanupResult: unboundCleanup };
}

export function projectRemoteSettlementRuntimeForMode<Mode extends RemoteTransactionSettlementMode>(
  runtime: BrowserRuntimeMetadata,
  mode: Mode,
): RemoteSettlementCompatibleRuntime<Mode> {
  const cleanup = runtime.recoveryCleanupResult;
  if (!cleanup) {
    const { recoveryCleanupResult: _omitted, ...unboundRuntime } = runtime;
    return unboundRuntime;
  }
  if (cleanup.settlementMode && cleanup.settlementMode !== mode) {
    throw new Error("Remote runtime settlement mode conflicts with durable settlement authority");
  }
  return {
    ...runtime,
    recoveryCleanupResult: { ...cleanup, settlementMode: mode },
  };
}

export function deriveRemoteArtifactNamespace(
  identity: Pick<RemoteTransactionPersistedEnvelope, "transactionToken" | "runId">,
): string {
  return `remote-${createHash("sha256")
    .update("oracle-remote-artifact-namespace-v1\0")
    .update(identity.runId)
    .update("\0")
    .update(identity.transactionToken)
    .digest("hex")}`;
}

export interface DurableRemoteArtifactDeliveryReceipt {
  receiptId: string;
  deliveredAt: string;
  byteSize: number;
  sha256: string;
}

export interface DurableRemoteArtifactManualCopyWaiver {
  waiverId: string;
  waivedAt: string;
  disposition: "manual-copy-required";
  byteSize: number;
  sha256: string;
}

export function deriveRemoteArtifactManualCopyWaiverId(params: {
  transactionToken: string;
  artifactId: string;
  byteSize: number;
  sha256: string;
}): string {
  return createHash("sha256")
    .update("oracle-remote-artifact-manual-copy-waiver-v1\0")
    .update(params.transactionToken)
    .update("\0")
    .update(params.artifactId)
    .update("\0")
    .update(params.sha256)
    .update("\0")
    .update(String(params.byteSize))
    .digest("hex");
}
export type DurableRemoteFileIdentity = PhysicalFileSnapshot;
export type RemoteArtifactNamespaceState = "uninitialized" | "initializing" | "initialized";

export interface DurableRemoteArtifactNamespaceIdentity {
  device: string;
  inode: string;
  birthtimeNs: string;
}

export interface DurableRemoteAutomationError {
  name: "BrowserAutomationError";
  category: "browser-automation";
  message: string;
  code?: string;
  stage?: string;
  recoverableDisconnect: boolean;
}

export interface DurableRemoteArtifactRegistration {
  descriptor: RemoteArtifactDescriptor & { required: boolean };
  transactionToken: string;
  canonicalPath: string;
  fileIdentity: DurableRemoteFileIdentity;
  deliveryReceipt?: DurableRemoteArtifactDeliveryReceipt;
  manualCopyWaiver?: DurableRemoteArtifactManualCopyWaiver;
}

export interface DurableRemoteTerminalAudit {
  redactedAt: string;
  settlementMode?: RemoteTransactionSettlementMode;
  publicationAcknowledgedAt?: string;
  artifacts: Array<{
    artifactId: string;
    runId: string;
    required: boolean;
    deliveryReceipt?: DurableRemoteArtifactDeliveryReceipt;
    manualCopyWaiver?: DurableRemoteArtifactManualCopyWaiver;
  }>;
  errorCode?: string;
  errorStage?: string;
}

export interface DurableRemoteCaptureWarning {
  code: string;
  message: string;
}

export interface DurableRemoteStagedCapture {
  result: RemotePublicRunResult;
  runtime: BrowserRuntimeMetadata;
  modelSelection?: BrowserModelSelectionEvidence;
  /** Undefined means artifact registration is incomplete; an explicit empty array is complete. */
  artifacts?: DurableRemoteArtifactRegistration[];
  stagedAt: string;
}

export interface RemoteControllerRestartRecovery {
  previousControllerGeneration: string;
  reconciledAt: string;
  reason: "controller-generation-changed";
}

/** Fields persisted for every transaction phase. Lifecycle authority is supplied by exact variants. */
export interface RemoteTransactionPersistedEnvelope {
  protocolVersion: typeof REMOTE_TRANSACTION_PROTOCOL_VERSION;
  transactionToken: string;
  runId: string;
  artifactNamespace: string;
  artifactNamespaceState: RemoteArtifactNamespaceState;
  artifactNamespaceIdentity?: DurableRemoteArtifactNamespaceIdentity;
  createdAt: string;
  updatedAt: string;
  controllerGeneration: string;
  state: RemoteTransactionState;
}

interface RemoteNonterminalTransactionAuthority {
  requestIdentity: BrowserRemotePromptRequestIdentity;
  browserConfig: BrowserSessionConfig;
  leaseExpiresAt: string;
  terminalAudit?: never;
}

type RemoteRunningTransactionBase = RemoteTransactionPersistedEnvelope &
  RemoteNonterminalTransactionAuthority & {
    state: "running";
    capacityReservationBytes: number;
    result?: never;
    artifacts?: never;
    error?: never;
    settlementMode?: never;
    settlementExecutionStartedAt?: never;
    publicationAcknowledgedAt?: never;
    finalization?: never;
    restartRecovery?: never;
  };

export type RemoteRunningTransactionRecord = RemoteRunningTransactionBase &
  (
    | {
        stagedCapture?: never;
        runtime?: BrowserRuntimeMetadata;
        runtimeJournaledAt?: string;
        modelSelection?: BrowserModelSelectionEvidence;
      }
    | {
        stagedCapture: DurableRemoteStagedCapture;
        runtime: BrowserRuntimeMetadata;
        runtimeJournaledAt?: string;
        modelSelection?: BrowserModelSelectionEvidence;
      }
  );

type RemotePendingCaptureTransactionBase = RemoteTransactionPersistedEnvelope &
  RemoteNonterminalTransactionAuthority & {
    state: "pending";
    capacityReservationBytes?: never;
    result: RemotePublicRunResult;
    runtimeJournaledAt?: string;
    modelSelection?: BrowserModelSelectionEvidence;
    artifacts: DurableRemoteArtifactRegistration[];
    stagedCapture?: never;
    error?: never;
    restartRecovery?: never;
  };

export type RemoteUnboundPendingCaptureTransactionRecord = RemotePendingCaptureTransactionBase & {
  runtime: RemoteSettlementUnboundRuntime;
  settlementMode?: never;
  settlementExecutionStartedAt?: never;
  publicationAcknowledgedAt?: never;
  finalization?: never;
};

export type RemoteRuntimeBoundPendingCaptureTransactionRecord =
  RemotePendingCaptureTransactionBase & {
    runtime: RemoteSettlementBoundRuntime;
    settlementMode?: never;
    settlementExecutionStartedAt?: never;
    publicationAcknowledgedAt?: never;
    finalization?: never;
  };

export type RemoteModeBoundPendingCaptureTransactionRecord = RemotePendingCaptureTransactionBase &
  (
    | {
        runtime: RemoteSettlementCompatibleRuntime<"finalize">;
        settlementMode: "finalize";
        settlementExecutionStartedAt?: never;
        publicationAcknowledgedAt?: string;
        finalization?: never;
      }
    | {
        runtime: RemoteSettlementCompatibleRuntime<"abort">;
        settlementMode: "abort";
        settlementExecutionStartedAt?: never;
        publicationAcknowledgedAt?: never;
        finalization?: never;
      }
  );

export type RemoteExecutingPendingCaptureTransactionRecord = RemotePendingCaptureTransactionBase &
  (
    | {
        runtime: RemoteSettlementCompatibleRuntime<"finalize">;
        settlementMode: "finalize";
        settlementExecutionStartedAt: string;
        publicationAcknowledgedAt: string;
        finalization?: never;
      }
    | {
        runtime: RemoteSettlementCompatibleRuntime<"abort">;
        settlementMode: "abort";
        settlementExecutionStartedAt: string;
        publicationAcknowledgedAt?: never;
        finalization?: never;
      }
  );

export type RemoteFinalizationPendingCaptureTransactionRecord =
  RemotePendingCaptureTransactionBase &
    (
      | {
          runtime: RemoteSettlementCompatibleRuntime<"finalize">;
          settlementMode: "finalize";
          settlementExecutionStartedAt: string;
          publicationAcknowledgedAt: string;
          finalization: Extract<BrowserCaptureFinalizationResult, { status: "pending" }>;
        }
      | {
          runtime: RemoteSettlementCompatibleRuntime<"abort">;
          settlementMode: "abort";
          settlementExecutionStartedAt: string;
          publicationAcknowledgedAt?: never;
          finalization: Extract<BrowserCaptureFinalizationResult, { status: "pending" }>;
        }
    );

export type RemotePendingCaptureTransactionRecord =
  | RemoteUnboundPendingCaptureTransactionRecord
  | RemoteRuntimeBoundPendingCaptureTransactionRecord
  | RemoteModeBoundPendingCaptureTransactionRecord
  | RemoteExecutingPendingCaptureTransactionRecord
  | RemoteFinalizationPendingCaptureTransactionRecord;

export type RemotePreSettlementPendingCaptureTransactionRecord =
  | RemoteUnboundPendingCaptureTransactionRecord
  | RemoteRuntimeBoundPendingCaptureTransactionRecord;

type RemoteRecoverableTransactionBase = RemoteTransactionPersistedEnvelope &
  RemoteNonterminalTransactionAuthority & {
    state: "recoverable-error";
    capacityReservationBytes?: never;
    result?: never;
    runtimeJournaledAt?: string;
    modelSelection?: never;
    artifacts?: never;
    stagedCapture?: DurableRemoteStagedCapture;
    error: DurableRemoteAutomationError;
    publicationAcknowledgedAt?: never;
    restartRecovery?: RemoteControllerRestartRecovery;
  };

export type RemoteUnboundRecoverableTransactionRecord = RemoteRecoverableTransactionBase & {
  runtime: RemoteSettlementUnboundRuntime;
  error: DurableRemoteAutomationError & { recoverableDisconnect: true };
  settlementMode?: never;
  settlementExecutionStartedAt?: never;
  finalization?: never;
};

export type RemoteRuntimeBoundRecoverableTransactionRecord = RemoteRecoverableTransactionBase & {
  runtime: RemoteSettlementBoundRuntime;
  error: DurableRemoteAutomationError & { recoverableDisconnect: true };
  settlementMode?: never;
  settlementExecutionStartedAt?: never;
  finalization?: never;
};

export type RemoteModeBoundRecoverableTransactionRecord = RemoteRecoverableTransactionBase & {
  runtime: RemoteSettlementCompatibleRuntime<"abort">;
  settlementMode: "abort";
  settlementExecutionStartedAt?: never;
  finalization?: never;
};

export type RemoteExecutingRecoverableTransactionRecord = RemoteRecoverableTransactionBase & {
  runtime: RemoteSettlementCompatibleRuntime<"abort">;
  settlementMode: "abort";
  settlementExecutionStartedAt: string;
  finalization?: never;
};

export type RemoteFinalizationRecoverableTransactionRecord = RemoteRecoverableTransactionBase & {
  runtime: RemoteSettlementCompatibleRuntime<"abort">;
  settlementMode: "abort";
  settlementExecutionStartedAt: string;
  finalization: Extract<BrowserCaptureFinalizationResult, { status: "pending" }>;
};

export type RemoteRecoverableTransactionRecord =
  | RemoteUnboundRecoverableTransactionRecord
  | RemoteRuntimeBoundRecoverableTransactionRecord
  | RemoteModeBoundRecoverableTransactionRecord
  | RemoteExecutingRecoverableTransactionRecord
  | RemoteFinalizationRecoverableTransactionRecord;

export type RemotePreSettlementRecoverableTransactionRecord =
  | RemoteUnboundRecoverableTransactionRecord
  | RemoteRuntimeBoundRecoverableTransactionRecord;

interface RemoteTerminalForbiddenAuthority {
  capacityReservationBytes?: never;
  requestIdentity?: never;
  browserConfig?: never;
  leaseExpiresAt?: never;
  result?: never;
  runtime?: never;
  runtimeJournaledAt?: never;
  modelSelection?: never;
  artifacts?: never;
  stagedCapture?: never;
  error?: never;
  settlementMode?: never;
  settlementExecutionStartedAt?: never;
  publicationAcknowledgedAt?: never;
  restartRecovery?: never;
}

type RemoteFinalizeTerminalAudit = Omit<
  DurableRemoteTerminalAudit,
  "settlementMode" | "publicationAcknowledgedAt"
> & {
  settlementMode: "finalize";
  publicationAcknowledgedAt: string;
};

type RemoteAbortTerminalAudit = Omit<
  DurableRemoteTerminalAudit,
  "settlementMode" | "publicationAcknowledgedAt"
> & {
  settlementMode: "abort";
  publicationAcknowledgedAt?: never;
};

type RemoteFailedTerminalAudit = Omit<
  DurableRemoteTerminalAudit,
  "settlementMode" | "publicationAcknowledgedAt"
> & {
  settlementMode?: never;
  publicationAcknowledgedAt?: never;
};

export type RemoteFinalizedTransactionRecord = RemoteTransactionPersistedEnvelope &
  RemoteTerminalForbiddenAuthority & {
    state: "finalized";
    terminalAudit: RemoteFinalizeTerminalAudit;
    finalization: Extract<BrowserCaptureFinalizationResult, { status: "completed" }>;
  };

export type RemoteAbortedTransactionRecord = RemoteTransactionPersistedEnvelope &
  RemoteTerminalForbiddenAuthority & {
    state: "aborted";
    terminalAudit: RemoteAbortTerminalAudit;
    finalization: Extract<BrowserCaptureFinalizationResult, { status: "completed" }>;
  };

export type RemoteFailedBeforeAuthorityTransactionRecord = RemoteTransactionPersistedEnvelope &
  RemoteTerminalForbiddenAuthority & {
    state: "failed";
    terminalAudit: RemoteFailedTerminalAudit;
    finalization?: never;
  };

export type RemoteFailedAfterAbortTransactionRecord = RemoteTransactionPersistedEnvelope &
  RemoteTerminalForbiddenAuthority & {
    state: "failed";
    terminalAudit: RemoteAbortTerminalAudit;
    finalization: Extract<BrowserCaptureFinalizationResult, { status: "completed" }>;
  };

export type RemoteFailedTransactionRecord =
  | RemoteFailedBeforeAuthorityTransactionRecord
  | RemoteFailedAfterAbortTransactionRecord;

export type RemoteTerminalTransactionRecord =
  | RemoteFinalizedTransactionRecord
  | RemoteAbortedTransactionRecord
  | RemoteFailedTransactionRecord;

export type RemoteNonterminalTransactionRecord =
  | RemoteRunningTransactionRecord
  | RemotePendingCaptureTransactionRecord
  | RemoteRecoverableTransactionRecord;

export type RemoteSettlementModeBoundTransactionRecord =
  | RemoteRuntimeBoundPendingCaptureTransactionRecord
  | RemoteModeBoundPendingCaptureTransactionRecord
  | RemoteRuntimeBoundRecoverableTransactionRecord
  | RemoteModeBoundRecoverableTransactionRecord;

export type RemoteSettlementExecutingTransactionRecord =
  | RemoteExecutingPendingCaptureTransactionRecord
  | RemoteExecutingRecoverableTransactionRecord;

export type RemoteSettlementPendingTransactionRecord =
  | RemoteFinalizationPendingCaptureTransactionRecord
  | RemoteFinalizationRecoverableTransactionRecord;

export type RemoteSettlementAuthorityTransactionRecord =
  | RemoteSettlementModeBoundTransactionRecord
  | RemoteSettlementExecutingTransactionRecord
  | RemoteSettlementPendingTransactionRecord;
export type RemoteMaterializedSettlementAuthorityTransactionRecord =
  | RemoteModeBoundPendingCaptureTransactionRecord
  | RemoteModeBoundRecoverableTransactionRecord
  | RemoteSettlementExecutingTransactionRecord
  | RemoteSettlementPendingTransactionRecord;

export type RemoteSettledTransactionRecord =
  | RemoteFinalizedTransactionRecord
  | RemoteAbortedTransactionRecord
  | RemoteFailedAfterAbortTransactionRecord;

export type RemoteTransactionRecord =
  | RemoteNonterminalTransactionRecord
  | RemoteTerminalTransactionRecord;

export type RemoteTransactionBeginRecord = Pick<
  RemoteRunningTransactionRecord,
  | "protocolVersion"
  | "transactionToken"
  | "runId"
  | "createdAt"
  | "requestIdentity"
  | "browserConfig"
>;

export interface ReconcileRemoteTransactionResult {
  transactionToken: string;
  previousControllerGeneration: string;
  state: "recoverable-error" | "failed";
  hadRuntimeAuthority: boolean;
}

export type RemoteTransactionSettlementBinding =
  | {
      record: RemoteMaterializedSettlementAuthorityTransactionRecord;
      status: "bound";
      cleanupRuntime: BrowserRuntimeMetadata;
    }
  | {
      record: RemoteSettledTransactionRecord;
      status: "completed";
      finalization: Extract<BrowserCaptureFinalizationResult, { status: "completed" }>;
    };

export interface RemoteTransactionSettlementAuthority {
  mode: RemoteTransactionSettlementMode;
  outcome: "bound" | "completed";
  state: RemoteTransactionState;
}

export type RemoteTransactionSettlementPhase =
  | "unbound"
  | "mode-bound"
  | "executing-or-pending"
  | "terminal";

export function isTerminalRemoteTransactionState(
  state: RemoteTransactionState,
): state is RemoteTerminalTransactionRecord["state"] {
  return state === "finalized" || state === "aborted" || state === "failed";
}

export function authoritativeRemoteSettlementMode(
  record: RemoteTransactionRecord,
): RemoteTransactionSettlementMode | undefined {
  if (record.state === "finalized" || record.state === "aborted" || record.state === "failed") {
    return record.terminalAudit.settlementMode;
  }
  return record.settlementMode ?? record.runtime?.recoveryCleanupResult?.settlementMode;
}

export function remoteTransactionSettlementPhase(
  record: RemoteTransactionRecord,
): RemoteTransactionSettlementPhase {
  if (isTerminalRemoteTransactionState(record.state)) return "terminal";
  if (!authoritativeRemoteSettlementMode(record)) return "unbound";
  return record.settlementExecutionStartedAt ? "executing-or-pending" : "mode-bound";
}

export type RemoteTransactionSettlementExecution =
  | {
      record: RemoteSettlementExecutingTransactionRecord | RemoteSettlementPendingTransactionRecord;
      status: "executing";
      cleanupRuntime: BrowserRuntimeMetadata;
    }
  | {
      record: RemoteSettledTransactionRecord;
      status: "completed";
      finalization: Extract<BrowserCaptureFinalizationResult, { status: "completed" }>;
    };

export interface ExpiredRemoteTransactionSettlement {
  mode: "finalize" | "abort";
  durablePublication: boolean;
}

export type RemoteTransactionControllerShutdownAction =
  | { action: "release" | "preserve" }
  | {
      action: "settle";
      mode: "finalize" | "abort";
      durablePublication: boolean;
    };

export type RemoteTransactionControllerShutdownPlan = RemoteTransactionControllerShutdownAction & {
  record: RemoteTransactionRecord;
};

interface RemoteTransactionTransitionDefinitions {
  "begin-artifact-namespace-initialization": {
    params: { runId: string };
    outcome: undefined;
  };
  "bind-artifact-namespace-identity": {
    params: { runId: string; identity: DurableRemoteArtifactNamespaceIdentity };
    outcome: undefined;
  };
  "rollback-artifact-namespace-initialization": {
    params: { runId: string; identity?: DurableRemoteArtifactNamespaceIdentity };
    outcome: undefined;
  };
  "complete-artifact-namespace-initialization": {
    params: { runId: string };
    outcome: undefined;
  };

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
  "stage-capture": {
    params: {
      runId: string;
      result: RemotePublicRunResult;
      runtime: BrowserRuntimeMetadata;
      modelSelection?: BrowserModelSelectionEvidence;
      artifacts?: DurableRemoteArtifactRegistration[];
    };
    outcome: undefined;
  };
  "promote-staged-capture": {
    params: {
      result?: RemotePublicRunResult;
      runtime?: BrowserRuntimeMetadata;
      warning?: DurableRemoteCaptureWarning;
      projectTargetSelectionLoss: boolean;
    };
    outcome: undefined;
  };
  "invalidate-staged-capture": {
    params: {
      runtime?: BrowserRuntimeMetadata;
      error: DurableRemoteAutomationError;
      settlementMode?: "abort";
    };
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
      settlementMode?: "abort";
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
  "record-artifact-manual-copy-waiver": {
    params: {
      artifactId: string;
      waiver: DurableRemoteArtifactManualCopyWaiver;
    };
    outcome: DurableRemoteArtifactManualCopyWaiver | null;
  };
  "bind-settlement": {
    params: {
      mode: RemoteTransactionSettlementMode;
      durablePublication: boolean;
    };
    outcome:
      | { status: "bound"; cleanupRuntime: BrowserRuntimeMetadata }
      | {
          status: "completed";
          finalization: Extract<BrowserCaptureFinalizationResult, { status: "completed" }>;
        };
  };
  "begin-settlement-execution": {
    params: { mode: RemoteTransactionSettlementMode };
    outcome:
      | { status: "executing"; cleanupRuntime: BrowserRuntimeMetadata }
      | {
          status: "completed";
          finalization: Extract<BrowserCaptureFinalizationResult, { status: "completed" }>;
        };
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
interface RemoteTransactionTransitionRecords {
  "begin-artifact-namespace-initialization": RemoteRunningTransactionRecord;
  "bind-artifact-namespace-identity": RemoteRunningTransactionRecord;
  "rollback-artifact-namespace-initialization": RemoteRunningTransactionRecord;
  "complete-artifact-namespace-initialization": RemoteRunningTransactionRecord;
  "renew-lease": RemoteNonterminalTransactionRecord;
  "journal-runtime": RemoteRunningTransactionRecord;
  "journal-recovery-runtime": RemotePreSettlementRecoverableTransactionRecord;
  "persist-settlement-runtime": RemoteMaterializedSettlementAuthorityTransactionRecord;
  "stage-capture": RemoteRunningTransactionRecord | RemoteRecoverableTransactionRecord;
  "promote-staged-capture": RemotePendingCaptureTransactionRecord;
  "invalidate-staged-capture": RemoteRecoverableTransactionRecord | RemoteFailedTransactionRecord;
  "publish-capture": RemotePreSettlementPendingCaptureTransactionRecord;
  "record-failure": RemoteRecoverableTransactionRecord | RemoteFailedTransactionRecord;
  "record-artifact-delivery": RemotePreSettlementPendingCaptureTransactionRecord;
  "record-artifact-manual-copy-waiver": RemotePreSettlementPendingCaptureTransactionRecord;
  "bind-settlement":
    | RemoteMaterializedSettlementAuthorityTransactionRecord
    | RemoteSettledTransactionRecord;
  "begin-settlement-execution":
    | RemoteSettlementExecutingTransactionRecord
    | RemoteSettlementPendingTransactionRecord
    | RemoteSettledTransactionRecord;
  "complete-settlement":
    | RemoteSettlementPendingTransactionRecord
    | RemoteFinalizedTransactionRecord
    | RemoteAbortedTransactionRecord;
  "prepare-controller-shutdown": RemoteTransactionRecord;
  "reconcile-controller": RemoteTransactionRecord;
  expire: RemoteTransactionRecord;
}

export type RemoteTransactionTransitionRecord<Type extends RemoteTransactionTransitionType> =
  RemoteTransactionTransitionRecords[Type];

export interface AppliedRemoteTransactionTransition<
  Type extends RemoteTransactionTransitionType,
  Record extends RemoteTransactionRecord = RemoteTransactionTransitionRecord<Type>,
> {
  record: Record;
  persist: boolean;
  outcome: RemoteTransactionTransitionOutcome<Type>;
}

export interface RemoteTransactionReducerContext {
  controllerGeneration: string;
  leaseDurationMs: number;
  now: () => number;
  nowIso: () => string;
}
