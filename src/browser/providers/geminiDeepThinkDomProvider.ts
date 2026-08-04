import { normalizePromptForIdentity } from "../actions/promptComposer.js";
import type {
  PromptCommitEvidence,
  ProviderDomAdapter,
  ProviderDomFlowContext,
} from "../providerDomFlow.js";
import { joinSelectors } from "../providerDomFlow.js";

const UI_TIMEOUT_MS = 60_000;
const RESPONSE_TIMEOUT_MS = 10 * 60_000;

interface GeminiPromptBaseline {
  userQueryCount: number;
  responseCount: number;
  normalizedPrompt: string;
}

interface GeminiDomProviderState {
  inputTimeoutMs?: number;
  timeoutMs?: number;
  geminiPromptBaseline?: GeminiPromptBaseline;
}

export const GEMINI_DEEP_THINK_SELECTORS = {
  input: [
    "rich-textarea .ql-editor",
    '[role="textbox"][aria-label*="prompt" i]',
    'div[contenteditable="true"]',
  ],
  sendButton: ["button.send-button", 'button[aria-label="Send message"]'],
  toolsButton: ["button.toolbox-drawer-button", 'button[aria-label="Tools"]'],
  toolsMenuItem: ['[role="menuitemcheckbox"]', ".toolbox-drawer-item-list-button"],
  deepThinkActive: [
    ".toolbox-drawer-item-deselect-button",
    'button[aria-label*="Deselect Deep Think"]',
  ],
  uploadButton: ['button[aria-label="Open upload file menu"]', ".upload-card-button"],
  uploadMenuItem: ['[role="menuitem"]'],
  uploadTrigger: [".hidden-local-file-upload-button", ".hidden-local-upload-button"],
  uploaderContainer: [".uploader-button-container", ".file-uploader"],
  uploaderElement: ["uploader.upload-button"],
  userTurnAttachment: [".file-preview-container"],
  responseTurn: ["model-response"],
  responseText: ["message-content", ".model-response-text message-content"],
  responseComplete: [".response-footer.complete"],
  userQuery: ["user-query"],
  userQueryText: ["user-query-content", ".query-text"],
  spinner: ['[role="progressbar"]'],
  thoughtsToggle: [".thoughts-header-button", '[data-test-id="thoughts-header-button"]'],
  thoughtsContent: ["model-thoughts", '[data-test-id="model-thoughts"]'],
  hasThoughts: [".has-thoughts"],
} as const;

function asSelectorLiteral(selectors: readonly string[]): string {
  return JSON.stringify(joinSelectors(selectors));
}

function readTimeouts(ctx: ProviderDomFlowContext): {
  uiTimeoutMs: number;
  responseTimeoutMs: number;
} {
  const state = ctx.state as GeminiDomProviderState | undefined;
  const uiTimeoutMs =
    typeof state?.inputTimeoutMs === "number" && Number.isFinite(state.inputTimeoutMs)
      ? Math.max(1_000, state.inputTimeoutMs)
      : UI_TIMEOUT_MS;
  const responseTimeoutMs =
    typeof state?.timeoutMs === "number" && Number.isFinite(state.timeoutMs)
      ? Math.max(1_000, state.timeoutMs)
      : RESPONSE_TIMEOUT_MS;
  return { uiTimeoutMs, responseTimeoutMs };
}
function requireGeminiState(ctx: ProviderDomFlowContext): GeminiDomProviderState {
  if (!ctx.state) {
    throw new Error(
      "Gemini Deep Think DOM flow requires provider state to bind its response to the submitted prompt.",
    );
  }
  return ctx.state as GeminiDomProviderState;
}

function parsePromptBaseline(payload: string | undefined, prompt: string): GeminiPromptBaseline {
  try {
    const parsed = JSON.parse(payload ?? "{}") as {
      userQueryCount?: unknown;
      responseCount?: unknown;
    };
    if (
      !Number.isSafeInteger(parsed.userQueryCount) ||
      !Number.isSafeInteger(parsed.responseCount) ||
      (parsed.userQueryCount as number) < 0 ||
      (parsed.responseCount as number) < 0
    ) {
      throw new Error("invalid counts");
    }
    return {
      userQueryCount: parsed.userQueryCount as number,
      responseCount: parsed.responseCount as number,
      normalizedPrompt: normalizePromptForIdentity(prompt),
    };
  } catch {
    throw new Error("Failed to capture Gemini DOM baselines before submitting the prompt.");
  }
}

