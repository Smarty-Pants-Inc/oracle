import {
  buildPromptIdentityNormalizationExpression,
  normalizePromptForIdentity,
  promptIdentitySha256,
  type PromptCommitVerification,
} from "../actions/promptComposer.js";
import type { CommittedPromptEpochLocator } from "../reattachability.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import type {
  PromptCommitEvidence,
  ProviderDomAdapter,
  ProviderDomFlowContext,
} from "../providerDomFlow.js";
import { joinSelectors } from "../providerDomFlow.js";

const UI_TIMEOUT_MS = 60_000;
const RESPONSE_TIMEOUT_MS = 10 * 60_000;
const GEMINI_DOM_TURN_ID_PREFIX = "gemini-dom-turn:";

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

interface GeminiPromptBaseline {
  userQueryCount: number;
  responseCount: number;
  normalizedPrompt: string;
  userStableId: string | null;
}

interface GeminiDomProviderState {
  inputTimeoutMs?: number;
  timeoutMs?: number;
  geminiConversationId?: string;
  geminiPromptBaseline?: GeminiPromptBaseline;
  geminiPromptCommitVerification?: PromptCommitVerification;
  geminiResponseStableId?: string;
}

interface GeminiRawTurnDescriptor {
  kind: "user" | "response";
  postBaseline: boolean;
  text: string;
  stableId: string | null;
  completionMarked?: boolean;
  visibleSpinner?: boolean;
}

type GeminiResponsePairing =
  | { status: "waiting" }
  | { status: "unsupported"; reason: string }
  | { status: "paired"; response: GeminiRawTurnDescriptor & { kind: "response" } };

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

