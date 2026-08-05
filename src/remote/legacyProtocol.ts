import { z } from "zod";
import {
  MAX_REMOTE_ARTIFACT_BYTES,
  MAX_REMOTE_ATTACHMENT_BYTES,
  MAX_REMOTE_ATTACHMENTS,
  MAX_REMOTE_EVENT_BYTES,
  MAX_REMOTE_PROMPT_CHARS,
  MAX_REMOTE_PUBLIC_RESULT_BYTES,
  MAX_REMOTE_TOTAL_ATTACHMENT_BYTES,
  RemoteArtifactDescriptorSchema,
} from "./types.js";

export const REMOTE_LEGACY_TEXT_PROTOCOL_VERSION = 1;

const LEGACY_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

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

export const RemoteLegacyAttachmentPayloadSchema = z
  .object({
    fileName: z.string().min(1).max(255),
    displayPath: z.string().min(1).max(4096),
    sizeBytes: z.number().int().positive().max(MAX_REMOTE_ATTACHMENT_BYTES).optional(),
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
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) ||
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
    } else if (attachment.sizeBytes !== undefined && attachment.sizeBytes !== decodedSize) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "attachment size does not match payload",
      });
    }
  });

const optionalPath = z.string().max(4096).nullable().optional();
const optionalDuration = z.number().int().nonnegative().max(86_400_000).optional();
const optionalPositiveDuration = z.number().int().positive().max(86_400_000).optional();
const trustedUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine(isTrustedChatGptUrl, "URL must be an HTTPS ChatGPT origin");

/**
 * Exact predecessor request surface. Authority-bearing fields are accepted only so an explicit
 * compatibility client can be parsed; the adapter never forwards them to browser execution.
 */
export const RemoteLegacyBrowserRunConfigSchema = z
  .object({
    chromeProfile: z.string().max(255).nullable().optional(),
    chromePath: optionalPath,
    chromeCookiePath: optionalPath,
    attachRunning: z.boolean().optional(),
    browserTabRef: z.string().max(256).nullable().optional(),
    chatgptUrl: trustedUrl.nullable().optional(),
    url: trustedUrl.optional(),
    timeoutMs: optionalPositiveDuration,
    debugPort: z.number().int().positive().max(65_535).nullable().optional(),
    inputTimeoutMs: optionalPositiveDuration,
    attachmentTimeoutMs: optionalPositiveDuration,
    assistantRecheckDelayMs: optionalDuration,
    assistantRecheckTimeoutMs: optionalPositiveDuration,
    reuseChromeWaitMs: optionalDuration,
    profileLockTimeoutMs: optionalPositiveDuration,
    maxConcurrentTabs: z.number().int().positive().max(64).optional(),
    autoReattachDelayMs: optionalDuration,
    autoReattachIntervalMs: optionalDuration,
    autoReattachTimeoutMs: optionalPositiveDuration,
    cookieSync: z.boolean().optional(),
    cookieNames: z.array(z.string().min(1).max(256)).max(64).nullable().optional(),
    cookieSyncWaitMs: optionalDuration,
    inlineCookies: z.null().optional(),
    inlineCookiesSource: optionalPath,
    headless: z.boolean().optional(),
    keepBrowser: z.boolean().optional(),
    hideWindow: z.boolean().optional(),
    desiredModel: z.string().min(1).max(128).nullable().optional(),
    modelStrategy: z.enum(["select", "current", "ignore"]).optional(),
    debug: z.boolean().optional(),
    allowCookieErrors: z.boolean().optional(),
    remoteChrome: z
      .object({ host: z.string().min(1).max(255), port: z.number().int().positive().max(65_535) })
      .strict()
      .nullable()
      .optional(),
    manualLogin: z.boolean().optional(),
    manualLoginProfileDir: optionalPath,
    manualLoginCookieSync: z.boolean().optional(),
    copyProfileSource: optionalPath,
    thinkingTime: z.enum(["light", "standard", "extended", "heavy"]).optional(),
    researchMode: z.enum(["off", "deep"]).optional(),
    archiveConversations: z.enum(["auto", "always", "never"]).optional(),
    resumeConversationUrl: trustedUrl.nullable().optional(),
  })
  .strict();