function requirePromptBaseline(ctx: ProviderDomFlowContext): GeminiPromptBaseline {
  const baseline = requireGeminiState(ctx).geminiPromptBaseline;
  if (!baseline) {
    throw new Error("Gemini Deep Think response polling requires a pre-dispatch prompt baseline.");
  }
  return baseline;
}

async function waitForUi(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.("[gemini-web] Waiting for Gemini UI to load...");
  const inputSelector = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.input);
  const { uiTimeoutMs } = readTimeouts(ctx);
  const uiDeadline = Date.now() + uiTimeoutMs;
  let uiReady = false;
  let sawLoginRedirect = false;

  while (Date.now() < uiDeadline) {
    const state = await ctx.evaluate<{ ready?: boolean; requiresLogin?: boolean }>(
      `(() => {
        const editor = document.querySelector(${inputSelector});
        const href = location.href || '';
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const requiresLogin =
          href.includes('accounts.google.com') ||
          (bodyText.includes('sign in') && bodyText.includes('google'));
        return { ready: Boolean(editor), requiresLogin };
      })()`,
    );
    if (state?.ready) {
      uiReady = true;
      break;
    }
    if (state?.requiresLogin) {
      sawLoginRedirect = true;
    }
    await ctx.delay(1_000);
  }

  if (!uiReady) {
    if (sawLoginRedirect) {
      throw new Error("Gemini is showing a sign-in flow. Please sign in in Chrome and retry.");
    }
    throw new Error("Timed out waiting for Gemini UI prompt input to become ready.");
  }
}

async function selectMode(ctx: ProviderDomFlowContext): Promise<void> {
  const toolsButtonSelectors = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.toolsButton);
  const toolsClickResult = await ctx.evaluate<string>(
    `(() => {
      const btn = document.querySelector(${toolsButtonSelectors});
      if (btn instanceof HTMLElement) {
        btn.click();
        return 'clicked';
      }
      return 'not-found';
    })()`,
  );
  if (toolsClickResult !== "clicked") {
    throw new Error("Unable to open Gemini tools menu; Deep Think toggle is not accessible.");
  }
  await ctx.delay(1_000);

  const deepThinkItemSelectors = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.toolsMenuItem);
  const deepThinkClickResult = await ctx.evaluate<string>(
    `(() => {
      const items = Array.from(document.querySelectorAll(${deepThinkItemSelectors}));
      for (const item of items) {
        const text = item.textContent?.trim().toLowerCase() ?? '';
        if (!text.includes('deep think')) continue;
        if (item instanceof HTMLElement) item.click();
        return 'clicked';
      }
      return 'not-found';
    })()`,
  );
  if (deepThinkClickResult !== "clicked") {
    throw new Error('Unable to select "Deep Think" from Gemini tools menu.');
  }
  await ctx.delay(1_500);

  const deepThinkActiveSelectors = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.deepThinkActive);
  const deepThinkActive = await ctx.evaluate<boolean>(
    `(() => {
      const active = document.querySelector(${deepThinkActiveSelectors});
      if (!(active instanceof HTMLElement)) return false;
      const label = active.getAttribute('aria-label')?.toLowerCase() ?? '';
      const text = active.textContent?.toLowerCase() ?? '';
      return label.includes('deep think') || text.includes('deep think');
    })()`,
  );
  if (!deepThinkActive) {
    throw new Error("Deep Think did not appear selected after clicking the tools menu item.");
  }
}

