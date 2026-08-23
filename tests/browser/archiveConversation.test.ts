import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  archiveChatGptConversation,
  buildArchiveConversationExpressionForTest,
  isProjectChatgptUrl,
  isTemporaryChatgptUrl,
  resolveBrowserArchiveDecision,
} from "../../src/browser/actions/archiveConversation.js";

describe("browser conversation archive policy", () => {
  test("archives successful non-project one-shots in auto mode", () => {
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/",
        conversationUrl: "https://chatgpt.com/c/abc",
        researchMode: "off",
        followUpCount: 0,
      }),
    ).toMatchObject({
      mode: "auto",
      shouldArchive: true,
      reason: "successful-one-shot",
    });
  });

  test("auto-archives successful project one-shots", () => {
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/g/g-p-demo/project",
        conversationUrl: "https://chatgpt.com/c/abc",
      }),
    ).toMatchObject({ shouldArchive: true, reason: "successful-one-shot" });
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/",
        conversationUrl: "https://chatgpt.com/g/g-p-demo/project/c/abc",
      }),
    ).toMatchObject({ shouldArchive: true, reason: "successful-one-shot" });
  });

  test("does not auto-archive Temporary Chat, Deep Research, multi-turn, or missing-url runs", () => {
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/?temporary-chat=true",
        conversationUrl: "https://chatgpt.com/?temporary-chat=true",
      }),
    ).toMatchObject({ shouldArchive: false, reason: "temporary-chat" });
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        conversationUrl: "https://chatgpt.com/c/abc",
        researchMode: "deep",
      }),
    ).toMatchObject({ shouldArchive: false, reason: "deep-research" });
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        conversationUrl: "https://chatgpt.com/c/abc",
        followUpCount: 1,
      }),
    ).toMatchObject({ shouldArchive: false, reason: "multi-turn" });
    expect(resolveBrowserArchiveDecision({ mode: "auto" })).toMatchObject({
      shouldArchive: false,
      reason: "missing-conversation-url",
    });
  });

  test("honors explicit always and never modes", () => {
    expect(resolveBrowserArchiveDecision({ mode: "never", conversationUrl: "x" })).toMatchObject({
      shouldArchive: false,
      reason: "disabled",
    });
    expect(
      resolveBrowserArchiveDecision({
        mode: "always",
        chatgptUrl: "https://chatgpt.com/g/g-p-demo/project",
        conversationUrl: "https://chatgpt.com/c/abc",
        researchMode: "deep",
        followUpCount: 2,
      }),
    ).toMatchObject({ shouldArchive: true, reason: "forced" });
  });

  test("detects ChatGPT project URLs", () => {
    expect(isProjectChatgptUrl("https://chatgpt.com/g/g-p-demo/project")).toBe(true);
    expect(isProjectChatgptUrl("https://chatgpt.com/g/g-p-demo/project?model=gpt-5")).toBe(true);
    expect(isProjectChatgptUrl("https://chatgpt.com/c/abc")).toBe(false);
  });

  test("detects ChatGPT temporary chat URLs", () => {
    expect(isTemporaryChatgptUrl("https://chatgpt.com/?temporary-chat=true")).toBe(true);
    expect(isTemporaryChatgptUrl("https://chatgpt.com/?temporary-chat=false")).toBe(false);
    expect(isTemporaryChatgptUrl("https://chatgpt.com/c/abc")).toBe(false);
  });
});

