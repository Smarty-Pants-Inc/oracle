import type { BrowserLogger, ChromeClient } from "./types.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { delay } from "./utils.js";

const ROUTE_TIMEOUT_MS = 20_000;

export interface ChatGptIdentityExpectation {
  email: string;
  workspaceName: string;
  accountDigest?: string | null;
  workspaceDigest?: string | null;
}

export interface ChatGptIdentityEvidence {
  email: string;
  workspaceName: string;
  accountDigest: string;
  workspaceDigest: string;
}

interface ChatGptSessionIdentity {
  status: "authenticated" | "unauthenticated" | "unavailable" | "wrong-origin";
  email?: string;
  accountDigest?: string;
  workspaceDigest?: string;
}

interface MenuActionResult {
  status?: "clicked" | "menu-opened" | "switcher-opened" | "selected" | "ambiguous" | "not-found";
  x?: number;
  y?: number;
}

export async function readChatGptSessionIdentity(
  Runtime: ChromeClient["Runtime"],
): Promise<ChatGptSessionIdentity> {
  try {
    const outcome = await Runtime.evaluate({
      expression: buildSessionIdentityExpression(),
      awaitPromise: true,
      returnByValue: true,
    });
    const value = outcome.result?.value as ChatGptSessionIdentity | undefined;
    if (!value || typeof value.status !== "string") {
      return { status: "unavailable" };
    }
    return value;
  } catch {
    return { status: "unavailable" };
  }
}
export async function assertChatGptIdentity(
  Runtime: ChromeClient["Runtime"],
  expectation: ChatGptIdentityExpectation,
): Promise<ChatGptIdentityEvidence> {
  const email = expectation.email.trim().toLowerCase();
  const workspaceName = expectation.workspaceName.trim();
  if (!email || !workspaceName) {
    throw new BrowserAutomationError(
      "Main Chrome account routing requires an exact ChatGPT email and workspace.",
      { stage: "main-chrome-account-router", code: "account-route-incomplete" },
    );
  }
  validateDigest(expectation.accountDigest, "account");
  validateDigest(expectation.workspaceDigest, "workspace");

  let identity = await readChatGptSessionIdentity(Runtime);
  if (identity.status === "unavailable") {
    const availableIdentity = await waitForIdentityAvailability(Runtime);
    if (!availableIdentity) throw identityUnavailableError();
    identity = availableIdentity;
  }
  if (identity.status === "wrong-origin") {
    throw chatGptOriginMismatchError();
  }
  if (identity.status === "authenticated" && identity.email !== email) {
    throw new BrowserAutomationError("ChatGPT account changed during the Oracle run.", {
      stage: "main-chrome-account-router",
      code: "account-identity-mismatch",
      expectedEmail: email,
    });
  }
  if (
    identity.status !== "authenticated" ||
    identity.email !== email ||
    !identity.accountDigest ||
    !identity.workspaceDigest
  ) {
    throw loginRequiredError(email, workspaceName);
  }
  if (expectation.accountDigest && identity.accountDigest !== expectation.accountDigest) {
    throw new BrowserAutomationError("Stored ChatGPT account identity changed.", {
      stage: "main-chrome-account-router",
      code: "account-identity-mismatch",
    });
  }
  if (expectation.workspaceDigest && identity.workspaceDigest !== expectation.workspaceDigest) {
    throw new BrowserAutomationError("Stored ChatGPT workspace identity changed.", {
      stage: "main-chrome-account-router",
      code: "workspace-identity-mismatch",
    });
  }
  return {
    email,
    workspaceName,
    accountDigest: identity.accountDigest,
    workspaceDigest: identity.workspaceDigest,
  };
}

