import { describe, expect, it } from "vitest";
import { buildThinkingTimeExpressionForTest } from "../../src/browser/actions/thinkingTime.js";

describe("browser thinking-time selection expression", () => {
  it("uses centralized menu selectors and normalized matching", () => {
    const expression = buildThinkingTimeExpressionForTest();
    expect(expression).toContain("const MENU_CONTAINER_SELECTOR");
    expect(expression).toContain("const MENU_ITEM_SELECTOR");
    expect(expression).toContain("const CHIP_SELECTORS");
    expect(expression).toContain("const MENU_LABELS");
    expect(expression).toContain('role=\\"menu\\"');
    expect(expression).toContain("data-radix-collection-root");
    expect(expression).toContain('role=\\"menuitem\\"');
    expect(expression).toContain('role=\\"menuitemradio\\"');
    expect(expression).toContain("normalize");
    expect(expression).toContain("thinking effort");
    expect(expression).toContain('.__composer-pill[aria-haspopup=\\"menu\\"]');
    expect(expression).toContain("extended");
    expect(expression).toContain("standard");
  });

  it("targets the requested thinking time level", () => {
    const levels = ["light", "standard", "extended", "heavy"] as const;
    for (const level of levels) {
      const expression = buildThinkingTimeExpressionForTest(level);
      expect(expression).toContain("const TARGET_LEVEL");
      expect(expression).toContain(`"${level}"`);
    }
  });

  it("reuses an existing thinking-time menu before clicking any composer chip", () => {
    const expression = buildThinkingTimeExpressionForTest("extended");
    expect(expression).toContain("const findThinkingMenu = () => {");
    expect(expression).toContain("const ensureThinkingMenu = async () => {");
    expect(expression).toContain("const existingMenu = findThinkingMenu();");
    expect(expression).toContain("return { status: 'ready', menu: existingMenu };");
  });

  it("ranks thinking-time chip candidates without falling back to the Pro model chip", () => {
    const expression = buildThinkingTimeExpressionForTest("extended");
    expect(expression).toContain("const collectThinkingChipCandidates = () => {");
    expect(expression).toContain("const queryCandidateTriggers = () => {");
    expect(expression).toContain("const collectComposerRoots = () => {");
    expect(expression).toContain("const looksLikeModelChip = (metadata) =>");
    expect(expression).toContain("metadata === 'pro'");
    expect(expression).toContain("metadata.includes('switch model')");
    expect(expression).toContain("right.rect.top - left.rect.top");
    expect(expression).not.toContain("aria.includes('pro') || text.includes('pro')");
  });
});
