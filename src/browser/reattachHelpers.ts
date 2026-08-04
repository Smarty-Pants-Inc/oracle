import type { BrowserLogger, ChromeClient } from "./types.js";
import { buildConversationTurnCountExpression } from "./conversationTurns.js";
import { extractStableConversationIdFromUrl } from "./conversationUrl.js";
import { delay } from "./utils.js";
import { readAssistantSnapshot } from "./pageActions.js";
import { normalizePromptForIdentity } from "./actions/promptComposer.js";
import type { CommittedPromptEpochLocator } from "./reattachability.js";

export type TargetInfoLite = {
  id?: string;
  targetId?: string;
  type?: string;
  url?: string;
  [key: string]: unknown;
};

export type AssistantPayload = {
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
};

type PromptEchoMatcher = { isEcho: (text: string) => boolean };

export function pickTarget(
  targets: TargetInfoLite[],
  runtime: { chromeTargetId?: string; tabUrl?: string; conversationId?: string },
  explicitTabRef?: string,
): TargetInfoLite | undefined {
  if (!Array.isArray(targets) || targets.length === 0) return undefined;
  const conversationId =
    runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? "");
  if (!conversationId) return undefined;
  if (runtime.tabUrl && extractConversationIdFromUrl(runtime.tabUrl) !== conversationId) {
    return undefined;
  }
  const conversationTargets = targets.filter(
    (target) => extractConversationIdFromUrl(target.url ?? "") === conversationId,
  );
  if (explicitTabRef) {
    const byExplicitId = conversationTargets.find(
      (target) => (target.targetId ?? target.id) === explicitTabRef,
    );
    if (byExplicitId) return byExplicitId;
    const explicitConversationId = extractConversationIdFromUrl(explicitTabRef);
    if (
      (explicitTabRef === conversationId || explicitConversationId === conversationId) &&
      conversationTargets.length === 1
    ) {
      return conversationTargets[0];
    }
    return undefined;
  }
  if (!runtime.chromeTargetId) return undefined;
  return conversationTargets.find(
    (target) => (target.targetId ?? target.id) === runtime.chromeTargetId,
  );
}

export function extractConversationIdFromUrl(url: string): string | undefined {
  return extractStableConversationIdFromUrl(url);
}

export function buildConversationUrl(
  runtime: { tabUrl?: string; conversationId?: string },
  baseUrl: string,
): string | null {
  if (runtime.tabUrl) {
    if (extractConversationIdFromUrl(runtime.tabUrl)) {
      return runtime.tabUrl;
    }
    return null;
  }
  const conversationId = runtime.conversationId;
  if (!conversationId) {
    return null;
  }
  try {
    const base = new URL(baseUrl);
    const pathRoot = base.pathname.replace(/\/$/, "");
    const prefix = pathRoot === "/" ? "" : pathRoot;
    return `${base.origin}${prefix}/c/${conversationId}`;
  } catch {
    return null;
  }
}

export async function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

export async function openConversationFromSidebar(
  Runtime: ChromeClient["Runtime"],
  options: { conversationId: string; preferProjects?: boolean },
  attempt = 0,
): Promise<boolean> {
  if (!options.conversationId.trim()) return false;
  const response = await Runtime.evaluate({
    expression: `(() => {
      const conversationId = ${JSON.stringify(options.conversationId)};
      const preferProjects = ${JSON.stringify(Boolean(options.preferProjects))};
      const attemptIndex = ${Math.max(0, attempt)};
      const nav = document.querySelector('nav') || document.querySelector('aside') || document.body;
      if (preferProjects) {
        const projectLink = Array.from(nav.querySelectorAll('a,button'))
          .find((el) => (el.textContent || '').trim().toLowerCase() === 'projects');
        if (projectLink) projectLink.click();
      }
      const allElements = Array.from(
        document.querySelectorAll(
          'a,button,[role="link"],[role="button"],[data-href],[data-url],[data-conversation-id],[data-testid*="conversation"],[data-testid*="history"]',
        ),
      );
      const getHref = (el) =>
        el.getAttribute('href') ||
        el.getAttribute('data-href') ||
        el.getAttribute('data-url') ||
        el.dataset?.href ||
        el.dataset?.url ||
        '';
      const conversationIdFromHref = (href) => {
        if (!href) return '';
        try {
          const match = new URL(href, location.origin).pathname.match(/\\/c\\/([^/]+)(?:\\/|$)/);
          return match ? decodeURIComponent(match[1]) : '';
        } catch {
          return '';
        }
      };
      const candidates = allElements.map((el) => {
        const clickable = el.closest('a,button,[role="link"],[role="button"]') || el;
        const href = getHref(clickable) || getHref(el);
        return {
          clickable,
          href,
          conversationId:
            clickable.getAttribute('data-conversation-id') ||
            el.getAttribute('data-conversation-id') ||
            clickable.dataset?.conversationId ||
            el.dataset?.conversationId ||
            conversationIdFromHref(href),
          inNav: Boolean(clickable.closest('nav,aside')),
        };
      });
      const visible = (item) => {
        const rect = item.clickable.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const matching = candidates.filter((item) => item.conversationId === conversationId);
      const visibleMatching = matching.filter(visible);
      const pool = visibleMatching.length > 0 ? visibleMatching : matching;
      const target = pool[Math.min(attemptIndex, Math.max(0, pool.length - 1))] || null;
      if (!target) return { ok: false, count: candidates.length };
      target.clickable.scrollIntoView({ block: 'center' });
      target.clickable.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
      );
      if (target.href && conversationIdFromHref(target.href) === conversationId) {
        const targetUrl = new URL(target.href, location.origin).toString();
        if (targetUrl !== location.href) location.href = targetUrl;
      }
      return { ok: true, href: target.href || '', count: candidates.length };
    })()`,
    returnByValue: true,
  });
  return Boolean(response.result?.value?.ok);
}

