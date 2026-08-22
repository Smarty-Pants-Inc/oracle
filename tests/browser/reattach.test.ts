import { describe, expect, test, vi } from "vitest";
import { resumeBrowserSession, __test__ } from "../../src/browser/reattach.js";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";

type FakeTarget = { id?: string; targetId?: string; type?: string; url?: string };
type FakeClient = {
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Runtime: {
    enable: () => void;
    evaluate: (params: {
      expression: string;
      returnByValue?: boolean;
    }) => Promise<{ result: { value: unknown } }>;
  };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  DOM: { enable: () => void };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Page?: { enable: () => void };
  close: () => Promise<void> | void;
};

describe("resumeBrowserSession", () => {
  test("selects target and captures markdown via stubs", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const close = vi.fn(async () => {});
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "Hello PATH plan",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "markdown response");
    const waitForConversationHydration = vi.fn(async () => 2);
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
      waitForConversationHydration,
    });

    expect(result.answerMarkdown).toBe("markdown response");
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 51559, target: "target-1" }),
    );
    expect(waitForAssistantResponse).toHaveBeenCalledWith(
      expect.anything(),
      2000,
      logger,
      expect.anything(),
      "abc",
    );
    expect(captureAssistantMarkdown).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      logger,
      "abc",
      expect.any(Function),
    );
    expect(waitForConversationHydration).toHaveBeenCalledWith(expect.anything(), 2000, logger, {
      requirePriorTurns: true,
      requirePromptReady: false,
      expectedConversationUrl: runtime.tabUrl,
    });
    expect(waitForConversationHydration.mock.invocationCallOrder[0]).toBeLessThan(
      waitForAssistantResponse.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(close).toHaveBeenCalledOnce();
  });

  test("uses prompt preview turn index when reattaching to an already-open answer", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (expression.includes("const needle =")) {
        return { result: { value: 3 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "live reattach pro 123",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-4" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "live reattach pro 123");
    const logger = vi.fn() as BrowserLogger;

    await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
      waitForConversationHydration: vi.fn(async () => 2),
      promptPreview: "live reattach pro 123",
    });

    expect(waitForAssistantResponse).toHaveBeenCalledWith(
      expect.anything(),
      2000,
      logger,
      3,
      "abc",
    );
  });

  test("uses Deep Research completion path when reattaching research sessions", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/deep",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (expression.includes("querySelectorAll")) {
        return { result: { value: 3 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Page: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn();
    const captureAssistantMarkdown = vi.fn();
    const waitForDeepResearchCompletion = vi.fn(async () => ({
      text: "Deep report body",
      html: "<p>Deep report body</p>",
      meta: { turnId: null, messageId: null },
    }));
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(
      runtime,
      { timeoutMs: 2000, researchMode: "deep" },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        waitForDeepResearchCompletion,
        waitForConversationHydration: vi.fn(async () => 2),
      },
    );

    expect(result.answerMarkdown).toBe("Deep report body");
    expect(waitForDeepResearchCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ evaluate }),
      logger,
      2000,
      2,
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        requireScopedTargetOwner: true,
        expectedConversationId: "deep",
        assertPageAffinity: expect.any(Function),
      }),
    );
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    expect(captureAssistantMarkdown).not.toHaveBeenCalled();
  });

  test("falls back to recovery when chrome port is missing", async () => {
    const runtime = {
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, { recoverSession });

    expect(result.answerMarkdown).toBe("fallback-md");
    expect(recoverSession).toHaveBeenCalled();
  });

  test("tries live reattach from browser websocket metadata before falling back", async () => {
    const runtime = {
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeProfileRoot: "/tmp/oracle-attach-running-profile",
      tabUrl: "https://chatgpt.com/c/abc",
      chromeTargetId: "target-2",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-2", type: "page", url: "https://chatgpt.com/c/abc" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "attached-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(
      runtime,
      { attachRunning: true, timeoutMs: 2_000 },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        waitForConversationHydration: vi.fn(async () => 2),
      },
    );

    expect(result.answerMarkdown).toBe("attached-md");
    expect(listTargets).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "ws://127.0.0.1:9222/devtools/browser/abc",
        local: true,
      }),
    );
  });

  test("revalidates routed browser identity and uses the fresh exact WebSocket", async () => {
    const freshBrowserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: freshBrowserWSEndpoint }),
      }),
    );
    const runtime = {
      chromePort: 9223,
      chromeHost: "127.0.0.1",
      chromeBrowserWSEndpoint: "ws://stale.invalid/devtools/browser/browser-a",
      chromeTargetId: "target-2",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "target-2", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
      result: {
        value:
          expression === "location.href"
            ? runtime.tabUrl
            : expression.includes("/api/auth/session")
              ? accountDigest
              : 2,
      },
    }));
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;

    try {
      await expect(
        resumeBrowserSession(
          runtime,
          {
            remoteChrome: { host: "127.0.0.1", port: 9223 },
            remoteChromeBrowserId: "browser-a",
            remoteChromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
            remoteChromeAccountDigest: accountDigest,
            timeoutMs: 2_000,
          },
          vi.fn() as BrowserLogger,
          {
            listTargets,
            connect,
            waitForAssistantResponse: vi.fn(async () => ({
              text: "attached",
              html: "",
              meta: { messageId: "m1", turnId: "conversation-turn-1" },
            })),
            captureAssistantMarkdown: vi.fn(async () => "attached-md"),
            waitForConversationHydration: vi.fn(async () => 2),
          },
        ),
      ).resolves.toMatchObject({ answerMarkdown: "attached-md" });
      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({ target: freshBrowserWSEndpoint, local: true }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("rejects a routed browser swap without recovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/browser-b",
        }),
      }),
    );
    const recoverSession = vi.fn(async () => ({
      answerText: "must not recover",
      answerMarkdown: "must not recover",
    }));
    try {
      await expect(
        resumeBrowserSession(
          {
            chromePort: 9223,
            chromeHost: "127.0.0.1",
            chromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
          },
          {
            remoteChrome: { host: "127.0.0.1", port: 9223 },
            remoteChromeBrowserId: "browser-a",
            remoteChromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
            remoteChromeAccountDigest: "a".repeat(64),
          },
          vi.fn() as BrowserLogger,
          { recoverSession },
        ),
      ).rejects.toThrow(/identity changed before session reattach/i);
      expect(recoverSession).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test.each([
    {
      label: "browser",
      runtime: {
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/different-browser",
        chatGptAccountDigest: "a".repeat(64),
      },
    },
    {
      label: "account",
      runtime: {
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
        chatGptAccountDigest: "b".repeat(64),
      },
    },
  ])("rejects conflicting runtime $label affinity before reattach", async ({ label, runtime }) => {
    const recoverSession = vi.fn(async () => ({
      answerText: "must not recover",
      answerMarkdown: "must not recover",
    }));
    await expect(
      resumeBrowserSession(
        {
          chromePort: 9223,
          chromeHost: "127.0.0.1",
          chromeTargetId: "target-a",
          tabUrl: "https://chatgpt.com/c/abc",
          ...runtime,
        },
        {
          remoteChrome: { host: "127.0.0.1", port: 9223 },
          remoteChromeBrowserId: "browser-a",
          remoteChromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
          remoteChromeAccountDigest: "a".repeat(64),
        },
        vi.fn() as BrowserLogger,
        { recoverSession },
      ),
    ).rejects.toThrow(new RegExp(`${label} identity is conflicting`, "i"));
    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("rejects a same-browser account swap", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: browserWSEndpoint }),
      }),
    );
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
      result: {
        value:
          expression === "location.href"
            ? "https://chatgpt.com/c/abc"
            : expression.includes("/api/auth/session")
              ? "b".repeat(64)
              : 2,
      },
    }));
    const connect = vi.fn(async () => ({
      Runtime: { enable: vi.fn(), evaluate },
      DOM: { enable: vi.fn() },
      close: vi.fn(async () => {}),
    })) as unknown as (options?: unknown) => Promise<ChromeClient>;
    try {
      await expect(
        resumeBrowserSession(
          {
            chromePort: 9223,
            chromeHost: "127.0.0.1",
            chromeTargetId: "target-a",
            tabUrl: "https://chatgpt.com/c/abc",
          },
          {
            remoteChrome: { host: "127.0.0.1", port: 9223 },
            remoteChromeBrowserId: "browser-a",
            remoteChromeBrowserWSEndpoint: browserWSEndpoint,
            remoteChromeAccountDigest: "a".repeat(64),
          },
          vi.fn() as BrowserLogger,
          {
            listTargets: vi.fn(async () => [
              { targetId: "target-a", type: "page", url: "https://chatgpt.com/c/abc" },
            ]),
            connect,
          },
        ),
      ).rejects.toThrow(/account identity changed/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("fails closed when runtime account affinity outlives remote config", async () => {
    const recoverSession = vi.fn(async () => ({
      answerText: "must not recover",
      answerMarkdown: "must not recover",
    }));
    await expect(
      resumeBrowserSession(
        {
          chromePort: 9223,
          chromeHost: "127.0.0.1",
          chromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
          chatGptAccountDigest: "a".repeat(64),
        },
        {},
        vi.fn() as BrowserLogger,
        { recoverSession },
      ),
    ).rejects.toThrow(/browser and account identity/i);
    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("fails closed for wrapper-routed host-only sessions", async () => {
    const previous = process.env.ORACLE_WRAPPER_REMOTE_ONLY;
    process.env.ORACLE_WRAPPER_REMOTE_ONLY = "1";
    const recoverSession = vi.fn(async () => ({
      answerText: "must not recover",
      answerMarkdown: "must not recover",
    }));
    try {
      await expect(
        resumeBrowserSession(
          { chromePort: 9223, chromeHost: "127.0.0.1" },
          { remoteChrome: { host: "127.0.0.1", port: 9223 } },
          vi.fn() as BrowserLogger,
          { recoverSession },
        ),
      ).rejects.toThrow(/browser and account identity/i);
      await expect(
        resumeBrowserSession(
          {
            chromePort: 9223,
            chromeHost: "127.0.0.1",
            chromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
            chatGptAccountDigest: "a".repeat(64),
          },
          {},
          vi.fn() as BrowserLogger,
          { recoverSession },
        ),
      ).rejects.toThrow(/browser and account identity/i);
      expect(recoverSession).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.ORACLE_WRAPPER_REMOTE_ONLY;
      } else {
        process.env.ORACLE_WRAPPER_REMOTE_ONLY = previous;
      }
    }
  });

  test("closes the attached client before falling back to recovery", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const listTargets = vi.fn(async () => {
      return [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[];
    }) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const close = vi.fn(async () => {});
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "must not be captured from an unhydrated shell",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const waitForConversationHydration = vi.fn(async () => {
      throw new Error("saved conversation did not hydrate");
    });
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      waitForConversationHydration,
      recoverSession,
    });

    expect(result.answerText).toBe("fallback");
    expect(close).toHaveBeenCalledOnce();
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    expect(recoverSession).toHaveBeenCalled();
  });
});

