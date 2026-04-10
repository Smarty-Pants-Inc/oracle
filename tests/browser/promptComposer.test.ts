import { describe, expect, test, vi } from "vitest";
import { __test__ as promptComposer } from "../../src/browser/actions/promptComposer.js";

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
});
