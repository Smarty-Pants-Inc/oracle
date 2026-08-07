import {
  buildPromptIdentityNormalizationExpression,
  normalizePromptForIdentity,
  promptIdentitySha256,
} from "../actions/committedPrompt.js";
import type { PromptCommitVerification } from "../actions/promptCommitVerification.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import type {
  PromptCommitEvidence,
  ProviderDomFlowContext,
  ProviderDomState,
} from "../providerDomFlow.js";
import {
  GEMINI_DEEP_THINK_SELECTORS,
  GEMINI_STABLE_ID_READER,
  geminiSelectorLiteral,
  pairGeminiPromptAndAssistant,
  readGeminiConversationSnapshot,
} from "./geminiConversationSnapshot.js";

const UI_TIMEOUT_MS = 60_000;
const RESPONSE_TIMEOUT_MS = 10 * 60_000;
const GEMINI_DOM_TURN_ID_PREFIX = "gemini-dom-turn:";

export interface GeminiPromptBaseline {
  userQueryCount: number;
  responseCount: number;
  promptSha256: string;
  userStableId: string | null;
}

export interface GeminiDeepThinkDomProviderState extends ProviderDomState<"gemini"> {
  inputTimeoutMs?: number;
  timeoutMs?: number;
  geminiConversationId?: string;
  geminiPromptBaseline?: GeminiPromptBaseline;
  geminiPromptCommitVerification?: PromptCommitVerification;
  geminiResponseStableId?: string;
}

export interface GeminiDeepThinkDomResponse {
  text: string;
}

export type GeminiDeepThinkDomFlowContext = ProviderDomFlowContext<GeminiDeepThinkDomProviderState>;

export function createGeminiDeepThinkDomProviderState(
  state: Omit<GeminiDeepThinkDomProviderState, "provider"> = {},
): GeminiDeepThinkDomProviderState {
  return { ...state, provider: "gemini" };
}

export function hasImmutableGeminiPromptIdentity(
  identity:
    | {
        status?: string;
        verifiedUserTurnId?: string;
        verifiedUserMessageId?: string;
      }
    | null
    | undefined,
): boolean {
  const userTurnId = identity?.verifiedUserTurnId?.trim();
  return Boolean(
    userTurnId &&
    identity?.verifiedUserMessageId?.trim() === userTurnId &&
    !userTurnId.startsWith(GEMINI_DOM_TURN_ID_PREFIX),
  );
}

function readTimeouts(ctx: GeminiDeepThinkDomFlowContext): {
  uiTimeoutMs: number;
  responseTimeoutMs: number;
} {
  const uiTimeoutMs =
    typeof ctx.state.inputTimeoutMs === "number" && Number.isFinite(ctx.state.inputTimeoutMs)
      ? Math.max(1_000, ctx.state.inputTimeoutMs)
      : UI_TIMEOUT_MS;
  const responseTimeoutMs =
    typeof ctx.state.timeoutMs === "number" && Number.isFinite(ctx.state.timeoutMs)
      ? Math.max(1_000, ctx.state.timeoutMs)
      : RESPONSE_TIMEOUT_MS;
  return { uiTimeoutMs, responseTimeoutMs };
}

function requireGeminiState(ctx: GeminiDeepThinkDomFlowContext): GeminiDeepThinkDomProviderState {
  if (ctx.state.provider !== "gemini") {
    throw new Error(
      "Gemini Deep Think DOM flow requires provider-bound state to own its response capture.",
    );
  }
  return ctx.state;
}

