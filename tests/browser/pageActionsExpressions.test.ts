import { describe, expect, test } from "vitest";
import {
  buildAssistantExtractorForTest,
  buildAssistantSnapshotExpressionForTest,
  buildConversationDebugExpressionForTest,
  buildMarkdownFallbackExtractorForTest,
  buildCopyExpressionForTest,
} from "../../src/browser/pageActions.ts";
import {
  CONVERSATION_TURN_SELECTOR,
  ASSISTANT_ROLE_SELECTOR,
} from "../../src/browser/constants.ts";

describe("browser automation expressions", () => {
  test("assistant extractor references constants", () => {
    const expression = buildAssistantExtractorForTest("capture");
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
    expect(expression).toContain(JSON.stringify(ASSISTANT_ROLE_SELECTOR));
  });

  test("assistant extractor aggregates top-level content roots instead of stopping at the first block", () => {
    const expression = buildAssistantExtractorForTest("capture");
    expect(expression).toContain("const CONTENT_SELECTOR");
    expect(expression).toContain("const topLevelRoots = uniqueRoots.filter");
    expect(expression).toContain("aggregatedRoots.map((payload) => payload.text).join('\\n\\n')");
    expect(expression).toContain(
      "const candidateScore = candidate.rank * 10000 + candidate.text.length",
    );
  });

  test("assistant extractor preserves inline button-backed content while removing response actions", () => {
    const expression = buildAssistantExtractorForTest("capture");
    expect(expression).toContain('[aria-label="Response actions"]');
    expect(expression).toContain('[data-testid*="good-response-turn-action-button"]');
    expect(expression).not.toContain("'button',");
    expect(expression).not.toContain("'[role=\"button\"]',");
  });

  test("assistant extractor prefers the last assistant message inside a grouped turn", () => {
    const expression = buildAssistantExtractorForTest("capture");
    expect(expression).toContain("const assistantMessages = Array.from(turn.querySelectorAll");
    expect(expression).toContain("assistantMessages[assistantMessages.length - 1] ?? turn");
  });

  test("assistant extractor strongly prefers specific assistant roots over longer turn wrappers", () => {
    const expression = buildAssistantExtractorForTest("capture");
    expect(expression).toContain("current.rank * 10000 + current.text.length");
    expect(expression).toContain("candidate.rank * 10000 + candidate.text.length");
  });

  test("conversation debug expression references conversation selector", () => {
    const expression = buildConversationDebugExpressionForTest();
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
  });

  test("markdown fallback filters user turns and respects assistant indicators", () => {
    const expression = buildMarkdownFallbackExtractorForTest("2");
    expect(expression).not.toContain("const MIN_TURN_INDEX = (MIN_TURN_INDEX");
    expect(expression).toContain("const __minTurn");
    expect(expression).toContain("role !== 'user'");
    expect(expression).toContain("copy-turn-action-button");
    expect(expression).toContain(CONVERSATION_TURN_SELECTOR);
  });

  test("markdown fallback does not self-reference MIN_TURN_INDEX literal", () => {
    const expression = buildMarkdownFallbackExtractorForTest("MIN_TURN_INDEX");
    expect(expression).toContain("MIN_TURN_INDEX");
    expect(expression).not.toContain("const MIN_TURN_INDEX = (MIN_TURN_INDEX");
    expect(expression).toContain("const __minTurn");
  });

  test("assistant snapshot expression does not return raw placeholder turns when fallback is empty", () => {
    const expression = buildAssistantSnapshotExpressionForTest(2);
    expect(expression).toContain(
      "const extractedCandidate = extracted && extracted.text && !isPlaceholder(extracted) ? extracted : null;",
    );
    expect(expression).toContain("return fallback() ?? null;");
    expect(expression).not.toContain("return fallback() ?? extracted;");
  });

  test("assistant snapshot expression treats progress-only project-view status text as transient", () => {
    const expression = buildAssistantSnapshotExpressionForTest(2);
    expect(expression).toContain("if (progressOnly) return true;");
    expect(expression).toContain("starting|finalizing answer");
  });

  test("copy expression scopes to assistant turn buttons", () => {
    const expression = buildCopyExpressionForTest({});
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
    expect(expression).toContain(ASSISTANT_ROLE_SELECTOR);
    expect(expression).toContain("isAssistantTurn");
    expect(expression).toContain("isAssistantButton");
    expect(expression).toContain("copy-turn-action-button");
    expect(expression).toContain("return null;");
  });

  test("assistant response expressions filter nested conversation turn wrappers", () => {
    expect(buildAssistantSnapshotExpressionForTest(2)).toContain("parentElement?.closest");
    expect(buildMarkdownFallbackExtractorForTest("2")).toContain("parentElement?.closest");
    expect(buildCopyExpressionForTest({})).toContain("parentElement?.closest");
  });
});
