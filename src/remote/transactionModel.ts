import { createHash } from "node:crypto";
import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
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
export function deriveRemoteArtifactNamespace(
  identity: Pick<RemoteTransactionRecord, "transactionToken" | "runId">,
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

export interface DurableRemoteFileIdentity {
  device: string;
  inode: string;
  birthtimeNs: string;
  ctimeNs: string;
}
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
  settlementMode?: "finalize" | "abort";
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

export interface RemoteTransactionRecord {
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
  capacityReservationBytes?: number;
  requestIdentity: BrowserRemotePromptRequestIdentity;
  browserConfig: BrowserSessionConfig;
  leaseExpiresAt: string;
  result?: RemotePublicRunResult;
  runtime?: BrowserRuntimeMetadata;
  runtimeJournaledAt?: string;
  modelSelection?: BrowserModelSelectionEvidence;
  artifacts?: DurableRemoteArtifactRegistration[];
  stagedCapture?: DurableRemoteStagedCapture;
  error?: DurableRemoteAutomationError;
  settlementMode?: "finalize" | "abort";
  settlementExecutionStartedAt?: string;
  publicationAcknowledgedAt?: string;
  finalization?: BrowserCaptureFinalizationResult;
  restartRecovery?: RemoteControllerRestartRecovery;
  terminalAudit?: DurableRemoteTerminalAudit;
}

export type RemoteTransactionBeginRecord = Pick<
  RemoteTransactionRecord,
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
      record: RemoteTransactionRecord;
      status: "bound";
      cleanupRuntime: BrowserRuntimeMetadata;
    }
  | {
      record: RemoteTransactionRecord;
      status: "completed";
      finalization: BrowserCaptureFinalizationResult;
    };

export interface RemoteTransactionSettlementAuthority {
  mode: "finalize" | "abort";
  outcome: "bound" | "completed";
  state: RemoteTransactionState;
}

export type RemoteTransactionSettlementPhase =
  | "unbound"
  | "mode-bound"
  | "executing-or-pending"
  | "terminal";

export type RemoteTransactionSettlementExecution =
  | {
      record: RemoteTransactionRecord;
      status: "executing";
      cleanupRuntime: BrowserRuntimeMetadata;
    }
  | {
      record: RemoteTransactionRecord;
      status: "completed";
      finalization: BrowserCaptureFinalizationResult;
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
      mode: "finalize" | "abort";
      durablePublication: boolean;
    };
    outcome:
      | { status: "bound"; cleanupRuntime: BrowserRuntimeMetadata }
      | { status: "completed"; finalization: BrowserCaptureFinalizationResult };
  };
  "begin-settlement-execution": {
    params: { mode: "finalize" | "abort" };
    outcome:
      | { status: "executing"; cleanupRuntime: BrowserRuntimeMetadata }
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
  record: RemoteTransactionRecord;
  persist: boolean;
  outcome: RemoteTransactionTransitionOutcome<Type>;
}

export interface RemoteTransactionReducerContext {
  controllerGeneration: string;
  leaseDurationMs: number;
  now: () => number;
  nowIso: () => string;
}