describe("reattach helpers", () => {
  const {
    pickTarget,
    extractConversationIdFromUrl,
    buildConversationUrl,
    openConversationFromSidebar,
  } = __test__;
  type EvaluateParams = { expression: string };
  type EvaluateResult<T> = { result: { value: T } };

  test("extracts conversation id from a chat URL", () => {
    expect(extractConversationIdFromUrl("https://chatgpt.com/c/abc-123")).toBe("abc-123");
    expect(
      extractConversationIdFromUrl(
        "https://chatgpt.com/c/WEB:32229414-5afa-4478-890c-9ca80aa82430",
      ),
    ).toBeUndefined();
    expect(extractConversationIdFromUrl("")).toBeUndefined();
  });

  test("builds conversation URL from tabUrl or conversationId", () => {
    expect(
      buildConversationUrl(
        { tabUrl: "https://chatgpt.com/c/live", conversationId: "ignored" },
        "https://chatgpt.com/",
      ),
    ).toBe("https://chatgpt.com/c/live");
    expect(buildConversationUrl({ conversationId: "abc" }, "https://chatgpt.com/")).toBe(
      "https://chatgpt.com/c/abc",
    );
  });

  test("pickTarget prefers a saved conversation over a stale target id", () => {
    const targets = [
      { targetId: "t-1", type: "page", url: "https://chatgpt.com/c/first" },
      { targetId: "t-2", type: "page", url: "https://chatgpt.com/c/second" },
      { targetId: "t-3", type: "page", url: "about:blank" },
    ];
    expect(pickTarget(targets, { chromeTargetId: "t-2" })).toEqual(targets[1]);
    expect(
      pickTarget(targets, {
        chromeTargetId: "t-2",
        tabUrl: "https://chatgpt.com/c/first",
        conversationId: "first",
      }),
    ).toEqual(targets[0]);
    expect(pickTarget(targets, { tabUrl: "https://chatgpt.com/c/first" })).toEqual(targets[0]);
    expect(pickTarget(targets, {})).toEqual(targets[0]);
  });

  test("pickTarget keeps the saved target among duplicate conversation tabs", () => {
    const targets = [
      { targetId: "duplicate", type: "page", url: "https://chatgpt.com/c/same" },
      { targetId: "submitted", type: "page", url: "https://chatgpt.com/c/same" },
    ];

    expect(
      pickTarget(targets, {
        chromeTargetId: "submitted",
        conversationId: "same",
      }),
    ).toEqual(targets[1]);
  });

  test("pickTarget understands CDP list ids", () => {
    const targets = [
      { id: "page-1", type: "page", url: "https://chatgpt.com/c/first" },
      { id: "page-2", type: "page", url: "about:blank" },
    ];

    expect(pickTarget(targets, { chromeTargetId: "page-1" })).toEqual(targets[0]);
  });

  test("openConversationFromSidebar passes conversationId and projects preference", async () => {
    const evaluate = vi.fn<
      (
        params: EvaluateParams,
      ) => Promise<EvaluateResult<{ ok: boolean; href?: string; count: number }>>
    >(async () => ({
      result: { value: { ok: true, href: "https://chatgpt.com/c/abc", count: 3 } },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const ok = await openConversationFromSidebar(runtime, {
      conversationId: "abc",
      preferProjects: true,
    });

    expect(ok).toBe(true);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain('const conversationId = "abc"');
    expect(call?.expression).toContain("const preferProjects = true");
  });

  test("openConversationFromSidebar handles missing conversationId", async () => {
    const evaluate = vi.fn<
      (params: EvaluateParams) => Promise<EvaluateResult<{ ok: boolean; count: number }>>
    >(async () => ({
      result: { value: { ok: false, count: 0 } },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const ok = await openConversationFromSidebar(runtime, { preferProjects: false });

    expect(ok).toBe(false);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain("const conversationId = null");
    expect(call?.expression).toContain("const preferProjects = false");
  });
});
