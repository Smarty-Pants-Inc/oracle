import { BrowserAutomationError } from "../oracle/errors.js";
import { INPUT_SELECTORS } from "./constants.js";
import { buildConversationTurnCountExpression } from "./conversationTurns.js";
import {
  readAssistantSnapshot,
  waitForAssistantResponse,
  waitForResumedConversationHydration,
} from "./pageActions.js";
import { isStableConversationUrl as isConversationUrl } from "./conversationUrl.js";
import type { CommittedPromptEpochLocator } from "./reattachability.js";
import { delay } from "./utils.js";
import type { BrowserLogger, ChromeClient } from "./types.js";
import {
  assertCommittedPromptEpochCurrent,
  readConversationUrl,
} from "./archiveSettlementCoordinator.js";
// Browser assistant response capture and transcript shaping.
export type AssistantAnswer = {
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
};

export async function waitForAssistantOrGeneratedImageResponse(params: {
  Runtime: ChromeClient["Runtime"];
  waitForText: () => Promise<AssistantAnswer>;
  timeoutMs: number;
  minTurnIndex?: number;
  expectedConversationId?: string;
  expectedPromptTurn?: CommittedPromptEpochLocator;
  imageOutputRequested: boolean;
  logger: BrowserLogger;
}): Promise<AssistantAnswer> {
  if (!params.imageOutputRequested) {
    return params.waitForText();
  }

  params.logger("[browser] Waiting for ChatGPT generated image response.");
  const response = await pollGeneratedImageOrTextAssistantResponse(
    params.Runtime,
    params.timeoutMs,
    params.minTurnIndex,
    params.expectedConversationId,
    params.expectedPromptTurn,
  );
  if (response) {
    if (response.html?.includes("/backend-api/estuary/content?id=file_")) {
      params.logger("[browser] Captured generated image response before text appeared.");
    }
    return response;
  }

  throw new Error("assistant response timeout while waiting for generated image or text");
}

export async function attemptAssistantRecheckOrRethrow(
  operation: () => Promise<AssistantAnswer | null>,
): Promise<AssistantAnswer | null> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BrowserAutomationError) {
      throw error;
    }
    return null;
  }
}

async function pollGeneratedImageOrTextAssistantResponse(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  minTurnIndex?: number,
  expectedConversationId?: string,
  expectedPromptTurn?: CommittedPromptEpochLocator,
): Promise<AssistantAnswer | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let snapshot = await readAssistantSnapshot(
      Runtime,
      minTurnIndex,
      expectedConversationId,
      expectedPromptTurn,
    ).catch(() => null);
    if (
      !snapshot &&
      !expectedPromptTurn &&
      typeof minTurnIndex === "number" &&
      Number.isFinite(minTurnIndex)
    ) {
      const relaxedSnapshot = await readAssistantSnapshot(
        Runtime,
        undefined,
        expectedConversationId,
      ).catch(() => null);
      const relaxedHtml = typeof relaxedSnapshot?.html === "string" ? relaxedSnapshot.html : "";
      if (relaxedHtml.includes("/backend-api/estuary/content?id=file_")) {
        snapshot = relaxedSnapshot;
      }
    }
    const candidateHtml = typeof snapshot?.html === "string" ? snapshot.html : "";
    const candidateHasGeneratedImage = candidateHtml.includes(
      "/backend-api/estuary/content?id=file_",
    );
    if (candidateHasGeneratedImage && expectedPromptTurn) {
      const revalidated = await assertCommittedPromptEpochCurrent(Runtime, expectedPromptTurn);
      const sameMessage = !snapshot?.messageId || revalidated.messageId === snapshot.messageId;
      const sameTurn = !snapshot?.turnId || revalidated.turnId === snapshot.turnId;
      const revalidatedHtml = typeof revalidated.html === "string" ? revalidated.html : "";
      if (
        !sameMessage ||
        !sameTurn ||
        !revalidatedHtml.includes("/backend-api/estuary/content?id=file_")
      ) {
        await delay(750);
        continue;
      }
      snapshot = revalidated;
    }
    const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
    const html = typeof snapshot?.html === "string" ? snapshot.html : "";
    const hasGeneratedImage = html.includes("/backend-api/estuary/content?id=file_");
    if (text && (hasGeneratedImage || !isImageOnlyUiChromeText(text))) {
      return {
        text,
        html,
        meta: {
          turnId: snapshot?.turnId ?? undefined,
          messageId: snapshot?.messageId ?? undefined,
        },
      };
    }
    await delay(750);
  }
  return null;
}