export async function ensureChatGptIdentity(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  expectation: ChatGptIdentityExpectation,
  logger: BrowserLogger,
): Promise<ChatGptIdentityEvidence> {
  const email = expectation.email.trim().toLowerCase();
  const workspaceName = expectation.workspaceName.trim();
  if (!email || !workspaceName) {
    throw new BrowserAutomationError(
      "Main Chrome account routing requires an exact ChatGPT email and workspace.",
      { stage: "main-chrome-account-router", code: "account-route-incomplete" },
    );
  }
  validateDigest(expectation.accountDigest, "account");
  validateDigest(expectation.workspaceDigest, "workspace");

  let identity = await readChatGptSessionIdentity(Runtime).catch(() => ({
    status: "unavailable" as const,
  }));
  if (identity.status === "unavailable") {
    const availableIdentity = await waitForIdentityAvailability(Runtime);
    if (!availableIdentity) throw identityUnavailableError();
    identity = availableIdentity;
  }
  if (identity.status === "wrong-origin") {
    throw chatGptOriginMismatchError();
  }

  let accountSelection: "clicked" | "selected" | false = false;
  if (identity.status !== "authenticated" || identity.email !== email) {
    logger(`[browser] Selecting the wrapper-routed ChatGPT account (${email})`);
    accountSelection = await selectMenuIdentity(
      Runtime,
      Input,
      "email",
      email,
      expectation,
      logger,
    );
    if (!accountSelection) {
      throw loginRequiredError(email, workspaceName);
    }
    const selectedIdentity = await waitForIdentity(
      Runtime,
      (candidate) =>
        candidate.email === email &&
        (!expectation.accountDigest || candidate.accountDigest === expectation.accountDigest),
    );
    if (!selectedIdentity) {
      throw loginRequiredError(email, workspaceName);
    }
    identity = selectedIdentity;
  }

  if (identity.status !== "authenticated" || identity.email !== email) {
    throw loginRequiredError(email, workspaceName);
  }
  if (expectation.accountDigest && identity.accountDigest !== expectation.accountDigest) {
    throw new BrowserAutomationError("Stored ChatGPT account identity changed.", {
      stage: "main-chrome-account-router",
      code: "account-identity-mismatch",
    });
  }

  const previousWorkspaceDigest = identity.workspaceDigest;
  logger(`[browser] Selecting the wrapper-routed ChatGPT workspace (${workspaceName})`);
  const selection = await selectMenuIdentity(
    Runtime,
    Input,
    "workspace",
    workspaceName,
    expectation,
    logger,
  );
  if (!selection) {
    throw workspaceRequiredError(email, workspaceName);
  }
  let selectedIdentity: ChatGptSessionIdentity | null;
  if (
    selection === "clicked" &&
    expectation.workspaceDigest &&
    expectation.workspaceDigest === previousWorkspaceDigest
  ) {
    const settledRow = await selectMenuIdentity(
      Runtime,
      Input,
      "workspace",
      workspaceName,
      { ...expectation, workspaceDigest: expectation.workspaceDigest },
      logger,
      false,
    );
    if (settledRow !== "selected") {
      throw workspaceRequiredError(email, workspaceName);
    }
    selectedIdentity = await waitForIdentity(
      Runtime,
      (candidate) =>
        candidate.email === email && candidate.workspaceDigest === expectation.workspaceDigest,
    );
  } else {
    selectedIdentity = await waitForIdentity(Runtime, (candidate) => {
      if (candidate.email !== email || !candidate.workspaceDigest) return false;
      if (
        expectation.workspaceDigest &&
        candidate.workspaceDigest !== expectation.workspaceDigest
      ) {
        return false;
      }
      return selection === "selected" || candidate.workspaceDigest !== previousWorkspaceDigest;
    });
  }
  if (!selectedIdentity) {
    throw workspaceRequiredError(email, workspaceName);
  }
  if (
    !expectation.workspaceDigest &&
    (await selectMenuIdentity(
      Runtime,
      Input,
      "workspace",
      workspaceName,
      { ...expectation, workspaceDigest: selectedIdentity.workspaceDigest },
      logger,
      false,
    )) !== "selected"
  ) {
    throw workspaceRequiredError(email, workspaceName);
  }
  identity = selectedIdentity;

  if (
    identity.status !== "authenticated" ||
    identity.email !== email ||
    !identity.accountDigest ||
    !identity.workspaceDigest
  ) {
    throw workspaceRequiredError(email, workspaceName);
  }
  if (expectation.accountDigest && identity.accountDigest !== expectation.accountDigest) {
    throw new BrowserAutomationError("Stored ChatGPT account identity changed.", {
      stage: "main-chrome-account-router",
      code: "account-identity-mismatch",
    });
  }
  if (expectation.workspaceDigest && identity.workspaceDigest !== expectation.workspaceDigest) {
    throw new BrowserAutomationError("Stored ChatGPT workspace identity changed.", {
      stage: "main-chrome-account-router",
      code: "workspace-identity-mismatch",
    });
  }

  logger(`[browser] ChatGPT identity verified (${email}, ${workspaceName})`);
  return {
    email,
    workspaceName,
    accountDigest: identity.accountDigest,
    workspaceDigest: identity.workspaceDigest,
  };
}

