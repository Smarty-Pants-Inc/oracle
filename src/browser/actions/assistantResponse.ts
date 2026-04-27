import type { ChromeClient, BrowserLogger } from "../types.js";
import {
  ANSWER_SELECTORS,
  ASSISTANT_ROLE_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  COPY_BUTTON_SELECTOR,
  FINISHED_ACTIONS_SELECTOR,
  STOP_BUTTON_SELECTOR,
} from "../constants.js";
import { delay } from "../utils.js";
import {
  logDomFailure,
  logConversationSnapshot,
  buildConversationDebugExpression,
} from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";

const ASSISTANT_POLL_TIMEOUT_ERROR = "assistant-response-watchdog-timeout";
const ASSISTANT_EMPTY_RESPONSE_ERROR = "assistant-response-empty-turn";
const ASSISTANT_RATE_LIMIT_ERROR = "assistant-response-rate-limited";
const ASSISTANT_EMPTY_RESPONSE_MIN_GRACE_MS = 6_000;
const ASSISTANT_EMPTY_RESPONSE_MAX_GRACE_MS = 12_000;
const ASSISTANT_TERMINAL_ERROR_MAX_TEXT_LENGTH = 500;
const STALE_STOP_BUTTON_STABLE_MS = 30_000;

export function isAssistantEmptyResponseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.toLowerCase().includes(ASSISTANT_EMPTY_RESPONSE_ERROR);
}

export function isAssistantRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.toLowerCase().includes(ASSISTANT_RATE_LIMIT_ERROR);
}

function isAnswerNowPlaceholderText(normalized: string): boolean {
  const text = normalized.trim();
  if (!text) return false;
  // Learned: "Pro thinking" shows a placeholder turn that contains "Answer now".
  // That is not the final answer and must be ignored in browser automation.
  if (text === "chatgpt said:" || text === "chatgpt said") return true;
  if (
    text.includes("file upload request") &&
    (text.includes("pro thinking") || text.includes("chatgpt said"))
  ) {
    return true;
  }
  return (
    text.includes("answer now") && (text.includes("pro thinking") || text.includes("chatgpt said"))
  );
}

function isThinkingSummaryPlaceholder(candidate: {
  text?: string | null;
  html?: string | null;
}): boolean {
  const normalized = cleanAssistantText(candidate.text ?? "").toLowerCase();
  const withoutPrefix = normalized.replace(/^chatgpt said:\s*/, "").trim();
  if (withoutPrefix === "pro thinking") {
    return true;
  }
  if (!isThinkingSummaryOnlyText(normalized)) {
    return false;
  }
  const html = String(candidate.html ?? "").toLowerCase();
  if (!html) {
    return true;
  }
  return (
    html.includes("result-thinking") ||
    /<p\b[^>]*>\s*<\/p>/.test(html) ||
    /data-message-model-slug="gpt-5-[^"]*thinking/.test(html)
  );
}

function isProgressStatusPlaceholder(candidate: {
  text?: string | null;
  html?: string | null;
}): boolean {
  const normalized = cleanAssistantText(candidate.text ?? "").toLowerCase();
  return isAssistantProgressStatusOnlyText(normalized);
}

function isAssistantPlaceholderCandidate(candidate: {
  text?: string | null;
  html?: string | null;
}): boolean {
  const normalized = cleanAssistantText(candidate.text ?? "").toLowerCase();
  return (
    isAnswerNowPlaceholderText(normalized) ||
    isThinkingSummaryPlaceholder(candidate) ||
    isProgressStatusPlaceholder(candidate)
  );
}

function isThinkingSummaryOnlyText(normalized: string): boolean {
  if (!normalized) {
    return false;
  }
  const withoutPrefix = normalized.replace(/^chatgpt said:\s*/, "").trim();
  return (
    withoutPrefix === "thinking" ||
    withoutPrefix === "pro thinking" ||
    /^thought for\b[^\n]*$/.test(withoutPrefix) ||
    /^thought for\b[^\n]*\nthinking$/.test(withoutPrefix)
  );
}

function isAssistantProgressStatusOnlyText(normalized: string): boolean {
  if (!normalized) {
    return false;
  }
  const withoutPrefix = normalized.replace(/^chatgpt said:\s*/, "").trim();
  return (
    /^(?:starting|finalizing answer)(?:\.{3}|…)?$/.test(withoutPrefix) ||
    /^(?:analyzing|researching|reasoning|planning|drafting|reading|browsing|searching(?: the web)?)(?:\.{3}|…)?$/.test(
      withoutPrefix,
    )
  );
}

function getAssistantStabilityThresholds(
  currentLength: number,
  completionVisible: boolean,
): {
  completionStableTarget: number;
  requiredStableCycles: number;
  minStableMs: number;
} {
  const shortAnswer = currentLength > 0 && currentLength < 16;
  const mediumAnswer = currentLength >= 16 && currentLength < 40;
  const longAnswer = currentLength >= 40 && currentLength < 500;
  if (completionVisible) {
    return {
      completionStableTarget: shortAnswer ? 12 : mediumAnswer ? 8 : longAnswer ? 6 : 8,
      requiredStableCycles: shortAnswer ? 12 : mediumAnswer ? 8 : longAnswer ? 8 : 10,
      minStableMs: shortAnswer ? 8000 : mediumAnswer ? 1200 : longAnswer ? 2000 : 3000,
    };
  }
  return {
    completionStableTarget: Number.POSITIVE_INFINITY,
    // Completion affordances can lag behind the first visible prose. Without them,
    // require a much longer quiet window before accepting the turn as final.
    requiredStableCycles: shortAnswer ? 12 : mediumAnswer ? 16 : longAnswer ? 20 : 24,
    minStableMs: shortAnswer ? 8000 : mediumAnswer ? 6000 : longAnswer ? 8000 : 10000,
  };
}

