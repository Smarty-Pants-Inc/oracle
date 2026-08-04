import { describe, expect, test } from "vitest";
import { hasRecoverableChatGptConversation } from "../../src/browser/reattachability.js";

function recoverableRuntime(
  conversationId: string,
  locator: { conversationId?: string; tabUrl?: string },
) {
  return {
    ...locator,
    promptSubmitted: true,
    promptEpoch: {
      status: "committed" as const,
      epochId: `epoch-${conversationId}`,
      promptSha256: "test-prompt-sha256",
      baselineTurns: 0,
      followUpOrdinal: 0,
      remainingFollowUps: 0,
      verifiedUserTurnIndex: 0,
      conversationId,
    },
  };
}

describe("hasRecoverableChatGptConversation", () => {
  test("accepts explicit conversation ids", () => {
    expect(
      hasRecoverableChatGptConversation(recoverableRuntime("abc", { conversationId: "abc" })),
    ).toBe(true);
  });

  test("accepts ChatGPT conversation URLs", () => {
    expect(
      hasRecoverableChatGptConversation(
        recoverableRuntime("abc123", { tabUrl: "https://chatgpt.com/c/abc123" }),
      ),
    ).toBe(true);
    expect(
      hasRecoverableChatGptConversation(
        recoverableRuntime("abc123", {
          tabUrl: "https://chatgpt.com/g/g-p-demo/project/c/abc123",
        }),
      ),
    ).toBe(true);
    expect(
      hasRecoverableChatGptConversation(
        recoverableRuntime("abc123", { tabUrl: "https://chat.openai.com/c/abc123" }),
      ),
    ).toBe(true);
  });

  test("rejects locators without matching current prompt authority", () => {
    expect(hasRecoverableChatGptConversation({ conversationId: "abc" })).toBe(false);
    expect(
      hasRecoverableChatGptConversation(
        recoverableRuntime("other", { tabUrl: "https://chatgpt.com/c/abc" }),
      ),
    ).toBe(false);
    const pendingFollowUp = recoverableRuntime("abc", {
      tabUrl: "https://chatgpt.com/c/abc",
    });
    pendingFollowUp.promptEpoch.remainingFollowUps = 1;
    expect(hasRecoverableChatGptConversation(pendingFollowUp)).toBe(false);
  });

  test("rejects ChatGPT home and project shell URLs", () => {
    expect(hasRecoverableChatGptConversation({ tabUrl: "https://chatgpt.com/" })).toBe(false);
    expect(
      hasRecoverableChatGptConversation({
        tabUrl: "https://chatgpt.com/g/g-p-demo/project",
      }),
    ).toBe(false);
    expect(
      hasRecoverableChatGptConversation({
        tabUrl: "https://chatgpt.com/c/WEB:32229414-5afa-4478-890c-9ca80aa82430",
      }),
    ).toBe(false);
  });

  test("rejects malformed or non-ChatGPT URLs", () => {
    expect(hasRecoverableChatGptConversation({ tabUrl: "not a url" })).toBe(false);
    expect(hasRecoverableChatGptConversation({ tabUrl: "https://example.com/c/abc" })).toBe(false);
    expect(hasRecoverableChatGptConversation({ tabUrl: "https://chatgpt.com/?next=/c/abc" })).toBe(
      false,
    );
    expect(hasRecoverableChatGptConversation({ tabUrl: "https://chatgpt.com/#/c/abc" })).toBe(
      false,
    );
  });
});
