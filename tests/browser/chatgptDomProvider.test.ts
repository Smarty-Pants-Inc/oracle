import { beforeEach, describe, expect, test, vi } from "vitest";

const promptComposerMocks = vi.hoisted(() => ({
  submitPrompt: vi.fn(),
}));
const assistantResponseMocks = vi.hoisted(() => ({
  waitForAssistantResponse: vi.fn(),
}));

vi.mock("../../src/browser/actions/promptComposer.js", () => promptComposerMocks);
vi.mock("../../src/browser/actions/assistantResponse.js", () => assistantResponseMocks);

import { chatgptDomProvider } from "../../src/browser/providers/chatgptDomProvider.js";

describe("chatgptDomProvider", () => {
  beforeEach(() => {
    promptComposerMocks.submitPrompt.mockReset();
    assistantResponseMocks.waitForAssistantResponse.mockReset();
  });

  test("rebases a stale caller baseline onto a fresh committed conversation", async () => {
    const runtime = {};
    const input = {};
    const logger = vi.fn();
    const state: Record<string, unknown> = {
      runtime,
      input,
      logger,
      timeoutMs: 5_000,
      baselineTurns: 7,
      assertPageAffinity: async () => undefined,
    };
    const context = {
      prompt: "fresh prompt",
      evaluate: async <T>() => undefined as T | undefined,
      delay: async () => undefined,
      state,
    };
    promptComposerMocks.submitPrompt.mockResolvedValue({
      turnsCount: 1,
      conversationUrl: "https://chatgpt.com/c/fresh",
    });
    assistantResponseMocks.waitForAssistantResponse.mockResolvedValue({ text: "fresh answer" });

    await chatgptDomProvider.submitPrompt(context);

    expect(promptComposerMocks.submitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ baselineTurns: 7 }),
      "fresh prompt",
      logger,
    );
    expect(state.baselineTurns).toBe(0);
    await expect(chatgptDomProvider.waitForResponse(context)).resolves.toMatchObject({
      text: "fresh answer",
    });
    expect(assistantResponseMocks.waitForAssistantResponse).toHaveBeenCalledWith(
      runtime,
      5_000,
      logger,
      0,
      undefined,
      "https://chatgpt.com/c/fresh",
    );
  });
});