export function isImageOnlyUiChromeText(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  return (
    normalized.length === 0 ||
    normalized === "edit" ||
    normalized === "stopped thinking" ||
    normalized === "stopped thinking edit" ||
    /^(?:reasoning\s+|pro thinking\s+)?thought for \d+(?:\.\d+)?\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\s+edit$/.test(
      normalized,
    )
  );
}

export interface BrowserConversationTurn {
  label: string;
  prompt?: string;
  answerText: string;
  answerMarkdown: string;
}

export function normalizeBrowserFollowUpPrompts(values: string[] | undefined): string[] {
  return (values ?? []).map((entry) => entry.trim()).filter(Boolean);
}

export function formatBrowserTurnTranscript(turns: BrowserConversationTurn[]): {
  answerText: string;
  answerMarkdown: string;
} {
  if (turns.length <= 1) {
    const turn = turns[0];
    return {
      answerText: turn?.answerText ?? "",
      answerMarkdown: turn?.answerMarkdown ?? turn?.answerText ?? "",
    };
  }

  const answerMarkdown = turns
    .map((turn, index) => {
      const label = turn.label.trim() || `Turn ${index + 1}`;
      const prompt = turn.prompt?.trim();
      const promptBlock = prompt ? `\n\n### Prompt\n\n${prompt}` : "";
      const answer = (turn.answerMarkdown || turn.answerText).trim() || "_No text captured._";
      return `## ${label}${promptBlock}\n\n### Answer\n\n${answer}`;
    })
    .join("\n\n")
    .trim();

  return {
    answerText: answerMarkdown,
    answerMarkdown,
  };
}
// Long-response recovery helpers.
export async function maybeRecoverLongAssistantResponse({
  runtime,
  answerText,
  answerMarkdown,
  logger,
  allowMarkdownUpdate,
  expectedPromptTurn,
}: {
  runtime: ChromeClient["Runtime"];
  answerText: string;
  answerMarkdown: string;
  logger: BrowserLogger;
  allowMarkdownUpdate: boolean;
  expectedPromptTurn: CommittedPromptEpochLocator;
}): Promise<{ answerText: string; answerMarkdown: string }> {
  // Learned: long streaming responses can still be rendering after initial capture.
  // Add a brief delay and re-poll to catch any additional content (#71).
  const capturedLength = answerText.trim().length;
  if (capturedLength <= 500) {
    return { answerText, answerMarkdown };
  }

  await delay(1500);
  let bestLength = capturedLength;
  let bestText = answerText;
  for (let i = 0; i < 5; i++) {
    const laterSnapshot = await readAssistantSnapshot(
      runtime,
      expectedPromptTurn.verifiedUserTurnIndex + 1,
      expectedPromptTurn.conversationId,
      expectedPromptTurn,
    ).catch(() => null);
    const laterText = typeof laterSnapshot?.text === "string" ? laterSnapshot.text.trim() : "";
    if (laterText.length > bestLength) {
      bestLength = laterText.length;
      bestText = laterText;
      await delay(800); // More content appeared, keep waiting
    } else {
      break; // Stable, stop polling
    }
  }
  if (bestLength > capturedLength) {
    logger(`Recovered ${bestLength - capturedLength} additional chars via delayed re-read`);
    return {
      answerText: bestText,
      answerMarkdown: allowMarkdownUpdate ? bestText : answerMarkdown,
    };
  }
  return { answerText, answerMarkdown };
}
// WebSocket, session, and turn validation helpers.
export function isWebSocketClosureError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("websocket connection closed") ||
    message.includes("websocket is closed") ||
    message.includes("websocket error") ||
    message.includes("inspected target navigated or closed") ||
    message.includes("target closed")
  );
}

export async function waitForAssistantResponseWithReload(
  Runtime: ChromeClient["Runtime"],
  Page: ChromeClient["Page"],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
  expectedConversationId?: string,
  expectedPromptTurn?: CommittedPromptEpochLocator,
) {
  try {
    return await waitForAssistantResponse(
      Runtime,
      timeoutMs,
      logger,
      minTurnIndex,
      expectedConversationId,
      expectedPromptTurn,
    );
  } catch (error) {
    if (!shouldReloadAfterAssistantError(error)) {
      throw error;
    }
    const conversationUrl = await readConversationUrl(Runtime);
    if (!conversationUrl || !isConversationUrl(conversationUrl)) {
      throw error;
    }
    logger("Assistant response stalled; reloading conversation and retrying once");
    await Page.navigate({ url: conversationUrl });
    await waitForResumedConversationHydration(Runtime, timeoutMs, logger, {
      requirePriorTurns: true,
      requirePromptReady: false,
      expectedConversationUrl: conversationUrl,
    });
    return await waitForAssistantResponse(
      Runtime,
      timeoutMs,
      logger,
      minTurnIndex,
      expectedConversationId,
      expectedPromptTurn,
    );
  }
}