export async function waitForAssistantResponse(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
}> {
  const start = Date.now();
  logger("Waiting for ChatGPT response");
  // Learned: two paths are needed:
  // 1) DOM observer (fast when mutations fire),
  // 2) snapshot poller (fallback when observers miss or JS stalls).
  const expression = buildResponseObserverExpression(timeoutMs, minTurnIndex);
  const evaluationPromise = Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const raceReadyEvaluation = evaluationPromise.then(
    (value) => ({ kind: "evaluation" as const, value }),
    (error) => {
      throw { source: "evaluation" as const, error };
    },
  );
  // Use AbortController to stop the poller when the evaluation wins the race,
  // preventing abandoned polling loops from consuming resources.
  const pollerAbort = new AbortController();
  const pollerPromise = pollAssistantCompletion(
    Runtime,
    timeoutMs,
    logger,
    minTurnIndex,
    pollerAbort.signal,
  ).then(
    (value) => ({ kind: "poll" as const, value }),
    (error) => ({ kind: "poll_error" as const, error }),
  );

  let evaluation: Awaited<ReturnType<ChromeClient["Runtime"]["evaluate"]>> | null = null;
  const awaitPollerResult = async (
    remainingMs: number,
  ): Promise<{
    text: string;
    html?: string;
    meta: { turnId?: string | null; messageId?: string | null };
  } | null> => {
    if (remainingMs <= 0) {
      return null;
    }
    const settled = await Promise.race([pollerPromise, delay(remainingMs).then(() => null)]);
    if (settled && settled.kind === "poll") {
      return settled.value;
    }
    if (settled && settled.kind === "poll_error") {
      const { error } = settled;
      if (error instanceof Error && error.message === ASSISTANT_POLL_TIMEOUT_ERROR) {
        return null;
      }
      evaluationPromise.catch(() => undefined);
      await terminateRuntimeExecution(Runtime);
      throw error ?? new Error("Failed to capture assistant response");
    }
    return null;
  };

  try {
    try {
      const winner = await Promise.race([raceReadyEvaluation, pollerPromise]);
      if (winner.kind === "poll") {
        if (!winner.value) {
          evaluation = await evaluationPromise;
        } else {
          logger("Captured assistant response via snapshot watchdog");
          evaluationPromise.catch(() => undefined);
          await terminateRuntimeExecution(Runtime);
          return winner.value;
        }
      } else if (winner.kind === "poll_error") {
        if (
          winner.error instanceof Error &&
          winner.error.message === ASSISTANT_POLL_TIMEOUT_ERROR
        ) {
          evaluation = await evaluationPromise;
        } else {
          evaluationPromise.catch(() => undefined);
          await terminateRuntimeExecution(Runtime);
          throw winner.error ?? new Error("Failed to capture assistant response");
        }
      } else {
        evaluation = winner.value;
      }
    } catch (wrappedError) {
      if (
        wrappedError &&
        typeof wrappedError === "object" &&
        "source" in wrappedError &&
        "error" in wrappedError
      ) {
        const { source, error } = wrappedError as { source: string; error: unknown };
        if (source === "evaluation") {
          const recovered = await recoverAssistantResponse(
            Runtime,
            timeoutMs,
            logger,
            minTurnIndex,
          );
          if (recovered) {
            return recovered;
          }
          const polled = await awaitPollerResult(Math.max(0, timeoutMs - (Date.now() - start)));
          if (polled) {
            return polled;
          }
          await logDomFailure(Runtime, logger, "assistant-response");
          throw error ?? new Error("Failed to capture assistant response");
        }
      } else {
        throw wrappedError;
      }
    }

    if (!evaluation) {
      const polled = await awaitPollerResult(Math.max(0, timeoutMs - (Date.now() - start)));
      if (polled) {
        return polled;
      }
      await logDomFailure(Runtime, logger, "assistant-response");
      throw new Error("Failed to capture assistant response");
    }

    const parsed = await parseAssistantEvaluationResult(Runtime, evaluation, logger);
    if (!parsed) {
      let remainingMs = Math.max(0, timeoutMs - (Date.now() - start));
      if (remainingMs > 0) {
        const polled = await awaitPollerResult(remainingMs);
        if (polled) {
          return polled;
        }
        remainingMs = Math.max(0, timeoutMs - (Date.now() - start));
        if (remainingMs > 0) {
          const recovered = await recoverAssistantResponse(
            Runtime,
            remainingMs,
            logger,
            minTurnIndex,
          );
          if (recovered) {
            return recovered;
          }
        }
      }
      await logDomFailure(Runtime, logger, "assistant-response");
      throw new Error("Unable to capture assistant response");
    }

    const refreshed = await refreshAssistantSnapshot(Runtime, parsed, logger, minTurnIndex);
    const candidate = refreshed ?? parsed;
    // The evaluation path can race ahead of completion. If ChatGPT is still streaming, wait for the watchdog poller.
    const elapsedMs = Date.now() - start;
    const remainingMs = Math.max(0, timeoutMs - elapsedMs);
    if (remainingMs > 0) {
      const [stopVisible, completionVisible] = await Promise.all([
        isStopButtonVisible(Runtime),
        isCompletionVisible(Runtime, minTurnIndex),
      ]);
      if (stopVisible || !completionVisible) {
        logger(
          stopVisible
            ? "Assistant still generating; waiting for completion"
            : "Assistant response is missing completion markers; waiting for a stable final turn",
        );
        const completed = await awaitPollerResult(remainingMs);
        if (completed) {
          return completed;
        }
      }
    }

    return candidate;
  } finally {
    pollerAbort.abort();
  }
}

export async function readAssistantSnapshot(
  Runtime: ChromeClient["Runtime"],
  minTurnIndex?: number,
): Promise<AssistantSnapshot | null> {
  const { result } = await Runtime.evaluate({
    expression: buildAssistantSnapshotExpression(minTurnIndex),
    returnByValue: true,
  });
  const value = result?.value;
  if (value && typeof value === "object") {
    const snapshot = value as AssistantSnapshot;
    if (typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex)) {
      const turnIndex = typeof snapshot.turnIndex === "number" ? snapshot.turnIndex : null;
      if (turnIndex === null) {
        return snapshot;
      }
      if (turnIndex < minTurnIndex) {
        return null;
      }
    }
    return snapshot;
  }
  return null;
}

export async function captureAssistantMarkdown(
  Runtime: ChromeClient["Runtime"],
  meta: { messageId?: string | null; turnId?: string | null },
  logger: BrowserLogger,
  minTurnIndex?: number,
): Promise<string | null> {
  const { result } = await Runtime.evaluate({
    expression: buildCopyExpression(meta, minTurnIndex),
    returnByValue: true,
    awaitPromise: true,
  });
  if (result?.value?.success && typeof result.value.markdown === "string") {
    return result.value.markdown;
  }
  const status = result?.value?.status;
  if (status && status !== "missing-button") {
    logger(`Copy button fallback status: ${status}`);
    await logDomFailure(Runtime, logger, "copy-markdown");
  }
  if (!status) {
    await logDomFailure(Runtime, logger, "copy-markdown");
  }
  return null;
}

export function buildAssistantExtractorForTest(name: string): string {
  return buildAssistantExtractor(name);
}

export function buildConversationDebugExpressionForTest(): string {
  return buildConversationDebugExpression();
}

export function buildMarkdownFallbackExtractorForTest(minTurnLiteral = "0"): string {
  return buildMarkdownFallbackExtractor(minTurnLiteral);
}

export function buildAssistantSnapshotExpressionForTest(minTurnIndex?: number): string {
  return buildAssistantSnapshotExpression(minTurnIndex);
}

export function buildCopyExpressionForTest(
  meta: { messageId?: string | null; turnId?: string | null } = {},
): string {
  return buildCopyExpression(meta);
}

async function recoverAssistantResponse(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const recoveryTimeoutMs = Math.max(0, timeoutMs);
  if (recoveryTimeoutMs === 0) {
    return null;
  }
  const recovered = await waitForCondition(
    async () => {
      const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex);
      return normalizeAssistantSnapshot(snapshot);
    },
    recoveryTimeoutMs,
    400,
  );
  if (recovered) {
    logger("Recovered assistant response via polling fallback");
    return recovered;
  }
  await logConversationSnapshot(Runtime, logger).catch(() => undefined);
  return null;
}

async function parseAssistantEvaluationResult(
  _Runtime: ChromeClient["Runtime"],
  evaluation: Awaited<ReturnType<ChromeClient["Runtime"]["evaluate"]>>,
  _logger: BrowserLogger,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const { result } = evaluation;
  if (
    result.type === "object" &&
    result.value &&
    typeof result.value === "object" &&
    "text" in result.value
  ) {
    const html =
      typeof (result.value as { html?: unknown }).html === "string"
        ? ((result.value as { html?: string }).html ?? undefined)
        : undefined;
    const turnId =
      typeof (result.value as { turnId?: unknown }).turnId === "string"
        ? ((result.value as { turnId?: string }).turnId ?? undefined)
        : undefined;
    const messageId =
      typeof (result.value as { messageId?: unknown }).messageId === "string"
        ? ((result.value as { messageId?: string }).messageId ?? undefined)
        : undefined;
    const text = normalizeAssistantTextCandidate(
      String((result.value as { text: unknown }).text ?? ""),
      html,
    );
    if (!text) {
      return null;
    }
    return { text, html, meta: { turnId, messageId } };
  }
  const fallbackText =
    typeof result.value === "string"
      ? normalizeAssistantTextCandidate(result.value as string, undefined)
      : null;
  if (!fallbackText) {
    return null;
  }
  return { text: fallbackText, html: undefined, meta: {} };
}

