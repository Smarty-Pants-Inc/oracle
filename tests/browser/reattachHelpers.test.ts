import { describe, expect, test } from "vitest";
import { alignPromptEchoPair, buildPromptEchoMatcher } from "../../src/browser/reattachHelpers.ts";

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
});

describe("buildPromptEchoMatcher", () => {
  test("requires the full normalized prompt rather than a prefix or truncated fragment", () => {
    const sharedPrefix = "x".repeat(200);
    const matcher = buildPromptEchoMatcher(`${sharedPrefix} intended suffix`);
    expect(matcher).not.toBeNull();
    expect(matcher?.isEcho(`${sharedPrefix} intended suffix`)).toBe(true);
    expect(matcher?.isEcho(`${sharedPrefix} unrelated suffix`)).toBe(false);
    expect(matcher?.isEcho(sharedPrefix.slice(0, 120))).toBe(false);
  });
});