async function selectMenuIdentity(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  kind: "email" | "workspace",
  target: string,
  expectation: ChatGptIdentityExpectation,
  logger: BrowserLogger,
  allowTargetClick = true,
): Promise<"clicked" | "selected" | false> {
  const deadline = Date.now() + ROUTE_TIMEOUT_MS;
  let lastStatus = "not-found";
  let clickedTarget = false;
  while (Date.now() < deadline) {
    try {
      const outcome = await Runtime.evaluate({
        expression: buildMenuActionExpression(
          kind,
          target,
          allowTargetClick,
          expectation.workspaceName,
          kind === "workspace" ? expectation.email : "",
        ),
        awaitPromise: false,
        returnByValue: true,
      });
      const result = outcome.result?.value as MenuActionResult | undefined;
      lastStatus = result?.status ?? "not-found";
      if (result?.status === "ambiguous") {
        throw new BrowserAutomationError(
          `ChatGPT exposed more than one ${kind} menu row matching the wrapper route; refusing an ambiguous selection.`,
          { stage: "main-chrome-account-router", code: `${kind}-menu-ambiguous` },
        );
      }
      const hasClickPoint =
        typeof result?.x === "number" &&
        Number.isFinite(result.x) &&
        typeof result.y === "number" &&
        Number.isFinite(result.y);
      const needsClick =
        result?.status === "clicked" ||
        result?.status === "menu-opened" ||
        result?.status === "switcher-opened";
      let clicked = false;
      if (needsClick && hasClickPoint) {
        await Input.dispatchMouseEvent({ type: "mouseMoved", x: result.x!, y: result.y! });
        const clickOutcome = await Runtime.evaluate({
          expression: buildPointerClickExpression(result.x!, result.y!),
          returnByValue: true,
        });
        clicked = clickOutcome.result?.value === true;
        if (result?.status === "clicked" && clicked) clickedTarget = true;
      }
      if (result?.status === "selected") return "selected";
      if (allowTargetClick && kind === "workspace" && result?.status === "clicked" && clicked) {
        return "clicked";
      }
    } catch (error) {
      if (error instanceof BrowserAutomationError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/context was destroyed|navigated or closed|target closed/i.test(message)) {
        logger(`[browser] ChatGPT ${kind} selector probe failed: ${message}`);
      }
    }

    await delay(500);
    const identity = await readChatGptSessionIdentity(Runtime).catch(() => null);
    if (kind === "email" && identity?.status === "authenticated" && identity.email === target) {
      return clickedTarget ? "clicked" : "selected";
    }
  }
  logger(`[browser] ChatGPT ${kind} selector stopped (${lastStatus})`);
  return false;
}

async function waitForIdentity(
  Runtime: ChromeClient["Runtime"],
  accept: (identity: ChatGptSessionIdentity) => boolean,
): Promise<ChatGptSessionIdentity | null> {
  const deadline = Date.now() + ROUTE_TIMEOUT_MS;
  let sawAvailableIdentity = false;
  while (Date.now() < deadline) {
    const identity = await readChatGptSessionIdentity(Runtime);
    if (identity.status === "wrong-origin") throw chatGptOriginMismatchError();
    if (identity.status !== "unavailable") sawAvailableIdentity = true;
    if (identity.status === "authenticated" && accept(identity)) {
      return identity;
    }
    await delay(500);
  }
  if (!sawAvailableIdentity) throw identityUnavailableError();
  return null;
}

