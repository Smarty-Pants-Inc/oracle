import { z } from "zod";
import type {
  BrowserRemotePromptRequestIdentity,
  BrowserRuntimeMetadata,
} from "../sessionManager.js";
import { promptIdentitySha256 } from "../browser/actions/promptComposer.js";

export const REMOTE_TRANSACTION_PROTOCOL_VERSION = 3;
export const MAX_REMOTE_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_REMOTE_REQUEST_BYTES = 96 * 1024 * 1024;
export const MAX_REMOTE_ATTACHMENT_BYTES = 32 * 1024 * 1024;
export const MAX_REMOTE_TOTAL_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const MAX_REMOTE_ATTACHMENTS = 32;
export const MAX_REMOTE_PROMPT_CHARS = 8 * 1024 * 1024;
export const MAX_REMOTE_EVENT_BYTES = 16 * 1024 * 1024;
export const MAX_REMOTE_PUBLIC_RESULT_BYTES = 12 * 1024 * 1024;

export const DEFAULT_REMOTE_RUN_OVERALL_TIMEOUT_MS = 22 * 60 * 1000;
export const DEFAULT_REMOTE_CONTROL_OVERALL_TIMEOUT_MS = 30_000;
export const DEFAULT_REMOTE_ARTIFACT_OVERALL_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_REMOTE_SOCKET_IDLE_TIMEOUT_MS = 90_000;

export const REMOTE_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_REMOTE_TRANSACTION_RECORDS = 1_024;
export const MAX_REMOTE_TRANSACTION_STORE_BYTES = 256 * 1024 * 1024;
export const REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES = MAX_REMOTE_EVENT_BYTES;

export const REMOTE_TRANSACTION_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const REMOTE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const REMOTE_ARTIFACT_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isTrustedChatGptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.port &&
      !url.username &&
      !url.password &&
      (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com")
    );
  } catch {
    return false;
  }
}

export const RemoteAttachmentPayloadSchema = z
  .object({
    fileName: z.string().min(1).max(255),
    displayPath: z.string().min(1).max(4096),
    sizeBytes: z.number().int().positive().max(MAX_REMOTE_ATTACHMENT_BYTES),
    contentBase64: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_REMOTE_ATTACHMENT_BYTES * 4) / 3) + 4),
  })
  .strict()
  .superRefine((attachment, context) => {
    const encoded = attachment.contentBase64;
    if (
      encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
      encoded.slice(0, -2).includes("=")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "attachment is not canonical base64",
      });
      return;
    }
    const decodedSize = Buffer.from(encoded, "base64").byteLength;
    if (decodedSize <= 0 || decodedSize > MAX_REMOTE_ATTACHMENT_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "attachment exceeds size limit" });
    } else if (attachment.sizeBytes !== decodedSize) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "attachment size does not match payload",
      });
    }
  });

/** Per-run behavior only. Browser/profile/process authority is owned by the remote service. */
export const RemoteBrowserRunConfigSchema = z
  .object({
    chatgptUrl: z
      .string()
      .min(1)
      .max(2048)
      .refine(isTrustedChatGptUrl, "chatgptUrl must be an HTTPS ChatGPT origin")
      .nullable()
      .optional(),
    timeoutMs: z.number().int().positive().max(86_400_000).optional(),
    inputTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
    attachmentTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
    assistantRecheckDelayMs: z.number().int().nonnegative().max(3_600_000).optional(),
    assistantRecheckTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
    desiredModel: z.string().min(1).max(128).nullable().optional(),
    modelStrategy: z.enum(["select", "current", "ignore"]).optional(),
    thinkingTime: z.enum(["light", "standard", "extended", "heavy"]).optional(),
    researchMode: z.enum(["off", "deep"]).optional(),
    archiveConversations: z.enum(["auto", "always", "never"]).optional(),
    resumeConversationUrl: z
      .string()
      .min(1)
      .max(2048)
      .refine(isTrustedChatGptUrl, "resumeConversationUrl must be an HTTPS ChatGPT origin")
      .nullable()
      .optional(),
  })
  .strict();

