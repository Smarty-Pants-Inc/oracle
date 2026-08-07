import { describe, expect, it } from "vitest";
import type { PendingPromptProviderOverrides } from "../../src/browser/reattachContracts.js";
import {
  chatgptDomProvider,
  type ChatgptDomFlowContext,
} from "../../src/browser/providers/chatgptDomProvider.js";
import {
  geminiDeepThinkDomProvider,
  type GeminiDeepThinkDomFlowContext,
} from "../../src/browser/providers/geminiDeepThinkDomProvider.js";
import { runProviderSubmissionFlow } from "../../src/browser/providerDomFlow.js";

declare const chatgptContext: ChatgptDomFlowContext;
declare const geminiContext: GeminiDeepThinkDomFlowContext;

function assertProviderStateBinding(): void {
  void runProviderSubmissionFlow(chatgptDomProvider, chatgptContext);
  void runProviderSubmissionFlow(geminiDeepThinkDomProvider, geminiContext);

  // @ts-expect-error Gemini state cannot be submitted through the ChatGPT adapter.
  void runProviderSubmissionFlow(chatgptDomProvider, geminiContext);
  // @ts-expect-error ChatGPT state cannot be submitted through the Gemini adapter.
  void runProviderSubmissionFlow(geminiDeepThinkDomProvider, chatgptContext);

  // @ts-expect-error Direct adapter methods retain the same state binding.
  void chatgptDomProvider.waitForUi(geminiContext);
  // @ts-expect-error Direct adapter methods retain the same state binding.
  void geminiDeepThinkDomProvider.waitForUi(chatgptContext);

  const overrides: PendingPromptProviderOverrides = {
    // @ts-expect-error The ChatGPT override slot cannot accept a Gemini adapter.
    chatgpt: geminiDeepThinkDomProvider,
    // @ts-expect-error The Gemini override slot cannot accept a ChatGPT adapter.
    gemini: chatgptDomProvider,
  };
  void overrides;
}

void assertProviderStateBinding;

describe("provider DOM flow type binding", () => {
  it("retains provider identity on public adapters", () => {
    expect(chatgptDomProvider.provider).toBe("chatgpt");
    expect(geminiDeepThinkDomProvider.provider).toBe("gemini");
  });
});
