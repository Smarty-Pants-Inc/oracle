import { extractConversationIdFromUrl } from "./reattachHelpers.js";

export interface SupervisorThreadInfo {
  conversationId?: string;
  url?: string;
  title: string;
  isActive?: boolean;
}

interface RawThreadInfo {
  conversationId?: unknown;
  url?: unknown;
  title?: unknown;
  isActive?: unknown;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeSupervisorThread(raw: RawThreadInfo): SupervisorThreadInfo | null {
  const url = asString(raw.url);
  const title = asString(raw.title) ?? "Untitled chat";
  const conversationId = asString(raw.conversationId) ?? extractConversationIdFromUrl(url ?? "");
  return {
    conversationId,
    url,
    title,
    isActive: raw.isActive === true,
  };
}
