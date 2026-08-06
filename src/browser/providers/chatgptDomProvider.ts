import type { BrowserLogger, ChromeClient } from "../types.js";
import type {
  PendingPromptEpochAuthority,
  PendingPromptObservation,
  PendingPromptReconciliationContext,
  PendingPromptEpochReconciliation,
  PromptCommitEvidence,
  ProviderDomAdapter,
  ProviderDomFlowContext,
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

interface ChatgptDomProviderState {
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

function requireState(ctx: ProviderDomFlowContext): ChatgptDomProviderState {
  const state = ctx.state as ChatgptDomProviderState | undefined;
  if (!state?.runtime || !state?.input || !state?.logger) {
    throw new Error("chatgptDomProvider requires runtime/input/logger in context.state.");
  }
  return state;
}

async function waitForUi(ctx: ProviderDomFlowContext): Promise<void> {
  const state = requireState(ctx);
  await ensurePromptReady(state.runtime, state.inputTimeoutMs ?? 30_000, state.logger);
}

async function typePrompt(_ctx: ProviderDomFlowContext): Promise<void> {
  // submitPrompt() handles typing + send for ChatGPT.
}

async function submitPromptViaAdapter(ctx: ProviderDomFlowContext): Promise<PromptCommitEvidence> {
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

async function waitForResponse(ctx: ProviderDomFlowContext): Promise<{
  text: string;
  html?: string;
  meta?: { turnId?: string | null; messageId?: string | null };
}> {
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
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.ready !== "boolean" ||
    (candidate.conversationId !== null && typeof candidate.conversationId !== "string") ||
    typeof candidate.composerText !== "string" ||
    typeof candidate.canSubmit !== "boolean" ||
    typeof candidate.active !== "boolean" ||
    !Array.isArray(candidate.turns)
  ) {
    return null;
  }
  const turns = candidate.turns.map((turn) => {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) return null;
    const entry = turn as Record<string, unknown>;
    if (
      (entry.role !== "user" && entry.role !== "assistant") ||
      typeof entry.text !== "string" ||
      (entry.turnId !== null && typeof entry.turnId !== "string") ||
      (entry.messageId !== null && typeof entry.messageId !== "string")
    ) {
      return null;
    }
    return {
      role: entry.role,
      text: entry.text,
      turnId: entry.turnId,
      messageId: entry.messageId,
    };
  });
  if (turns.some((turn) => turn === null)) return null;
  return {
    ready: candidate.ready,
    conversationId: candidate.conversationId,
    composerText: candidate.composerText,
    canSubmit: candidate.canSubmit,
    active: candidate.active,
    turns: turns as PendingPromptObservation["turns"],
  };
}

async function readPendingPromptObservation(
  ctx: PendingPromptReconciliationContext,
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
  ctx: PendingPromptReconciliationContext,
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

export const chatgptDomProvider: ProviderDomAdapter = {
  providerName: "chatgpt-web",
  waitForUi,
  typePrompt,
  submitPrompt: submitPromptViaAdapter,
  reconcilePendingPrompt,
  waitForResponse,
};
