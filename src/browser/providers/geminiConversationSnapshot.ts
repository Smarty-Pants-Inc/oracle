import { promptIdentitySha256 } from "../actions/committedPrompt.js";
import type { DomEvaluate } from "../providerDomFlow.js";
import { joinSelectors } from "../providerDomFlow.js";

export const GEMINI_DEEP_THINK_SELECTORS = {
  input: [
    "rich-textarea .ql-editor",
    '[role="textbox"][aria-label*="prompt" i]',
    'div[contenteditable="true"]',
  ],
  sendButton: ["button.send-button", 'button[aria-label="Send message"]'],
  toolsButton: ["button.toolbox-drawer-button", 'button[aria-label="Tools"]'],
  toolsMenuItem: ['[role="menuitemcheckbox"]', ".toolbox-drawer-item-list-button"],
  deepThinkActive: [
    ".toolbox-drawer-item-deselect-button",
    'button[aria-label*="Deselect Deep Think"]',
  ],
  uploadButton: ['button[aria-label="Open upload file menu"]', ".upload-card-button"],
  uploadMenuItem: ['[role="menuitem"]'],
  uploadTrigger: [".hidden-local-file-upload-button", ".hidden-local-upload-button"],
  uploaderContainer: [".uploader-button-container", ".file-uploader"],
  uploaderElement: ["uploader.upload-button"],
  userTurnAttachment: [".file-preview-container"],
  responseTurn: ["model-response"],
  responseText: ["message-content", ".model-response-text message-content"],
  responseComplete: [".response-footer.complete"],
  userQuery: ["user-query"],
  userQueryText: ["user-query-content", ".query-text"],
  spinner: ['[role="progressbar"]'],
  thoughtsToggle: [".thoughts-header-button", '[data-test-id="thoughts-header-button"]'],
  thoughtsContent: ["model-thoughts", '[data-test-id="model-thoughts"]'],
  hasThoughts: [".has-thoughts"],
} as const;

export const GEMINI_STABLE_ID_READER = `
  const stableAttributes = ['data-message-id', 'data-query-id', 'data-turn-id'];
  const readStableId = (turn) => {
    const selector = stableAttributes.map((name) => '[' + name + ']').join(', ');
    const nodes = [turn, ...Array.from(turn.querySelectorAll?.(selector) ?? [])];
    for (const attribute of stableAttributes) {
      const values = new Set();
      for (const node of nodes) {
        const value = node.getAttribute?.(attribute)?.trim();
        if (value) values.add(value);
      }
      if (values.size > 1) return null;
      if (values.size === 1) return attribute + ':' + Array.from(values)[0];
    }
    return null;
  };
`;

export interface GeminiConversationTurn {
  kind: "user" | "response";
  text: string;
  stableId: string | null;
  completionMarked?: boolean;
  visibleSpinner?: boolean;
}

export interface GeminiConversationSnapshot {
  ready: boolean;
  composerText: string;
  canSubmit: boolean;
  active: boolean;
  entries: GeminiConversationTurn[];
}

export interface GeminiPromptResponseAuthority {
  userStableId: string | null;
  promptSha256: string;
}

export type GeminiResponseIdentity =
  | { status: "identified"; stableId: string }
  | {
      status: "unsupported";
      issue: "response-identity-unavailable" | "response-identity-ambiguous";
      reason: string;
    };

export type GeminiPromptAssistantPairing =
  | { status: "waiting" }
  | { status: "prompt-mismatch" }
  | {
      status: "unsupported";
      issue:
        | "user-identity-unavailable"
        | "user-identity-ambiguous"
        | "multiple-responses"
        | "response-identity-unavailable"
        | "response-identity-ambiguous";
      reason: string;
    }
  | {
      status: "paired";
      response: GeminiConversationTurn & { kind: "response" };
      responseIdentity: string;
    };

export function geminiSelectorLiteral(selectors: readonly string[]): string {
  return JSON.stringify(joinSelectors(selectors));
}

function parseGeminiConversationSnapshot(value: unknown): GeminiConversationSnapshot | null {
  let decoded = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      return null;
    }
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  if (
    !("ready" in decoded) ||
    typeof decoded.ready !== "boolean" ||
    !("composerText" in decoded) ||
    typeof decoded.composerText !== "string" ||
    !("canSubmit" in decoded) ||
    typeof decoded.canSubmit !== "boolean" ||
    !("active" in decoded) ||
    typeof decoded.active !== "boolean" ||
    !("entries" in decoded) ||
    !Array.isArray(decoded.entries)
  ) {
    return null;
  }
  const entries: GeminiConversationTurn[] = [];
  for (const entry of decoded.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    if (
      !("kind" in entry) ||
      (entry.kind !== "user" && entry.kind !== "response") ||
      !("text" in entry) ||
      typeof entry.text !== "string" ||
      !("stableId" in entry) ||
      (typeof entry.stableId !== "string" && entry.stableId !== null)
    ) {
      return null;
    }
    entries.push({
      kind: entry.kind,
      text: entry.text,
      stableId: entry.stableId,
      ...(entry.kind === "response"
        ? {
            completionMarked: "completionMarked" in entry && entry.completionMarked === true,
            visibleSpinner: "visibleSpinner" in entry && entry.visibleSpinner === true,
          }
        : {}),
    });
  }
  return {
    ready: decoded.ready,
    composerText: decoded.composerText,
    canSubmit: decoded.canSubmit,
    active: decoded.active,
    entries,
  };
}