function parseSubmissionProbe(
  payload: string | undefined,
  prompt: string,
): {
  baseline: GeminiPromptBaseline | null;
  sendResult: string;
  bindingStatus: "bound" | "accepted" | "ambiguous" | "prompt-mismatch" | "timeout";
} {
  try {
    const decoded: unknown = JSON.parse(payload ?? "{}");
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("invalid submission probe");
    }
    if (
      !("userQueryCount" in decoded) ||
      !("responseCount" in decoded) ||
      !("sendResult" in decoded) ||
      !("bindingStatus" in decoded) ||
      !("userStableId" in decoded)
    ) {
      throw new Error("invalid submission probe");
    }
    const { userQueryCount, responseCount, sendResult, userStableId } = decoded;
    if (
      typeof userQueryCount !== "number" ||
      !Number.isSafeInteger(userQueryCount) ||
      userQueryCount < 0 ||
      typeof responseCount !== "number" ||
      !Number.isSafeInteger(responseCount) ||
      responseCount < 0 ||
      typeof sendResult !== "string" ||
      (typeof userStableId !== "string" && userStableId !== null)
    ) {
      throw new Error("invalid submission probe");
    }
    let bindingStatus: "bound" | "accepted" | "ambiguous" | "prompt-mismatch" | "timeout";
    switch (decoded.bindingStatus) {
      case "bound":
      case "accepted":
      case "ambiguous":
      case "prompt-mismatch":
      case "timeout":
        bindingStatus = decoded.bindingStatus;
        break;
      default:
        throw new Error("invalid submission probe");
    }
    const stableId = typeof userStableId === "string" && userStableId.trim() ? userStableId : null;
    if ((bindingStatus === "bound") !== Boolean(stableId)) {
      throw new Error("submission identity does not match binding status");
    }
    return {
      baseline:
        bindingStatus === "bound" || bindingStatus === "accepted"
          ? {
              userQueryCount,
              responseCount,
              promptSha256: promptIdentitySha256(prompt),
              userStableId: stableId,
            }
          : null,
      sendResult,
      bindingStatus,
    };
  } catch {
    throw new Error("Failed to capture Gemini DOM baselines before submitting the prompt.");
  }
}

function requirePromptBaseline(ctx: GeminiDeepThinkDomFlowContext): GeminiPromptBaseline {
  const baseline = requireGeminiState(ctx).geminiPromptBaseline;
  if (!baseline) {
    throw new Error("Gemini Deep Think response polling requires a pre-dispatch prompt baseline.");
  }
  return baseline;
}

export async function waitForGeminiDeepThinkUi(ctx: GeminiDeepThinkDomFlowContext): Promise<void> {
  ctx.log?.("[gemini-web] Waiting for Gemini UI to load...");
  const inputSelector = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.input);
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

export async function selectGeminiDeepThinkMode(ctx: GeminiDeepThinkDomFlowContext): Promise<void> {
  const toolsButtonSelectors = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.toolsButton);
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

  const deepThinkItemSelectors = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.toolsMenuItem);
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

  const deepThinkActiveSelectors = geminiSelectorLiteral(
    GEMINI_DEEP_THINK_SELECTORS.deepThinkActive,
  );
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

export async function typeGeminiDeepThinkPrompt(ctx: GeminiDeepThinkDomFlowContext): Promise<void> {
  ctx.log?.("[gemini-web] Typing prompt...");
  const inputSelector = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.input);
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