export const RemoteRunOptionsSchema = z
  .object({
    heartbeatIntervalMs: z.number().int().positive().max(3_600_000).optional(),
    verbose: z.boolean().optional(),
    sessionId: z.string().regex(REMOTE_IDENTIFIER_PATTERN).optional(),
    followUpPrompts: z.array(z.string().min(1).max(MAX_REMOTE_PROMPT_CHARS)).max(32).optional(),
    keepConversationTab: z.boolean().optional(),
  })
  .strict();

export const RemoteRunPayloadSchema = z
  .object({
    protocolVersion: z.literal(REMOTE_TRANSACTION_PROTOCOL_VERSION),
    prompt: z.string().min(1).max(MAX_REMOTE_PROMPT_CHARS),
    attachments: z.array(RemoteAttachmentPayloadSchema).max(MAX_REMOTE_ATTACHMENTS),
    fallbackSubmission: z
      .object({
        prompt: z.string().min(1).max(MAX_REMOTE_PROMPT_CHARS),
        attachments: z.array(RemoteAttachmentPayloadSchema).max(MAX_REMOTE_ATTACHMENTS),
      })
      .strict()
      .optional(),
    browserConfig: RemoteBrowserRunConfigSchema,
    options: RemoteRunOptionsSchema,
  })
  .strict()
  .superRefine((payload, context) => {
    const attachments = [
      ...payload.attachments,
      ...(payload.fallbackSubmission?.attachments ?? []),
    ];
    if (attachments.length > MAX_REMOTE_ATTACHMENTS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "remote attachment count exceeds limit",
      });
    }
    const totalBytes = attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0);
    if (totalBytes > MAX_REMOTE_TOTAL_ATTACHMENT_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "remote attachments exceed aggregate size limit",
      });
    }
  });

export const RemoteArtifactCapabilitiesSchema = z
  .object({
    artifactTransfer: z.literal(true),
    artifactProtocolVersion: z.number().int().positive(),
    transactionProtocolVersion: z.literal(REMOTE_TRANSACTION_PROTOCOL_VERSION),
    maxArtifactBytes: z.number().int().positive(),
    maxRequestBytes: z.number().int().positive(),
    maxAttachmentBytes: z.number().int().positive(),
    maxTotalAttachmentBytes: z.number().int().positive(),
    maxAttachments: z.number().int().positive(),
    maxPromptChars: z.number().int().positive(),
    transportSecurity: z.literal("loopback-http"),
    boundedRequestDeadlines: z.literal(true),
    boundedTransactionStore: z.literal(true),
  })
  .strict();

export const RemoteArtifactDescriptorSchema = z
  .object({
    artifactId: z.string().regex(REMOTE_ARTIFACT_IDENTIFIER_PATTERN),
    runId: z.string().regex(REMOTE_ARTIFACT_IDENTIFIER_PATTERN),
    kind: z.literal("file"),
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(255).optional(),
    byteSize: z.number().int().positive().max(MAX_REMOTE_ARTIFACT_BYTES),
    sha256: z.string().regex(SHA256_PATTERN),
    validation: z
      .object({
        type: z.enum(["generic", "zip"]),
        ok: z.boolean(),
        error: z.string().max(4096).optional(),
      })
      .strict()
      .optional(),
    sourceUrlKind: z.enum(["sandbox", "chatgpt-file-endpoint", "browser-download"]),
    transferStatus: z.enum(["ready", "streaming", "completed", "failed", "skipped"]),
    required: z.boolean(),
  })
  .strict();

export const RemoteCommittedPromptEpochSchema = z
  .object({
    status: z.literal("committed"),
    epochId: z.string().min(1).max(128),
    promptSha256: z.string().regex(SHA256_PATTERN),
    baselineTurns: z.number().int().nonnegative(),
    followUpOrdinal: z.number().int().nonnegative(),
    remainingFollowUps: z.number().int().nonnegative(),
    verifiedUserTurnIndex: z.number().int().nonnegative(),
    verifiedUserTurnId: z.string().min(1).max(256),
    verifiedUserMessageId: z.string().min(1).max(256),
    conversationId: z.string().regex(REMOTE_IDENTIFIER_PATTERN),
  })
  .strict();

