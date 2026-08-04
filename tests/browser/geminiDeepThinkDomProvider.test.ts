import { afterEach, describe, expect, it, vi } from "vitest";
import { geminiDeepThinkDomProvider } from "../../src/browser/providers/geminiDeepThinkDomProvider.js";
import type { DomEvaluate } from "../../src/browser/providerDomFlow.js";

type FixtureTurn = {
  kind: "user" | "response";
  order: number;
  text: string;
  complete?: boolean;
  visibleSpinner?: boolean;
};

class FixtureNode {
  constructor(private readonly turn: FixtureTurn) {}

  get textContent(): string {
    return this.turn.text;
  }

  get hidden(): boolean {
    return false;
  }

  compareDocumentPosition(other: FixtureNode): number {
    return this.turn.order < other.turn.order ? 4 : 2;
  }

  getAttribute(name: string): string | null {
    return name === "aria-hidden" ? null : null;
  }

  getBoundingClientRect(): { width: number; height: number } {
    return { width: this.turn.visibleSpinner ? 1 : 0, height: this.turn.visibleSpinner ? 1 : 0 };
  }

  querySelector(selector: string): FixtureNode | null {
    if (selector.includes("user-query-content") && this.turn.kind === "user") return this;
    if (selector.includes("message-content") && this.turn.kind === "response") return this;
    if (selector.includes("response-footer.complete") && this.turn.complete) return this;
    return null;
  }

  querySelectorAll(selector: string): FixtureNode[] {
    return selector.includes("progressbar") && this.turn.visibleSpinner ? [this] : [];
  }
}

function fixtureDocument(turns: FixtureTurn[]) {
  const nodes = turns.map((turn) => new FixtureNode(turn));
  return {
    querySelectorAll(selector: string): FixtureNode[] {
      if (selector.includes("user-query"))
        return nodes.filter((node) => node.querySelector("user-query-content"));
      if (selector.includes("model-response"))
        return nodes.filter((node) => node.querySelector("message-content"));
      return [];
    },
  };
}

function responseContext(
  turns: FixtureTurn[],
  baseline: { userQueryCount: number; responseCount: number; normalizedPrompt: string } = {
    userQueryCount: 0,
    responseCount: 0,
    normalizedPrompt: "new request",
  },
) {
  let now = 0;
  let observedPayload: Record<string, unknown> | undefined;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const ctx = {
    prompt: "New request",
    evaluate: async <T>(expression: string): Promise<T | undefined> => {
      const payload = Function(
        "document",
        "Node",
        `return ${expression};`,
      )(fixtureDocument(turns), {
        DOCUMENT_POSITION_FOLLOWING: 4,
      });
      observedPayload = JSON.parse(String(payload)) as Record<string, unknown>;
      return payload as T;
    },
    delay: async (ms: number) => {
      now += ms;
    },
    state: { timeoutMs: 1_000, geminiPromptBaseline: baseline },
  };
  return { ctx, observedPayload: () => observedPayload };
}

async function expectNoCausalAnswer(
  turns: FixtureTurn[],
  expectedStatus?: string,
  baseline?: { userQueryCount: number; responseCount: number; normalizedPrompt: string },
): Promise<void> {
  const { ctx, observedPayload } = responseContext(turns, baseline);
  await expect(geminiDeepThinkDomProvider.waitForResponse(ctx)).rejects.toThrow(
    "Deep Think timed out waiting for response (1 seconds).",
  );
  expect(observedPayload()).toMatchObject({
    causalPair: false,
    ...(expectedStatus ? { status: expectedStatus } : {}),
  });
}

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
    await expectNoCausalAnswer([], "waiting");
  });

  it("rejects an old completed response when the send click is ignored", async () => {
    let now = 0;
    const state: Record<string, unknown> = { timeoutMs: 1_000 };
    const oldConversation = [
      { kind: "user" as const, order: 1, text: "old request" },
      { kind: "response" as const, order: 2, text: "old completed response", complete: true },
    ];
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const evaluate: DomEvaluate = async <T>(expression: string): Promise<T | undefined> => {
      if (expression.includes("userQueryCount")) {
        return JSON.stringify({ userQueryCount: 1, responseCount: 1 }) as T;
      }
      if (expression.includes("btn.click")) return "clicked" as T;
      return Function(
        "document",
        "Node",
        `return ${expression};`,
      )(fixtureDocument(oldConversation), {
        DOCUMENT_POSITION_FOLLOWING: 4,
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

  it("executes the generated probe against a DOM fixture and accepts only its exact paired answer", async () => {
    const { ctx, observedPayload } = responseContext([
      { kind: "user", order: 1, text: "  NEW\nREQUEST  " },
      { kind: "response", order: 2, text: "fresh completed response", complete: true },
    ]);

    await expect(geminiDeepThinkDomProvider.waitForResponse(ctx)).resolves.toEqual({
      text: "fresh completed response",
    });
    expect(observedPayload()).toEqual({
      status: "done",
      text: "fresh completed response",
      causalPair: true,
    });
  });

  it("rejects a completed response whose nearest user turn has the wrong query", async () => {
    await expectNoCausalAnswer([
      { kind: "user", order: 1, text: "different query" },
      { kind: "response", order: 2, text: "response to a different query", complete: true },
    ]);
  });

  it("rejects a lazily hydrated unrelated response even when the exact query is present", async () => {
    await expectNoCausalAnswer([
      { kind: "response", order: 1, text: "unrelated completed response", complete: true },
      { kind: "user", order: 2, text: "new request" },
    ]);
  });

  it("rejects a new response paired with an exact user node from before the baseline", async () => {
    await expectNoCausalAnswer(
      [
        { kind: "user", order: 1, text: "new request" },
        { kind: "response", order: 2, text: "answer to an earlier request", complete: true },
      ],
      undefined,
      { userQueryCount: 1, responseCount: 0, normalizedPrompt: "new request" },
    );
  });

  it("rejects a response when another user query intervenes after the submitted prompt", async () => {
    await expectNoCausalAnswer([
      { kind: "user", order: 1, text: "new request" },
      { kind: "user", order: 2, text: "intervening request" },
      { kind: "response", order: 3, text: "ambiguous answer", complete: true },
    ]);
  });

  it("does not publish an incomplete generating response", async () => {
    await expectNoCausalAnswer(
      [
        { kind: "user", order: 1, text: "new request" },
        { kind: "response", order: 2, text: "Generating your response", complete: false },
      ],
      "streaming",
    );
  });

  it("recognizes a visible spinner without throwing from the nonterminal probe", async () => {
    await expectNoCausalAnswer(
      [
        { kind: "user", order: 1, text: "new request" },
        { kind: "response", order: 2, text: "working", complete: false, visibleSpinner: true },
      ],
      "generating",
    );
  });
});