async function refreshAssistantSnapshot(
  Runtime: ChromeClient["Runtime"],
  current: {
    text: string;
    html?: string;
    meta: { turnId?: string | null; messageId?: string | null };
  },
  logger: BrowserLogger,
  minTurnIndex?: number,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const deadline = Date.now() + 5_000;
  let best: {
    text: string;
    html?: string;
    meta: { turnId?: string | null; messageId?: string | null };
  } | null = null;
  let stableCycles = 0;
  const stableTarget = 3;
  while (Date.now() < deadline) {
    // Learned: short/fast answers can race; poll a few extra cycles to pick up messageId + full text.
    const latestSnapshot = await readAssistantSnapshot(Runtime, minTurnIndex).catch(() => null);
    const latest = normalizeAssistantSnapshot(latestSnapshot);
    if (latest) {
      if (
        !best ||
        latest.text.length > best.text.length ||
        (!best.meta.messageId && latest.meta.messageId)
      ) {
        best = latest;
        stableCycles = 0;
      } else if (latest.text.trim() === best.text.trim()) {
        stableCycles += 1;
      }
    }
    if (best && stableCycles >= stableTarget) {
      break;
    }
    await delay(300);
  }
  if (!best) {
    return null;
  }
  const currentLength = cleanAssistantText(current.text).trim().length;
  const latestLength = best.text.length;
  const hasBetterId = !current.meta?.messageId && Boolean(best.meta.messageId);
  const isLonger = latestLength > currentLength;
  const hasDifferentText = best.text.trim() !== current.text.trim();
  if (isLonger || hasBetterId || hasDifferentText) {
    logger("Refreshed assistant response via latest snapshot");
    return best;
  }
  return null;
}

async function terminateRuntimeExecution(Runtime: ChromeClient["Runtime"]): Promise<void> {
  if (typeof Runtime.terminateExecution !== "function") {
    return;
  }
  try {
    await Runtime.terminateExecution();
  } catch {
    // ignore termination failures
  }
}

async function pollAssistantCompletion(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
  abortSignal?: AbortSignal,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const watchdogDeadline = Date.now() + timeoutMs;
  const emptyResponseGraceMs = Math.min(
    ASSISTANT_EMPTY_RESPONSE_MAX_GRACE_MS,
    Math.max(ASSISTANT_EMPTY_RESPONSE_MIN_GRACE_MS, Math.floor(timeoutMs * 0.1)),
  );
  let previousLength = 0;
  let stableCycles = 0;
  let lastChangeAt = Date.now();
  let emptyAssistantSince: number | null = null;
  while (Date.now() < watchdogDeadline) {
    // Check abort signal to stop polling when another path won the race
    if (abortSignal?.aborted) {
      return null;
    }
    const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex);
    const normalized = normalizeAssistantSnapshot(snapshot);
    const [stopVisible, completionVisible] = await Promise.all([
      isStopButtonVisible(Runtime),
      isCompletionVisible(Runtime, minTurnIndex),
    ]);
    const terminalError = await readAssistantTerminalError(Runtime);
    if (terminalError) {
      logger(`Assistant terminated with UI error: ${terminalError}`);
      throw new Error(terminalError);
    }
    if (!stopVisible && completionVisible && !normalized) {
      const copied = await captureAssistantCompletionViaCopy(
        Runtime,
        snapshot,
        logger,
        minTurnIndex,
      );
      if (copied) {
        return copied;
      }
    }
    if (!stopVisible && !normalized) {
      const emptyAssistantTurn = await isIdleEmptyAssistantTurn(Runtime, minTurnIndex);
      if (emptyAssistantTurn) {
        const now = Date.now();
        if (emptyAssistantSince === null) {
          emptyAssistantSince = now;
          logger("Assistant exposed an empty thinking shell; waiting for real answer text");
        }
        if (now - emptyAssistantSince >= emptyResponseGraceMs) {
          const copied = await captureAssistantCompletionViaCopy(
            Runtime,
            snapshot,
            logger,
            minTurnIndex,
          );
          if (copied) {
            return copied;
          }
          throw new Error(ASSISTANT_EMPTY_RESPONSE_ERROR);
        }
      } else {
        emptyAssistantSince = null;
      }
    } else {
      emptyAssistantSince = null;
    }
    if (normalized) {
      const currentLength = normalized.text.length;
      if (currentLength > previousLength) {
        previousLength = currentLength;
        stableCycles = 0;
        lastChangeAt = Date.now();
      } else {
        stableCycles += 1;
      }
      const stableMs = Date.now() - lastChangeAt;
      const thresholds = getAssistantStabilityThresholds(currentLength, completionVisible);
      // Require stop button to disappear before treating completion as final.
      if (!stopVisible) {
        const stableEnough =
          stableCycles >= thresholds.requiredStableCycles && stableMs >= thresholds.minStableMs;
        const completionEnough =
          completionVisible &&
          stableCycles >= thresholds.completionStableTarget &&
          stableMs >= thresholds.minStableMs;
        if (completionEnough || stableEnough) {
          return normalized;
        }
      } else if (
        stableMs >= STALE_STOP_BUTTON_STABLE_MS &&
        stableCycles >= thresholds.requiredStableCycles
      ) {
        logger("Assistant response text is stable despite a stale stop button; capturing it.");
        return normalized;
      }
    } else {
      previousLength = 0;
      stableCycles = 0;
    }
    await delay(400);
  }
  return null;
}

async function isStopButtonVisible(Runtime: ChromeClient["Runtime"]): Promise<boolean> {
  try {
    const { result } = await Runtime.evaluate({
      expression: `Boolean(document.querySelector('${STOP_BUTTON_SELECTOR}'))`,
      returnByValue: true,
    });
    return Boolean(result?.value);
  } catch {
    return false;
  }
}

