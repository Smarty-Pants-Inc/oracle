import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { extractStableConversationIdFromUrl, isStableConversationUrl } from "./conversationUrl.js";

/**
 * True when the URL points at a specific ChatGPT conversation (`/c/<id>`) on
 * chatgpt.com or chat.openai.com. Rejects home, project shell, and external
 * URLs — anything else would be unsafe to auto-reopen in a persistent
 * signed-in browser profile.
 */
export function isRecoverableChatGptConversationUrl(candidate: string | null | undefined): boolean {
  const trimmed = candidate?.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.port) {
      return false;
    }
    if (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") {
      return false;
    }
    return isStableConversationUrl(url.pathname);
  } catch {
    return false;
  }
}

export function hasRecoverableChatGptConversation(
  runtime: BrowserRuntimeMetadata | null | undefined,
): boolean {
  const epoch = runtime?.promptEpoch;
  if (
    !runtime ||
    !epoch ||
    epoch.status !== "committed" ||
    typeof epoch.epochId !== "string" ||
    !epoch.epochId.trim() ||
    typeof epoch.promptSha256 !== "string" ||
    !epoch.promptSha256.trim() ||
    !Number.isInteger(epoch.baselineTurns) ||
    epoch.baselineTurns < 0 ||
    !Number.isInteger(epoch.followUpOrdinal) ||
    epoch.followUpOrdinal < 0 ||
    !Number.isInteger(epoch.remainingFollowUps) ||
    epoch.remainingFollowUps !== 0 ||
    !Number.isInteger(epoch.verifiedUserTurnIndex) ||
    epoch.verifiedUserTurnIndex < epoch.baselineTurns ||
    typeof epoch.conversationId !== "string" ||
    !epoch.conversationId.trim()
  ) {
    return false;
  }
  const locators: string[] = [];
  const explicitConversationId = runtime.conversationId?.trim();
  if (explicitConversationId) {
    locators.push(explicitConversationId);
  }
  const tabUrl = runtime.tabUrl?.trim();
  if (tabUrl) {
    const tabConversationId = extractStableConversationIdFromUrl(tabUrl);
    if (tabConversationId) {
      if (!isRecoverableChatGptConversationUrl(tabUrl)) return false;
      locators.push(tabConversationId);
    }
  }
  return (
    locators.length > 0 &&
    locators.every((conversationId) => conversationId === epoch.conversationId)
  );
}
