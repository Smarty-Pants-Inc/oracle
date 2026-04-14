import { describe, expect, test, vi } from "vitest";
import {
  alignPromptEchoPair,
  buildConversationUrl,
  buildPromptEchoMatcher,
  pickTarget,
  readConversationTurnIndex,
} from "../../src/browser/reattachHelpers.ts";

describe("alignPromptEchoPair", () => {
  test("aligns answer text when text is a prompt echo", () => {
    const matcher = buildPromptEchoMatcher("Echo prompt");
    expect(matcher).not.toBeNull();
    const result = alignPromptEchoPair("Echo prompt", "Real answer", matcher);
    expect(result.answerText).toBe("Real answer");
    expect(result.answerMarkdown).toBe("Real answer");
    expect(result.isEcho).toBe(false);
  });

  test("aligns answer markdown when markdown is a prompt echo", () => {
    const matcher = buildPromptEchoMatcher("Echo prompt");
    expect(matcher).not.toBeNull();
    const result = alignPromptEchoPair("Real answer", "Echo prompt", matcher);
    expect(result.answerText).toBe("Real answer");
    expect(result.answerMarkdown).toBe("Real answer");
    expect(result.isEcho).toBe(false);
  });

  test("keeps echo flag when both text and markdown are prompt echoes", () => {
    const matcher = buildPromptEchoMatcher("Echo prompt");
    expect(matcher).not.toBeNull();
    const result = alignPromptEchoPair("Echo prompt", "Echo prompt", matcher);
    expect(result.isEcho).toBe(true);
  });

  test("counts only top-level conversation turns for follow-up baselines", async () => {
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      expect(expression).toContain("__oracleCollectThreadEntries");
      return { result: { value: 5 } };
    });

    const turnIndex = await readConversationTurnIndex({
      evaluate,
    } as never);

    expect(turnIndex).toBe(4);
  });

  test("pickTarget rejects a stale chromeTargetId from another conversation in the same project scope", () => {
    const target = pickTarget(
      [
        {
          targetId: "stale-target",
          type: "page",
          url: "https://chatgpt.com/g/team-space-oracle/c/wrong-1",
        },
        {
          targetId: "right-target",
          type: "page",
          url: "https://chatgpt.com/g/team-space-oracle/c/right-1",
        },
      ],
      {
        chromeTargetId: "stale-target",
        tabUrl: "https://chatgpt.com/g/team-space-oracle/c/right-1",
        conversationId: "right-1",
      },
      { requireMatch: true },
    );

    expect(target?.targetId).toBe("right-target");
  });

  test("buildConversationUrl does not duplicate /c/<id> when baseUrl is already conversation-scoped", () => {
    expect(
      buildConversationUrl({ conversationId: "next-root" }, "https://chatgpt.com/c/current-root"),
    ).toBe("https://chatgpt.com/c/next-root");
    expect(
      buildConversationUrl(
        {
          tabUrl: "https://chatgpt.com/g/team-space-oracle/c/next-project",
          conversationId: "next-project",
        },
        "https://chatgpt.com/g/team-space-oracle/c/current-project",
      ),
    ).toBe("https://chatgpt.com/g/team-space-oracle/c/next-project");
  });
});
