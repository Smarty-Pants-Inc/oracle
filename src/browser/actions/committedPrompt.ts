import { createHash } from "node:crypto";
import type { CommittedPromptEpochLocator } from "../reattachability.js";
import {
  buildConversationTurnIdentityExpression,
  buildConversationTurnListExpression,
} from "../conversationTurns.js";

export interface SerializedCommittedPromptAuthority {
  conversationId: string;
  promptEpoch: {
    promptSha256: string;
    userTurnIndex: number;
    userTurnId: string;
    userMessageId: string;
  } | null;
}

export interface CommittedPromptProbe {
  conversationId: string;
  promptText: string | null;
  userTurnIndex?: number;
  userTurnId?: string;
  userMessageId?: string;
  promptSha256?: string;
}

export function normalizePromptForIdentity(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/```[^\n]*\n([\s\S]*?)```/g, " $1 ")
    .replace(/```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function promptIdentitySha256(prompt: string): string {
  return createHash("sha256").update(normalizePromptForIdentity(prompt), "utf8").digest("hex");
}

/** Build the browser-context counterpart of normalizePromptForIdentity. */
export function buildPromptIdentityNormalizationExpression(): string {
  return `const normalizePromptIdentity = (value) => {
    let text = value?.toLowerCase?.() ?? '';
    text = text.replace(/\`\`\`[^\\n]*\\n([\\s\\S]*?)\`\`\`/g, ' $1 ');
    text = text.replace(/\`\`\`/g, ' ');
    text = text.replace(/\`([^\`]*)\`/g, '$1');
    return text.replace(/\\s+/g, ' ').trim();
  };`;
}

/**
 * Build the browser-side reader for the authored portion of a user turn.
 * Presentation chrome and attachments are deliberately not prompt identity authority.
 */
export function buildReadUserPromptTextExpression(): string {
  return `const readUserPromptText = (turn) => {
    if (!turn || typeof turn.querySelectorAll !== 'function') return null;
    const USER_SCOPE_SELECTOR = '[data-message-author-role="user"], [data-turn="user"]';
    const CONTENT_SELECTOR = [
      '[data-message-content]',
      '[data-testid="user-message"]',
      '[data-testid*="user-message"]',
      '[data-testid="user-turn-content"]',
      '[data-testid*="user-turn-content"]',
      '[class*="whitespace-pre-wrap"]',
      '.whitespace-pre-wrap',
      '.markdown',
    ].join(', ');
    const EXCLUDED_SELECTOR = [
      'button',
      '[role="button"]',
      '[data-testid*="action"]',
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[data-testid*="file"]',
      '[aria-label*="attachment"]',
      '[aria-label*="file"]',
    ].join(', ');
    const isUserScope = (node) => node?.matches?.(USER_SCOPE_SELECTOR);
    const scopes = isUserScope(turn)
      ? [turn]
      : Array.from(turn.querySelectorAll(USER_SCOPE_SELECTOR));
    if (scopes.length !== 1) return null;
    const scope = scopes[0];
    if (!scope || typeof scope.querySelectorAll !== 'function') return null;
    const isExcluded = (node) => Boolean(node?.closest?.(EXCLUDED_SELECTOR));
    const candidates = [
      ...(scope.matches?.(CONTENT_SELECTOR) ? [scope] : []),
      ...Array.from(scope.querySelectorAll(CONTENT_SELECTOR)),
    ].filter((node) => !isExcluded(node));
    const leaves = candidates.filter(
      (candidate) => !candidates.some((other) => other !== candidate && candidate.contains?.(other)),
    );
    if (leaves.length !== 1) return null;
    const text = leaves[0]?.innerText ?? leaves[0]?.textContent;
    return typeof text === 'string' ? text : null;
  };`;
}

export function serializeCommittedPromptAuthority(
  conversationId: string,
  locator?: CommittedPromptEpochLocator,
): SerializedCommittedPromptAuthority {
  return {
    conversationId,
    promptEpoch: locator
      ? {
          promptSha256: locator.promptSha256,
          userTurnIndex: locator.verifiedUserTurnIndex,
          userTurnId: locator.verifiedUserTurnId,
          userMessageId: locator.verifiedUserMessageId,
        }
      : null,
  };
}

/**
 * Defines one committed-prompt probe in the browser realm. It authenticates the
 * conversation and exact user turn, rejects later user turns, extracts only the
 * authored prompt, and optionally verifies its normalized SHA-256 digest.
 */
export function buildCommittedPromptProbeDefinition(
  authority: SerializedCommittedPromptAuthority,
  {
    functionName = "readCommittedPromptAuthority",
    verifySha256 = false,
  }: { functionName?: string; verifySha256?: boolean } = {},
): string {
  const expectedAuthority = JSON.stringify(authority);
  const hashDefinition = verifySha256
    ? `const sha256 = async (value) => {
      if (!globalThis.crypto?.subtle || typeof TextEncoder !== 'function') return null;
      const bytes = new TextEncoder().encode(normalizePromptIdentity(value));
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    };`
    : "";
  const asyncKeyword = verifySha256 ? "async " : "";
  const hashCheck = verifySha256
    ? `const promptSha256 = await sha256(promptText);
    if (promptSha256 !== promptEpoch.promptSha256) return null;
    return { conversationId, promptText, userTurnIndex: promptEpoch.userTurnIndex, userTurnId, userMessageId, promptSha256 };`
    : `return { conversationId, promptText, userTurnIndex: promptEpoch.userTurnIndex, userTurnId, userMessageId };`;

  return `const expectedCommittedPromptAuthority = ${expectedAuthority};
  ${buildConversationTurnIdentityExpression()}
  ${buildReadUserPromptTextExpression()}
  ${buildPromptIdentityNormalizationExpression()}
  ${hashDefinition}
  const ${functionName} = ${asyncKeyword}() => {
    const href = typeof location === 'object' && location.href ? location.href : '';
    const conversationId = href.match(/\\/c\\/([a-zA-Z0-9-]+)/)?.[1] ?? null;
    if (conversationId !== expectedCommittedPromptAuthority.conversationId) return null;
    const promptEpoch = expectedCommittedPromptAuthority.promptEpoch;
    if (!promptEpoch) return { conversationId, promptText: null };
    const turns = ${buildConversationTurnListExpression()};
    const turn = turns[promptEpoch.userTurnIndex];
    if (!turn || !isUserTurn(turn)) return null;
    const userTurnId = readTurnId(turn);
    const userMessageId = readMessageId(turn);
    if (userTurnId !== promptEpoch.userTurnId || userMessageId !== promptEpoch.userMessageId) return null;
    for (let index = promptEpoch.userTurnIndex + 1; index < turns.length; index += 1) {
      if (isUserTurn(turns[index])) return null;
    }
    const promptText = readUserPromptText(turn);
    if (typeof promptText !== 'string') return null;
    ${hashCheck}
  };`;
}

export function buildCommittedPromptProbeExpression(
  authority: SerializedCommittedPromptAuthority,
  options?: { verifySha256?: boolean },
): string {
  return `(() => {
    ${buildCommittedPromptProbeDefinition(authority, options)}
    return readCommittedPromptAuthority();
  })()`;
}

export function parseCommittedPromptProbe(
  value: unknown,
  authority: SerializedCommittedPromptAuthority,
  { requirePromptSha256 = false }: { requirePromptSha256?: boolean } = {},
): CommittedPromptProbe | null {
  if (!value || typeof value !== "object") return null;
  const probe = value as Record<string, unknown>;
  if (
    probe.conversationId !== authority.conversationId ||
    (typeof probe.promptText !== "string" && probe.promptText !== null)
  ) {
    return null;
  }
  if (!authority.promptEpoch) {
    return probe.promptText === null
      ? { conversationId: authority.conversationId, promptText: null }
      : null;
  }
  const epoch = authority.promptEpoch;
  if (
    typeof probe.promptText !== "string" ||
    probe.userTurnIndex !== epoch.userTurnIndex ||
    probe.userTurnId !== epoch.userTurnId ||
    probe.userMessageId !== epoch.userMessageId
  ) {
    return null;
  }
  if (requirePromptSha256 && probe.promptSha256 !== epoch.promptSha256) return null;
  return {
    conversationId: authority.conversationId,
    promptText: probe.promptText,
    userTurnIndex: epoch.userTurnIndex,
    userTurnId: epoch.userTurnId,
    userMessageId: epoch.userMessageId,
    ...(typeof probe.promptSha256 === "string" ? { promptSha256: probe.promptSha256 } : {}),
  };
}