async function waitForIdentityAvailability(
  Runtime: ChromeClient["Runtime"],
): Promise<ChatGptSessionIdentity | null> {
  const deadline = Date.now() + ROUTE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const identity = await readChatGptSessionIdentity(Runtime);
    if (identity.status !== "unavailable") return identity;
    await delay(500);
  }
  return null;
}

function validateDigest(value: string | null | undefined, label: string): void {
  if (value && !/^[a-f0-9]{64}$/.test(value)) {
    throw new BrowserAutomationError(`Stored ChatGPT ${label} identity is invalid.`, {
      stage: "main-chrome-account-router",
      code: `${label}-identity-invalid`,
    });
  }
}

function chatGptOriginMismatchError(): BrowserAutomationError {
  return new BrowserAutomationError("Main Chrome left the trusted ChatGPT origin.", {
    stage: "main-chrome-account-router",
    code: "chatgpt-origin-mismatch",
  });
}

function identityUnavailableError(): BrowserAutomationError {
  return new BrowserAutomationError(
    "ChatGPT session identity is temporarily unavailable in main Chrome. Keep chatgpt.com open and retry after the page and browser bridge are responsive.",
    {
      stage: "main-chrome-account-router",
      code: "identity-unavailable",
    },
  );
}

function loginRequiredError(email: string, workspaceName: string): BrowserAutomationError {
  return new BrowserAutomationError(
    `ChatGPT login for ${email} is unavailable in the main Chrome profile. In main Chrome, open chatgpt.com, choose Add account, sign in to ${email}, select the “${workspaceName}” workspace, then rerun Oracle.`,
    {
      stage: "main-chrome-account-router",
      code: "login-required",
      expectedEmail: email,
      expectedWorkspace: workspaceName,
    },
  );
}

function workspaceRequiredError(email: string, workspaceName: string): BrowserAutomationError {
  return new BrowserAutomationError(
    `The “${workspaceName}” ChatGPT workspace is unavailable for ${email} in the main Chrome profile. In main Chrome, switch to ${email}, select that workspace, then rerun Oracle.`,
    {
      stage: "main-chrome-account-router",
      code: "workspace-required",
      expectedEmail: email,
      expectedWorkspace: workspaceName,
    },
  );
}