const GEMINI_STABLE_ID_READER = `
  const stableAttributes = ['data-message-id', 'data-query-id', 'data-turn-id'];
  const readStableId = (turn) => {
    const selector = stableAttributes.map((name) => '[' + name + ']').join(', ');
    const nodes = [turn, ...Array.from(turn.querySelectorAll?.(selector) ?? [])];
    for (const attribute of stableAttributes) {
      const values = new Set();
      for (const node of nodes) {
        const value = node.getAttribute?.(attribute)?.trim();
        if (value) values.add(value);
      }
      if (values.size > 1) return null;
      if (values.size === 1) return attribute + ':' + Array.from(values)[0];
    }
    return null;
  };
`;

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
): {
  baseline: GeminiPromptBaseline | null;
  sendResult: string;
  bindingStatus: "bound" | "accepted" | "ambiguous" | "prompt-mismatch" | "timeout";
} {
  try {
    const decoded: unknown = JSON.parse(payload ?? "{}");
    if (!decoded || typeof decoded !== "object") throw new Error("invalid submission probe");
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
              normalizedPrompt: normalizePromptForIdentity(prompt),
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

function requirePromptBaseline(ctx: ProviderDomFlowContext): GeminiPromptBaseline {
  const baseline = requireGeminiState(ctx).geminiPromptBaseline;
  if (!baseline) {
    throw new Error("Gemini Deep Think response polling requires a pre-dispatch prompt baseline.");
  }
  return baseline;
}

function parseResponseProbe(payload: string | undefined): GeminiRawTurnDescriptor[] | null {
  try {
    const decoded: unknown = JSON.parse(payload ?? "{}");
    if (!decoded || typeof decoded !== "object" || !("entries" in decoded)) return null;
    if (!Array.isArray(decoded.entries)) return null;
    const entries: GeminiRawTurnDescriptor[] = [];
    for (const entry of decoded.entries) {
      if (
        !entry ||
        typeof entry !== "object" ||
        !("kind" in entry) ||
        !("postBaseline" in entry) ||
        !("text" in entry) ||
        !("stableId" in entry) ||
        (entry.kind !== "user" && entry.kind !== "response") ||
        typeof entry.postBaseline !== "boolean" ||
        typeof entry.text !== "string" ||
        (typeof entry.stableId !== "string" && entry.stableId !== null)
      ) {
        return null;
      }
      entries.push({
        kind: entry.kind,
        postBaseline: entry.postBaseline,
        text: entry.text,
        stableId: entry.stableId,
        ...(entry.kind === "response"
          ? {
              completionMarked: "completionMarked" in entry && entry.completionMarked === true,
              visibleSpinner: "visibleSpinner" in entry && entry.visibleSpinner === true,
            }
          : {}),
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
  baseline: GeminiPromptBaseline,
): GeminiResponsePairing {
  if (!baseline.userStableId) {
    return {
      status: "unsupported",
      reason: "Gemini accepted the prompt without an immutable provider user identity.",
    };
  }
  let submittedUserIndex = -1;
  for (const [index, entry] of entries.entries()) {
    if (entry.kind !== "user" || entry.stableId !== baseline.userStableId) continue;
    if (submittedUserIndex >= 0) {
      return {
        status: "unsupported",
        reason: "Gemini rendered the dispatched user message identity more than once.",
      };
    }
    submittedUserIndex = index;
  }
  if (submittedUserIndex < 0) return { status: "waiting" };

  const submittedUser = entries[submittedUserIndex];
  if (
    !submittedUser.postBaseline ||
    normalizePromptForIdentity(submittedUser.text) !== baseline.normalizedPrompt
  ) {
    return { status: "waiting" };
  }
  const completedResponses: Array<GeminiRawTurnDescriptor & { kind: "response" }> = [];
  for (let index = submittedUserIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.kind === "user") break;
    if (entry.postBaseline && isCompletedGeminiResponse(entry)) completedResponses.push(entry);
  }
  if (completedResponses.length === 0) return { status: "waiting" };
  if (completedResponses.length > 1) {
    return {
      status: "unsupported",
      reason: "Gemini rendered multiple completed responses for the dispatched user message.",
    };
  }

  const response = completedResponses[0];
  if (!response.stableId) {
    return {
      status: "unsupported",
      reason: "Gemini response lacks a stable provider message identifier.",
    };
  }
  const responseIdentityMatches = entries.filter(
    (entry) => entry.kind === "response" && entry.stableId === response.stableId,
  );
  if (responseIdentityMatches.length !== 1) {
    return {
      status: "unsupported",
      reason: "Gemini response identity is not unique in the current conversation DOM.",
    };
  }
  return { status: "paired", response };
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
  const userQueryTextSelector = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.userQueryText);
  const responseTurnSelector = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseTurn);
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

async function waitForResponse(ctx: ProviderDomFlowContext): Promise<{ text: string }> {
  ctx.log?.("[gemini-web] Waiting for Deep Think response (this may take a while)...");
  const responseTurnSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseTurn);
  const responseTextSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseText);
  const responseCompleteSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseComplete);
  const spinnerSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.spinner);
  const userQuerySel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.userQuery);
  const userQueryTextSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.userQueryText);
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
    const payload = await ctx.evaluate<string>(
      `(() => {
        ${GEMINI_STABLE_ID_READER}
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
            stableId: readStableId(node),
          })),
          ...responseTurns.map((node, index) => ({
            node,
            kind: 'response',
            postBaseline: index >= ${baseline.responseCount},
            text: node.querySelector(${responseTextSel})?.textContent ?? '',
            stableId: readStableId(node),
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
      const pairing = findCausallyPairedResponse(entries, baseline);
      if (pairing.status === "unsupported") {
        throw new Error(`${pairing.reason} Exact Gemini response ownership is unsupported.`);
      }
      if (pairing.status === "paired") {
        responseText = pairing.response.text.trim();
        state.geminiResponseStableId = pairing.response.stableId ?? undefined;
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

  if (!responseText || !state.geminiResponseStableId) {
    throw new Error(
      `Deep Think timed out waiting for response (${Math.ceil(responseTimeoutMs / 1000)} seconds).`,
    );
  }
  return { text: responseText };
}

async function extractThoughts(ctx: ProviderDomFlowContext): Promise<string | null> {
  const thoughtsToggleSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.thoughtsToggle);
  const thoughtsContentSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.thoughtsContent);
  const responseTurnSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseTurn);
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

export async function recoverCommittedGeminiDeepThinkResponse(
  ctx: Pick<ProviderDomFlowContext, "evaluate" | "delay" | "log">,
  promptLocator: CommittedPromptEpochLocator,
  timeoutMs: number,
): Promise<{ text: string }> {
  if (!hasImmutableGeminiPromptIdentity(promptLocator)) {
    throw new BrowserAutomationError(
      "Committed Gemini prompt lacks an immutable provider user identity for exact reattach.",
      {
        stage: "prompt-epoch",
        code: "gemini-reattach-authority-unavailable",
        reattachable: false,
      },
    );
  }
  const immutableUserId = promptLocator.verifiedUserTurnId.trim();
  const responseTurnSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseTurn);
  const responseTextSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseText);
  const responseCompleteSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseComplete);
  const spinnerSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.spinner);
  const userQuerySel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.userQuery);
  const userQueryTextSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.userQueryText);
  const deadline = Date.now() + Math.max(1_000, timeoutMs);

  while (Date.now() < deadline) {
    const payload = await ctx.evaluate<string>(
      `(() => {
        ${GEMINI_STABLE_ID_READER}
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
          ...userTurns.map((node) => ({
            node,
            kind: 'user',
            postBaseline: true,
            text: node.querySelector(${userQueryTextSel})?.textContent ?? node.textContent ?? '',
            stableId: readStableId(node),
          })),
          ...responseTurns.map((node) => ({
            node,
            kind: 'response',
            postBaseline: true,
            text: node.querySelector(${responseTextSel})?.textContent ?? '',
            stableId: readStableId(node),
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
      let submittedUserIndex = -1;
      for (const [index, entry] of entries.entries()) {
        if (entry.stableId !== immutableUserId) continue;
        if (submittedUserIndex >= 0) {
          throw new BrowserAutomationError(
            "Gemini rendered the committed provider user identity more than once during reattach.",
            {
              stage: "prompt-epoch",
              code: "committed-prompt-identity-mismatch",
              reattachable: false,
            },
          );
        }
        submittedUserIndex = index;
      }
      if (submittedUserIndex >= 0) {
        const submittedUser = entries[submittedUserIndex];
        if (
          submittedUser.kind !== "user" ||
          promptIdentitySha256(submittedUser.text) !== promptLocator.promptSha256
        ) {
          throw new BrowserAutomationError(
            "Recovered Gemini turn does not match the committed prompt epoch.",
            { stage: "prompt-epoch", code: "committed-prompt-identity-mismatch" },
          );
        }
        const completedResponses: Array<GeminiRawTurnDescriptor & { kind: "response" }> = [];
        for (let index = submittedUserIndex + 1; index < entries.length; index += 1) {
          const entry = entries[index];
          if (entry.kind === "user") break;
          if (isCompletedGeminiResponse(entry)) completedResponses.push(entry);
        }
        if (completedResponses.length > 1) {
          throw new BrowserAutomationError(
            "Gemini exposes multiple completed responses for the committed prompt epoch.",
            {
              stage: "gemini-response-capture",
              code: "gemini-response-ownership-ambiguous",
              reattachable: false,
            },
          );
        }
        if (completedResponses.length === 1) {
          return { text: completedResponses[0].text.trim() };
        }
      }
    }
    await ctx.delay(1_000);
  }
  throw new Error("Timed out waiting for the committed Gemini response during reattach.");
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