const RemotePendingCleanupSchema = z.object({ status: z.literal("pending") }).strict();
const RemoteCompletedCleanupSchema = z.object({ status: z.literal("completed") }).strict();

export const RemotePublicRuntimeSchema = z.union([
  z
    .object({
      promptEpoch: RemoteCommittedPromptEpochSchema.optional(),
      cleanup: RemotePendingCleanupSchema,
    })
    .strict(),
  z
    .object({
      promptEpoch: RemoteCommittedPromptEpochSchema.optional(),
      cleanup: RemoteCompletedCleanupSchema,
    })
    .strict(),
]);

export const RemoteCapturedPublicRuntimeSchema = z.union([
  z
    .object({
      promptEpoch: RemoteCommittedPromptEpochSchema,
      cleanup: RemotePendingCleanupSchema,
    })
    .strict(),
  z
    .object({
      promptEpoch: RemoteCommittedPromptEpochSchema,
      cleanup: RemoteCompletedCleanupSchema,
    })
    .strict(),
]);

const RemoteArchiveResultSchema = z
  .object({
    mode: z.enum(["auto", "always", "never"]),
    attempted: z.boolean(),
    archived: z.boolean(),
    conversationUrl: z
      .string()
      .max(2048)
      .refine(isTrustedChatGptUrl, "conversationUrl must be an HTTPS ChatGPT origin")
      .optional(),
  })
  .strict();

const RemoteModelSelectionSchema = z
  .object({
    requestedModel: z.string().max(128).nullable().optional(),
    resolvedLabel: z.string().max(128).nullable().optional(),
    strategy: z.enum(["select", "current", "ignore"]).optional(),
    status: z.enum([
      "already-selected",
      "switched",
      "switched-best-effort",
      "skipped",
      "unavailable",
    ]),
    verified: z.boolean(),
    source: z.enum(["chatgpt-model-picker", "config"]),
    capturedAt: z.string().min(1).max(64),
  })
  .strict();

export const RemotePublicRunResultSchema = z
  .object({
    answerText: z.string().max(MAX_REMOTE_EVENT_BYTES),
    answerMarkdown: z.string().max(MAX_REMOTE_EVENT_BYTES),
    answerHtml: z.string().max(MAX_REMOTE_EVENT_BYTES).optional(),
    archive: RemoteArchiveResultSchema.optional(),
    modelSelection: RemoteModelSelectionSchema.optional(),
    warnings: z
      .array(
        z
          .object({
            code: z.string().min(1).max(128),
            severity: z.literal("warning"),
            message: z.string().min(1).max(32_768),
          })
          .strict(),
      )
      .max(64)
      .optional(),
    tookMs: z.number().int().nonnegative(),
    answerTokens: z.number().int().nonnegative(),
    answerChars: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.answerChars !== result.answerText.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "answerChars does not match answerText",
      });
    }
    const publicBytes =
      Buffer.byteLength(result.answerText, "utf8") +
      Buffer.byteLength(result.answerMarkdown, "utf8") +
      Buffer.byteLength(result.answerHtml ?? "", "utf8");
    if (publicBytes > MAX_REMOTE_PUBLIC_RESULT_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "public remote result exceeds aggregate size limit",
      });
    }
  });

const RemotePendingTransactionSchema = z
  .object({
    protocolVersion: z.literal(REMOTE_TRANSACTION_PROTOCOL_VERSION),
    transactionToken: z.string().regex(REMOTE_TRANSACTION_TOKEN_PATTERN),
    runId: z.string().regex(REMOTE_ARTIFACT_IDENTIFIER_PATTERN),
    result: RemotePublicRunResultSchema,
    runtime: z
      .object({
        promptEpoch: RemoteCommittedPromptEpochSchema,
        cleanup: RemotePendingCleanupSchema,
      })
      .strict(),
    artifacts: z.array(RemoteArtifactDescriptorSchema).max(MAX_REMOTE_ATTACHMENTS),
    state: z.literal("pending"),
  })
  .strict();

