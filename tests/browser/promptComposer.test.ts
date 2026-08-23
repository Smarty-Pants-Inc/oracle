import { describe, expect, test, vi } from "vitest";
import {
  __test__ as promptComposer,
  clearPromptComposer,
  submitPrompt,
} from "../../src/browser/actions/promptComposer.js";
import {
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  PROMPT_PRIMARY_SELECTOR,
} from "../../src/browser/constants.js";

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

  test("does not accept a cleared-composer fallback without a matching submitted turn", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({ result: { value: 10 } })
          .mockResolvedValue({
            result: {
              value: {
                baseline: 10,
                turnsCount: 11,
                userMatched: false,
                prefixMatched: false,
                lastMatched: false,
                submittedTurnMatched: false,
                hasNewTurn: true,
                stopVisible: true,
                assistantVisible: true,
                composerCleared: true,
                inConversation: true,
                href: "https://chatgpt.com/c/unrelated",
              },
            },
          }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(runtime as never, "hello", 150);
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
  test("finds the submitted prompt at a refreshed baseline after prior-turn hydration", async () => {
    const turn = (role: "user" | "assistant", innerText: string) => ({
      innerText,
      getAttribute: (name: string) => (name === "data-message-author-role" ? role : null),
      querySelector: () => null,
    });
    const topLevelTurns = [
      turn("user", "old prompt"),
      turn("assistant", "old answer"),
      turn("assistant", "late hydrated answer"),
      turn("user", "new prompt"),
    ];
    const composer = {
      innerText: "",
      getBoundingClientRect: () => ({ width: 100, height: 40 }),
    };
    const document = {
      querySelector: (selector: string) => (selector === PROMPT_PRIMARY_SELECTOR ? composer : null),
      querySelectorAll: (selector: string) => {
        if (
          selector === CONVERSATION_TURN_CONTAINER_SELECTOR ||
          selector === CONVERSATION_TURN_SELECTOR
        ) {
          return topLevelTurns;
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
          )(document, FakeTextArea, { href: "https://chatgpt.com/c/reused" }),
        },
      })),
    } as unknown as {
      evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
    };

    await expect(
      promptComposer.verifyPromptCommitted(runtime as never, "new prompt", 150, undefined, 2),
    ).resolves.toEqual({
      turnsCount: 4,
      conversationUrl: "https://chatgpt.com/c/reused",
    });
  });

  test("does not combine a stale tail match with later composer clearance", async () => {
    vi.useFakeTimers();
    try {
      const firstProbe = {
        baseline: 2,
        turnsCount: 3,
        submittedTurnIndex: 2,
        submittedTurnMatched: true,
        hasNewTurn: true,
        lastMatched: true,
        composerKnown: true,
        composerCleared: false,
        inConversation: true,
        href: "https://chatgpt.com/c/reused",
      };
      const laterProbe = {
        ...firstProbe,
        turnsCount: 4,
        lastMatched: false,
        composerCleared: true,
        assistantVisible: true,
      };
      const runtime = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({ result: { value: firstProbe } })
          .mockResolvedValue({ result: { value: laterProbe } }),
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
      const assertion = expect(promise).rejects.toMatchObject({
        details: expect.objectContaining({ code: "prompt-commit-timeout" }),
      });
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
        evaluate: vi.fn().mockResolvedValue({ result: { value: probe } }),
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

  test("fails closed when no pre-send baseline is available", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              baseline: -1,
              turnsCount: 1,
              submittedTurnIndex: 0,
              submittedTurnMatched: true,
              hasNewTurn: false,
              lastMatched: true,
              composerKnown: true,
              composerCleared: true,
              inConversation: true,
              href: "https://chatgpt.com/c/created-for-prompt",
            },
          },
        }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(runtime as never, "hello", 150);
      const assertion = expect(promise).rejects.toMatchObject({
        details: expect.objectContaining({ code: "prompt-commit-timeout" }),
      });
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
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

  test("marks prompt submitted before commit verification finishes", async () => {
    const onPromptSubmitted = vi.fn();
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
        if (expression.trim().endsWith(").length")) {
          return { result: { value: 0 } };
        }
        if (expression.includes("button.scrollIntoView")) {
          return { result: { value: { status: "point", x: 1, y: 1 } } };
        }
        return {
          result: {
            value: {
              baseline: 0,
              turnsCount: 1,
              userMatched: true,
              prefixMatched: false,
              lastMatched: true,
              submittedTurnIndex: 0,
              submittedTurnMatched: true,
              hasNewTurn: true,
              stopVisible: true,
              assistantVisible: false,
              composerKnown: true,
              composerCleared: true,
              inConversation: true,
              href: "https://chatgpt.com/c/created-for-prompt",
            },
          },
        };
      }),
    };
    const input = {
      insertText: vi.fn(),
      dispatchKeyEvent: vi.fn(),
      dispatchMouseEvent: vi.fn(),
    };
    const logger = Object.assign(vi.fn(), { verbose: false });
    const assertPageAffinity = vi.fn().mockResolvedValue(undefined);

    await submitPrompt(
      {
        runtime: runtime as never,
        input: input as never,
        baselineTurns: 7,
        onPromptSubmitted,
        assertPageAffinity,
      },
      "hello",
      logger as never,
    );

    expect(onPromptSubmitted).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(runtime.evaluate)
        .mock.calls.some(([{ expression }]) => String(expression).includes("const baseline = 0;")),
    ).toBe(true);
    expect(assertPageAffinity.mock.calls.map(([action]) => action)).toEqual([
      "prompt composer focus",
      "prompt text insertion",
      "prompt send",
    ]);
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
