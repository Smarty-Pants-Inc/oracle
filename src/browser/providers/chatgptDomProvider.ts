import type { BrowserLogger, ChromeClient } from "../types.js";
import type { ProviderDomAdapter, ProviderDomFlowContext } from "../providerDomFlow.js";
import { ensurePromptReady } from "../actions/navigation.js";
import { submitPrompt, type AttachmentReadyExpectation } from "../actions/promptComposer.js";
import { waitForAssistantResponse } from "../actions/assistantResponse.js";

interface ChatgptDomProviderState {
  runtime: ChromeClient["Runtime"];
  input: ChromeClient["Input"];
  logger: BrowserLogger;
  timeoutMs: number;
  inputTimeoutMs?: number;
  attachmentTimeoutMs?: number;
  baselineTurns?: number | null;
  attachmentNames?: AttachmentReadyExpectation[];
  committedTurns?: number | null;
  committedConversationUrl?: string;
  onPromptSubmitted?: () => Promise<void> | void;
  assertPageAffinity: (action: string) => Promise<void>;
}
function requireState(ctx: ProviderDomFlowContext): ChatgptDomProviderState {
  const state = ctx.state as ChatgptDomProviderState | undefined;
  if (!state?.runtime || !state?.input || !state?.logger || !state.assertPageAffinity) {
    throw new Error(
      "chatgptDomProvider requires runtime/input/logger/affinity guard in context.state.",
    );
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

async function submitPromptViaAdapter(ctx: ProviderDomFlowContext): Promise<void> {
  const state = requireState(ctx);
  const commit = await submitPrompt(
    {
      runtime: state.runtime,
      input: state.input,
      attachmentNames: state.attachmentNames ?? [],
      baselineTurns: state.baselineTurns ?? undefined,
      inputTimeoutMs: state.inputTimeoutMs ?? undefined,
      attachmentTimeoutMs: state.attachmentTimeoutMs ?? undefined,
      onPromptSubmitted: state.onPromptSubmitted,
      assertPageAffinity: state.assertPageAffinity,
    },
    ctx.prompt,
    state.logger,
  );
  state.committedTurns = commit.turnsCount;
  state.committedConversationUrl = commit.conversationUrl;
  if (state.committedTurns != null && Number.isFinite(state.committedTurns)) {
    state.baselineTurns = Math.max(0, state.committedTurns - 1);
  }
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

export const chatgptDomProvider: ProviderDomAdapter = {
  providerName: "chatgpt-web",
  waitForUi,
  typePrompt,
  submitPrompt: submitPromptViaAdapter,
  waitForResponse,
};