const RemoteTerminalTransactionSchema = z
  .object({
    protocolVersion: z.literal(REMOTE_TRANSACTION_PROTOCOL_VERSION),
    transactionToken: z.string().regex(REMOTE_TRANSACTION_TOKEN_PATTERN),
    runId: z.string().regex(REMOTE_ARTIFACT_IDENTIFIER_PATTERN),
    result: RemotePublicRunResultSchema,
    runtime: z
      .object({
        promptEpoch: RemoteCommittedPromptEpochSchema,
        cleanup: RemoteCompletedCleanupSchema,
      })
      .strict(),
    artifacts: z.array(RemoteArtifactDescriptorSchema).max(MAX_REMOTE_ATTACHMENTS),
    state: z.enum(["finalized", "aborted"]),
  })
  .strict();

export const RemoteRunTransactionPayloadSchema = z.discriminatedUnion("state", [
  RemotePendingTransactionSchema,
  RemoteTerminalTransactionSchema,
]);

const RemoteRecoverableErrorSchema = z
  .object({
    name: z.literal("BrowserAutomationError"),
    category: z.literal("browser-automation"),
    message: z.string().min(1).max(65_536),
    code: z.string().min(1).max(128).optional(),
    stage: z.string().min(1).max(128).optional(),
    recoverableDisconnect: z.literal(true),
    recoveryToken: z.string().regex(REMOTE_TRANSACTION_TOKEN_PATTERN),
    settlementMode: z.enum(["finalize", "abort"]).optional(),
    runtime: z
      .object({
        promptEpoch: RemoteCommittedPromptEpochSchema.optional(),
        cleanup: RemotePendingCleanupSchema,
      })
      .strict(),
  })
  .strict();

const RemoteTerminalErrorSchema = z
  .object({
    name: z.literal("BrowserAutomationError"),
    category: z.literal("browser-automation"),
    message: z.string().min(1).max(65_536),
    code: z.string().min(1).max(128).optional(),
    stage: z.string().min(1).max(128).optional(),
    recoverableDisconnect: z.literal(false),
  })
  .strict();

export const RemoteBrowserAutomationErrorSchema = z.discriminatedUnion("recoverableDisconnect", [
  RemoteRecoverableErrorSchema,
  RemoteTerminalErrorSchema,
]);

export const RemoteRunEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("log"), message: z.string().max(1_048_576) }).strict(),
  z
    .object({
      type: z.literal("artifact-progress"),
      artifactId: z.string().regex(REMOTE_ARTIFACT_IDENTIFIER_PATTERN),
      receivedBytes: z.number().int().nonnegative().optional(),
      totalBytes: z.number().int().positive().max(MAX_REMOTE_ARTIFACT_BYTES).optional(),
      phase: z.enum(["download", "transfer", "validate"]),
    })
    .strict(),
  z
    .object({ type: z.literal("transaction"), transaction: RemoteRunTransactionPayloadSchema })
    .strict(),
  z.object({ type: z.literal("error"), error: RemoteBrowserAutomationErrorSchema }).strict(),
]);

export const RemoteTransactionRetryResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("running") }).strict(),
  z
    .object({ status: z.literal("transaction"), transaction: RemoteRunTransactionPayloadSchema })
    .strict(),
  z.object({ status: z.literal("error"), error: RemoteBrowserAutomationErrorSchema }).strict(),
]);

const RemotePendingFinalizationSchema = z
  .object({
    status: z.literal("pending"),
    runtime: z
      .object({
        promptEpoch: RemoteCommittedPromptEpochSchema.optional(),
        cleanup: RemotePendingCleanupSchema,
      })
      .strict(),
    error: z.string().min(1).max(4096),
  })
  .strict();

const RemoteCompletedFinalizationSchema = z
  .object({
    status: z.literal("completed"),
    runtime: z
      .object({
        promptEpoch: RemoteCommittedPromptEpochSchema.optional(),
        cleanup: RemoteCompletedCleanupSchema,
      })
      .strict(),
  })
  .strict();

