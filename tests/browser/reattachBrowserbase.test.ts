import { afterEach, describe, expect, test, vi } from "vitest";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";

afterEach(() => {
  vi.doUnmock("../../src/browser/chromeLifecycle.js");
  vi.doUnmock("../../src/browser/browserbase.js");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("Browserbase reattach recovery", () => {
  test("resumeBrowserSession refuses to recover by launching local Chrome", async () => {
    const { resumeBrowserSession, launchChrome } = await loadReattachWithLaunchGuard();
    const logger = vi.fn() as BrowserLogger;
    const runtime: BrowserRuntimeMetadata = {
      browserProvider: "browserbase",
      browserbaseSessionId: "bb-session-1",
      browserbaseKeepAlive: false,
      tabUrl: "https://chatgpt.com/c/browserbase-thread",
      conversationId: "browserbase-thread",
    };

    await expect(resumeBrowserSession(runtime, {}, logger)).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: expect.objectContaining({ stage: "browserbase-reattach-unavailable" }),
    });
    expect(launchChrome).not.toHaveBeenCalled();
  });

  test("continueBrowserSession refuses to recover by launching local Chrome", async () => {
    const { continueBrowserSession, launchChrome } = await loadReattachWithLaunchGuard();
    const logger = vi.fn() as BrowserLogger;
    const runtime: BrowserRuntimeMetadata = {
      browserProvider: "browserbase",
      browserbaseSessionId: "bb-session-1",
      browserbaseKeepAlive: false,
      tabUrl: "https://chatgpt.com/c/browserbase-thread",
      conversationId: "browserbase-thread",
    };

    await expect(
      continueBrowserSession(runtime, {}, logger, { prompt: "continue" }),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: expect.objectContaining({ stage: "browserbase-reattach-unavailable" }),
    });
    expect(launchChrome).not.toHaveBeenCalled();
  });

  test("continueBrowserSession refreshes redacted kept-alive Browserbase connectUrl", async () => {
    const refreshedConnectUrl =
      "wss://user:fresh-token@connect.browserbase.com/devtools/browser/bb-session-1";
    const { continueBrowserSession, launchChrome, getSession, createSession } =
      await loadReattachWithLaunchGuard({
        browserbaseSession: {
          id: "bb-session-1",
          projectId: "bb-project-1",
          contextId: "bb-context-1",
          connectUrl: refreshedConnectUrl,
        },
      });
    const runtime: BrowserRuntimeMetadata = {
      browserProvider: "browserbase",
      browserbaseSessionId: "bb-session-1",
      browserbaseProjectId: "bb-project-1",
      browserbaseContextId: "bb-context-1",
      browserbaseKeepAlive: true,
      chromeBrowserWSEndpoint:
        "wss://user:%5Bredacted%5D@connect.browserbase.com/devtools/browser/bb-session-1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/browserbase-thread",
      conversationId: "browserbase-thread",
    };
    const listTargets = vi.fn(async () => [
      {
        targetId: "target-1",
        type: "page",
        url: "https://chatgpt.com/c/browserbase-thread",
      },
    ]);
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
          Input: {},
          close: vi.fn(async () => {}),
        }) as unknown as ChromeClient,
    );
    const logger = vi.fn() as BrowserLogger;

    const result = await continueBrowserSession(
      runtime,
      {
        timeoutMs: 2_000,
        inputTimeoutMs: 1_000,
        manualLogin: true,
        keepBrowser: true,
        hideWindow: true,
        browserbase: {
          enabled: true,
          apiKey: "bb-test-key",
          projectId: "bb-project-1",
          contextId: "bb-context-1",
          keepAlive: true,
        },
      },
      logger,
      { prompt: "continue" },
      {
        listTargets,
        connect,
        ensurePromptReady: vi.fn(async () => {}),
        clearPromptComposer: vi.fn(async () => {}),
        submitPrompt: vi.fn(async () => 2),
        waitForAssistantResponse: vi.fn(async () => ({
          text: "browserbase response",
          html: "",
          meta: { messageId: "msg-2", turnId: "turn-2" },
        })),
        captureAssistantMarkdown: vi.fn(async () => "browserbase markdown"),
      },
    );

    expect(result.answerMarkdown).toBe("browserbase markdown");
    expect(getSession).toHaveBeenCalledWith("bb-session-1");
    expect(createSession).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        target: refreshedConnectUrl,
        local: true,
      }),
    );
    expect(launchChrome).not.toHaveBeenCalled();
  });
});

async function loadReattachWithLaunchGuard(options?: {
  browserbaseSession?: {
    id: string;
    projectId?: string;
    contextId?: string;
    connectUrl?: string;
  };
}) {
  const launchChrome = vi.fn(async () => {
    throw new Error("local Chrome launched");
  });
  const createSession = vi.fn(async () => {
    throw new Error("created new Browserbase session");
  });
  const getSession = vi.fn(async () => options?.browserbaseSession);
  vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
    const original = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
      "../../src/browser/chromeLifecycle.js",
    );
    return {
      ...original,
      launchChrome,
    };
  });
  vi.doMock("../../src/browser/browserbase.js", async () => {
    const original = await vi.importActual<typeof import("../../src/browser/browserbase.js")>(
      "../../src/browser/browserbase.js",
    );
    return {
      ...original,
      BrowserbaseClient: vi.fn().mockImplementation(function BrowserbaseClient() {
        return {
          createSession,
          getSession,
        };
      }),
    };
  });
  const reattach = await import("../../src/browser/reattach.js");
  return { ...reattach, launchChrome, createSession, getSession };
}
