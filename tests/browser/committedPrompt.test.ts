import { describe, expect, test } from "vitest";
import {
  parseCommittedPromptProbe,
  promptIdentitySha256,
  serializeCommittedPromptAuthority,
} from "../../src/browser/actions/committedPrompt.js";
import type { CommittedPromptEpochLocator } from "../../src/browser/reattachability.js";

const prompt = "Keep only this exact committed prompt.";
const promptSha256 = promptIdentitySha256(prompt);
const locator: CommittedPromptEpochLocator = {
  epoch: {
    status: "committed",
    epochId: "epoch-1",
    promptSha256,
    baselineTurns: 0,
    followUpOrdinal: 0,
    remainingFollowUps: 0,
    verifiedUserTurnIndex: 0,
    verifiedUserTurnId: "turn-1",
    verifiedUserMessageId: "message-1",
    conversationId: "conversation-1",
  },
  conversationId: "conversation-1",
  promptSha256,
  verifiedUserTurnIndex: 0,
  verifiedUserTurnId: "turn-1",
  verifiedUserMessageId: "message-1",
  conversationUrls: ["https://chatgpt.com/c/conversation-1"],
};

describe("committed prompt authority parser", () => {
  test("accepts only the serialized locator and required verified digest", () => {
    const authority = serializeCommittedPromptAuthority(locator.conversationId, locator);
    const probe = {
      conversationId: locator.conversationId,
      promptText: prompt,
      userTurnIndex: locator.verifiedUserTurnIndex,
      userTurnId: locator.verifiedUserTurnId,
      userMessageId: locator.verifiedUserMessageId,
      promptSha256: locator.promptSha256,
    };

    expect(parseCommittedPromptProbe(probe, authority, { requirePromptSha256: true })).toEqual(
      probe,
    );
    expect(
      parseCommittedPromptProbe({ ...probe, userMessageId: "other-message" }, authority, {
        requirePromptSha256: true,
      }),
    ).toBeNull();
    expect(
      parseCommittedPromptProbe({ ...probe, promptSha256: "b".repeat(64) }, authority, {
        requirePromptSha256: true,
      }),
    ).toBeNull();
  });
});
