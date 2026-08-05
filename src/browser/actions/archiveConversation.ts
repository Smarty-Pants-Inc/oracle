import type {
  BrowserArchiveMode,
  BrowserArchiveResult,
  BrowserLogger,
  BrowserResearchMode,
  ChromeClient,
} from "../types.js";
import {
  buildConversationTurnIdentityExpression,
  buildConversationTurnListExpression,
} from "../conversationTurns.js";
import { extractStableConversationIdFromUrl } from "../conversationUrl.js";
import type { CommittedPromptEpochLocator } from "../reattachability.js";
import {
  buildPromptIdentityNormalizationExpression,
  buildReadUserPromptTextExpression,
} from "./promptComposer.js";

export interface BrowserArchiveDecision {
  mode: BrowserArchiveMode;
  shouldArchive: boolean;
  reason: string;
}

export interface BrowserArchiveEffectReceipt {
  conversationId: string;
  promptEpoch: {
    epochId: string;
    promptSha256: string;
    userTurnIndex: number;
    userTurnId: string;
    userMessageId: string;
  } | null;
}

type BrowserArchiveResultWithEffectReceipt = BrowserArchiveResult & {
  effectAuthority?: BrowserArchiveEffectReceipt;
};

export function archiveResultHasCommittedEffectAuthority(
  archive: BrowserArchiveResult,
  locator: CommittedPromptEpochLocator,
): boolean {
  const receipt = (archive as BrowserArchiveResultWithEffectReceipt).effectAuthority;
  const promptEpoch = receipt?.promptEpoch;
  if (!archive.archived || !receipt || !promptEpoch) return false;
  return (
    receipt.conversationId === locator.conversationId &&
    promptEpoch.epochId === locator.epoch.epochId &&
    promptEpoch.promptSha256 === locator.promptSha256 &&
    promptEpoch.userTurnIndex === locator.verifiedUserTurnIndex &&
    promptEpoch.userTurnId === locator.verifiedUserTurnId &&
    promptEpoch.userMessageId === locator.verifiedUserMessageId
  );
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

export async function archiveChatGptConversation(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  {
    mode,
    conversationUrl,
    promptLocator,
  }: {
    mode: BrowserArchiveMode;
    conversationUrl?: string | null;
    promptLocator?: CommittedPromptEpochLocator;
  },
): Promise<BrowserArchiveResult> {
  const conversationId =
    promptLocator?.conversationId ?? extractStableConversationIdFromUrl(conversationUrl ?? "");
  const conversationUrlId = extractStableConversationIdFromUrl(conversationUrl ?? "");
  if (
    !conversationId ||
    (promptLocator && conversationUrlId && conversationUrlId !== conversationId)
  ) {
    logger("[browser] ChatGPT archive skipped (archive-authority-mismatch).");
    return {
      mode,
      attempted: false,
      archived: false,
      reason: "archive-authority-mismatch",
      conversationUrl: conversationUrl ?? undefined,
    };
  }
  const evaluated = await Runtime.evaluate({
    expression: buildArchiveConversationExpression(conversationId, promptLocator),
    awaitPromise: true,
    returnByValue: true,
  });
  const value = evaluated.result?.value as
    | {
        status: "archived";
        conversationUrl?: string | null;
        effectAuthority?: BrowserArchiveEffectReceipt;
      }
    | { status: "skipped"; reason: string; conversationUrl?: string | null }
    | { status: "failed"; error: string; conversationUrl?: string | null }
    | undefined;
  const resolvedUrl = value?.conversationUrl ?? conversationUrl ?? undefined;
  if (value?.status === "archived") {
    const archive: BrowserArchiveResultWithEffectReceipt = {
      mode,
      attempted: true,
      archived: true,
      conversationUrl: resolvedUrl,
      effectAuthority: value.effectAuthority,
    };
    if (promptLocator && !archiveResultHasCommittedEffectAuthority(archive, promptLocator)) {
      logger("[browser] ChatGPT archive skipped (archive-authority-mismatch).");
      return {
        mode,
        attempted: true,
        archived: false,
        reason: "archive-authority-mismatch",
        conversationUrl: resolvedUrl,
      };
    }
    logger("[browser] Archived ChatGPT conversation after saving local artifacts.");
    return archive;
  }
  const reason = value?.status === "skipped" ? value.reason : "archive-failed";
  const error = value?.status === "failed" ? value.error : undefined;
  logger(`[browser] ChatGPT archive skipped (${error ?? reason}).`);
  return {
    mode,
    attempted: true,
    archived: false,
    reason,
    conversationUrl: resolvedUrl,
    error,
  };
}

export function buildArchiveConversationExpressionForTest(
  conversationUrl = "https://chatgpt.com/c/test-conversation",
  promptLocator?: CommittedPromptEpochLocator,
): string {
  const conversationId =
    promptLocator?.conversationId ?? extractStableConversationIdFromUrl(conversationUrl);
  if (!conversationId) throw new Error("A stable conversation URL is required for archive tests.");
  return buildArchiveConversationExpression(conversationId, promptLocator);
}

function buildArchiveConversationExpression(
  conversationId: string,
  promptLocator?: CommittedPromptEpochLocator,
): string {
  const authority = {
    conversationId,
    promptEpoch: promptLocator
      ? {
          epochId: promptLocator.epoch.epochId,
          promptSha256: promptLocator.promptSha256,
          userTurnIndex: promptLocator.verifiedUserTurnIndex,
          userTurnId: promptLocator.verifiedUserTurnId,
          userMessageId: promptLocator.verifiedUserMessageId,
        }
      : null,
  };
  return `(() => {
    const expectedArchiveAuthority = ${JSON.stringify(authority)};
    const conversationUrl = typeof location === 'object' ? location.href : null;
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
    const isVisible = (element) => {
      if (!element || !(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const labelFor = (element) =>
      normalize([
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('title'),
        element.textContent,
      ].filter(Boolean).join(' '));
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
    ${buildConversationTurnIdentityExpression()}
    ${buildReadUserPromptTextExpression()}
    ${buildPromptIdentityNormalizationExpression()}
    const sha256 = async (value) => {
      if (!globalThis.crypto?.subtle || typeof TextEncoder !== 'function') return null;
      const bytes = new TextEncoder().encode(normalizePromptIdentity(value));
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    const readArchiveAuthoritySnapshot = () => {
      try {
        const href = typeof location === 'object' && location.href ? location.href : '';
        const currentUrl = new URL(href);
        if (
          currentUrl.protocol !== 'https:' ||
          currentUrl.port ||
          (currentUrl.hostname !== 'chatgpt.com' && currentUrl.hostname !== 'chat.openai.com')
        ) return null;
        const conversationId = currentUrl.pathname.match(/\\/c\\/([a-zA-Z0-9-]+)/)?.[1] ?? null;
        if (conversationId !== expectedArchiveAuthority.conversationId) return null;
        const promptEpoch = expectedArchiveAuthority.promptEpoch;
        if (!promptEpoch) return { conversationId, promptText: null };
        const turns = ${buildConversationTurnListExpression()};
        const turn = turns[promptEpoch.userTurnIndex];
        if (!turn || !isUserTurn(turn)) return null;
        if (readTurnId(turn) !== promptEpoch.userTurnId) return null;
        if (readMessageId(turn) !== promptEpoch.userMessageId) return null;
        for (let index = promptEpoch.userTurnIndex + 1; index < turns.length; index += 1) {
          if (isUserTurn(turns[index])) return null;
        }
        const promptText = readUserPromptText(turn);
        return typeof promptText === 'string' ? { conversationId, promptText } : null;
      } catch {
        return null;
      }
    };
    const runWithArchiveAuthority = async (effect) => {
      const beforeDigest = readArchiveAuthoritySnapshot();
      if (!beforeDigest) return false;
      const promptEpoch = expectedArchiveAuthority.promptEpoch;
      if (!promptEpoch) {
        effect();
        return true;
      }
      if (await sha256(beforeDigest.promptText) !== promptEpoch.promptSha256) return false;
      const immediatelyBeforeEffect = readArchiveAuthoritySnapshot();
      if (
        !immediatelyBeforeEffect ||
        immediatelyBeforeEffect.conversationId !== beforeDigest.conversationId ||
        immediatelyBeforeEffect.promptText !== beforeDigest.promptText
      ) return false;
      effect();
      return true;
    };
    const clickArchiveEffect = (element) => runWithArchiveAuthority(() => click(element));
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
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (conversationUrl && location.href !== conversationUrl) return true;
        if (hasArchiveConfirmation()) return true;
        await sleep(150);
      }
      return false;
    };
    const verifyArchivedStateFromMenu = async () => {
      const menuButton = findConversationMenuButton();
      if (!menuButton) return false;
      click(menuButton);
      await sleep(300);
      const archived = hasUnarchiveMenuItem();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return archived;
    };
    return (async () => {
      if (!(await runWithArchiveAuthority(() => {}))) {
        return { status: 'skipped', reason: 'archive-authority-mismatch', conversationUrl };
      }
      const menuButton = findConversationMenuButton();
      if (!menuButton) {
        return { status: 'skipped', reason: 'conversation-menu-not-found', conversationUrl };
      }
      click(menuButton);
      await sleep(350);
      const archiveItem = findArchiveMenuItem();
      if (!archiveItem) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { status: 'skipped', reason: 'archive-menu-item-not-found', conversationUrl };
      }
      if (!(await clickArchiveEffect(archiveItem))) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { status: 'skipped', reason: 'archive-authority-mismatch', conversationUrl };
      }
      await sleep(350);
      const confirmButton = findArchiveConfirmationButton();
      if (confirmButton) {
        if (!(await clickArchiveEffect(confirmButton))) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          return { status: 'skipped', reason: 'archive-authority-mismatch', conversationUrl };
        }
        await sleep(500);
      }
      if (await waitForArchiveConfirmation()) {
        return { status: 'archived', conversationUrl, effectAuthority: expectedArchiveAuthority };
      }
      if (await verifyArchivedStateFromMenu()) {
        return { status: 'archived', conversationUrl, effectAuthority: expectedArchiveAuthority };
      }
      return { status: 'skipped', reason: 'archive-not-confirmed', conversationUrl };
    })().catch((error) => ({
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      conversationUrl,
    }));
  })()`;
}
