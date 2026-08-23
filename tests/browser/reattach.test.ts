import { describe, expect, test, vi } from "vitest";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import { resumeBrowserSession, __test__ } from "../../src/browser/reattach.js";
import type { OpenBrowserUseConnection } from "../../src/browser/openBrowserUse.js";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";
import { hashConversationTurnText } from "../../src/browser/conversationTurns.js";

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

const obuConversationUrl = "https://chatgpt.com/c/obu-thread";
const obuAccountDigest = "a".repeat(64);
const obuWorkspaceDigest = "b".repeat(64);
const obuRuntime = {
  browserTransport: "obu" as const,
  obuSessionId: "stored-session",
  obuTabId: 7,
  chatGptAccountEmail: "paul@smartypants.ai",
  chatGptWorkspaceName: "Paul Bettner",
  chatGptAccountDigest: obuAccountDigest,
  chatGptWorkspaceDigest: obuWorkspaceDigest,
  tabUrl: obuConversationUrl,
  conversationId: "obu-thread",
  promptSubmitted: true,
  promptTurnIndex: 0,
  promptTurnId: "user-turn-0",
  promptMessageId: "user-message-0",
  assistantTurnIndex: 1,
  assistantTurnId: "assistant-turn-1",
  assistantMessageId: "assistant-message-1",
};

