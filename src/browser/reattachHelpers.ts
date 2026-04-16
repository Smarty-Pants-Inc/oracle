import type { BrowserLogger, ChromeClient } from "./types.js";
import { CONVERSATION_TURN_SELECTOR } from "./constants.js";
import { delay } from "./utils.js";
import { readAssistantSnapshot } from "./pageActions.js";
import { buildThreadIntrospectionHelpers } from "./threadIntrospection.js";

export type TargetInfoLite = {
  targetId?: string;
  id?: string;
  type?: string;
  url?: string;
  [key: string]: unknown;
};

function getTargetId(target: TargetInfoLite | undefined): string | undefined {
  const targetId = target?.targetId;
  if (typeof targetId === "string" && targetId.length > 0) {
    return targetId;
  }
  const legacyId = target?.id;
  return typeof legacyId === "string" && legacyId.length > 0 ? legacyId : undefined;
}

function isPageTarget(target: TargetInfoLite | undefined): boolean {
  return target?.type === "page";
}

export function isAttachableChatTarget(target: TargetInfoLite | undefined): boolean {
  if (!target) {
    return false;
  }
  if (isPageTarget(target)) {
    const url = target.url || "";
    return (
      isConversationShellTargetUrl(url) ||
      isProjectConversationTargetUrl(url) ||
      Boolean(extractConversationIdFromUrl(url))
    );
  }
  const url = target.url || "";
  if (isProjectConversationTargetUrl(url)) {
    return false;
  }
  return Boolean(extractConversationIdFromUrl(url) || isConversationShellTargetUrl(url));
}

function isChatLikeTargetUrl(url: string | undefined): boolean {
  if (!url || url === "about:blank") {
    return false;
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === "chatgpt.com" || host === "chat.openai.com";
  } catch {
    return false;
  }
}

function isConversationShellTargetUrl(url: string | undefined): boolean {
  if (!isChatLikeTargetUrl(url) || extractConversationIdFromUrl(url || "")) {
    return false;
  }
  try {
    const parsed = new URL(url ?? "");
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return pathname === "" || pathname === "/" || /^\/g\/[^/]+\/project$/i.test(pathname);
  } catch {
    return false;
  }
}

function projectConversationShellUrl(url: string | undefined): string | null {
  if (!isChatLikeTargetUrl(url)) {
    return null;
  }
  try {
    const parsed = new URL(url ?? "");
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const match = pathname.match(/^(\/g\/[^/]+\/project)\/c\/[^/]+$/i);
    if (!match) {
      return null;
    }
    return `${parsed.origin}${match[1]}`;
  } catch {
    return null;
  }
}

function isProjectConversationTargetUrl(url: string | undefined): boolean {
  if (!isChatLikeTargetUrl(url)) {
    return false;
  }
  try {
    const parsed = new URL(url ?? "");
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return /^\/g\/[^/]+(?:\/project)?\/c\/[a-zA-Z0-9-]+$/i.test(pathname);
  } catch {
    return /^https:\/\/chatgpt\.com\/g\/[^/]+(?:\/project)?\/c\/[a-zA-Z0-9-]+\/?$/i.test(url ?? "");
  }
}

