import type { BrowserLogger, ChromeClient } from "../types.js";
import {
  ASSISTANT_ROLE_SELECTOR,
  INPUT_SELECTORS,
  PROMPT_FALLBACK_SELECTOR,
  PROMPT_PRIMARY_SELECTOR,
  STOP_BUTTON_SELECTOR,
} from "../constants.js";
import {
  buildConversationTurnIdentityExpression,
  buildConversationTurnListExpression,
} from "../conversationTurns.js";
import { delay } from "../utils.js";
import { logDomFailure } from "../domDebug.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import {
  buildPromptIdentityNormalizationExpression,
  buildReadUserPromptTextExpression,
  normalizePromptForIdentity,
  promptIdentitySha256,
} from "./committedPrompt.js";
const PROMPT_TOO_LARGE_REJECTION_SELECTORS = [
  '[role="alert"]',
  '[role="status"]',
  "[aria-live]",
  '[data-testid*="toast"]',
  '[data-testid*="banner"]',
  '[data-testid*="error"]',
] as const;
const PROMPT_TOO_LARGE_REJECTION_PATTERN =
  "message (?:you submitted|is) (?:was )?too long|submit something shorter|maximum (?:message|context) length|reduce (?:the )?length of (?:your )?(?:message|prompt)";

function buildPromptTooLargeRejectionReaderExpression(): string {
  return `const readVisiblePromptTooLargeRejections = () => {
    const selectors = ${JSON.stringify(PROMPT_TOO_LARGE_REJECTION_SELECTORS)};
    const pattern = new RegExp(${JSON.stringify(PROMPT_TOO_LARGE_REJECTION_PATTERN)}, 'i');
    const fingerprint = (text) => {
      let hash = 2166136261;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return text.length + ':' + (hash >>> 0);
    };
    const matches = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        if (seen.has(node) || !isVisible(node)) continue;
        seen.add(node);
        const text = String(node.innerText ?? node.textContent ?? '').replace(/\\s+/g, ' ').trim();
        if (pattern.test(text)) matches.push({ node, fingerprint: fingerprint(text) });
      }
    }
    return matches;
  };`;
}
export interface PromptCommitVerification {
  committedTurns: number;
  promptSha256: string;
  verifiedUserTurnIndex: number;
  verifiedUserTurnId: string;
  verifiedUserMessageId: string;
  conversationId: string;
}
interface PromptTooLargeRejectionBaseline {
  fingerprintCounts: Record<string, number>;
}