export async function readGeminiConversationSnapshot(
  evaluate: DomEvaluate,
): Promise<GeminiConversationSnapshot | null> {
  const inputSelector = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.input);
  const sendButtonSelector = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.sendButton);
  const userQuerySelector = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.userQuery);
  const userQueryTextSelector = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.userQueryText);
  const responseTurnSelector = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseTurn);
  const responseTextSelector = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseText);
  const responseCompleteSelector = geminiSelectorLiteral(
    GEMINI_DEEP_THINK_SELECTORS.responseComplete,
  );
  const spinnerSelector = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.spinner);
  const payload = await evaluate<unknown>(`(() => {
    /* oracle-pending-prompt-reconciliation */
    /* oracle-gemini-conversation-snapshot */
    ${GEMINI_STABLE_ID_READER}
    const isVisible = (node) => {
      if (!node || node.hidden || node.getAttribute?.('aria-hidden') === 'true') return false;
      const rect = node.getBoundingClientRect?.();
      return !rect || (rect.width > 0 && rect.height > 0);
    };
    const editor = Array.from(document.querySelectorAll(${inputSelector})).find(isVisible) ?? null;
    const userTurns = Array.from(document.querySelectorAll(${userQuerySelector}));
    const responseTurns = Array.from(document.querySelectorAll(${responseTurnSelector}));
    const ordered = [
      ...userTurns.map((node) => ({
        node,
        kind: 'user',
        text: node.querySelector(${userQueryTextSelector})?.textContent ?? node.textContent ?? '',
        stableId: readStableId(node),
      })),
      ...responseTurns.map((node) => ({
        node,
        kind: 'response',
        text: node.querySelector(${responseTextSelector})?.textContent ?? '',
        stableId: readStableId(node),
        completionMarked: Boolean(node.querySelector(${responseCompleteSelector})),
        visibleSpinner: Array.from(node.querySelectorAll(${spinnerSelector})).some(isVisible),
      })),
    ].sort((left, right) => {
      if (left.node === right.node) return 0;
      return left.node.compareDocumentPosition(right.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    const send = Array.from(document.querySelectorAll(${sendButtonSelector})).find(isVisible);
    return JSON.stringify({
      ready: document.readyState !== 'loading' && Boolean(editor),
      composerText: editor?.innerText ?? editor?.textContent ?? '',
      canSubmit: Boolean(send && !send.disabled && send.getAttribute?.('aria-disabled') !== 'true'),
      active: Array.from(document.querySelectorAll(${spinnerSelector})).some(isVisible),
      entries: ordered.map(({ node: _node, ...entry }) => entry),
    });
  })()`);
  return parseGeminiConversationSnapshot(payload);
}

function isCompletedGeminiResponse(
  entry: GeminiConversationTurn,
): entry is GeminiConversationTurn & { kind: "response" } {
  if (entry.kind !== "response" || entry.completionMarked !== true) return false;
  const text = entry.text.trim();
  const lower = text.toLowerCase();
  return (
    text.length > 0 &&
    !lower.includes("generating your response") &&
    !lower.includes("check back later") &&
    !lower.includes("i'm on it")
  );
}

export function geminiResponseIdentity(
  entries: readonly GeminiConversationTurn[],
  response: GeminiConversationTurn & { kind: "response" },
): GeminiResponseIdentity {
  if (!response.stableId) {
    return {
      status: "unsupported",
      issue: "response-identity-unavailable",
      reason: "Gemini response lacks a stable provider message identifier.",
    };
  }
  const matches = entries.filter(
    (entry) => entry.kind === "response" && entry.stableId === response.stableId,
  );
  if (matches.length !== 1) {
    return {
      status: "unsupported",
      issue: "response-identity-ambiguous",
      reason: "Gemini response identity is not unique in the current conversation DOM.",
    };
  }
  return { status: "identified", stableId: response.stableId };
}

export function pairGeminiPromptAndAssistant(
  entries: readonly GeminiConversationTurn[],
  authority: GeminiPromptResponseAuthority,
): GeminiPromptAssistantPairing {
  if (!authority.userStableId) {
    return {
      status: "unsupported",
      issue: "user-identity-unavailable",
      reason: "Gemini accepted the prompt without an immutable provider user identity.",
    };
  }
  let submittedUserIndex = -1;
  for (const [index, entry] of entries.entries()) {
    if (entry.stableId !== authority.userStableId) continue;
    if (submittedUserIndex >= 0) {
      return {
        status: "unsupported",
        issue: "user-identity-ambiguous",
        reason: "Gemini rendered the dispatched user message identity more than once.",
      };
    }
    submittedUserIndex = index;
  }
  if (submittedUserIndex < 0) return { status: "waiting" };

  const submittedUser = entries[submittedUserIndex];
  if (
    submittedUser.kind !== "user" ||
    promptIdentitySha256(submittedUser.text) !== authority.promptSha256
  ) {
    return { status: "prompt-mismatch" };
  }
  const completedResponses: Array<GeminiConversationTurn & { kind: "response" }> = [];
  for (let index = submittedUserIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.kind === "user") break;
    if (isCompletedGeminiResponse(entry)) completedResponses.push(entry);
  }
  if (completedResponses.length === 0) return { status: "waiting" };
  if (completedResponses.length > 1) {
    return {
      status: "unsupported",
      issue: "multiple-responses",
      reason: "Gemini rendered multiple completed responses for the dispatched user message.",
    };
  }

  const response = completedResponses[0];
  const identity = geminiResponseIdentity(entries, response);
  if (identity.status === "unsupported") return identity;
  return { status: "paired", response, responseIdentity: identity.stableId };
}