async function typePrompt(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.("[gemini-web] Typing prompt...");
  const inputSelector = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.input);
  const typeResult = await ctx.evaluate<string>(
    `(() => {
      const editor = document.querySelector(${inputSelector});
      if (!(editor instanceof HTMLElement)) return 'no-editor';
      editor.focus();
      editor.textContent = '';
      if (typeof document.execCommand === 'function') {
        document.execCommand('insertText', false, ${JSON.stringify(ctx.prompt)});
      } else {
        editor.textContent = ${JSON.stringify(ctx.prompt)};
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(ctx.prompt)} }));
      }
      const typed = (editor.textContent || '').trim().length > 0;
      return typed ? 'typed' : 'empty';
    })()`,
  );
  if (typeResult !== "typed") {
    throw new Error(`Failed to type Gemini prompt (status=${typeResult ?? "unknown"}).`);
  }
  await ctx.delay(500);
}

async function submitPrompt(ctx: ProviderDomFlowContext): Promise<PromptCommitEvidence> {
  ctx.log?.("[gemini-web] Sending prompt...");
  const inputSelector = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.input);
  const sendButtonSelectors = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.sendButton);
  const userQuerySelector = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.userQuery);
  const responseTurnSelector = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseTurn);
  const baselinePayload = await ctx.evaluate<string>(
    `(() => JSON.stringify({
      userQueryCount: document.querySelectorAll(${userQuerySelector}).length,
      responseCount: document.querySelectorAll(${responseTurnSelector}).length,
    }))()`,
  );
  requireGeminiState(ctx).geminiPromptBaseline = parsePromptBaseline(baselinePayload, ctx.prompt);

  const sendResult = await ctx.evaluate<string>(
    `(() => {
      const btn = document.querySelector(${sendButtonSelectors});
      if (btn instanceof HTMLElement) {
        btn.click();
        return 'clicked';
      }
      const editor = document.querySelector(${inputSelector});
      if (editor instanceof HTMLElement) {
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        return 'enter';
      }
      return 'not-found';
    })()`,
  );
  if (sendResult !== "clicked" && sendResult !== "enter") {
    throw new Error("Failed to submit prompt in Gemini Deep Think mode (send control not found).");
  }
  return { status: "attempted" };
}

