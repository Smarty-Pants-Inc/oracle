import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizePromptForIdentity,
  promptIdentitySha256,
  type PromptCommitVerification,
} from "../../src/browser/actions/promptComposer.js";
import { geminiDeepThinkDomProvider } from "../../src/browser/providers/geminiDeepThinkDomProvider.js";

type FixtureTurn = {
  kind: "user" | "response";
  order: number;
  text: string;
  stableId?: string;
  complete?: boolean;
  visibleSpinner?: boolean;
  thoughts?: string;
  thoughtsExpanded?: boolean;
  toggleClicks?: number;
};

type GeminiState = Record<string, unknown> & {
  inputTimeoutMs?: number;
  timeoutMs?: number;
  geminiConversationId?: string;
  geminiPromptBaseline?: {
    userQueryCount: number;
    responseCount: number;
    normalizedPrompt: string;
    userStableId: string | null;
  };
  geminiPromptCommitVerification?: PromptCommitVerification;
  geminiResponseStableId?: string;
};

class FixtureHTMLElement {}

class FixtureThoughts extends FixtureHTMLElement {
  constructor(private readonly turn: FixtureTurn) {
    super();
  }

  get textContent(): string {
    return this.turn.thoughts ?? "";
  }

  querySelector(): null {
    return null;
  }
}

class FixtureThoughtsToggle extends FixtureHTMLElement {
  constructor(private readonly turn: FixtureTurn) {
    super();
  }

  click(): void {
    this.turn.toggleClicks = (this.turn.toggleClicks ?? 0) + 1;
    this.turn.thoughtsExpanded = true;
  }

  getAttribute(): null {
    return null;
  }
}

class FixtureNode extends FixtureHTMLElement {
  constructor(private readonly turn: FixtureTurn) {
    super();
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
    if (name === "data-message-id") return this.turn.stableId ?? null;
    if (name === "aria-hidden") return null;
    return null;
  }

  getBoundingClientRect(): { width: number; height: number } {
    return {
      width: this.turn.visibleSpinner ? 1 : 0,
      height: this.turn.visibleSpinner ? 1 : 0,
    };
  }

  querySelector(selector: string): FixtureNode | FixtureThoughtsToggle | FixtureThoughts | null {
    if (selector.includes("user-query-content") && this.turn.kind === "user") return this;
    if (selector.includes("message-content") && this.turn.kind === "response") return this;
    if (selector.includes("response-footer.complete") && this.turn.complete) return this;
    if (selector.includes("thoughts-header-button") && this.turn.thoughts) {
      return new FixtureThoughtsToggle(this.turn);
    }
    if (selector.includes("model-thoughts") && this.turn.thoughtsExpanded) {
      return new FixtureThoughts(this.turn);
    }
    return null;
  }

  querySelectorAll(selector: string): FixtureNode[] {
    if (selector.includes("progressbar")) return this.turn.visibleSpinner ? [this] : [];
    if (selector.includes("data-message-id")) return this.turn.stableId ? [this] : [];
    return [];
  }
}

function createFixtureDocument(
  turns: FixtureTurn[],
  onSend?: (notifyMutation: () => void, observerActive: () => boolean) => void,
) {
  let observed = false;
  let observerCallback: (() => void) | null = null;
  const nodeFor = (turn: FixtureTurn) => new FixtureNode(turn);
  class FixtureMutationObserver {
    constructor(callback: () => void) {
      observerCallback = callback;
    }

    observe(): void {
      observed = true;
    }

    disconnect(): void {
      observed = false;
    }
  }
  const notifyMutation = () => observerCallback?.();
  const document = {
    documentElement: {},
    body: {},
    querySelectorAll(selector: string): FixtureNode[] {
      if (selector.includes("user-query")) {
        return turns.filter((turn) => turn.kind === "user").map(nodeFor);
      }
      if (selector.includes("model-response")) {
        return turns.filter((turn) => turn.kind === "response").map(nodeFor);
      }
      return [];
    },
    querySelector(selector: string): FixtureHTMLElement | null {
      if (!selector.includes("send-button") || !onSend) return null;
      return new (class extends FixtureHTMLElement {
        click(): void {
          onSend(notifyMutation, () => observed);
        }
      })();
    },
    getElementById(): null {
      return null;
    },
  };
  return { document, FixtureMutationObserver };
}