function shouldReloadAfterAssistantError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("assistant-response") ||
    message.includes("watchdog") ||
    message.includes("timeout") ||
    message.includes("capture assistant response")
  );
}

export function isAssistantResponseTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (!message) return false;
  return (
    message === "response timeout" ||
    message.includes("assistant-response") ||
    message.includes("assistant response") ||
    message.includes("watchdog") ||
    message.includes("capture assistant response")
  );
}

interface SessionValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates that the ChatGPT session is still active by checking for login CTAs
 * and textarea availability. Sessions can expire during long delays (e.g., recheck).
 *
 * @param Runtime - Chrome Runtime client
 * @param logger - Browser logger for diagnostics
 * @returns SessionValidationResult indicating if session is valid and reason if not
 */
export async function validateChatGPTSession(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<SessionValidationResult> {
  try {
    const outcome = await Runtime.evaluate({
      expression: buildSessionValidationExpression(),
      awaitPromise: true,
      returnByValue: true,
    });

    const result = outcome.result?.value as
      | {
          valid: boolean;
          hasLoginCta: boolean;
          hasTextarea: boolean;
          onAuthPage: boolean;
          pageUrl: string | null;
        }
      | undefined;

    if (!result) {
      return { valid: false, reason: "Failed to evaluate session state" };
    }

    if (result.onAuthPage) {
      return { valid: false, reason: "Redirected to auth page" };
    }

    if (result.hasLoginCta) {
      return { valid: false, reason: "Login button detected on page" };
    }

    if (!result.hasTextarea) {
      return { valid: false, reason: "Prompt textarea not available" };
    }

    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Session validation error: ${message}`);
    return { valid: false, reason: `Validation error: ${message}` };
  }
}

function buildSessionValidationExpression(): string {
  const selectorLiteral = JSON.stringify(INPUT_SELECTORS);
  return `(async () => {
    const pageUrl = typeof location === 'object' && location?.href ? location.href : null;
    const onAuthPage =
      typeof location === 'object' &&
      typeof location.pathname === 'string' &&
      /^\\/(auth|login|signin)/i.test(location.pathname);

    // Check for login CTAs (similar to ensureLoggedIn logic)
    const hasLoginCta = (() => {
      const candidates = Array.from(
        document.querySelectorAll(
          [
            'a[href*="/auth/login"]',
            'a[href*="/auth/signin"]',
            'button[type="submit"]',
            'button[data-testid*="login"]',
            'button[data-testid*="log-in"]',
            'button[data-testid*="sign-in"]',
            'button[data-testid*="signin"]',
            'button',
            'a',
          ].join(','),
        ),
      );
      const textMatches = (text) => {
        if (!text) return false;
        const normalized = text.toLowerCase().trim();
        return ['log in', 'login', 'sign in', 'signin', 'continue with'].some((needle) =>
          normalized.startsWith(needle),
        );
      };
      for (const node of candidates) {
        if (!(node instanceof HTMLElement)) continue;
        const label =
          node.textContent?.trim() ||
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          '';
        if (textMatches(label)) {
          return true;
        }
      }
      return false;
    })();

    // Check for textarea availability
    const hasTextarea = (() => {
      const selectors = ${selectorLiteral};
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node) {
          return true;
        }
      }
      return false;
    })();

    return {
      valid: !onAuthPage && !hasLoginCta && hasTextarea,
      hasLoginCta,
      hasTextarea,
      onAuthPage,
      pageUrl,
    };
  })()`;
}

export async function readConversationTurnCount(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
): Promise<number | null> {
  const expression = buildConversationTurnCountExpression();
  const attempts = 4;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { result } = await Runtime.evaluate({
        expression,
        returnByValue: true,
      });
      const value = result?.value;
      const raw =
        typeof value === "number"
          ? value
          : typeof value === "string" && value.trim().length > 0
            ? Number(value)
            : Number.NaN;
      if (!Number.isFinite(raw)) {
        throw new Error("Turn count not numeric");
      }
      return Math.max(0, Math.floor(raw));
    } catch (error) {
      if (attempt < attempts - 1) {
        await delay(150);
        continue;
      }
      if (logger?.verbose) {
        logger(
          `Failed to read conversation turn count: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    }
  }
  return null;
}