function createObuConnection(sessionId: string, tabId: number) {
  const Runtime = {
    enable: vi.fn(),
    evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
      result: {
        value: expression.includes("/api/auth/session")
          ? {
              status: "authenticated",
              email: "paul@smartypants.ai",
              accountDigest: obuAccountDigest,
              workspaceDigest: obuWorkspaceDigest,
            }
          : expression.includes("location.href")
            ? obuConversationUrl
            : expression.includes("const candidates = []")
              ? [
                  {
                    user: {
                      index: 0,
                      text: "exact prompt",
                      turnId: "user-turn-0",
                      messageId: "user-message-0",
                    },
                    assistants: [
                      {
                        index: 1,
                        text: "exact answer",
                        turnId: "assistant-turn-1",
                        messageId: "assistant-message-1",
                        completionVisible: true,
                      },
                    ],
                    hasLaterUserTurn: true,
                  },
                ]
              : null,
      },
    })),
  } as unknown as ChromeClient["Runtime"];
  const finalize = vi.fn(async (_keepTab: boolean) => {});
  const connection: OpenBrowserUseConnection = {
    client: {
      Runtime,
      DOM: { enable: vi.fn() },
      Page: { enable: vi.fn() },
    } as unknown as ChromeClient,
    obuClient: {} as OpenBrowserUseConnection["obuClient"],
    sessionId,
    tabId,
    tabUrl: obuConversationUrl,
    created: sessionId !== "stored-session",
    finalize,
  };
  return { connection, Runtime, finalize };
}

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
    expect(waitForAssistantResponse).toHaveBeenCalled();
    expect(captureAssistantMarkdown).toHaveBeenCalled();
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

    expect(waitForAssistantResponse).toHaveBeenCalledWith(expect.anything(), 2000, logger, 3);
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
      if (expression === "location.href" || expression.includes("location.href ? location.href")) {
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
      {
        requireScopedTargetOwner: true,
      },
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

  test("reattaches an OBU tab to the exact stored prompt and persists its assistant", async () => {
    const { connection, Runtime, finalize } = createObuConnection("recovered-session", 8);
    const release = vi.fn(async () => {});
    const promptOnlyRuntime = {
      ...obuRuntime,
      assistantTurnIndex: undefined,
      assistantTurnId: undefined,
      assistantMessageId: undefined,
    };
    const waitForAssistantResponse = vi.fn(
      async (
        _Runtime: ChromeClient["Runtime"],
        _timeoutMs: number,
        _logger: BrowserLogger,
        _minTurnIndex?: number,
        _expectedConversationId?: string,
      ) => ({
        text: "exact answer",
        html: "",
        meta: { messageId: "m1", turnId: "turn-1" },
      }),
    );
    const result = await resumeBrowserSession(
      promptOnlyRuntime,
      {
        browserTransport: "obu",
        obuSessionId: "stored-session",
        obuTabId: 7,
        chatGptAccountEmail: "paul@smartypants.ai",
        chatGptWorkspaceName: "Paul Bettner",
        chatGptAccountDigest: obuAccountDigest,
        chatGptWorkspaceDigest: obuWorkspaceDigest,
        url: obuConversationUrl,
        timeoutMs: 2_000,
      },
      vi.fn() as BrowserLogger,
      {
        acquireOpenBrowserUseRunLock: vi.fn(async () => ({
          path: "/tmp/oracle.lock",
          lockId: "lock-1",
          release,
        })),
        connectOpenBrowserUseTab: vi.fn(async () => connection),
        prepareOpenBrowserUseChatGptRoute: vi.fn(async () => ({
          email: "paul@smartypants.ai",
          workspaceName: "Paul Bettner",
          accountDigest: obuAccountDigest,
          workspaceDigest: obuWorkspaceDigest,
        })),
        waitForConversationHydration: vi.fn(async () => 2),
        waitForAssistantResponse,
        captureAssistantMarkdown: vi.fn(async () => "exact **answer**"),
      },
    );

    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      answerMarkdown: "exact **answer**",
      runtime: {
        browserTransport: "obu",
        obuSessionId: "recovered-session",
        obuTabId: 8,
        conversationId: "obu-thread",
        assistantTurnIndex: 1,
        assistantTurnId: "assistant-turn-1",
        assistantMessageId: "assistant-message-1",
      },
    });
    expect(Runtime.evaluate).toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith(false);
    expect(release).toHaveBeenCalledOnce();
  });

  test("recovers a delayed OBU conversation URL from the exact stored tab", async () => {
    const runtime = { ...obuRuntime, tabUrl: undefined, conversationId: undefined };
    const { connection, finalize } = createObuConnection("stored-session", 7);
    connection.tabUrl = undefined;
    const connectOpenBrowserUseTab = vi.fn(async () => connection);
    const waitForOpenBrowserUseConversationUrl = vi.fn(async () => obuConversationUrl);
    const prepareOpenBrowserUseConversationRoute = vi.fn(async () => ({
      email: "paul@smartypants.ai",
      workspaceName: "Paul Bettner",
      accountDigest: obuAccountDigest,
      workspaceDigest: obuWorkspaceDigest,
    }));

    await expect(
      resumeBrowserSession(
        runtime,
        {
          browserTransport: "obu",
          obuSessionId: "stored-session",
          obuTabId: 7,
          chatGptAccountEmail: "paul@smartypants.ai",
          chatGptWorkspaceName: "Paul Bettner",
          chatGptAccountDigest: obuAccountDigest,
          chatGptWorkspaceDigest: obuWorkspaceDigest,
          url: "https://chatgpt.com/",
          timeoutMs: 2_000,
        },
        vi.fn() as BrowserLogger,
        {
          acquireOpenBrowserUseRunLock: vi.fn(async () => ({
            path: "/tmp/oracle.lock",
            lockId: "lock-1",
            release: vi.fn(async () => {}),
          })),
          connectOpenBrowserUseTab,
          prepareOpenBrowserUseConversationRoute,
          waitForOpenBrowserUseConversationUrl,
          waitForConversationHydration: vi.fn(async () => 2),
          waitForAssistantResponse: vi.fn(async () => ({
            text: "delayed answer",
            html: "",
            meta: { messageId: "m1", turnId: "turn-1" },
          })),
          captureAssistantMarkdown: vi.fn(async () => "delayed **answer**"),
        },
      ),
    ).resolves.toMatchObject({
      answerMarkdown: "delayed **answer**",
      runtime: {
        obuSessionId: "stored-session",
        obuTabId: 7,
        tabUrl: obuConversationUrl,
        conversationId: "obu-thread",
      },
    });
    expect(connectOpenBrowserUseTab).toHaveBeenCalledWith(
      expect.objectContaining({
        obuSessionId: "stored-session",
        obuTabId: 7,
        exactTabOnly: true,
        conversationUrl: null,
      }),
    );
    expect(waitForOpenBrowserUseConversationUrl).toHaveBeenCalledWith(
      expect.objectContaining({ connection }),
    );
    expect(prepareOpenBrowserUseConversationRoute).toHaveBeenCalledWith(
      expect.objectContaining({ targetUrl: obuConversationUrl }),
    );
    expect(finalize).toHaveBeenCalledWith(false);
  });

  test("preserves the exact OBU tab while its conversation URL is still unavailable", async () => {
    const runtime = {
      ...obuRuntime,
      tabUrl: undefined,
      conversationId: undefined,
      submittedPromptText: "exact prompt",
      submittedPromptIndex: 0,
    };
    const { connection, finalize } = createObuConnection("stored-session", 7);
    connection.tabUrl = undefined;
    const delayedUrlError = new BrowserAutomationError(
      "The accepted prompt has not received a stable conversation URL yet.",
      { stage: "chatgpt-scope", code: "conversation-affinity-unavailable" },
    );

    await expect(
      resumeBrowserSession(
        runtime,
        {
          browserTransport: "obu",
          obuSessionId: "stored-session",
          obuTabId: 7,
          chatGptAccountEmail: "paul@smartypants.ai",
          chatGptWorkspaceName: "Paul Bettner",
          chatGptAccountDigest: obuAccountDigest,
          chatGptWorkspaceDigest: obuWorkspaceDigest,
          url: "https://chatgpt.com/",
          timeoutMs: 2_000,
        },
        vi.fn() as BrowserLogger,
        {
          acquireOpenBrowserUseRunLock: vi.fn(async () => ({
            path: "/tmp/oracle.lock",
            lockId: "lock-1",
            release: vi.fn(async () => {}),
          })),
          connectOpenBrowserUseTab: vi.fn(async () => connection),
          waitForOpenBrowserUseConversationUrl: vi.fn(async () => {
            throw delayedUrlError;
          }),
        },
      ),
    ).rejects.toMatchObject({
      details: {
        stage: "chatgpt-scope",
        code: "conversation-affinity-unavailable",
        runtime: { obuSessionId: "stored-session", obuTabId: 7 },
      },
    });
    expect(finalize).toHaveBeenCalledWith(true);
  });

  test("fails closed when an OBU reattach lacks exact prompt affinity", async () => {
    const { connection, finalize } = createObuConnection("stored-session", 7);
    const runtime = {
      ...obuRuntime,
      promptTurnIndex: undefined,
      promptTurnId: undefined,
      promptMessageId: undefined,
      assistantTurnIndex: undefined,
      assistantTurnId: undefined,
      assistantMessageId: undefined,
    };

    await expect(
      resumeBrowserSession(
        runtime,
        {
          browserTransport: "obu",
          obuSessionId: "stored-session",
          obuTabId: 7,
          chatGptAccountEmail: "paul@smartypants.ai",
          chatGptWorkspaceName: "Paul Bettner",
          chatGptAccountDigest: obuAccountDigest,
          chatGptWorkspaceDigest: obuWorkspaceDigest,
          url: obuConversationUrl,
          timeoutMs: 2_000,
        },
        vi.fn() as BrowserLogger,
        {
          acquireOpenBrowserUseRunLock: vi.fn(async () => ({
            path: "/tmp/oracle.lock",
            lockId: "lock-1",
            release: vi.fn(async () => {}),
          })),
          connectOpenBrowserUseTab: vi.fn(async () => connection),
          prepareOpenBrowserUseChatGptRoute: vi.fn(async () => ({
            email: "paul@smartypants.ai",
            workspaceName: "Paul Bettner",
            accountDigest: obuAccountDigest,
            workspaceDigest: obuWorkspaceDigest,
          })),
          waitForConversationHydration: vi.fn(async () => 2),
        },
      ),
    ).rejects.toMatchObject({
      details: { stage: "chatgpt-turn-affinity", code: "turn-affinity-missing" },
    });
    expect(finalize).toHaveBeenCalledWith(true);
  });

  test("does not bind an older identical prompt without a persisted turn boundary", async () => {
    const { connection, Runtime, finalize } = createObuConnection("stored-session", 7);
    const evaluate = Runtime.evaluate as ReturnType<typeof vi.fn>;
    evaluate.mockImplementation(async ({ expression }: { expression: string }) => {
      if (expression.includes("/api/auth/session")) {
        return {
          result: {
            value: {
              status: "authenticated",
              email: "paul@smartypants.ai",
              accountDigest: obuAccountDigest,
              workspaceDigest: obuWorkspaceDigest,
            },
          },
        };
      }
      if (expression.includes("location.href")) {
        return { result: { value: obuConversationUrl } };
      }
      if (expression.includes("return turns.flatMap")) {
        return {
          result: {
            value: [
              {
                index: 0,
                text: "exact prompt",
                turnId: "older-user-turn",
                messageId: "older-user-message",
              },
            ],
          },
        };
      }
      if (expression.includes("const candidates = []")) {
        return {
          result: {
            value: [
              {
                user: {
                  index: 0,
                  text: "exact prompt",
                  turnId: "older-user-turn",
                  messageId: "older-user-message",
                },
                assistants: [
                  {
                    index: 1,
                    text: "older answer",
                    turnId: "older-assistant-turn",
                    messageId: "older-assistant-message",
                    completionVisible: true,
                  },
                ],
                hasLaterUserTurn: true,
              },
            ],
          },
        };
      }
      return { result: { value: null } };
    });
    const runtime = {
      ...obuRuntime,
      promptDigest: hashConversationTurnText("exact prompt"),
      promptTurnIndex: undefined,
      promptTurnId: undefined,
      promptMessageId: undefined,
      assistantTurnIndex: undefined,
      assistantTurnId: undefined,
      assistantMessageId: undefined,
      submittedPromptText: "exact prompt",
      submittedPromptIndex: 0,
      promptSubmitted: true,
    };

    await expect(
      resumeBrowserSession(
        runtime,
        {
          browserTransport: "obu",
          obuSessionId: "stored-session",
          obuTabId: 7,
          chatGptAccountEmail: "paul@smartypants.ai",
          chatGptWorkspaceName: "Paul Bettner",
          chatGptAccountDigest: obuAccountDigest,
          chatGptWorkspaceDigest: obuWorkspaceDigest,
          url: obuConversationUrl,
          timeoutMs: 2_000,
        },
        vi.fn() as BrowserLogger,
        {
          acquireOpenBrowserUseRunLock: vi.fn(async () => ({
            path: "/tmp/oracle.lock",
            lockId: "lock-1",
            release: vi.fn(async () => {}),
          })),
          connectOpenBrowserUseTab: vi.fn(async () => connection),
          prepareOpenBrowserUseChatGptRoute: vi.fn(async () => ({
            email: "paul@smartypants.ai",
            workspaceName: "Paul Bettner",
            accountDigest: obuAccountDigest,
            workspaceDigest: obuWorkspaceDigest,
          })),
          waitForConversationHydration: vi.fn(async () => 2),
          promptText: "exact prompt",
        },
      ),
    ).rejects.toMatchObject({
      details: { stage: "chatgpt-turn-affinity", code: "turn-affinity-missing" },
    });
    expect(finalize).toHaveBeenCalledWith(true);
  });

  test("does not guess the initial prompt for a legacy session with planned follow-ups", () => {
    expect(
      __test__.resolveReattachPromptText(
        { promptSubmitted: true },
        { promptText: "initial prompt", followUpPrompts: ["follow-up prompt"] },
      ),
    ).toBeUndefined();
  });

  test.each([
    {
      label: "turn index only",
      provisional: { promptDigest: undefined, promptTurnIndex: 0 },
      promptText: "exact prompt",
      followUpPrompts: undefined,
      submittedPromptText: undefined,
      submittedPromptIndex: undefined,
      promptSubmitted: true,
      renderedPrompt: "exact prompt",
      turnIndex: 0,
    },
    {
      label: "persisted follow-up prompt",
      provisional: { promptDigest: undefined, promptTurnIndex: 2 },
      promptText: "initial prompt",
      followUpPrompts: undefined,
      submittedPromptText: "follow-up prompt",
      submittedPromptIndex: 1,
      promptSubmitted: true,
      renderedPrompt: "follow-up prompt",
      turnIndex: 2,
    },
    {
      label: "prepared prompt before submit callback",
      provisional: { promptDigest: undefined, promptTurnIndex: 0 },
      promptText: "exact prompt",
      followUpPrompts: undefined,
      submittedPromptText: "exact prompt",
      submittedPromptIndex: 0,
      promptSubmitted: false,
      renderedPrompt: "exact prompt",
      turnIndex: 0,
    },
  ])(
    "recovers a missing OBU prompt binding from the exact stored prompt ($label)",
    async ({
      provisional,
      promptText,
      followUpPrompts,
      submittedPromptText,
      submittedPromptIndex,
      promptSubmitted,
      renderedPrompt,
      turnIndex,
    }) => {
      const { connection, Runtime, finalize } = createObuConnection("stored-session", 7);
      const evaluate = Runtime.evaluate as ReturnType<typeof vi.fn>;
      evaluate.mockImplementation(async ({ expression }: { expression: string }) => {
        if (expression.includes("/api/auth/session")) {
          return {
            result: {
              value: {
                status: "authenticated",
                email: "paul@smartypants.ai",
                accountDigest: obuAccountDigest,
                workspaceDigest: obuWorkspaceDigest,
              },
            },
          };
        }
        if (expression.includes("location.href")) {
          return { result: { value: obuConversationUrl } };
        }
        if (expression.includes("return turns.flatMap")) {
          return {
            result: {
              value: [
                {
                  index: turnIndex,
                  text: renderedPrompt,
                  turnId: `user-turn-${turnIndex}`,
                  messageId: `user-message-${turnIndex}`,
                },
              ],
            },
          };
        }
        if (expression.includes("const candidates = []")) {
          return {
            result: {
              value: [
                {
                  user: {
                    index: turnIndex,
                    text: renderedPrompt,
                    turnId: `user-turn-${turnIndex}`,
                    messageId: `user-message-${turnIndex}`,
                  },
                  assistants: [
                    {
                      index: turnIndex + 1,
                      text: "exact answer",
                      turnId: `assistant-turn-${turnIndex + 1}`,
                      messageId: `assistant-message-${turnIndex + 1}`,
                      completionVisible: true,
                    },
                  ],
                  hasLaterUserTurn: true,
                },
              ],
            },
          };
        }
        return { result: { value: null } };
      });
      const runtime = {
        ...obuRuntime,
        ...provisional,
        submittedPromptText,
        submittedPromptIndex,
        promptSubmitted,
        promptTurnId: undefined,
        promptMessageId: undefined,
        assistantTurnIndex: undefined,
        assistantTurnId: undefined,
        assistantMessageId: undefined,
      };

      await expect(
        resumeBrowserSession(
          runtime,
          {
            browserTransport: "obu",
            obuSessionId: "stored-session",
            obuTabId: 7,
            chatGptAccountEmail: "paul@smartypants.ai",
            chatGptWorkspaceName: "Paul Bettner",
            chatGptAccountDigest: obuAccountDigest,
            chatGptWorkspaceDigest: obuWorkspaceDigest,
            url: obuConversationUrl,
            timeoutMs: 2_000,
          },
          vi.fn() as BrowserLogger,
          {
            acquireOpenBrowserUseRunLock: vi.fn(async () => ({
              path: "/tmp/oracle.lock",
              lockId: "lock-1",
              release: vi.fn(async () => {}),
            })),
            connectOpenBrowserUseTab: vi.fn(async () => connection),
            prepareOpenBrowserUseChatGptRoute: vi.fn(async () => ({
              email: "paul@smartypants.ai",
              workspaceName: "Paul Bettner",
              accountDigest: obuAccountDigest,
              workspaceDigest: obuWorkspaceDigest,
            })),
            waitForConversationHydration: vi.fn(async () => 2),
            captureAssistantMarkdown: vi.fn(async () => "exact **answer**"),
            promptText,
            followUpPrompts,
          },
        ),
      ).resolves.toMatchObject({
        answerMarkdown: "exact **answer**",
        runtime: {
          promptDigest: hashConversationTurnText(renderedPrompt),
          promptTurnIndex: turnIndex,
          promptTurnId: `user-turn-${turnIndex}`,
          promptMessageId: `user-message-${turnIndex}`,
          assistantTurnIndex: turnIndex + 1,
          assistantTurnId: `assistant-turn-${turnIndex + 1}`,
          assistantMessageId: `assistant-message-${turnIndex + 1}`,
        },
      });
      expect(finalize).toHaveBeenCalledWith(false);
    },
  );

  test("fails closed when a bound OBU prompt has multiple unbound assistant branches", async () => {
    const { connection, Runtime, finalize } = createObuConnection("stored-session", 7);
    const evaluate = Runtime.evaluate as ReturnType<typeof vi.fn>;
    evaluate.mockImplementation(async ({ expression }: { expression: string }) => {
      if (expression.includes("/api/auth/session")) {
        return {
          result: {
            value: {
              status: "authenticated",
              email: "paul@smartypants.ai",
              accountDigest: obuAccountDigest,
              workspaceDigest: obuWorkspaceDigest,
            },
          },
        };
      }
      if (expression.includes("location.href")) {
        return { result: { value: obuConversationUrl } };
      }
      if (expression.includes("const candidates = []")) {
        return {
          result: {
            value: [
              {
                user: {
                  index: 0,
                  text: "exact prompt",
                  turnId: "user-turn-0",
                  messageId: "user-message-0",
                },
                assistants: [
                  { index: 1, text: "first answer", messageId: "assistant-message-1" },
                  { index: 1, text: "regenerated answer", messageId: "assistant-message-2" },
                ],
                hasLaterUserTurn: false,
              },
            ],
          },
        };
      }
      return { result: { value: null } };
    });

    await expect(
      resumeBrowserSession(
        {
          ...obuRuntime,
          assistantTurnIndex: undefined,
          assistantTurnId: undefined,
          assistantMessageId: undefined,
        },
        {
          browserTransport: "obu",
          obuSessionId: "stored-session",
          obuTabId: 7,
          chatGptAccountEmail: "paul@smartypants.ai",
          chatGptWorkspaceName: "Paul Bettner",
          chatGptAccountDigest: obuAccountDigest,
          chatGptWorkspaceDigest: obuWorkspaceDigest,
          url: obuConversationUrl,
          timeoutMs: 2_000,
        },
        vi.fn() as BrowserLogger,
        {
          acquireOpenBrowserUseRunLock: vi.fn(async () => ({
            path: "/tmp/oracle.lock",
            lockId: "lock-1",
            release: vi.fn(async () => {}),
          })),
          connectOpenBrowserUseTab: vi.fn(async () => connection),
          prepareOpenBrowserUseChatGptRoute: vi.fn(async () => ({
            email: "paul@smartypants.ai",
            workspaceName: "Paul Bettner",
            accountDigest: obuAccountDigest,
            workspaceDigest: obuWorkspaceDigest,
          })),
          waitForConversationHydration: vi.fn(async () => 2),
        },
      ),
    ).rejects.toMatchObject({
      details: { stage: "chatgpt-turn-affinity", code: "turn-affinity-ambiguous" },
    });
    expect(finalize).toHaveBeenCalledWith(true);
  });

  test.each([
    {
      label: "planned follow-ups remain",
      submittedPromptIndex: 0,
      expectedDetails: { code: "follow-ups-pending", remainingFollowUps: 1 },
    },
    {
      label: "the final planned follow-up is bound but the full transcript is unavailable",
      submittedPromptIndex: 1,
      expectedDetails: { code: "follow-up-transcript-unavailable" },
    },
  ])(
    "preserves the exact OBU tab when $label",
    async ({ submittedPromptIndex, expectedDetails }) => {
      const { connection, finalize } = createObuConnection("stored-session", 7);
      const runtime = {
        ...obuRuntime,
        submittedPromptText: submittedPromptIndex === 0 ? "exact prompt" : "follow-up prompt",
        submittedPromptIndex,
      };

      await expect(
        resumeBrowserSession(
          runtime,
          {
            browserTransport: "obu",
            obuSessionId: "stored-session",
            obuTabId: 7,
            chatGptAccountEmail: "paul@smartypants.ai",
            chatGptWorkspaceName: "Paul Bettner",
            chatGptAccountDigest: obuAccountDigest,
            chatGptWorkspaceDigest: obuWorkspaceDigest,
            url: obuConversationUrl,
            timeoutMs: 2_000,
          },
          vi.fn() as BrowserLogger,
          {
            acquireOpenBrowserUseRunLock: vi.fn(async () => ({
              path: "/tmp/oracle.lock",
              lockId: "lock-1",
              release: vi.fn(async () => {}),
            })),
            connectOpenBrowserUseTab: vi.fn(async () => connection),
            prepareOpenBrowserUseChatGptRoute: vi.fn(async () => ({
              email: "paul@smartypants.ai",
              workspaceName: "Paul Bettner",
              accountDigest: obuAccountDigest,
              workspaceDigest: obuWorkspaceDigest,
            })),
            waitForConversationHydration: vi.fn(async () => 2),
            captureAssistantMarkdown: vi.fn(async () => "exact **answer**"),
            followUpPrompts: ["follow-up prompt"],
          },
        ),
      ).rejects.toMatchObject({
        details: { stage: "browser-follow-ups", ...expectedDetails },
      });
      expect(finalize).toHaveBeenCalledWith(true);
    },
  );

  test("uses completion evidence from the exact assistant instead of a global stop button", async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("stop-response")) return { result: { value: true } };
        return {
          result: {
            value: [
              {
                user: {
                  index: 0,
                  text: "exact prompt",
                  turnId: "user-turn-0",
                  messageId: "user-message-0",
                },
                assistants: [
                  {
                    index: 1,
                    text: "exact completed answer",
                    turnId: "assistant-turn-1",
                    messageId: "assistant-message-1",
                    completionVisible: true,
                  },
                ],
                hasLaterUserTurn: false,
              },
            ],
          },
        };
      });
      const pending = __test__.waitForBoundAssistantTurn(
        { evaluate } as never,
        {
          promptTurnId: "user-turn-0",
          promptMessageId: "user-message-0",
          assistantTurnId: "assistant-turn-1",
          assistantMessageId: "assistant-message-1",
        },
        5_000,
        vi.fn() as BrowserLogger,
      );

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toMatchObject({ text: "exact completed answer" });
      expect(evaluate.mock.calls.some(([call]) => call.expression.includes("stop-response"))).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("returns the assistant paired with the stored user turn after later child turns", async () => {
    const parentPrompt = `${"shared prefix ".repeat(20)}parent`;
    const runtime = {
      ...obuRuntime,
      promptDigest: hashConversationTurnText(parentPrompt),
      promptTurnIndex: 0,
      promptTurnId: "user-turn-0",
      promptMessageId: "user-message-0",
    };
    const { connection, Runtime, finalize } = createObuConnection("stored-session", 7);
    const evaluate = Runtime.evaluate as ReturnType<typeof vi.fn>;
    evaluate.mockImplementation(async ({ expression }: { expression: string }) => {
      if (expression.includes("/api/auth/session")) {
        return {
          result: {
            value: {
              status: "authenticated",
              email: "paul@smartypants.ai",
              accountDigest: obuAccountDigest,
              workspaceDigest: obuWorkspaceDigest,
            },
          },
        };
      }
      if (expression.includes("location.href")) {
        return { result: { value: obuConversationUrl } };
      }
      if (expression.includes("const candidates = []")) {
        return {
          result: {
            value: [
              {
                user: {
                  index: 0,
                  text: parentPrompt,
                  turnId: "user-turn-0",
                  messageId: "user-message-0",
                },
                assistants: [
                  {
                    index: 1,
                    text: "parent answer",
                    turnId: "assistant-turn-1",
                    messageId: "assistant-message-1",
                  },
                ],
                hasLaterUserTurn: true,
              },
            ],
          },
        };
      }
      return { result: { value: null } };
    });
    const waitForAssistantResponse = vi.fn();
    const captureAssistantMarkdown = vi.fn(async () => "parent **answer**");

    await expect(
      resumeBrowserSession(
        runtime,
        {
          browserTransport: "obu",
          obuSessionId: "stored-session",
          obuTabId: 7,
          chatGptAccountEmail: "paul@smartypants.ai",
          chatGptWorkspaceName: "Paul Bettner",
          chatGptAccountDigest: obuAccountDigest,
          chatGptWorkspaceDigest: obuWorkspaceDigest,
          url: obuConversationUrl,
          timeoutMs: 2_000,
        },
        vi.fn() as BrowserLogger,
        {
          acquireOpenBrowserUseRunLock: vi.fn(async () => ({
            path: "/tmp/oracle.lock",
            lockId: "lock-1",
            release: vi.fn(async () => {}),
          })),
          connectOpenBrowserUseTab: vi.fn(async () => connection),
          prepareOpenBrowserUseChatGptRoute: vi.fn(async () => ({
            email: "paul@smartypants.ai",
            workspaceName: "Paul Bettner",
            accountDigest: obuAccountDigest,
            workspaceDigest: obuWorkspaceDigest,
          })),
          waitForConversationHydration: vi.fn(async () => 3),
          waitForAssistantResponse,
          captureAssistantMarkdown,
        },
      ),
    ).resolves.toMatchObject({
      answerText: "parent answer",
      answerMarkdown: "parent **answer**",
      runtime: {
        assistantTurnIndex: 1,
        assistantTurnId: "assistant-turn-1",
        assistantMessageId: "assistant-message-1",
      },
    });
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    expect(captureAssistantMarkdown).toHaveBeenCalledWith(
      Runtime,
      { messageId: "assistant-message-1", turnId: "assistant-turn-1" },
      expect.any(Function),
    );
    expect(finalize).toHaveBeenCalledWith(false);
  });

  test("returns the full Deep Research result while persisting exact OBU assistant affinity", async () => {
    const { connection } = createObuConnection("stored-session", 7);
    const captureAssistantMarkdown = vi.fn(async () => "short DOM stub");
    const waitForDeepResearchCompletion = vi.fn(async () => ({
      text: "Full Deep Research report body",
      html: "<article>Full Deep Research report body</article>",
      meta: { turnId: "assistant-turn-1", messageId: "assistant-message-1" },
    }));

    await expect(
      resumeBrowserSession(
        obuRuntime,
        {
          browserTransport: "obu",
          obuSessionId: "stored-session",
          obuTabId: 7,
          chatGptAccountEmail: "paul@smartypants.ai",
          chatGptWorkspaceName: "Paul Bettner",
          chatGptAccountDigest: obuAccountDigest,
          chatGptWorkspaceDigest: obuWorkspaceDigest,
          url: obuConversationUrl,
          researchMode: "deep",
          timeoutMs: 2_000,
        },
        vi.fn() as BrowserLogger,
        {
          acquireOpenBrowserUseRunLock: vi.fn(async () => ({
            path: "/tmp/oracle.lock",
            lockId: "lock-1",
            release: vi.fn(async () => {}),
          })),
          connectOpenBrowserUseTab: vi.fn(async () => connection),
          prepareOpenBrowserUseChatGptRoute: vi.fn(async () => ({
            email: "paul@smartypants.ai",
            workspaceName: "Paul Bettner",
            accountDigest: obuAccountDigest,
            workspaceDigest: obuWorkspaceDigest,
          })),
          waitForConversationHydration: vi.fn(async () => 2),
          waitForDeepResearchCompletion,
          captureAssistantMarkdown,
        },
      ),
    ).resolves.toMatchObject({
      answerText: "Full Deep Research report body",
      answerMarkdown: "Full Deep Research report body",
      runtime: {
        assistantTurnIndex: 1,
        assistantTurnId: "assistant-turn-1",
        assistantMessageId: "assistant-message-1",
      },
    });
    expect(captureAssistantMarkdown).not.toHaveBeenCalled();
  });

  test("returns the recovered affinity with redacted finalization warning details", async () => {
    const { connection } = createObuConnection("recovered-session", 8);
    const signedUrl = "https://chatgpt.com/c/recovered-thread?sig=reattach-secret#done";
    const finalize = vi.fn().mockRejectedValueOnce(
      new BrowserAutomationError(`Failed to finalize at ${signedUrl}`, {
        stage: "open-browser-use",
        code: "tab-finalize-failed",
        recoveryHandle: {
          transport: "obu",
          sessionId: "recovered-session",
          tabId: 8,
          conversationUrl: signedUrl,
        },
      }),
    );
    connection.finalize = finalize;

    const result = await resumeBrowserSession(
      obuRuntime,
      {
        browserTransport: "obu",
        obuSessionId: "stored-session",
        obuTabId: 7,
        chatGptAccountEmail: "paul@smartypants.ai",
        chatGptWorkspaceName: "Paul Bettner",
        chatGptAccountDigest: obuAccountDigest,
        chatGptWorkspaceDigest: obuWorkspaceDigest,
        url: obuConversationUrl,
        timeoutMs: 2_000,
      },
      vi.fn() as BrowserLogger,
      {
        acquireOpenBrowserUseRunLock: vi.fn(async () => ({
          path: "/tmp/oracle.lock",
          lockId: "lock-1",
          release: vi.fn(async () => {}),
        })),
        connectOpenBrowserUseTab: vi.fn(async () => connection),
        prepareOpenBrowserUseChatGptRoute: vi.fn(async () => ({
          email: "paul@smartypants.ai",
          workspaceName: "Paul Bettner",
          accountDigest: obuAccountDigest,
          workspaceDigest: obuWorkspaceDigest,
        })),
        waitForConversationHydration: vi.fn(async () => 2),
        waitForAssistantResponse: vi.fn(async () => ({
          text: "exact answer",
          html: "",
          meta: { messageId: "m1", turnId: "turn-1" },
        })),
        captureAssistantMarkdown: vi.fn(async () => "exact answer"),
      },
    );

    expect(result).toMatchObject({
      runtime: { obuSessionId: "recovered-session", obuTabId: 8 },
      warnings: [
        {
          code: "obu-tab-finalize-failed",
          message: "Failed to finalize at [redacted-url]",
          details: {
            stage: "open-browser-use",
            code: "tab-finalize-failed",
            recoveryHandle: {
              transport: "obu",
              sessionId: "recovered-session",
              tabId: 8,
              conversationUrl: "[redacted-url]",
            },
          },
        },
      ],
    });
    expect(JSON.stringify(result.warnings)).not.toContain(signedUrl);
    expect(JSON.stringify(result.warnings)).not.toContain("reattach-secret");
    expect(finalize).toHaveBeenCalledWith(false);
  });

  test("closes a recovered OBU tab when route verification fails and retains retry affinity", async () => {
    const recovered = createObuConnection("recovered-session", 8);
    const original = createObuConnection("stored-session", 7);
    const connectOpenBrowserUseTab = vi
      .fn()
      .mockResolvedValueOnce(recovered.connection)
      .mockResolvedValueOnce(original.connection);
    const prepareOpenBrowserUseChatGptRoute = vi
      .fn()
      .mockRejectedValueOnce(
        new BrowserAutomationError("ChatGPT left the stored thread.", {
          stage: "chatgpt-scope",
          code: "scope-mismatch",
        }),
      )
      .mockResolvedValueOnce({
        email: "paul@smartypants.ai",
        workspaceName: "Paul Bettner",
        accountDigest: obuAccountDigest,
        workspaceDigest: obuWorkspaceDigest,
      });
    const deps = {
      acquireOpenBrowserUseRunLock: vi.fn(async () => ({
        path: "/tmp/oracle.lock",
        lockId: "lock-1",
        release: vi.fn(async () => {}),
      })),
      connectOpenBrowserUseTab,
      prepareOpenBrowserUseChatGptRoute,
      waitForConversationHydration: vi.fn(async () => 2),
      waitForAssistantResponse: vi.fn(async () => ({
        text: "retry answer",
        html: "",
        meta: { messageId: "m2", turnId: "turn-2" },
      })),
      captureAssistantMarkdown: vi.fn(async () => "retry answer"),
    };
    const config = {
      browserTransport: "obu" as const,
      obuSessionId: "stored-session",
      obuTabId: 7,
      chatGptAccountEmail: "paul@smartypants.ai",
      chatGptWorkspaceName: "Paul Bettner",
      chatGptAccountDigest: obuAccountDigest,
      chatGptWorkspaceDigest: obuWorkspaceDigest,
      url: obuConversationUrl,
      timeoutMs: 2_000,
    };

    const firstError = await resumeBrowserSession(
      obuRuntime,
      config,
      vi.fn() as BrowserLogger,
      deps,
    ).catch((error) => error);
    expect(firstError).toMatchObject({
      details: {
        stage: "chatgpt-scope",
        runtime: {
          obuSessionId: "stored-session",
          obuTabId: 7,
          conversationId: "obu-thread",
        },
      },
    });
    expect(recovered.finalize).toHaveBeenCalledWith(false);

    await expect(
      resumeBrowserSession(obuRuntime, config, vi.fn() as BrowserLogger, deps),
    ).resolves.toMatchObject({
      runtime: { obuSessionId: "stored-session", obuTabId: 7, conversationId: "obu-thread" },
    });
    expect(original.finalize).toHaveBeenCalledWith(false);
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