describe("archiveChatGptConversation", () => {
  test.each(["https://chatgpt.com", "https://chat.openai.com"])(
    "returns archived result when the DOM action succeeds on %s",
    async (origin) => {
      const conversationUrl = `${origin}/c/abc`;
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: { value: { status: "archived", conversationUrl } },
        }),
      };
      const logger = vi.fn();
      const remainingMs = 10_000;

      await expect(
        archiveChatGptConversation(runtime as never, logger as never, {
          mode: "auto",
          conversationUrl,
          remainingMs,
        }),
      ).resolves.toMatchObject({
        mode: "auto",
        attempted: true,
        archived: true,
        conversationUrl,
      });
      expect(runtime.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          awaitPromise: true,
          returnByValue: true,
        }),
      );
      const expression = runtime.evaluate.mock.calls[0]?.[0]?.expression;
      expect(expression).toContain("const deadline = ");
      expect(expression).toContain("const confirmationBudgetMs = 1000;");
      expect(expression).toContain("const confirmationDeadline = deadline - confirmationBudgetMs;");
    },
  );

  test("bounds a stalled Runtime.evaluate and dispatches cancellation", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn(({ awaitPromise }: { awaitPromise?: boolean }) =>
          awaitPromise
            ? new Promise<never>(() => {})
            : Promise.resolve({ result: { value: true } }),
        ),
      };
      const result = archiveChatGptConversation(runtime as never, vi.fn() as never, {
        mode: "always",
        conversationUrl: "https://chatgpt.com/c/abc",
        remainingMs: 2_000,
      });

      await vi.advanceTimersByTimeAsync(2_000);

      await expect(result).resolves.toMatchObject({
        attempted: true,
        archived: false,
        reason: "archive-failed",
        error: "Timed out while archiving ChatGPT conversation.",
      });
      expect(runtime.evaluate).toHaveBeenCalledTimes(2);
      expect(runtime.evaluate).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ awaitPromise: true, returnByValue: true }),
      );
      expect(runtime.evaluate).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          awaitPromise: false,
          returnByValue: true,
          expression: expect.stringContaining("__oracleChatGptArchiveCancelled"),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects an insufficient confirmation budget before evaluating the archive mutation", async () => {
    const runtime = { evaluate: vi.fn() };

    await expect(
      archiveChatGptConversation(runtime as never, vi.fn() as never, {
        mode: "always",
        conversationUrl: "https://chatgpt.com/c/abc",
        remainingMs: 1_000,
      }),
    ).resolves.toMatchObject({
      attempted: false,
      archived: false,
      reason: "archive-not-confirmed",
      error: "Archive deadline has insufficient confirmation budget.",
    });
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });

  test("returns a non-archived result when the DOM action is not confirmed", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            status: "skipped",
            reason: "archive-not-confirmed",
            conversationUrl: "https://chatgpt.com/c/abc",
          },
        },
      }),
    };

    await expect(
      archiveChatGptConversation(runtime as never, vi.fn() as never, {
        mode: "always",
        conversationUrl: "https://chatgpt.com/c/abc",
      }),
    ).resolves.toMatchObject({
      mode: "always",
      attempted: true,
      archived: false,
      reason: "archive-not-confirmed",
      conversationUrl: "https://chatgpt.com/c/abc",
    });
  });

  test("returns a non-attempt result when the mutation evaluator rejects affinity", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            status: "skipped",
            reason: "affinity-mismatch",
            conversationUrl: "https://chatgpt.com/c/other",
          },
        },
      }),
    };

    await expect(
      archiveChatGptConversation(runtime as never, vi.fn() as never, {
        mode: "always",
        conversationUrl: "https://chatgpt.com/c/abc",
        expectedAccountDigest: "a".repeat(64),
      }),
    ).resolves.toMatchObject({
      attempted: false,
      archived: false,
      reason: "affinity-mismatch",
    });
  });
  test.each(["https://chatgpt.com", "https://chat.openai.com"])(
    "rejects an archived result that crosses root/project scope on %s",
    async (origin) => {
      const projectUrl = `${origin}/g/g-project/project/c/abc`;
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: { value: { status: "archived", conversationUrl: `${origin}/c/abc` } },
        }),
      };

      await expect(
        archiveChatGptConversation(runtime as never, vi.fn() as never, {
          mode: "always",
          conversationUrl: projectUrl,
        }),
      ).resolves.toMatchObject({
        attempted: false,
        archived: false,
        reason: "affinity-mismatch",
        error: "Archive result left the approved conversation scope.",
      });
    },
  );

  test.each([
    "https://attacker.example/c/abc",
    "https://chatgpt.com:8443/c/abc",
    "https://chat.openai.com:8443/c/abc",
    "https://chat.openai.com.evil.example/c/abc",
  ])(
    "rejects noncanonical conversation URL %s before evaluating the page",
    async (conversationUrl) => {
      const runtime = { evaluate: vi.fn() };

      await expect(
        archiveChatGptConversation(runtime as never, vi.fn() as never, {
          mode: "always",
          conversationUrl,
          expectedAccountDigest: "a".repeat(64),
        }),
      ).resolves.toMatchObject({
        attempted: false,
        archived: false,
        reason: "affinity-mismatch",
      });
      expect(runtime.evaluate).not.toHaveBeenCalled();
    },
  );

  test.each(["https://chatgpt.com", "https://chat.openai.com"])(
    "checks account affinity inside the evaluator before DOM mutation on %s",
    async (origin) => {
      const expectedAccountDigest = createHash("sha256").update("account-a").digest("hex");
      const expression = buildArchiveConversationExpressionForTest({
        expectedOrigin: origin,
        expectedConversationUrl: `${origin}/c/abc`,
        expectedConversationId: "abc",
        expectedAccountDigest,
      });
      expect(expression).toContain("rawUserId.length > 0 && rawUserId.length <= 512");
      const domAccess = vi.fn();
      const document = new Proxy(
        {},
        {
          get() {
            domAccess();
            throw new Error("DOM mutation path reached");
          },
        },
      );
      const sessionTarget = `${origin}/api/auth/session`;
      const fetch = vi.fn().mockResolvedValue({
        ok: true,
        redirected: false,
        url: sessionTarget,
        json: async () => ({ user: { id: "account-b" } }),
      });
      const evaluate = new Function("location", "document", "fetch", `return ${expression};`) as (
        location: { href: string },
        document: object,
        fetch: typeof globalThis.fetch,
      ) => Promise<{
        status: string;
        reason?: string;
      }>;

      await expect(
        evaluate({ href: `${origin}/c/abc` }, document, fetch as never),
      ).resolves.toMatchObject({ status: "skipped", reason: "affinity-mismatch" });
      expect(fetch).toHaveBeenCalledWith(sessionTarget, expect.anything());
      expect(domAccess).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["https://chatgpt.com", "https://chat.openai.com"],
    ["https://chat.openai.com", "https://chatgpt.com"],
    ["https://chatgpt.com", "https://attacker.example"],
  ])(
    "checks exact ChatGPT origin before DOM mutation (%s expected, %s observed)",
    async (expectedOrigin, actualOrigin) => {
      const expectedAccountDigest = createHash("sha256").update("account-a").digest("hex");
      const expression = buildArchiveConversationExpressionForTest({
        expectedOrigin,
        expectedConversationUrl: `${expectedOrigin}/c/abc`,
        expectedConversationId: "abc",
        expectedAccountDigest,
      });
      const domAccess = vi.fn();
      const document = new Proxy(
        {},
        {
          get() {
            domAccess();
            throw new Error("DOM mutation path reached");
          },
        },
      );
      const fetch = vi.fn().mockResolvedValue({
        ok: true,
        redirected: false,
        url: `${expectedOrigin}/api/auth/session`,
        json: async () => ({ user: { id: "account-a" } }),
      });
      const evaluate = new Function("location", "document", "fetch", `return ${expression};`) as (
        location: { href: string },
        document: object,
        fetch: typeof globalThis.fetch,
      ) => Promise<{
        status: string;
        reason?: string;
      }>;

      await expect(
        evaluate({ href: `${actualOrigin}/c/abc` }, document, fetch as never),
      ).resolves.toMatchObject({ status: "skipped", reason: "affinity-mismatch" });
      expect(fetch).not.toHaveBeenCalled();
      expect(domAccess).not.toHaveBeenCalled();
    },
  );

  test("fails closed when the in-page account probe rejects", async () => {
    const expression = buildArchiveConversationExpressionForTest({
      expectedConversationId: "abc",
      expectedAccountDigest: "a".repeat(64),
    });
    const domAccess = vi.fn();
    const document = new Proxy(
      {},
      {
        get() {
          domAccess();
          throw new Error("DOM mutation path reached");
        },
      },
    );
    const fetch = vi.fn().mockRejectedValue(new Error("session unavailable"));
    const evaluate = new Function("location", "document", "fetch", `return ${expression};`) as (
      location: { href: string },
      document: object,
      fetch: typeof globalThis.fetch,
    ) => Promise<{
      status: string;
      reason?: string;
    }>;

    await expect(
      evaluate({ href: "https://chatgpt.com/c/abc" }, document, fetch as never),
    ).resolves.toMatchObject({ status: "skipped", reason: "affinity-mismatch" });
    expect(domAccess).not.toHaveBeenCalled();
  });
  test("bounds a stalled account-affinity probe by the caller remaining budget", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const expression = buildArchiveConversationExpressionForTest({
        expectedConversationId: "abc",
        expectedAccountDigest: "a".repeat(64),
        remainingMs: 100,
      });
      const domAccess = vi.fn();
      const document = new Proxy(
        {},
        {
          get() {
            domAccess();
            throw new Error("DOM mutation path reached");
          },
        },
      );
      const fetch = vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      );
      const evaluate = new Function("location", "document", "fetch", `return ${expression};`) as (
        location: { href: string },
        document: object,
        fetch: typeof globalThis.fetch,
      ) => Promise<{
        status: string;
        reason?: string;
      }>;

      const result = evaluate({ href: "https://chatgpt.com/c/abc" }, document, fetch as never);
      await vi.advanceTimersByTimeAsync(100);

      await expect(result).resolves.toMatchObject({
        status: "skipped",
        reason: "affinity-mismatch",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      const [, requestInit] = fetch.mock.calls[0] as [string, RequestInit];
      expect(requestInit.signal?.aborted).toBe(true);
      expect(domAccess).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("rechecks account affinity after opening the menu and before archive mutation", async () => {
    const expectedAccountDigest = createHash("sha256").update("account-a").digest("hex");
    const expression = buildArchiveConversationExpressionForTest({
      expectedConversationId: "abc",
      expectedAccountDigest,
    });
    class FakeElement {
      textContent = "More";
      dispatchEvent = vi.fn();
      getAttribute(name: string) {
        return name === "aria-label" ? "More" : null;
      }
      getBoundingClientRect() {
        return { left: 1160, right: 1180, top: 10, width: 20, height: 20 };
      }
    }
    const menuButton = new FakeElement();
    const document = {
      querySelectorAll: vi.fn((selector: string) =>
        selector === 'button,[role="button"]' ? [menuButton] : [],
      ),
    };
    const response = (userId: string) => ({
      ok: true,
      redirected: false,
      url: "https://chatgpt.com/api/auth/session",
      json: async () => ({ user: { id: userId } }),
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response("account-a"))
      .mockResolvedValueOnce(response("account-b"));
    const EventStub = class {};
    const evaluate = new Function(
      "location",
      "document",
      "fetch",
      "HTMLElement",
      "getComputedStyle",
      "window",
      "PointerEvent",
      "MouseEvent",
      "setTimeout",
      `return ${expression};`,
    ) as (
      location: { href: string },
      document: object,
      fetch: typeof globalThis.fetch,
      HTMLElement: typeof FakeElement,
      getComputedStyle: () => { visibility: string; display: string },
      window: { innerWidth: number },
      PointerEvent: typeof EventStub,
      MouseEvent: typeof EventStub,
      setTimeout: (callback: () => void, ms?: number) => number,
    ) => Promise<{ status: string; reason?: string }>;

    await expect(
      evaluate(
        { href: "https://chatgpt.com/c/abc" },
        document,
        fetch as never,
        FakeElement,
        () => ({ visibility: "visible", display: "block" }),
        { innerWidth: 1200 },
        EventStub,
        EventStub,
        (callback, ms) => {
          if (ms === 350) callback();
          return 0;
        },
      ),
    ).resolves.toMatchObject({ status: "skipped", reason: "affinity-mismatch" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(menuButton.dispatchEvent).toHaveBeenCalled();
    expect(document.querySelectorAll).toHaveBeenCalledTimes(1);
  });
  test("reserves fallback time to recheck affinity and confirm the Unarchive menu state", async () => {
    const expectedAccountDigest = createHash("sha256").update("account-a").digest("hex");
    const expression = buildArchiveConversationExpressionForTest({
      expectedConversationId: "abc",
      expectedAccountDigest,
      remainingMs: 2_000,
    });
    let now = 0;
    let menuOpen = false;
    let archived = false;
    class EventStub {
      constructor(readonly type: string) {}
    }
    class FakeElement {
      constructor(
        readonly label: string,
        private readonly onClick?: () => void,
      ) {}

      get textContent() {
        return this.label;
      }

      dispatchEvent = vi.fn((event: EventStub) => {
        if (event.type === "click") this.onClick?.();
        return true;
      });

      getAttribute(name: string) {
        return name === "aria-label" ? this.label : null;
      }

      getBoundingClientRect() {
        return { left: 1160, right: 1180, top: 10, width: 20, height: 20 };
      }
    }
    const menuButton = new FakeElement("More", () => {
      menuOpen = true;
    });
    const archiveItem = new FakeElement("Archive", () => {
      archived = true;
      menuOpen = false;
    });
    const unarchiveItem = new FakeElement("Unarchive");
    class FakeMenu extends FakeElement {
      querySelectorAll() {
        return menuOpen ? [archived ? unarchiveItem : archiveItem] : [];
      }
    }
    const menu = new FakeMenu("");
    const document = {
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === 'button,[role="button"]') return [menuButton];
        if (selector === '[role="menu"]') return menuOpen ? [menu] : [];
        return [];
      }),
      dispatchEvent: vi.fn(),
    };
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      redirected: false,
      url: "https://chatgpt.com/api/auth/session",
      json: async () => ({ user: { id: "account-a" } }),
    });
    const evaluate = new Function(
      "location",
      "document",
      "fetch",
      "HTMLElement",
      "getComputedStyle",
      "window",
      "PointerEvent",
      "MouseEvent",
      "KeyboardEvent",
      "Date",
      "setTimeout",
      "clearTimeout",
      "crypto",
      "globalThis",
      `return ${expression};`,
    ) as (
      location: { href: string },
      document: object,
      fetch: typeof globalThis.fetch,
      HTMLElement: typeof FakeElement,
      getComputedStyle: () => { visibility: string; display: string },
      window: { innerWidth: number },
      PointerEvent: typeof EventStub,
      MouseEvent: typeof EventStub,
      KeyboardEvent: typeof EventStub,
      Date: { now: () => number },
      setTimeout: (callback: () => void, ms: number) => number,
      clearTimeout: (timeout: number) => void,
      crypto: Crypto,
      pageGlobal: { crypto: Crypto },
    ) => Promise<{ status: string; reason?: string }>;
    const pageCrypto = globalThis.crypto;
    const result = await evaluate(
      { href: "https://chatgpt.com/c/abc" },
      document,
      fetch as never,
      FakeElement,
      () => ({ visibility: "visible", display: "block" }),
      { innerWidth: 1200 },
      EventStub,
      EventStub,
      EventStub,
      { now: () => now },
      (callback, ms) => {
        if (ms <= 500) {
          now += ms;
          callback();
        }
        return 1;
      },
      () => undefined,
      pageCrypto,
      { crypto: pageCrypto },
    );

    expect(result).toMatchObject({ status: "archived" });
    expect(archived).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(menuButton.dispatchEvent).toHaveBeenCalledTimes(10);
    expect(archiveItem.dispatchEvent).toHaveBeenCalled();
  });

  test.each(["https://chatgpt.com", "https://chat.openai.com"])(
    "keeps the archive expression scoped to Archive actions on %s",
    (origin) => {
      const expression = buildArchiveConversationExpressionForTest({
        expectedOrigin: origin,
        expectedConversationUrl: `${origin}/g/g-project/project/c/abc`,
      });
      expect(expression).toContain("findConversationMenuButton");
      expect(expression).toContain("visibleMenuCandidates");
      expect(expression).toContain("findArchiveMenuItem");
      expect(expression).toContain("findArchiveConfirmationButton");
      expect(expression).toContain("hasUnarchiveMenuItem");
      expect(expression).toContain("PointerEvent");
      expect(expression).toContain("waitForArchiveConfirmation");
      expect(expression).toContain("const remainingMs =");
      expect(expression).toContain("const confirmationDeadline =");
      expect(expression).toContain("AbortController");
      expect(expression).toContain("Promise.withResolvers");
      expect(expression).toContain(`const expectedOrigin = "${origin}";`);
      expect(expression).toContain("const pageOrigin = new URL(location.href).origin;");
      expect(expression).toContain("target = new URL('/api/auth/session', pageOrigin).href;");
      expect(expression).toContain("if (pageOrigin !== expectedOrigin) return null;");
      expect(expression).toContain("redirect: 'error'");
      expect(expression).toContain("response.redirected");
      expect(expression).toContain("response.url !== target");
      expect(expression).toContain("archive-not-confirmed");
      expect(expression).toContain("const deadline = Date.now() + 10000;");
      expect(expression).toContain("archive");
      expect(expression).not.toContain("delete");
    },
  );
});