async function waitForResponse(ctx: ProviderDomFlowContext): Promise<{ text: string }> {
  ctx.log?.("[gemini-web] Waiting for Deep Think response (this may take a while)...");
  const responseTurnSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseTurn);
  const responseTextSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseText);
  const responseCompleteSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseComplete);
  const spinnerSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.spinner);
  const userQuerySel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.userQuery);
  const userQueryTextSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.userQueryText);
  const baseline = requirePromptBaseline(ctx);
  const { responseTimeoutMs } = readTimeouts(ctx);
  const responseDeadline = Date.now() + responseTimeoutMs;
  let lastLog = 0;
  let responseText = "";

  while (Date.now() < responseDeadline) {
    const payload = await ctx.evaluate<string>(
      `(() => {
        const normalize = (value) => String(value ?? '')
          .toLowerCase()
          .replace(/\`\`\`[^\\n]*\\n([\\s\\S]*?)\`\`\`/g, ' $1 ')
          .replace(/\`\`\`/g, ' ')
          .replace(/\`([^\`]*)\`/g, '$1')
          .replace(/\\s+/g, ' ')
          .trim();
        const userTurns = Array.from(document.querySelectorAll(${userQuerySel}));
        const responseTurns = Array.from(document.querySelectorAll(${responseTurnSel}));
        const entries = [
          ...userTurns.map((node, index) => ({
            node,
            kind: 'user',
            postBaseline: index >= ${baseline.userQueryCount},
            text: node.querySelector(${userQueryTextSel})?.textContent?.trim() ?? node.textContent?.trim() ?? '',
          })),
          ...responseTurns.map((node, index) => {
            const text = node.querySelector(${responseTextSel})?.textContent?.trim() ?? '';
            const lower = text.toLowerCase();
            return {
              node,
              kind: 'response',
              postBaseline: index >= ${baseline.responseCount},
              text,
              completed: Boolean(node.querySelector(${responseCompleteSel})) && text.length > 0 &&
                !lower.includes('generating your response') &&
                !lower.includes('check back later') &&
                !lower.includes("i'm on it"),
            };
          }),
        ].sort((left, right) => {
          if (left.node === right.node) return 0;
          return left.node.compareDocumentPosition(right.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        });
        const completed = entries
          .filter((entry) => entry.kind === 'response' && entry.postBaseline && entry.completed)
          .reverse()
          .find((entry) => {
            for (let index = entries.indexOf(entry) - 1; index >= 0; index -= 1) {
              const preceding = entries[index];
              if (preceding.kind !== 'user') continue;
              return preceding.postBaseline && normalize(preceding.text) === ${JSON.stringify(baseline.normalizedPrompt)};
            }
            return false;
          });
        if (completed) {
          return JSON.stringify({ status: 'done', text: completed.text, causalPair: true });
        }
        const postBaselineResponses = entries.filter(
          (entry) => entry.kind === 'response' && entry.postBaseline,
        );
        const lastTurn = postBaselineResponses[postBaselineResponses.length - 1]?.node;
        const visibleSpinners = Array.from(lastTurn?.querySelectorAll(${spinnerSel}) ?? []).filter((spinner) => {
          if (spinner.hidden || spinner.getAttribute?.('aria-hidden') === 'true') return false;
          const rect = typeof spinner.getBoundingClientRect === 'function'
            ? spinner.getBoundingClientRect()
            : null;
          return !rect || (rect.width > 0 && rect.height > 0);
        });
        return JSON.stringify({
          status: postBaselineResponses.length === 0 ? 'waiting' : visibleSpinners.length > 0 ? 'generating' : 'streaming',
          causalPair: false,
        });
      })()`,
    );

    try {
      const parsed = JSON.parse(payload ?? "{}") as {
        status?: string;
        text?: string;
        causalPair?: unknown;
      };
      if (
        parsed.causalPair === true &&
        parsed.status === "done" &&
        typeof parsed.text === "string" &&
        parsed.text.length > 0
      ) {
        responseText = parsed.text;
        break;
      }
      const now = Date.now();
      if (now - lastLog > 10_000) {
        const status =
          parsed.causalPair === true ? (parsed.status ?? "unknown") : "awaiting causal pair";
        ctx.log?.(`[gemini-web] Deep Think still generating... (${status})`);
        lastLog = now;
      }
    } catch {
      // Ignore malformed DOM probes while polling.
    }
    await ctx.delay(3_000);
  }

  if (!responseText) {
    throw new Error(
      `Deep Think timed out waiting for response (${Math.ceil(responseTimeoutMs / 1000)} seconds).`,
    );
  }
  return { text: responseText };
}

async function extractThoughts(ctx: ProviderDomFlowContext): Promise<string | null> {
  const thoughtsToggleSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.thoughtsToggle);
  const thoughtsContentSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.thoughtsContent);

  const thinkResult = await ctx.evaluate<string>(
    `(() => {
      const toggle = document.querySelector(${thoughtsToggleSel});
      if (!(toggle instanceof HTMLElement)) return 'no-toggle';
      toggle.click();
      return 'clicked';
    })()`,
  );
  if (thinkResult !== "clicked") {
    return null;
  }

  await ctx.delay(1_500);
  const extractedThoughts = await ctx.evaluate<string>(
    `(() => {
      const el = document.querySelector(${thoughtsContentSel});
      if (!el) return '';
      const full = el.textContent?.trim() ?? '';
      const btn = el.querySelector('.thoughts-header-button, [data-test-id="thoughts-header-button"]');
      const btnText = btn?.textContent?.trim() ?? '';
      if (btnText && full.startsWith(btnText)) {
        return full.slice(btnText.length).trim();
      }
      return full;
    })()`,
  );
  return typeof extractedThoughts === "string" && extractedThoughts.length > 0
    ? extractedThoughts
    : null;
}

export const geminiDeepThinkDomProvider: ProviderDomAdapter = {
  providerName: "gemini-web",
  waitForUi,
  selectMode,
  typePrompt,
  submitPrompt,
  waitForResponse,
  extractThoughts,
};
