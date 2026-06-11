import type { ChromeClient, BrowserLogger } from "../types.js";
import {
  INPUT_SELECTORS,
  PROMPT_PRIMARY_SELECTOR,
  PROMPT_FALLBACK_SELECTOR,
  SEND_BUTTON_SELECTORS,
  CONVERSATION_TURN_SELECTOR,
  STOP_BUTTON_SELECTOR,
  ASSISTANT_ROLE_SELECTOR,
} from "../constants.js";
import { delay } from "../utils.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";
import { BrowserAutomationError } from "../../oracle/errors.js";

const ENTER_KEY_EVENT = {
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
} as const;
const ENTER_KEY_TEXT = "\r";
const PROMPT_ACCEPTANCE_TIMEOUT_MS = 5_000;
const PROMPT_ACCEPTANCE_POLL_MS = 100;

type PromptAcceptanceProbe = {
  accepted?: boolean;
  blockedBy?: string | null;
  signals?: string[];
  blockers?: string[];
  evidence?: Record<string, unknown>;
};

export async function submitPrompt(
  deps: {
    runtime: ChromeClient["Runtime"];
    input: ChromeClient["Input"];
    attachmentNames?: string[];
    baselineTurns?: number | null;
    inputTimeoutMs?: number | null;
  },
  prompt: string,
  logger: BrowserLogger,
): Promise<number | null> {
  const { runtime, input } = deps;

  await waitForDomReady(runtime, logger, deps.inputTimeoutMs ?? undefined);
  const encodedPrompt = JSON.stringify(prompt);
  const focusResult = await runtime.evaluate({
    expression: `(() => {
      ${buildClickDispatcher()}
      const SELECTORS = ${JSON.stringify(INPUT_SELECTORS)};
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const focusNode = (node) => {
        if (!node) {
          return false;
        }
        // Learned: React/ProseMirror require a real click + focus + selection for inserts to stick.
        dispatchClickSequence(node);
        if (typeof node.focus === 'function') {
          node.focus();
        }
        const doc = node.ownerDocument;
        const selection = doc?.getSelection?.();
        if (selection) {
          const range = doc.createRange();
          range.selectNodeContents(node);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return true;
      };

      const candidates = [];
      for (const selector of SELECTORS) {
        const node = document.querySelector(selector);
        if (node) {
          candidates.push(node);
        }
      }
      const preferred = candidates.find((node) => isVisible(node)) || candidates[0];
      if (preferred && focusNode(preferred)) {
        return { focused: true };
      }
      return { focused: false };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (!focusResult.result?.value?.focused) {
    await logDomFailure(runtime, logger, "focus-textarea");
    throw new Error("Failed to focus prompt textarea");
  }

  await input.insertText({ text: prompt });

  // Some pages (notably ChatGPT when subscriptions/widgets load) need a brief settle
  // before the send button becomes enabled; give it a short breather to avoid races.
  await delay(500);

  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const verification = await runtime.evaluate({
    expression: `(() => {
      const editor = document.querySelector(${primarySelectorLiteral});
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
      const readValue = (node) => {
        if (!node) return '';
        if (node instanceof HTMLTextAreaElement) return node.value ?? '';
        return node.innerText ?? '';
      };
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const candidates = inputSelectors
        .map((selector) => document.querySelector(selector))
        .filter((node) => Boolean(node));
      const active = candidates.find((node) => isVisible(node)) || candidates[0] || null;
      return {
        editorText: editor?.innerText ?? '',
        fallbackValue: fallback?.value ?? '',
        activeValue: active ? readValue(active) : '',
      };
    })()`,
    returnByValue: true,
  });

  const editorTextRaw = verification.result?.value?.editorText ?? "";
  const fallbackValueRaw = verification.result?.value?.fallbackValue ?? "";
  const activeValueRaw = verification.result?.value?.activeValue ?? "";
  const editorTextTrimmed = editorTextRaw?.trim?.() ?? "";
  const fallbackValueTrimmed = fallbackValueRaw?.trim?.() ?? "";
  const activeValueTrimmed = activeValueRaw?.trim?.() ?? "";
  if (!editorTextTrimmed && !fallbackValueTrimmed && !activeValueTrimmed) {
    // Learned: occasionally Input.insertText doesn't land in the editor; force textContent/value + input events.
    await runtime.evaluate({
      expression: `(() => {
        const fallback = document.querySelector(${fallbackSelectorLiteral});
        if (fallback) {
          fallback.value = ${encodedPrompt};
          fallback.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
          fallback.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const editor = document.querySelector(${primarySelectorLiteral});
        if (editor) {
          editor.textContent = ${encodedPrompt};
          // Nudge ProseMirror to register the textContent write so its state/send-button updates
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
        }
      })()`,
    });
  }

  const promptLength = prompt.length;
  const postVerification = await runtime.evaluate({
    expression: `(() => {
      const editor = document.querySelector(${primarySelectorLiteral});
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
      const readValue = (node) => {
        if (!node) return '';
        if (node instanceof HTMLTextAreaElement) return node.value ?? '';
        return node.innerText ?? '';
      };
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const candidates = inputSelectors
        .map((selector) => document.querySelector(selector))
        .filter((node) => Boolean(node));
      const active = candidates.find((node) => isVisible(node)) || candidates[0] || null;
      return {
        editorText: editor?.innerText ?? '',
        fallbackValue: fallback?.value ?? '',
        activeValue: active ? readValue(active) : '',
      };
    })()`,
    returnByValue: true,
  });
  const observedEditor = postVerification.result?.value?.editorText ?? "";
  const observedFallback = postVerification.result?.value?.fallbackValue ?? "";
  const observedActive = postVerification.result?.value?.activeValue ?? "";
  const observedLength = Math.max(
    observedEditor.length,
    observedFallback.length,
    observedActive.length,
  );
  if (promptLength >= 50_000 && observedLength > 0 && observedLength < promptLength - 2_000) {
    // Learned: very large prompts can truncate silently; fail fast so we can fall back to file uploads.
    await logDomFailure(runtime, logger, "prompt-too-large");
    throw new BrowserAutomationError(
      "Prompt appears truncated in the composer (likely too large).",
      {
        stage: "submit-prompt",
        code: "prompt-too-large",
        promptLength,
        observedLength,
      },
    );
  }

  const clicked = await attemptSendButton(runtime, logger, deps?.attachmentNames);
  if (!clicked) {
    await input.dispatchKeyEvent({
      type: "keyDown",
      ...ENTER_KEY_EVENT,
      text: ENTER_KEY_TEXT,
      unmodifiedText: ENTER_KEY_TEXT,
    });
    await input.dispatchKeyEvent({
      type: "keyUp",
      ...ENTER_KEY_EVENT,
    });
    logger("Submitted prompt via Enter key");
  } else {
    logger("Clicked send button");
  }

  await waitForPromptAccepted(
    runtime,
    PROMPT_ACCEPTANCE_TIMEOUT_MS,
    logger,
    deps.baselineTurns ?? undefined,
  );

  const commitTimeoutMs = Math.max(60_000, deps.inputTimeoutMs ?? 0);
  // Learned: the send button can succeed but the turn doesn't appear immediately; verify commit via turns/stop button.
  return await verifyPromptCommitted(
    runtime,
    prompt,
    commitTimeoutMs,
    logger,
    deps.baselineTurns ?? undefined,
  );
}

export async function clearPromptComposer(Runtime: ChromeClient["Runtime"], logger: BrowserLogger) {
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const result = await Runtime.evaluate({
    expression: `(() => {
      const SELECTORS = ${inputSelectorsLiteral};
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const editor = document.querySelector(${primarySelectorLiteral});
      const readValue = (node) => {
        if (!node) return '';
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return node.value ?? '';
        return node.innerText ?? node.textContent ?? '';
      };
      const dispatchClearEvents = (node) => {
        try {
          node.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: null, inputType: 'deleteContentBackward' }));
        } catch {}
        try {
          node.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
        } catch {
          node.dispatchEvent(new Event('input', { bubbles: true }));
        }
        node.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const clearEditable = (node) => {
        if (!node) return false;
        try {
          node.focus?.();
        } catch {}
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
          node.value = '';
          dispatchClearEvents(node);
          return true;
        }
        if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') {
          try {
            const selection = node.ownerDocument?.getSelection?.();
            const range = node.ownerDocument?.createRange?.();
            if (selection && range) {
              range.selectNodeContents(node);
              selection.removeAllRanges();
              selection.addRange(range);
              node.ownerDocument?.execCommand?.('delete', false);
            }
          } catch {}
          node.textContent = '';
          dispatchClearEvents(node);
          return true;
        }
        return false;
      };
      let cleared = false;
      const nodes = SELECTORS
        .map((selector) => document.querySelector(selector))
        .filter((node) => Boolean(node));
      for (const node of Array.from(new Set([fallback, editor, ...nodes])).filter(Boolean)) {
        cleared = clearEditable(node) || cleared;
      }
      const remaining = Array.from(new Set([fallback, editor, ...nodes]))
        .filter(Boolean)
        .map((node) => readValue(node).trim())
        .filter(Boolean);
      return { cleared, remaining };
    })()`,
    returnByValue: true,
  });
  const value = result.result?.value as { cleared?: boolean; remaining?: string[] } | undefined;
  if (!value?.cleared || (value.remaining?.length ?? 0) > 0) {
    await logDomFailure(Runtime, logger, "clear-composer");
    throw new Error("Failed to clear prompt composer");
  }
  await delay(250);
}

async function waitForDomReady(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const ready = document.readyState === 'complete';
        const composer = document.querySelector('[data-testid*="composer"]') || document.querySelector('form');
        const fileInput = document.querySelector('input[type="file"]');
        return { ready, composer: Boolean(composer), fileInput: Boolean(fileInput) };
      })()`,
      returnByValue: true,
    });
    const value = result?.value as
      | { ready?: boolean; composer?: boolean; fileInput?: boolean }
      | undefined;
    if (value?.ready && value.composer) {
      return;
    }
    await delay(150);
  }
  logger?.(`Page did not reach ready/composer state within ${timeoutMs}ms; continuing cautiously.`);
}

