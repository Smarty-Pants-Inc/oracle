import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { extractStableConversationIdFromUrl, isStableConversationUrl } from "./conversationUrl.js";
export type CommittedBrowserPromptEpoch = Extract<
  NonNullable<BrowserRuntimeMetadata["promptEpoch"]>,
  { status: "committed" }
>;

export interface CommittedPromptEpochLocator {
  epoch: CommittedBrowserPromptEpoch;
  conversationId: string;
  promptSha256: string;
  verifiedUserTurnIndex: number;
  verifiedUserTurnId: string;
  verifiedUserMessageId: string;
  conversationUrls: readonly string[];
}

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

export function resolveCommittedPromptEpochLocator(
  runtime: BrowserRuntimeMetadata | null | undefined,
  additionalConversationUrls: readonly unknown[] = [],
): CommittedPromptEpochLocator | null {
  const epoch = runtime?.promptEpoch;
  if (
    !runtime ||
    !epoch ||
    epoch.status !== "committed" ||
    typeof epoch.epochId !== "string" ||
    !epoch.epochId.trim() ||
    typeof epoch.promptSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(epoch.promptSha256) ||
    !Number.isInteger(epoch.baselineTurns) ||
    epoch.baselineTurns < 0 ||
    !Number.isInteger(epoch.followUpOrdinal) ||
    epoch.followUpOrdinal < 0 ||
    !Number.isInteger(epoch.remainingFollowUps) ||
    epoch.remainingFollowUps < 0 ||
    !Number.isInteger(epoch.verifiedUserTurnIndex) ||
    epoch.verifiedUserTurnIndex < epoch.baselineTurns ||
    typeof epoch.conversationId !== "string" ||
    !/^[a-zA-Z0-9-]+$/.test(epoch.conversationId) ||
    typeof epoch.verifiedUserTurnId !== "string" ||
    !epoch.verifiedUserTurnId.trim() ||
    typeof epoch.verifiedUserMessageId !== "string" ||
    !epoch.verifiedUserMessageId.trim()
  ) {
    return null;
  }

  if (
    runtime.conversationId !== undefined &&
    (typeof runtime.conversationId !== "string" ||
      runtime.conversationId.trim() !== epoch.conversationId)
  ) {
    return null;
  }

  const conversationUrls: string[] = [];
  for (const candidate of [...additionalConversationUrls, runtime.tabUrl]) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    if (typeof candidate !== "string") return null;
    const url = candidate.trim();
    if (!url) continue;
    if (
      !isRecoverableChatGptConversationUrl(url) ||
      extractStableConversationIdFromUrl(url) !== epoch.conversationId
    ) {
      return null;
    }
    conversationUrls.push(url);
  }

  return {
    epoch,
    conversationId: epoch.conversationId,
    promptSha256: epoch.promptSha256,
    verifiedUserTurnIndex: epoch.verifiedUserTurnIndex,
    verifiedUserTurnId: epoch.verifiedUserTurnId.trim(),
    verifiedUserMessageId: epoch.verifiedUserMessageId.trim(),
    conversationUrls,
  };
}

export function hasRecoverableChatGptConversation(
  runtime: BrowserRuntimeMetadata | null | undefined,
): boolean {
  return resolveCommittedPromptEpochLocator(runtime) !== null;
}
