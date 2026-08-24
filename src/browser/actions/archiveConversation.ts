import type {
  BrowserArchiveMode,
  BrowserArchiveResult,
  BrowserLogger,
  BrowserResearchMode,
  ChromeClient,
} from "../types.js";
import { chatGptConversationScopeFromUrl } from "../conversationUrl.js";

export interface BrowserArchiveDecision {
  mode: BrowserArchiveMode;
  shouldArchive: boolean;
  reason: string;
}

export function isProjectChatgptUrl(url?: string | null): boolean {
  try {
    const parsed = new URL(url ?? "");
    return Boolean(
      parsed.origin === "https://chatgpt.com" &&
      /^\/g\/[^/]+\/(?:project|c\/[^/]+)\/?$/i.test(parsed.pathname),
    );
  } catch {
    return false;
  }
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
): { origin: string; conversationId: string; projectKey: string | null } | null {
  const scope = rawUrl ? chatGptConversationScopeFromUrl(rawUrl) : undefined;
  return scope ? { origin: "https://chatgpt.com", ...scope } : null;
}

export async function archiveChatGptConversation(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  {
    mode,
    conversationUrl,
    expectedAccountDigest,
    expectedWorkspaceDigest,
  }: {
    mode: BrowserArchiveMode;
    conversationUrl?: string | null;
    expectedAccountDigest?: string;
    expectedWorkspaceDigest?: string;
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
  const evaluated = await Runtime.evaluate({
    expression: buildArchiveConversationExpression({
      expectedOrigin: affinity.origin,
      expectedConversationId: affinity.conversationId,
      expectedProjectKey: affinity.projectKey,
      expectedAccountDigest,
      expectedWorkspaceDigest,
    }),
    awaitPromise: true,
    returnByValue: true,
  });
  const value = evaluated.result?.value as
    | { status: "archived"; conversationUrl?: string | null }
    | { status: "skipped"; reason: string; conversationUrl?: string | null }
    | { status: "failed"; error: string; conversationUrl?: string | null }
    | undefined;
  const reason = value?.status === "skipped" ? value.reason : "archive-failed";
  const error = value?.status === "failed" ? value.error : undefined;
  const resolvedUrl =
    reason === "affinity-mismatch"
      ? (conversationUrl ?? undefined)
      : (value?.conversationUrl ?? conversationUrl ?? undefined);
  if (value?.status === "archived") {
    logger("[browser] Archived ChatGPT conversation after saving local artifacts.");
    return { mode, attempted: true, archived: true, conversationUrl: resolvedUrl };
  }
  logger(`[browser] ChatGPT archive skipped (${error ?? reason}).`);
  return {
    mode,
    attempted: reason !== "affinity-mismatch",
    archived: false,
    reason,
    conversationUrl: resolvedUrl,
    error,
  };
}

export function buildArchiveConversationExpressionForTest(options?: {
  expectedOrigin?: string;
  expectedRoute?: string;
  expectedConversationId?: string;
  expectedAccountDigest?: string;
  expectedWorkspaceDigest?: string;
}): string {
  const route = options?.expectedRoute ?? `/c/${options?.expectedConversationId ?? "abc"}`;
  const affinity = resolveArchiveConversationAffinity(`https://chatgpt.com${route}`);
  if (!affinity) throw new Error("Test archive route is invalid.");
  return buildArchiveConversationExpression({
    expectedOrigin: options?.expectedOrigin ?? affinity.origin,
    expectedConversationId: affinity.conversationId,
    expectedProjectKey: affinity.projectKey,
    expectedAccountDigest: options?.expectedAccountDigest,
    expectedWorkspaceDigest: options?.expectedWorkspaceDigest,
  });
}

function buildArchiveConversationExpression({
  expectedOrigin,
  expectedConversationId,
  expectedProjectKey,
  expectedAccountDigest,
  expectedWorkspaceDigest,
}: {
  expectedOrigin: string;
  expectedConversationId: string;
  expectedProjectKey: string | null;
  expectedAccountDigest?: string;
  expectedWorkspaceDigest?: string;
}): string {
  return `(() => {
    const expectedOrigin = ${JSON.stringify(expectedOrigin)};
    const expectedConversationId = ${JSON.stringify(expectedConversationId)};
    const expectedProjectKey = ${JSON.stringify(expectedProjectKey)};
    const expectedAccountDigest = ${JSON.stringify(expectedAccountDigest ?? null)};
    const expectedWorkspaceDigest = ${JSON.stringify(expectedWorkspaceDigest ?? null)};
    const conversationUrl = typeof location === 'object' ? location.href : null;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const normalize = (value) =>
      String(value ?? '')
        .replace(/\\s+/g, ' ')
        .trim()
        .toLowerCase();
    const digest = async (value) => {
      if (typeof value !== 'string' || !value.trim() || !globalThis.crypto?.subtle) return null;
      const bytes = new Uint8Array(await crypto.subtle.digest(
        'SHA-256', new TextEncoder().encode(value.trim()),
      ));
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    const readIdentityDigests = async () => {
      if (!expectedAccountDigest && !expectedWorkspaceDigest) {
        return { accountDigest: null, workspaceDigest: null };
      }
      try {
        const response = await fetch('/api/auth/session', {
          cache: 'no-store', credentials: 'include',
        });
        if (!response.ok) return null;
        const body = await response.json();
        return {
          accountDigest: await digest(body?.user?.id),
          workspaceDigest: await digest(body?.account?.id),
        };
      } catch {
        return null;
      }
    };
    // Runtime.evaluate cannot import conversationUrl.ts. Keep this parser broad for conservative
    // sidebar exclusion; only immutable canonical expected values cross the boundary.
    const stableProjectKey = (value) => {
      if (typeof value !== 'string' || !value) return null;
      return (value.match(/^(g-p-[0-9a-f]{32})(?=-|$)/i)?.[1] || value).toLowerCase();
    };
    const projectConversationPath = new RegExp('^/g/([^/?#]+)/c/([^/?#]+)/?$');
    const rootConversationPath = new RegExp('^/c/([^/?#]+)/?$');
    const parseTrustedCurrentUrl = () => {
      const currentConversationUrl = typeof location === 'object' ? location.href : null;
      try {
        const currentUrl = new URL(currentConversationUrl);
        if (
          currentUrl.origin !== expectedOrigin ||
          currentUrl.username ||
          currentUrl.password ||
          currentUrl.pathname.includes('%') ||
          currentUrl.search ||
          currentUrl.hash
        ) return null;
        return currentUrl;
      } catch {
        return null;
      }
    };
    const matchesExpectedIdentity = (identity) =>
      Boolean(
        identity &&
        (!expectedAccountDigest || identity.accountDigest === expectedAccountDigest) &&
        (!expectedWorkspaceDigest || identity.workspaceDigest === expectedWorkspaceDigest),
      );
    const parseConversationPath = (pathname) => {
      const project = projectConversationPath.exec(pathname);
      const root = rootConversationPath.exec(pathname);
      if (project?.[1] && project[2]) {
        return { conversationId: project[2], projectKey: stableProjectKey(project[1]) };
      }
      return root?.[1] ? { conversationId: root[1], projectKey: null } : null;
    };
    const hasExpectedAffinity = async () => {
      if (!matchesExpectedIdentity(await readIdentityDigests())) return false;
      const currentUrl = parseTrustedCurrentUrl();
      const route = currentUrl ? parseConversationPath(currentUrl.pathname) : null;
      return Boolean(
        route &&
        route.conversationId === expectedConversationId &&
        route.projectKey === expectedProjectKey,
      );
    };
    const isExpectedArchiveRedirectRoute = () => {
      const currentUrl = parseTrustedCurrentUrl();
      if (!currentUrl) return false;
      if (expectedProjectKey === null) return currentUrl.pathname === '/';
      const project = new RegExp('^/g/([^/?#]+)/project/?$').exec(currentUrl.pathname);
      return Boolean(project?.[1] && stableProjectKey(project[1]) === expectedProjectKey);
    };
    const hasExpectedArchiveRedirect = async () =>
      isExpectedArchiveRedirectRoute() &&
      matchesExpectedIdentity(await readIdentityDigests());
    const isVisible = (element) => {
      if (!element || !(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity || '1') > 0.01 &&
        style.pointerEvents !== 'none'
      );
    };
    const labelFor = (element) =>
      normalize([
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('title'),
        element.textContent,
      ].filter(Boolean).join(' '));
    const belongsToOtherConversation = (element) => {
      let current = element;
      while (current && current !== document.body) {
        const tag = String(current.tagName || '').toLowerCase();
        const marker = normalize([
          current.getAttribute?.('aria-label'),
          current.getAttribute?.('data-testid'),
          current.getAttribute?.('class'),
        ].filter(Boolean).join(' '));
        if (
          tag === 'nav' ||
          tag === 'aside' ||
          /sidebar|history|conversation[-_ ]list|thread[-_ ]list/.test(marker)
        ) return true;
        const href = current.getAttribute?.('href');
        if (href) {
          try {
            const linked = new URL(href, location.href);
            const linkedRoute = parseConversationPath(linked.pathname);
            if (
              linkedRoute?.conversationId &&
              (linked.origin !== expectedOrigin ||
                linkedRoute.conversationId !== expectedConversationId ||
                linkedRoute.projectKey !== expectedProjectKey)
            ) return true;
          } catch {}
        }
        current = current.parentElement;
      }
      return false;
    };
    const click = (element) => {
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
    };
    const findConversationMenuButton = () => {
      const headerCandidates = Array.from(document.querySelectorAll('button,[role="button"]'))
        .filter((element) => element instanceof HTMLElement && isVisible(element))
        .map((element) => ({ element, label: labelFor(element), rect: element.getBoundingClientRect() }))
        .filter(({ element, label, rect }) =>
          !belongsToOtherConversation(element) &&
          rect.top < 180 &&
          rect.right > window.innerWidth - 420 &&
          (
            label.includes('more') ||
            label.includes('conversation options') ||
            label.includes('open menu') ||
            label.includes('więcej') ||
            label.includes('opcje')
          )
        );
      return headerCandidates.length === 1 ? headerCandidates[0].element : null;
    };
    const visibleMenuRoots = () =>
      Array.from(document.querySelectorAll('[role="menu"],[role="listbox"]'))
        .filter((element) => element instanceof HTMLElement && isVisible(element));
    const visibleDialogRoots = () =>
      Array.from(document.querySelectorAll('[role="dialog"]'))
        .filter((element) => element instanceof HTMLElement && isVisible(element));
    const resolveOwnedMenuRoot = (button, beforeRoots) => {
      const controlledRoots = String(button.getAttribute?.('aria-controls') || '')
        .split(/\\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id))
        .filter((element) => element instanceof HTMLElement && isVisible(element));
      if (controlledRoots.length === 1) return controlledRoots[0];
      const openedRoots = visibleMenuRoots().filter((root) => !beforeRoots.includes(root));
      return openedRoots.length === 1 ? openedRoots[0] : null;
    };
    const visibleMenuCandidates = (root) =>
      Array.from(root.querySelectorAll('[role="menuitem"],[role="option"],button,div[tabindex],a'))
        .filter((element) => element instanceof HTMLElement && isVisible(element));
    const findArchiveMenuItem = (root) =>
      visibleMenuCandidates(root).find((element) => {
        const label = labelFor(element);
        if (!label || label.includes('unarchive') || label.includes('restore')) return false;
        return label.includes('archive') || label.includes('archiwizuj');
      }) ?? null;
    const findArchiveConfirmationButton = (beforeDialogs) => {
      const openedDialogs = visibleDialogRoots().filter((dialog) => !beforeDialogs.includes(dialog));
      if (openedDialogs.length !== 1) return null;
      const candidates = Array.from(openedDialogs[0].querySelectorAll('button,[role="button"]'))
        .filter((element) => element instanceof HTMLElement && isVisible(element));
      return candidates.find((element) => {
        const label = labelFor(element);
        if (!label) return false;
        if (label.includes('unarchive') || label.includes('restore')) return false;
        return label === 'archive' || label === 'archiwizuj' || label.includes('archive conversation');
      }) ?? null;
    };
    const hasUnarchiveMenuItem = (root) =>
      visibleMenuCandidates(root).some((element) => {
        const label = labelFor(element);
        return (
          label.includes('unarchive') ||
          label.includes('restore') ||
          label.includes('przywróć') ||
          label.includes('przywroc')
        );
      });
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
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (conversationUrl && location.href !== conversationUrl) {
          if (await hasExpectedArchiveRedirect()) return true;
          if (!(await hasExpectedAffinity())) return false;
        }
        if (hasArchiveConfirmation()) return true;
        await sleep(150);
      }
      return false;
    };
    const verifyArchivedStateFromMenu = async () => {
      const menuButton = findConversationMenuButton();
      if (!menuButton) return false;
      const beforeRoots = visibleMenuRoots();
      click(menuButton);
      await sleep(300);
      const menuRoot = resolveOwnedMenuRoot(menuButton, beforeRoots);
      const archived = Boolean(menuRoot && hasUnarchiveMenuItem(menuRoot));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return archived;
    };
    return (async () => {
      if (!await hasExpectedAffinity()) {
        return { status: 'skipped', reason: 'affinity-mismatch', conversationUrl };
      }
      const menuButton = findConversationMenuButton();
      if (!menuButton) {
        return { status: 'skipped', reason: 'conversation-menu-not-found', conversationUrl };
      }
      const beforeRoots = visibleMenuRoots();
      click(menuButton);
      await sleep(350);
      if (!await hasExpectedAffinity()) {
        return { status: 'skipped', reason: 'affinity-mismatch', conversationUrl };
      }
      const menuRoot = resolveOwnedMenuRoot(menuButton, beforeRoots);
      if (!menuRoot) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { status: 'skipped', reason: 'conversation-menu-not-owned', conversationUrl };
      }
      const archiveItem = findArchiveMenuItem(menuRoot);
      if (!archiveItem) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { status: 'skipped', reason: 'archive-menu-item-not-found', conversationUrl };
      }
      const beforeDialogs = visibleDialogRoots();
      click(archiveItem);
      await sleep(350);
      const confirmButton = findArchiveConfirmationButton(beforeDialogs);
      if (confirmButton) {
        if (!await hasExpectedAffinity()) {
          return { status: 'skipped', reason: 'affinity-mismatch', conversationUrl };
        }
        click(confirmButton);
        await sleep(500);
      }
      if (await waitForArchiveConfirmation()) {
        return { status: 'archived', conversationUrl };
      }
      if (!await hasExpectedAffinity()) {
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