export const RemoteLegacyRunPayloadSchema = z
  .object({
    prompt: z.string().min(1).max(MAX_REMOTE_PROMPT_CHARS),
    attachments: z.array(RemoteLegacyAttachmentPayloadSchema).max(MAX_REMOTE_ATTACHMENTS),
    fallbackSubmission: z
      .object({
        prompt: z.string().min(1).max(MAX_REMOTE_PROMPT_CHARS),
        attachments: z.array(RemoteLegacyAttachmentPayloadSchema).max(MAX_REMOTE_ATTACHMENTS),
      })
      .strict()
      .optional(),
    browserConfig: RemoteLegacyBrowserRunConfigSchema,
    options: z
      .object({
        heartbeatIntervalMs: z.number().int().positive().max(3_600_000).optional(),
        verbose: z.boolean().optional(),
        sessionId: z.string().regex(LEGACY_IDENTIFIER_PATTERN).optional(),
        followUpPrompts: z.array(z.string().min(1).max(MAX_REMOTE_PROMPT_CHARS)).max(32).optional(),
      })
      .strict(),
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
    const totalBytes = attachments.reduce(
      (total, attachment) => total + Buffer.from(attachment.contentBase64, "base64").byteLength,
      0,
    );
    if (totalBytes > MAX_REMOTE_TOTAL_ATTACHMENT_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "remote attachments exceed aggregate size limit",
      });
    }
  });

export const RemoteLegacyArtifactDescriptorSchema = RemoteArtifactDescriptorSchema.omit({
  required: true,
});

const RemoteLegacyRunWarningSchema = z
  .object({
    code: z.string().min(1).max(128),
    severity: z.literal("warning"),
    message: z.string().min(1).max(32_768),
  })
  .strict();

export const RemoteLegacyTextResultSchema = z
  .object({
    answerText: z.string().max(MAX_REMOTE_EVENT_BYTES),
    answerMarkdown: z.string().max(MAX_REMOTE_EVENT_BYTES),
    answerHtml: z.string().max(MAX_REMOTE_EVENT_BYTES).optional(),
    tookMs: z.number().int().nonnegative(),
    answerTokens: z.number().int().nonnegative(),
    answerChars: z.number().int().nonnegative(),
    warnings: z.array(RemoteLegacyRunWarningSchema).max(64).optional(),
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
        message: "legacy remote result exceeds aggregate size limit",
      });
    }
  });

export const RemoteLegacyRunEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("log"), message: z.string().max(1_048_576) }).strict(),
  z
    .object({
      type: z.literal("artifact-ready"),
      runId: z.string().min(1).max(128),
      artifact: RemoteLegacyArtifactDescriptorSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("artifact-progress"),
      artifactId: z.string().min(1).max(128),
      receivedBytes: z.number().int().nonnegative().optional(),
      totalBytes: z.number().int().positive().max(MAX_REMOTE_ARTIFACT_BYTES).optional(),
      phase: z.enum(["download", "transfer", "validate"]),
    })
    .strict(),
  z.object({ type: z.literal("result"), result: RemoteLegacyTextResultSchema }).strict(),
  z.object({ type: z.literal("error"), message: z.string().min(1).max(65_536) }).strict(),
]);

export const RemoteLegacyHealthResponseSchema = z
  .object({
    ok: z.literal(true),
    version: z.string().min(1).max(128).optional(),
    uptimeSeconds: z.number().int().nonnegative().optional(),
    capabilities: z
      .object({
        artifactTransfer: z.literal(true),
        artifactProtocolVersion: z.number().int().positive(),
        maxArtifactBytes: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RemoteLegacyAttachmentPayload = z.infer<typeof RemoteLegacyAttachmentPayloadSchema>;
export type RemoteLegacyBrowserRunConfig = z.infer<typeof RemoteLegacyBrowserRunConfigSchema>;
export type RemoteLegacyRunPayload = z.infer<typeof RemoteLegacyRunPayloadSchema>;
export type RemoteLegacyTextResult = z.infer<typeof RemoteLegacyTextResultSchema>;
export type RemoteLegacyRunEvent = z.infer<typeof RemoteLegacyRunEventSchema>;
