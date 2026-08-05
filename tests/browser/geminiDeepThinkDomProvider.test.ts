import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizePromptForIdentity } from "../../src/browser/actions/promptComposer.js";
import { geminiDeepThinkDomProvider } from "../../src/browser/providers/geminiDeepThinkDomProvider.js";

type FixtureTurn = {
  kind: "user" | "response";
  order: number;
  text: string;
  boundToDispatch?: boolean;
  complete?: boolean;
  visibleSpinner?: boolean;
};

type GeminiBaseline = {
  userQueryCount: number;
  responseCount: number;
  normalizedPrompt: string;
  dispatchNonce: string;
};

class FixtureNode {
  readonly __oracleGeminiDispatchNonce: string | undefined;

  constructor(private readonly turn: FixtureTurn) {
    this.__oracleGeminiDispatchNonce = turn.boundToDispatch ? "fixture-dispatch" : undefined;
  }

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
  const nodes = new Map<FixtureTurn, FixtureNode>();
  const nodeFor = (turn: FixtureTurn) => {
    let node = nodes.get(turn);
    if (!node) {
      node = new FixtureNode(turn);
      nodes.set(turn, node);
    }
    return node;
  };
  return {
    querySelectorAll(selector: string): FixtureNode[] {
      if (selector.includes("user-query"))
        return turns.map(nodeFor).filter((node) => node.querySelector("user-query-content"));
      if (selector.includes("model-response"))
        return turns.map(nodeFor).filter((node) => node.querySelector("message-content"));
      return [];
    },
  };
}