function buildAttachmentReadyExpression(attachmentNames: string[]): string {
  const namesLiteral = JSON.stringify(attachmentNames.map((name) => name.toLowerCase()));
  return `(() => {
    const names = ${namesLiteral};
    const composer =
      document.querySelector('[data-testid*="composer"]') ||
      document.querySelector('form') ||
      document.body ||
      document;
    const labelText = (node) =>
      [
        node?.textContent,
        node?.getAttribute?.('aria-label'),
        node?.getAttribute?.('title'),
        node?.getAttribute?.('data-testid'),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    const match = (node, name) => labelText(node).includes(name);

    // Restrict to attachment affordances; never scan generic div/span nodes (prompt text can contain the file name).
    const attachmentSelectors = [
      '[data-testid*="chip"]',
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[data-testid*="file"]',
      '[aria-label*="Remove file"]',
      'button[aria-label*="Remove file"]',
      '[aria-label*="remove file"]',
      'button[aria-label*="remove file"]',
    ];
    const attachmentRoots = Array.from(new Set([composer, document])).filter(Boolean);

    const chipsReady = names.every((name) =>
      attachmentRoots.some((root) =>
        Array.from(root.querySelectorAll(attachmentSelectors.join(','))).some((node) => match(node, name)),
      ),
    );
    const inputsReady = names.every((name) =>
      attachmentRoots.some((root) =>
        Array.from(root.querySelectorAll('input[type="file"]')).some((el) =>
          Array.from((el instanceof HTMLInputElement ? el.files : []) || []).some((file) =>
            file?.name?.toLowerCase?.().includes(name),
          ),
        ),
      ),
    );

    return chipsReady || inputsReady;
  })()`;
}

