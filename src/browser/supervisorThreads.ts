import type { ChromeClient } from "./types.js";
import { delay } from "./utils.js";
import {
  conversationHrefMatchesConfiguredScope,
  openConversationFromSidebarWithRetry,
} from "./reattachHelpers.js";
import {
  normalizeSupervisorThread,
  type SupervisorThreadInfo,
} from "./supervisorThreadNormalize.js";

export type { SupervisorThreadInfo };

const ATTACH_CONFIRM_TIMEOUT_MS = 8_000;
const ATTACH_CONFIRM_POLL_MS = 250;

export async function readCurrentSupervisorThread(
  Runtime: ChromeClient["Runtime"],
): Promise<SupervisorThreadInfo> {
  const response = await Runtime.evaluate({
    expression: `(() => {
      const href = window.location.href || '';
      const conversationId = (href.match(/\\/c\\/([a-zA-Z0-9-]+)/) || [])[1] || '';
      const title =
        (document.querySelector('main h1')?.textContent || '').trim() ||
        (document.title || '').trim() ||
        'Untitled chat';
      return { url: href, conversationId, title, isActive: true };
    })()`,
    returnByValue: true,
  });
  const normalized = normalizeSupervisorThread(
    (response?.result?.value ?? {}) as Record<string, unknown>,
  );
  return normalized ?? { title: "Untitled chat", isActive: true };
}

