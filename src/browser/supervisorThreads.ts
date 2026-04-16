import type { ChromeClient } from "./types.js";
import {
  ASSISTANT_ROLE_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  FINISHED_ACTIONS_SELECTOR,
} from "./constants.js";
import { delay } from "./utils.js";
import {
  conversationHrefMatchesConfiguredScope,
  openConversationFromSidebarWithRetry,
} from "./reattachHelpers.js";
import { readAssistantSnapshot } from "./pageActions.js";
import {
  normalizeSupervisorThread,
  type SupervisorThreadInfo,
} from "./supervisorThreadNormalize.js";
import { buildThreadIntrospectionHelpers } from "./threadIntrospection.js";

export type { SupervisorThreadInfo };

const ATTACH_CONFIRM_TIMEOUT_MS = 8_000;
const ATTACH_CONFIRM_POLL_MS = 250;
const ATTACH_DIRECT_NAV_RETRY_DELAY_MS = 2_000;
const ATTACH_SIDEBAR_REPAIR_DELAY_MS = 4_000;
const ATTACH_REPAIR_CONFIRM_EXTENSION_MS = 1_000;
const HISTORY_ENTRY_LIMIT_DEFAULT = 100;
const HISTORY_ENTRY_LIMIT_MAX = 200;
const HISTORY_STABILITY_POLL_MS = 250;
const HISTORY_STABILITY_TIMEOUT_MS = 4_000;

export interface SupervisorThreadHistoryEntry {
  role: "user" | "assistant";
  text: string;
}

export interface SupervisorThreadHistoryWindow {
  limit: number;
  returnedCount: number;
  totalCount: number;
  truncated: boolean;
}

interface SupervisorThreadHistorySnapshot {
  thread: SupervisorThreadInfo;
  history: SupervisorThreadHistoryEntry[];
  historyWindow: SupervisorThreadHistoryWindow;
  activeRootValidated: boolean;
}

function normalizeNonNegativeInteger(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.max(0, Math.trunc(numeric));
}

async function readVisibleSupervisorTurnCount(Runtime: ChromeClient["Runtime"]): Promise<number> {
  try {
    const response = await Runtime.evaluate({
      expression: `(() => {
        ${buildThreadIntrospectionHelpers()}
        const activeRoot = __oraclePickActiveThreadRoot();
        if (!activeRoot) {
          return 0;
        }
        return __oracleCollectThreadEntries(activeRoot).filter(
          (entry) =>
            (entry.role === 'user' || entry.role === 'assistant') &&
            String(entry.text || '').trim().length > 0,
        ).length;
      })()`,
      returnByValue: true,
    });
    return normalizeNonNegativeInteger(response?.result?.value);
  } catch {
    return 0;
  }
}

async function hasVisibleSupervisorConversationContent(
  Runtime: ChromeClient["Runtime"],
  thread: SupervisorThreadInfo,
  threadUrl?: string,
): Promise<boolean> {
  const visibleTurnCount = await readVisibleSupervisorTurnCount(Runtime);
  if (visibleTurnCount > 0) {
    return true;
  }
  if (!isRootConversationUrl(thread.url) && !isRootConversationUrl(threadUrl)) {
    return false;
  }
  try {
    const snapshot = await readAssistantSnapshot(Runtime);
    return hasReadableAssistantSnapshotText(snapshot);
  } catch {
    return false;
  }
}

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

function isRootConversationUrl(url?: string): boolean {
  const trimmed = url?.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return /^\/c\/[a-zA-Z0-9-]+$/i.test(pathname);
  } catch {
    return /^https?:\/\/[^/]+\/c\/[a-zA-Z0-9-]+\/?$/i.test(trimmed);
  }
}