export function buildAttachmentReadyExpressionForTest(attachmentNames: string[]) {
  return buildAttachmentReadyExpression(attachmentNames);
}

async function attemptSendButton(
  Runtime: ChromeClient["Runtime"],
  _logger?: BrowserLogger,
  attachmentNames?: string[],
): Promise<boolean> {
  const script = `(() => {
    ${buildClickDispatcher()}
    const selectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const isEnabled = (node) => {
      const ariaDisabled = node.getAttribute('aria-disabled');
      const dataDisabled = node.getAttribute('data-disabled');
      const style = window.getComputedStyle(node);
      return !(
        node.hasAttribute('disabled') ||
        ariaDisabled === 'true' ||
        dataDisabled === 'true' ||
        style.pointerEvents === 'none' ||
        style.display === 'none'
      );
    };
    const candidates = [];
    for (const selector of selectors) {
      candidates.push(...Array.from(document.querySelectorAll(selector)));
    }
    const button = candidates.find((node) => isVisible(node) && isEnabled(node)) || null;
    if (!button) return 'missing';
    // Use unified pointer/mouse sequence to satisfy React handlers.
    dispatchClickSequence(button);
    return 'clicked';
  })()`;

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const needAttachment = Array.isArray(attachmentNames) && attachmentNames.length > 0;
    if (needAttachment) {
      const ready = await Runtime.evaluate({
        expression: buildAttachmentReadyExpression(attachmentNames),
        returnByValue: true,
      });
      if (!ready?.result?.value) {
        await delay(150);
        continue;
      }
    }
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    if (result.value === "clicked") {
      return true;
    }
    if (result.value === "missing") {
      break;
    }
    await delay(100);
  }
  if (Array.isArray(attachmentNames) && attachmentNames.length > 0) {
    throw new BrowserAutomationError(
      "Attachments never reached a clickable send button before timeout.",
      {
        stage: "submit-prompt",
        code: "attachment-send-not-ready",
        attachmentNames,
      },
    );
  }
  return false;
}

