import { describe, expect, test } from "vitest";
import {
  buildAssistantExtractorForTest,
  buildAssistantSnapshotExpressionForTest,
  buildConversationDebugExpressionForTest,
  buildMarkdownFallbackExtractorForTest,
  buildCopyExpressionForTest,
  buildUserTurnAttachmentExpressionForTest,
} from "../../src/browser/pageActions.ts";
import {
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  ASSISTANT_ROLE_SELECTOR,
} from "../../src/browser/constants.ts";

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

  test("exact prompt scope rejects an answer after any later user turn", () => {
    class FakeElement {
      readonly dataset: Record<string, string>;

      constructor(
        private readonly role: "user" | "assistant",
        readonly innerText: string,
        private readonly index: number,
      ) {
        this.dataset = {
          turn: role,
          turnId: `turn-${index}`,
          messageId: `message-${index}`,
        };
      }

      get textContent(): string {
        return this.innerText;
      }

      get innerHTML(): string {
        return this.innerText;
      }

      get id(): string {
        return `conversation-turn-${this.index}`;
      }

      getAttribute(name: string): string | null {
        if (name === "data-message-author-role" || name === "data-turn") return this.role;
        if (name === "data-turn-id") return `turn-${this.index}`;
        if (name === "data-message-id") return `message-${this.index}`;
        if (name === "data-testid") return `conversation-turn-${this.index}`;
        return null;
      }

      matches(selector: string): boolean {
        return (
          selector === "[data-message-id]" ||
          (this.role === "user" && selector.includes('[data-message-author-role="user"]'))
        );
      }

      querySelector(selector: string): FakeElement | null {
        if (selector.includes('data-message-author-role="user"') && this.role === "user") {
          return this;
        }
        return null;
      }

      querySelectorAll(selector: string): Array<{
        innerText: string;
        textContent: string;
        closest: () => null;
        contains: () => boolean;
      }> {
        return this.role === "user" && selector.includes("[data-message-content]")
          ? [
              {
                innerText: this.innerText,
                textContent: this.innerText,
                closest: () => null,
                contains: () => false,
              },
            ]
          : [];
      }
    }

    const locator = {
      epoch: {
        status: "committed" as const,
        epochId: "epoch-original",
        promptSha256: "a".repeat(64),
        baselineTurns: 0,
        followUpOrdinal: 0,
        remainingFollowUps: 0,
        verifiedUserTurnIndex: 0,
        verifiedUserTurnId: "turn-0",
        verifiedUserMessageId: "message-0",
        conversationId: "conversation-1",
      },
      conversationId: "conversation-1",
      promptSha256: "a".repeat(64),
      verifiedUserTurnIndex: 0,
      verifiedUserTurnId: "turn-0",
      verifiedUserMessageId: "message-0",
      conversationUrls: ["https://chatgpt.com/c/conversation-1"],
    };
    const expression = buildAssistantExtractorForTest("capture", locator);
    const evaluate = (turns: FakeElement[]) =>
      Function(
        "document",
        "HTMLElement",
        "location",
        `${expression}; return capture();`,
      )(
        {
          querySelectorAll: (selector: string) =>
            selector === CONVERSATION_TURN_CONTAINER_SELECTOR ? turns : [],
        },
        FakeElement,
        { href: "https://chatgpt.com/c/conversation-1" },
      ) as { text?: string; turnIndex?: number } | null;

    expect(
      evaluate([
        new FakeElement("user", "original prompt", 0),
        new FakeElement("assistant", "original answer", 1),
      ]),
    ).toMatchObject({ text: "original answer", turnIndex: 1 });
    expect(
      evaluate([
        new FakeElement("user", "original prompt", 0),
        new FakeElement("assistant", "original answer", 1),
        new FakeElement("user", "later unrelated prompt", 2),
        new FakeElement("assistant", "later unrelated answer", 3),
      ]),
    ).toBeNull();
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

  test("markdown fallback filters user turns and respects assistant indicators", () => {
    const expression = buildMarkdownFallbackExtractorForTest("2");

    // Role recognition comes from the canonical conversation-turn helper. The fallback must
    // apply that helper when excluding user markdown and when preferring assistant markdown.
    expect(expression).toContain("const __minTurn");
    expect(expression).toContain(
      `const ASSISTANT_TURN_SELECTOR = ${JSON.stringify(ASSISTANT_ROLE_SELECTOR)};`,
    );
    expect(expression).toContain("const isUserTurn = (node) =>");
    expect(expression).toContain("return !container || !isUserTurn(container);");
    expect(expression).toContain("return Boolean(container && isAssistantTurn(container));");
  });

  test("markdown fallback does not self-reference MIN_TURN_INDEX literal", () => {
    const expression = buildMarkdownFallbackExtractorForTest("MIN_TURN_INDEX");
    expect(expression).toContain("MIN_TURN_INDEX");
    expect(expression).not.toContain("const MIN_TURN_INDEX = (MIN_TURN_INDEX");
    expect(expression).toContain("const __minTurn");
  });

  test("copy expression scopes to assistant turn buttons", () => {
    const expression = buildCopyExpressionForTest({});

    // The unhinted fallback must traverse canonical conversation turns, skip user turns, and
    // only query a copy button within an assistant turn.
    expect(expression).toContain(
      `const ASSISTANT_TURN_SELECTOR = ${JSON.stringify(ASSISTANT_ROLE_SELECTOR)};`,
    );
    expect(expression).toContain("const isAssistantTurn = (node) => {");
    expect(expression).toContain("if (!isAssistantTurn(turn)) continue;");
    expect(expression).toContain("turn.querySelector(BUTTON_SELECTOR)");
    expect(expression).toContain("if (turn && isAssistantTurn(turn)) {");
  });

  test("user-turn attachment expression requires non-empty prompt text for prefix fallback", () => {
    const expression = buildUserTurnAttachmentExpressionForTest({
      expectedPromptPrefix: "expected prompt text",
    });
    expect(expression).toContain("const textPrefix = text.slice");
    expect(expression).toContain("text.length > 0");
    expect(expression).toContain("textPrefix.length > 0");
  });
});
