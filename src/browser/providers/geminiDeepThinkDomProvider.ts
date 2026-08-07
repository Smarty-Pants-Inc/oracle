import type { ProviderDomAdapter } from "../providerDomFlow.js";
import {
  extractGeminiDeepThinkThoughts,
  selectGeminiDeepThinkMode,
  submitGeminiDeepThinkPrompt,
  typeGeminiDeepThinkPrompt,
  waitForGeminiDeepThinkResponse,
  waitForGeminiDeepThinkUi,
  type GeminiDeepThinkDomProviderState,
  type GeminiDeepThinkDomResponse,
} from "./geminiDeepThinkLive.js";
import { reconcilePendingGeminiDeepThinkPrompt } from "./geminiDeepThinkRecovery.js";

export {
  createGeminiDeepThinkDomProviderState,
  hasImmutableGeminiPromptIdentity,
  type GeminiDeepThinkDomFlowContext,
  type GeminiDeepThinkDomProviderState,
  type GeminiDeepThinkDomResponse,
  type GeminiPromptBaseline,
} from "./geminiDeepThinkLive.js";
export { recoverCommittedGeminiDeepThinkResponse } from "./geminiDeepThinkRecovery.js";
export { GEMINI_DEEP_THINK_SELECTORS } from "./geminiConversationSnapshot.js";

export type GeminiDeepThinkDomAdapter = ProviderDomAdapter<
  GeminiDeepThinkDomProviderState,
  GeminiDeepThinkDomResponse
>;

export const geminiDeepThinkDomProvider: GeminiDeepThinkDomAdapter = {
  provider: "gemini",
  providerName: "gemini-web",
  waitForUi: waitForGeminiDeepThinkUi,
  selectMode: selectGeminiDeepThinkMode,
  typePrompt: typeGeminiDeepThinkPrompt,
  submitPrompt: submitGeminiDeepThinkPrompt,
  reconcilePendingPrompt: reconcilePendingGeminiDeepThinkPrompt,
  waitForResponse: waitForGeminiDeepThinkResponse,
  extractThoughts: extractGeminiDeepThinkThoughts,
};