function normalizedComparableHref(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function urlsExactlyMatchRuntimeTab(candidateUrl: string | undefined, runtimeUrl: string): boolean {
  const candidateHref = normalizedComparableHref(candidateUrl);
  const runtimeHref = normalizedComparableHref(runtimeUrl);
  return Boolean(candidateHref && runtimeHref && candidateHref === runtimeHref);
}

function urlsLooselyMatchRuntimeTab(candidateUrl: string | undefined, runtimeUrl: string): boolean {
  if (!candidateUrl || !runtimeUrl) {
    return false;
  }
  try {
    const candidate = new URL(candidateUrl);
    const runtime = new URL(runtimeUrl);
    if (candidate.origin !== runtime.origin) {
      return false;
    }
    candidate.search = "";
    candidate.hash = "";
    runtime.search = "";
    runtime.hash = "";
    const candidateHref = candidate.toString().replace(/\/+$/, "");
    const runtimeHref = runtime.toString().replace(/\/+$/, "");
    const candidatePath = candidate.pathname.replace(/\/+$/, "");
    const runtimePath = runtime.pathname.replace(/\/+$/, "");
    if (!candidatePath || candidatePath === "/") {
      return false;
    }
    return candidateHref === runtimeHref || candidatePath === runtimePath;
  } catch {
    return false;
  }
}

function projectScopeKey(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const match = pathname.match(
      /^\/g\/([^/]+)(?:\/project(?:\/c\/[a-zA-Z0-9-]+)?|\/c\/[a-zA-Z0-9-]+)$/i,
    );
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function normalizeProjectFamilyKey(value: string | null): string | null {
  return value ? value.replace(/-oracle$/i, "") : null;
}

function projectScopeFamilyKey(url: string | undefined): string | null {
  return normalizeProjectFamilyKey(projectScopeKey(url));
}

function projectConversationScopeKey(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const match = pathname.match(/^\/g\/([^/]+)(?:\/project)?\/c\/[a-zA-Z0-9-]+$/i);
    return normalizeProjectFamilyKey(match?.[1]?.toLowerCase() ?? null);
  } catch {
    return null;
  }
}

function urlsShareProjectConversationScope(
  candidateUrl: string | undefined,
  runtimeUrl: string | undefined,
): boolean {
  const candidateKey = projectConversationScopeKey(candidateUrl);
  const runtimeKey = projectConversationScopeKey(runtimeUrl);
  return Boolean(candidateKey && runtimeKey && candidateKey === runtimeKey);
}

function pickUniqueConversationShellTarget(
  targets: TargetInfoLite[],
  runtimeProjectFamilyKey?: string | null,
): TargetInfoLite | undefined {
  const shells = targets.filter(
    (target) =>
      isAttachableChatTarget(target) &&
      isConversationShellTargetUrl(target.url) &&
      (!runtimeProjectFamilyKey || projectScopeFamilyKey(target.url) === runtimeProjectFamilyKey),
  );
  const distinctShellUrls = new Set(
    shells
      .map((target) => target.url?.replace(/\/+$/, ""))
      .filter((value): value is string => Boolean(value)),
  );
  return distinctShellUrls.size === 1 ? shells[0] : undefined;
}

function hasProjectConversationShadowTarget(
  targets: TargetInfoLite[],
  conversationId: string,
): boolean {
  return targets.some(
    (target) =>
      !isPageTarget(target) &&
      isProjectConversationTargetUrl(target.url) &&
      extractConversationIdFromUrl(target.url || "") === conversationId,
  );
}

function pickSafeFallbackTarget(targets: TargetInfoLite[]): TargetInfoLite | undefined {
  const attachableTargets = targets.filter(isAttachableChatTarget);
  if (attachableTargets.length === 1) {
    return attachableTargets[0];
  }
  const conversationTargets = attachableTargets.filter((target) =>
    Boolean(extractConversationIdFromUrl(target.url || "")),
  );
  if (conversationTargets.length === 1) {
    return conversationTargets[0];
  }
  const chatTargets = attachableTargets.filter((target) => isChatLikeTargetUrl(target.url));
  if (chatTargets.length === 1) {
    return chatTargets[0];
  }
  return undefined;
}

export type AssistantPayload = {
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
};

type PromptEchoMatcher = { isEcho: (text: string) => boolean };

export function runtimeRequiresSpecificTarget(runtime: {
  chromeTargetId?: string;
  tabUrl?: string;
  conversationId?: string;
}): boolean {
  return Boolean(runtime.chromeTargetId || runtime.tabUrl || getRuntimeConversationId(runtime));
}

export function runtimeHasReusableIdentity(runtime: {
  chromeTargetId?: string;
  tabUrl?: string;
  conversationId?: string;
}): boolean {
  return runtimeRequiresSpecificTarget(runtime);
}

export function getRuntimeConversationId(runtime: {
  tabUrl?: string;
  conversationId?: string;
}): string | undefined {
  const explicitConversationId = runtime.conversationId?.trim();
  if (explicitConversationId) {
    return explicitConversationId;
  }
  return extractConversationIdFromUrl(runtime.tabUrl || "");
}

export function pickTarget(
  targets: TargetInfoLite[],
  runtime: { chromeTargetId?: string; tabUrl?: string; conversationId?: string },
  options?: {
    requireMatch?: boolean;
    allowProjectScopeRecovery?: boolean;
    allowUniqueProjectShellFallback?: boolean;
  },
): TargetInfoLite | undefined {
  if (!Array.isArray(targets) || targets.length === 0) {
    return undefined;
  }
  const attachableTargets = targets.filter(isAttachableChatTarget);
  const runtimeConversationId = getRuntimeConversationId(runtime);
  const runtimeProjectScope = projectScopeKey(runtime.tabUrl);
  const runtimeProjectFamily = normalizeProjectFamilyKey(runtimeProjectScope);
  if (runtimeConversationId) {
    const projectConversationTargets = targets.filter((target) => {
      if (!isProjectConversationTargetUrl(target.url)) {
        return false;
      }
      if (extractConversationIdFromUrl(target.url || "") !== runtimeConversationId) {
        return false;
      }
      return !runtimeProjectScope || projectScopeKey(target.url) === runtimeProjectScope;
    });
    const projectConversationTarget =
      projectConversationTargets.length === 1 ? projectConversationTargets[0] : undefined;
    if (projectConversationTarget) {
      const preferredProjectShellUrl = projectConversationShellUrl(projectConversationTarget.url);
      if (preferredProjectShellUrl) {
        const projectShellTarget = attachableTargets.find((target) => {
          if (!isPageTarget(target)) {
            return false;
          }
          const candidateUrl = target.url?.replace(/\/+$/, "");
          return candidateUrl === preferredProjectShellUrl;
        });
        if (projectShellTarget) {
          return projectShellTarget;
        }
      }
    }
  }
  if (runtime.chromeTargetId) {
    const byId = attachableTargets.find((t) => getTargetId(t) === runtime.chromeTargetId);
    const runtimeProjectShellUrl = projectConversationShellUrl(runtime.tabUrl);
    const candidateUrl = byId?.url?.replace(/\/+$/, "");
    const candidateConversationId = extractConversationIdFromUrl(byId?.url || "");
    const candidateProjectScope = projectScopeKey(byId?.url);
    const conversationIdMatches =
      candidateConversationId === runtimeConversationId &&
      (!runtimeProjectScope ||
        Boolean(candidateProjectScope && candidateProjectScope === runtimeProjectScope));
    if (
      byId &&
      (runtimeConversationId
        ? conversationIdMatches ||
          Boolean(
            runtimeProjectShellUrl &&
            candidateUrl &&
            candidateUrl === runtimeProjectShellUrl.replace(/\/+$/, ""),
          )
        : !runtime.tabUrl ||
          urlsExactlyMatchRuntimeTab(byId.url, runtime.tabUrl) ||
          urlsLooselyMatchRuntimeTab(byId.url, runtime.tabUrl) ||
          urlsShareProjectConversationScope(byId.url, runtime.tabUrl))
    ) {
      return byId;
    }
  }
  if (runtimeConversationId) {
    const conversationMatches = attachableTargets.filter((t) => {
      if (extractConversationIdFromUrl(t.url || "") !== runtimeConversationId) {
        return false;
      }
      return !runtimeProjectScope || projectScopeKey(t.url) === runtimeProjectScope;
    });
    const byConversation = conversationMatches.length === 1 ? conversationMatches[0] : undefined;
    if (byConversation) {
      if (!isPageTarget(byConversation)) {
        const preferredProjectShellUrl = projectConversationShellUrl(byConversation.url);
        if (preferredProjectShellUrl) {
          const projectShellTarget = attachableTargets.find((target) => {
            if (!isPageTarget(target)) {
              return false;
            }
            const candidateUrl = target.url?.replace(/\/+$/, "");
            return candidateUrl === preferredProjectShellUrl;
          });
          if (projectShellTarget) {
            return projectShellTarget;
          }
        }
      }
      return byConversation;
    }
  }
  if (runtime.tabUrl) {
    const exactUrlMatches = attachableTargets.filter((target) =>
      urlsExactlyMatchRuntimeTab(target.url, runtime.tabUrl as string),
    );
    if (exactUrlMatches.length === 1) {
      return exactUrlMatches[0];
    }
    if (exactUrlMatches.length > 1) {
      return undefined;
    }
    const byUrl = attachableTargets.find((t) =>
      urlsLooselyMatchRuntimeTab(t.url, runtime.tabUrl as string),
    );
    if (byUrl) return byUrl;
    const allowProjectScopeRecovery = Boolean(
      runtimeConversationId && options?.allowProjectScopeRecovery,
    );
    if (!runtimeConversationId || allowProjectScopeRecovery) {
      const matchingProjectTargets = attachableTargets.filter((target) =>
        urlsShareProjectConversationScope(target.url, runtime.tabUrl),
      );
      const scopedCandidates = allowProjectScopeRecovery
        ? matchingProjectTargets.filter((target) => isPageTarget(target))
        : matchingProjectTargets;
      if (scopedCandidates.length === 1) {
        return scopedCandidates[0];
      }
    }
  }
  if (runtimeConversationId) {
    const shellTarget = pickUniqueConversationShellTarget(attachableTargets, runtimeProjectFamily);
    const uniqueShellFallback =
      shellTarget &&
      options?.allowUniqueProjectShellFallback !== false &&
      runtimeProjectFamily &&
      attachableTargets.filter((target) => isConversationShellTargetUrl(target.url)).length === 1 &&
      projectScopeFamilyKey(shellTarget.url) === runtimeProjectFamily &&
      !hasProjectConversationShadowTarget(targets, runtimeConversationId);
    if (
      shellTarget &&
      (!runtimeProjectScope ||
        projectScopeKey(shellTarget.url) === runtimeProjectScope ||
        uniqueShellFallback)
    ) {
      return shellTarget;
    }
  }
  if (options?.requireMatch || runtimeRequiresSpecificTarget(runtime)) {
    return undefined;
  }
  return pickSafeFallbackTarget(targets);
}

export function extractConversationIdFromUrl(url: string): string | undefined {
  if (!url) return undefined;
  const match = url.match(/\/c\/([a-zA-Z0-9-]+)/);
  return match?.[1];
}

function normalizeProjectBaseUrl(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (/^\/g\/[^/]+\/project$/i.test(pathname)) {
      return `${parsed.origin}${pathname}`;
    }
  } catch {
    const trimmed = baseUrl.replace(/\/+$/, "");
    if (/^https:\/\/chatgpt\.com\/g\/[^/]+\/project$/i.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

export function conversationHrefMatchesConfiguredScope(href: string, baseUrl: string): boolean {
  const projectBaseUrl = normalizeProjectBaseUrl(baseUrl);
  if (!projectBaseUrl) {
    if (!isConversationShellTargetUrl(baseUrl)) {
      return false;
    }
    return (
      isConversationShellTargetUrl(href) ||
      isProjectConversationTargetUrl(href) ||
      Boolean(extractConversationIdFromUrl(href))
    );
  }
  try {
    const base = new URL(projectBaseUrl);
    const target = new URL(href);
    if (target.origin !== base.origin) {
      return false;
    }
    const normalizedBasePath = base.pathname.replace(/\/+$/, "");
    const normalizedTargetPath = target.pathname.replace(/\/+$/, "");
    if (
      normalizedTargetPath === normalizedBasePath ||
      normalizedTargetPath.startsWith(`${normalizedBasePath}/`)
    ) {
      return true;
    }
    const projectMatch = normalizedBasePath.match(/^\/g\/([^/]+)\/project$/i);
    if (!projectMatch?.[1]) {
      return false;
    }
    const configuredProjectId = projectMatch[1];
    const targetProjectMatch = normalizedTargetPath.match(
      /^\/g\/([^/]+)(?:\/project(?:\/c\/[a-zA-Z0-9-]+)?|\/c\/[a-zA-Z0-9-]+)$/i,
    );
    const targetProjectId = targetProjectMatch?.[1];
    if (!targetProjectId) {
      return false;
    }
    if (/-oracle$/i.test(configuredProjectId)) {
      return targetProjectId.toLowerCase() === configuredProjectId.toLowerCase();
    }
    return (
      normalizeProjectFamilyKey(targetProjectId) === normalizeProjectFamilyKey(configuredProjectId)
    );
  } catch {
    const trimmedHref = href.replace(/\/+$/, "");
    return trimmedHref === projectBaseUrl || trimmedHref.startsWith(`${projectBaseUrl}/`);
  }
}

export function buildConversationUrl(
  runtime: { tabUrl?: string; conversationId?: string },
  baseUrl: string,
): string | null {
  const conversationId =
    runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? "");
  const canonicalConversationUrl = (() => {
    if (!conversationId) {
      return null;
    }
    try {
      const base = new URL(baseUrl);
      const pathRoot = base.pathname.replace(/\/+$/, "").replace(/\/c\/[a-zA-Z0-9-]+$/i, "");
      const prefix = pathRoot === "/" ? "" : pathRoot;
      return `${base.origin}${prefix}/c/${conversationId}`;
    } catch {
      return null;
    }
  })();
  if (runtime.tabUrl) {
    if (runtime.tabUrl.includes("/c/")) {
      return conversationHrefMatchesConfiguredScope(runtime.tabUrl, baseUrl)
        ? runtime.tabUrl
        : canonicalConversationUrl;
    }
    return null;
  }
  if (!conversationId) {
    return null;
  }
  return canonicalConversationUrl;
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

async function evaluateWithTimeout(
  Runtime: ChromeClient["Runtime"],
  expression: string,
  timeoutMs: number,
  label: string,
): Promise<{ result?: { value?: unknown } }> {
  return await withTimeout(Runtime.evaluate({ expression, returnByValue: true }), timeoutMs, label);
}

export async function openConversationFromSidebar(
  Runtime: ChromeClient["Runtime"],
  options: { conversationId?: string; preferProjects?: boolean; promptPreview?: string },
  attempt = 0,
): Promise<boolean> {
  const response = await evaluateWithTimeout(
    Runtime,
    `(() => {
      const conversationId = ${JSON.stringify(options.conversationId ?? null)};
      const allowLooseFallback = !conversationId;
      const preferProjects = ${JSON.stringify(Boolean(options.preferProjects))};
      const promptPreview = ${JSON.stringify(options.promptPreview ?? null)};
      const attemptIndex = ${Math.max(0, attempt)};
      const promptNeedleFull = promptPreview ? promptPreview.trim().toLowerCase().slice(0, 100) : '';
      const promptNeedleShort = promptNeedleFull.replace(/\\s*\\d{4,}\\s*$/, '').trim();
      const promptNeedles = Array.from(new Set([promptNeedleFull, promptNeedleShort].filter(Boolean)));
      const nav = document.querySelector('nav') || document.querySelector('aside') || document.body;
      if (preferProjects) {
        const projectLink = Array.from(nav.querySelectorAll('a,button'))
          .find((el) => (el.textContent || '').trim().toLowerCase() === 'projects');
        if (projectLink) {
          projectLink.click();
        }
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
      const toCandidate = (el) => {
        const clickable = el.closest('a,button,[role="link"],[role="button"]') || el;
        const rawText = (el.textContent || clickable.textContent || '').trim();
        return {
          el,
          clickable,
          href: getHref(clickable) || getHref(el),
          conversationId:
            clickable.getAttribute('data-conversation-id') ||
            el.getAttribute('data-conversation-id') ||
            clickable.dataset?.conversationId ||
            el.dataset?.conversationId ||
            '',
          testId: clickable.getAttribute('data-testid') || el.getAttribute('data-testid') || '',
          text: rawText.replace(/\\s+/g, ' ').slice(0, 400),
          inNav: Boolean(clickable.closest('nav,aside')),
        };
      };
      const candidates = allElements.map(toCandidate);
      const mainCandidates = candidates.filter((item) => !item.inNav);
      const navCandidates = candidates.filter((item) => item.inNav);
      const visible = (item) => {
        const rect = item.clickable.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const pick = (items) => (items.find(visible) || items[0] || null);
      const pickWithAttempt = (items) => {
        if (!items.length) return null;
        const visibleItems = items.filter(visible);
        const pool = visibleItems.length > 0 ? visibleItems : items;
        const index = Math.min(attemptIndex, pool.length - 1);
        return pool[index] ?? null;
      };
      const pickByPreference = (navItems, mainItems) =>
        preferProjects ? pick(navItems) || pick(mainItems) : pick(mainItems) || pick(navItems);
      const pickByAttemptPreference = (navItems, mainItems) =>
        preferProjects
          ? pickWithAttempt(navItems) || pickWithAttempt(mainItems)
          : pickWithAttempt(mainItems) || pickWithAttempt(navItems);
      let target = null;
      if (conversationId) {
        const byId = (item) =>
          (item.href && item.href.includes('/c/' + conversationId)) ||
          (item.conversationId && item.conversationId === conversationId);
        target = pickByPreference(navCandidates.filter(byId), mainCandidates.filter(byId));
      }
      if (!target && allowLooseFallback && promptNeedles.length > 0) {
        const byPrompt = (item) => promptNeedles.some((needle) => item.text && item.text.toLowerCase().includes(needle));
        const sortBySpecificity = (items) =>
          items
            .filter(byPrompt)
            .sort((a, b) => (a.text?.length ?? 0) - (b.text?.length ?? 0));
        target = pickByAttemptPreference(
          sortBySpecificity(navCandidates),
          sortBySpecificity(mainCandidates),
        );
      }
      if (!target && allowLooseFallback) {
        const byHref = (item) => item.href && item.href.includes('/c/');
        target = pickByAttemptPreference(
          navCandidates.filter(byHref),
          mainCandidates.filter(byHref),
        );
      }
      if (!target && allowLooseFallback) {
        const byTestId = (item) => /conversation|history/i.test(item.testId || '');
        target = pickByAttemptPreference(
          navCandidates.filter(byTestId),
          mainCandidates.filter(byTestId),
        );
      }
      if (target) {
        target.clickable.scrollIntoView({ block: 'center' });
        target.clickable.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
        );
        // Fallback: some project-sidebar items don't navigate on click, force the URL.
        if (target.href && target.href.includes('/c/')) {
          const targetUrl = target.href.startsWith('http')
            ? target.href
            : new URL(target.href, location.origin).toString();
          if (targetUrl && targetUrl !== location.href) {
            location.href = targetUrl;
          }
        }
        return {
          ok: true,
          href: target.href || '',
          count: candidates.length,
          scope: target.inNav ? 'nav' : 'main',
        };
      }
      return { ok: false, count: candidates.length };
    })()`,
    5_000,
    "Timed out while reopening the ChatGPT conversation from the sidebar",
  );
  const value = response.result?.value as { ok?: boolean } | undefined;
  return Boolean(value?.ok);
}

export async function openConversationFromSidebarWithRetry(
  Runtime: ChromeClient["Runtime"],
  options: { conversationId?: string; preferProjects?: boolean; promptPreview?: string },
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    // Retry because project list can hydrate after initial navigation.
    const opened = await openConversationFromSidebar(Runtime, options, attempt);
    if (opened) {
      // A known conversation id is enough to reopen the existing thread.
      // The current follow-up prompt has not been submitted yet, so waiting
      // for its preview here would deadlock the reopen path.
      if (options.promptPreview && !options.conversationId) {
        const matched = await waitForPromptPreview(Runtime, options.promptPreview, 10_000);
        if (matched) {
          return true;
        }
      } else {
        return true;
      }
    }
    attempt += 1;
    await delay(attempt < 5 ? 250 : 500);
  }
  return false;
}

export async function waitForPromptPreview(
  Runtime: ChromeClient["Runtime"],
  promptPreview: string,
  timeoutMs: number,
): Promise<boolean> {
  const needleFull = promptPreview.trim().toLowerCase().slice(0, 120);
  const needleShort = needleFull.replace(/\\s*\\d{4,}\\s*$/, "").trim();
  const needles = Array.from(new Set([needleFull, needleShort].filter(Boolean)));
  if (needles.length === 0) return false;
  const selectorLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const expression = `(() => {
    const needles = ${JSON.stringify(needles)};
    const root =
      document.querySelector('section[data-testid="screen-threadFlyOut"]') ||
      document.querySelector('[data-testid="chat-thread"]') ||
      document.querySelector('main') ||
      document.querySelector('[role="main"]');
    if (!root) return false;
    const userTurns = Array.from(root.querySelectorAll('[data-message-author-role="user"], [data-turn="user"]'));
    const collectText = (nodes) =>
      nodes
        .map((node) => (node.innerText || node.textContent || ''))
        .join(' ')
        .toLowerCase();
    let text = collectText(userTurns);
    let hasTurns = userTurns.length > 0;
    if (!text) {
      const turns = Array.from(root.querySelectorAll(${selectorLiteral}));
      hasTurns = hasTurns || turns.length > 0;
      text = collectText(turns);
    }
    if (!text) {
      text = (root.innerText || root.textContent || '').toLowerCase();
    }
    return needles.some((needle) => text.includes(needle));
  })()`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const remainingMs = timeoutMs - (Date.now() - start);
      const { result } = await evaluateWithTimeout(
        Runtime,
        expression,
        Math.min(5_000, Math.max(1_000, remainingMs)),
        "Timed out while checking the follow-up prompt preview",
      );
      if (result?.value === true) {
        return true;
      }
    } catch {
      // ignore
    }
    await delay(300);
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
    const remainingMs = timeoutMs - (Date.now() - start);
    const { result } = await withTimeout(
      Runtime.evaluate({ expression: "location.href", returnByValue: true }),
      Math.min(5_000, Math.max(1_000, remainingMs)),
      "Timed out waiting for location change",
    );
    const href = typeof result?.value === "string" ? result.value : "";
    if (lastHref && href !== lastHref) {
      return;
    }
    lastHref = href;
    await delay(200);
  }
}

