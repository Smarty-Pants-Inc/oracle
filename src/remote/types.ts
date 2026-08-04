import type { BrowserSessionConfig } from "../sessionStore.js";
import type { BrowserRunResult } from "../browserMode.js";
import type { BrowserAttachment, BrowserCaptureFinalizationResult } from "../browser/types.js";
import type { BrowserRuntimeMetadata, SessionArtifactValidation } from "../sessionManager.js";

export const REMOTE_TRANSACTION_PROTOCOL_VERSION = 2;
export const MAX_REMOTE_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_REMOTE_REQUEST_BYTES = 96 * 1024 * 1024;
export const MAX_REMOTE_ATTACHMENT_BYTES = 32 * 1024 * 1024;
export const MAX_REMOTE_TOTAL_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const MAX_REMOTE_ATTACHMENTS = 32;
export const MAX_REMOTE_PROMPT_CHARS = 8 * 1024 * 1024;

export interface RemoteAttachmentPayload {
  fileName: string;
  displayPath: string;
  sizeBytes?: number;
  contentBase64: string;
}

/** Per-run behavior only. Browser/profile/process authority is owned by the remote service. */
export type RemoteBrowserRunConfig = Pick<
  BrowserSessionConfig,
  | "chatgptUrl"
  | "timeoutMs"
  | "inputTimeoutMs"
  | "attachmentTimeoutMs"
  | "assistantRecheckDelayMs"
  | "assistantRecheckTimeoutMs"
  | "desiredModel"
  | "modelStrategy"
  | "thinkingTime"
  | "researchMode"
  | "archiveConversations"
  | "resumeConversationUrl"
>;

export interface RemoteRunPayload {
  protocolVersion: typeof REMOTE_TRANSACTION_PROTOCOL_VERSION;
  /** Client-generated 256-bit idempotency and transaction capability token. */
  transactionToken: string;
  prompt: string;
  attachments: RemoteAttachmentPayload[];
  fallbackSubmission?: {
    prompt: string;
    attachments: RemoteAttachmentPayload[];
  };
  browserConfig: RemoteBrowserRunConfig;
  options: {
    heartbeatIntervalMs?: number;
    verbose?: boolean;
    sessionId?: string;
    followUpPrompts?: string[];
    /** Preserve the completed conversation tab, without granting browser-process authority. */
    keepConversationTab?: boolean;
  };
}

export interface RemoteArtifactCapabilities {
  artifactTransfer: boolean;
  artifactProtocolVersion: number;
  transactionProtocolVersion: typeof REMOTE_TRANSACTION_PROTOCOL_VERSION;
  maxArtifactBytes: number;
  maxRequestBytes: number;
  maxAttachmentBytes: number;
  maxTotalAttachmentBytes: number;
  maxAttachments: number;
  maxPromptChars: number;
}

export interface RemoteArtifactDescriptor {
  artifactId: string;
  runId: string;
  kind: "file";
  filename: string;
  mimeType?: string;
  byteSize: number;
  sha256: string;
  validation?: SessionArtifactValidation;
  sourceUrlKind: "sandbox" | "chatgpt-file-endpoint" | "browser-download";
  transferStatus: "ready" | "streaming" | "completed" | "failed" | "skipped";
}

export interface RemoteRunTransactionPayload {
  protocolVersion: typeof REMOTE_TRANSACTION_PROTOCOL_VERSION;
  transactionToken: string;
  runId: string;
  result: BrowserRunResult;
  runtime: BrowserRuntimeMetadata;
  artifacts: RemoteArtifactDescriptor[];
  state: "pending" | "finalized" | "aborted";
  finalization?: BrowserCaptureFinalizationResult;
}

export interface RemoteBrowserAutomationErrorPayload {
  name: "BrowserAutomationError";
  category: "browser-automation";
  message: string;
  details?: Record<string, unknown>;
  stage?: string;
  recoverableDisconnect: boolean;
  /** Opaque host-side recovery authority; meaningful only with service authentication. */
  recoveryToken?: string;
  runtime?: BrowserRuntimeMetadata;
}

export type RemoteTransactionRetryResponse =
  | { status: "running" }
  | { status: "transaction"; transaction: RemoteRunTransactionPayload }
  | { status: "error"; error: RemoteBrowserAutomationErrorPayload };

export interface RemoteTransactionSettlementResponse {
  transactionToken: string;
  state: "pending" | "finalized" | "aborted";
  finalization: BrowserCaptureFinalizationResult;
}

export interface RemoteRecoverySettlementOptions {
  runtime: BrowserRuntimeMetadata;
  /** Configured bridge host. Must exactly match the persisted authority before auth is sent. */
  configuredHost: string;
  /** Resolved bridge credential (for example ORACLE_REMOTE_TOKEN); never persisted in runtime. */
  authToken?: string;
  /** Defaults to finalize for captured answers and abort for recoverable capture errors. */
  mode?: "finalize" | "abort";
}

export type RemoteRunEvent =
  | { type: "log"; message: string }
  | {
      type: "artifact-progress";
      artifactId: string;
      receivedBytes?: number;
      totalBytes?: number;
      phase: "download" | "transfer" | "validate";
    }
  | { type: "transaction"; transaction: RemoteRunTransactionPayload }
  | { type: "error"; error: RemoteBrowserAutomationErrorPayload };

export interface SerializedAttachment extends BrowserAttachment {
  fileName: string;
  contentBase64: string;
}
