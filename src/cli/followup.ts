import type { BrowserSessionConfig, SessionMetadata } from "../sessionStore.js";
import { CHATGPT_URL } from "../browser/constants.js";
import { buildConversationUrl, extractConversationIdFromUrl } from "../browser/reattachHelpers.js";
import { resolveRecoveryUrl } from "../browser/recoverConversation.js";
import { isRecoverableChatGptConversationUrl } from "../browser/reattachability.js";
import { DEFAULT_MODEL } from "../oracle/config.js";
import type { ModelName } from "../oracle/types.js";

export interface BrowserFollowupResolution {
  sessionId: string;
  resumeConversationUrl: string;
  model: ModelName;
  browserConfig: BrowserSessionConfig;
}

export interface FollowupSessionReader {
  readSession(sessionId: string): Promise<SessionMetadata | null>;
}

/**
 * Resolve the ChatGPT conversation URL to reopen for a browser follow-up.
 *
 * A committed prompt epoch is the durable conversation authority. Its exact
 * conversation id must bind every recovered URL and is the only permitted
 * fallback id. URL-only fallback remains solely for epoch-less legacy sessions;
 * a pending epoch cannot authorize a follow-up target.
 */
export function resolveBrowserResumeConversationUrl(
  metadata: SessionMetadata,
  fallbackBaseUrl = CHATGPT_URL,
): string | null {
  const runtime = metadata.browser?.runtime;
  const promptEpoch = runtime?.promptEpoch;
  if (promptEpoch && promptEpoch.status !== "committed") return null;

  const gatedUrl = resolveRecoveryUrl(metadata);
  if (gatedUrl) return gatedUrl;

  const committedConversationId =
    promptEpoch?.status === "committed" ? promptEpoch.conversationId.trim() : null;
  if (promptEpoch && !committedConversationId) return null;
  if (committedConversationId) {
    const harvestUrl = metadata.browser?.harvest?.url;
    const runtimeUrl = runtime?.tabUrl;
    if (
      (typeof harvestUrl === "string" &&
        isRecoverableChatGptConversationUrl(harvestUrl) &&
        extractConversationIdFromUrl(harvestUrl) !== committedConversationId) ||
      (typeof runtimeUrl === "string" &&
        isRecoverableChatGptConversationUrl(runtimeUrl) &&
        extractConversationIdFromUrl(runtimeUrl) !== committedConversationId)
    ) {
      return null;
    }
  }
  const storedConversationId = runtime?.conversationId?.trim();
  if (
    committedConversationId &&
    storedConversationId &&
    storedConversationId !== committedConversationId
  ) {
    return null;
  }
  const conversationId = committedConversationId ?? storedConversationId;
  if (!conversationId) return null;

  const baseUrl = metadata.browser?.config?.url ?? fallbackBaseUrl;
  const built = buildConversationUrl({ conversationId }, baseUrl);
  return built && isRecoverableChatGptConversationUrl(built) ? built : null;
}

export async function resolveBrowserFollowupReference(
  value: string,
  store: FollowupSessionReader,
): Promise<BrowserFollowupResolution | null> {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("resp_")) {
    return null;
  }

  const metadata = await store.readSession(trimmed);
  if (!metadata) {
    return null;
  }
  const mode = metadata.mode ?? metadata.options?.mode;
  const hasBrowserMetadata = Boolean(
    metadata.browser?.runtime || metadata.browser?.config || metadata.options?.browserConfig,
  );
  if (mode !== "browser" && !hasBrowserMetadata) {
    return null;
  }

  const resumeConversationUrl = resolveBrowserResumeConversationUrl(metadata);
  if (!resumeConversationUrl) {
    throw new Error(
      `Session ${trimmed} is a browser session but does not contain a ChatGPT conversation URL. Run "oracle status --hours 72 --limit 20" to list recent sessions.`,
    );
  }
  const parentBrowserConfig = metadata.options?.browserConfig ?? metadata.browser?.config;
  if (!parentBrowserConfig) {
    throw new Error(`Session ${trimmed} is missing its stored browser configuration.`);
  }
  const storedModel = metadata.options?.model ?? metadata.model;
  const model =
    typeof storedModel === "string" && storedModel.startsWith("gpt-")
      ? (storedModel as ModelName)
      : DEFAULT_MODEL;
  return {
    sessionId: metadata.id,
    resumeConversationUrl,
    model,
    browserConfig: {
      ...parentBrowserConfig,
      browserTabRef: null,
      resumeConversationUrl,
      researchMode: "off",
      archiveConversations: "never",
    },
  };
}
