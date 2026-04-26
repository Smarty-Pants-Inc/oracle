import { describe, expect, it } from "vitest";
import {
  buildModelMatchersLiteralForTest,
  modelCandidateMatchesTargetForTest,
} from "../../src/browser/actions/modelSelection.js";

const expectSome = (arr: string[], predicate: (s: string) => boolean) => {
  expect(arr.some(predicate)).toBe(true);
};

describe("browser model selection arbitrary labels", () => {
  it("accepts custom label tokens (e.g., 5.1 Instant)", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("5.1 Instant");
    expectSome(labelTokens, (t) => t.includes("5.1"));
    expectSome(labelTokens, (t) => t.includes("instant"));
    // We still generate reasonable testid-based hints for 5.1 models
    expectSome(testIdTokens, (t) => t.includes("gpt-5-1"));
  });

  it("accepts Thinking label", () => {
    const { labelTokens } = buildModelMatchersLiteralForTest("Thinking");
    expectSome(labelTokens, (t) => t.includes("thinking"));
  });

  it("matches shorthand Pro labels for GPT-5.5 Pro", () => {
    expect(modelCandidateMatchesTargetForTest("GPT-5.5 Pro", "Pro")).toBe(true);
  });

  it("rejects shorthand Pro labels when testid proves a different version", () => {
    expect(
      modelCandidateMatchesTargetForTest("GPT-5.5 Pro", "Pro", "model-switcher-gpt-5-2-pro"),
    ).toBe(false);
  });

  it("matches shorthand Thinking labels for Thinking 5.5", () => {
    expect(modelCandidateMatchesTargetForTest("Thinking 5.5", "Thinking")).toBe(true);
  });

  it("matches descriptive shortcut rows for the generic Instant target", () => {
    expect(modelCandidateMatchesTargetForTest("Instant", "Instant for everyday chats")).toBe(true);
    expect(modelCandidateMatchesTargetForTest("Instant", "InstantFor everyday chats")).toBe(true);
  });

  it("rejects shorthand variant labels for a base-model request", () => {
    expect(modelCandidateMatchesTargetForTest("GPT-5.5", "Pro")).toBe(false);
    expect(modelCandidateMatchesTargetForTest("GPT-5.5", "Thinking")).toBe(false);
    expect(modelCandidateMatchesTargetForTest("GPT-5.5", "Instant")).toBe(false);
  });

  it("accepts version-specific test ids even when the visible label is generic", () => {
    expect(modelCandidateMatchesTargetForTest("GPT-5.2", "ChatGPT", "model-switcher-gpt-5-2")).toBe(
      true,
    );
  });

  it("rejects version-matched test ids that still advertise the wrong variant", () => {
    expect(
      modelCandidateMatchesTargetForTest("GPT-5.2", "ChatGPT", "model-switcher-gpt-5-2-pro"),
    ).toBe(false);
    expect(
      modelCandidateMatchesTargetForTest("GPT-5.2", "ChatGPT", "model-switcher-gpt-5-2-thinking"),
    ).toBe(false);
  });

  it("rejects conflicting shorthand labels", () => {
    expect(modelCandidateMatchesTargetForTest("GPT-5.5 Pro", "Thinking")).toBe(false);
    expect(modelCandidateMatchesTargetForTest("Thinking 5.5", "Pro")).toBe(false);
  });
});