function buildSessionIdentityExpression(): string {
  return `(() => (async () => {
    if (globalThis.location?.origin !== 'https://chatgpt.com') {
      return { status: 'wrong-origin' };
    }
    const digest = async (value) => {
      if (typeof value !== 'string' || !value.trim() || !globalThis.crypto?.subtle) return '';
      const bytes = new Uint8Array(await crypto.subtle.digest(
        'SHA-256', new TextEncoder().encode(value.trim()),
      ));
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    try {
      const response = await fetch('/api/auth/session', {
        cache: 'no-store', credentials: 'include',
      });
      if (response.status === 401 || response.status === 403) return { status: 'unauthenticated' };
      if (!response.ok) return { status: 'unavailable' };
      const body = await response.json();
      const email = typeof body?.user?.email === 'string'
        ? body.user.email.trim().toLowerCase()
        : '';
      const userId = typeof body?.user?.id === 'string' ? body.user.id : '';
      const workspaceId = typeof body?.account?.id === 'string' ? body.account.id : '';
      if (!email || !userId || !workspaceId) return { status: 'unauthenticated' };
      return {
        status: 'authenticated',
        email,
        accountDigest: await digest(userId),
        workspaceDigest: await digest(workspaceId),
      };
    } catch {
      return { status: 'unavailable' };
    }
  })())()`;
}
function buildMenuActionExpression(
  kind: "email" | "workspace",
  target: string,
  allowTargetClick = true,
  accountWorkspace = "",
  accountEmail = "",
): string {
  return `(() => {
    const kind = ${JSON.stringify(kind)};
    const target = ${JSON.stringify(target.trim().toLowerCase())};
    const allowTargetClick = ${JSON.stringify(allowTargetClick)};
    const accountWorkspace = ${JSON.stringify(accountWorkspace.trim().toLowerCase())};
    const accountEmail = ${JSON.stringify(accountEmail.trim().toLowerCase())};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const lower = (value) => normalize(value).toLowerCase();
    const visible = (node) => {
      if (!(node instanceof Element)) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
    };
    const labels = (node) => [
      node?.getAttribute?.('aria-label'),
      node?.getAttribute?.('title'),
      node?.textContent,
    ].map(normalize).filter(Boolean);
    const label = (node) => labels(node).join(' ');
    const actionableSelector = 'button,a,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"]';
    const actionable = Array.from(document.querySelectorAll(actionableSelector)).filter(visible);
    const menuRoots = Array.from(document.querySelectorAll(
      '[role="menu"],[role="dialog"],[role="listbox"],[data-radix-menu-content],[data-radix-popper-content-wrapper],[data-state="open"]',
    )).filter(visible);
    const menuActionable = Array.from(new Set(menuRoots.flatMap((root) => [
      ...(root.matches?.(actionableSelector) ? [root] : []),
      ...Array.from(root.querySelectorAll(actionableSelector)),
    ]))).filter(visible);
    const emails = (node) => Array.from(new Set(labels(node).map(lower).flatMap((value) =>
      value.match(/[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9.-]+\\.[a-z]{2,}/g) || []
    )));
    const matchesEmail = (node, expected) => {
      const found = emails(node);
      return found.length === 1 && found[0] === expected;
    };
    const matchesWorkspace = (node, expected) => labels(node).map(lower).some((value) => {
      const cleaned = value.replace(/^[✓✔\\s]+/, '').replace(/\\s+(selected|current)$/i, '');
      if (cleaned === expected) return true;
      return cleaned.split(/\\s+[•·|›→]\\s+/).some((part) => part.trim() === expected);
    });
    const matchesTarget = (node) => kind === 'email'
      ? matchesEmail(node, target)
      : matchesWorkspace(node, target);
    const isSelected = (node) => {
      const selected = [
        node.getAttribute('aria-checked'),
        node.getAttribute('aria-current'),
        node.getAttribute('aria-selected'),
        node.getAttribute('data-state'),
      ].map(lower);
      return selected.some((value) => ['true', 'page', 'checked', 'selected', 'active'].includes(value)) ||
        Boolean(node.querySelector('[data-state="checked"],[aria-label*="selected" i],[data-icon="check"],svg[class*="check" i]'));
    };
    const clickPoint = (node, status) => {
      const rect = node.getBoundingClientRect();
      return {
        status,
        x: rect.left + rect.width / 2 - Math.min(10, rect.width / 4),
        y: rect.top + rect.height / 2,
      };
    };
    let targetMatches = menuActionable.filter(matchesTarget);
    if (kind === 'workspace' && accountEmail) {
      const accountMatches = menuActionable.filter((node) => matchesEmail(node, accountEmail));
      const accountLeaves = accountMatches.filter((node) =>
        !accountMatches.some((other) => other !== node && node.contains(other))
      );
      if (accountLeaves.length > 1) return { status: 'ambiguous' };
      const account = accountLeaves[0];
      if (!account) {
        const currentAccount = menuActionable.find((node) =>
          node.getAttribute('role') === 'menuitem' &&
          ((node.getAttribute('aria-haspopup') === 'menu' && node.hasAttribute('data-has-submenu')) ||
            /(?:personal|business|team|enterprise)\\s+account\\b/i.test(label(node)))
        );
        if (currentAccount) return clickPoint(currentAccount, 'switcher-opened');
      }
      const accountRows = [];
      for (let index = menuActionable.indexOf(account) + 1; index < menuActionable.length; index += 1) {
        const candidate = menuActionable[index];
        if (emails(candidate).length) break;
        accountRows.push(candidate);
      }
      targetMatches = accountRows.filter(matchesTarget);
    }
    const leafMatches = targetMatches.filter((node) =>
      !targetMatches.some((other) => other !== node && node.contains(other))
    );
    if (leafMatches.length > 1) return { status: 'ambiguous' };
    const match = leafMatches[0] || null;
    if (match && kind === 'email' && accountWorkspace) {
      const accountRows = [];
      for (let index = menuActionable.indexOf(match) + 1; index < menuActionable.length; index += 1) {
        const candidate = menuActionable[index];
        if (emails(candidate).length) break;
        accountRows.push(candidate);
      }
      const workspaceMatches = accountRows.filter((node) => matchesWorkspace(node, accountWorkspace));
      const workspaceLeafMatches = workspaceMatches.filter((node) =>
        !workspaceMatches.some((other) => other !== node && node.contains(other))
      );
      if (workspaceLeafMatches.length > 1) return { status: 'ambiguous' };
      const workspaceMatch = workspaceLeafMatches[0] || null;
      if (!workspaceMatch) return { status: 'not-found' };
      if (isSelected(workspaceMatch)) return { status: 'selected' };
      return allowTargetClick ? clickPoint(workspaceMatch, 'clicked') : { status: 'not-found' };
    }
    if (match) {
      if (isSelected(match)) return { status: 'selected' };
      return allowTargetClick ? clickPoint(match, 'clicked') : { status: 'not-found' };
    }
    if (kind === 'email') {
      const switcher = menuActionable.find((node) => /^(switch account|accounts?)$/i.test(label(node)));
      if (switcher) return clickPoint(switcher, 'switcher-opened');
    }
    const currentAccount = menuActionable.find((node) =>
      node.getAttribute('role') === 'menuitem' &&
      ((node.getAttribute('aria-haspopup') === 'menu' && node.hasAttribute('data-has-submenu')) ||
        /(?:personal|business|team|enterprise)\\s+account\\b/i.test(label(node)))
    );
    if (currentAccount) return clickPoint(currentAccount, 'switcher-opened');
    const profileSelectors = [
      '[data-testid="profile-button"]',
      '[data-testid="accounts-profile-button"]',
      '[role="button"][aria-label*="open profile menu" i]',
      '[role="button"][aria-label*="profile menu" i]',
      '[role="button"][aria-label*="account menu" i]',
      'button[aria-label*="open profile menu" i]',
      'button[aria-label*="profile menu" i]',
      'button[aria-label*="account menu" i]',
    ];
    const profileCandidates = Array.from(new Set(profileSelectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector))
    ))).filter(visible);
    let profile = profileCandidates.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
    })[0] || null;
    if (!profile) {
      const menuButtons = actionable.filter((node) =>
        node.getAttribute('aria-haspopup') === 'menu' &&
        (/profile|account|settings/i.test(label(node)) || Boolean(node.closest('nav,aside')))
      );
      profile = menuButtons.at(-1) || null;
    }
    if (profile) return clickPoint(profile, 'menu-opened');
    return { status: 'not-found' };
  })()`;
}

function buildPointerClickExpression(x: number, y: number): string {
  return `(() => {
    const x = ${JSON.stringify(x)};
    const y = ${JSON.stringify(y)};
    const node = document.elementFromPoint(x, y);
    if (!(node instanceof Element)) return false;
    const common = {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, button: 0,
    };
    try {
      node.dispatchEvent(new PointerEvent('pointerdown', {
        ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1,
      }));
      node.dispatchEvent(new MouseEvent('mousedown', { ...common, buttons: 1 }));
      node.dispatchEvent(new PointerEvent('pointerup', {
        ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0,
      }));
      node.dispatchEvent(new MouseEvent('mouseup', { ...common, buttons: 0 }));
      node.dispatchEvent(new MouseEvent('click', { ...common, buttons: 0, detail: 1 }));
      return true;
    } catch {
      if (!(node instanceof HTMLElement)) return false;
      node.click();
      return true;
    }
  })()`;
}

export const __test__ = {
  buildMenuActionExpression,
  buildPointerClickExpression,
  buildSessionIdentityExpression,
};