function buildPromptAcceptanceProbeExpression(baselineTurns?: number): string {
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const sendSelectorsLiteral = JSON.stringify(SEND_BUTTON_SELECTORS);
  const stopSelectorLiteral = JSON.stringify(STOP_BUTTON_SELECTOR);
  const assistantSelectorLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const turnSelectorLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const baselineLiteral =
    typeof baselineTurns === "number" && Number.isFinite(baselineTurns) && baselineTurns >= 0
      ? Math.floor(baselineTurns)
      : -1;
  return `(() => {
    const INPUT_SELECTORS = ${inputSelectorsLiteral};
    const SEND_SELECTORS = ${sendSelectorsLiteral};
    const STOP_SELECTOR = ${stopSelectorLiteral};
    const ASSISTANT_SELECTOR = ${assistantSelectorLiteral};
    const TURN_SELECTOR = ${turnSelectorLiteral};
    const baseline = ${baselineLiteral};
    const normalize = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const isVisible = (node) => {
      if (!(node instanceof Element)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (!style) return false;
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const labelFor = (node) =>
      normalize(node?.textContent || node?.getAttribute?.('aria-label') || node?.getAttribute?.('title') || node?.getAttribute?.('data-testid'));
    const visibleFrom = (selector) => {
      try {
        return Array.from(document.querySelectorAll(selector)).filter((node) => isVisible(node));
      } catch {
        return [];
      }
    };
    const visibleButtons = Array.from(document.querySelectorAll('button,a,[role="button"]')).filter((node) => isVisible(node));
    const buttonLabels = visibleButtons.map(labelFor).filter(Boolean).slice(0, 16);
    const bodyText = normalize(document.body?.innerText || '');
    const bodyLower = bodyText.toLowerCase();
    const url = typeof location === 'object' && location.href ? location.href : '';
    const path = typeof location === 'object' && location.pathname ? location.pathname : '';
    const title = normalize(document.title);
    const loginPattern = /\\b(log in|login|sign in|signin|sign up|continue with google|continue with microsoft|continue with email)\\b/i;
    const loginVisible =
      /auth\\.openai\\.com/i.test(url) ||
      /^\\/(auth|login|signin)/i.test(path) ||
      visibleButtons.some((node) => loginPattern.test(labelFor(node))) ||
      /log in to get answers|get responses tailored to you|welcome back/i.test(bodyText);
    const cloudflare =
      /just a moment/i.test(title) ||
      Boolean(document.querySelector('script[src*="/challenge-platform/"]')) ||
      /checking your browser|verify you are human|cf-challenge|cloudflare/i.test(bodyLower);
    const accountBlocked =
      /suspicious activity detected|secure your account|regain access/.test(bodyLower);
    const permissionGate =
      /does not have access|access denied|permission denied|workspace access|you don't have access/.test(bodyLower);

    const inputs = INPUT_SELECTORS.flatMap((selector) => visibleFrom(selector));
    const uniqueInputs = Array.from(new Set(inputs));
    const readValue = (node) => {
      if (!node) return '';
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
        return node.value ?? '';
      }
      return node.innerText ?? node.textContent ?? '';
    };
    const inputValues = uniqueInputs.map((node) => normalize(readValue(node))).filter(Boolean);
    const composerCleared = uniqueInputs.length > 0 && inputValues.length === 0;
    const composerDisabled =
      uniqueInputs.length > 0 &&
      uniqueInputs.every((node) => {
        const element = node;
        return (
          element.hasAttribute('disabled') ||
          element.getAttribute('aria-disabled') === 'true' ||
          element.getAttribute('contenteditable') === 'false'
        );
      });
    const inputSelectorsFound = INPUT_SELECTORS.filter((selector) => visibleFrom(selector).length > 0);

    const sendButtons = SEND_SELECTORS.flatMap((selector) => visibleFrom(selector));
    const sendVisible = sendButtons.length > 0;
    const sendEnabled = sendButtons.some((node) => {
      const style = window.getComputedStyle(node);
      return !(
        node.hasAttribute('disabled') ||
        node.getAttribute('aria-disabled') === 'true' ||
        node.getAttribute('data-disabled') === 'true' ||
        style.pointerEvents === 'none'
      );
    });
    const sendDisabled = sendVisible && !sendEnabled;
    const stopVisible = [
      ...visibleFrom(STOP_SELECTOR),
      ...visibleFrom('button[aria-label*="Stop"]'),
      ...visibleFrom('button[data-testid*="stop"]'),
    ].length > 0 || visibleButtons.some((node) => /\\bstop\\b/i.test(labelFor(node)));
    const turnsCount = document.querySelectorAll(TURN_SELECTOR).length;
    const hasNewTurn = baseline >= 0 && turnsCount > baseline;
    const assistantVisible = Boolean(
      document.querySelector(ASSISTANT_SELECTOR) ||
      document.querySelector('[data-testid*="assistant"]'),
    );
    const inConversation = /\\/c\\//.test(url);
    const statusNodes = [
      ...visibleFrom('[aria-live]:not([aria-live="off"])'),
      ...visibleFrom('[role="status"]'),
      ...visibleFrom('[role="progressbar"]'),
      ...visibleFrom('[aria-busy="true"]'),
      ...visibleFrom('[data-testid*="loading"]'),
      ...visibleFrom('[data-testid*="progress"]'),
      ...visibleFrom('[data-testid*="thinking"]'),
      ...visibleFrom('[data-testid*="reason"]'),
      ...visibleFrom('[data-testid*="shimmer"]'),
    ];
    const statusText = normalize(statusNodes.map(labelFor).filter(Boolean).join(' '));
    const thinkingVisible = /\\b(thinking|reasoning|working|analyzing|searching|reading|running|responding|generating|loading)\\b/i.test(statusText);

    const signals = [];
    if (hasNewTurn) signals.push('new-turn');
    if (stopVisible) signals.push('stop-control');
    if (thinkingVisible) signals.push('thinking-status');
    if (assistantVisible && hasNewTurn) signals.push('assistant-turn');
    if (composerCleared && (hasNewTurn || stopVisible || thinkingVisible || inConversation)) {
      signals.push('composer-cleared-after-send');
    }
    if (composerDisabled && (hasNewTurn || stopVisible || thinkingVisible)) {
      signals.push('composer-disabled-after-send');
    }
    if (sendDisabled && composerCleared && (hasNewTurn || stopVisible || thinkingVisible)) {
      signals.push('send-disabled-after-send');
    }

    const blockers = [];
    if (cloudflare) blockers.push('cloudflare-challenge');
    if (accountBlocked) blockers.push('chatgpt-account-blocked');
    if (loginVisible) blockers.push('login-required');
    if (permissionGate) blockers.push('permission-required');
    const blockedBy = blockers[0] || null;
    return {
      accepted: blockers.length === 0 && signals.length > 0,
      blockedBy,
      signals,
      blockers,
      evidence: {
        url,
        title,
        baseline,
        turnsCount,
        hasNewTurn,
        stopVisible,
        sendVisible,
        sendEnabled,
        sendDisabled,
        composerCleared,
        composerDisabled,
        inputCount: uniqueInputs.length,
        inputSelectorsFound,
        assistantVisible,
        inConversation,
        statusText: statusText.slice(0, 240),
        buttonLabels,
        bodySnippet: bodyText.slice(0, 500),
      },
    };
  })()`;
}

