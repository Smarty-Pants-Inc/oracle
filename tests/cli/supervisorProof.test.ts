import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { __test__ } from "../../scripts/supervisor-proof.ts";

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((signal: NodeJS.Signals) => {
    if (signal === "SIGTERM") {
      this.exitCode = 0;
      queueMicrotask(() => this.emit("exit", 0, null));
    }
    return true;
  });
}

describe("supervisor proof helpers", () => {
  test("clears timeout handles after a successful race", async () => {
    vi.useFakeTimers();
    try {
      await expect(
        __test__.withTimeout(Promise.resolve("ok"), 15_000, () => new Error("timeout")),
      ).resolves.toBe("ok");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("terminates an unclosed broker child after the exit timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChildProcess();
      const pending = __test__.waitForChildExit(child as never, 5_000, 1_000);

      await vi.advanceTimersByTimeAsync(5_000);

      await expect(pending).resolves.toEqual({ code: 0, signal: null });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects non-clean broker exits after a response is captured", () => {
    expect(() => __test__.assertBrokerExitedCleanly({ code: 2, signal: null })).toThrow(
      /exited with code 2/i,
    );
    expect(() => __test__.assertBrokerExitedCleanly({ code: null, signal: "SIGTERM" })).toThrow(
      /exited with signal SIGTERM/i,
    );
    expect(() => __test__.assertBrokerExitedCleanly({ code: 0, signal: null })).not.toThrow();
  });

  test("accepts the expected conversation thread when validating proof state", () => {
    expect(() =>
      __test__.assertProofOnExpectedThread({
        expectedConversationId: "thread-abc",
        expectedTabUrl: "https://chatgpt.com/g/proj-1/c/thread-abc",
        observedHref: "https://chatgpt.com/g/proj-1/c/thread-abc?model=gpt-5.5-pro",
      }),
    ).not.toThrow();
  });

  test("accepts recovered -oracle conversation urls when the expected conversation id matches", () => {
    expect(() =>
      __test__.assertProofOnExpectedThread({
        expectedConversationId: "thread-abc",
        expectedTabUrl: "https://chatgpt.com/g/team-space/project/c/thread-abc",
        observedHref: "https://chatgpt.com/g/team-space-oracle/c/thread-abc?model=gpt-5.5-pro",
      }),
    ).not.toThrow();
  });

  test("fails closed when attach-after-recovery stays on the project shell without a conversation id", () => {
    expect(() =>
      __test__.assertProofOnExpectedThread({
        expectedConversationId: "thread-abc",
        expectedTabUrl: "https://chatgpt.com/g/team-space/project/c/thread-abc",
        observedHref: "https://chatgpt.com/g/team-space/project",
      }),
    ).toThrow(/instead of thread-abc/i);
  });

  test("fails closed when proof observes a different conversation in the same project scope", () => {
    expect(() =>
      __test__.assertProofOnExpectedThread({
        expectedConversationId: "thread-abc",
        expectedTabUrl: "https://chatgpt.com/g/proj-1/c/thread-abc",
        observedHref: "https://chatgpt.com/g/proj-1/c/thread-def",
      }),
    ).toThrow(/instead of thread-abc/i);
  });

  test("falls back to exact tab URL matching when conversation identity is unavailable", () => {
    expect(() =>
      __test__.assertProofOnExpectedThread({
        expectedTabUrl: "https://chatgpt.com/g/proj-1/project/",
        observedHref: "https://chatgpt.com/g/proj-1/project?x=1",
      }),
    ).not.toThrow();
    expect(() =>
      __test__.assertProofOnExpectedThread({
        expectedTabUrl: "https://chatgpt.com/g/proj-1/project",
        observedHref: "https://chatgpt.com/g/proj-1/c/other-thread",
      }),
    ).toThrow(/unexpected tab/i);
  });
});
