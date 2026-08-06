import { describe, expect, test } from "vitest";
import {
  isRecoveredConversationHarvestReady,
  resolveRecoveryProfileDir,
  resolveRecoveryUrl,
} from "../../src/browser/recoverConversation.js";
import { promptIdentitySha256 } from "../../src/browser/actions/committedPrompt.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionManager.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

function metaWith(
  runtime: NonNullable<SessionMetadata["browser"]>["runtime"] | undefined,
  harvest: NonNullable<SessionMetadata["browser"]>["harvest"] | undefined,
  config: NonNullable<SessionMetadata["browser"]>["config"] | undefined = undefined,
): SessionMetadata {
  return {
    id: "x",
    createdAt: "2026-05-26T00:00:00.000Z",
    status: "completed",
    options: {},
    mode: "browser",
    browser: {
      config: config ?? {},
      runtime: runtime ?? {},
      harvest: harvest ?? {},
    },
  } as unknown as SessionMetadata;
}

function committedRuntime(
  conversationId: string,
  runtime: Omit<BrowserRuntimeMetadata, "conversationId" | "promptEpoch"> = {},
): BrowserRuntimeMetadata {
  return {
    ...runtime,
    conversationId,
    promptEpoch: {
      status: "committed",
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

describe("resolveRecoveryUrl", () => {
  test("accepts only a URL matching a committed prompt epoch", () => {
    expect(
      resolveRecoveryUrl(
        metaWith(
          committedRuntime("abc-123", { tabUrl: "https://chatgpt.com/c/abc-123" }),
          undefined,
        ),
      ),
    ).toBe("https://chatgpt.com/c/abc-123");
    expect(
      resolveRecoveryUrl(
        metaWith(
          committedRuntime("legacy-id", {
            tabUrl: "https://chat.openai.com/c/legacy-id",
          }),
          undefined,
        ),
      ),
    ).toBe("https://chat.openai.com/c/legacy-id");
  });

  test("rejects epoch-less URL and conversation fields", () => {
    expect(
      resolveRecoveryUrl(metaWith({ tabUrl: "https://chatgpt.com/c/legacy-only" }, undefined)),
    ).toBeNull();
    expect(resolveRecoveryUrl(metaWith({ conversationId: "legacy-only" }, undefined))).toBeNull();
  });

  test("rejects conflicting harvest or runtime URLs", () => {
    expect(
      resolveRecoveryUrl(
        metaWith(
          committedRuntime("committed-id", {
            tabUrl: "https://chatgpt.com/c/committed-id",
          }),
          { url: "https://chatgpt.com/c/wrong-harvest" },
        ),
      ),
    ).toBeNull();
    expect(
      resolveRecoveryUrl(
        metaWith(
          committedRuntime("committed-id", {
            tabUrl: "https://chatgpt.com/c/wrong-runtime",
          }),
          { url: "https://chatgpt.com/c/committed-id" },
        ),
      ),
    ).toBeNull();
  });

  test("rejects recovery while the prompt epoch is pending", () => {
    expect(
      resolveRecoveryUrl(
        metaWith(
          {
            conversationId: "pending-id",
            promptEpoch: {
              status: "pending",
              epochId: "epoch-pending",
              promptSha256: "a".repeat(64),
              baselineTurns: 0,
              followUpOrdinal: 0,
              remainingFollowUps: 0,
            },
          },
          undefined,
        ),
      ),
    ).toBeNull();
  });

  test("builds a canonical URL from the committed conversation identity", () => {
    expect(
      resolveRecoveryUrl(
        metaWith(committedRuntime("committed-id"), undefined, {
          url: "https://chatgpt.com/",
        }),
      ),
    ).toBe("https://chatgpt.com/c/committed-id");
  });

  test("rejects invalid stored URLs even when an epoch exists", () => {
    for (const tabUrl of [
      "https://chatgpt.com/",
      "https://example.com/c/committed-id",
      "not a url",
    ]) {
      expect(
        resolveRecoveryUrl(metaWith(committedRuntime("committed-id", { tabUrl }), undefined)),
      ).toBeNull();
    }
  });

  test("ignores empty browser metadata", () => {
    expect(resolveRecoveryUrl({ id: "x" } as unknown as SessionMetadata)).toBeNull();
  });
});

describe("isRecoveredConversationHarvestReady", () => {
  const currentAnswer = {
    assistantCount: 2,
    lastAssistantTurnIndex: 3,
    lastUserTurnIndex: 2,
    lastAssistantText: "Current answer",
  };

  test("requires the latest assistant turn to follow the latest user turn", () => {
    expect(isRecoveredConversationHarvestReady(currentAnswer)).toBe(true);
    expect(
      isRecoveredConversationHarvestReady({
        ...currentAnswer,
        lastAssistantTurnIndex: 1,
      }),
    ).toBe(false);
    expect(
      isRecoveredConversationHarvestReady({
        assistantCount: 1,
        lastAssistantText: "Historical answer",
      }),
    ).toBe(false);
  });

  test("requires the full prompt digest and exact persisted user turn identity", () => {
    const sharedPrefix = "x".repeat(120);
    const prompt = `${sharedPrefix} intended suffix`;
    const epoch = {
      status: "committed" as const,
      epochId: "epoch-exact",
      promptSha256: promptIdentitySha256(prompt),
      baselineTurns: 0,
      followUpOrdinal: 0,
      remainingFollowUps: 0,
      verifiedUserTurnIndex: 2,
      verifiedUserTurnId: "turn-2",
      verifiedUserMessageId: "message-2",
      conversationId: "exact-conversation",
    };
    const locator = {
      epoch,
      conversationId: epoch.conversationId,
      promptSha256: epoch.promptSha256,
      verifiedUserTurnIndex: epoch.verifiedUserTurnIndex,
      verifiedUserTurnId: epoch.verifiedUserTurnId,
      verifiedUserMessageId: epoch.verifiedUserMessageId,
      conversationUrls: ["https://chatgpt.com/c/exact-conversation"],
    };
    const exactHarvest = {
      conversationId: "exact-conversation",
      lastUserTurnIndex: 2,
      lastUserTurnId: "turn-2",
      lastUserMessageId: "message-2",
      lastUserText: prompt,
      lastAssistantTurnIndex: 3,
      assistantCount: 1,
      lastAssistantText: "Exact answer",
    };

    expect(isRecoveredConversationHarvestReady(exactHarvest, locator)).toBe(true);
    expect(
      isRecoveredConversationHarvestReady(
        { ...exactHarvest, lastUserText: `${sharedPrefix} unrelated suffix` },
        locator,
      ),
    ).toBe(false);
    expect(
      isRecoveredConversationHarvestReady(
        { ...exactHarvest, lastUserTurnIndex: 4, lastUserTurnId: "turn-4" },
        locator,
      ),
    ).toBe(false);
  });

  test("accepts indexless project-view answers with verified DOM ordering", () => {
    expect(
      isRecoveredConversationHarvestReady({
        assistantCount: 1,
        assistantFollowsLatestUser: true,
        lastAssistantText: "Current project answer",
      }),
    ).toBe(true);
  });

  test("rejects Pro-thinking and ChatGPT placeholder variants", () => {
    expect(
      isRecoveredConversationHarvestReady({
        ...currentAnswer,
        lastAssistantText: "Pro thinking Answer now",
      }),
    ).toBe(false);
    expect(
      isRecoveredConversationHarvestReady({
        ...currentAnswer,
        lastAssistantText: "Answer now",
      }),
    ).toBe(false);
    expect(
      isRecoveredConversationHarvestReady({
        ...currentAnswer,
        lastAssistantText: "ChatGPT said: Answer now",
      }),
    ).toBe(false);
  });

  test("uses raw latest-turn text before captured Markdown", () => {
    expect(
      isRecoveredConversationHarvestReady({
        ...currentAnswer,
        lastAssistantText: "Pro thinking Answer now",
        lastAssistantMarkdown: "Historical completed answer",
      }),
    ).toBe(false);
  });

  test("accepts a visible stop control only after the conversation turns hydrate", () => {
    expect(
      isRecoveredConversationHarvestReady({
        stopExists: true,
        assistantCount: 0,
        lastUserTurnIndex: 0,
      }),
    ).toBe(true);
    expect(
      isRecoveredConversationHarvestReady({
        stopExists: true,
        assistantCount: 0,
      }),
    ).toBe(false);
  });
});

describe("resolveRecoveryProfileDir", () => {
  test("uses the session manual-login profile dir", () => {
    expect(
      resolveRecoveryProfileDir(
        metaWith({ tabUrl: "https://chatgpt.com/c/abc" }, undefined, {
          manualLogin: true,
          manualLoginProfileDir: "/tmp/oracle-profile",
        }),
      ),
    ).toBe("/tmp/oracle-profile");
  });

  test("prefers the recorded runtime profile dir for default manual-login sessions", () => {
    expect(
      resolveRecoveryProfileDir(
        metaWith(
          {
            tabUrl: "https://chatgpt.com/c/abc",
            userDataDir: "/tmp/runtime-profile",
          },
          undefined,
          {
            manualLogin: true,
          },
        ),
      ),
    ).toBe("/tmp/runtime-profile");
  });

  test("rejects sessions that did not use manual-login mode", () => {
    expect(() =>
      resolveRecoveryProfileDir(
        metaWith(
          {
            tabUrl: "https://chatgpt.com/c/abc",
            userDataDir: "/tmp/temp-profile",
          },
          undefined,
          {
            manualLogin: false,
          },
        ),
      ),
    ).toThrow(/manual-login browser profile/);
  });
});
