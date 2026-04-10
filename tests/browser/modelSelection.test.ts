import { describe, expect, it } from "vitest";
import {
  buildModelMatchersLiteralForTest,
  buildModelSelectionExpressionForTest,
} from "../../src/browser/actions/modelSelection.js";

const expectContains = (arr: string[], value: string) => {
  expect(arr).toContain(value);
};

describe("browser model selection matchers", () => {
  it("includes pro + 5.4 tokens for gpt-5.4-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.4-pro");
    expect(labelTokens.some((t) => t.includes("pro"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.4") || t.includes("5-4"))).toBe(true);
    expect(testIdTokens.some((t) => t.includes("gpt-5.4-pro") || t.includes("gpt-5-4-pro"))).toBe(
      true,
    );
  });

  it("includes rich tokens for gpt-5.1", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.1");
    expectContains(labelTokens, "gpt-5.1");
    expectContains(labelTokens, "gpt-5-1");
    expectContains(labelTokens, "gpt51");
    expectContains(labelTokens, "chatgpt 5.1");
    expectContains(testIdTokens, "gpt-5-1");
    expect(
      testIdTokens.some(
        (t) => t.includes("gpt-5.1") || t.includes("gpt-5-1") || t.includes("gpt51"),
      ),
    ).toBe(true);
  });

  it("includes pro/research tokens for gpt-5.2-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.2-pro");
    expect(labelTokens.some((t) => t.includes("pro") || t.includes("research"))).toBe(true);
    expectContains(testIdTokens, "gpt-5.2-pro");
    expect(testIdTokens.some((t) => t.includes("model-switcher-gpt-5.2-pro"))).toBe(true);
  });

  it("includes pro + 5.2 tokens for gpt-5.2-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.2-pro");
    expect(labelTokens.some((t) => t.includes("pro"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.2") || t.includes("5-2"))).toBe(true);
    expect(testIdTokens.some((t) => t.includes("gpt-5.2-pro") || t.includes("gpt-5-2-pro"))).toBe(
      true,
    );
  });

  it("includes thinking tokens for gpt-5.2-thinking", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.2-thinking");
    expect(labelTokens.some((t) => t.includes("thinking"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.2") || t.includes("5-2"))).toBe(true);
    expect(testIdTokens).toContain("model-switcher-gpt-5-2-thinking");
    expect(testIdTokens).toContain("gpt-5.2-thinking");
  });

  it("includes instant tokens for gpt-5.2-instant", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.2-instant");
    expect(labelTokens.some((t) => t.includes("instant"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.2") || t.includes("5-2"))).toBe(true);
    expect(testIdTokens).toContain("model-switcher-gpt-5-2-instant");
    expect(testIdTokens).toContain("gpt-5.2-instant");
  });

  it("closes the menu after a successful selection path", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.4");
    expect(expression).toContain("const closeMenu = () =>");
    expect(expression).toContain("key: 'Escape'");
    expect(expression).toContain("closeMenu();");
  });

  it("inspects the selected picker option instead of trusting the top bar label", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.4-pro");
    expect(expression).toContain("const findSelectedOption = () =>");
    expect(expression).toContain("const resolveCurrentSelectionLabel = () =>");
    expect(expression).toContain("selectionMatchesTarget()");
  });

  it("uses button metadata and caps repeated target clicks to avoid picker thrash", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.4-pro");
    expect(expression).toContain("const getButtonLabelCandidates = () =>");
    expect(expression).toContain("button.getAttribute('aria-label')");
    expect(expression).toContain("let repeatedTargetClicks = 0;");
    expect(expression).toContain("repeatedTargetClicks >= 2");
  });

  it("returns early when the button already matches the requested model", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.4-pro");
    expect(expression).toContain("} else if (buttonMatchesTarget()) {");
    expect(expression).toContain(
      "resolve({ status: 'already-selected', label: getButtonLabel() || PRIMARY_LABEL });",
    );
  });

  it("does not blindly click the picker when the menu is already visible", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.4-pro");
    expect(expression).toContain("if (getAssociatedMenuRoots().length === 0) {");
    expect(expression).toContain("// Open once only when the model menu is not already visible.");
  });

  it("requires explicit version evidence before trusting top-bar shorthand labels", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.4-pro");
    expect(expression).toContain("const buttonCandidateMatchesTarget = (candidate, testId) =>");
    expect(expression).toContain("if (!desiredVersion) {");
    expect(expression).toContain("if (!candidateVersion) {");
    expect(expression).toContain("return candidateVersion === desiredVersion;");
  });

  it("keeps versioned button matching strict enough to reject bare shorthand labels", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.4-pro");
    expect(expression).toContain("if (!candidateVersion) {");
    expect(expression).not.toContain("buttonReflectsClickedMatch");
  });

  it("falls back to visible menu roots before scanning page-wide buttons", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.4-pro");
    expect(expression).toContain("const isVisibleMenuRoot = (root) => {");
    expect(expression).toContain("const rootDistanceFromButton = (root) => {");
    expect(expression).toContain("const menuRoots = Array.from(document.querySelectorAll(");
    expect(expression).toContain("isVisibleMenuRoot(root)");
    expect(expression).toContain(
      ".sort((left, right) => rootDistanceFromButton(left) - rootDistanceFromButton(right))[0];",
    );
    expect(expression).toContain("return nearestVisibleRoot ? [nearestVisibleRoot] : [];");
  });

  it("handles the follow-up thinking-time chooser after selecting Pro/Thinking", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.4-pro");
    expect(expression).toContain("const looksLikeThinkingTimeMenu = () =>");
    expect(expression).toContain("const pickThinkingTimeFallback = () =>");
    expect(expression).toContain(
      "if ((wantsPro || wantsThinking) && looksLikeThinkingTimeMenu()) {",
    );
    expect(expression).toContain("setTimeout(attempt, Math.max(120, INITIAL_WAIT_MS));");
    expect(expression).not.toContain(
      "resolve({ status: 'switched', label: match.label || fallbackThinkingTime })",
    );
  });

  it("accepts an exact versioned picker hit when ChatGPT keeps the top button generic", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.4-pro");
    expect(expression).toContain("const clickedExactVersionedOption = (match) =>");
    expect(expression).toContain("const usesGenericModelButton = () =>");
    expect(expression).toContain("return normalizedButtonLabel === 'chatgpt';");
    expect(expression).toContain("clickedExactVersionedOption(match) &&");
    expect(expression).toContain("usesGenericModelButton() &&");
    expect(expression).toContain(
      "resolve({ status: 'switched', label: match.label || PRIMARY_LABEL });",
    );
  });
});