async function readPromptAcceptanceState(
  Runtime: ChromeClient["Runtime"],
  baselineTurns?: number,
): Promise<PromptAcceptanceProbe> {
  const { result } = await Runtime.evaluate({
    expression: buildPromptAcceptanceProbeExpression(baselineTurns),
    returnByValue: true,
  });
  return (result?.value ?? {}) as PromptAcceptanceProbe;
}

function buildPromptAcceptanceError(
  probe: PromptAcceptanceProbe | null,
  timeoutMs: number,
): BrowserAutomationError {
  const code = probe?.blockedBy || "prompt-not-accepted";
  const details = {
    stage: "submit-prompt",
    code,
    timeoutMs,
    signals: probe?.signals ?? [],
    blockers: probe?.blockers ?? [],
    evidence: probe?.evidence ?? {},
  };
  if (code === "login-required") {
    return new BrowserAutomationError(
      "ChatGPT login dialog detected after prompt submission; the prompt was not accepted.",
      details,
    );
  }
  if (code === "cloudflare-challenge") {
    return new BrowserAutomationError(
      "ChatGPT browser challenge detected after prompt submission; the prompt was not accepted.",
      details,
    );
  }
  if (code === "chatgpt-account-blocked") {
    return new BrowserAutomationError(
      "ChatGPT account security block detected after prompt submission; the prompt was not accepted.",
      details,
    );
  }
  if (code === "permission-required") {
    return new BrowserAutomationError(
      "ChatGPT reported a permission or workspace access blocker after prompt submission.",
      details,
    );
  }
  return new BrowserAutomationError(
    "ChatGPT did not enter a visible thinking/running state after the prompt was submitted.",
    details,
  );
}

function promptProbeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransientPromptProbeError(error: unknown): boolean {
  return /execution context was destroyed|context was destroyed|cannot find context|navigat|frame was detached/i.test(
    promptProbeErrorMessage(error),
  );
}

async function waitForPromptAccepted(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  logger?: BrowserLogger,
  baselineTurns?: number,
): Promise<PromptAcceptanceProbe> {
  const deadline = Date.now() + timeoutMs;
  let latest: PromptAcceptanceProbe | null = null;
  while (Date.now() < deadline) {
    try {
      latest = await readPromptAcceptanceState(Runtime, baselineTurns);
    } catch (error) {
      if (isTransientPromptProbeError(error)) {
        latest = {
          accepted: false,
          signals: [],
          blockers: [],
          evidence: { probeError: promptProbeErrorMessage(error) },
        };
        await delay(PROMPT_ACCEPTANCE_POLL_MS);
        continue;
      }
      throw new BrowserAutomationError(
        "Failed to inspect ChatGPT prompt acceptance state after submission.",
        {
          stage: "submit-prompt",
          code: "prompt-acceptance-probe-failed",
          timeoutMs,
          error: promptProbeErrorMessage(error),
        },
        error,
      );
    }
    if (latest.blockedBy) {
      logger?.(
        `Prompt acceptance blocked (${latest.blockedBy}); evidence: ${JSON.stringify(
          latest.evidence ?? {},
        )}`,
      );
      await logDomFailure(Runtime, logger as BrowserLogger, "prompt-acceptance").catch(
        () => undefined,
      );
      throw buildPromptAcceptanceError(latest, timeoutMs);
    }
    if (latest.accepted) {
      logger?.(
        `Prompt accepted by ChatGPT (${(latest.signals ?? []).join(", ") || "signal detected"})`,
      );
      return latest;
    }
    await delay(PROMPT_ACCEPTANCE_POLL_MS);
  }
  if (logger) {
    logger(
      `Prompt acceptance check failed; latest state: ${latest ? JSON.stringify(latest) : "unavailable"}`,
    );
    await logDomFailure(Runtime, logger, "prompt-acceptance");
  }
  throw buildPromptAcceptanceError(latest, timeoutMs);
}