export async function submitGeminiDeepThinkPrompt(
  ctx: GeminiDeepThinkDomFlowContext,
): Promise<PromptCommitEvidence> {
  ctx.log?.("[gemini-web] Sending prompt...");
  const inputSelector = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.input);
  const sendButtonSelectors = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.sendButton);
  const userQuerySelector = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.userQuery);
  const userQueryTextSelector = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.userQueryText);
  const responseTurnSelector = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseTurn);
  const { uiTimeoutMs } = readTimeouts(ctx);
  const bindingTimeoutMs = Math.min(uiTimeoutMs, 10_000);
  const submissionPayload = await ctx.evaluate<string>(
    `(() => {
      const userQuerySelector = ${userQuerySelector};
      const beforeUserTurns = Array.from(document.querySelectorAll(userQuerySelector));
      const beforeUserCount = beforeUserTurns.length;
      const responseCount = document.querySelectorAll(${responseTurnSelector}).length;
      const expectedPrompt = ${JSON.stringify(normalizePromptForIdentity(ctx.prompt))};
      ${GEMINI_STABLE_ID_READER}
      ${buildPromptIdentityNormalizationExpression()}
      const beforeStableIds = new Set(beforeUserTurns.map(readStableId).filter(Boolean));
      const { promise, resolve } = Promise.withResolvers();
      let sendResult = 'not-found';
      let finished = false;
      let candidateTimer;
      let timeout;
      const observer = new MutationObserver(() => inspect());
      const finish = (bindingStatus, userStableId = null) => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(candidateTimer);
        clearTimeout(timeout);
        resolve(JSON.stringify({
          userQueryCount: beforeUserCount,
          responseCount,
          sendResult,
          bindingStatus,
          userStableId,
        }));
      };
      const scheduleFinish = (bindingStatus, userStableId = null) => {
        clearTimeout(candidateTimer);
        candidateTimer = setTimeout(() => {
          inspect();
          if (!finished) finish(bindingStatus, userStableId);
        }, 0);
      };
      function inspect() {
        if (finished) return;
        const postBaselineTurns = Array.from(document.querySelectorAll(userQuerySelector)).filter(
          (turn, index) => {
            const stableId = readStableId(turn);
            return index >= beforeUserCount || Boolean(stableId && !beforeStableIds.has(stableId));
          },
        );
        if (postBaselineTurns.length > 1) {
          scheduleFinish('ambiguous');
          return;
        }
        const turn = postBaselineTurns[0];
        if (!turn) return;
        const text = normalizePromptIdentity(
          turn.querySelector(${userQueryTextSelector})?.textContent ?? turn.textContent ?? '',
        );
        if (text && text !== expectedPrompt) {
          scheduleFinish('prompt-mismatch');
          return;
        }
        if (text !== expectedPrompt) return;
        const stableId = readStableId(turn);
        scheduleFinish(stableId ? 'bound' : 'accepted', stableId);
      }
      const root = document.documentElement ?? document.body;
      if (root) {
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: stableAttributes,
          characterData: true,
        });
      }
      const btn = document.querySelector(${sendButtonSelectors});
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
      if (sendResult === 'not-found') {
        finish('timeout');
        return promise;
      }
      inspect();
      timeout = setTimeout(() => finish('timeout'), ${bindingTimeoutMs});
      return promise;
    })()`,
  );
  const submission = parseSubmissionProbe(submissionPayload, ctx.prompt);
  if (submission.sendResult !== "clicked" && submission.sendResult !== "enter") {
    throw new Error("Failed to submit prompt in Gemini Deep Think mode (send control not found).");
  }
  if (submission.bindingStatus === "ambiguous") {
    throw new Error(
      "Gemini mounted multiple post-baseline user turns; exact dispatch ownership is ambiguous.",
    );
  }
  if (submission.bindingStatus === "prompt-mismatch") {
    throw new Error("Gemini mounted a different post-baseline user turn after this dispatch.");
  }
  if (
    (submission.bindingStatus !== "bound" && submission.bindingStatus !== "accepted") ||
    !submission.baseline
  ) {
    throw new Error("Failed to bind Gemini response to the newly submitted user turn.");
  }
  const state = requireGeminiState(ctx);
  const conversationId = state.geminiConversationId?.trim();
  if (!conversationId) {
    throw new Error("Gemini Deep Think prompt binding requires a stable conversation identity.");
  }
  const promptSha256 = promptIdentitySha256(ctx.prompt);
  const verifiedUserTurnIndex =
    submission.baseline.userQueryCount + submission.baseline.responseCount;
  // Provider-id-less turns are safe only while this live baseline remains intact.
  // Persist the correlation for audit, but exact reattach rejects this synthetic identity.
  const verifiedUserTurnId =
    submission.baseline.userStableId ??
    `${GEMINI_DOM_TURN_ID_PREFIX}${verifiedUserTurnIndex}:${promptSha256}`;
  const verification: PromptCommitVerification = {
    committedTurns: verifiedUserTurnIndex + 1,
    promptSha256,
    verifiedUserTurnIndex,
    verifiedUserTurnId,
    verifiedUserMessageId: verifiedUserTurnId,
    conversationId,
  };
  state.geminiPromptBaseline = submission.baseline;
  state.geminiPromptCommitVerification = verification;
  delete state.geminiResponseStableId;
  return { status: "committed", verification };
}