async function readAssistantTerminalError(
  Runtime: ChromeClient["Runtime"],
): Promise<string | null> {
  try {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const MAX_TEXT_LENGTH = ${ASSISTANT_TERMINAL_ERROR_MAX_TEXT_LENGTH};
        const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        const matchesRateLimit = (text) => {
          if (!text || text.length > MAX_TEXT_LENGTH) {
            return false;
          }
          return (
            (text.includes('too many requests') &&
              text.includes('temporarily limited access to your conversations')) ||
            (text.includes('too many requests') &&
              text.includes('please wait a few minutes before trying again'))
          );
        };
        const isVisible = (node) => {
          if (!(node instanceof HTMLElement)) {
            return false;
          }
          const style = window.getComputedStyle(node);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            Number.parseFloat(style.opacity || '1') === 0
          ) {
            return false;
          }
          const rects = node.getClientRects();
          return rects.length > 0;
        };
        for (const candidate of Array.from(document.body?.querySelectorAll('*') || [])) {
          if (!(candidate instanceof HTMLElement)) {
            continue;
          }
          if (!isVisible(candidate)) {
            continue;
          }
          if (candidate.closest('${CONVERSATION_TURN_SELECTOR}')) {
            continue;
          }
          const text = normalize(candidate.innerText || candidate.textContent || '');
          if (matchesRateLimit(text)) {
            return '${ASSISTANT_RATE_LIMIT_ERROR}';
          }
        }
        return null;
      })()`,
      returnByValue: true,
    });
    return typeof result?.value === "string" && result.value ? result.value : null;
  } catch {
    return null;
  }
}

async function isCompletionVisible(
  Runtime: ChromeClient["Runtime"],
  minTurnIndex?: number,
): Promise<boolean> {
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  try {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const MIN_TURN_INDEX = ${minTurnLiteral};
        // Find the LAST assistant turn to check completion status
        // Must match the same logic as buildAssistantExtractor for consistency
        const ASSISTANT_SELECTOR = '${ASSISTANT_ROLE_SELECTOR}';
        const isAssistantTurn = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
          if (turnAttr === 'assistant') return true;
          const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
          if (role === 'assistant') return true;
          const testId = (node.getAttribute('data-testid') || '').toLowerCase();
          if (testId.includes('assistant')) return true;
          return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
        };
        const turns = Array.from(document.querySelectorAll('${CONVERSATION_TURN_SELECTOR}')).filter(
          (node) =>
            !(node instanceof HTMLElement && node.parentElement?.closest('${CONVERSATION_TURN_SELECTOR}')),
        );
        const hasIndexedTurns = turns.length > 0;
        const resolveTurnIndex = (node) => {
          const turn = node?.closest?.('${CONVERSATION_TURN_SELECTOR}');
          if (!turn) return null;
          const idx = turns.indexOf(turn);
          return idx >= 0 ? idx : null;
        };
        const isAfterMinTurn = (node) => {
          if (MIN_TURN_INDEX < 0 || !hasIndexedTurns) return true;
          const idx = resolveTurnIndex(node);
          return idx !== null && idx >= MIN_TURN_INDEX;
        };
        const isAssistantAction = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const turn = node.closest('${CONVERSATION_TURN_SELECTOR}');
          if (turn) {
            return isAssistantTurn(turn);
          }
          return Boolean(
            node.closest('[data-message-author-role="assistant"], [data-turn="assistant"], [data-testid*="assistant"]'),
          );
        };
        const hasAssistantFinishedActions = () =>
          Array.from(document.querySelectorAll('${FINISHED_ACTIONS_SELECTOR}')).some((node) =>
            isAssistantAction(node) && isAfterMinTurn(node),
          );
        let lastAssistantTurn = null;
        for (let i = turns.length - 1; i >= 0; i--) {
          if (isAssistantTurn(turns[i])) {
            lastAssistantTurn = turns[i];
            break;
          }
        }
        if (!lastAssistantTurn) {
          return hasAssistantFinishedActions();
        }
        if (!isAfterMinTurn(lastAssistantTurn)) {
          return hasAssistantFinishedActions();
        }
        // Check if the last assistant turn has finished action buttons (copy, thumbs up/down, share)
        if (
          Array.from(lastAssistantTurn.querySelectorAll('${FINISHED_ACTIONS_SELECTOR}')).some((node) =>
            isAfterMinTurn(node),
          )
        ) {
          return true;
        }
        // Also check for "Done" text in the last assistant turn's markdown
        const markdowns = lastAssistantTurn.querySelectorAll('.markdown');
        if (Array.from(markdowns).some((n) => (n.textContent || '').trim() === 'Done')) {
          return true;
        }
        return hasAssistantFinishedActions();
      })()`,
      returnByValue: true,
    });
    return Boolean(result?.value);
  } catch {
    return false;
  }
}

