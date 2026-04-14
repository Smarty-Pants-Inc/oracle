import { describe, expect, test, vi } from "vitest";
import {
  alignPromptEchoPair,
  buildPromptEchoMatcher,
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
});
