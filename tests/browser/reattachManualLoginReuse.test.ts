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
    const hideChromeWindow = vi.fn(async () => {});
    const startChromeFocusGuard = vi.fn(() => vi.fn());
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
      retries: 3,
      retryDelayMs: 500,
    });
    expect(connectToChrome).not.toHaveBeenCalled();
    expect(closeTab).toHaveBeenCalledWith(9333, "isolated-target-1", logger, "127.0.0.1");
    expect(launchChrome).not.toHaveBeenCalled();
    expect(captureFrontmostProcess).toHaveBeenCalledWith(logger);
    expect(hideChromeWindow).toHaveBeenNthCalledWith(1, reusedChrome, logger, frontmostTarget);
    expect(hideChromeWindow).toHaveBeenNthCalledWith(2, reusedChrome, logger);
    expect(startChromeFocusGuard).toHaveBeenCalledWith(reusedChrome, logger, frontmostTarget);
    expect(hideChromeWindow.mock.invocationCallOrder[0]).toBeLessThan(
      connectWithNewTab.mock.invocationCallOrder[0],
    );
    expect(result.answerMarkdown).toBe("supervisor markdown");
  });

  test("treats a fresh chat home page as valid current context for the first follow-up prompt", async () => {
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
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
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const listTargets = vi.fn(async () => [
      { targetId: "target-root", type: "page", url: "https://chatgpt.com/" },
    ]);
    const openConversationFromSidebarWithRetry = vi.fn(async () => {
      throw new Error("sidebar reopen should not run for a fresh chat home page");
    });
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
      const original = await vi.importActual<typeof import("../../src/browser/reattachHelpers.js")>(
        "../../src/browser/reattachHelpers.js",
      );
      return {
        ...original,
        openConversationFromSidebarWithRetry,
      };
    });

    const { continueBrowserSession } = await import("../../src/browser/reattach.js");
    const logger = vi.fn() as BrowserLogger;

    const result = await continueBrowserSession(
      {
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeTargetId: "target-root",
        tabUrl: "https://chatgpt.com/",
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
    expect(result.answerMarkdown).toBe("hello");
  });
});