export async function waitForGeminiDeepThinkResponse(
  ctx: GeminiDeepThinkDomFlowContext,
): Promise<GeminiDeepThinkDomResponse> {
  ctx.log?.("[gemini-web] Waiting for Deep Think response (this may take a while)...");
  const baseline = requirePromptBaseline(ctx);
  if (!baseline.userStableId) {
    throw new BrowserAutomationError(
      "Gemini accepted the prompt without an immutable provider user identity; " +
        "refusing response publication because DOM position is not stable authority.",
      {
        stage: "gemini-response-capture",
        code: "gemini-live-response-authority-unavailable",
        reattachable: false,
      },
    );
  }
  const state = requireGeminiState(ctx);
  const { responseTimeoutMs } = readTimeouts(ctx);
  const responseDeadline = Date.now() + responseTimeoutMs;
  let lastLog = 0;
  let responseText = "";

  while (Date.now() < responseDeadline) {
    const snapshot = await readGeminiConversationSnapshot(ctx.evaluate);
    if (snapshot) {
      const pairing = pairGeminiPromptAndAssistant(snapshot.entries, baseline);
      if (pairing.status === "unsupported") {
        throw new Error(`${pairing.reason} Exact Gemini response ownership is unsupported.`);
      }
      if (pairing.status === "paired") {
        responseText = pairing.response.text.trim();
        state.geminiResponseStableId = pairing.responseIdentity;
        break;
      }
      const responses = snapshot.entries.filter((entry) => entry.kind === "response");
      const status =
        responses.length === 0
          ? "waiting"
          : responses[responses.length - 1]?.visibleSpinner
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

  if (!responseText || !state.geminiResponseStableId) {
    throw new Error(
      `Deep Think timed out waiting for response (${Math.ceil(responseTimeoutMs / 1000)} seconds).`,
    );
  }
  return { text: responseText };
}

export async function extractGeminiDeepThinkThoughts(
  ctx: GeminiDeepThinkDomFlowContext,
): Promise<string | null> {
  const thoughtsToggleSel = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.thoughtsToggle);
  const thoughtsContentSel = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.thoughtsContent);
  const responseTurnSel = geminiSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseTurn);
  const responseStableId = requireGeminiState(ctx).geminiResponseStableId;
  if (!responseStableId) {
    throw new Error("Gemini thoughts extraction requires an exact paired response identity.");
  }

  const thinkResult = await ctx.evaluate<{ status?: string }>(
    `(() => {
      ${GEMINI_STABLE_ID_READER}
      const matches = Array.from(document.querySelectorAll(${responseTurnSel})).filter(
        (node) => readStableId(node) === ${JSON.stringify(responseStableId)},
      );
      if (matches.length !== 1) return { status: 'unsupported' };
      const toggle = matches[0].querySelector(${thoughtsToggleSel});
      if (!(toggle instanceof HTMLElement)) return { status: 'no-toggle' };
      toggle.click();
      return { status: 'clicked' };
    })()`,
  );
  if (thinkResult?.status === "unsupported") {
    throw new Error(
      "Gemini exact paired response could not be uniquely recovered for thoughts extraction.",
    );
  }
  if (thinkResult?.status !== "clicked") return null;

  await ctx.delay(1_500);
  const extracted = await ctx.evaluate<{ status?: string; text?: string }>(
    `(() => {
      ${GEMINI_STABLE_ID_READER}
      const matches = Array.from(document.querySelectorAll(${responseTurnSel})).filter(
        (node) => readStableId(node) === ${JSON.stringify(responseStableId)},
      );
      if (matches.length !== 1) return { status: 'unsupported' };
      const response = matches[0];
      const toggle = response.querySelector(${thoughtsToggleSel});
      let content = response.querySelector(${thoughtsContentSel});
      if (!content && toggle) {
        const controlledId = toggle.getAttribute?.('aria-controls')?.trim().split(/\\s+/)[0];
        if (controlledId) content = document.getElementById(controlledId);
      }
      if (!content) return { status: 'empty', text: '' };
      const full = content.textContent?.trim() ?? '';
      const header = content.querySelector(${thoughtsToggleSel});
      const headerText = header?.textContent?.trim() ?? '';
      const text = headerText && full.startsWith(headerText)
        ? full.slice(headerText.length).trim()
        : full;
      return { status: 'ok', text };
    })()`,
  );
  if (extracted?.status === "unsupported") {
    throw new Error(
      "Gemini exact paired response could not be uniquely recovered after thoughts expansion.",
    );
  }
  return extracted?.status === "ok" &&
    typeof extracted.text === "string" &&
    extracted.text.length > 0
    ? extracted.text
    : null;
}