export const RemoteTransactionSettlementResponseSchema = z.discriminatedUnion("state", [
  z
    .object({
      transactionToken: z.string().regex(REMOTE_TRANSACTION_TOKEN_PATTERN),
      state: z.literal("pending"),
      finalization: RemotePendingFinalizationSchema,
    })
    .strict(),
  z
    .object({
      transactionToken: z.string().regex(REMOTE_TRANSACTION_TOKEN_PATTERN),
      state: z.enum(["finalized", "aborted"]),
      finalization: RemoteCompletedFinalizationSchema,
    })
    .strict(),
]);

export const RemoteFinalizeRequestSchema = z
  .object({ durablePublication: z.literal(true) })
  .strict();
export const RemoteAbortRequestSchema = z.object({}).strict();
export const RemoteRetryRequestSchema = z.object({}).strict();
export const RemoteArtifactDeliveryReceiptRequestSchema = z
  .object({
    sha256: z.string().regex(SHA256_PATTERN),
    byteSize: z.number().int().positive().max(MAX_REMOTE_ARTIFACT_BYTES),
  })
  .strict();

export const RemoteHealthResponseSchema = z
  .object({
    ok: z.literal(true),
    version: z.string().min(1).max(128),
    uptimeSeconds: z.number().int().nonnegative(),
    capabilities: RemoteArtifactCapabilitiesSchema,
  })
  .strict();

export type RemoteAttachmentPayload = z.infer<typeof RemoteAttachmentPayloadSchema>;
export type RemoteBrowserRunConfig = z.infer<typeof RemoteBrowserRunConfigSchema>;
export type RemoteRunPayload = z.infer<typeof RemoteRunPayloadSchema>;

export function buildRemotePromptRequestIdentity(
  payload: RemoteRunPayload,
): BrowserRemotePromptRequestIdentity {
  const followUpPrompts = payload.options.followUpPrompts ?? [];
  const finalFollowUp = followUpPrompts.at(-1);
  const acceptedPrompts = finalFollowUp
    ? [finalFollowUp]
    : [payload.prompt, payload.fallbackSubmission?.prompt].filter(
        (prompt): prompt is string => typeof prompt === "string",
      );
  return {
    acceptedPromptSha256: [...new Set(acceptedPrompts.map(promptIdentitySha256))],
    followUpOrdinal: followUpPrompts.length,
    remainingFollowUps: 0,
  };
}
export type RemoteArtifactCapabilities = z.infer<typeof RemoteArtifactCapabilitiesSchema>;
export type RemoteArtifactDescriptor = z.infer<typeof RemoteArtifactDescriptorSchema>;
export type RemoteArtifactDeliveryReceiptRequest = z.infer<
  typeof RemoteArtifactDeliveryReceiptRequestSchema
>;
export type RemoteCommittedPromptEpoch = z.infer<typeof RemoteCommittedPromptEpochSchema>;
export type RemotePublicRuntime = z.infer<typeof RemotePublicRuntimeSchema>;
export type RemotePublicRunResult = z.infer<typeof RemotePublicRunResultSchema>;
export type RemoteRunTransactionPayload = z.infer<typeof RemoteRunTransactionPayloadSchema>;
export type RemoteBrowserAutomationErrorPayload = z.infer<
  typeof RemoteBrowserAutomationErrorSchema
>;
export type RemoteTransactionRetryResponse = z.infer<typeof RemoteTransactionRetryResponseSchema>;
export type RemoteTransactionSettlementResponse = z.infer<
  typeof RemoteTransactionSettlementResponseSchema
>;
export type RemoteRunEvent = z.infer<typeof RemoteRunEventSchema>;

export interface RemoteTransportDeadlines {
  runOverallTimeoutMs?: number;
  controlOverallTimeoutMs?: number;
  artifactOverallTimeoutMs?: number;
  socketIdleTimeoutMs?: number;
  recoveryWindowMs?: number;
}

export interface RemoteRecoverySettlementOptions {
  runtime: BrowserRuntimeMetadata;
  /** Configured bridge host. Must exactly match the persisted authority before auth is sent. */
  configuredHost: string;
  /** Resolved bridge credential (for example ORACLE_REMOTE_TOKEN); never persisted in runtime. */
  authToken?: string;
  /** Defaults to finalize for captured answers and abort for recoverable capture errors. */
  mode?: "finalize" | "abort";
  deadlines?: RemoteTransportDeadlines;
}