export async function openConversationFromSidebarWithRetry(
  Runtime: ChromeClient["Runtime"],
  options: { conversationId: string; preferProjects?: boolean },
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    if (await openConversationFromSidebar(Runtime, options, attempt)) return true;
    attempt += 1;
    await delay(attempt < 5 ? 250 : 500);
  }
  return false;
}

export async function waitForLocationChange(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  let lastHref = "";
  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({ expression: "location.href", returnByValue: true });
    const href = typeof result?.value === "string" ? result.value : "";
    if (lastHref && href !== lastHref) {
      return;
    }
    lastHref = href;
    await delay(200);
  }
}

export async function readConversationTurnIndex(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
): Promise<number | null> {
  try {
    const { result } = await Runtime.evaluate({
      expression: buildConversationTurnCountExpression(),
      returnByValue: true,
    });
    const raw = typeof result?.value === "number" ? result.value : Number(result?.value);
    if (!Number.isFinite(raw)) {
      throw new Error("Turn count not numeric");
    }
    return Math.max(0, Math.floor(raw) - 1);
  } catch (error) {
    if (logger?.verbose) {
      logger(
        `Failed to read conversation turn index: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }
}

export function buildPromptEchoMatcher(prompt?: string | null): PromptEchoMatcher | null {
  const normalizedPrompt = normalizePromptForIdentity(prompt ?? "");
  if (!normalizedPrompt) return null;
  return {
    isEcho: (text: string) => normalizePromptForIdentity(text) === normalizedPrompt,
  };
}

export async function recoverPromptEcho(
  Runtime: ChromeClient["Runtime"],
  answer: AssistantPayload,
  matcher: PromptEchoMatcher | null,
  logger: BrowserLogger,
  minTurnIndex: number | null,
  timeoutMs: number,
  expectedConversationId?: string,
  expectedPromptTurn?: CommittedPromptEpochLocator,
): Promise<AssistantPayload> {
  if (!matcher || !matcher.isEcho(answer.text)) {
    return answer;
  }
  logger("Detected prompt echo while reattaching; waiting for assistant response...");
  const deadline = Date.now() + Math.min(timeoutMs, 15_000);
  let bestText: string | null = null;
  let stableCount = 0;
  while (Date.now() < deadline) {
    const snapshot = await readAssistantSnapshot(
      Runtime,
      minTurnIndex ?? undefined,
      expectedConversationId,
      expectedPromptTurn,
    ).catch(() => null);
    const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
    if (!text || matcher.isEcho(text)) {
      await delay(300);
      continue;
    }
    if (!bestText || text.length > bestText.length) {
      bestText = text;
      stableCount = 0;
    } else if (text === bestText) {
      stableCount += 1;
    }
    if (stableCount >= 2) {
      break;
    }
    await delay(300);
  }
  if (bestText) {
    logger("Recovered assistant response after prompt echo during reattach");
    return { ...answer, text: bestText };
  }
  return answer;
}

export function alignPromptEchoPair(
  answerText: string,
  answerMarkdown: string,
  matcher: PromptEchoMatcher | null,
  logger?: BrowserLogger,
  messages?: { text?: string; markdown?: string },
): {
  answerText: string;
  answerMarkdown: string;
  textEcho: boolean;
  markdownEcho: boolean;
  isEcho: boolean;
} {
  if (!matcher) {
    return { answerText, answerMarkdown, textEcho: false, markdownEcho: false, isEcho: false };
  }
  let textEcho = matcher.isEcho(answerText);
  let markdownEcho = matcher.isEcho(answerMarkdown);
  if (textEcho && !markdownEcho && answerMarkdown) {
    if (logger && messages?.text) {
      logger(messages.text);
    }
    answerText = answerMarkdown;
    textEcho = false;
  }
  if (markdownEcho && !textEcho && answerText) {
    if (logger && messages?.markdown) {
      logger(messages.markdown);
    }
    answerMarkdown = answerText;
    markdownEcho = false;
  }
  return {
    answerText,
    answerMarkdown,
    textEcho,
    markdownEcho,
    isEcho: textEcho || markdownEcho,
  };
}

export function alignPromptEchoMarkdown(
  answerText: string,
  answerMarkdown: string,
  matcher: PromptEchoMatcher | null,
  logger: BrowserLogger,
): { answerText: string; answerMarkdown: string } {
  const aligned = alignPromptEchoPair(answerText, answerMarkdown, matcher, logger, {
    text: "Aligned prompt-echo text to copied markdown during reattach",
    markdown: "Aligned prompt-echo markdown to response text during reattach",
  });
  return { answerText: aligned.answerText, answerMarkdown: aligned.answerMarkdown };
}