function normalizeProjectUrl(projectUrl?: string): string | undefined {
  const trimmed = projectUrl?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export function supervisorThreadMatchesProjectScope(
  thread: SupervisorThreadInfo,
  projectUrl?: string,
): boolean {
  const normalizedProjectUrl = normalizeProjectUrl(projectUrl);
  if (!normalizedProjectUrl) {
    return true;
  }
  const threadUrl = normalizeProjectUrl(thread.url);
  if (thread.conversationId) {
    return !threadUrl || conversationHrefMatchesConfiguredScope(threadUrl, normalizedProjectUrl);
  }
  return threadUrl === normalizedProjectUrl;
}

export async function listSupervisorThreads(
  Runtime: ChromeClient["Runtime"],
  options?: { limit?: number; projectUrl?: string },
): Promise<SupervisorThreadInfo[]> {
  const limit = Math.min(200, Math.max(1, options?.limit ?? 50));
  const projectUrl = options?.projectUrl;
  const response = await Runtime.evaluate({
    expression: `(() => {
      const limit = ${limit};
      const toAbsolute = (href) => {
        if (!href) return '';
        try {
          return new URL(href, window.location.origin).toString();
        } catch {
          return href;
        }
      };
      const extractId = (href) => ((href || '').match(/\\/c\\/([a-zA-Z0-9-]+)/) || [])[1] || '';
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const selectors = [
        'nav a[href*="/c/"]',
        'aside a[href*="/c/"]',
        'a[href*="/c/"]',
        '[data-conversation-id]',
        '[data-testid*="conversation"]',
        '[data-testid*="history"]',
      ];
      const nodes = Array.from(new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))));
      const seen = new Set();
      const threads = [];
      const currentHref = window.location.href || '';
      const currentId = extractId(currentHref);
      for (const node of nodes) {
        const clickable = node.closest('a,button,[role="link"],[role="button"]') || node;
        if (!isVisible(clickable)) continue;
        const hrefRaw =
          clickable.getAttribute('href') ||
          clickable.getAttribute('data-href') ||
          clickable.getAttribute('data-url') ||
          node.getAttribute('href') ||
          node.getAttribute('data-href') ||
          node.getAttribute('data-url') ||
          '';
        const href = toAbsolute(hrefRaw);
        const conversationId =
          clickable.getAttribute('data-conversation-id') ||
          node.getAttribute('data-conversation-id') ||
          extractId(href);
        if (!conversationId && !href.includes('/c/')) continue;
        const title = (clickable.textContent || node.textContent || '').replace(/\\s+/g, ' ').trim();
        const key = conversationId || href || title;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const isActive =
          clickable.getAttribute('aria-current') === 'page' ||
          clickable.getAttribute('aria-selected') === 'true' ||
          clickable.classList.contains('active') ||
          (conversationId && conversationId === currentId) ||
          (href && href === currentHref);
        threads.push({
          conversationId,
          url: href,
          title: title || 'Untitled chat',
          isActive,
        });
        if (threads.length >= limit) break;
      }
      return threads;
    })()`,
    returnByValue: true,
  });

  const rawThreads = Array.isArray(response.result?.value) ? response.result.value : [];
  return rawThreads
    .map((raw) => normalizeSupervisorThread((raw ?? {}) as Record<string, unknown>))
    .filter((value): value is SupervisorThreadInfo => value !== null)
    .filter(
      (value) =>
        Boolean(value.conversationId?.trim()) &&
        supervisorThreadMatchesProjectScope(value, projectUrl),
    )
    .slice(0, limit);
}

async function readConfirmedSupervisorThread(
  Runtime: ChromeClient["Runtime"],
  conversationId: string,
  options?: { projectUrl?: string },
): Promise<SupervisorThreadInfo> {
  const current = await readCurrentSupervisorThread(Runtime);
  if (
    current.conversationId === conversationId &&
    supervisorThreadMatchesProjectScope(current, options?.projectUrl)
  ) {
    return current;
  }
  const activeSidebarThread = (
    await listSupervisorThreads(Runtime, {
      limit: 50,
      projectUrl: options?.projectUrl,
    })
  ).find((thread) => thread.isActive && thread.conversationId === conversationId);
  return activeSidebarThread ?? current;
}

export async function attachSupervisorThread(
  Runtime: ChromeClient["Runtime"],
  conversationId: string,
  options?: { projectUrl?: string },
): Promise<SupervisorThreadInfo> {
  const normalizedId = conversationId.trim();
  if (!normalizedId) {
    throw new Error("conversationId is required for attach_thread.");
  }

  const current = await readCurrentSupervisorThread(Runtime);
  if (
    current.conversationId === normalizedId &&
    supervisorThreadMatchesProjectScope(current, options?.projectUrl)
  ) {
    return current;
  }

  const opened = await openConversationFromSidebarWithRetry(
    Runtime,
    { conversationId: normalizedId, preferProjects: true },
    15_000,
  );
  if (!opened) {
    throw new Error(`Unable to find conversation ${normalizedId} in sidebar.`);
  }

  const start = Date.now();
  let lastSeen = current;
  while (Date.now() - start < ATTACH_CONFIRM_TIMEOUT_MS) {
    await delay(ATTACH_CONFIRM_POLL_MS);
    lastSeen = await readConfirmedSupervisorThread(Runtime, normalizedId, options);
    if (
      lastSeen.conversationId === normalizedId &&
      supervisorThreadMatchesProjectScope(lastSeen, options?.projectUrl)
    ) {
      return lastSeen;
    }
  }

  throw new Error(
    `Conversation ${normalizedId} did not become active after attach_thread (current: ${
      lastSeen.conversationId || "unknown"
    }).`,
  );
}

export async function newSupervisorThread(
  Runtime: ChromeClient["Runtime"],
  options?: { projectUrl?: string },
): Promise<SupervisorThreadInfo> {
  const projectUrl = options?.projectUrl?.trim() || undefined;
  const start = await readCurrentSupervisorThread(Runtime);
  const isFreshChat = (thread: SupervisorThreadInfo): boolean => {
    if (!thread.url || thread.url.includes("/c/") || thread.conversationId) {
      return false;
    }
    try {
      const parsed = new URL(thread.url);
      const pathname = parsed.pathname.replace(/\/+$/, "");
      if (pathname === "" || pathname === "/") {
        return !projectUrl;
      }
      if (projectUrl) {
        return normalizeProjectUrl(parsed.toString()) === normalizeProjectUrl(projectUrl);
      }
      return /^\/g\/[^/]+\/project$/i.test(pathname);
    } catch {
      return (
        (!projectUrl &&
          (thread.url === "https://chatgpt.com" || thread.url === "https://chatgpt.com/")) ||
        (projectUrl !== undefined &&
          normalizeProjectUrl(thread.url) === normalizeProjectUrl(projectUrl))
      );
    }
  };
  if (isFreshChat(start)) {
    return start;
  }
  await Runtime.evaluate({
    expression: `(() => {
      const selectors = [
        '[data-testid*="new-chat"]',
        'button[aria-label*="new chat" i]',
        'button[title*="new chat" i]',
        'a[aria-label*="new chat" i]',
      ];
      const normalize = (text) => (text || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      for (const selector of selectors) {
        const candidate = document.querySelector(selector);
        if (candidate instanceof HTMLElement) {
          candidate.click();
          return true;
        }
      }
      const fallback = Array.from(document.querySelectorAll('a,button,[role="button"],[role="link"]'))
        .find((el) => normalize(el.textContent).includes('new chat'));
      if (fallback instanceof HTMLElement) {
        fallback.click();
        return true;
      }
      try {
        window.location.href = ${JSON.stringify(projectUrl ?? "/")};
        return true;
      } catch {
        return false;
      }
    })()`,
    returnByValue: true,
  });

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(250);
    const current = await readCurrentSupervisorThread(Runtime);
    if (isFreshChat(current)) {
      return current;
    }
    if (current.url !== start.url || current.conversationId !== start.conversationId) {
      continue;
    }
  }

  const current = await readCurrentSupervisorThread(Runtime);
  if (isFreshChat(current)) {
    return current;
  }
  throw new Error(
    `New Oracle thread did not become active in the configured project scope (current: ${
      current.url || current.conversationId || "unknown"
    }).`,
  );
}

export const __test__ = {
  normalizeSupervisorThread,
  supervisorThreadMatchesProjectScope,
};
