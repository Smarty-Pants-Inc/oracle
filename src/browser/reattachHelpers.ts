import type { BrowserLogger, ChromeClient } from "./types.js";
import { extractStableConversationIdFromUrl } from "./conversationUrl.js";
import { delay } from "./utils.js";
import { normalizePromptForIdentity } from "./actions/promptComposer.js";

export type TargetInfoLite = {
  id?: string;
  targetId?: string;
  type?: string;
  url?: string;
  [key: string]: unknown;
};

type PromptEchoMatcher = { isEcho: (text: string) => boolean };

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

export function buildPromptEchoMatcher(prompt?: string | null): PromptEchoMatcher | null {
  const normalizedPrompt = normalizePromptForIdentity(prompt ?? "");
  if (!normalizedPrompt) return null;
  return {
    isEcho: (text: string) => normalizePromptForIdentity(text) === normalizedPrompt,
  };
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
