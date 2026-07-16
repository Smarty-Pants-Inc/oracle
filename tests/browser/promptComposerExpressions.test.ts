import { describe, expect, test } from "vitest";
import { buildAttachmentReadyExpressionForTest } from "../../src/browser/actions/promptComposer.ts";

describe("prompt composer attachment expressions", () => {
  test("attachment ready check does not match prompt text", () => {
    const expression = buildAttachmentReadyExpressionForTest(["oracle-attach-verify.txt"]);
    expect(expression).toContain("document.querySelector('[data-testid*=\"composer\"]')");
    expect(expression).toContain("composerAttachments.length > 0");
    expect(expression).toContain('input[type="file"]');
    expect(expression).toContain("fileNameMatches(file?.name, name)");
    expect(expression).toContain("renderedTokens(node)");
    expect(expression).toContain(".flatMap((value)");
    expect(expression).not.toContain("getAttribute?.('data-testid')");
    expect(expression).toContain("token === name");
    expect(expression).toContain("composerInputs.length > 0");
    expect(expression).not.toContain("file?.name?.toLowerCase?.().includes(name)");
    expect(expression).not.toContain("fileNoExt");
    expect(expression).toContain('[aria-label*="Remove file"]');
    expect(expression).toContain("getAttribute?.('aria-label')");
    expect(expression).not.toContain("a,div,span");
    expect(expression).not.toContain(
      'document.querySelectorAll(\'[data-testid*="chip"],[data-testid*="attachment"],a,div,span\')',
    );
  });

  test("attachment ready check tolerates ChatGPT numbered renames", () => {
    const expression = buildAttachmentReadyExpressionForTest(["attachments-bundle.txt"]);
    expect(() => new Function(`return ${expression}`)).not.toThrow();
    expect(expression).toContain("numberedRenameMatch");
    // The injected matcher must accept "name(2).ext" dedupe renames without substring fallback.
    expect(expression).toContain(
      "const middle = token.slice(stem.length, token.length - ext.length);",
    );
    expect(expression).toContain("/^\\(\\d+\\)$/.test(middle)");
  });
});