export async function capturePromptTooLargeRejectionBaseline(
  Runtime: ChromeClient["Runtime"],
): Promise<PromptTooLargeRejectionBaseline | undefined> {
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      ${buildPromptTooLargeRejectionReaderExpression()}
      const fingerprintCounts = {};
      for (const { fingerprint } of readVisiblePromptTooLargeRejections()) {
        fingerprintCounts[fingerprint] = (fingerprintCounts[fingerprint] ?? 0) + 1;
      }
      return { fingerprintCounts };
    })()`,
    returnByValue: true,
  });
  const value = result.value as PromptTooLargeRejectionBaseline | undefined;
  if (!value?.fingerprintCounts || typeof value.fingerprintCounts !== "object") return undefined;
  return value;
}
function hasExactAcceptedPromptTurn(
  probe: CommitProbeState | undefined,
  expectedPromptSha256: string,
  baseline: number,
): probe is CommitProbeState & {
  turnsCount: number;
  matchedUserTurnIndex: number;
  matchedUserTurnText: string;
} {
  return (
    typeof probe?.turnsCount === "number" &&
    Number.isFinite(probe.turnsCount) &&
    typeof probe.matchedUserTurnIndex === "number" &&
    Number.isInteger(probe.matchedUserTurnIndex) &&
    probe.matchedUserTurnIndex >= baseline &&
    probe.turnsCount > probe.matchedUserTurnIndex &&
    typeof probe.matchedUserTurnText === "string" &&
    promptIdentitySha256(probe.matchedUserTurnText) === expectedPromptSha256
  );
}

export async function verifyPromptCommitted(
  Runtime: ChromeClient["Runtime"],
  prompt: string,
  timeoutMs: number,
  logger: BrowserLogger | undefined,
  baselineTurns: number,
  promptTooLargeRejectionBaseline?: PromptTooLargeRejectionBaseline,
): Promise<PromptCommitVerification> {
  if (!Number.isFinite(baselineTurns) || baselineTurns < 0) {
    throw new BrowserAutomationError(
      "Unable to verify prompt commit without a pre-dispatch conversation baseline.",
      { stage: "submit-prompt", code: "prompt-baseline-unavailable" },
    );
  }
  const baseline = Math.floor(baselineTurns);
  const deadline = Date.now() + timeoutMs;
  const normalizedPrompt = normalizePromptForIdentity(prompt);
  const expectedPromptSha256 = promptIdentitySha256(prompt);
  const encodedPrompt = JSON.stringify(normalizedPrompt);
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const stopSelectorLiteral = JSON.stringify(STOP_BUTTON_SELECTOR);
  const assistantSelectorLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const rejectionBaselineLiteral = JSON.stringify(promptTooLargeRejectionBaseline ?? null);
  // Only a full normalized prompt match in a new user turn can commit this epoch.
  // Prefixes, substrings, and historical repeated turns are never commit authority.
  const script = `(() => {
    const editor = document.querySelector(${primarySelectorLiteral});
    const fallback = document.querySelector(${fallbackSelectorLiteral});
    const inputSelectors = ${inputSelectorsLiteral};
    const baseline = ${baseline};
    const rejectionBaseline = ${rejectionBaselineLiteral};
    ${buildPromptIdentityNormalizationExpression()}
    ${buildConversationTurnIdentityExpression()}
    ${buildReadUserPromptTextExpression()}
    const normalizedPrompt = ${encodedPrompt};
    const articles = ${buildConversationTurnListExpression()};
    const readValue = (node) => {
      if (!node) return '';
      if (node instanceof HTMLTextAreaElement) return node.value ?? '';
      return node.innerText ?? '';
    };
    const isVisible = (node) => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const matchesPrompt = (text) => normalizedPrompt.length > 0 && text === normalizedPrompt;
    let matchedUserTurnIndex = null;
    let matchedUserTurnId = null;
    let matchedUserMessageId = null;
    let matchedUserTurnText = null;
    let hasPostBaselineUserTurn = false;
    for (let index = baseline; index < articles.length; index += 1) {
      const node = articles[index];
      if (!isUserTurn(node)) continue;
      hasPostBaselineUserTurn = true;
      const promptText = readUserPromptText(node);
      const text = promptText === null ? null : normalizePromptIdentity(promptText);
      if (text === null || !matchesPrompt(text)) continue;
      matchedUserTurnIndex = index;
      matchedUserTurnId = readTurnId(node);
      matchedUserMessageId = readMessageId(node);
      matchedUserTurnText = text;
      break;
    }
    const inputs = inputSelectors
      .map((selector) => document.querySelector(selector))
      .filter((node) => Boolean(node));
    const visibleInputs = inputs.filter((node) => isVisible(node));
    const activeInputs = visibleInputs.length > 0 ? visibleInputs : inputs;
    const editorValue = editor?.innerText ?? '';
    const fallbackValue = fallback?.value ?? '';
    const activeEmpty =
      activeInputs.length === 0 ? null : activeInputs.every((node) => !String(readValue(node)).trim());
    const composerCleared = activeEmpty ?? !(String(editorValue).trim() || String(fallbackValue).trim());
    const href = typeof location === 'object' && location.href ? location.href : '';
    const conversationId = href.match(/\\/c\\/([^/?#]+)/)?.[1] ?? null;
    const normalizedTurns = articles.map((node) => {
      const promptText = readUserPromptText(node);
      return promptText === null ? '' : normalizePromptIdentity(promptText);
    });
    ${buildPromptTooLargeRejectionReaderExpression()}
    const currentRejectionFingerprintCounts = {};
    for (const { fingerprint } of readVisiblePromptTooLargeRejections()) {
      currentRejectionFingerprintCounts[fingerprint] =
        (currentRejectionFingerprintCounts[fingerprint] ?? 0) + 1;
    }
    const baselineRejectionFingerprintCounts = rejectionBaseline?.fingerprintCounts ?? {};
    const promptTooLargeRejectedForDispatch = Boolean(
      rejectionBaseline && Object.keys(currentRejectionFingerprintCounts).some(
        (fingerprint) => baselineRejectionFingerprintCounts[fingerprint] === undefined,
      ),
    );
    return {
      baseline,
      matchedUserTurnIndex,
      matchedUserTurnId,
      matchedUserMessageId,
      matchedUserTurnText,
      hasPostBaselineUserTurn,
      hasNewTurn: articles.length > baseline,
      stopVisible: Boolean(document.querySelector(${stopSelectorLiteral})),
      assistantVisible: Boolean(
        document.querySelector(${assistantSelectorLiteral}) ||
          document.querySelector('[data-testid*="assistant"]'),
      ),
      composerCleared,
      promptTooLargeRejectedForDispatch,
      inConversation: Boolean(conversationId),
      conversationId,
      href,
      fallbackValue,
      editorValue,
      lastTurn: normalizedTurns[normalizedTurns.length - 1] ?? '',
      turnsCount: articles.length,
    };
  })()`;

  let lastProbe: CommitProbeState | undefined;
  let acceptedTurnProbe: CommitProbeState | undefined;
  let promptTooLargeRejectionObserved = false;
  let postBaselineTurnObserved = false;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    const info = result.value as CommitProbeState | undefined;
    if (info && typeof info === "object") {
      lastProbe = info;
    }
    if (info?.promptTooLargeRejectedForDispatch === true && promptTooLargeRejectionBaseline) {
      promptTooLargeRejectionObserved = true;
    }
    if (info?.hasNewTurn === true || info?.hasPostBaselineUserTurn === true) {
      postBaselineTurnObserved = true;
    }
    const conversationId = info?.conversationId?.trim();
    if (hasExactAcceptedPromptTurn(info, expectedPromptSha256, baseline)) {
      acceptedTurnProbe = info;
      if (
        typeof info.matchedUserTurnId === "string" &&
        info.matchedUserTurnId.trim().length > 0 &&
        typeof info.matchedUserMessageId === "string" &&
        info.matchedUserMessageId.trim().length > 0 &&
        conversationId
      ) {
        return {
          committedTurns: Math.floor(info.turnsCount),
          verifiedUserTurnIndex: info.matchedUserTurnIndex,
          promptSha256: expectedPromptSha256,
          verifiedUserTurnId: info.matchedUserTurnId.trim(),
          verifiedUserMessageId: info.matchedUserMessageId.trim(),
          conversationId,
        };
      }
    }
    await delay(100);
  }
  const finalProbe = await Runtime.evaluate({ expression: script, returnByValue: true })
    .then((res) => res?.result?.value as CommitProbeState | undefined)
    .catch(() => undefined);
  const probe = finalProbe && typeof finalProbe === "object" ? finalProbe : lastProbe;
  if (hasExactAcceptedPromptTurn(probe, expectedPromptSha256, baseline)) {
    acceptedTurnProbe = probe;
  }
  if (probe?.promptTooLargeRejectedForDispatch === true && promptTooLargeRejectionBaseline) {
    promptTooLargeRejectionObserved = true;
  }
  if (probe?.hasNewTurn === true || probe?.hasPostBaselineUserTurn === true) {
    postBaselineTurnObserved = true;
  }
  if (logger) {
    logger(
      `Prompt commit check failed; latest state: ${probe ? JSON.stringify(probe) : "unavailable"}`,
    );
    await logDomFailure(Runtime, logger, "prompt-commit");
  }
  if (acceptedTurnProbe) {
    throw new BrowserAutomationError(
      "Prompt appeared in a new user turn, but stable turn identity did not become available; refusing to resend.",
      {
        stage: "submit-prompt",
        code: "prompt-commit-identity-unavailable",
        promptLength: prompt.trim().length,
        timeoutMs,
        commitProbe: summarizeCommitProbe(acceptedTurnProbe),
      },
    );
  }
  if (
    prompt.trim().length >= 50_000 &&
    promptTooLargeRejectionObserved &&
    !postBaselineTurnObserved
  ) {
    throw new BrowserAutomationError("ChatGPT rejected the prompt as too large.", {
      stage: "submit-prompt",
      code: "prompt-too-large",
      promptLength: prompt.trim().length,
      timeoutMs,
      promptSubmissionRejected: true,
    });
  }
  throw new BrowserAutomationError(
    "Prompt did not appear in conversation before timeout (send may have failed)",
    {
      stage: "submit-prompt",
      code: "prompt-commit-timeout",
      promptLength: prompt.trim().length,
      timeoutMs,
      commitProbe: probe ? summarizeCommitProbe(probe) : undefined,
    },
  );
}

interface CommitProbeState {
  baseline?: number;
  matchedUserTurnIndex?: number | null;
  matchedUserTurnId?: string | null;
  matchedUserMessageId?: string | null;
  matchedUserTurnText?: string | null;
  hasPostBaselineUserTurn?: boolean;
  hasNewTurn?: boolean;
  stopVisible?: boolean;
  assistantVisible?: boolean;
  composerCleared?: boolean;
  inConversation?: boolean;
  promptTooLargeRejectedForDispatch?: boolean;
  conversationId?: string | null;
  turnsCount?: number;
  href?: string;
  editorValue?: string;
  fallbackValue?: string;
  lastTurn?: string;
}

// Keep booleans/counts but replace free text and stable ids with lengths/presence.
function summarizeCommitProbe(probe: CommitProbeState): Record<string, unknown> {
  return {
    baseline: probe.baseline,
    turnsCount: probe.turnsCount,
    matchedUserTurnIndex: probe.matchedUserTurnIndex,
    matchedUserTurnIdPresent: Boolean(probe.matchedUserTurnId),
    matchedUserMessageIdPresent: Boolean(probe.matchedUserMessageId),
    matchedUserTurnLength:
      typeof probe.matchedUserTurnText === "string" ? probe.matchedUserTurnText.length : undefined,
    hasPostBaselineUserTurn: probe.hasPostBaselineUserTurn,
    hasNewTurn: probe.hasNewTurn,
    stopVisible: probe.stopVisible,
    assistantVisible: probe.assistantVisible,
    composerCleared: probe.composerCleared,
    promptTooLargeRejectedForDispatch: probe.promptTooLargeRejectedForDispatch,
    inConversation: probe.inConversation,
    editorLength: typeof probe.editorValue === "string" ? probe.editorValue.length : undefined,
    lastTurnLength: typeof probe.lastTurn === "string" ? probe.lastTurn.length : undefined,
  };
}