async function verifyPromptCommitted(
  Runtime: ChromeClient["Runtime"],
  prompt: string,
  timeoutMs: number,
  logger?: BrowserLogger,
  baselineTurns?: number,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  const encodedPrompt = JSON.stringify(prompt.trim());
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const stopSelectorLiteral = JSON.stringify(STOP_BUTTON_SELECTOR);
  const assistantSelectorLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const turnSelectorLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  let baseline: number | null =
    typeof baselineTurns === "number" && Number.isFinite(baselineTurns) && baselineTurns >= 0
      ? Math.floor(baselineTurns)
      : null;
  if (baseline === null) {
    try {
      const { result } = await Runtime.evaluate({
        expression: `document.querySelectorAll(${turnSelectorLiteral}).length`,
        returnByValue: true,
      });
      const raw = typeof result?.value === "number" ? result.value : Number(result?.value);
      if (Number.isFinite(raw)) {
        baseline = Math.max(0, Math.floor(raw));
      }
    } catch {
      // ignore; baseline stays unknown
    }
  }
  const baselineLiteral = baseline ?? -1;
  // Learned: ChatGPT can echo/format text; normalize markdown and use prefix matches to detect the sent prompt.
  const script = `(() => {
		    const editor = document.querySelector(${primarySelectorLiteral});
		    const fallback = document.querySelector(${fallbackSelectorLiteral});
		    const inputSelectors = ${inputSelectorsLiteral};
	    const normalize = (value) => {
	      let text = value?.toLowerCase?.() ?? '';
	      // Strip markdown *markers* but keep content (ChatGPT renders fence markers differently).
	      text = text.replace(/\`\`\`[^\\n]*\\n([\\s\\S]*?)\`\`\`/g, ' $1 ');
	      text = text.replace(/\`\`\`/g, ' ');
	      text = text.replace(/\`([^\`]*)\`/g, '$1');
	      return text.replace(/\\s+/g, ' ').trim();
	    };
	    const normalizedPrompt = normalize(${encodedPrompt});
	    const normalizedPromptPrefix = normalizedPrompt.slice(0, 120);
	    const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
	    const articles = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
	    const normalizedTurns = articles.map((node) => normalize(node?.innerText));
	    const readValue = (node) => {
	      if (!node) return '';
	      if (node instanceof HTMLTextAreaElement) return node.value ?? '';
	      return node.innerText ?? '';
	    };
	    const isVisible = (node) => {
	      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
	      const rect = node.getBoundingClientRect();
	      return rect.width > 0 && rect.height > 0;
	    };
	    const inputs = inputSelectors
	      .map((selector) => document.querySelector(selector))
	      .filter((node) => Boolean(node));
	    const visibleInputs = inputs.filter((node) => isVisible(node));
	    const activeInputs = visibleInputs.length > 0 ? visibleInputs : inputs;
	    const userMatched =
	      normalizedPrompt.length > 0 && normalizedTurns.some((text) => text.includes(normalizedPrompt));
	    const prefixMatched =
	      normalizedPromptPrefix.length > 30 &&
	      normalizedTurns.some((text) => text.includes(normalizedPromptPrefix));
		    const lastTurn = normalizedTurns[normalizedTurns.length - 1] ?? '';
		    const lastMatched =
		      normalizedPrompt.length > 0 &&
		      (lastTurn.includes(normalizedPrompt) ||
		        (normalizedPromptPrefix.length > 30 && lastTurn.includes(normalizedPromptPrefix)));
		    const baseline = ${baselineLiteral};
		    const hasNewTurn = baseline < 0 ? false : normalizedTurns.length > baseline;
		    const stopVisible = Boolean(document.querySelector(${stopSelectorLiteral}));
		    const assistantVisible = Boolean(
		      document.querySelector(${assistantSelectorLiteral}) ||
		      document.querySelector('[data-testid*="assistant"]'),
		    );
	    // Learned: composer clearing + stop button or assistant presence is a reliable fallback signal.
      const editorValue = editor?.innerText ?? '';
      const fallbackValue = fallback?.value ?? '';
      const activeEmpty =
        activeInputs.length === 0 ? null : activeInputs.every((node) => !String(readValue(node)).trim());
      const composerCleared = activeEmpty ?? !(String(editorValue).trim() || String(fallbackValue).trim());
      const href = typeof location === 'object' && location.href ? location.href : '';
      const inConversation = /\\/c\\//.test(href);
		    return {
        baseline,
	      userMatched,
	      prefixMatched,
	      lastMatched,
	      hasNewTurn,
	      stopVisible,
      assistantVisible,
      composerCleared,
      inConversation,
      href,
      fallbackValue,
      editorValue,
      lastTurn,
      turnsCount: normalizedTurns.length,
    };
  })()`;

  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    const info = result.value as {
      baseline?: number;
      userMatched?: boolean;
      prefixMatched?: boolean;
      lastMatched?: boolean;
      hasNewTurn?: boolean;
      stopVisible?: boolean;
      assistantVisible?: boolean;
      composerCleared?: boolean;
      inConversation?: boolean;
      turnsCount?: number;
    };
    const turnsCount = (result.value as { turnsCount?: number } | undefined)?.turnsCount;
    const matchesPrompt = Boolean(info?.lastMatched || info?.userMatched || info?.prefixMatched);
    const baselineUnknown =
      typeof info?.baseline === "number" ? info.baseline < 0 : baselineLiteral < 0;
    if (matchesPrompt && (baselineUnknown || info?.hasNewTurn)) {
      return typeof turnsCount === "number" && Number.isFinite(turnsCount) ? turnsCount : null;
    }
    const fallbackCommit =
      info?.composerCleared &&
      Boolean(info?.hasNewTurn) &&
      ((info?.stopVisible ?? false) || info?.assistantVisible || info?.inConversation);
    if (fallbackCommit) {
      return typeof turnsCount === "number" && Number.isFinite(turnsCount) ? turnsCount : null;
    }
    await delay(100);
  }
  if (logger) {
    logger(
      `Prompt commit check failed; latest state: ${await Runtime.evaluate({
        expression: script,
        returnByValue: true,
      })
        .then((res) => JSON.stringify(res?.result?.value))
        .catch(() => "unavailable")}`,
    );
    await logDomFailure(Runtime, logger, "prompt-commit");
  }
  if (prompt.trim().length >= 50_000) {
    throw new BrowserAutomationError(
      "Prompt did not appear in conversation before timeout (likely too large).",
      {
        stage: "submit-prompt",
        code: "prompt-too-large",
        promptLength: prompt.trim().length,
        timeoutMs,
      },
    );
  }
  throw new Error("Prompt did not appear in conversation before timeout (send may have failed)");
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  attemptSendButton,
  buildPromptAcceptanceProbeExpression,
  waitForPromptAccepted,
  verifyPromptCommitted,
};
