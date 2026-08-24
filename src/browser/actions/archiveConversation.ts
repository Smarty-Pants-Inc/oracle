import { randomUUID } from "node:crypto";
import type {
  BrowserArchiveMode,
  BrowserArchiveResult,
  BrowserLogger,
  BrowserResearchMode,
  ChromeClient,
} from "../types.js";
import { MAX_CHATGPT_ACCOUNT_ID_LENGTH } from "../chatgptAccount.js";
import { isSameChatGptConversationUrl, parseChatGptConversationScope } from "../conversationUrl.js";

const ARCHIVE_HOST_HANDOFF_MS = 250;
const ARCHIVE_CONFIRMATION_BUDGET_MS = 1_000;
const ARCHIVE_TOMBSTONES_KEY = "__oracleChatGptArchiveCancelled";

export interface BrowserArchiveDecision {
  mode: BrowserArchiveMode;
  shouldArchive: boolean;
  reason: string;
}

export function isProjectChatgptUrl(url?: string | null): boolean {
  return /\/project(?:[/?#]|$)/i.test(url ?? "");
}

export function isTemporaryChatgptUrl(url?: string | null): boolean {
  try {
    const parsed = new URL(url ?? "");
    return (parsed.searchParams.get("temporary-chat") ?? "").trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

export function resolveBrowserArchiveDecision({
  mode = "auto",
  chatgptUrl,
  conversationUrl,
  researchMode,
  followUpCount,
}: {
  mode?: BrowserArchiveMode;
  chatgptUrl?: string | null;
  conversationUrl?: string | null;
  researchMode?: BrowserResearchMode;
  followUpCount?: number;
}): BrowserArchiveDecision {
  if (mode === "never") {
    return { mode, shouldArchive: false, reason: "disabled" };
  }
  if (!conversationUrl) {
    return { mode, shouldArchive: false, reason: "missing-conversation-url" };
  }
  if (isTemporaryChatgptUrl(chatgptUrl) || isTemporaryChatgptUrl(conversationUrl)) {
    return { mode, shouldArchive: false, reason: "temporary-chat" };
  }
  if (mode === "always") {
    return { mode, shouldArchive: true, reason: "forced" };
  }
  if (researchMode === "deep") {
    return { mode, shouldArchive: false, reason: "deep-research" };
  }
  if ((followUpCount ?? 0) > 0) {
    return { mode, shouldArchive: false, reason: "multi-turn" };
  }
  return { mode, shouldArchive: true, reason: "successful-one-shot" };
}

function resolveArchiveConversationAffinity(
  rawUrl?: string | null,
): { origin: string; conversationId: string; conversationUrl: string } | null {
  const scope = parseChatGptConversationScope(rawUrl);
  if (!scope) return null;
  return {
    origin: scope.origin,
    conversationId: scope.conversationId,
    conversationUrl: `${scope.origin}${scope.pathname}`,
  };
}
function buildArchiveCancellationExpression(operationToken: string): string {
  return `(() => {
    const key = ${JSON.stringify(ARCHIVE_TOMBSTONES_KEY)};
    const token = ${JSON.stringify(operationToken)};
    try {
      const tombstones = window[key] && typeof window[key] === 'object'
        ? window[key]
        : (window[key] = Object.create(null));
      tombstones[token] = true;
      return tombstones[token] === true;
    } catch {
      return false;
    }
  })()`;
}

function buildArchiveCleanupExpression(operationToken: string): string {
  return `(() => {
    const key = ${JSON.stringify(ARCHIVE_TOMBSTONES_KEY)};
    const token = ${JSON.stringify(operationToken)};
    try {
      const tombstones = window[key];
      if (!tombstones || tombstones[token] !== true) return false;
      delete tombstones[token];
      return tombstones[token] !== true;
    } catch {
      return false;
    }
  })()`;
}

function cancelTimedOutArchiveEvaluation(
  Runtime: ChromeClient["Runtime"],
  operation: Promise<unknown>,
  operationToken: string,
): void {
  const cancellation = Promise.resolve().then(() =>
    Runtime.evaluate({
      expression: buildArchiveCancellationExpression(operationToken),
      awaitPromise: false,
      returnByValue: true,
    }),
  );
  const lateResult = operation.then(
    () => undefined,
    () => undefined,
  );
  void Promise.allSettled([cancellation, lateResult]).then(([cancelled]) => {
    if (cancelled.status !== "fulfilled" || cancelled.value.result?.value !== true) return;
    void Promise.resolve()
      .then(() =>
        Runtime.evaluate({
          expression: buildArchiveCleanupExpression(operationToken),
          awaitPromise: false,
          returnByValue: true,
        }),
      )
      .catch(() => undefined);
  });
}

export async function archiveChatGptConversation(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  {
    mode,
    conversationUrl,
    expectedAccountDigest,
    remainingMs,
  }: {
    mode: BrowserArchiveMode;
    conversationUrl?: string | null;
    expectedAccountDigest?: string;
    remainingMs?: number;
  },
): Promise<BrowserArchiveResult> {
  const affinity = resolveArchiveConversationAffinity(conversationUrl);
  if (!affinity) {
    return {
      mode,
      attempted: false,
      archived: false,
      reason: "affinity-mismatch",
      conversationUrl: conversationUrl ?? undefined,
      error: "originating conversation identity is unavailable",
    };
  }
  const resolvedRemainingMs =
    typeof remainingMs === "number" && Number.isFinite(remainingMs)
      ? Math.max(0, Math.floor(remainingMs))
      : 10_000;
  if (resolvedRemainingMs === 0) {
    const error = "Archive deadline elapsed.";
    logger(`[browser] ChatGPT archive skipped (${error}).`);
    return {
      mode,
      attempted: false,
      archived: false,
      reason: "archive-failed",
      conversationUrl: conversationUrl ?? undefined,
      error,
    };
  }
  const pageRemainingMs = resolvedRemainingMs - ARCHIVE_HOST_HANDOFF_MS;
  if (pageRemainingMs < ARCHIVE_CONFIRMATION_BUDGET_MS) {
    const error = "Archive deadline has insufficient confirmation budget.";
    logger(`[browser] ChatGPT archive skipped (${error}).`);
    return {
      mode,
      attempted: false,
      archived: false,
      reason: "archive-not-confirmed",
      conversationUrl: conversationUrl ?? undefined,
      error,
    };
  }
  const operationToken = randomUUID();
  const pageDeadlineMs = Date.now() + pageRemainingMs;
  const operation = Promise.resolve().then(() =>
    Runtime.evaluate({
      expression: buildArchiveConversationExpression({
        expectedOrigin: affinity.origin,
        expectedConversationId: affinity.conversationId,
        expectedConversationUrl: affinity.conversationUrl,
        expectedAccountDigest,
        remainingMs: pageRemainingMs,
        deadlineMs: pageDeadlineMs,
        operationToken,
      }),
      awaitPromise: true,
      returnByValue: true,
    }),
  );
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      reject(new Error("Timed out while archiving ChatGPT conversation."));
    }, resolvedRemainingMs);
    timeout.unref?.();
  });
  try {
    const evaluated = await Promise.race([operation, timeoutPromise]);
    const value = evaluated.result?.value as
      | { status: "archived"; conversationUrl?: string | null }
      | { status: "skipped"; reason: string; conversationUrl?: string | null }
      | { status: "failed"; error: string; conversationUrl?: string | null }
      | undefined;
    const reason = value?.status === "skipped" ? value.reason : "archive-failed";
    const error = value?.status === "failed" ? value.error : undefined;
    const returnedUrl = value?.conversationUrl ?? affinity.conversationUrl;
    const scopeMatches = isSameChatGptConversationUrl(returnedUrl, affinity.conversationUrl);
    const resolvedUrl = scopeMatches
      ? (value?.conversationUrl ?? conversationUrl)
      : conversationUrl;
    if (value?.status === "archived" && scopeMatches) {
      logger("[browser] Archived ChatGPT conversation after saving local artifacts.");
      return { mode, attempted: true, archived: true, conversationUrl: resolvedUrl ?? undefined };
    }
    const resolvedReason = value?.status === "archived" ? "affinity-mismatch" : reason;
    const resolvedError =
      value?.status === "archived" && !scopeMatches
        ? "Archive result left the approved conversation scope."
        : error;
    logger(`[browser] ChatGPT archive skipped (${resolvedError ?? resolvedReason}).`);
    return {
      mode,
      attempted: resolvedReason !== "affinity-mismatch",
      archived: false,
      reason: resolvedReason,
      conversationUrl: resolvedUrl ?? undefined,
      error: resolvedError,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (timedOut) {
      cancelTimedOutArchiveEvaluation(Runtime, operation, operationToken);
      logger(
        "[browser] ChatGPT archive timeout cancellation was dispatched; page deadline gate remains active.",
      );
    }
    logger(`[browser] ChatGPT archive skipped (${message}).`);
    return {
      mode,
      attempted: true,
      archived: false,
      reason: "archive-failed",
      conversationUrl: conversationUrl ?? undefined,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function buildArchiveConversationExpressionForTest(options?: {
  expectedOrigin?: string;
  expectedConversationId?: string;
  expectedConversationUrl?: string;
  expectedAccountDigest?: string;
  remainingMs?: number;
  deadlineMs?: number;
  operationToken?: string;
}): string {
  const expectedOrigin = options?.expectedOrigin ?? "https://chatgpt.com";
  const expectedConversationId = options?.expectedConversationId ?? "abc";
  return buildArchiveConversationExpression({
    expectedOrigin,
    expectedConversationId,
    expectedConversationUrl:
      options?.expectedConversationUrl ?? `${expectedOrigin}/c/${expectedConversationId}`,
    expectedAccountDigest: options?.expectedAccountDigest,
    remainingMs:
      typeof options?.remainingMs === "number" && Number.isFinite(options.remainingMs)
        ? Math.max(0, Math.floor(options.remainingMs))
        : 10_000,
    deadlineMs:
      typeof options?.deadlineMs === "number" && Number.isFinite(options.deadlineMs)
        ? Math.floor(options.deadlineMs)
        : undefined,
    operationToken: options?.operationToken ?? "archive-test-operation",
  });
}

function buildArchiveConversationExpression({
  expectedOrigin,
  expectedConversationId,
  expectedConversationUrl,
  expectedAccountDigest,
  remainingMs,
  deadlineMs,
  operationToken,
}: {
  expectedOrigin: string;
  expectedConversationId: string;
  expectedConversationUrl: string;
  expectedAccountDigest?: string;
  remainingMs: number;
  deadlineMs?: number;
  operationToken: string;
}): string {
  const deadlineExpression =
    deadlineMs === undefined
      ? `Date.now() + ${JSON.stringify(Math.max(0, Math.floor(remainingMs)))}`
      : JSON.stringify(deadlineMs);
  return `(() => {
    const expectedOrigin = ${JSON.stringify(expectedOrigin)};
    const expectedConversationId = ${JSON.stringify(expectedConversationId)};
    const expectedConversationUrl = ${JSON.stringify(expectedConversationUrl)};
    const expectedAccountDigest = ${JSON.stringify(expectedAccountDigest ?? null)};
    const operationToken = ${JSON.stringify(operationToken)};
    const tombstonesKey = ${JSON.stringify(ARCHIVE_TOMBSTONES_KEY)};
    const deadline = ${deadlineExpression};
    const remainingMs = Math.max(0, deadline - Date.now());
    const confirmationBudgetMs = ${ARCHIVE_CONFIRMATION_BUDGET_MS};
    const confirmationDeadline = deadline - confirmationBudgetMs;
    const fallbackAffinityDeadline = deadline - Math.min(350, confirmationBudgetMs);
    const isCancelled = () => {
      try { return window[tombstonesKey]?.[operationToken] === true; } catch { return false; }
    };
    const canContinue = (cutoff = deadline) => !isCancelled() && Date.now() < cutoff;
    let conversationUrl = typeof location === 'object' ? location.href : null;
    const sleep = (ms) => {
      const { promise, resolve } = Promise.withResolvers();
      setTimeout(resolve, ms);
      return promise;
    };
    const normalize = (value) =>
      String(value ?? '')
        .replace(/\\s+/g, ' ')
        .trim()
        .toLowerCase();
    const labelFor = (element) =>
      normalize([
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('title'),
        element.textContent,
      ].filter(Boolean).join(' '));
    const readAccountDigest = async (cutoff = deadline) => {
      if (!expectedAccountDigest || !canContinue(cutoff)) return null;
      const controller = new AbortController();
      const { promise: timeout, resolve: resolveTimeout } = Promise.withResolvers();
      const timeoutId = setTimeout(() => {
        controller.abort();
        resolveTimeout(null);
      }, Math.max(0, cutoff - Date.now()));
      try {
        return await Promise.race([
          (async () => {
            let target;
            try {
              const pageOrigin = new URL(location.href).origin;
              if (pageOrigin !== expectedOrigin) return null;
              target = new URL('/api/auth/session', pageOrigin).href;
            } catch {
              return null;
            }
            const response = await fetch(target, {
              method: 'GET', cache: 'no-store', credentials: 'include', redirect: 'error', signal: controller.signal,
            });
            if (
              !response.ok ||
              response.redirected ||
              response.url !== target ||
              controller.signal.aborted ||
              !canContinue(cutoff)
            ) return null;
            const body = await response.json();
            const rawUserId = typeof body?.user?.id === 'string' ? body.user.id : '';
            const userId =
              rawUserId.length > 0 && rawUserId.length <= ${MAX_CHATGPT_ACCOUNT_ID_LENGTH} ? rawUserId.trim() : '';
            if (!userId || !globalThis.crypto?.subtle || !canContinue(cutoff)) return null;
            const bytes = new Uint8Array(await crypto.subtle.digest(
              'SHA-256', new TextEncoder().encode(userId),
            ));
            return canContinue(cutoff)
              ? Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
              : null;
          })().catch(() => null),
          timeout,
        ]);
      } finally {
        clearTimeout(timeoutId);
      }
    };
    const hasExpectedAffinity = async (cutoff = deadline) => {
      if (!canContinue(cutoff)) return false;
      if (expectedAccountDigest && await readAccountDigest(cutoff) !== expectedAccountDigest) return false;
      if (!canContinue(cutoff)) return false;
      conversationUrl = typeof location === 'object' ? location.href : null;
      try {
        const currentUrl = new URL(conversationUrl);
        if (currentUrl.origin !== expectedOrigin || currentUrl.search || currentUrl.hash) return false;
        const currentScope = currentUrl.origin + currentUrl.pathname.replace(/\\/$/, '');
        return currentScope === expectedConversationUrl &&
          currentUrl.pathname.match(/(?:^|\\/)c\\/([a-zA-Z0-9-]+)(?:\\/)?$/)?.[1] === expectedConversationId &&
          canContinue(cutoff);
      } catch {
        return false;
      }
    };
    const isVisible = (element) => {
      if (!element || !(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const click = (element) => {
      if (!canContinue()) return false;
      const rect = element.getBoundingClientRect();
      const eventInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      };
      if (typeof PointerEvent === 'function') {
        element.dispatchEvent(new PointerEvent('pointerdown', {
          ...eventInit,
          buttons: 1,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
        }));
      }
      element.dispatchEvent(new MouseEvent('mousedown', { ...eventInit, buttons: 1 }));
      if (typeof PointerEvent === 'function') {
        element.dispatchEvent(new PointerEvent('pointerup', {
          ...eventInit,
          buttons: 0,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
        }));
      }
      element.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, buttons: 0 }));
      element.dispatchEvent(new MouseEvent('click', { ...eventInit, buttons: 0 }));
      return true;
    };
    const findConversationMenuButton = () => {
      const buttons = Array.from(document.querySelectorAll('button,[role="button"]'))
        .filter((element) => element instanceof HTMLElement && isVisible(element));
      const labelled = buttons
        .map((element) => ({ element, label: labelFor(element), rect: element.getBoundingClientRect() }))
        .filter(({ label }) =>
          label.includes('more') ||
          label.includes('conversation options') ||
          label.includes('open menu') ||
          label.includes('więcej') ||
          label.includes('opcje')
        );
      const headerCandidates = labelled
        .filter(({ rect }) => rect.top < 180 && rect.right > window.innerWidth - 420)
        .sort((a, b) => b.rect.right - a.rect.right);
      return (headerCandidates[0] ?? labelled[0])?.element ?? null;
    };
	    const visibleMenuCandidates = () => {
	      const menuRoots = Array.from(document.querySelectorAll('[role="menu"]'))
	        .filter((element) => element instanceof HTMLElement && isVisible(element));
	      const roots = menuRoots.length > 0 ? menuRoots : [document];
	      return roots.flatMap((root) =>
	        Array.from(root.querySelectorAll('[role="menuitem"],[role="option"],button,div[tabindex],a')),
	      ).filter((element) => element instanceof HTMLElement && isVisible(element));
	    };
	    const findArchiveMenuItem = () => {
	      const candidates = visibleMenuCandidates();
	      return candidates.find((element) => {
	        const label = labelFor(element);
	        if (!label) return false;
	        if (label.includes('unarchive') || label.includes('restore')) return false;
	        return label.includes('archive') || label.includes('archiwizuj');
	      }) ?? null;
	    };
	    const findArchiveConfirmationButton = () => {
	      const candidates = Array.from(document.querySelectorAll('[role="dialog"] button,[role="dialog"] [role="button"]'))
	        .filter((element) => element instanceof HTMLElement && isVisible(element));
	      return candidates.find((element) => {
	        const label = labelFor(element);
	        if (!label) return false;
	        if (label.includes('unarchive') || label.includes('restore')) return false;
	        return label === 'archive' || label === 'archiwizuj' || label.includes('archive conversation');
	      }) ?? null;
	    };
	    const hasUnarchiveMenuItem = () => {
	      const candidates = visibleMenuCandidates();
	      return candidates.some((element) => {
	        const label = labelFor(element);
	        return (
	          label.includes('unarchive') ||
	          label.includes('restore') ||
	          label.includes('przywróć') ||
	          label.includes('przywroc')
	        );
	      });
	    };
	    const hasArchiveConfirmation = () => {
	      const visibleText = Array.from(document.querySelectorAll('[role="status"],[role="alert"],[data-testid*="toast"],[class*="toast"],[class*="snackbar"]'))
	        .filter((element) => element instanceof HTMLElement && isVisible(element))
	        .map((element) => labelFor(element))
	        .join(' ');
	      return (
	        visibleText.includes('archived') ||
	        visibleText.includes('conversation archived') ||
	        visibleText.includes('chat archived') ||
	        visibleText.includes('zarchiwizowano') ||
	        visibleText.includes('archiwum')
	      );
	    };
    const waitForArchiveConfirmation = async () => {
      while (canContinue(confirmationDeadline)) {
        if (conversationUrl && location.href !== conversationUrl) return true;
        if (hasArchiveConfirmation()) return true;
        await sleep(Math.min(150, Math.max(0, confirmationDeadline - Date.now())));
      }
      return false;
    };
    const verifyArchivedStateFromMenu = async () => {
      if (!canContinue()) return false;
      const menuButton = findConversationMenuButton();
      if (!menuButton || !click(menuButton)) return false;
      const remaining = deadline - Date.now();
      if (!canContinue() || remaining <= 0) return false;
      await sleep(Math.min(300, remaining));
      if (!canContinue()) return false;
      const archived = hasUnarchiveMenuItem();
      if (canContinue()) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
      return archived;
    };
    return (async () => {
      if (!await hasExpectedAffinity()) {
        return { status: 'skipped', reason: 'affinity-mismatch', conversationUrl };
      }
      const menuButton = findConversationMenuButton();
      if (!menuButton || !canContinue(confirmationDeadline)) {
        return { status: 'skipped', reason: 'conversation-menu-not-found', conversationUrl };
      }
      if (!click(menuButton)) {
        return { status: 'skipped', reason: 'archive-not-confirmed', conversationUrl };
      }
      await sleep(350);
      if (!await hasExpectedAffinity()) {
        return { status: 'skipped', reason: 'affinity-mismatch', conversationUrl };
      }
      const archiveItem = findArchiveMenuItem();
      if (!archiveItem) {
        if (canContinue()) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { status: 'skipped', reason: 'archive-menu-item-not-found', conversationUrl };
      }
      if (!canContinue(confirmationDeadline) || !click(archiveItem)) {
        return { status: 'skipped', reason: 'archive-not-confirmed', conversationUrl };
      }
      await sleep(350);
      const confirmButton = findArchiveConfirmationButton();
      if (confirmButton) {
        if (!await hasExpectedAffinity() || !canContinue(confirmationDeadline) || !click(confirmButton)) {
          return { status: 'skipped', reason: 'archive-not-confirmed', conversationUrl };
        }
        await sleep(500);
      }
      if (await waitForArchiveConfirmation()) {
        return { status: 'archived', conversationUrl };
      }
      if (!await hasExpectedAffinity(fallbackAffinityDeadline)) {
        return { status: 'skipped', reason: 'affinity-mismatch', conversationUrl };
      }
      if (await verifyArchivedStateFromMenu()) {
        return { status: 'archived', conversationUrl };
      }
      return { status: 'skipped', reason: 'archive-not-confirmed', conversationUrl };
    })().catch((error) => ({
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      conversationUrl,
    }));
  })()`;
}
