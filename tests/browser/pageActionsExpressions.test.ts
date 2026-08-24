import { describe, expect, test } from "vitest";
import {
  buildAssistantExtractorForTest,
  buildAssistantSnapshotExpressionForTest,
  buildConversationDebugExpressionForTest,
  buildMarkdownFallbackExtractorForTest,
  buildCopyExpressionForTest,
  buildResponseObserverExpressionForTest,
  buildUserTurnAttachmentExpressionForTest,
} from "../../src/browser/pageActions.ts";
import {
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  ASSISTANT_ROLE_SELECTOR,
} from "../../src/browser/constants.ts";
import { CHATGPT_ORIGINS } from "../../src/browser/conversationUrl.ts";

describe("browser automation expressions", () => {
  test("assistant extractor references constants", () => {
    const expression = buildAssistantExtractorForTest("capture");
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
    expect(expression).toContain(JSON.stringify(ASSISTANT_ROLE_SELECTOR));
  });

  test("assistant extractor treats image-only ChatGPT turns as responses", () => {
    const expression = buildAssistantExtractorForTest("capture");
    expect(expression).toContain("/backend-api/estuary/content?id=file_");
    expect(expression).toContain("Generated image.");
    expect(expression).toContain("stopped thinking edit");
    expect(expression).toContain("thought for");
  });

  test("assistant extractor indexes top-level turns instead of nested role nodes", () => {
    class FakeElement {
      readonly dataset: Record<string, string> = {};

      constructor(
        private readonly attributes: Record<string, string>,
        readonly innerText = "",
        private readonly children: FakeElement[] = [],
      ) {}

      get textContent(): string {
        return this.innerText;
      }

      get innerHTML(): string {
        return this.innerText;
      }

      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }

      matches(): boolean {
        return false;
      }

      querySelector(selector: string): FakeElement | null {
        if (selector === ASSISTANT_ROLE_SELECTOR) {
          return (
            this.children.find(
              (child) => child.getAttribute("data-message-author-role") === "assistant",
            ) ?? null
          );
        }
        return null;
      }

      querySelectorAll(): FakeElement[] {
        return [];
      }
    }

    const nestedUser = new FakeElement({ "data-message-author-role": "user" }, "old prompt");
    const nestedAssistant = new FakeElement(
      { "data-message-author-role": "assistant" },
      "old answer",
    );
    const userTurn = new FakeElement({ "data-testid": "conversation-turn-1" }, "old prompt", [
      nestedUser,
    ]);
    const assistantTurn = new FakeElement({ "data-testid": "conversation-turn-2" }, "old answer", [
      nestedAssistant,
    ]);
    const document = {
      querySelectorAll: (selector: string) => {
        if (selector === CONVERSATION_TURN_CONTAINER_SELECTOR) return [userTurn, assistantTurn];
        if (selector === CONVERSATION_TURN_SELECTOR) {
          return [userTurn, nestedUser, assistantTurn, nestedAssistant];
        }
        return [];
      },
    };
    const expression = buildAssistantExtractorForTest("capture");
    const result = Function(
      "document",
      "HTMLElement",
      `${expression}; return capture();`,
    )(document, FakeElement) as { text?: string; turnIndex?: number } | null;

    expect(result).toMatchObject({ text: "old answer", turnIndex: 1 });
  });

  test("conversation debug expression references conversation selector", () => {
    const expression = buildConversationDebugExpressionForTest();
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
  });

  test("assistant snapshot expression guards against conversation drift", () => {
    const expression = buildAssistantSnapshotExpressionForTest(4, "conv-123");
    expect(expression).toContain('const EXPECTED_CONVERSATION_ID = "conv-123"');
    expect(expression).toContain("currentConversationId !== EXPECTED_CONVERSATION_ID");
    expect(expression).toContain("return null;");
  });
  test("assistant snapshot expression rejects a missing conversation id", () => {
    const expression = buildAssistantSnapshotExpressionForTest(4, "conv-123");
    expect(expression).not.toContain("currentConversationId &&");
  });

  test("assistant snapshot expression accepts every supported ChatGPT origin", () => {
    const expression = buildAssistantSnapshotExpressionForTest(4, "conv-123");
    expect(expression).toContain(JSON.stringify(CHATGPT_ORIGINS[0]));
    expect(expression).toContain("currentPageUrl?.protocol === 'https:'");
    expect(expression).toContain("currentPageUrl.pathname");
  });

  test("assistant expressions preserve exact conversation origin and project path", () => {
    const conversationUrl = "https://chat.openai.com/g/team/project/c/conv-123";
    const snapshot = buildAssistantSnapshotExpressionForTest(
      4,
      "conv-123",
      undefined,
      conversationUrl,
    );
    const observer = buildResponseObserverExpressionForTest(5_000, 4, "conv-123", conversationUrl);
    const copy = buildCopyExpressionForTest({}, "conv-123", conversationUrl);
    for (const expression of [snapshot, observer, copy]) {
      expect(expression).toContain(JSON.stringify(conversationUrl));
      expect(expression).toContain("origin");
      expect(expression).toContain("pathname");
      expect(expression).toContain("search");
      expect(expression).toContain("hash");
    }
    expect(observer).toContain("approvedConversationScope");
    expect(copy).toContain("conversation-mismatch");
  });

  test("markdown fallback filters user turns and respects assistant indicators", () => {
    const expression = buildMarkdownFallbackExtractorForTest("2");
    expect(expression).not.toContain("const MIN_TURN_INDEX = (MIN_TURN_INDEX");
    expect(expression).toContain("const __minTurn");
    expect(expression).toContain("role !== 'user'");
    expect(expression).toContain("copy-turn-action-button");
    expect(expression).toContain(CONVERSATION_TURN_SELECTOR);
    expect(expression).toContain("turn.contains?.(node)");
  });

  test("markdown fallback does not self-reference MIN_TURN_INDEX literal", () => {
    const expression = buildMarkdownFallbackExtractorForTest("MIN_TURN_INDEX");
    expect(expression).toContain("MIN_TURN_INDEX");
    expect(expression).not.toContain("const MIN_TURN_INDEX = (MIN_TURN_INDEX");
    expect(expression).toContain("const __minTurn");
  });

  test("copy expression scopes to assistant turns and the expected conversation", () => {
    const expression = buildCopyExpressionForTest({}, "conv-123");
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
    expect(expression).toContain(ASSISTANT_ROLE_SELECTOR);
    expect(expression).toContain("isAssistantTurn");
    expect(expression).toContain("copy-turn-action-button");
    expect(expression).toContain('const EXPECTED_CONVERSATION_ID = "conv-123"');
    expect(expression).toContain("conversation-mismatch");
  });

  test("copy expression rechecks the conversation immediately before clicking", () => {
    const expression = buildCopyExpressionForTest({}, "conv-123");
    const clickIndex = expression.indexOf("dispatchClickSequence(button);");
    const guardIndex = expression.lastIndexOf("if (!matchesExpectedConversation())", clickIndex);
    const scrollIndex = expression.indexOf("button.scrollIntoView");

    expect(clickIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(-1);
    expect(scrollIndex).toBeGreaterThan(-1);
    expect(scrollIndex).toBeLessThan(guardIndex);
    expect(guardIndex).toBeLessThan(clickIndex);
  });

  test("user-turn attachment expression requires non-empty prompt text for prefix fallback", () => {
    const expression = buildUserTurnAttachmentExpressionForTest({
      expectedPromptPrefix: "expected prompt text",
    });
    expect(expression).toContain("const textPrefix = text.slice");
    expect(expression).toContain("text.length > 0");
    expect(expression).toContain("textPrefix.length > 0");
  });

  test("user-turn attachment expression rejects a missing conversation id", () => {
    const expression = buildUserTurnAttachmentExpressionForTest({
      expectedConversationId: "conv-123",
    });
    expect(expression).toContain("currentConversationId !== EXPECTED_CONVERSATION_ID");
    expect(expression).not.toContain("currentConversationId &&");
  });
});