function createContext(
  turns: FixtureTurn[],
  state: GeminiState,
  onSend?: (notifyMutation: () => void, observerActive: () => boolean) => void,
  prompt = "New request",
) {
  const { document, FixtureMutationObserver } = createFixtureDocument(turns, onSend);
  state.geminiConversationId ??= "gemini-conversation";
  return {
    prompt,
    state,
    evaluate: async <T>(expression: string): Promise<T | undefined> =>
      (await Function(
        "document",
        "Node",
        "HTMLElement",
        "MutationObserver",
        "KeyboardEvent",
        "InputEvent",
        `return ${expression};`,
      )(
        document,
        { DOCUMENT_POSITION_FOLLOWING: 4 },
        FixtureHTMLElement,
        FixtureMutationObserver,
        class {},
        class {},
      )) as T,
    delay: async () => {},
  };
}

function responseState(
  overrides: Partial<NonNullable<GeminiState["geminiPromptBaseline"]>> = {},
): GeminiState {
  return {
    timeoutMs: 1_000,
    geminiPromptBaseline: {
      userQueryCount: 0,
      responseCount: 0,
      normalizedPrompt: "new request",
      userStableId: "data-message-id:user-current",
      ...overrides,
    },
  };
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

  it("installs its observer before Send and awaits an asynchronously mounted stable user turn", async () => {
    const turns: FixtureTurn[] = [];
    let observerWasActiveAtSend = false;
    const state: GeminiState = { inputTimeoutMs: 1_000 };
    const ctx = createContext(turns, state, (notify, observerActive) => {
      observerWasActiveAtSend = observerActive();
      queueMicrotask(() => {
        turns.push({ kind: "user", order: 1, text: "new request", stableId: "user-current" });
        notify();
      });
    });

    await expect(geminiDeepThinkDomProvider.submitPrompt(ctx)).resolves.toEqual({
      status: "committed",
      verification: {
        committedTurns: 1,
        promptSha256: promptIdentitySha256("New request"),
        verifiedUserTurnIndex: 0,
        verifiedUserTurnId: "data-message-id:user-current",
        verifiedUserMessageId: "data-message-id:user-current",
        conversationId: "gemini-conversation",
      },
    });
    expect(observerWasActiveAtSend).toBe(true);
    expect(state.geminiPromptBaseline).toEqual({
      userQueryCount: 0,
      responseCount: 0,
      normalizedPrompt: "new request",
      userStableId: "data-message-id:user-current",
    });
    expect(state.geminiPromptCommitVerification).toEqual(
      expect.objectContaining({
        promptSha256: promptIdentitySha256("New request"),
        verifiedUserTurnId: "data-message-id:user-current",
      }),
    );
  });

  it("recovers the exact dispatched turn after DOM replacement by stable provider identity", async () => {
    const turns: FixtureTurn[] = [];
    const state: GeminiState = { inputTimeoutMs: 1_000, timeoutMs: 1_000 };
    const ctx = createContext(turns, state, (notify) => {
      queueMicrotask(() => {
        turns.push({ kind: "user", order: 1, text: "new request", stableId: "user-current" });
        notify();
      });
    });
    await geminiDeepThinkDomProvider.submitPrompt(ctx);

    turns[0] = { kind: "user", order: 1, text: "NEW REQUEST", stableId: "user-current" };
    turns.push({
      kind: "response",
      order: 2,
      text: "exact answer",
      stableId: "response-current",
      complete: true,
    });

    await expect(geminiDeepThinkDomProvider.waitForResponse(ctx)).resolves.toEqual({
      text: "exact answer",
    });
    expect(state.geminiResponseStableId).toBe("data-message-id:response-current");
  });

  it("fails closed when Send mounts more than one post-baseline user turn", async () => {
    const turns: FixtureTurn[] = [];
    const ctx = createContext(turns, { inputTimeoutMs: 1_000 }, (notify) => {
      turns.push(
        { kind: "user", order: 1, text: "new request", stableId: "user-a" },
        { kind: "user", order: 2, text: "new request", stableId: "user-b" },
      );
      notify();
    });

    await expect(geminiDeepThinkDomProvider.submitPrompt(ctx)).rejects.toThrow(
      "exact dispatch ownership is ambiguous",
    );
  });

  it("commits and captures the exact accepted Gemini turn without a provider id", async () => {
    const turns: FixtureTurn[] = [];
    const state: GeminiState = { inputTimeoutMs: 1_000, timeoutMs: 1_000 };
    const ctx = createContext(turns, state, (notify) => {
      turns.push({ kind: "user", order: 1, text: "new request" });
      notify();
    });
    const promptSha256 = promptIdentitySha256("New request");
    const verifiedUserTurnId = `gemini-dom-turn:0:${promptSha256}`;

    await expect(geminiDeepThinkDomProvider.submitPrompt(ctx)).resolves.toEqual({
      status: "committed",
      verification: {
        committedTurns: 1,
        promptSha256,
        verifiedUserTurnIndex: 0,
        verifiedUserTurnId,
        verifiedUserMessageId: verifiedUserTurnId,
        conversationId: "gemini-conversation",
      },
    });
    expect(state.geminiPromptBaseline).toEqual({
      userQueryCount: 0,
      responseCount: 0,
      normalizedPrompt: "new request",
      userStableId: null,
    });

    turns.push({
      kind: "response",
      order: 2,
      text: "accepted answer",
      stableId: "response-current",
      complete: true,
    });
    await expect(geminiDeepThinkDomProvider.waitForResponse(ctx)).resolves.toEqual({
      text: "accepted answer",
    });
  });

  it("rejects stale and later-turn responses while publishing only the exact current answer", async () => {
    const turns: FixtureTurn[] = [
      { kind: "user", order: 1, text: "new request", stableId: "user-stale" },
      {
        kind: "response",
        order: 2,
        text: "stale answer",
        stableId: "response-stale",
        complete: true,
      },
      { kind: "user", order: 3, text: "new request", stableId: "user-current" },
      {
        kind: "response",
        order: 4,
        text: "current answer",
        stableId: "response-current",
        complete: true,
      },
      { kind: "user", order: 5, text: "new request", stableId: "user-later" },
      {
        kind: "response",
        order: 6,
        text: "later answer",
        stableId: "response-later",
        complete: true,
      },
    ];
    const state = responseState({ userQueryCount: 1, responseCount: 1 });
    const ctx = createContext(turns, state);

    await expect(geminiDeepThinkDomProvider.waitForResponse(ctx)).resolves.toEqual({
      text: "current answer",
    });
  });

  it("fails unsupported when the exact completed response has no stable provider id", async () => {
    const turns: FixtureTurn[] = [
      { kind: "user", order: 1, text: "new request", stableId: "user-current" },
      { kind: "response", order: 2, text: "answer", complete: true },
    ];
    const ctx = createContext(turns, responseState());

    await expect(geminiDeepThinkDomProvider.waitForResponse(ctx)).rejects.toThrow(
      "response lacks a stable provider message identifier",
    );
  });

  it("extracts thoughts only from the exact paired response after a response rerender", async () => {
    const earlier: FixtureTurn = {
      kind: "response",
      order: 2,
      text: "earlier answer",
      stableId: "response-earlier",
      complete: true,
      thoughts: "earlier thoughts",
    };
    const turns: FixtureTurn[] = [
      { kind: "user", order: 1, text: "earlier", stableId: "user-earlier" },
      earlier,
      { kind: "user", order: 3, text: "new request", stableId: "user-current" },
      {
        kind: "response",
        order: 4,
        text: "current answer",
        stableId: "response-current",
        complete: true,
        thoughts: "discarded instance",
      },
    ];
    const state = responseState({ userQueryCount: 1, responseCount: 1 });
    const ctx = createContext(turns, state);
    await geminiDeepThinkDomProvider.waitForResponse(ctx);

    const replacement: FixtureTurn = {
      kind: "response",
      order: 4,
      text: "current answer",
      stableId: "response-current",
      complete: true,
      thoughts: "current thoughts",
    };
    turns[3] = replacement;

    await expect(geminiDeepThinkDomProvider.extractThoughts!(ctx)).resolves.toBe(
      "current thoughts",
    );
    expect(earlier.toggleClicks ?? 0).toBe(0);
    expect(replacement.toggleClicks).toBe(1);
  });

  it("preserves canonical prompt matching across formatting and Unicode whitespace", async () => {
    const prompt = "Explain\n```ts\nconst answer = 42;\n```\u00a0now";
    const turns: FixtureTurn[] = [
      {
        kind: "user",
        order: 1,
        text: "EXPLAIN const answer = 42; now",
        stableId: "user-current",
      },
      {
        kind: "response",
        order: 2,
        text: "canonical answer",
        stableId: "response-current",
        complete: true,
      },
    ];
    const state = responseState({ normalizedPrompt: normalizePromptForIdentity(prompt) });
    const ctx = createContext(turns, state, undefined, prompt);

    await expect(geminiDeepThinkDomProvider.waitForResponse(ctx)).resolves.toEqual({
      text: "canonical answer",
    });
  });
});
