import { describe, expect, test } from "vitest";
import type { BrowserRuntimeMetadata } from "../../src/sessionManager.js";
import {
  hasRecoverableChatGptConversation,
  requiresCleanupOnlyCommittedPromptRecovery,
  resolveCommittedPromptEpochLocator,
} from "../../src/browser/reattachability.js";

const conversationId = "smoke-conversation";
const promptSha256 = "a".repeat(64);

function committedRuntime(remainingFollowUps: number): BrowserRuntimeMetadata {
  return {
    chromePort: 9222,
    conversationId,
    tabUrl: `https://chatgpt.com/c/${conversationId}`,
    promptEpoch: {
      status: "committed",
      epochId: "smoke-epoch",
      promptSha256,
      baselineTurns: 0,
      followUpOrdinal: 0,
      remainingFollowUps,
      verifiedUserTurnIndex: 0,
      verifiedUserTurnId: "turn-smoke",
      verifiedUserMessageId: "message-smoke",
      conversationId,
    },
  };
}

describe("prompt epoch crash-window recovery", () => {
  test("never replays an ambiguous submitted prompt and resumes only an exact final commit", () => {
    const submissionInFlight: BrowserRuntimeMetadata = {
      chromePort: 9222,
      conversationId,
      tabUrl: `https://chatgpt.com/c/${conversationId}`,
      promptEpoch: {
        status: "pending",
        epochId: "smoke-epoch",
        promptSha256,
        baselineTurns: 0,
        followUpOrdinal: 0,
        remainingFollowUps: 0,
      },
    };
    const committedFollowUp = committedRuntime(1);
    const committedFinalPrompt = committedRuntime(0);
    const legacySubmittedOnly: unknown = { chromePort: 9222, promptSubmitted: true };

    expect(
      resolveCommittedPromptEpochLocator(legacySubmittedOnly as BrowserRuntimeMetadata),
    ).toBeNull();
    expect(hasRecoverableChatGptConversation(legacySubmittedOnly as BrowserRuntimeMetadata)).toBe(
      false,
    );

    expect(resolveCommittedPromptEpochLocator(submissionInFlight)).toBeNull();
    expect(hasRecoverableChatGptConversation(submissionInFlight)).toBe(false);
    expect(requiresCleanupOnlyCommittedPromptRecovery(submissionInFlight)).toBe(false);

    expect(resolveCommittedPromptEpochLocator(committedFollowUp)).toMatchObject({
      conversationId,
      promptSha256,
      verifiedUserTurnId: "turn-smoke",
      verifiedUserMessageId: "message-smoke",
    });
    expect(hasRecoverableChatGptConversation(committedFollowUp)).toBe(false);
    expect(requiresCleanupOnlyCommittedPromptRecovery(committedFollowUp)).toBe(true);

    expect(resolveCommittedPromptEpochLocator(committedFinalPrompt)).toMatchObject({
      conversationId,
      promptSha256,
    });
    expect(hasRecoverableChatGptConversation(committedFinalPrompt)).toBe(true);
    expect(requiresCleanupOnlyCommittedPromptRecovery(committedFinalPrompt)).toBe(false);
  });
});
