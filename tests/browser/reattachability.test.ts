import { describe, expect, test } from "vitest";
import { hasRecoverableChatGptConversation } from "../../src/browser/reattachability.js";

function recoverableRuntime(
  conversationId: string,
  locator: { conversationId?: string; tabUrl?: string },
) {
  return {
    ...locator,
    promptEpoch: {
      status: "committed" as const,
      epochId: `epoch-${conversationId}`,
      promptSha256: "a".repeat(64),
      baselineTurns: 0,
      followUpOrdinal: 0,
      remainingFollowUps: 0,
      verifiedUserTurnIndex: 0,
      verifiedUserTurnId: "turn-0",
      verifiedUserMessageId: "message-0",
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

  test("requires matching current prompt authority but preserves committed turns before follow-ups", () => {
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
    expect(hasRecoverableChatGptConversation(pendingFollowUp)).toBe(true);
  });

  test("rejects malformed or truncated prompt digests", () => {
    const runtime = recoverableRuntime("abc", { conversationId: "abc" });
    runtime.promptEpoch.promptSha256 = "a".repeat(63);
    expect(hasRecoverableChatGptConversation(runtime)).toBe(false);
  });

  test("rejects committed epochs without stable user turn and message ids", () => {
    const runtime = recoverableRuntime("abc", { conversationId: "abc" });
    expect(
      hasRecoverableChatGptConversation({
        ...runtime,
        promptEpoch: { ...runtime.promptEpoch, verifiedUserTurnId: undefined },
      } as never),
    ).toBe(false);
    expect(
      hasRecoverableChatGptConversation({
        ...runtime,
        promptEpoch: { ...runtime.promptEpoch, verifiedUserMessageId: "" },
      }),
    ).toBe(false);
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
