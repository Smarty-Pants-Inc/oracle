import vm from "node:vm";
import { describe, expect, test, vi } from "vitest";
import { __test__ as promptComposer } from "../../src/browser/actions/promptComposer.js";
import {
  ASSISTANT_ROLE_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
} from "../../src/browser/constants.js";

describe("promptComposer", () => {
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

  test("treats a cleared home-page composer plus stop button as committed for a fresh chat", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        // Baseline read (turn count)
        .mockResolvedValueOnce({ result: { value: 0 } })
        // First poll shows the home-page send state before /c/ navigation lands.
        .mockResolvedValueOnce({
          result: {
            value: {
              baseline: 0,
              turnsCount: 0,
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

    await expect(
      promptComposer.verifyPromptCommitted(runtime as never, "hello", 150),
    ).resolves.toBe(0);
  });

  test("treats a matched prompt plus active generation on the home page as committed", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        // Baseline read (turn count)
        .mockResolvedValueOnce({ result: { value: 4 } })
        // First poll shows the prompt echoed in home-page fallback UI while generation is active.
        .mockResolvedValueOnce({
          result: {
            value: {
              baseline: 4,
              turnsCount: 4,
              userMatched: true,
              prefixMatched: true,
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

    await expect(
      promptComposer.verifyPromptCommitted(runtime as never, "hello", 150),
    ).resolves.toBe(4);
  });

  test("does not treat stale prompt text from older turns as a new committed follow-up", async () => {
    vi.useFakeTimers();
    try {
      const prompt = "Follow up on the implementation.";
      let evaluateCalls = 0;
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string; returnByValue?: boolean }) => {
          evaluateCalls += 1;
          if (evaluateCalls === 1) {
            return { result: { value: 6 } };
          }
          const turns = [
            "Earlier context",
            prompt,
            "More prior context",
            "Existing workflow snapshot",
            "Oracle delegated work to the orchestrator.",
            "O1_1775534779",
            "Thinking",
          ];
          const turnNodes = turns.map((text) => ({ innerText: text, textContent: text }));
          const fakeDocument = {
            querySelectorAll(selector: string) {
              return selector === CONVERSATION_TURN_SELECTOR ? turnNodes : [];
            },
            querySelector(selector: string) {
              if (
                selector === ASSISTANT_ROLE_SELECTOR ||
                selector === '[data-testid*="assistant"]'
              ) {
                return {};
              }
              return null;
            },
          };
          const value = vm.runInNewContext(expression, {
            document: fakeDocument,
            location: { href: "https://chatgpt.com/c/abc" },
            HTMLTextAreaElement: class HTMLTextAreaElement {},
          });
          return { result: { value } };
        }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(runtime as never, prompt, 150);
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("matches the submitted user turn even when the assistant reply is already the last visible turn", async () => {
    const prompt =
      "Reply with exactly PONG_1775543200 and nothing else.\n\n### File: README.md\n\nREADME sample";

    const createWrappedTurn = (text: string, role: "user" | "assistant") => {
      const wrapper = {
        innerText: text,
        textContent: text,
        parentElement: null,
        getAttribute: () => null,
        getBoundingClientRect: () => ({ width: 1, height: 1 }),
        closest(selector: string) {
          return selector === CONVERSATION_TURN_SELECTOR ? wrapper : null;
        },
        querySelector(selector: string) {
          if (selector.includes("[data-message-author-role]") || selector.includes("[data-turn]")) {
            return roleNode;
          }
          return null;
        },
      };
      const roleNode = {
        innerText: text,
        textContent: text,
        parentElement: wrapper,
        getAttribute(name: string) {
          if (name === "data-message-author-role" || name === "data-turn") {
            return role;
          }
          return null;
        },
        querySelector: () => null,
        getBoundingClientRect: () => ({ width: 1, height: 1 }),
      };
      return { wrapper, roleNode };
    };

    const previousAssistant = createWrappedTurn("Earlier context", "assistant");
    const submittedUser = createWrappedTurn(`You said:\n\n${prompt}`, "user");
    const latestAssistant = createWrappedTurn("PONG_1775543200", "assistant");
    const conversationNodes = [
      previousAssistant.wrapper,
      previousAssistant.roleNode,
      submittedUser.wrapper,
      submittedUser.roleNode,
      latestAssistant.wrapper,
      latestAssistant.roleNode,
    ];

    const fakeDocument = {
      querySelectorAll(selector: string) {
        if (selector === CONVERSATION_TURN_SELECTOR) {
          return conversationNodes;
        }
        return [];
      },
      querySelector(selector: string) {
        if (selector === ASSISTANT_ROLE_SELECTOR || selector === '[data-testid*="assistant"]') {
          return latestAssistant.roleNode;
        }
        return null;
      },
    };

    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string; returnByValue?: boolean }) => {
        const value = vm.runInNewContext(expression, {
          document: fakeDocument,
          location: { href: "https://chatgpt.com/c/abc" },
          HTMLTextAreaElement: class HTMLTextAreaElement {},
        });
        return { result: { value } };
      }),
    } as unknown as {
      evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
    };

    await expect(
      promptComposer.verifyPromptCommitted(runtime as never, prompt, 150, undefined, 1),
    ).resolves.toBe(3);
  });
});
