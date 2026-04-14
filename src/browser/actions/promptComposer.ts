import type { ChromeClient, BrowserLogger } from "../types.js";
import {
  INPUT_SELECTORS,
  PROMPT_PRIMARY_SELECTOR,
  PROMPT_FALLBACK_SELECTOR,
  SEND_BUTTON_SELECTORS,
  STOP_BUTTON_SELECTOR,
  ASSISTANT_ROLE_SELECTOR,
} from "../constants.js";
import { delay } from "../utils.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import { buildThreadIntrospectionHelpers } from "../threadIntrospection.js";

const ENTER_KEY_EVENT = {
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
} as const;
const ENTER_KEY_TEXT = "\r";

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

  if (observedLength > 0) {
    await nudgePromptComposerState(runtime);
    await delay(250);
  }

  let clicked = await attemptSendButton(runtime, logger, deps?.attachmentNames);
  if (!clicked && observedLength > 0) {
    await nudgePromptComposerState(runtime);
    await delay(250);
    clicked = await attemptSendButton(runtime, logger, deps?.attachmentNames);
    if (clicked) {
      logger("Clicked send button after composer state nudge");
    }
  }
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

  const commitTimeoutMs = Math.max(60_000, deps.inputTimeoutMs ?? 0);
  // Learned: the send button can succeed but the turn doesn't appear immediately; verify commit via turns/stop button.
  try {
    return await verifyPromptCommitted(
      runtime,
      prompt,
      commitTimeoutMs,
      logger,
      deps.baselineTurns ?? undefined,
    );
  } catch (error) {
    if (error instanceof BrowserAutomationError) {
      throw new BrowserAutomationError(
        error.message,
        {
          ...(typeof error.details === "object" && error.details ? error.details : {}),
          stage: "submit-prompt",
          promptSubmitted: true,
          submittedPrompt: prompt,
          baselineTurns: deps.baselineTurns ?? null,
        },
        error,
      );
    }
    throw new BrowserAutomationError(
      error instanceof Error
        ? error.message
        : "Prompt commit verification failed after sending the prompt.",
      {
        stage: "submit-prompt",
        promptSubmitted: true,
        submittedPrompt: prompt,
        baselineTurns: deps.baselineTurns ?? null,
      },
      error,
    );
  }
}