function responseContext(
  turns: FixtureTurn[],
  baseline: GeminiBaseline = {
    userQueryCount: 0,
    responseCount: 0,
    normalizedPrompt: "new request",
    dispatchNonce: "fixture-dispatch",
  },
  prompt = "New request",
) {
  let now = 0;
  let observedPayload: Record<string, unknown> | undefined;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const ctx = {
    prompt,
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
  baseline?: GeminiBaseline,
): Promise<void> {
  const { ctx } = responseContext(turns, baseline);
  await expect(geminiDeepThinkDomProvider.waitForResponse(ctx)).rejects.toThrow(
    "Deep Think timed out waiting for response (1 seconds).",
  );
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
    await expectNoCausalAnswer([]);
  });

  it("fails closed when an ignored send is followed by a lazily mounted identical pair", async () => {
    const state: Record<string, unknown> = { timeoutMs: 1_000 };
    const ctx = {
      prompt: "new request",
      evaluate: async <T>(expression: string): Promise<T | undefined> => {
        if (expression.includes("beforeUserTurns")) {
          return JSON.stringify({
            userQueryCount: 0,
            responseCount: 0,
            sendResult: "clicked",
            boundNonce: null,
          }) as T;
        }
        throw new Error("The unbound lazy pair must never be probed.");
      },
      delay: async () => {},
      state,
    };

    await expect(geminiDeepThinkDomProvider.submitPrompt(ctx)).rejects.toThrow(
      "Failed to bind Gemini response to the newly submitted user turn.",
    );
    expect(state.geminiPromptBaseline).toBeUndefined();
  });

  it("binds the synchronously created user node to this dispatch", async () => {
    const turns: FixtureTurn[] = [];
    class FixtureHTMLElement {}
    const sendButton = new (class extends FixtureHTMLElement {
      click() {
        turns.push({ kind: "user", order: 1, text: "new request" });
      }
    })();
    const document = {
      ...fixtureDocument(turns),
      querySelector(selector: string) {
        return selector.includes("send-button") ? sendButton : null;
      },
    };
    const state: Record<string, unknown> = { timeoutMs: 1_000 };
    const ctx = {
      prompt: "new request",
      evaluate: async <T>(expression: string): Promise<T | undefined> =>
        Function(
          "document",
          "Node",
          "HTMLElement",
          `return ${expression};`,
        )(document, { DOCUMENT_POSITION_FOLLOWING: 4 }, FixtureHTMLElement) as T,
      delay: async () => {},
      state,
    };

    await expect(geminiDeepThinkDomProvider.submitPrompt(ctx)).resolves.toEqual({
      status: "attempted",
    });
    expect(state.geminiPromptBaseline).toMatchObject({
      userQueryCount: 0,
      responseCount: 0,
      normalizedPrompt: "new request",
    });

    turns.push({ kind: "response", order: 2, text: "bound answer", complete: true });
    await expect(geminiDeepThinkDomProvider.waitForResponse(ctx)).resolves.toEqual({
      text: "bound answer",
    });
  });

  it("returns raw ordered descriptors and accepts only its exact bound paired answer", async () => {
    const { ctx, observedPayload } = responseContext([
      { kind: "user", order: 1, text: "  NEW\nREQUEST  ", boundToDispatch: true },
      { kind: "response", order: 2, text: "fresh completed response", complete: true },
    ]);

    await expect(geminiDeepThinkDomProvider.waitForResponse(ctx)).resolves.toEqual({
      text: "fresh completed response",
    });
    expect(observedPayload()).toEqual({
      entries: [
        {
          kind: "user",
          postBaseline: true,
          text: "  NEW\nREQUEST  ",
          boundToDispatch: true,
        },
        {
          kind: "response",
          postBaseline: true,
          text: "fresh completed response",
          completionMarked: true,
          visibleSpinner: false,
        },
      ],
    });
  });

  it("rejects a completed response whose bound user turn has the wrong query", async () => {
    await expectNoCausalAnswer([
      { kind: "user", order: 1, text: "different query", boundToDispatch: true },
      { kind: "response", order: 2, text: "response to a different query", complete: true },
    ]);
  });

  it("rejects a lazily hydrated identical pair with no bound user node", async () => {
    await expectNoCausalAnswer([
      { kind: "user", order: 1, text: "new request" },
      { kind: "response", order: 2, text: "old identical answer", complete: true },
    ]);
  });

  it("rejects a response when the bound user node predates the submission baseline", async () => {
    await expectNoCausalAnswer(
      [
        { kind: "user", order: 1, text: "new request", boundToDispatch: true },
        { kind: "response", order: 2, text: "answer to an earlier request", complete: true },
      ],
      {
        userQueryCount: 1,
        responseCount: 0,
        normalizedPrompt: "new request",
        dispatchNonce: "fixture-dispatch",
      },
    );
  });

  it("does not publish a response after another user query intervenes", async () => {
    await expectNoCausalAnswer([
      { kind: "user", order: 1, text: "new request", boundToDispatch: true },
      { kind: "user", order: 2, text: "intervening request" },
      { kind: "response", order: 3, text: "ambiguous answer", complete: true },
    ]);
  });

  it("publishes the exact bound answer, never a later answer to an identical concurrent turn", async () => {
    const { ctx } = responseContext([
      { kind: "user", order: 1, text: "new request", boundToDispatch: true },
      { kind: "response", order: 2, text: "Oracle response", complete: true },
      { kind: "user", order: 3, text: "NEW REQUEST" },
      { kind: "response", order: 4, text: "later response", complete: true },
    ]);

    await expect(geminiDeepThinkDomProvider.waitForResponse(ctx)).resolves.toEqual({
      text: "Oracle response",
    });
  });

  it("fails closed when the dispatch identity appears on multiple user nodes", async () => {
    await expectNoCausalAnswer([
      { kind: "user", order: 1, text: "new request", boundToDispatch: true },
      { kind: "user", order: 2, text: "new request", boundToDispatch: true },
      { kind: "response", order: 3, text: "ambiguous answer", complete: true },
    ]);
  });

  it("does not publish an incomplete generating response", async () => {
    await expectNoCausalAnswer([
      { kind: "user", order: 1, text: "new request", boundToDispatch: true },
      { kind: "response", order: 2, text: "Generating your response", complete: false },
    ]);
  });

  it("preserves visible-spinner detection in raw response descriptors", async () => {
    const { ctx, observedPayload } = responseContext([
      { kind: "user", order: 1, text: "new request", boundToDispatch: true },
      { kind: "response", order: 2, text: "working", complete: false, visibleSpinner: true },
    ]);
    await expect(geminiDeepThinkDomProvider.waitForResponse(ctx)).rejects.toThrow(
      "Deep Think timed out waiting for response (1 seconds).",
    );
    expect(observedPayload()).toEqual({
      entries: [
        { kind: "user", postBaseline: true, text: "new request", boundToDispatch: true },
        {
          kind: "response",
          postBaseline: true,
          text: "working",
          completionMarked: false,
          visibleSpinner: true,
        },
      ],
    });
  });

  it.each([
    {
      name: "fenced code",
      prompt: "Explain\n```ts\nconst answer = 42;\n```",
      echoedPrompt: "EXPLAIN\nconst answer = 42;",
    },
    {
      name: "inline code",
      prompt: "Run `pnpm test` now",
      echoedPrompt: "run pnpm test now",
    },
    {
      name: "Unicode whitespace",
      prompt: "Alpha\u00a0Beta\u2003Gamma",
      echoedPrompt: "alpha beta gamma",
    },
    {
      name: "mixed line endings",
      prompt: "first\r\nsecond\rthird\nfourth",
      echoedPrompt: "FIRST second third fourth",
    },
  ])("pairs canonical prompt identity for $name in Node", async ({ prompt, echoedPrompt }) => {
    const { ctx, observedPayload } = responseContext(
      [
        { kind: "user", order: 1, text: echoedPrompt, boundToDispatch: true },
        { kind: "response", order: 2, text: "canonical answer", complete: true },
      ],
      {
        userQueryCount: 0,
        responseCount: 0,
        normalizedPrompt: normalizePromptForIdentity(prompt),
        dispatchNonce: "fixture-dispatch",
      },
      prompt,
    );

    await expect(geminiDeepThinkDomProvider.waitForResponse(ctx)).resolves.toEqual({
      text: "canonical answer",
    });
    expect(observedPayload()).toEqual({
      entries: [
        { kind: "user", postBaseline: true, text: echoedPrompt, boundToDispatch: true },
        {
          kind: "response",
          postBaseline: true,
          text: "canonical answer",
          completionMarked: true,
          visibleSpinner: false,
        },
      ],
    });
  });
});