async function isIdleEmptyAssistantTurn(
  Runtime: ChromeClient["Runtime"],
  minTurnIndex?: number,
): Promise<boolean> {
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  try {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const MIN_TURN_INDEX = ${minTurnLiteral};
        const turns = Array.from(document.querySelectorAll('${CONVERSATION_TURN_SELECTOR}')).filter(
          (node) =>
            !(node instanceof HTMLElement && node.parentElement?.closest('${CONVERSATION_TURN_SELECTOR}')),
        );
        const hasIndexedTurns = turns.length > 0;
        const resolveTurnIndex = (node) => {
          const turn = node?.closest?.('${CONVERSATION_TURN_SELECTOR}');
          if (!turn) return null;
          const idx = turns.indexOf(turn);
          return idx >= 0 ? idx : null;
        };
        const isAfterMinTurn = (node) => {
          if (MIN_TURN_INDEX < 0 || !hasIndexedTurns) return true;
          const idx = resolveTurnIndex(node);
          return idx !== null && idx >= MIN_TURN_INDEX;
        };
        const isAssistantTurn = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
          if (turnAttr === 'assistant') return true;
          const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
          if (role === 'assistant') return true;
          const testId = (node.getAttribute('data-testid') || '').toLowerCase();
          if (testId.includes('assistant')) return true;
          return Boolean(node.querySelector('${ASSISTANT_ROLE_SELECTOR}') || node.querySelector('[data-testid*="assistant"]'));
        };
        let lastAssistantTurn = null;
        for (let i = turns.length - 1; i >= 0; i -= 1) {
          if (isAssistantTurn(turns[i])) {
            lastAssistantTurn = turns[i];
            break;
          }
        }
        if (!lastAssistantTurn || !isAfterMinTurn(lastAssistantTurn)) {
          return false;
        }
        const assistantRoot = lastAssistantTurn.querySelector('${ASSISTANT_ROLE_SELECTOR}') ?? lastAssistantTurn;
        const assistantText = String(assistantRoot?.innerText || assistantRoot?.textContent || '').trim();
        if (assistantText) {
          return false;
        }
        const assistantHtml = String(assistantRoot?.outerHTML || lastAssistantTurn.innerHTML || '')
          .toLowerCase()
          .trim();
        const htmlLooksEmpty =
          assistantHtml.includes('result-thinking') ||
          /<p\\b[^>]*>\\s*<\\/p>/.test(assistantHtml) ||
          /data-message-model-slug="gpt-5-[^"]*thinking/.test(assistantHtml);
        const turnText = String(lastAssistantTurn.innerText || lastAssistantTurn.textContent || '')
          .toLowerCase()
          .trim();
        const stripped = turnText.startsWith('chatgpt said:')
          ? turnText.slice('chatgpt said:'.length).trim()
          : turnText;
        const summaryOnly =
          stripped === 'thinking' ||
          /^thought for\\b[^\\n]*$/.test(stripped) ||
          /^thought for\\b[^\\n]*\\nthinking$/.test(stripped);
        if (!summaryOnly && !htmlLooksEmpty) {
          return false;
        }
        return true;
      })()`,
      returnByValue: true,
    });
    return Boolean(result?.value);
  } catch {
    return false;
  }
}

function normalizeAssistantSnapshot(snapshot: AssistantSnapshot | null): {
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null {
  const text = snapshot?.text
    ? normalizeAssistantTextCandidate(snapshot.text, snapshot.html ?? undefined)
    : null;
  if (!text) {
    return null;
  }
  return {
    text,
    html: snapshot?.html ?? undefined,
    meta: { turnId: snapshot?.turnId ?? undefined, messageId: snapshot?.messageId ?? undefined },
  };
}

function normalizeAssistantTextCandidate(text: string, html?: string): string | null {
  const cleaned = cleanAssistantText(text);
  if (!cleaned.trim()) {
    return null;
  }
  if (isAssistantPlaceholderCandidate({ text: cleaned, html })) {
    return null;
  }
  // Ignore user echo turns that can show up in project view fallbacks.
  if (cleaned.toLowerCase().startsWith("you said")) {
    return null;
  }
  return cleaned;
}

async function captureAssistantCompletionViaCopy(
  Runtime: ChromeClient["Runtime"],
  snapshot: AssistantSnapshot | null,
  logger: BrowserLogger,
  minTurnIndex?: number,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const markdown = await captureAssistantMarkdown(
    Runtime,
    {
      messageId: snapshot?.messageId ?? undefined,
      turnId: snapshot?.turnId ?? undefined,
    },
    logger,
    minTurnIndex,
  );
  if (!markdown) {
    return null;
  }
  const text = normalizeAssistantTextCandidate(markdown);
  if (!text) {
    return null;
  }
  return {
    text,
    html: snapshot?.html ?? undefined,
    meta: {
      turnId: snapshot?.turnId ?? undefined,
      messageId: snapshot?.messageId ?? undefined,
    },
  };
}

async function waitForCondition<T>(
  getter: () => Promise<T | null>,
  timeoutMs: number,
  pollIntervalMs = 400,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await getter();
    if (value) {
      return value;
    }
    await delay(pollIntervalMs);
  }
  return null;
}

function buildAssistantSnapshotExpression(minTurnIndex?: number): string {
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  return `(() => {
    const MIN_TURN_INDEX = ${minTurnLiteral};
    // Learned: the default turn DOM misses project view; keep a fallback extractor.
    ${buildAssistantExtractor("extractAssistantTurn")}
    const extracted = extractAssistantTurn();
    const isPlaceholder = (snapshot) => {
      const normalized = String(snapshot?.text ?? '').toLowerCase().trim();
      const html = String(snapshot?.html ?? '').toLowerCase();
      if (normalized === 'chatgpt said:' || normalized === 'chatgpt said') return true;
      if (normalized.includes('file upload request') && (normalized.includes('pro thinking') || normalized.includes('chatgpt said'))) {
        return true;
      }
      if (normalized.includes('answer now') && (normalized.includes('pro thinking') || normalized.includes('chatgpt said'))) {
        return true;
      }
      const stripped = normalized.startsWith('chatgpt said:')
        ? normalized.slice('chatgpt said:'.length).trim()
        : normalized;
      const summaryOnly =
        stripped === 'thinking' ||
        /^thought for\\b[^\\n]*$/.test(stripped) ||
        /^thought for\\b[^\\n]*\\nthinking$/.test(stripped);
      const progressOnly =
        /^(?:starting|finalizing answer)(?:\\.\\.\\.|…)?$/.test(stripped) ||
        /^(?:analyzing|researching|reasoning|planning|drafting|reading|browsing|searching(?: the web)?)(?:\\.\\.\\.|…)?$/.test(stripped);
      if (progressOnly) return true;
      if (!summaryOnly) return false;
      return (
        html.includes('result-thinking') ||
        (html.includes('data-message-model-slug="gpt-5-') && html.includes('thinking'))
      );
    };
    const extractedCandidate = extracted && extracted.text && !isPlaceholder(extracted) ? extracted : null;
    if (extractedCandidate) {
      return extractedCandidate;
    }
    // Fallback for ChatGPT project view: answers can live outside conversation turns.
    const fallback = ${buildMarkdownFallbackExtractor("MIN_TURN_INDEX")};
    return fallback() ?? null;
  })()`;
}

function buildResponseObserverExpression(timeoutMs: number, minTurnIndex?: number): string {
  const selectorsLiteral = JSON.stringify(ANSWER_SELECTORS);
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  return `(() => {
    ${buildClickDispatcher()}
    const SELECTORS = ${selectorsLiteral};
    const STOP_SELECTOR = '${STOP_BUTTON_SELECTOR}';
    const FINISHED_SELECTOR = '${FINISHED_ACTIONS_SELECTOR}';
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    // Learned: settling avoids capturing mid-stream HTML; keep short.
    const settleDelayMs = 800;
    const isAnswerNowPlaceholder = (snapshot) => {
      const normalized = String(snapshot?.text ?? '').toLowerCase().trim();
      const html = String(snapshot?.html ?? '').toLowerCase();
      if (normalized === 'chatgpt said:' || normalized === 'chatgpt said') return true;
      if (normalized.includes('file upload request') && (normalized.includes('pro thinking') || normalized.includes('chatgpt said'))) {
        return true;
      }
      if (normalized.includes('answer now') && (normalized.includes('pro thinking') || normalized.includes('chatgpt said'))) {
        return true;
      }
      const stripped = normalized.startsWith('chatgpt said:')
        ? normalized.slice('chatgpt said:'.length).trim()
        : normalized;
      const summaryOnly =
        stripped === 'thinking' ||
        /^thought for\\b[^\\n]*$/.test(stripped) ||
        /^thought for\\b[^\\n]*\\nthinking$/.test(stripped);
      const progressOnly =
        /^(?:starting|finalizing answer)(?:\\.\\.\\.|…)?$/.test(stripped) ||
        /^(?:analyzing|researching|reasoning|planning|drafting|reading|browsing|searching(?: the web)?)(?:\\.\\.\\.|…)?$/.test(stripped);
      if (progressOnly) return true;
      if (!summaryOnly) return false;
      return (
        html.includes('result-thinking') ||
        (html.includes('data-message-model-slug="gpt-5-') && html.includes('thinking'))
      );
    };

    // Helper to detect assistant turns - must match buildAssistantExtractor logic for consistency.
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') return true;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) return true;
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };

    const MIN_TURN_INDEX = ${minTurnLiteral};
    ${buildAssistantExtractor("extractFromTurns")}
    // Learned: some layouts (project view) render markdown without assistant turn wrappers.
    const extractFromMarkdownFallback = ${buildMarkdownFallbackExtractor("MIN_TURN_INDEX")};

    const acceptSnapshot = (snapshot) => {
      if (!snapshot) return null;
      const index = typeof snapshot.turnIndex === 'number' ? snapshot.turnIndex : -1;
      if (MIN_TURN_INDEX >= 0) {
        if (index < 0 || index < MIN_TURN_INDEX) {
          return null;
        }
      }
      return snapshot;
    };

    const captureViaObserver = () =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + ${timeoutMs};
        let timeoutId = null;
        let cleanedUp = false;
        let observer = null;

        // Centralized cleanup to prevent resource leaks
        const cleanup = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          if (observer) {
            try {
              observer.disconnect();
            } catch {
              // ignore disconnect errors
            }
            observer = null;
          }
        };

        const observerCallback = () => {
          if (cleanedUp) return;
          try {
            const extractedRaw = extractFromTurns();
            const extractedCandidate =
              extractedRaw && !isAnswerNowPlaceholder(extractedRaw) ? extractedRaw : null;
            let extracted = acceptSnapshot(extractedCandidate);
            if (!extracted) {
              const fallbackRaw = extractFromMarkdownFallback();
              const fallbackCandidate =
                fallbackRaw && !isAnswerNowPlaceholder(fallbackRaw) ? fallbackRaw : null;
              extracted = acceptSnapshot(fallbackCandidate);
            }
            if (extracted) {
              cleanup();
              resolve(extracted);
            } else if (Date.now() > deadline) {
              cleanup();
              reject(new Error('Response timeout'));
            }
          } catch (error) {
            cleanup();
            reject(error);
          }
        };

        observer = new MutationObserver(observerCallback);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });

        timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error('Response timeout'));
        }, ${timeoutMs});
      });

    // Check if the last assistant turn has finished (scoped to avoid detecting old turns).
    const isLastAssistantTurnFinished = () => {
      const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR)).filter(
        (node) => !(node instanceof HTMLElement && node.parentElement?.closest(CONVERSATION_SELECTOR)),
      );
      const hasIndexedTurns = turns.length > 0;
      const resolveTurnIndex = (node) => {
        if (!(node instanceof HTMLElement)) return null;
        const turn = node.matches(CONVERSATION_SELECTOR)
          ? node
          : node.closest(CONVERSATION_SELECTOR);
        if (!turn) return null;
        const idx = turns.indexOf(turn);
        return idx >= 0 ? idx : null;
      };
      const isAfterMinTurn = (node) => {
        if (MIN_TURN_INDEX < 0 || !hasIndexedTurns) return true;
        const idx = resolveTurnIndex(node);
        return idx !== null && idx >= MIN_TURN_INDEX;
      };
      let lastAssistantTurn = null;
      for (let i = turns.length - 1; i >= 0; i--) {
        if (isAssistantTurn(turns[i])) {
          lastAssistantTurn = turns[i];
          break;
        }
      }
      if (!lastAssistantTurn) return false;
      if (!isAfterMinTurn(lastAssistantTurn)) return false;
      // Check for action buttons in this specific turn
      if (
        Array.from(lastAssistantTurn.querySelectorAll(FINISHED_SELECTOR)).some((node) =>
          isAfterMinTurn(node),
        )
      ) {
        return true;
      }
      // Check for "Done" text in this turn's markdown
      const markdowns = lastAssistantTurn.querySelectorAll('.markdown');
      return Array.from(markdowns).some((n) => (n.textContent || '').trim() === 'Done');
    };

    const waitForSettle = async (snapshot) => {
      // Learned: short answers can be 1-2 tokens; enforce longer settle windows to avoid truncation.
      // Learned: long streaming responses (esp. thinking models) can pause mid-stream;
      // use progressively longer windows to avoid truncation (#71).
      const initialLength = snapshot?.text?.length ?? 0;
      const shortAnswer = initialLength > 0 && initialLength < 16;
      const mediumAnswer = initialLength >= 16 && initialLength < 40;
      const longAnswer = initialLength >= 40 && initialLength < 500;
      const settleWindowMs = shortAnswer ? 12_000 : mediumAnswer ? 8_000 : longAnswer ? 10_000 : 12_000;
      const settleIntervalMs = 400;
      const deadline = Date.now() + settleWindowMs;
      let latest = snapshot;
      let lastLength = snapshot?.text?.length ?? 0;
      let stableCycles = 0;
      const stableTarget = shortAnswer ? 12 : mediumAnswer ? 16 : longAnswer ? 20 : 24;
      let lastChangeAt = Date.now();
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, settleIntervalMs));
        const refreshedRaw = extractFromTurns();
        const refreshedCandidate =
          refreshedRaw && !isAnswerNowPlaceholder(refreshedRaw) ? refreshedRaw : null;
        let refreshed = acceptSnapshot(refreshedCandidate);
        if (!refreshed) {
          const fallbackRaw = extractFromMarkdownFallback();
          const fallbackCandidate =
            fallbackRaw && !isAnswerNowPlaceholder(fallbackRaw) ? fallbackRaw : null;
          refreshed = acceptSnapshot(fallbackCandidate);
        }
        const nextLength = refreshed?.text?.length ?? lastLength;
        if (refreshed && nextLength >= lastLength) {
          latest = refreshed;
        }
        if (nextLength > lastLength) {
          lastLength = nextLength;
          stableCycles = 0;
          lastChangeAt = Date.now();
        } else {
          stableCycles += 1;
        }
        const stopVisible = Boolean(document.querySelector(STOP_SELECTOR));
        const finishedVisible = isLastAssistantTurnFinished();
        const stableMs = Date.now() - lastChangeAt;
        const minStableMs = shortAnswer ? 8000 : mediumAnswer ? 6000 : longAnswer ? 8000 : 10000;

        if (finishedVisible || (!stopVisible && stableCycles >= stableTarget && stableMs >= minStableMs)) {
          break;
        }
      }
      return latest ?? snapshot;
    };

    const extractedRaw = extractFromTurns();
    const extractedCandidate = extractedRaw && !isAnswerNowPlaceholder(extractedRaw) ? extractedRaw : null;
    let extracted = acceptSnapshot(extractedCandidate);
    if (!extracted) {
      const fallbackRaw = extractFromMarkdownFallback();
      const fallbackCandidate = fallbackRaw && !isAnswerNowPlaceholder(fallbackRaw) ? fallbackRaw : null;
      extracted = acceptSnapshot(fallbackCandidate);
    }
    if (extracted) {
      return waitForSettle(extracted);
    }
    return captureViaObserver().then((payload) => waitForSettle(payload));
  })()`;
}

function buildAssistantExtractor(functionName: string): string {
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const finishedLiteral = JSON.stringify(FINISHED_ACTIONS_SELECTOR);
  return `const ${functionName} = () => {
    ${buildClickDispatcher()}
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    const FINISHED_SELECTOR = ${finishedLiteral};
    const CONTENT_SELECTOR =
      '.markdown,[data-message-content],[data-testid*="message"],[data-testid*="assistant"],.prose,[class*="markdown"]';
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') {
        return true;
      }
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') {
        return true;
      }
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) {
        return true;
      }
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };

    const readCandidatePayload = (node) => {
      if (!(node instanceof HTMLElement)) {
        return null;
      }
      const clone = node.cloneNode(true);
      if (!(clone instanceof HTMLElement)) {
        return null;
      }
      const discardSelector = [
        'nav',
        'aside',
        'form',
        '[aria-label="Response actions"]',
        '[role="group"][aria-label="Response actions"]',
        FINISHED_SELECTOR,
        '[data-testid*="copy-turn-action-button"]',
        '[data-testid*="good-response-turn-action-button"]',
        '[data-testid*="bad-response-turn-action-button"]',
        '[data-testid*="turn-action"]',
        '[data-testid*="message-actions"]',
      ]
        .filter(Boolean)
        .join(',');
      if (discardSelector) {
        for (const child of clone.querySelectorAll(discardSelector)) {
          child.remove();
        }
      }
      const innerText = clone.innerText ?? '';
      const textContent = clone.textContent ?? '';
      const text = innerText.trim().length > 0 ? innerText : textContent;
      if (!text.trim()) {
        return null;
      }
      return { text: text.trim(), html: clone.innerHTML ?? '' };
    };

    const chooseBetterPayload = (current, candidate) => {
      if (!candidate) {
        return current;
      }
      if (!current) {
        return candidate;
      }
      const currentScore = current.rank * 10000 + current.text.length;
      const candidateScore = candidate.rank * 10000 + candidate.text.length;
      if (candidateScore > currentScore) {
        return candidate;
      }
      return current;
    };

    const expandCollapsibles = (root) => {
      const buttons = Array.from(root.querySelectorAll('button'));
      for (const button of buttons) {
        const label = (button.textContent || '').toLowerCase();
        const testid = (button.getAttribute('data-testid') || '').toLowerCase();
        if (
          label.includes('more') ||
          label.includes('expand') ||
          label.includes('show') ||
          testid.includes('markdown') ||
          testid.includes('toggle')
        ) {
          dispatchClickSequence(button);
        }
      }
    };

    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR)).filter(
      (node) => !(node instanceof HTMLElement && node.parentElement?.closest(CONVERSATION_SELECTOR)),
    );
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!isAssistantTurn(turn)) {
        continue;
      }
      const assistantMessages = Array.from(turn.querySelectorAll(ASSISTANT_SELECTOR)).filter(
        (node) => node instanceof HTMLElement,
      );
      const messageRoot =
        assistantMessages[assistantMessages.length - 1] ?? turn;
      expandCollapsibles(messageRoot);
      const candidateRoots = [];
      if (messageRoot.matches?.(CONTENT_SELECTOR)) {
        candidateRoots.push(messageRoot);
      }
      candidateRoots.push(...Array.from(messageRoot.querySelectorAll(CONTENT_SELECTOR)));
      const uniqueRoots = Array.from(new Set(candidateRoots));
      const topLevelRoots = uniqueRoots.filter(
        (node) => !uniqueRoots.some((other) => other !== node && other.contains(node)),
      );
      let bestPayload = null;
      const aggregatedRoots = topLevelRoots
        .map((node) => readCandidatePayload(node))
        .filter(Boolean);
      if (aggregatedRoots.length > 1) {
        bestPayload = chooseBetterPayload(bestPayload, {
          text: aggregatedRoots.map((payload) => payload.text).join('\\n\\n'),
          html: aggregatedRoots.map((payload) => payload.html).filter(Boolean).join('\\n'),
          rank: 4,
        });
      }
      for (const node of topLevelRoots) {
        const payload = readCandidatePayload(node);
        if (!payload) {
          continue;
        }
        bestPayload = chooseBetterPayload(bestPayload, { ...payload, rank: 3 });
      }
      const messagePayload = readCandidatePayload(messageRoot);
      if (messagePayload) {
        bestPayload = chooseBetterPayload(bestPayload, { ...messagePayload, rank: 2 });
      }
      const turnPayload = readCandidatePayload(turn);
      if (turnPayload) {
        bestPayload = chooseBetterPayload(bestPayload, { ...turnPayload, rank: 1 });
      }
      const messageId = messageRoot.getAttribute('data-message-id');
      const turnId = messageRoot.getAttribute('data-testid');
      if (bestPayload?.text?.trim()) {
        return {
          text: bestPayload.text,
          html: bestPayload.html,
          messageId,
          turnId,
          turnIndex: index,
        };
      }
    }
    return null;
  };`;
}

function buildMarkdownFallbackExtractor(minTurnLiteral?: string): string {
  const turnIndexValue = minTurnLiteral
    ? `(${minTurnLiteral} >= 0 ? ${minTurnLiteral} : null)`
    : "null";
  return `(() => {
    const __minTurn = ${turnIndexValue};
    const roots = [
      document.querySelector('section[data-testid="screen-threadFlyOut"]'),
      document.querySelector('[data-testid="chat-thread"]'),
      document.querySelector('main'),
      document.querySelector('[role="main"]'),
    ].filter(Boolean);
    if (roots.length === 0) return null;
    const markdownSelector = '.markdown,[data-message-content],[data-testid*="message"],.prose,[class*="markdown"]';
    const isExcluded = (node) =>
      Boolean(
        node?.closest?.(
          'nav, aside, [data-testid*="sidebar"], [data-testid*="chat-history"], [data-testid*="composer"], form',
        ),
      );
    const scoreRoot = (node) => {
      const actions = node.querySelectorAll('${FINISHED_ACTIONS_SELECTOR}').length;
      const assistants = node.querySelectorAll('[data-message-author-role="assistant"], [data-turn="assistant"]').length;
      const markdowns = node.querySelectorAll(markdownSelector).length;
      return actions * 10 + assistants * 5 + markdowns;
    };
    let root = roots[0];
    let bestScore = scoreRoot(root);
    for (let i = 1; i < roots.length; i += 1) {
      const candidate = roots[i];
      const score = scoreRoot(candidate);
      if (score > bestScore) {
        bestScore = score;
        root = candidate;
      }
    }
    if (!root) return null;
    const CONVERSATION_SELECTOR = '${CONVERSATION_TURN_SELECTOR}';
    const turnNodes = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR)).filter(
      (node) => !(node instanceof HTMLElement && node.parentElement?.closest(CONVERSATION_SELECTOR)),
    );
    const hasTurns = turnNodes.length > 0;
    const resolveTurnIndex = (node) => {
      const turn = node?.closest?.(CONVERSATION_SELECTOR);
      if (!turn) return null;
      const idx = turnNodes.indexOf(turn);
      return idx >= 0 ? idx : null;
    };
    const isAfterMinTurn = (node) => {
      if (__minTurn === null) return true;
      if (!hasTurns) return true;
      const idx = resolveTurnIndex(node);
      return idx !== null && idx >= __minTurn;
    };
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const collectUserText = (scope) => {
      if (!scope?.querySelectorAll) return '';
      const userTurns = Array.from(scope.querySelectorAll('[data-message-author-role="user"], [data-turn="user"]'));
      const lastUser = userTurns[userTurns.length - 1];
      return lastUser ? normalize(lastUser.innerText || lastUser.textContent || '') : '';
    };
    const userText = collectUserText(root) || collectUserText(document);
    const isUserEcho = (text) => {
      if (!userText) return false;
      const normalized = normalize(text);
      if (!normalized) return false;
      return normalized === userText || normalized.startsWith(userText);
    };
    const markdowns = Array.from(root.querySelectorAll(markdownSelector))
      .filter((node) => !isExcluded(node))
      .filter((node) => {
        const container = node.closest('[data-message-author-role], [data-turn]');
        if (!container) return true;
        const role =
          (container.getAttribute('data-message-author-role') || container.getAttribute('data-turn') || '').toLowerCase();
        return role !== 'user';
      });
    if (markdowns.length === 0) return null;
    const actionButtons = Array.from(root.querySelectorAll('${FINISHED_ACTIONS_SELECTOR}'));
    const actionMarkdowns = [];
    for (const button of actionButtons) {
      const container =
        button.closest('${CONVERSATION_TURN_SELECTOR}') ||
        button.closest('[data-message-author-role="assistant"], [data-turn="assistant"]') ||
        button.closest('[data-message-author-role], [data-turn]') ||
        button.closest('[data-testid*="assistant"]');
      if (!container || container === root || container === document.body) continue;
      const scoped = Array.from(container.querySelectorAll(markdownSelector))
        .filter((node) => !isExcluded(node))
        .filter((node) => {
          const roleNode = node.closest('[data-message-author-role], [data-turn]');
          if (!roleNode) return true;
          const role =
            (roleNode.getAttribute('data-message-author-role') || roleNode.getAttribute('data-turn') || '').toLowerCase();
          return role !== 'user';
        });
      if (scoped.length === 0) continue;
      for (const node of scoped) {
        actionMarkdowns.push(node);
      }
    }
    const assistantMarkdowns = markdowns.filter((node) => {
      const container = node.closest('[data-message-author-role], [data-turn], [data-testid*="assistant"]');
      if (!container) return false;
      const role =
        (container.getAttribute('data-message-author-role') || container.getAttribute('data-turn') || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (container.getAttribute('data-testid') || '').toLowerCase();
      return testId.includes('assistant');
    });
    const hasAssistantIndicators = Boolean(
      root.querySelector('${FINISHED_ACTIONS_SELECTOR}') ||
        root.querySelector('[data-message-author-role="assistant"], [data-turn="assistant"], [data-testid*="assistant"]'),
    );
    const allowMarkdownFallback = hasAssistantIndicators || hasTurns || Boolean(userText);
    const candidates =
      actionMarkdowns.length > 0
        ? actionMarkdowns
        : assistantMarkdowns.length > 0
          ? assistantMarkdowns
          : allowMarkdownFallback
            ? markdowns
            : [];
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const node = candidates[i];
      if (!node) continue;
      if (!isAfterMinTurn(node)) continue;
      const text = (node.innerText || node.textContent || '').trim();
      if (!text) continue;
      if (isUserEcho(text)) continue;
      const html = node.innerHTML ?? '';
      const turnIndex = resolveTurnIndex(node);
      return { text, html, messageId: null, turnId: null, turnIndex };
    }
    return null;
  })`;
}

function buildCopyExpression(
  meta: { messageId?: string | null; turnId?: string | null },
  minTurnIndex?: number,
): string {
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  return `(() => {
    ${buildClickDispatcher()}
    const BUTTON_SELECTOR = '${COPY_BUTTON_SELECTOR}';
    const TIMEOUT_MS = 10000;
    const MIN_TURN_INDEX = ${minTurnLiteral};

    const locateButton = () => {
      const hint = ${JSON.stringify(meta ?? {})};
      const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
      const ASSISTANT_SELECTOR = '${ASSISTANT_ROLE_SELECTOR}';
      const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR)).filter(
        (node) => !(node instanceof HTMLElement && node.parentElement?.closest(CONVERSATION_SELECTOR)),
      );
      const hasIndexedTurns = turns.length > 0;
      const resolveTurnIndex = (node) => {
        const turn = node?.closest?.(CONVERSATION_SELECTOR);
        if (!turn) return null;
        const idx = turns.indexOf(turn);
        return idx >= 0 ? idx : null;
      };
      const isAfterMinTurn = (node) => {
        if (MIN_TURN_INDEX < 0 || !hasIndexedTurns) return true;
        const idx = resolveTurnIndex(node);
        return idx !== null && idx >= MIN_TURN_INDEX;
      };
      const isAssistantTurn = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
        if (turnAttr === 'assistant') return true;
        const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
        if (role === 'assistant') return true;
        const testId = (node.getAttribute('data-testid') || '').toLowerCase();
        if (testId.includes('assistant')) return true;
        return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
      };
      const isAssistantButton = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const turn = node.closest(CONVERSATION_SELECTOR);
        if (turn) {
          return isAssistantTurn(turn);
        }
        return Boolean(
          node.closest('[data-message-author-role="assistant"], [data-turn="assistant"], [data-testid*="assistant"]'),
        );
      };
      if (hint?.messageId) {
        const node = document.querySelector('[data-message-id="' + hint.messageId + '"]');
        const buttons = node ? Array.from(node.querySelectorAll('${COPY_BUTTON_SELECTOR}')) : [];
        const button =
          buttons
            .filter((candidate) => isAssistantButton(candidate) && isAfterMinTurn(candidate))
            .at(-1) ?? null;
        if (button) {
          return button;
        }
      }
      if (hint?.turnId) {
        const node = document.querySelector('[data-testid="' + hint.turnId + '"]');
        const buttons = node ? Array.from(node.querySelectorAll('${COPY_BUTTON_SELECTOR}')) : [];
        const button =
          buttons
            .filter((candidate) => isAssistantButton(candidate) && isAfterMinTurn(candidate))
            .at(-1) ?? null;
        if (button) {
          return button;
        }
      }
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        const turn = turns[i];
        if (!isAssistantTurn(turn)) continue;
        if (!isAfterMinTurn(turn)) continue;
        const button = turn.querySelector(BUTTON_SELECTOR);
        if (button) {
          return button;
        }
      }
      const all = Array.from(document.querySelectorAll(BUTTON_SELECTOR));
      for (let i = all.length - 1; i >= 0; i -= 1) {
        const button = all[i];
        if (isAssistantButton(button) && isAfterMinTurn(button)) {
          return button;
        }
      }
      return null;
    };

    const interceptClipboard = () => {
      const clipboard = navigator.clipboard;
      const state = { text: '', updatedAt: 0 };
      if (!clipboard) {
        return { state, restore: () => {} };
      }
      const originalWriteText = clipboard.writeText;
      const originalWrite = clipboard.write;
      clipboard.writeText = (value) => {
        state.text = typeof value === 'string' ? value : '';
        state.updatedAt = Date.now();
        return Promise.resolve();
      };
      clipboard.write = async (items) => {
        try {
          const list = Array.isArray(items) ? items : items ? [items] : [];
          for (const item of list) {
            if (!item) continue;
            const types = Array.isArray(item.types) ? item.types : [];
            if (types.includes('text/plain') && typeof item.getType === 'function') {
              const blob = await item.getType('text/plain');
              const text = await blob.text();
              state.text = text ?? '';
              state.updatedAt = Date.now();
              break;
            }
          }
        } catch {
          state.text = '';
          state.updatedAt = Date.now();
        }
        return Promise.resolve();
      };
      return {
        state,
        restore: () => {
          clipboard.writeText = originalWriteText;
          clipboard.write = originalWrite;
        },
      };
    };

    return new Promise((resolve) => {
      const deadline = Date.now() + TIMEOUT_MS;
      const waitForButton = () => {
        const button = locateButton();
        if (button) {
          const interception = interceptClipboard();
          let settled = false;
          let pollId = null;
          let timeoutId = null;
          const finish = (payload) => {
            if (settled) {
              return;
            }
            settled = true;
            if (pollId) {
              clearInterval(pollId);
            }
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            button.removeEventListener('copy', handleCopy, true);
            interception.restore?.();
            resolve(payload);
          };

          const readIntercepted = () => {
            const markdown = interception.state.text ?? '';
            const updatedAt = interception.state.updatedAt ?? 0;
            return { success: Boolean(markdown.trim()), markdown, updatedAt };
          };

          let lastText = '';
          let stableTicks = 0;
          const requiredStableTicks = 3;
          const requiredStableMs = 250;
          const maybeFinish = () => {
            const payload = readIntercepted();
            if (!payload.success) return;
            if (payload.markdown !== lastText) {
              lastText = payload.markdown;
              stableTicks = 0;
              return;
            }
            stableTicks += 1;
            const ageMs = Date.now() - (payload.updatedAt || 0);
            if (stableTicks >= requiredStableTicks && ageMs >= requiredStableMs) {
              finish(payload);
            }
          };

          const handleCopy = () => {
            maybeFinish();
          };

          button.addEventListener('copy', handleCopy, true);
          button.scrollIntoView({ block: 'center', behavior: 'instant' });
          dispatchClickSequence(button);
          pollId = setInterval(maybeFinish, 120);
          timeoutId = setTimeout(() => {
            button.removeEventListener('copy', handleCopy, true);
            finish({ success: false, status: 'timeout' });
          }, TIMEOUT_MS);
          return;
        }
        if (Date.now() > deadline) {
          resolve({ success: false, status: 'missing-button' });
          return;
        }
        setTimeout(waitForButton, 120);
      };

      waitForButton();
    });
  })()`;
}

interface AssistantSnapshot {
  text?: string;
  html?: string;
  messageId?: string | null;
  turnId?: string | null;
  turnIndex?: number | null;
}

const LANGUAGE_TAGS = new Set(
  [
    "copy code",
    "markdown",
    "bash",
    "sh",
    "shell",
    "javascript",
    "typescript",
    "ts",
    "js",
    "yaml",
    "json",
    "python",
    "py",
    "go",
    "java",
    "c",
    "c++",
    "cpp",
    "c#",
    "php",
    "ruby",
    "rust",
    "swift",
    "kotlin",
    "html",
    "css",
    "sql",
    "text",
  ].map((token) => token.toLowerCase()),
);

function cleanAssistantText(text: string): string {
  const normalized = text.replace(/\u00a0/g, " ");
  const lines = normalized.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const trimmed = line.trim().toLowerCase();
    if (LANGUAGE_TAGS.has(trimmed)) return false;
    return true;
  });
  return filtered
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