function hasReadableAssistantSnapshotText(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== "object") {
    return false;
  }
  const raw = snapshot as Record<string, unknown>;
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!text) {
    return false;
  }
  const normalized = text.toLowerCase();
  const normalizedHtml = (typeof raw.html === "string" ? raw.html : "").toLowerCase();
  if (
    normalized === "thinking" ||
    /^thought for\b[^\n]*$/.test(normalized) ||
    /^thought for\b[^\n]*\nthinking$/.test(normalized)
  ) {
    return false;
  }
  if (normalizedHtml.includes("result-thinking") || /<p\b[^>]*>\s*<\/p>/.test(normalizedHtml)) {
    return false;
  }
  if (
    normalized.includes("answer now") &&
    (normalized.includes("pro thinking") || normalized.includes("chatgpt"))
  ) {
    return false;
  }
  if (normalized.startsWith("you said")) {
    return false;
  }
  return !/^(?:starting|finalizing answer|analyzing|researching|reasoning|planning|drafting|reading|browsing|searching(?: the web)?)(?:\.{3}|…)?$/.test(
    normalized,
  );
}

async function navigateSupervisorThreadUrl(
  Runtime: ChromeClient["Runtime"],
  threadUrl: string,
): Promise<void> {
  await Runtime.evaluate({
    expression: `(() => {
      window.location.assign(${JSON.stringify(threadUrl)});
      return true;
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
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

function normalizeHistoryLimit(limit?: number): number {
  const numeric =
    typeof limit === "number" && Number.isFinite(limit)
      ? Math.trunc(limit)
      : HISTORY_ENTRY_LIMIT_DEFAULT;
  return Math.min(HISTORY_ENTRY_LIMIT_MAX, Math.max(1, numeric));
}

function normalizeSupervisorThreadHistoryEntry(
  value: unknown,
): SupervisorThreadHistoryEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const role = raw.role === "user" || raw.role === "assistant" ? raw.role : null;
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!role || !text) {
    return null;
  }
  return { role, text };
}

function normalizeSupervisorThreadHistoryWindow(
  value: unknown,
  limit: number,
  returnedCount: number,
): SupervisorThreadHistoryWindow {
  if (!value || typeof value !== "object") {
    return {
      limit,
      returnedCount,
      totalCount: returnedCount,
      truncated: false,
    };
  }
  const raw = value as Record<string, unknown>;
  const numeric = (candidate: unknown, fallback: number): number => {
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
      return fallback;
    }
    return Math.max(0, Math.trunc(candidate));
  };
  const normalizedLimit = normalizeHistoryLimit(numeric(raw.limit, limit));
  const normalizedReturnedCount = numeric(raw.returnedCount, returnedCount);
  const normalizedTotalCount = Math.max(
    normalizedReturnedCount,
    numeric(raw.totalCount, normalizedReturnedCount),
  );
  return {
    limit: normalizedLimit,
    returnedCount: normalizedReturnedCount,
    totalCount: normalizedTotalCount,
    truncated:
      typeof raw.truncated === "boolean"
        ? raw.truncated
        : normalizedTotalCount > normalizedReturnedCount,
  };
}

function normalizeSupervisorThreadHistorySnapshot(
  value: unknown,
  limit: number,
): SupervisorThreadHistorySnapshot {
  const snapshotRecord =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const readSnapshotThread = (candidate: unknown): SupervisorThreadInfo | null => {
    if (!candidate || typeof candidate !== "object") {
      return null;
    }
    const raw = candidate as Record<string, unknown>;
    const normalized = normalizeSupervisorThread(raw);
    const hasTitle = typeof raw.title === "string" && raw.title.trim().length > 0;
    return normalized && (Boolean(normalized.conversationId || normalized.url) || hasTitle)
      ? normalized
      : null;
  };
  const thread = readSnapshotThread(snapshotRecord.thread) ??
    readSnapshotThread(snapshotRecord.supervisorThread) ?? {
      title: "Untitled chat",
      isActive: true,
    };
  const rawHistory = Array.isArray(value)
    ? value
    : Array.isArray(snapshotRecord.history)
      ? (snapshotRecord.history as unknown[])
      : [];
  const history = rawHistory
    .map((entry) => normalizeSupervisorThreadHistoryEntry(entry))
    .filter((entry): entry is SupervisorThreadHistoryEntry => entry !== null);
  const historyWindow = normalizeSupervisorThreadHistoryWindow(
    snapshotRecord.historyWindow,
    limit,
    history.length,
  );
  const activeRootValidated =
    typeof snapshotRecord.activeRootValidated === "boolean"
      ? snapshotRecord.activeRootValidated
      : true;
  return { thread, history, historyWindow, activeRootValidated };
}

function supervisorThreadHistorySnapshotsEqual(
  left: SupervisorThreadHistorySnapshot,
  right: SupervisorThreadHistorySnapshot,
): boolean {
  const sameThread =
    left.thread.conversationId || right.thread.conversationId
      ? left.thread.conversationId === right.thread.conversationId
      : normalizeProjectUrl(left.thread.url) === normalizeProjectUrl(right.thread.url);
  if (
    !sameThread ||
    left.activeRootValidated !== right.activeRootValidated ||
    left.historyWindow.limit !== right.historyWindow.limit ||
    left.historyWindow.returnedCount !== right.historyWindow.returnedCount ||
    left.historyWindow.totalCount !== right.historyWindow.totalCount ||
    left.historyWindow.truncated !== right.historyWindow.truncated ||
    left.history.length !== right.history.length
  ) {
    return false;
  }
  return left.history.every(
    (entry, index) =>
      entry.role === right.history[index]?.role && entry.text === right.history[index]?.text,
  );
}

async function readSupervisorThreadHistorySnapshotOnce(
  Runtime: ChromeClient["Runtime"],
  limit: number,
): Promise<SupervisorThreadHistorySnapshot> {
  const response = await Runtime.evaluate({
    expression: `(() => {
      ${buildThreadIntrospectionHelpers()}
      const limit = ${limit};
      const turnSelector = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
      const assistantSelector = ${JSON.stringify(ASSISTANT_ROLE_SELECTOR)};
      const finishedSelector = ${JSON.stringify(FINISHED_ACTIONS_SELECTOR)};
      const contentSelector =
        '.markdown,[data-message-content],[data-testid*="message"],[data-testid*="assistant"],.prose,[class*="markdown"]';
      const userSelector = '[data-message-author-role="user"], [data-turn="user"]';
      const readThread = () => {
        const href = window.location.href || '';
        const conversationId = (href.match(/\\/c\\/([a-zA-Z0-9-]+)/) || [])[1] || '';
        return {
          url: href,
          conversationId,
          title:
            (document.querySelector('main h1')?.textContent || '').trim() ||
            (document.title || '').trim() ||
            'Untitled chat',
          isActive: true,
        };
      };
      const activeRoot = __oraclePickActiveThreadRoot();
      if (!(activeRoot instanceof Element)) {
        return {
          thread: readThread(),
          history: [],
          historyWindow: {
            limit,
            returnedCount: 0,
            totalCount: 0,
            truncated: false,
          },
          activeRootValidated: false,
        };
      }
      const normalize = (text) =>
        (text || '')
          .replace(/\\u00a0/g, ' ')
          .replace(/\\r/g, '')
          .replace(/[ \\t]+\\n/g, '\\n')
          .replace(/\\n{3,}/g, '\\n\\n')
          .replace(/[ \\t]{2,}/g, ' ')
          .trim();
      const cleanAssistantText = (text) => normalize(text).replace(/^chatgpt said:\\s*/i, '').trim();
      const isAssistantPlaceholder = ({ text, html }) => {
        const normalized = cleanAssistantText(text).toLowerCase();
        const normalizedHtml = String(html || '').toLowerCase();
        if (!normalized) return true;
        if (
          normalized === 'thinking' ||
          /^thought for\\b[^\\n]*$/.test(normalized) ||
          /^thought for\\b[^\\n]*\\nthinking$/.test(normalized)
        ) {
          return true;
        }
        if (
          normalizedHtml.includes('result-thinking') ||
          /<p\\b[^>]*>\\s*<\\/p>/.test(normalizedHtml)
        ) {
          return true;
        }
        if (
          normalized.includes('answer now') &&
          (normalized.includes('pro thinking') || normalized.includes('chatgpt'))
        ) {
          return true;
        }
        return /^(?:starting|finalizing answer|analyzing|researching|reasoning|planning|drafting|reading|browsing|searching(?: the web)?)(?:\\.{3}|…)?$/.test(
          normalized,
        );
      };
      const detectRole = (node) => {
        const ownRole =
          (node.getAttribute('data-message-author-role') ||
            node.getAttribute('data-turn') ||
            node.dataset?.messageAuthorRole ||
            node.dataset?.turn ||
            '')
            .toLowerCase()
            .trim();
        if (ownRole === 'user' || ownRole === 'assistant') {
          return ownRole;
        }
        if (node.querySelector(assistantSelector)) {
          return 'assistant';
        }
        if (node.querySelector(userSelector)) {
          return 'user';
        }
        return '';
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
          finishedSelector,
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
        const text = normalize(innerText.trim().length > 0 ? innerText : textContent);
        if (!text) {
          return null;
        }
        return { text, html: clone.innerHTML ?? '' };
      };
      const chooseBetterPayload = (current, candidate) => {
        if (!candidate) return current;
        if (!current) return candidate;
        const currentScore = current.rank * 10000 + current.text.length;
        const candidateScore = candidate.rank * 10000 + candidate.text.length;
        return candidateScore > currentScore ? candidate : current;
      };
      const expandCollapsibles = (root) => {
        if (!(root instanceof HTMLElement)) {
          return;
        }
        const normalizeLabel = (value) => (value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        for (const button of Array.from(root.querySelectorAll('button'))) {
          const label = normalizeLabel(button.getAttribute('aria-label') || button.textContent);
          const testid = (button.getAttribute('data-testid') || '').toLowerCase();
          const expanded = (button.getAttribute('aria-expanded') || '').toLowerCase();
          if (
            expanded === 'false' ||
            label === 'more' ||
            label === 'show more' ||
            label.startsWith('show more ') ||
            label === 'expand' ||
            label.startsWith('expand ') ||
            testid.includes('markdown') ||
            testid.includes('toggle') ||
            testid.includes('expand')
          ) {
            button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          }
        }
      };
      const readTurnPayload = (node, role) => {
        const messageSelector = role === 'assistant' ? assistantSelector : userSelector;
        const messageRoots = Array.from(node.querySelectorAll(messageSelector)).filter(
          (candidate) => candidate instanceof HTMLElement,
        );
        const messageRoot = messageRoots[messageRoots.length - 1] ?? node;
        expandCollapsibles(messageRoot);
        const candidateRoots = [];
        if (messageRoot.matches?.(contentSelector)) {
          candidateRoots.push(messageRoot);
        }
        candidateRoots.push(...Array.from(messageRoot.querySelectorAll(contentSelector)));
        const uniqueRoots = Array.from(new Set(candidateRoots));
        const topLevelRoots = uniqueRoots.filter(
          (candidate) => !uniqueRoots.some((other) => other !== candidate && other.contains(candidate)),
        );
        let bestPayload = null;
        const aggregatedRoots = topLevelRoots
          .map((candidate) => readCandidatePayload(candidate))
          .filter(Boolean);
        if (aggregatedRoots.length > 1) {
          bestPayload = chooseBetterPayload(bestPayload, {
            text: aggregatedRoots.map((payload) => payload.text).join('\\n\\n'),
            html: aggregatedRoots.map((payload) => payload.html).filter(Boolean).join('\\n'),
            rank: 4,
          });
        }
        for (const candidate of topLevelRoots) {
          const payload = readCandidatePayload(candidate);
          if (!payload) continue;
          bestPayload = chooseBetterPayload(bestPayload, { ...payload, rank: 3 });
        }
        const messagePayload = readCandidatePayload(messageRoot);
        if (messagePayload) {
          bestPayload = chooseBetterPayload(bestPayload, { ...messagePayload, rank: 2 });
        }
        const turnPayload = readCandidatePayload(node);
        if (turnPayload) {
          bestPayload = chooseBetterPayload(bestPayload, { ...turnPayload, rank: 1 });
        }
        return bestPayload;
      };
      const rawTurns = Array.from(activeRoot.querySelectorAll(turnSelector)).filter(
        (node) => node instanceof Element && !__oracleIsExcluded(node),
      );
      const turns = rawTurns.filter(
        (node) =>
          node instanceof Element &&
          !__oracleIsExcluded(node) &&
          !(node instanceof HTMLElement && node.parentElement?.closest(turnSelector)),
      );
      const orderedTurns = turns.length > 0 ? turns : rawTurns;
      const entries = [];
      for (const node of orderedTurns) {
        if (!(node instanceof Element)) continue;
        const role = detectRole(node);
        if (!role) continue;
        const payload = readTurnPayload(node, role);
        if (!payload?.text) continue;
        if (role === 'assistant' && isAssistantPlaceholder(payload)) {
          continue;
        }
        const text = payload.text;
        const last = entries.at(-1);
        if (last && last.role === role && last.text === text) {
          continue;
        }
        entries.push({ role, text });
      }
      const limitedEntries = entries.slice(-limit);
      return {
        thread: readThread(),
        history: limitedEntries,
        historyWindow: {
          limit,
          returnedCount: limitedEntries.length,
          totalCount: entries.length,
          truncated: entries.length > limitedEntries.length,
        },
        activeRootValidated: true,
      };
    })()`,
    returnByValue: true,
  });
  return normalizeSupervisorThreadHistorySnapshot(response.result?.value, limit);
}

async function readSupervisorThreadHistorySnapshot(
  Runtime: ChromeClient["Runtime"],
  options?: { limit?: number },
): Promise<SupervisorThreadHistorySnapshot> {
  const limit = normalizeHistoryLimit(options?.limit);
  let previous = await readSupervisorThreadHistorySnapshotOnce(Runtime, limit);
  let current = await readSupervisorThreadHistorySnapshotOnce(Runtime, limit);
  if (supervisorThreadHistorySnapshotsEqual(previous, current)) {
    return current;
  }
  const deadline = Date.now() + HISTORY_STABILITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(HISTORY_STABILITY_POLL_MS);
    previous = current;
    current = await readSupervisorThreadHistorySnapshotOnce(Runtime, limit);
    if (supervisorThreadHistorySnapshotsEqual(previous, current)) {
      return current;
    }
  }
  return current;
}

export async function readSupervisorThreadHistory(
  Runtime: ChromeClient["Runtime"],
  options?: { limit?: number },
): Promise<SupervisorThreadHistoryEntry[]> {
  return (await readSupervisorThreadHistorySnapshot(Runtime, options)).history;
}

export async function readAttachedSupervisorThreadHistory(
  Runtime: ChromeClient["Runtime"],
  options: { conversationId: string; projectUrl?: string; limit?: number },
): Promise<{
  thread: SupervisorThreadInfo;
  history: SupervisorThreadHistoryEntry[];
  historyWindow: SupervisorThreadHistoryWindow;
}> {
  const expectedConversationId = options.conversationId.trim();
  if (!expectedConversationId) {
    throw new Error("conversationId is required for thread_history.");
  }
  let thread = await readCurrentSupervisorThread(Runtime);
  if (
    thread.conversationId !== expectedConversationId ||
    !supervisorThreadMatchesProjectScope(thread, options.projectUrl) ||
    !(await hasVisibleSupervisorConversationContent(Runtime, thread))
  ) {
    thread = await attachSupervisorThread(Runtime, expectedConversationId, {
      projectUrl: options.projectUrl,
    });
  }
  if (!supervisorThreadMatchesProjectScope(thread, options.projectUrl)) {
    throw new Error(
      `Refusing to read Oracle supervisor thread ${thread.conversationId ?? "unknown"} outside the configured project scope.`,
    );
  }
  const snapshot = await readSupervisorThreadHistorySnapshot(Runtime, { limit: options.limit });
  if (!snapshot.activeRootValidated) {
    throw new Error(
      `Oracle supervisor thread history could not validate the active conversation container for ${expectedConversationId}.`,
    );
  }
  if (
    snapshot.thread.conversationId !== expectedConversationId ||
    !supervisorThreadMatchesProjectScope(snapshot.thread, options.projectUrl)
  ) {
    throw new Error(
      `Oracle supervisor thread changed during history capture (expected ${expectedConversationId}, current ${snapshot.thread.conversationId ?? "unknown"}).`,
    );
  }
  const settledThread = await readCurrentSupervisorThread(Runtime);
  await delay(HISTORY_STABILITY_POLL_MS);
  const confirmedThread = await readCurrentSupervisorThread(Runtime);
  if (
    settledThread.conversationId !== expectedConversationId ||
    !supervisorThreadMatchesProjectScope(settledThread, options.projectUrl) ||
    confirmedThread.conversationId !== expectedConversationId ||
    !supervisorThreadMatchesProjectScope(confirmedThread, options.projectUrl)
  ) {
    throw new Error(
      `Oracle supervisor thread changed during history capture (expected ${expectedConversationId}, current ${confirmedThread.conversationId ?? settledThread.conversationId ?? "unknown"}).`,
    );
  }
  return {
    thread: confirmedThread,
    history: snapshot.history,
    historyWindow: snapshot.historyWindow,
  };
}

export async function attachSupervisorThread(
  Runtime: ChromeClient["Runtime"],
  conversationId: string,
  options?: { projectUrl?: string; threadUrl?: string },
): Promise<SupervisorThreadInfo> {
  const normalizedId = conversationId.trim();
  const normalizedThreadUrl = options?.threadUrl?.trim() || undefined;
  if (!normalizedId) {
    throw new Error("conversationId is required for attach_thread.");
  }

  const current = await readCurrentSupervisorThread(Runtime);
  if (
    current.conversationId === normalizedId &&
    (!normalizedThreadUrl ||
      normalizeProjectUrl(current.url) === normalizeProjectUrl(normalizedThreadUrl)) &&
    supervisorThreadMatchesProjectScope(current, options?.projectUrl) &&
    (await hasVisibleSupervisorConversationContent(Runtime, current, normalizedThreadUrl))
  ) {
    return current;
  }

  if (normalizedThreadUrl) {
    await navigateSupervisorThreadUrl(Runtime, normalizedThreadUrl);
  } else {
    const opened = await openConversationFromSidebarWithRetry(
      Runtime,
      { conversationId: normalizedId, preferProjects: true },
      15_000,
    );
    if (!opened) {
      throw new Error(`Unable to find conversation ${normalizedId} in sidebar.`);
    }
  }

  const start = Date.now();
  let deadline = start + ATTACH_CONFIRM_TIMEOUT_MS;
  let lastSeen = current;
  let retriedDirectNavigation = false;
  let attemptedSidebarRepair = false;
  while (Date.now() < deadline) {
    await delay(ATTACH_CONFIRM_POLL_MS);
    lastSeen = await readCurrentSupervisorThread(Runtime);
    if (
      lastSeen.conversationId === normalizedId &&
      supervisorThreadMatchesProjectScope(lastSeen, options?.projectUrl) &&
      (await hasVisibleSupervisorConversationContent(Runtime, lastSeen, normalizedThreadUrl))
    ) {
      return lastSeen;
    }

    const attachIdentityMatches =
      lastSeen.conversationId === normalizedId &&
      supervisorThreadMatchesProjectScope(lastSeen, options?.projectUrl);
    if (!normalizedThreadUrl || attachIdentityMatches) {
      continue;
    }

    const elapsedMs = Date.now() - start;
    if (!retriedDirectNavigation && elapsedMs >= ATTACH_DIRECT_NAV_RETRY_DELAY_MS) {
      retriedDirectNavigation = true;
      await navigateSupervisorThreadUrl(Runtime, normalizedThreadUrl);
      deadline = Math.max(deadline, Date.now() + ATTACH_REPAIR_CONFIRM_EXTENSION_MS);
      continue;
    }
    if (!attemptedSidebarRepair && elapsedMs >= ATTACH_SIDEBAR_REPAIR_DELAY_MS) {
      attemptedSidebarRepair = true;
      await openConversationFromSidebarWithRetry(
        Runtime,
        { conversationId: normalizedId, preferProjects: true },
        15_000,
      ).catch(() => false);
      deadline = Math.max(deadline, Date.now() + ATTACH_REPAIR_CONFIRM_EXTENSION_MS);
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
  normalizeSupervisorThreadHistoryEntry,
  readAttachedSupervisorThreadHistory,
  readSupervisorThreadHistory,
  readSupervisorThreadHistorySnapshot,
  supervisorThreadMatchesProjectScope,
};
