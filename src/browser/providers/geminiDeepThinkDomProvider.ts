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
  dispatchNonce: string;
}

interface GeminiDomProviderState {
  inputTimeoutMs?: number;
  timeoutMs?: number;
  geminiPromptBaseline?: GeminiPromptBaseline;
}

interface GeminiRawTurnDescriptor {
  kind: "user" | "response";
  postBaseline: boolean;
  text: string;
  boundToDispatch?: boolean;
  completionMarked?: boolean;
  visibleSpinner?: boolean;
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

function parseSubmissionProbe(
  payload: string | undefined,
  prompt: string,
  dispatchNonce: string,
): {
  baseline: GeminiPromptBaseline;
  sendResult: string;
  boundNonce: string | null;
} {
  try {
    const parsed = JSON.parse(payload ?? "{}") as {
      userQueryCount?: unknown;
      responseCount?: unknown;
      sendResult?: unknown;
      boundNonce?: unknown;
    };
    if (
      !Number.isSafeInteger(parsed.userQueryCount) ||
      !Number.isSafeInteger(parsed.responseCount) ||
      (parsed.userQueryCount as number) < 0 ||
      (parsed.responseCount as number) < 0 ||
      typeof parsed.sendResult !== "string" ||
      (typeof parsed.boundNonce !== "string" && parsed.boundNonce !== null)
    ) {
      throw new Error("invalid submission probe");
    }
    return {
      baseline: {
        userQueryCount: parsed.userQueryCount as number,
        responseCount: parsed.responseCount as number,
        normalizedPrompt: normalizePromptForIdentity(prompt),
        dispatchNonce,
      },
      sendResult: parsed.sendResult,
      boundNonce: parsed.boundNonce,
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
function parseResponseProbe(payload: string | undefined): GeminiRawTurnDescriptor[] | null {
  try {
    const parsed = JSON.parse(payload ?? "{}") as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return null;
    const entries: GeminiRawTurnDescriptor[] = [];
    for (const entry of parsed.entries) {
      if (
        !entry ||
        typeof entry !== "object" ||
        ((entry as { kind?: unknown }).kind !== "user" &&
          (entry as { kind?: unknown }).kind !== "response") ||
        typeof (entry as { postBaseline?: unknown }).postBaseline !== "boolean" ||
        typeof (entry as { text?: unknown }).text !== "string"
      ) {
        return null;
      }
      const descriptor = entry as {
        kind: "user" | "response";
        postBaseline: boolean;
        text: string;
        boundToDispatch?: unknown;
        completionMarked?: unknown;
        visibleSpinner?: unknown;
      };
      entries.push({
        kind: descriptor.kind,
        postBaseline: descriptor.postBaseline,
        text: descriptor.text,
        ...(descriptor.kind === "user"
          ? { boundToDispatch: descriptor.boundToDispatch === true }
          : {
              completionMarked: descriptor.completionMarked === true,
              visibleSpinner: descriptor.visibleSpinner === true,
            }),
      });
    }
    return entries;
  } catch {
    return null;
  }
}

function isCompletedGeminiResponse(
  entry: GeminiRawTurnDescriptor,
): entry is GeminiRawTurnDescriptor & {
  kind: "response";
} {
  if (entry.kind !== "response" || entry.completionMarked !== true) return false;
  const text = entry.text.trim();
  const lower = text.toLowerCase();
  return (
    text.length > 0 &&
    !lower.includes("generating your response") &&
    !lower.includes("check back later") &&
    !lower.includes("i'm on it")
  );
}

function findCausallyPairedResponse(
  entries: GeminiRawTurnDescriptor[],
  normalizedPrompt: string,
): GeminiRawTurnDescriptor | null {
  const boundUserIndexes: number[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.kind === "user" && entry.boundToDispatch === true) boundUserIndexes.push(index);
  }
  if (boundUserIndexes.length !== 1) return null;

  const submittedUserIndex = boundUserIndexes[0];
  const submittedUser = entries[submittedUserIndex];
  if (
    !submittedUser.postBaseline ||
    normalizePromptForIdentity(submittedUser.text) !== normalizedPrompt
  ) {
    return null;
  }

  for (let responseIndex = entries.length - 1; responseIndex >= 0; responseIndex -= 1) {
    const response = entries[responseIndex];
    if (!response.postBaseline || !isCompletedGeminiResponse(response)) continue;
    for (let index = responseIndex - 1; index >= 0; index -= 1) {
      if (entries[index].kind !== "user") continue;
      if (index === submittedUserIndex) return response;
      break;
    }
  }
  return null;
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
  const dispatchNonce = `oracle-gemini-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dispatchNonceLiteral = JSON.stringify(dispatchNonce);
  const submissionPayload = await ctx.evaluate<string>(
    `(() => {
      const beforeUserTurns = Array.from(document.querySelectorAll(${userQuerySelector}));
      const responseCount = document.querySelectorAll(${responseTurnSelector}).length;
      const btn = document.querySelector(${sendButtonSelectors});
      let sendResult = 'not-found';
      if (btn instanceof HTMLElement) {
        btn.click();
        sendResult = 'clicked';
      } else {
        const editor = document.querySelector(${inputSelector});
        if (editor instanceof HTMLElement) {
          editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
          editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
          sendResult = 'enter';
        }
      }
      const newUserTurns = Array.from(document.querySelectorAll(${userQuerySelector})).filter(
        (node) => !beforeUserTurns.includes(node),
      );
      const boundTurn = newUserTurns.length === 1 ? newUserTurns[0] : null;
      if (boundTurn) {
        Object.defineProperty(boundTurn, '__oracleGeminiDispatchNonce', {
          configurable: true,
          value: ${dispatchNonceLiteral},
        });
      }
      return JSON.stringify({
        userQueryCount: beforeUserTurns.length,
        responseCount,
        sendResult,
        boundNonce: boundTurn?.__oracleGeminiDispatchNonce ?? null,
      });
    })()`,
  );
  const submission = parseSubmissionProbe(submissionPayload, ctx.prompt, dispatchNonce);
  if (submission.sendResult !== "clicked" && submission.sendResult !== "enter") {
    throw new Error("Failed to submit prompt in Gemini Deep Think mode (send control not found).");
  }
  if (submission.boundNonce !== dispatchNonce) {
    throw new Error("Failed to bind Gemini response to the newly submitted user turn.");
  }
  requireGeminiState(ctx).geminiPromptBaseline = submission.baseline;
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
        const isVisible = (element) => {
          if (element.hidden || element.getAttribute?.('aria-hidden') === 'true') return false;
          const rect = typeof element.getBoundingClientRect === 'function'
            ? element.getBoundingClientRect()
            : null;
          return !rect || (rect.width > 0 && rect.height > 0);
        };
        const userTurns = Array.from(document.querySelectorAll(${userQuerySel}));
        const responseTurns = Array.from(document.querySelectorAll(${responseTurnSel}));
        const ordered = [
          ...userTurns.map((node, index) => ({
            node,
            kind: 'user',
            postBaseline: index >= ${baseline.userQueryCount},
            text: node.querySelector(${userQueryTextSel})?.textContent ?? node.textContent ?? '',
            boundToDispatch: node.__oracleGeminiDispatchNonce === ${JSON.stringify(baseline.dispatchNonce)},
          })),
          ...responseTurns.map((node, index) => ({
            node,
            kind: 'response',
            postBaseline: index >= ${baseline.responseCount},
            text: node.querySelector(${responseTextSel})?.textContent ?? '',
            completionMarked: Boolean(node.querySelector(${responseCompleteSel})),
            visibleSpinner: Array.from(node.querySelectorAll(${spinnerSel})).some(isVisible),
          })),
        ].sort((left, right) => {
          if (left.node === right.node) return 0;
          return left.node.compareDocumentPosition(right.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        });
        return JSON.stringify({ entries: ordered.map(({ node, ...entry }) => entry) });
      })()`,
    );

    const entries = parseResponseProbe(payload);
    if (entries) {
      const pairedResponse = findCausallyPairedResponse(entries, baseline.normalizedPrompt);
      if (pairedResponse) {
        responseText = pairedResponse.text.trim();
        break;
      }
      const postBaselineResponses = entries.filter(
        (entry) => entry.kind === "response" && entry.postBaseline,
      );
      const status =
        postBaselineResponses.length === 0
          ? "waiting"
          : postBaselineResponses[postBaselineResponses.length - 1]?.visibleSpinner
            ? "generating"
            : "streaming";
      const now = Date.now();
      if (now - lastLog > 10_000) {
        ctx.log?.(`[gemini-web] Deep Think still generating... (${status})`);
        lastLog = now;
      }
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