export async function clearPromptComposer(Runtime: ChromeClient["Runtime"], logger: BrowserLogger) {
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const result = await Runtime.evaluate({
    expression: `(() => {
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const editor = document.querySelector(${primarySelectorLiteral});
      const inputSelectors = ${inputSelectorsLiteral};
      let cleared = false;
      if (fallback) {
        fallback.value = '';
        fallback.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
        fallback.dispatchEvent(new Event('change', { bubbles: true }));
        cleared = true;
      }
      if (editor) {
        editor.textContent = '';
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
        cleared = true;
      }
      const nodes = inputSelectors
        .map((selector) => document.querySelector(selector))
        .filter((node) => Boolean(node));
      for (const node of nodes) {
        if (!node) continue;
        if (node instanceof HTMLTextAreaElement) {
          node.value = '';
          node.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          cleared = true;
          continue;
        }
        if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') {
          node.textContent = '';
          node.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
          cleared = true;
        }
      }
      return { cleared };
    })()`,
    returnByValue: true,
  });
  if (!result.result?.value?.cleared) {
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

async function nudgePromptComposerState(Runtime: ChromeClient["Runtime"]): Promise<void> {
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  await Runtime.evaluate({
    expression: `(() => {
      const editor = document.querySelector(${primarySelectorLiteral});
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const inputSelectors = ${inputSelectorsLiteral};
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
      const nodes = Array.from(new Set([editor, fallback, ...activeInputs].filter(Boolean)));
      for (const node of nodes) {
        const text =
          node instanceof HTMLTextAreaElement ? (node.value ?? "") : ((node.innerText ?? "") as string);
        if (!String(text).trim()) continue;
        if (typeof node.focus === "function") {
          node.focus();
        }
        if (node instanceof HTMLTextAreaElement) {
          node.dispatchEvent(
            new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }),
          );
          node.dispatchEvent(new Event("change", { bubbles: true }));
          continue;
        }
        node.dispatchEvent(
          new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }),
        );
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
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
    const roots = Array.from(new Set([composer, document.body, document].filter(Boolean)));
    const match = (node, name) => (node?.textContent || '').toLowerCase().includes(name);

    // Restrict to attachment affordances; never scan generic div/span nodes (prompt text can contain the file name).
    const attachmentSelectors = [
      '[data-testid*="chip"]',
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[aria-label="Remove file"]',
      'button[aria-label="Remove file"]',
    ];

    const attachmentNodes = roots.flatMap((root) =>
      Array.from(root.querySelectorAll(attachmentSelectors.join(','))),
    );
    const fileInputs = roots.flatMap((root) => Array.from(root.querySelectorAll('input[type="file"]')));

    const chipsReady = names.every((name) =>
      attachmentNodes.some((node) => match(node, name)),
    );
    const inputsReady = names.every((name) =>
      fileInputs.some((el) =>
        Array.from((el instanceof HTMLInputElement ? el.files : []) || []).some((file) =>
          file?.name?.toLowerCase?.().includes(name),
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
    let button = null;
    for (const selector of selectors) {
      button = document.querySelector(selector);
      if (button) break;
    }
    if (!button) return 'missing';
    const ariaDisabled = button.getAttribute('aria-disabled');
    const dataDisabled = button.getAttribute('data-disabled');
    const style = window.getComputedStyle(button);
    const disabled =
      button.hasAttribute('disabled') ||
      ariaDisabled === 'true' ||
      dataDisabled === 'true' ||
      style.pointerEvents === 'none' ||
      style.display === 'none';
    // Learned: some send buttons render but are inert; only click when truly enabled.
    if (disabled) return 'disabled';
    // Use unified pointer/mouse sequence to satisfy React handlers.
    dispatchClickSequence(button);
    return 'clicked';
  })()`;

  const deadline = Date.now() + 8_000;
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
  return false;
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
  let baseline: number | null =
    typeof baselineTurns === "number" && Number.isFinite(baselineTurns) && baselineTurns >= 0
      ? Math.floor(baselineTurns)
      : null;
  if (baseline === null) {
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
      ${buildThreadIntrospectionHelpers()}
      const editor = document.querySelector(${primarySelectorLiteral});
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const inputSelectors = ${inputSelectorsLiteral};
      const normalize = (value) => {
        let text = value?.toLowerCase?.() ?? '';
        text = text.replace(/\`\`\`[^\\n]*\\n([\\s\\S]*?)\`\`\`/g, ' $1 ');
        text = text.replace(/\`\`\`/g, ' ');
        text = text.replace(/\`([^\`]*)\`/g, '$1');
        text = text.replace(/\\s+/g, ' ').trim();
        return text.replace(/^you said\\s*:?\\s*/, '');
      };
      const entries = __oracleCollectThreadEntries(__oraclePickThreadRoot()).filter(
        (entry) => entry.role === 'user' || entry.role === 'assistant',
      );
      const normalizedPrompt = normalize(${encodedPrompt});
      const normalizedPromptPrefix = normalizedPrompt.slice(0, 60);
      const normalizedTurns = entries.map((entry) => normalize(entry.text));
      const turnRoles = entries.map((entry) => entry.role);
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
      const baseline = ${baselineLiteral};
      const hasNewTurn = baseline < 0 ? false : normalizedTurns.length > baseline;
      const postBaselineTurnTexts =
        baseline < 0 ? normalizedTurns : normalizedTurns.slice(Math.max(0, baseline));
      const postBaselineTurnRoles =
        baseline < 0 ? turnRoles : turnRoles.slice(Math.max(0, baseline));
      const postBaselineUserTurns = postBaselineTurnTexts.filter(
        (_text, index) => postBaselineTurnRoles[index] === 'user',
      );
      const searchableTurns =
        postBaselineUserTurns.length > 0
          ? postBaselineUserTurns
          : (postBaselineTurnTexts.length > 0 ? postBaselineTurnTexts : normalizedTurns);
      const userMatched =
        normalizedPrompt.length > 0 &&
        searchableTurns.some((text) => text.includes(normalizedPrompt));
      const prefixMatched =
        normalizedPromptPrefix.length > 30 &&
        searchableTurns.some((text) => text.includes(normalizedPromptPrefix));
      const lastTurn =
        (postBaselineUserTurns.length > 0
          ? postBaselineUserTurns[postBaselineUserTurns.length - 1]
          : postBaselineTurnTexts.length > 0
            ? postBaselineTurnTexts[postBaselineTurnTexts.length - 1]
            : normalizedTurns[normalizedTurns.length - 1]) ?? '';
      const lastMatched =
        normalizedPrompt.length > 0 &&
        (lastTurn.includes(normalizedPrompt) ||
          (normalizedPromptPrefix.length > 30 && lastTurn.includes(normalizedPromptPrefix)));
      const stopVisible = Boolean(document.querySelector(${stopSelectorLiteral}));
      const assistantVisible = Boolean(
        document.querySelector(${assistantSelectorLiteral}) ||
        document.querySelector('[data-testid*="assistant"]'),
      );
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
    const homePageMatchedCommit =
      matchesPrompt &&
      !info?.inConversation &&
      Boolean(info?.composerCleared) &&
      ((info?.stopVisible ?? false) || Boolean(info?.assistantVisible));
    const baselineUnknown =
      typeof info?.baseline === "number" ? info.baseline < 0 : baselineLiteral < 0;
    if (matchesPrompt && (baselineUnknown || info?.hasNewTurn || homePageMatchedCommit)) {
      return typeof turnsCount === "number" && Number.isFinite(turnsCount) ? turnsCount : null;
    }
    const generationCommit =
      info?.composerCleared &&
      Boolean(info?.hasNewTurn) &&
      Boolean(info?.stopVisible || info?.assistantVisible);
    const homePageCommit =
      info?.composerCleared &&
      (info?.stopVisible ?? false) &&
      !info?.inConversation &&
      !info?.assistantVisible &&
      (info?.turnsCount ?? 0) === 0 &&
      ((typeof info?.baseline === "number" && info.baseline === 0) || baselineLiteral === 0);
    if (generationCommit || homePageCommit) {
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
  verifyPromptCommitted,
};
