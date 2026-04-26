import { afterEach, describe, expect, test, vi } from "vitest";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";

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
  Input: Record<string, never>;
  close: () => Promise<void> | void;
};

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("continueBrowserSession via reopened Chrome", () => {
  test("reopens the stored conversation without directly navigating the hidden tab to the exact thread url", async () => {
    const projectUrl = "https://chatgpt.com/g/g-p-example-oracle/project";
    const conversationUrl = `${projectUrl}/c/right-thread`;
    const events: string[] = [];
    const launchedChrome = {
      pid: 4321,
      port: 9222,
      kill: vi.fn(async () => {}),
    };
    let currentHref = projectUrl;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: currentHref } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (expression.includes(`window.location.href = ${JSON.stringify(conversationUrl)}`)) {
        events.push("conversation-url");
        currentHref = conversationUrl;
        return { result: { value: true } };
      }
      if (
        expression.includes("const conversationId =") &&
        expression.includes(JSON.stringify("right-thread"))
      ) {
        events.push("sidebar-open");
        currentHref = conversationUrl;
        return {
          result: { value: { ok: true, href: conversationUrl, count: 1, scope: "project" } },
        };
      }
      if (expression.includes("document.querySelectorAll(")) {
        return { result: { value: 4 } };
      }
      return { result: { value: null } };
    });
    const initialClient = {
      Runtime: { enable: vi.fn(), evaluate },
      DOM: { enable: vi.fn() },
      Page: { navigate: vi.fn(async () => {}) },
      Input: {},
      close: vi.fn(async () => {}),
    } satisfies FakeClient & { Page: { navigate: (params: { url: string }) => Promise<void> } };
    const launchChrome = vi.fn(async () => launchedChrome);
    const connectWithNewTab = vi.fn(async () => ({
      client: initialClient,
      targetId: "target-1",
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/test",
    })) as unknown as (
      port: number,
      logger: BrowserLogger,
      initialUrl?: string,
      host?: string,
      options?: unknown,
    ) => Promise<{
      client: ChromeClient;
      targetId?: string;
      browserWSEndpoint?: string;
    }>;
    const hideChromeWindow = vi.fn(async () => {});
    const navigateToChatGPT = vi.fn(async (_page, _runtime, url: string) => {
      if (url === conversationUrl) {
        throw new Error("direct conversation navigation should not run in the reopened hidden tab");
      }
      events.push(`navigate:${url}`);
      currentHref = url;
    });
    const ensureNotBlocked = vi.fn(async () => {});
    const ensureLoggedIn = vi.fn(async () => {});
    const ensurePromptReady = vi.fn(async () => {
      events.push("prompt-ready");
    });
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "PONG",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "PONG");

    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return { ...original, launchChrome, connectWithNewTab, hideChromeWindow };
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

    const result = await continueBrowserSession(
      {
        tabUrl: conversationUrl,
        conversationId: "right-thread",
      },
      {
        timeoutMs: 2_000,
        inputTimeoutMs: 1_000,
        modelStrategy: "ignore",
        cookieSync: false,
        url: projectUrl,
      },
      logger,
      { prompt: "Reply with exactly PONG." },
      {
        waitForAssistantResponse,
        captureAssistantMarkdown,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
      },
    );

    expect(result.answerMarkdown).toBe("PONG");
    expect(navigateToChatGPT.mock.calls.map((call) => call[2])).toEqual([
      "https://chatgpt.com/",
      projectUrl,
    ]);
    expect(
      evaluate.mock.calls.some(
        (call) =>
          String(call[0]?.expression ?? "").includes(
            `window.location.href = ${JSON.stringify(conversationUrl)}`,
          ) ||
          (String(call[0]?.expression ?? "").includes("const conversationId =") &&
            String(call[0]?.expression ?? "").includes(JSON.stringify("right-thread"))),
      ),
    ).toBe(true);
    expect(events.indexOf("prompt-ready")).toBeGreaterThan(events.indexOf("conversation-url"));
  });

  test("resumes a project-scoped reusable conversation before waiting for prompt readiness", async () => {
    const projectUrl = "https://chatgpt.com/g/g-p-example-oracle/project";
    const conversationUrl = `${projectUrl}/c/right-thread`;
    const events: string[] = [];
    const launchedChrome = {
      pid: 4321,
      port: 9222,
      kill: vi.fn(async () => {}),
    };
    let currentHref = projectUrl;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: currentHref } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (expression.includes(`window.location.href = ${JSON.stringify(conversationUrl)}`)) {
        events.push("conversation-url");
        currentHref = conversationUrl;
        return { result: { value: true } };
      }
      if (
        expression.includes("const conversationId =") &&
        expression.includes(JSON.stringify("right-thread"))
      ) {
        events.push("sidebar-open");
        currentHref = conversationUrl;
        return {
          result: { value: { ok: true, href: conversationUrl, count: 1, scope: "project" } },
        };
      }
      if (expression.includes("document.querySelectorAll(")) {
        return { result: { value: 4 } };
      }
      return { result: { value: null } };
    });
    const initialClient = {
      Runtime: { enable: vi.fn(), evaluate },
      DOM: { enable: vi.fn() },
      Page: { navigate: vi.fn(async () => {}) },
      Input: {},
      close: vi.fn(async () => {}),
    } satisfies FakeClient & { Page: { navigate: (params: { url: string }) => Promise<void> } };
    const launchChrome = vi.fn(async () => launchedChrome);
    const connectWithNewTab = vi.fn(async () => ({
      client: initialClient,
      targetId: "target-1",
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/test",
    })) as unknown as (
      port: number,
      logger: BrowserLogger,
      initialUrl?: string,
      host?: string,
      options?: unknown,
    ) => Promise<{
      client: ChromeClient;
      targetId?: string;
      browserWSEndpoint?: string;
    }>;
    const hideChromeWindow = vi.fn(async () => {});
    const navigateToChatGPT = vi.fn(async (_page, _runtime, url: string) => {
      events.push(`navigate:${url}`);
      currentHref = url;
    });
    const ensureNotBlocked = vi.fn(async () => {});
    const ensureLoggedIn = vi.fn(async () => {});
    const ensurePromptReady = vi.fn(async () => {
      events.push("prompt-ready");
    });
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "PONG",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "PONG");

    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return { ...original, launchChrome, connectWithNewTab, hideChromeWindow };
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

    const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(
      {
        tabUrl: conversationUrl,
        conversationId: "right-thread",
      },
      {
        timeoutMs: 2_000,
        inputTimeoutMs: 1_000,
        cookieSync: false,
        url: projectUrl,
      },
      logger,
      {
        waitForAssistantResponse,
        captureAssistantMarkdown,
        ensurePromptReady,
      },
    );

    expect(result.answerMarkdown).toBe("PONG");
    expect(events.indexOf("prompt-ready")).toBeGreaterThan(events.indexOf("conversation-url"));
  });

  test("resumes without resending when observation fails after send", async () => {
    const launchedChrome = {
      pid: 4321,
      port: 9222,
      kill: vi.fn(async () => {}),
    };
    const initialEvaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: "https://chatgpt.com/c/abc" } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const initialClient = {
      Runtime: { enable: vi.fn(), evaluate: initialEvaluate },
      DOM: { enable: vi.fn() },
      Input: {},
      close: vi.fn(async () => {}),
    } satisfies FakeClient;
    const launchChrome = vi.fn(async () => launchedChrome);
    const connectWithNewTab = vi.fn(async () => ({
      client: initialClient,
      targetId: "target-1",
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/test",
    })) as unknown as (
      port: number,
      logger: BrowserLogger,
      initialUrl?: string,
      host?: string,
      options?: unknown,
    ) => Promise<{
      client: ChromeClient;
      targetId?: string;
      browserWSEndpoint?: string;
    }>;
    const hideChromeWindow = vi.fn(async () => {});
    const navigateToChatGPT = vi.fn(async () => {});
    const ensureNotBlocked = vi.fn(async () => {});
    const ensureLoggedIn = vi.fn(async () => {});
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);

    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return { ...original, launchChrome, connectWithNewTab, hideChromeWindow };
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
    const resumeEvaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: "https://chatgpt.com/c/abc" } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const resumeConnect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate: resumeEvaluate },
          DOM: { enable: vi.fn() },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce({
        text: "supervisor response",
        html: "",
        meta: { messageId: "m2", turnId: "conversation-turn-2" },
      });
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const listTargets = vi.fn(async () => [
      { targetId: "target-1", type: "page", url: "https://chatgpt.com/c/abc" },
    ]);
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      {
        tabUrl: "https://chatgpt.com/c/abc",
        conversationId: "abc",
      },
      { timeoutMs: 2_000, inputTimeoutMs: 1_000, modelStrategy: "ignore" },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect: resumeConnect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
      },
    );

    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(waitForAssistantResponse).toHaveBeenCalledTimes(2);
    expect(launchChrome).toHaveBeenCalledTimes(1);
    expect(connectWithNewTab).toHaveBeenCalledTimes(1);
    expect(resumeConnect).toHaveBeenCalledTimes(1);
    expect(launchedChrome.kill).toHaveBeenCalledTimes(1);
    expect(result.answerMarkdown).toBe("supervisor markdown");
  });
});
