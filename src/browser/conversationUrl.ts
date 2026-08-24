const STABLE_CONVERSATION_PATH = /^(?:\/c|\/g\/([^/?#]+)\/c)\/([a-zA-Z0-9-]+)\/?$/u;

export interface ChatGptConversationScope {
  conversationId: string;
  projectKey: string | null;
}

function scopeFromPath(pathname: string): ChatGptConversationScope | undefined {
  const match = STABLE_CONVERSATION_PATH.exec(pathname);
  if (!match?.[2]) return undefined;
  const rawProject = match[1];
  return {
    conversationId: match[2],
    projectKey: rawProject
      ? (rawProject.match(/^(g-p-[0-9a-f]{32})(?=-|$)/iu)?.[1] ?? rawProject).toLowerCase()
      : null,
  };
}

function isCanonicalChatGptUrl(parsed: URL): boolean {
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === "chatgpt.com" &&
    !parsed.port &&
    !parsed.username &&
    !parsed.password &&
    !parsed.pathname.includes("%")
  );
}

/**
 * Extract a durable ChatGPT conversation id from a URL or a validated path.
 *
 * ChatGPT can briefly expose client-created routes such as `/c/WEB:<request-id>`
 * before replacing them with the persisted conversation URL. Those transient
 * routes must not be used to scope assistant-response capture or reattachment.
 */
export function extractStableConversationIdFromUrl(url: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!isCanonicalChatGptUrl(parsed)) return undefined;
    return scopeFromPath(parsed.pathname)?.conversationId;
  } catch {
    return scopeFromPath(url)?.conversationId;
  }
}

export function isStableConversationUrl(url: string): boolean {
  return extractStableConversationIdFromUrl(url) !== undefined;
}

export function chatGptConversationScopeFromUrl(url: string): ChatGptConversationScope | undefined {
  try {
    const parsed = new URL(url);
    if (!isCanonicalChatGptUrl(parsed)) return undefined;
    return scopeFromPath(parsed.pathname);
  } catch {
    return undefined;
  }
}

export function isSameChatGptConversationScope(actualUrl: string, expectedUrl: string): boolean {
  const actual = chatGptConversationScopeFromUrl(actualUrl);
  const expected = chatGptConversationScopeFromUrl(expectedUrl);
  return Boolean(
    actual &&
    expected &&
    actual.conversationId === expected.conversationId &&
    actual.projectKey === expected.projectKey,
  );
}
