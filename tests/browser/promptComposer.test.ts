import { describe, expect, test, vi } from "vitest";
import {
  __test__ as promptComposer,
  clearPromptComposer,
  submitPrompt,
} from "../../src/browser/actions/promptComposer.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";

describe("promptComposer", () => {
  test("builds a syntactically valid prompt acceptance probe", () => {
    const expression = promptComposer.buildPromptAcceptanceProbeExpression(0);

    expect(() => new Function(`return ${expression}`)).not.toThrow();
  });

  test("fails in the short post-submit gate when ChatGPT never starts running", async () => {
    vi.useFakeTimers();
    try {
      const prompt = "hello acceptance gate";
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("document.readyState === 'complete'")) {
            return { result: { value: { ready: true, composer: true, fileInput: false } } };
          }
          if (expression.includes("const focusNode")) {
            return { result: { value: { focused: true } } };
          }
          if (
            expression.includes("editorText") &&
            expression.includes("fallbackValue") &&
            expression.includes("activeValue")
          ) {
            return {
              result: {
                value: { editorText: prompt, fallbackValue: "", activeValue: prompt },
              },
            };
          }
          if (expression.includes("dispatchClickSequence(button)")) {
            return { result: { value: "clicked" } };
          }
          return {
            result: {
              value: {
                baseline: 0,
                turnsCount: 0,
                userMatched: false,
                prefixMatched: false,
                lastMatched: false,
                hasNewTurn: false,
                stopVisible: false,
                assistantVisible: false,
                composerCleared: false,
                inConversation: false,
                href: "https://chatgpt.com/g/g-p-test/project",
                fallbackValue: prompt,
                editorValue: prompt,
                lastTurn: "",
              },
            },
          };
        }),
      };
      const input = {
        insertText: vi.fn().mockResolvedValue(undefined),
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
      };
      const logger = Object.assign(vi.fn(), { verbose: false });
      let rejection: unknown;
      let settled = false;
      const pending = submitPrompt(
        {
          runtime: runtime as never,
          input: input as never,
          baselineTurns: 0,
          inputTimeoutMs: 1_000,
        },
        prompt,
        logger as never,
      ).then(
        () => {
          settled = true;
        },
        (error) => {
          settled = true;
          rejection = error;
        },
      );

      await vi.advanceTimersByTimeAsync(5_600);

      expect(settled).toBe(true);
      expect(rejection).toBeInstanceOf(BrowserAutomationError);
      expect((rejection as BrowserAutomationError).details).toMatchObject({
        stage: "submit-prompt",
        code: "prompt-not-accepted",
      });
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  test("reports a login dialog during the post-submit gate as login-required", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            accepted: false,
            blockedBy: "login-required",
            signals: [],
            blockers: ["login-required"],
            evidence: {
              url: "https://chatgpt.com/",
              title: "ChatGPT",
              buttonLabels: ["Log in", "Sign up"],
              bodySnippet: "Log in to get answers tailored to you",
            },
          },
        },
      }),
    } as unknown as {
      evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
    };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await expect(
      promptComposer.waitForPromptAccepted(runtime as never, 5_000, logger as never, 0),
    ).rejects.toMatchObject({
      details: {
        stage: "submit-prompt",
        code: "login-required",
        blockers: ["login-required"],
      },
    });
  });

  test("accepts a thinking/status signal before waiting for the committed turn", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            accepted: true,
            signals: ["thinking-status"],
            blockers: [],
            evidence: {
              statusText: "Thinking",
              turnsCount: 10,
              baseline: 10,
            },
          },
        },
      }),
    } as unknown as {
      evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
    };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await expect(
      promptComposer.waitForPromptAccepted(runtime as never, 5_000, logger as never, 10),
    ).resolves.toMatchObject({
      accepted: true,
      signals: ["thinking-status"],
    });
  });

  test("retries through transient navigation while checking prompt acceptance", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        .mockRejectedValueOnce(
          new Error("Execution context was destroyed, probably because of a navigation."),
        )
        .mockResolvedValueOnce({
          result: {
            value: {
              accepted: true,
              signals: ["new-turn"],
              blockers: [],
              evidence: {
                turnsCount: 11,
                baseline: 10,
              },
            },
          },
        }),
    } as unknown as {
      evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
    };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await expect(
      promptComposer.waitForPromptAccepted(runtime as never, 5_000, logger as never, 10),
    ).resolves.toMatchObject({
      accepted: true,
      signals: ["new-turn"],
    });
  });

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

  test("does not treat cleared composer + stop button as committed without a new turn", async () => {
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
                assistantVisible: false,
                composerCleared: true,
                inConversation: false,
              },
            },
          }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(runtime as never, "hello", 150);
      // Attach the rejection handler before timers advance to avoid unhandled-rejection warnings.
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("allows prompt match even if baseline turn count cannot be read", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        // Baseline read fails
        .mockRejectedValueOnce(new Error("turn read failed"))
        // First poll shows prompt match (baseline unknown)
        .mockResolvedValueOnce({
          result: {
            value: {
              baseline: -1,
              turnsCount: 1,
              userMatched: true,
              prefixMatched: false,
              lastMatched: true,
              hasNewTurn: false,
              stopVisible: false,
              assistantVisible: false,
              composerCleared: false,
              inConversation: true,
            },
          },
        }),
    } as unknown as {
      evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
    };

    await expect(
      promptComposer.verifyPromptCommitted(runtime as never, "hello", 150),
    ).resolves.toBe(1);
  });

  test("attachment sends time out instead of allowing Enter fallback", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("dispatchClickSequence")) {
            return { result: { value: "disabled" } };
          }
          return { result: { value: true } };
        }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.attemptSendButton(
        runtime as never,
        (() => undefined) as never,
        ["oracle-attach-verify.txt"],
      );
      const assertion = expect(promise).rejects.toThrow(/clickable send button/i);
      await vi.advanceTimersByTimeAsync(21_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
