import { afterEach, describe, expect, test, vi } from "vitest";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";

type FakeClient = {
  Runtime: {
    enable: () => void;
    evaluate: (params: { expression: string; returnByValue?: boolean }) => Promise<{
      result: { value: unknown };
    }>;
  };
  DOM: { enable: () => void };
  Input: Record<string, never>;
  close: () => Promise<void> | void;
};

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("continueBrowserSession manual-login reuse", () => {
  test("reuses an existing manual-login Chrome instead of launching a second profile owner", async () => {
    const reusedChrome = {
      pid: 4321,
      port: 9333,
      kill: vi.fn(async () => {}),
    };
    const makeClient = async () => {
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "location.href") {
          return { result: { value: "https://chatgpt.com/c/abc" } };
        }
        if (expression === "1+1") {
          return { result: { value: 2 } };
        }
        return { result: { value: null } };
      });
      return {
        Runtime: { enable: vi.fn(), evaluate },
        DOM: { enable: vi.fn() },
        Input: {},
        close: vi.fn(async () => {}),
      } satisfies FakeClient;
    };
    const connectToChrome = vi.fn(makeClient) as unknown as (
      port: number,
      logger: BrowserLogger,
      host?: string,
    ) => Promise<ChromeClient>;
    const connectWithNewTab = vi.fn(async () => ({
      client: (await makeClient()) as unknown as ChromeClient,
      targetId: "isolated-target-1",
    }));
    const closeTab = vi.fn(async () => {});
    const launchChrome = vi.fn(async () => {
      throw new Error("launchChrome should not be called");
    });
    const hideChromeWindow = vi.fn(async (..._args: unknown[]) => {});
    const startChromeFocusGuard = vi.fn(() => vi.fn());
    const finalizeChromeFocusProtection = vi.fn(async (chrome, loggerArg, stop, restoreTarget) => {
      await hideChromeWindow(chrome as never, loggerArg as never, restoreTarget as never);
      stop?.();
    });
    const frontmostTarget = { name: "Terminal", pid: 91 };
    const captureFrontmostProcess = vi.fn(async () => frontmostTarget);
    const navigateToChatGPT = vi.fn(async () => {});
    const ensureNotBlocked = vi.fn(async () => {});
    const ensureLoggedIn = vi.fn(async () => {});
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "supervisor response",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");

    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return {
        ...original,
        closeTab,
        connectToChrome,
        connectWithNewTab,
        launchChrome,
        hideChromeWindow,
        startChromeFocusGuard,
        finalizeChromeFocusProtection,
        captureFrontmostProcess,
      };
    });
    vi.doMock("../../src/browser/index.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/index.js")>(
        "../../src/browser/index.js",
      );
      return { ...original, maybeReuseRunningChrome: vi.fn(async () => reusedChrome) };
    });
    vi.doMock("../../src/browser/pageActions.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/pageActions.js")>(
        "../../src/browser/pageActions.js",
      );
      return {
        ...original,
        navigateToChatGPT,
        ensureNotBlocked,
        ensureLoggedIn,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
      };
    });

    const { continueBrowserSession } = await import("../../src/browser/reattach.js");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      {
        tabUrl: "https://chatgpt.com/c/abc",
        conversationId: "abc",
      },
      {
        timeoutMs: 2_000,
        inputTimeoutMs: 1_000,
        modelStrategy: "ignore",
        manualLogin: true,
        manualLoginProfileDir: "/tmp/oracle-browser-profile",
        hideWindow: true,
      },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        waitForAssistantResponse,
        captureAssistantMarkdown,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
      },
    );

    expect(connectWithNewTab).toHaveBeenCalledWith(9333, logger, undefined, "127.0.0.1", {
      fallbackToDefault: false,
      hiddenTarget: true,
      retries: 3,
      retryDelayMs: 500,
    });
    expect(connectToChrome).not.toHaveBeenCalled();
    expect(closeTab).toHaveBeenCalledWith(9333, "isolated-target-1", logger, "127.0.0.1");
    expect(launchChrome).not.toHaveBeenCalled();
    expect(captureFrontmostProcess).toHaveBeenCalledWith(logger);
    expect(hideChromeWindow).toHaveBeenNthCalledWith(1, reusedChrome, logger, frontmostTarget);
    expect(hideChromeWindow).toHaveBeenNthCalledWith(2, reusedChrome, logger, frontmostTarget);
    expect(startChromeFocusGuard).toHaveBeenCalledWith(reusedChrome, logger, frontmostTarget);
    expect(hideChromeWindow.mock.invocationCallOrder[0]).toBeLessThan(
      connectWithNewTab.mock.invocationCallOrder[0],
    );
    expect(result.answerMarkdown).toBe("supervisor markdown");
  });

  test.each([
    {
      label: "ChatGPT home page",
      url: "https://chatgpt.com/",
    },
    {
      label: "project root",
      url: "https://chatgpt.com/g/g-p-69ccbf70cff08191bd2a7e61d8962644/project",
    },
  ])(
    "treats a fresh $label as valid current context for the first follow-up prompt",
    async ({ url }) => {
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "location.href") {
          return { result: { value: url } };
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
            Input: {},
            close: vi.fn(async () => {}),
          }) satisfies FakeClient,
      ) as unknown as (options?: unknown) => Promise<ChromeClient>;
      const listTargets = vi.fn(async () => [{ targetId: "isolated-target-1", type: "page", url }]);
      const openConversationFromSidebarWithRetry = vi.fn(async () => {
        throw new Error("sidebar reopen should not run for a fresh chat home page");
      });
      const readConversationTurnIndex = vi.fn(async () => 0);
      const ensurePromptReady = vi.fn(async () => {});
      const clearPromptComposer = vi.fn(async () => {});
      const submitPrompt = vi.fn(async () => 1);
      const waitForAssistantResponse = vi.fn(async () => ({
        text: "hello",
        html: "",
        meta: { messageId: "m3", turnId: "conversation-turn-3" },
      }));
      const captureAssistantMarkdown = vi.fn(async () => "hello");

      vi.doMock("../../src/browser/reattachHelpers.js", async () => {
        const original = await vi.importActual<
          typeof import("../../src/browser/reattachHelpers.js")
        >("../../src/browser/reattachHelpers.js");
        return {
          ...original,
          openConversationFromSidebarWithRetry,
          readConversationTurnIndex,
        };
      });

      const { continueBrowserSession } = await import("../../src/browser/reattach.js");
      const logger = vi.fn() as BrowserLogger;

      const result = await continueBrowserSession(
        {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeTargetId: "target-root",
          tabUrl: url,
        },
        { timeoutMs: 2_000, inputTimeoutMs: 1_000, modelStrategy: "ignore" },
        logger,
        { prompt: "Say hi." },
        {
          listTargets: listTargets as unknown as () => Promise<
            { targetId?: string; type?: string; url?: string }[]
          >,
          connect,
          ensurePromptReady,
          clearPromptComposer,
          submitPrompt,
          waitForAssistantResponse,
          captureAssistantMarkdown,
        },
      );

      expect(openConversationFromSidebarWithRetry).not.toHaveBeenCalled();
      expect(submitPrompt).toHaveBeenCalledTimes(1);
      expect(waitForAssistantResponse).toHaveBeenCalledWith(expect.anything(), 2_000, logger, 1);
      expect(captureAssistantMarkdown).toHaveBeenCalledWith(
        expect.anything(),
        { messageId: "m3", turnId: "conversation-turn-3" },
        logger,
        1,
      );
      expect(result.answerMarkdown).toBe("hello");
    },
  );

  test("emits follow-up milestones and refreshes runtime identity after rebinding an existing thread", async () => {
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: "https://chatgpt.com/c/abc" } };
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
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const listTargets = vi.fn(async () => [
      { targetId: "fresh-target", type: "page", url: "https://chatgpt.com/c/abc" },
    ]);
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 1);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "hello",
      html: "",
      meta: { messageId: "m3", turnId: "conversation-turn-3" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "hello");

    const { continueBrowserSession } = await import("../../src/browser/reattach.js");
    const logger = vi.fn() as BrowserLogger;
    const progressSpy = vi.fn();
    const sessionLogSpy = vi.fn();
    logger.progress = progressSpy;
    logger.sessionLog = sessionLogSpy;

    const result = await continueBrowserSession(
      {
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeTargetId: "stale-target",
        tabUrl: "https://chatgpt.com/c/abc",
        conversationId: "abc",
      },
      { timeoutMs: 2_000, inputTimeoutMs: 1_000, modelStrategy: "ignore" },
      logger,
      { prompt: "Say hi." },
      {
        listTargets: listTargets as unknown as () => Promise<
          { targetId?: string; type?: string; url?: string }[]
        >,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    const stages = progressSpy.mock.calls.map((call) => call[0]?.stage);
    expect(stages).toContain("thread-bound");
    expect(stages).toContain("prompt-committed");
    expect(stages).toContain("assistant-generating");
    expect(stages).toContain("assistant-completed");
    expect(progressSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "thread-bound",
        runtime: expect.objectContaining({
          chromeTargetId: "fresh-target",
          tabUrl: "https://chatgpt.com/c/abc",
          conversationId: "abc",
        }),
      }),
    );
    expect(sessionLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("[browser-progress:prompt-committed]"),
    );
    expect(result.runtime).toMatchObject({
      chromeTargetId: "fresh-target",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
    });
  });

  test("treats a fresh chat home page as valid current context when resuming through reopened manual-login chrome", async () => {
    const reusedChrome = {
      pid: 4321,
      port: 9333,
      kill: vi.fn(async () => {}),
    };
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: "https://chatgpt.com/" } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connectToChrome = vi.fn(async () => {
      throw new Error("connectToChrome should not be called");
    }) as unknown as (port: number, logger: BrowserLogger, host?: string) => Promise<ChromeClient>;
    const connectWithNewTab = vi.fn(async () => {
      const client = {
        Runtime: { enable: vi.fn(), evaluate },
        DOM: { enable: vi.fn() },
        Input: {},
        close: vi.fn(async () => {}),
      } satisfies FakeClient;
      return {
        client: client as unknown as ChromeClient,
        targetId: "isolated-target-1",
      };
    });
    const closeTab = vi.fn(async () => {});
    const launchChrome = vi.fn(async () => {
      throw new Error("launchChrome should not be called");
    });
    const hideChromeWindow = vi.fn(async (..._args: unknown[]) => {});
    const startChromeFocusGuard = vi.fn(() => vi.fn());
    const finalizeChromeFocusProtection = vi.fn(async (chrome, loggerArg, stop, restoreTarget) => {
      await hideChromeWindow(chrome as never, loggerArg as never, restoreTarget as never);
      stop?.();
    });
    const frontmostTarget = { name: "Terminal", pid: 91 };
    const captureFrontmostProcess = vi.fn(async () => frontmostTarget);
    const navigateToChatGPT = vi.fn(async () => {});
    const ensureNotBlocked = vi.fn(async () => {});
    const ensureLoggedIn = vi.fn(async () => {});
    const ensurePromptReady = vi.fn(async () => {});
    const openConversationFromSidebarWithRetry = vi.fn(async () => {
      throw new Error("sidebar reopen should not run for a fresh chat home page");
    });
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "hello again",
      html: "",
      meta: { messageId: "m4", turnId: "conversation-turn-4" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "hello again");

    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return {
        ...original,
        closeTab,
        connectToChrome,
        connectWithNewTab,
        launchChrome,
        hideChromeWindow,
        startChromeFocusGuard,
        finalizeChromeFocusProtection,
        captureFrontmostProcess,
      };
    });
    vi.doMock("../../src/browser/index.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/index.js")>(
        "../../src/browser/index.js",
      );
      return { ...original, maybeReuseRunningChrome: vi.fn(async () => reusedChrome) };
    });
    vi.doMock("../../src/browser/pageActions.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/pageActions.js")>(
        "../../src/browser/pageActions.js",
      );
      return {
        ...original,
        navigateToChatGPT,
        ensureNotBlocked,
        ensureLoggedIn,
        ensurePromptReady,
      };
    });
    vi.doMock("../../src/browser/reattachHelpers.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/reattachHelpers.js")>(
        "../../src/browser/reattachHelpers.js",
      );
      return {
        ...original,
        openConversationFromSidebarWithRetry,
      };
    });

    const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(
      {
        tabUrl: "https://chatgpt.com/",
      },
      {
        timeoutMs: 2_000,
        inputTimeoutMs: 1_000,
        modelStrategy: "ignore",
        manualLogin: true,
        manualLoginProfileDir: "/tmp/oracle-browser-profile",
        hideWindow: true,
      },
      logger,
      {
        waitForAssistantResponse,
        captureAssistantMarkdown,
        baselineTurns: 4,
      },
    );

    expect(connectWithNewTab).toHaveBeenCalledWith(9333, logger, undefined, "127.0.0.1", {
      fallbackToDefault: false,
      hiddenTarget: true,
      retries: 3,
      retryDelayMs: 500,
    });
    expect(openConversationFromSidebarWithRetry).not.toHaveBeenCalled();
    expect(closeTab).toHaveBeenCalledWith(9333, "isolated-target-1", logger, "127.0.0.1");
    expect(captureFrontmostProcess).toHaveBeenCalledWith(logger);
    expect(hideChromeWindow).toHaveBeenNthCalledWith(1, reusedChrome, logger, frontmostTarget);
    expect(hideChromeWindow).toHaveBeenNthCalledWith(2, reusedChrome, logger, frontmostTarget);
    expect(waitForAssistantResponse).toHaveBeenCalledWith(expect.anything(), 2_000, logger, 4);
    expect(captureAssistantMarkdown).toHaveBeenCalledWith(
      expect.anything(),
      { messageId: "m4", turnId: "conversation-turn-4" },
      logger,
      4,
    );
    expect(result.answerMarkdown).toBe("hello again");
  });

  test("preserves submitted baseline turns when a reused manual-login Chrome reconnects after send", async () => {
    const reusedChrome = {
      pid: 4321,
      port: 9333,
      kill: vi.fn(async () => {}),
    };
    const firstEvaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: "https://chatgpt.com/" } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const resumedEvaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: "https://chatgpt.com/" } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate: resumedEvaluate },
          DOM: { enable: vi.fn() },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const listTargets = vi.fn(async () => [
      { targetId: "isolated-target-1", type: "page", url: "https://chatgpt.com/" },
    ]);
    const connectToChrome = vi.fn(async () => {
      throw new Error("connectToChrome should not be called");
    }) as unknown as (port: number, logger: BrowserLogger, host?: string) => Promise<ChromeClient>;
    const connectWithNewTab = vi.fn(async () => {
      const client = {
        Runtime: { enable: vi.fn(), evaluate: firstEvaluate },
        DOM: { enable: vi.fn() },
        Input: {},
        close: vi.fn(async () => {}),
      } satisfies FakeClient;
      return {
        client: client as unknown as ChromeClient,
        targetId: "isolated-target-1",
      };
    });
    const closeTab = vi.fn(async () => {});
    const launchChrome = vi.fn(async () => {
      throw new Error("launchChrome should not be called");
    });
    const hideChromeWindow = vi.fn(async (..._args: unknown[]) => {});
    const startChromeFocusGuard = vi.fn(() => vi.fn());
    const finalizeChromeFocusProtection = vi.fn(async (chrome, loggerArg, stop, restoreTarget) => {
      await hideChromeWindow(chrome as never, loggerArg as never, restoreTarget as never);
      stop?.();
    });
    const frontmostTarget = { name: "Terminal", pid: 91 };
    const captureFrontmostProcess = vi.fn(async () => frontmostTarget);
    const navigateToChatGPT = vi.fn(async () => {});
    const ensureNotBlocked = vi.fn(async () => {});
    const ensureLoggedIn = vi.fn(async () => {});
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 1);
    const waitForAssistantResponse = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce({
        text: "hello after reconnect",
        html: "",
        meta: { messageId: "m5", turnId: "conversation-turn-5" },
      });
    const captureAssistantMarkdown = vi.fn(async () => "hello after reconnect");
    const openConversationFromSidebarWithRetry = vi.fn(async () => {
      throw new Error("sidebar reopen should not run for a fresh chat home page");
    });
    const readConversationTurnIndex = vi.fn(async () => 0);

    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return {
        ...original,
        closeTab,
        connectToChrome,
        connectWithNewTab,
        launchChrome,
        hideChromeWindow,
        startChromeFocusGuard,
        finalizeChromeFocusProtection,
        captureFrontmostProcess,
      };
    });
    vi.doMock("../../src/browser/index.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/index.js")>(
        "../../src/browser/index.js",
      );
      return { ...original, maybeReuseRunningChrome: vi.fn(async () => reusedChrome) };
    });
    vi.doMock("../../src/browser/pageActions.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/pageActions.js")>(
        "../../src/browser/pageActions.js",
      );
      return {
        ...original,
        navigateToChatGPT,
        ensureNotBlocked,
        ensureLoggedIn,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
      };
    });
    vi.doMock("../../src/browser/detect.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/detect.js")>(
        "../../src/browser/detect.js",
      );
      return {
        ...original,
        readDevToolsActivePortInfo: vi.fn(async () => ({
          port: 9333,
          browserWSEndpoint: "ws://127.0.0.1:9333/devtools/browser/browser-1",
          path: "/tmp/oracle-browser-profile/DevToolsActivePort",
        })),
      };
    });
    vi.doMock("../../src/browser/reattachHelpers.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/reattachHelpers.js")>(
        "../../src/browser/reattachHelpers.js",
      );
      return {
        ...original,
        openConversationFromSidebarWithRetry,
        readConversationTurnIndex,
      };
    });

    const { continueBrowserSession } = await import("../../src/browser/reattach.js");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      {
        tabUrl: "https://chatgpt.com/",
      },
      {
        timeoutMs: 2_000,
        inputTimeoutMs: 1_000,
        modelStrategy: "ignore",
        manualLogin: true,
        manualLoginProfileDir: "/tmp/oracle-browser-profile",
        hideWindow: true,
      },
      logger,
      { prompt: "Say hi after reconnect." },
      {
        connect,
        listTargets: listTargets as unknown as () => Promise<
          { targetId?: string; type?: string; url?: string }[]
        >,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(connectWithNewTab).toHaveBeenCalledWith(9333, logger, undefined, "127.0.0.1", {
      fallbackToDefault: false,
      hiddenTarget: true,
      retries: 3,
      retryDelayMs: 500,
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({
      target: "ws://127.0.0.1:9333/devtools/browser/browser-1",
      local: true,
      targetId: "isolated-target-1",
    });
    expect(openConversationFromSidebarWithRetry).not.toHaveBeenCalled();
    expect(waitForAssistantResponse).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      2_000,
      logger,
      1,
    );
    expect(waitForAssistantResponse).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      2_000,
      logger,
      1,
    );
    expect(captureAssistantMarkdown).toHaveBeenLastCalledWith(
      expect.anything(),
      { messageId: "m5", turnId: "conversation-turn-5" },
      logger,
      1,
    );
    expect(result.answerMarkdown).toBe("hello after reconnect");
  });

  test("fails closed instead of relaunching a fresh hidden browser when the managed profile is not reusable", async () => {
    const launchChrome = vi.fn(async () => {
      throw new Error("launchChrome should not be called");
    });

    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return {
        ...original,
        launchChrome,
      };
    });
    vi.doMock("../../src/browser/detect.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/detect.js")>(
        "../../src/browser/detect.js",
      );
      return {
        ...original,
        readDevToolsActivePortInfo: vi.fn(async () => null),
      };
    });
    vi.doMock("../../src/browser/profileState.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/profileState.js")>(
        "../../src/browser/profileState.js",
      );
      return {
        ...original,
        readChromePid: vi.fn(async () => null),
        resolveChromePidForUserDataDir: vi.fn(async () => null),
      };
    });

    const { resumeBrowserSession, continueBrowserSession } =
      await import("../../src/browser/reattach.js");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    await expect(
      resumeBrowserSession(
        {
          chromeHost: "127.0.0.1",
          chromePort: 9333,
          chromeBrowserWSEndpoint: "ws://127.0.0.1:9333/devtools/browser/browser-1",
          chromeTargetId: "cached-target",
          tabUrl: "https://chatgpt.com/g/team-space-oracle/c/thread-1",
          conversationId: "thread-1",
          userDataDir: "/tmp/oracle-browser-profile-hidden",
        },
        {
          timeoutMs: 2_000,
          modelStrategy: "ignore",
          keepBrowser: true,
          manualLogin: true,
          manualLoginProfileDir: "/tmp/oracle-browser-profile-hidden",
          hideWindow: true,
        },
        logger,
        {},
      ),
    ).rejects.toThrow(/Refusing to relaunch the Oracle hidden browser/i);

    expect(launchChrome).not.toHaveBeenCalled();

    await expect(
      continueBrowserSession(
        {
          chromeHost: "127.0.0.1",
          chromePort: 9333,
          chromeBrowserWSEndpoint: "ws://127.0.0.1:9333/devtools/browser/browser-1",
          chromeTargetId: "cached-target",
          tabUrl: "https://chatgpt.com/g/team-space-oracle/c/thread-1",
          conversationId: "thread-1",
          userDataDir: "/tmp/oracle-browser-profile-hidden",
        },
        {
          timeoutMs: 2_000,
          modelStrategy: "ignore",
          keepBrowser: true,
          manualLogin: true,
          manualLoginProfileDir: "/tmp/oracle-browser-profile-hidden",
          hideWindow: true,
        },
        logger,
        {
          prompt: "hello again",
          attachments: [],
        },
        {},
      ),
    ).rejects.toThrow(/Refusing to relaunch the Oracle hidden browser/i);

    expect(launchChrome).not.toHaveBeenCalled();
  });
});
