import type { BrowserSessionConfig, SessionMetadata } from "../sessionStore.js";
import { CHATGPT_URL } from "../browser/constants.js";
import { resolveRecoveryUrl } from "../browser/recoverConversation.js";
import { extractStableConversationIdFromUrl } from "../browser/conversationUrl.js";
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

const EXACT_CONVERSATION_ID = /^[a-zA-Z0-9-]+$/;

/** Legacy metadata may authorize only a conversation URL for a new run, never old cleanup state. */
function resolveCompletedLegacyConversationUrl(metadata: SessionMetadata): string | null {
  if (metadata.status !== "completed") return null;
  const runtime = metadata.browser?.runtime;
  if (!runtime || runtime.promptEpoch !== undefined) return null;

  const rawConversationId: unknown = runtime.conversationId;
  const conversationId =
    typeof rawConversationId === "string" && EXACT_CONVERSATION_ID.test(rawConversationId.trim())
      ? rawConversationId.trim()
      : undefined;
  if (rawConversationId !== undefined && !conversationId) return null;

  const rawTabUrl: unknown = runtime.tabUrl;
  let tabConversationId: string | undefined;
  let tabUrl: string | undefined;
  if (typeof rawTabUrl === "string" && rawTabUrl.trim()) {
    tabUrl = rawTabUrl.trim();
    if (!isRecoverableChatGptConversationUrl(tabUrl)) return null;
    tabConversationId = extractStableConversationIdFromUrl(tabUrl);
  } else if (rawTabUrl !== undefined && rawTabUrl !== "") {
    return null;
  }

  if (conversationId && tabConversationId && conversationId !== tabConversationId) return null;
  const exactConversationId = conversationId ?? tabConversationId;
  if (!exactConversationId) return null;

  const harvestUrl = metadata.browser?.harvest?.url;
  if (typeof harvestUrl === "string" && isRecoverableChatGptConversationUrl(harvestUrl)) {
    const harvestConversationId = extractStableConversationIdFromUrl(harvestUrl);
    if (harvestConversationId && harvestConversationId !== exactConversationId) return null;
  }

  return tabUrl ?? new URL(`/c/${exactConversationId}`, CHATGPT_URL).toString();
}

/** Resolve an exact ChatGPT conversation for a new prompt epoch or completed legacy follow-up. */
export function resolveBrowserResumeConversationUrl(
  metadata: SessionMetadata,
  fallbackBaseUrl = CHATGPT_URL,
): string | null {
  return (
    resolveRecoveryUrl(metadata, fallbackBaseUrl) ?? resolveCompletedLegacyConversationUrl(metadata)
  );
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
      `Session ${trimmed} is a browser session but does not contain a structurally valid committed prompt epoch or completed legacy metadata bound to one exact ChatGPT conversation. Run "oracle status --hours 72 --limit 20" to list recent sessions.`,
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
