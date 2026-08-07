import type { BrowserLogger, ChromeClient } from "../types.js";
import type {
  PendingPromptEpochAuthority,
  PendingPromptObservation,
  PendingPromptReconciliationContext,
  PendingPromptEpochReconciliation,
  PendingPromptTurnObservation,
  PromptCommitEvidence,
  ProviderDomAdapter,
  ProviderDomFlowContext,
  ProviderDomState,
} from "../providerDomFlow.js";
import { reconcilePendingPromptObservations } from "../providerDomFlow.js";
import { ensurePromptReady } from "../actions/navigation.js";
import { submitPrompt, type AttachmentReadyExpectation } from "../actions/promptComposer.js";
import { waitForAssistantResponse } from "../actions/assistantResponse.js";
import { buildReadUserPromptTextExpression } from "../actions/committedPrompt.js";
import {
  buildConversationTurnIdentityExpression,
  buildConversationTurnListExpression,
} from "../conversationTurns.js";
import { INPUT_SELECTORS, SEND_BUTTON_SELECTORS, STOP_BUTTON_SELECTORS } from "../constants.js";

export interface ChatgptDomProviderState extends ProviderDomState<"chatgpt"> {
  runtime: ChromeClient["Runtime"];
  input: ChromeClient["Input"];
  logger: BrowserLogger;
  timeoutMs: number;
  inputTimeoutMs?: number;
  attachmentTimeoutMs?: number;
  baselineTurns: number;
  attachmentNames?: AttachmentReadyExpectation[];
  onPromptDispatchStarted?: () => Promise<void> | void;
}

export interface ChatgptDomResponse {
  text: string;
  html?: string;
  meta?: { turnId?: string | null; messageId?: string | null };
}

export type ChatgptDomAdapter = ProviderDomAdapter<ChatgptDomProviderState, ChatgptDomResponse>;
export type ChatgptDomFlowContext = ProviderDomFlowContext<ChatgptDomProviderState>;

export function createChatgptDomProviderState(
  state: Omit<ChatgptDomProviderState, "provider">,
): ChatgptDomProviderState {
  return { ...state, provider: "chatgpt" };
}

function requireState(ctx: ChatgptDomFlowContext): ChatgptDomProviderState {
  const state = ctx.state;
  if (state.provider !== "chatgpt" || !state.runtime || !state.input || !state.logger) {
    throw new Error("chatgptDomProvider requires bound runtime/input/logger provider state.");
  }
  return state;
}

async function waitForUi(ctx: ChatgptDomFlowContext): Promise<void> {
  const state = requireState(ctx);
  await ensurePromptReady(state.runtime, state.inputTimeoutMs ?? 30_000, state.logger);
}

async function typePrompt(_ctx: ChatgptDomFlowContext): Promise<void> {
  // submitPrompt() handles typing + send for ChatGPT.
}

async function submitPromptViaAdapter(ctx: ChatgptDomFlowContext): Promise<PromptCommitEvidence> {
  const state = requireState(ctx);
  const verification = await submitPrompt(
    {
      runtime: state.runtime,
      input: state.input,
      attachmentNames: state.attachmentNames ?? [],
      baselineTurns: state.baselineTurns,
      inputTimeoutMs: state.inputTimeoutMs ?? undefined,
      attachmentTimeoutMs: state.attachmentTimeoutMs ?? undefined,
      onPromptDispatchStarted: state.onPromptDispatchStarted,
    },
    ctx.prompt,
    state.logger,
  );
  state.baselineTurns = verification.verifiedUserTurnIndex + 1;
  return { status: "committed", verification };
}

async function waitForResponse(ctx: ChatgptDomFlowContext): Promise<ChatgptDomResponse> {
  const state = requireState(ctx);
  const answer = await waitForAssistantResponse(
    state.runtime,
    state.timeoutMs,
    state.logger,
    state.baselineTurns ?? undefined,
  );
  return {
    text: answer.text,
    html: answer.html,
    meta: answer.meta,
  };
}

