import { describe, expect, it, vi, afterEach } from "vitest";
import { geminiDeepThinkDomProvider } from "../../src/browser/providers/geminiDeepThinkDomProvider.js";
import type { DomEvaluate } from "../../src/browser/providerDomFlow.js";

describe("geminiDeepThinkDomProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses inputTimeoutMs for UI readiness", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    await expect(
      geminiDeepThinkDomProvider.waitForUi({
        prompt: "hello",
        evaluate: async <T>() => ({ ready: false, requiresLogin: false }) as T,
        delay: async (ms) => {
          now += ms;
        },
        state: { inputTimeoutMs: 2_000 },
      }),
    ).rejects.toThrow("Timed out waiting for Gemini UI prompt input to become ready.");
  });

  it("uses timeoutMs for response polling", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    await expect(
      geminiDeepThinkDomProvider.waitForResponse({
        prompt: "hello",
        evaluate: async <T>() => JSON.stringify({ status: "generating", responseCount: 0 }) as T,
        delay: async (ms) => {
          now += ms;
        },
        state: {
          timeoutMs: 4_000,
          geminiPromptBaseline: { userQueryCount: 0, responseCount: 0, normalizedPrompt: "hello" },
        },
      }),
    ).rejects.toThrow("Deep Think timed out waiting for response (4 seconds).");
  });

  it("rejects an old completed response when the send click is ignored", async () => {
    let now = 0;
    const state: Record<string, unknown> = { timeoutMs: 1_000 };
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const evaluate: DomEvaluate = async <T>(expression: string): Promise<T | undefined> => {
      if (expression.includes("userQueryCount")) {
        return JSON.stringify({ userQueryCount: 2, responseCount: 4 }) as T;
      }
      if (expression.includes("btn.click")) return "clicked" as T;
      return JSON.stringify({
        status: "done",
        text: "old completed response",
        postBaselineUserQueries: [],
        responseCount: 4,
      }) as T;
    };
    const ctx = {
      prompt: "new request",
      evaluate,
      delay: async (ms: number) => {
        now += ms;
      },
      state,
    };

    await expect(geminiDeepThinkDomProvider.submitPrompt(ctx)).resolves.toEqual({
      status: "attempted",
    });
    await expect(geminiDeepThinkDomProvider.waitForResponse(ctx)).rejects.toThrow(
      "Deep Think timed out waiting for response (1 seconds).",
    );
  });

  it("accepts a normalized new user turn and a newer completed response", async () => {
    const state: Record<string, unknown> = { timeoutMs: 1_000 };
    const evaluate: DomEvaluate = async <T>(expression: string): Promise<T | undefined> => {
      if (expression.includes("userQueryCount")) {
        return JSON.stringify({ userQueryCount: 2, responseCount: 4 }) as T;
      }
      if (expression.includes("btn.click")) return "clicked" as T;
      return JSON.stringify({
        status: "done",
        text: "fresh completed response",
        postBaselineUserQueries: ["  NEW\nREQUEST  "],
        responseCount: 5,
      }) as T;
    };
    const ctx = {
      prompt: "New request",
      evaluate,
      delay: async () => undefined,
      state,
    };

    await geminiDeepThinkDomProvider.submitPrompt(ctx);
    await expect(geminiDeepThinkDomProvider.waitForResponse(ctx)).resolves.toEqual({
      text: "fresh completed response",
    });
    expect(state).toMatchObject({
      geminiPromptBaseline: {
        userQueryCount: 2,
        responseCount: 4,
        normalizedPrompt: "new request",
        verifiedUserQueryCount: 3,
      },
    });
  });

  it("rejects a newer response paired with the wrong new user text", async () => {
    let now = 0;
    const state: Record<string, unknown> = { timeoutMs: 1_000 };
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const evaluate: DomEvaluate = async <T>(expression: string): Promise<T | undefined> => {
      if (expression.includes("userQueryCount")) {
        return JSON.stringify({ userQueryCount: 0, responseCount: 0 }) as T;
      }
      if (expression.includes("btn.click")) return "clicked" as T;
      return JSON.stringify({
        status: "done",
        text: "response to a different query",
        postBaselineUserQueries: ["different query"],
        responseCount: 1,
      }) as T;
    };
    const ctx = {
      prompt: "expected query",
      evaluate,
      delay: async (ms: number) => {
        now += ms;
      },
      state,
    };

    await geminiDeepThinkDomProvider.submitPrompt(ctx);
    await expect(geminiDeepThinkDomProvider.waitForResponse(ctx)).rejects.toThrow(
      "Deep Think timed out waiting for response (1 seconds).",
    );
  });
});