export async function waitForConversationLocation(
  Runtime: ChromeClient["Runtime"],
  conversationId: string,
  timeoutMs: number,
): Promise<boolean> {
  const expectedId = conversationId.trim();
  if (!expectedId) {
    return false;
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - start);
    const { result } = await withTimeout(
      Runtime.evaluate({ expression: "location.href", returnByValue: true }),
      Math.min(5_000, Math.max(1_000, remainingMs)),
      "Timed out waiting for the expected conversation URL",
    );
    const href = typeof result?.value === "string" ? result.value : "";
    if (extractConversationIdFromUrl(href) === expectedId) {
      return true;
    }
    await delay(200);
  }
  return false;
}

export async function readConversationTurnIndex(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
): Promise<number | null> {
  try {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        ${buildThreadIntrospectionHelpers()}
        return __oracleCollectThreadEntries(__oraclePickThreadRoot()).filter(
          (entry) => entry.role === 'user' || entry.role === 'assistant',
        ).length;
      })()`,
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

function normalizeForComparison(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/\\s+/g, " ")
    .trim();
}

export function buildPromptEchoMatcher(promptPreview?: string | null): PromptEchoMatcher | null {
  const normalizedPrompt = normalizeForComparison(promptPreview ?? "");
  if (!normalizedPrompt) {
    return null;
  }
  const promptPrefix =
    normalizedPrompt.length >= 80
      ? normalizedPrompt.slice(0, Math.min(200, normalizedPrompt.length))
      : "";
  const minFragment = Math.min(40, normalizedPrompt.length);
  return {
    isEcho: (text: string) => {
      const normalized = normalizeForComparison(text);
      if (!normalized) return false;
      if (normalized === normalizedPrompt) return true;
      if (promptPrefix.length > 0 && normalized.startsWith(promptPrefix)) return true;
      if (normalized.length >= minFragment && normalizedPrompt.startsWith(normalized)) {
        return true;
      }
      if (normalized.includes("…") || normalized.includes("...")) {
        const marker = normalized.includes("…") ? "…" : "...";
        const [prefixRaw, suffixRaw] = normalized.split(marker);
        const prefix = prefixRaw?.trim() ?? "";
        const suffix = suffixRaw?.trim() ?? "";
        if (!prefix && !suffix) return false;
        if (prefix && !normalizedPrompt.includes(prefix)) return false;
        if (suffix && !normalizedPrompt.includes(suffix)) return false;
        const fragmentLength = prefix.length + suffix.length;
        return fragmentLength >= minFragment;
      }
      return false;
    },
  };
}

export async function recoverPromptEcho(
  Runtime: ChromeClient["Runtime"],
  answer: AssistantPayload,
  matcher: PromptEchoMatcher | null,
  logger: BrowserLogger,
  minTurnIndex: number | null,
  timeoutMs: number,
): Promise<AssistantPayload> {
  if (!matcher || !matcher.isEcho(answer.text)) {
    return answer;
  }
  logger("Detected prompt echo while reattaching; waiting for assistant response...");
  const deadline = Date.now() + Math.min(timeoutMs, 15_000);
  let bestText: string | null = null;
  let stableCount = 0;
  while (Date.now() < deadline) {
    const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex ?? undefined).catch(
      () => null,
    );
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
