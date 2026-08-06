import { describe, expect, test } from "vitest";
import {
  hasRecoverableChatGptConversation,
  hasRecoverableGeminiConversation,
} from "../../src/browser/reattachability.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionManager.js";

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

function recoverableGeminiRuntime(): BrowserRuntimeMetadata {
  const targetId = "gemini-target-1";
  const generationId = "gemini-generation-1";
  const promptEpoch = {
    status: "committed" as const,
    epochId: "gemini-epoch-1",
    promptSha256: "b".repeat(64),
    baselineTurns: 0,
    followUpOrdinal: 0,
    remainingFollowUps: 0,
    verifiedUserTurnIndex: 0,
    verifiedUserTurnId: "data-message-id:user-current",
    verifiedUserMessageId: "data-message-id:user-current",
    conversationId: targetId,
  };
  return {
    chromePort: 9222,
    chromeTargetId: targetId,
    tabUrl: `about:blank#oracle-acquisition=${generationId}`,
    conversationId: targetId,
    promptEpoch,
    recoveryCleanupResources: [
      {
        chromeTargetId: targetId,
        conversationId: targetId,
        promptEpoch,
        targetCloseCapability: {
          version: 1,
          generationId,
          capabilityId: "gemini-target-capability-1",
          targetId,
        },
        tabLease: {
          id: "gemini-tab-lease-1",
          generationId,
          profileDirectory: {
            version: 2,
            platform: process.platform,
            canonicalPath: "/tmp/oracle-gemini-profile",
            device: "1",
            inode: "2",
            birthtimeNs: "3",
          },
        },
        acquisition: {
          generationId,
          targetMarkerUrl: `about:blank#oracle-acquisition=${generationId}`,
        },
        recoveryCleanup: {
          ownsTarget: true,
          profileKind: "manual-login",
          keepBrowser: false,
          closeOwnedTargetOnComplete: true,
        },
      },
    ],
    recoveryCleanupResult: { status: "pending" },
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

  test("requires matching final-turn prompt authority", () => {
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
    pendingFollowUp.promptEpoch.remainingFollowUps = 0;
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

describe("hasRecoverableGeminiConversation", () => {
  const geminiConfig = { desiredModel: "gemini-3-pro-deep-think" };

  test("accepts executor-style committed Gemini target authority with an acquisition marker", () => {
    expect(hasRecoverableGeminiConversation(recoverableGeminiRuntime(), geminiConfig)).toBe(true);
  });

  test("requires Gemini model configuration and immutable provider identity", () => {
    const runtime = recoverableGeminiRuntime();
    expect(hasRecoverableGeminiConversation(runtime, { desiredModel: "gpt-5.2-pro" })).toBe(false);
    const syntheticPromptEpoch = {
      ...runtime.promptEpoch!,
      verifiedUserTurnId: "gemini-dom-turn:0:synthetic",
      verifiedUserMessageId: "gemini-dom-turn:0:synthetic",
    };
    runtime.promptEpoch = syntheticPromptEpoch;
    runtime.recoveryCleanupResources![0]!.promptEpoch = syntheticPromptEpoch;
    expect(hasRecoverableGeminiConversation(runtime, geminiConfig)).toBe(false);
  });

  test("rejects target and acquisition capability mismatches", () => {
    const targetMismatch = recoverableGeminiRuntime();
    targetMismatch.recoveryCleanupResources![0]!.chromeTargetId = "foreign-target";
    expect(hasRecoverableGeminiConversation(targetMismatch, geminiConfig)).toBe(false);

    const markerMismatch = recoverableGeminiRuntime();
    markerMismatch.tabUrl = "about:blank#oracle-acquisition=foreign-generation";
    expect(hasRecoverableGeminiConversation(markerMismatch, geminiConfig)).toBe(false);
  });
});
