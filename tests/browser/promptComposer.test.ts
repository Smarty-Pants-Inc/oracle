import { describe, expect, test, vi } from "vitest";
import {
  __test__ as promptComposer,
  clearPromptComposer,
  submitPrompt,
} from "../../src/browser/actions/promptComposer.js";
import {
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
} from "../../src/browser/constants.js";
import { verifyCommittedPromptTurn } from "../../src/browser/actions/assistantResponse.js";
import type { CommittedPromptEpochLocator } from "../../src/browser/reattachability.js";

describe("promptComposer", () => {
  test("fails composer clearing when stale text remains", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { cleared: true, remaining: ["old draft"] } },
      }),
    } as unknown as {
      evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
    };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await expect(clearPromptComposer(runtime as never, logger as never)).rejects.toThrow(
      /Failed to clear prompt composer/,
    );
  });

  test("refuses commit verification without a finite pre-dispatch baseline", async () => {
    const runtime = { evaluate: vi.fn() };

    await expect(
      promptComposer.verifyPromptCommitted(runtime as never, "hello", 150, undefined, Number.NaN),
    ).rejects.toMatchObject({
      details: { stage: "submit-prompt", code: "prompt-baseline-unavailable" },
    });
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });

  test("commits and verifies a container whose user role exists only in nested data-turn markup", async () => {
    const nestedUser = {
      dataset: { messageId: "nested-message" },
      getAttribute(name: string): string | null {
        if (name === "data-turn") return "user";
        if (name === "data-message-id") return "nested-message";
        return null;
      },
      querySelector: () => null,
    };
    const container = {
      innerText: "Exact nested prompt",
      textContent: "Exact nested prompt",
      dataset: { turnId: "nested-turn" },
      getAttribute(name: string): string | null {
        if (name === "data-testid") return "conversation-turn-nested";
        if (name === "data-turn-id") return "nested-turn";
        return null;
      },
      matches: () => false,
      querySelector(selector: string) {
        if (selector.includes('[data-turn="user"]')) return nestedUser;
        if (selector === "[data-message-id]") return nestedUser;
        return null;
      },
    };
    const document = {
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (
          selector === CONVERSATION_TURN_CONTAINER_SELECTOR ||
          selector === CONVERSATION_TURN_SELECTOR
        ) {
          return [container];
        }
        return [];
      },
    };
    class FakeTextArea {}
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: Function(
            "document",
            "HTMLTextAreaElement",
            "location",
            `return ${expression};`,
          )(document, FakeTextArea, { href: "https://chatgpt.com/c/nested-user" }),
        },
      })),
    };

    const committed = await promptComposer.verifyPromptCommitted(
      runtime as never,
      "Exact nested prompt",
      150,
      undefined,
      0,
    );

    const locator: CommittedPromptEpochLocator = {
      epoch: {
        status: "committed",
        epochId: "nested-user-prompt-epoch-0",
        promptSha256: committed.promptSha256,
        baselineTurns: 0,
        followUpOrdinal: 0,
        remainingFollowUps: 0,
        verifiedUserTurnIndex: committed.verifiedUserTurnIndex,
        verifiedUserTurnId: committed.verifiedUserTurnId,
        verifiedUserMessageId: committed.verifiedUserMessageId,
        conversationId: committed.conversationId,
      },
      conversationId: committed.conversationId,
      promptSha256: committed.promptSha256,
      verifiedUserTurnIndex: committed.verifiedUserTurnIndex,
      verifiedUserTurnId: committed.verifiedUserTurnId,
      verifiedUserMessageId: committed.verifiedUserMessageId,
      conversationUrls: ["https://chatgpt.com/c/nested-user"],
    };

    await expect(verifyCommittedPromptTurn(runtime as never, locator)).resolves.toBeUndefined();
  });

  test("does not commit an exact prompt turn without stable turn and message ids", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              baseline: 0,
              turnsCount: 1,
              matchedUserTurnIndex: 0,
              matchedUserTurnId: null,
              matchedUserMessageId: null,
              matchedUserTurnText: "hello",
              conversationId: "conversation-1",
            },
          },
        }),
      };
      const pending = promptComposer.verifyPromptCommitted(
        runtime as never,
        "hello",
        150,
        undefined,
        0,
      );
      const assertion = expect(pending).rejects.toThrow(/prompt did not appear/i);

      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not treat historical assistant content as committed without a new turn", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          // Baseline read (turn count)
          .mockResolvedValueOnce({ result: { value: 10 } })
          // Polls (repeat)
          .mockResolvedValue({
            result: {
              value: {
                baseline: 10,
                turnsCount: 10,
                userMatched: false,
                prefixMatched: false,
                lastMatched: false,
                hasNewTurn: false,
                stopVisible: true,
                assistantVisible: true,
                composerCleared: true,
                inConversation: false,
              },
            },
          }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(
        runtime as never,
        "hello",
        150,
        undefined,
        10,
      );
      // Attach the rejection handler before timers advance to avoid unhandled-rejection warnings.
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not count nested broad-selector matches as new turns in a reused conversation", async () => {
    vi.useFakeTimers();
    try {
      const topLevelTurns = [{ innerText: "old user" }, { innerText: "old assistant" }];
      const nestedMatches = [
        topLevelTurns[0],
        { innerText: "old user" },
        topLevelTurns[1],
        { innerText: "old assistant" },
      ];
      const document = {
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === CONVERSATION_TURN_CONTAINER_SELECTOR) return topLevelTurns;
          if (selector === CONVERSATION_TURN_SELECTOR) return nestedMatches;
          return [];
        },
      };
      class FakeTextArea {}
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
          result: {
            value: Function(
              "document",
              "HTMLTextAreaElement",
              "location",
              `return ${expression};`,
            )(document, FakeTextArea, { href: "https://chatgpt.com/c/reused" }),
          },
        })),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(
        runtime as never,
        "new prompt",
        150,
        undefined,
        2,
      );
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("commit timeout throws a structured error with probe diagnostics", async () => {
    vi.useFakeTimers();
    try {
      const probe = {
        baseline: 10,
        turnsCount: 10,
        userMatched: false,
        prefixMatched: false,
        lastMatched: false,
        hasNewTurn: false,
        stopVisible: false,
        assistantVisible: false,
        composerCleared: true,
        inConversation: false,
        editorValue: "",
        lastTurn: "previous turn text",
      };
      const runtime = {
        evaluate: vi
          .fn()
          // Baseline read (turn count)
          .mockResolvedValueOnce({ result: { value: 10 } })
          // Polls + final diagnostic probe
          .mockResolvedValue({ result: { value: probe } }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(
        runtime as never,
        "hello",
        150,
        undefined,
        10,
      );
      const assertion = promise.then(
        () => {
          throw new Error("expected verifyPromptCommitted to reject");
        },
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(250);
      const error = (await assertion) as {
        name?: string;
        details?: Record<string, unknown>;
        message?: string;
      };
      expect(error.message).toMatch(/prompt did not appear/i);
      expect(error.name).toBe("BrowserAutomationError");
      expect(error.details).toMatchObject({
        stage: "submit-prompt",
        code: "prompt-commit-timeout",
        commitProbe: expect.objectContaining({
          hasNewTurn: false,
          composerCleared: true,
          turnsCount: 10,
          lastTurnLength: "previous turn text".length,
        }),
      });
      // Free text must not leak into the structured details.
      const commitProbe = error.details?.commitProbe as Record<string, unknown>;
      expect(commitProbe).not.toHaveProperty("lastTurn");
      expect(commitProbe).not.toHaveProperty("editorValue");
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not let a historical repeated prompt authorize an unrelated new turn", async () => {
    vi.useFakeTimers();
    try {
      const makeTurn = (role: "user" | "assistant", text: string, index: number) => {
        const node = {
          innerText: text,
          textContent: text,
          id: `conversation-turn-${index}`,
          dataset: {
            turn: role,
            turnId: `turn-${index}`,
            messageId: `message-${index}`,
          },
          getAttribute(name: string) {
            if (name === "data-message-author-role" || name === "data-turn") return role;
            if (name === "data-turn-id") return `turn-${index}`;
            if (name === "data-message-id") return `message-${index}`;
            return null;
          },
          matches(selector: string) {
            return selector === "[data-message-id]";
          },
          querySelector(selector: string) {
            if (selector === "[data-message-id]") {
              return {
                dataset: { messageId: `message-${index}` },
                getAttribute: () => `message-${index}`,
              };
            }
            if (selector === '[data-message-author-role="user"]' && role === "user") return {};
            return null;
          },
        };
        return node;
      };
      const topLevelTurns = [
        makeTurn("user", "repeat this prompt", 0),
        makeTurn("assistant", "historical answer", 1),
        makeTurn("user", "an unrelated new prompt", 2),
      ];
      const document = {
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === CONVERSATION_TURN_CONTAINER_SELECTOR) return topLevelTurns;
          if (selector === CONVERSATION_TURN_SELECTOR) return topLevelTurns;
          return [];
        },
      };
      class FakeTextArea {}
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
          result: {
            value: Function(
              "document",
              "HTMLTextAreaElement",
              "location",
              `return ${expression};`,
            )(document, FakeTextArea, { href: "https://chatgpt.com/c/repeated-prompt" }),
          },
        })),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(
        runtime as never,
        "repeat this prompt",
        150,
        undefined,
        2,
      );
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects a new user turn that shares the first 120 characters but has a different suffix", async () => {
    vi.useFakeTimers();
    try {
      const sharedPrefix = "x".repeat(120);
      const intendedPrompt = `${sharedPrefix} intended suffix`;
      const observedPrompt = `${sharedPrefix} unrelated suffix`;
      const turn = {
        innerText: observedPrompt,
        textContent: observedPrompt,
        id: "conversation-turn-0",
        dataset: { turn: "user", turnId: "turn-0", messageId: "message-0" },
        getAttribute(name: string) {
          if (name === "data-message-author-role" || name === "data-turn") return "user";
          if (name === "data-turn-id") return "turn-0";
          if (name === "data-message-id") return "message-0";
          return null;
        },
        matches: (selector: string) => selector === "[data-message-id]",
        querySelector: () => null,
      };
      const document = {
        querySelector: () => null,
        querySelectorAll: (selector: string) =>
          selector === CONVERSATION_TURN_CONTAINER_SELECTOR ||
          selector === CONVERSATION_TURN_SELECTOR
            ? [turn]
            : [],
      };
      class FakeTextArea {}
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
          result: {
            value: Function(
              "document",
              "HTMLTextAreaElement",
              "location",
              `return ${expression};`,
            )(document, FakeTextArea, { href: "https://chatgpt.com/c/exact-suffix" }),
          },
        })),
      };

      const pending = promptComposer.verifyPromptCommitted(
        runtime as never,
        intendedPrompt,
        150,
        undefined,
        0,
      );
      const assertion = expect(pending).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("commits the exact prompt with stable data-testid and message identities", async () => {
    const messageNode = {
      dataset: { messageId: "message-0" },
      getAttribute: (name: string) => (name === "data-message-id" ? "message-0" : null),
    };
    const turn = {
      innerText: "Exact prompt text",
      textContent: "Exact prompt text",
      dataset: { turn: "user" },
      getAttribute(name: string) {
        if (name === "data-message-author-role" || name === "data-turn") return "user";
        if (name === "data-testid") return "conversation-turn-0";
        return null;
      },
      matches: () => false,
      querySelector: (selector: string) => (selector === "[data-message-id]" ? messageNode : null),
    };
    const document = {
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector === CONVERSATION_TURN_CONTAINER_SELECTOR || selector === CONVERSATION_TURN_SELECTOR
          ? [turn]
          : [],
    };
    class FakeTextArea {}
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: Function(
            "document",
            "HTMLTextAreaElement",
            "location",
            `return ${expression};`,
          )(document, FakeTextArea, { href: "https://chatgpt.com/c/exact-conversation" }),
        },
      })),
    };

    await expect(
      promptComposer.verifyPromptCommitted(
        runtime as never,
        "Exact prompt text",
        150,
        undefined,
        0,
      ),
    ).resolves.toMatchObject({
      verifiedUserTurnIndex: 0,
      verifiedUserTurnId: "conversation-turn-0",
      verifiedUserMessageId: "message-0",
      conversationId: "exact-conversation",
    });
  });

  test("attachment sends time out instead of allowing Enter fallback", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("dispatchClickSequence")) {
            return { result: { value: { status: "disabled" } } };
          }
          return { result: { value: true } };
        }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.attemptSendButton(
        runtime as never,
        (() => undefined) as never,
        undefined,
        ["oracle-attach-verify.txt"],
      );
      const assertion = expect(promise).rejects.toThrow(/after 45s/i);
      await vi.advanceTimersByTimeAsync(46_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("checks an enabled attachment send button even when secondary evidence is stale", async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("const expected =")) {
          return { result: { value: false } };
        }
        return { result: { value: { status: "point", x: 10, y: 20 } } };
      });
      const input = { dispatchMouseEvent: vi.fn().mockResolvedValue(undefined) };
      const pending = promptComposer.attemptSendButton(
        { evaluate } as never,
        input as never,
        undefined,
        ["first.md", "second.md"],
        300,
      );
      const assertion = expect(pending).resolves.toBe(true);

      await vi.advanceTimersByTimeAsync(1_500);
      await assertion;
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("only attachment sends get the longer send-button deadline", () => {
    expect(promptComposer.sendButtonTimeoutMs()).toBe(20_000);
    expect(promptComposer.sendButtonTimeoutMs([])).toBe(20_000);
    expect(promptComposer.sendButtonTimeoutMs(["oracle-attach-verify.txt"])).toBe(45_000);
    expect(promptComposer.sendButtonTimeoutMs(["oracle-attach-verify.txt"], 120_000)).toBe(120_000);
  });

  test("marks prompt dispatch before commit verification", async () => {
    const events: string[] = [];
    const onPromptDispatchStarted = vi.fn(() => {
      events.push("dispatch");
    });
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("document.readyState")) {
          return { result: { value: { ready: true, composer: true, fileInput: false } } };
        }
        if (expression.includes("focused: true")) {
          return { result: { value: { focused: true } } };
        }
        if (expression.includes("editorText")) {
          return {
            result: { value: { editorText: "hello", fallbackValue: "", activeValue: "hello" } },
          };
        }
        if (expression.includes("button.scrollIntoView")) {
          return { result: { value: { status: "clicked" } } };
        }
        events.push("verify");
        return {
          result: {
            value: {
              baseline: 0,
              turnsCount: 1,
              matchedUserTurnIndex: 0,
              matchedUserTurnId: "turn-1",
              matchedUserMessageId: "message-1",
              matchedUserTurnText: "hello",
              hasNewTurn: true,
              stopVisible: true,
              assistantVisible: false,
              composerCleared: true,
              inConversation: true,
              conversationId: "conversation-1",
            },
          },
        };
      }),
    };
    const input = { insertText: vi.fn(), dispatchKeyEvent: vi.fn() };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await submitPrompt(
      {
        runtime: runtime as never,
        input: input as never,
        baselineTurns: 0,
        onPromptDispatchStarted,
      },
      "hello",
      logger as never,
    );

    expect(onPromptDispatchStarted).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["dispatch", "verify"]);
  });

  test("waits for a delayed trusted click without issuing a second send", async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn().mockResolvedValue({
        result: { value: { status: "point", x: 10, y: 20 } },
      });
      const input = {
        dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
          if (type === "mouseReleased") {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }),
      };

      const result = promptComposer.attemptSendButton(
        { evaluate } as never,
        input as never,
        undefined,
        undefined,
      );
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe(true);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
