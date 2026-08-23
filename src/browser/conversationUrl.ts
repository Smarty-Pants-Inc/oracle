const CONVERSATION_ID_PATH = /\/c\/([a-zA-Z0-9-]+)(?=[/?#]|$)/;
const EXACT_CONVERSATION_PATH =
  /^(?:\/c\/([a-zA-Z0-9-]+)|\/g\/([^/?#]+)\/(?:project\/)?c\/([a-zA-Z0-9-]+))\/?$/;
const ABSOLUTE_URL_AUTHORITY_PATTERN = /^[a-z][a-z\d+.-]*:\/\/([^/?#\\]*)/iu;

/** The only HTTPS origins accepted for ChatGPT page and session affinity. */
export const CHATGPT_ORIGINS = ["https://chatgpt.com", "https://chat.openai.com"] as const;
export const CHATGPT_ORIGIN = CHATGPT_ORIGINS[0];
export type ChatGptOrigin = (typeof CHATGPT_ORIGINS)[number];

export interface ChatGptConversationScope {
  origin: ChatGptOrigin;
  pathname: string;
  conversationId: string;
}

function isChatGptOrigin(origin: string): origin is ChatGptOrigin {
  return (CHATGPT_ORIGINS as readonly string[]).includes(origin);
}

/**
 * Parse a ChatGPT page URL using the same strict origin policy everywhere.
 * Query strings and fragments are allowed for non-conversation page checks.
 */
export function parseChatGptUrl(value: unknown): URL | null {
  const raw = String(value ?? "").trim();
  const authority = ABSOLUTE_URL_AUTHORITY_PATTERN.exec(raw)?.[1];
  if (!authority) return null;
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !isChatGptOrigin(parsed.origin) ||
      authority.toLowerCase() !== parsed.hostname.toLowerCase()
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Parse an approved, query/fragment-free conversation URL. */
export function parseChatGptConversationScope(rawUrl: unknown): ChatGptConversationScope | null {
  const parsed = parseChatGptUrl(rawUrl);
  if (!parsed || parsed.search || parsed.hash) return null;
  const match = EXACT_CONVERSATION_PATH.exec(parsed.pathname);
  const conversationId = match?.[1] ?? match?.[3];
  if (!conversationId) return null;
  return {
    origin: parsed.origin as ChatGptOrigin,
    pathname: parsed.pathname.replace(/\/$/u, ""),
    conversationId,
  };
}

/** Compare the complete approved route identity, not only its conversation id. */
export function isSameChatGptConversationUrl(actualUrl: unknown, expectedUrl: unknown): boolean {
  const actual = parseChatGptConversationScope(actualUrl);
  const expected = parseChatGptConversationScope(expectedUrl);
  return Boolean(
    actual &&
    expected &&
    actual.origin === expected.origin &&
    actual.pathname === expected.pathname &&
    actual.conversationId === expected.conversationId,
  );
}

export function buildChatGptSessionUrl(origin: string = CHATGPT_ORIGIN): string {
  if (!isChatGptOrigin(origin)) throw new Error("Unsupported ChatGPT origin.");
  return `${origin}/api/auth/session`;
}

/**
 * Extract a durable ChatGPT conversation id from a URL or pathname.
 *
 * ChatGPT can briefly expose client-created routes such as `/c/WEB:<request-id>`
 * before replacing them with the persisted conversation URL. Those transient
 * routes must not be used to scope assistant-response capture or reattachment.
 */
export function extractStableConversationIdFromUrl(url: string): string | undefined {
  if (!url) return undefined;
  return url.match(CONVERSATION_ID_PATH)?.[1];
}

export function isStableConversationUrl(url: string): boolean {
  return extractStableConversationIdFromUrl(url) !== undefined;
}