function parsePendingPromptObservation(value: unknown): PendingPromptObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    !("ready" in value) ||
    typeof value.ready !== "boolean" ||
    !("conversationId" in value) ||
    (value.conversationId !== null && typeof value.conversationId !== "string") ||
    !("composerText" in value) ||
    typeof value.composerText !== "string" ||
    !("canSubmit" in value) ||
    typeof value.canSubmit !== "boolean" ||
    !("active" in value) ||
    typeof value.active !== "boolean" ||
    !("turns" in value) ||
    !Array.isArray(value.turns)
  ) {
    return null;
  }
  const turns: PendingPromptTurnObservation[] = [];
  for (const turn of value.turns) {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) return null;
    if (
      !("role" in turn) ||
      (turn.role !== "user" && turn.role !== "assistant") ||
      !("text" in turn) ||
      typeof turn.text !== "string" ||
      !("turnId" in turn) ||
      (turn.turnId !== null && typeof turn.turnId !== "string") ||
      !("messageId" in turn) ||
      (turn.messageId !== null && typeof turn.messageId !== "string")
    ) {
      return null;
    }
    turns.push({
      role: turn.role,
      text: turn.text,
      turnId: turn.turnId,
      messageId: turn.messageId,
    });
  }
  return {
    ready: value.ready,
    conversationId: value.conversationId,
    composerText: value.composerText,
    canSubmit: value.canSubmit,
    active: value.active,
    turns,
  };
}

async function readPendingPromptObservation(
  ctx: PendingPromptReconciliationContext<ChatgptDomProviderState>,
): Promise<PendingPromptObservation | null> {
  const value = await ctx.evaluate<unknown>(`(() => {
    /* oracle-pending-prompt-reconciliation */
    ${buildConversationTurnIdentityExpression()}
    ${buildReadUserPromptTextExpression()}
    const isVisible = (node) => {
      if (!node || node.hidden || node.getAttribute?.('aria-hidden') === 'true') return false;
      const rect = node.getBoundingClientRect?.();
      return !rect || (rect.width > 0 && rect.height > 0);
    };
    const turns = ${buildConversationTurnListExpression()}.map((turn) => ({
      role: isUserTurn(turn) ? 'user' : isAssistantTurn(turn) ? 'assistant' : null,
      text: isUserTurn(turn)
        ? (readUserPromptText(turn) ?? '')
        : (turn.innerText ?? turn.textContent ?? ''),
      turnId: readTurnId(turn),
      messageId: readMessageId(turn),
    })).filter((turn) => turn.role);
    const inputs = ${JSON.stringify(INPUT_SELECTORS)}
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    const composer = inputs.find(isVisible) ?? inputs[0] ?? null;
    const composerText = composer instanceof HTMLTextAreaElement
      ? (composer.value ?? '')
      : (composer?.innerText ?? composer?.textContent ?? '');
    const send = ${JSON.stringify(SEND_BUTTON_SELECTORS)}
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .find(isVisible);
    const active = ${JSON.stringify(STOP_BUTTON_SELECTORS)}
      .some((selector) => Array.from(document.querySelectorAll(selector)).some(isVisible));
    const href = typeof location === 'object' && location.href ? location.href : '';
    const conversationId = href.match(/\\/c\\/([a-zA-Z0-9-]+)/)?.[1] ?? null;
    return {
      ready: document.readyState !== 'loading' && Boolean(composer),
      conversationId,
      composerText,
      canSubmit: Boolean(send && !send.disabled && send.getAttribute?.('aria-disabled') !== 'true'),
      active,
      turns,
    };
  })()`);
  return parsePendingPromptObservation(value);
}

async function reconcilePendingPrompt(
  ctx: PendingPromptReconciliationContext<ChatgptDomProviderState>,
  authority: PendingPromptEpochAuthority,
): Promise<PendingPromptEpochReconciliation> {
  const first = await readPendingPromptObservation(ctx);
  await ctx.delay(750);
  const second = await readPendingPromptObservation(ctx);
  if (!first || !second) {
    return {
      status: "ambiguous",
      reason: "ChatGPT prompt reconciliation returned invalid DOM state.",
    };
  }
  return reconcilePendingPromptObservations(first, second, authority);
}

export const chatgptDomProvider: ChatgptDomAdapter = {
  provider: "chatgpt",
  providerName: "chatgpt-web",
  waitForUi,
  typePrompt,
  submitPrompt: submitPromptViaAdapter,
  reconcilePendingPrompt,
  waitForResponse,
};
