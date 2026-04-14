import { afterEach, describe, expect, test, vi } from "vitest";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import {
  continueBrowserSession,
  resumeBrowserSession,
  __test__,
} from "../../src/browser/reattach.js";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";

type FakeTarget = { targetId?: string; type?: string; url?: string };
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
  Target?: {
    getTargetInfo?: () => Promise<{
      targetInfo?: { targetId?: string; type?: string; url?: string };
    }>;
  };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Page?: { navigate: (params: { url: string }) => Promise<void> | void };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Input: Record<string, never>;
  close: () => Promise<void> | void;
};

const isTurnCountProbe = (expression: string) =>
  expression.includes("document.querySelectorAll(") ||
  expression.includes("__oracleCollectThreadEntries");

afterEach(() => {
  vi.doUnmock("../../src/browser/chromeLifecycle.js");
  vi.resetModules();
  vi.restoreAllMocks();
});

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
      if (isTurnCountProbe(expression)) {
        return { result: { value: 7 } };
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
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "Hello PATH plan",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "markdown response");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
    });

    expect(result.answerMarkdown).toBe("markdown response");
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 51559, target: "target-1" }),
    );
    expect(waitForAssistantResponse).toHaveBeenCalled();
    expect(captureAssistantMarkdown).toHaveBeenCalled();
  });

  test("reopens the cached conversation from the project shell via sidebar recovery", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/g/g-p-example/project/c/abc",
      conversationId: "abc",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    let currentHref = "https://chatgpt.com/g/g-p-example/project";
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: currentHref } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      const navigateMatch = expression.match(/^window\.location\.href = ("[^"]+")$/);
      if (navigateMatch) {
        currentHref = JSON.parse(navigateMatch[1] ?? '""');
        return { result: { value: true } };
      }
      if (
        expression.includes("const conversationId =") &&
        expression.includes(JSON.stringify(runtime.conversationId))
      ) {
        currentHref = runtime.tabUrl;
        return {
          result: { value: { ok: true, href: runtime.tabUrl, count: 1, scope: "project" } },
        };
      }
      if (isTurnCountProbe(expression)) {
        return { result: { value: 7 } };
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
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached after direct navigation",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "direct-nav-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, { timeoutMs: 2_000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
    });

    expect(result.answerMarkdown).toBe("direct-nav-md");
    expect(currentHref).toBe(runtime.tabUrl);
    expect(
      evaluate.mock.calls.some((call) =>
        String(call[0]?.expression ?? "").includes("const conversationId ="),
      ),
    ).toBe(true);
  });

  test("jumps straight to the stored oracle conversation when reattach starts on the wrong project thread", async () => {
    const projectUrl = "https://chatgpt.com/g/g-p-example/project";
    const expectedUrl = "https://chatgpt.com/g/g-p-example-oracle/c/right-thread";
    const wrongUrl = "https://chatgpt.com/g/g-p-example-oracle/c/wrong-thread";
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: expectedUrl,
      conversationId: "right-thread",
    };
    const listTargets = vi.fn(
      async () => [{ targetId: "target-1", type: "page", url: wrongUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    let currentHref = wrongUrl;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: currentHref } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      const navigateMatch = expression.match(/^window\.location\.href = ("[^"]+")$/);
      if (navigateMatch) {
        currentHref = JSON.parse(navigateMatch[1] ?? '""');
        return { result: { value: true } };
      }
      if (isTurnCountProbe(expression)) {
        return { result: { value: 7 } };
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
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached after wrong-thread recovery",
      html: "",
      meta: { messageId: "m-wrong-thread", turnId: "conversation-turn-wrong-thread" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "wrong-thread-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(
      runtime,
      { url: projectUrl, timeoutMs: 2_000 },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(result.answerMarkdown).toBe("wrong-thread-md");
    expect(currentHref).toBe(expectedUrl);
    expect(
      evaluate.mock.calls.some((call) =>
        String(call[0]?.expression ?? "").includes('const conversationId = "right-thread"'),
      ),
    ).toBe(false);
  });

  test("retries target discovery when the hidden browser target list lags after controller loss", async () => {
    const expectedUrl = "https://chatgpt.com/g/g-p-example-oracle/c/right-thread";
    const wrongUrl = "https://chatgpt.com/g/g-p-example-oracle/c/wrong-thread";
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeBrowserWSEndpoint: "ws://127.0.0.1:51559/devtools/browser/browser-1",
      chromeTargetId: "stale-target",
      tabUrl: expectedUrl,
      conversationId: "right-thread",
    };
    const listTargets = vi
      .fn()
      .mockResolvedValueOnce([] satisfies FakeTarget[])
      .mockResolvedValueOnce([
        { targetId: "target-1", type: "page", url: wrongUrl },
      ] satisfies FakeTarget[]);
    let currentHref = wrongUrl;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: currentHref } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      const navigateMatch = expression.match(/^window\.location\.href = ("[^"]+")$/);
      if (navigateMatch) {
        currentHref = JSON.parse(navigateMatch[1] ?? '""');
        return { result: { value: true } };
      }
      if (isTurnCountProbe(expression)) {
        return { result: { value: 7 } };
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
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached after target retry",
      html: "",
      meta: { messageId: "m-target-retry", turnId: "conversation-turn-target-retry" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "target-retry-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, { timeoutMs: 5_000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
    });

    expect(result.answerMarkdown).toBe("target-retry-md");
    expect(listTargets).toHaveBeenCalledTimes(2);
    expect(currentHref).toBe(expectedUrl);
  }, 10_000);

  test("reopens a project-scoped conversation from conversationId alone via the project shell", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      conversationId: "abc",
    };
    const projectUrl = "https://chatgpt.com/g/g-p-example/project";
    const expectedUrl = `${projectUrl}/c/abc`;
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: projectUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    let currentHref = projectUrl;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: currentHref } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (
        expression.includes("const conversationId =") &&
        expression.includes(JSON.stringify(runtime.conversationId))
      ) {
        currentHref = expectedUrl;
        return {
          result: { value: { ok: true, href: expectedUrl, count: 1, scope: "project" } },
        };
      }
      const navigateMatch = expression.match(/window\.location\.href = "(.*)"/);
      if (navigateMatch?.[1]) {
        currentHref = navigateMatch[1].replace(/\\"/g, '"');
        return { result: { value: true } };
      }
      if (isTurnCountProbe(expression)) {
        return { result: { value: 7 } };
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
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached after project navigation",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "project-direct-nav-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(
      runtime,
      { url: projectUrl, timeoutMs: 2_000 },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(result.answerMarkdown).toBe("project-direct-nav-md");
    expect(
      evaluate.mock.calls.some((call) =>
        String(call[0]?.expression ?? "").includes("const conversationId ="),
      ),
    ).toBe(true);
    expect(
      evaluate.mock.calls.some((call) =>
        String(call[0]?.expression ?? "").includes(
          `window.location.href = ${JSON.stringify(expectedUrl)}`,
        ),
      ),
    ).toBe(false);
  });

  test("falls back to sidebar recovery when direct navigation lands outside the configured project scope", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      conversationId: "abc",
    };
    const projectUrl = "https://chatgpt.com/g/g-p-example/project";
    const expectedUrl = `${projectUrl}/c/abc`;
    const rootConversationUrl = "https://chatgpt.com/c/abc";
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: projectUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    let currentHref = rootConversationUrl;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: currentHref } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      const navigateMatch = expression.match(/^window\.location\.href = ("[^"]+")$/);
      if (navigateMatch) {
        currentHref = JSON.parse(navigateMatch[1] ?? '""');
        return { result: { value: true } };
      }
      if (expression.includes('const conversationId = "abc"')) {
        currentHref = expectedUrl;
        return { result: { value: { ok: true, href: expectedUrl, count: 3 } } };
      }
      if (isTurnCountProbe(expression)) {
        return { result: { value: 7 } };
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
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached after sidebar recovery",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "project-recovered-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(
      runtime,
      { url: projectUrl, timeoutMs: 2_000 },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(result.answerMarkdown).toBe("project-recovered-md");
    expect(
      evaluate.mock.calls.some((call) =>
        String(call[0]?.expression ?? "").startsWith("window.location.href = "),
      ),
    ).toBe(true);
    expect(
      evaluate.mock.calls.some((call) =>
        String(call[0]?.expression ?? "").includes('const conversationId = "abc"'),
      ),
    ).toBe(true);
  });

  test("forces the stored project conversation URL when sidebar recovery lands on the wrong thread", async () => {
    const projectUrl = "https://chatgpt.com/g/g-p-example/project";
    const expectedUrl = `${projectUrl}/c/right-thread`;
    const wrongUrl = `${projectUrl}/c/wrong-thread`;
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-project",
      tabUrl: expectedUrl,
      conversationId: "right-thread",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-project", type: "page", url: projectUrl },
          { targetId: "target-thread", type: "other", url: expectedUrl },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    let currentHref = projectUrl;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: currentHref } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      const navigateMatch = expression.match(/^window\.location\.href = ("[^"]+")$/);
      if (navigateMatch) {
        currentHref = JSON.parse(navigateMatch[1] ?? '""');
        return { result: { value: true } };
      }
      if (expression.includes('const conversationId = "right-thread"')) {
        currentHref = wrongUrl;
        return {
          result: { value: { ok: true, href: wrongUrl, count: 1, scope: "project" } },
        };
      }
      if (isTurnCountProbe(expression)) {
        return { result: { value: 4 } };
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
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "forced-url response",
      html: "",
      meta: { messageId: "m-forced", turnId: "conversation-turn-forced" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "forced-url markdown");
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(
      runtime,
      { url: projectUrl, timeoutMs: 2_000 },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(result.answerMarkdown).toBe("forced-url markdown");
    expect(
      evaluate.mock.calls.some(
        (call) =>
          String(call[0]?.expression ?? "") ===
          `window.location.href = ${JSON.stringify(expectedUrl)}`,
      ),
    ).toBe(true);
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
    const connectMock = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    );
    const connect = connectMock as unknown as (options?: unknown) => Promise<ChromeClient>;
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

  test("falls back to target discovery when a cached hidden websocket target is no longer listed", async () => {
    vi.resetModules();
    const runtime = {
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      tabUrl: "https://chatgpt.com/c/abc",
      chromeTargetId: "hidden-target-1",
    };
    const listRemoteChromeTargets = vi.fn(
      async () =>
        [{ targetId: "listed-target", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[],
    );
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const client = {
      Runtime: { enable: vi.fn(async () => ({})), evaluate },
      DOM: { enable: vi.fn(async () => ({})) },
      Target: {
        getTargetInfo: vi.fn(async () => ({
          targetInfo: {
            targetId: "hidden-target-1",
            type: "page",
            url: runtime.tabUrl,
          },
        })),
      },
      Input: {},
      close: vi.fn(async () => {}),
    } satisfies FakeClient;
    const connectToRemoteChromeTarget = vi.fn(async () => ({
      client: client as unknown as ChromeClient,
      close: vi.fn(async () => {}),
      targetId: "listed-target",
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return {
        ...actual,
        connectToRemoteChromeTarget,
        listRemoteChromeTargets,
      };
    });
    const { resumeBrowserSession: mockedResumeBrowserSession } =
      await import("../../src/browser/reattach.js");
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached-hidden",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "attached-hidden-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await mockedResumeBrowserSession(runtime, { timeoutMs: 2_000 }, logger, {
      waitForAssistantResponse,
      captureAssistantMarkdown,
    });

    expect(result.answerMarkdown).toBe("attached-hidden-md");
    expect(listRemoteChromeTargets).toHaveBeenCalledTimes(1);
    expect(connectToRemoteChromeTarget).toHaveBeenCalledWith(
      "127.0.0.1",
      9222,
      expect.any(Function),
      expect.objectContaining({
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        targetId: "listed-target",
        closeTargetOnDispose: false,
      }),
    );
    expect(connectToRemoteChromeTarget).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("cached target hidden-target-1 is no longer listed"),
    );
    expect(waitForAssistantResponse).toHaveBeenCalled();
    expect(captureAssistantMarkdown).toHaveBeenCalled();
  });

  test("falls back to host:port discovery when browser-websocket target listing is empty", async () => {
    vi.resetModules();
    const runtime = {
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      tabUrl: "https://chatgpt.com/g/g-p-example-oracle/c/right-thread",
      chromeTargetId: "hidden-target-1",
      conversationId: "right-thread",
    };
    const wrongUrl = "https://chatgpt.com/g/g-p-example-oracle/c/wrong-thread";
    const listRemoteChromeTargets = vi.fn(async (options?: { browserWSEndpoint?: string }) => {
      if (options?.browserWSEndpoint) {
        return [] satisfies FakeTarget[];
      }
      return [{ targetId: "listed-target", type: "page", url: wrongUrl }] satisfies FakeTarget[];
    });
    let currentHref = wrongUrl;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: currentHref } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      const navigateMatch = expression.match(/^window\.location\.href = ("[^"]+")$/);
      if (navigateMatch) {
        currentHref = JSON.parse(navigateMatch[1] ?? '""');
        return { result: { value: true } };
      }
      if (isTurnCountProbe(expression)) {
        return { result: { value: 7 } };
      }
      return { result: { value: null } };
    });
    const client = {
      Runtime: { enable: vi.fn(async () => ({})), evaluate },
      DOM: { enable: vi.fn(async () => ({})) },
      Input: {},
      close: vi.fn(async () => {}),
    } satisfies FakeClient;
    const connectToRemoteChromeTarget = vi.fn(async () => ({
      client: client as unknown as ChromeClient,
      close: vi.fn(async () => {}),
      targetId: "listed-target",
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return {
        ...actual,
        connectToRemoteChromeTarget,
        listRemoteChromeTargets,
      };
    });
    const { resumeBrowserSession: mockedResumeBrowserSession } =
      await import("../../src/browser/reattach.js");
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached-from-port-discovery",
      html: "",
      meta: { messageId: "m-port-discovery", turnId: "conversation-turn-port-discovery" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "attached-from-port-discovery-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await mockedResumeBrowserSession(runtime, { timeoutMs: 2_000 }, logger, {
      waitForAssistantResponse,
      captureAssistantMarkdown,
    });

    expect(result.answerMarkdown).toBe("attached-from-port-discovery-md");
    expect(listRemoteChromeTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 9222,
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      }),
    );
    expect(listRemoteChromeTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 9222,
      }),
    );
    expect(connectToRemoteChromeTarget).toHaveBeenCalledWith(
      "127.0.0.1",
      9222,
      expect.any(Function),
      expect.objectContaining({
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        targetId: "listed-target",
        closeTargetOnDispose: false,
      }),
    );
    expect(currentHref).toBe(runtime.tabUrl);
  });

  test("falls back to target discovery when a cached hidden websocket target resolves to the wrong conversation", async () => {
    vi.resetModules();
    const runtime = {
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      tabUrl: "https://chatgpt.com/c/expected",
      chromeTargetId: "hidden-target-1",
      conversationId: "expected",
    };
    const listRemoteChromeTargets = vi.fn(
      async () =>
        [
          { targetId: "hidden-target-1", type: "page", url: "https://chatgpt.com/c/other" },
          { targetId: "expected-target", type: "page", url: runtime.tabUrl },
        ] satisfies FakeTarget[],
    );
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const staleClient = {
      Runtime: { enable: vi.fn(async () => ({})), evaluate },
      DOM: { enable: vi.fn(async () => ({})) },
      Target: {
        getTargetInfo: vi.fn(async () => ({
          targetInfo: {
            targetId: "hidden-target-1",
            type: "page",
            url: "https://chatgpt.com/c/other",
          },
        })),
      },
      Input: {},
      close: vi.fn(async () => {}),
    } satisfies FakeClient;
    const staleConnection = {
      client: staleClient as unknown as ChromeClient,
      close: vi.fn(async () => {}),
      targetId: "hidden-target-1",
    };
    const freshClient = {
      Runtime: { enable: vi.fn(async () => ({})), evaluate },
      DOM: { enable: vi.fn(async () => ({})) },
      Target: {
        getTargetInfo: vi.fn(async () => ({
          targetInfo: {
            targetId: "expected-target",
            type: "page",
            url: runtime.tabUrl,
          },
        })),
      },
      Input: {},
      close: vi.fn(async () => {}),
    } satisfies FakeClient;
    const freshConnection = {
      client: freshClient as unknown as ChromeClient,
      close: vi.fn(async () => {}),
      targetId: "expected-target",
    };
    const connectToRemoteChromeTarget = vi
      .fn()
      .mockResolvedValueOnce(staleConnection)
      .mockResolvedValueOnce(freshConnection);
    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return {
        ...actual,
        connectToRemoteChromeTarget,
        listRemoteChromeTargets,
      };
    });
    const { resumeBrowserSession: mockedResumeBrowserSession } =
      await import("../../src/browser/reattach.js");
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached-hidden",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "attached-hidden-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await mockedResumeBrowserSession(runtime, { timeoutMs: 2_000 }, logger, {
      waitForAssistantResponse,
      captureAssistantMarkdown,
    });

    expect(result.answerMarkdown).toBe("attached-hidden-md");
    expect(staleConnection.close).toHaveBeenCalledTimes(1);
    expect(listRemoteChromeTargets).toHaveBeenCalledTimes(1);
    expect(connectToRemoteChromeTarget).toHaveBeenNthCalledWith(
      2,
      "127.0.0.1",
      9222,
      expect.any(Function),
      expect.objectContaining({
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        targetId: "expected-target",
      }),
    );
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("retrying via target discovery"));
  });

  test("falls back to target discovery when a cached hidden websocket target is a project conversation shadow target", async () => {
    vi.resetModules();
    const runtime = {
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      tabUrl: "https://chatgpt.com/g/g-p-example/project/c/expected",
      chromeTargetId: "hidden-target-1",
      conversationId: "expected",
    };
    const listRemoteChromeTargets = vi.fn(
      async () =>
        [
          { targetId: "project-shadow", type: "other", url: runtime.tabUrl },
          {
            targetId: "project-shell",
            type: "page",
            url: "https://chatgpt.com/g/g-p-example/project",
          },
        ] satisfies FakeTarget[],
    );
    let currentHref = "https://chatgpt.com/g/g-p-example/project";
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      const navigationMatch = expression.match(/window\.location\.href = "(.*)"/);
      if (navigationMatch?.[1]) {
        currentHref = navigationMatch[1].replace(/\\"/g, '"');
        return { result: { value: currentHref } };
      }
      if (
        expression.includes("const conversationId =") &&
        expression.includes(JSON.stringify(runtime.conversationId))
      ) {
        currentHref = runtime.tabUrl;
        return {
          result: { value: { ok: true, href: runtime.tabUrl, count: 1, scope: "project" } },
        };
      }
      if (expression === "location.href") {
        return { result: { value: currentHref } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (isTurnCountProbe(expression)) {
        return { result: { value: 4 } };
      }
      return { result: { value: null } };
    });
    const shellClient = {
      Runtime: { enable: vi.fn(async () => ({})), evaluate },
      DOM: { enable: vi.fn(async () => ({})) },
      Target: {
        getTargetInfo: vi.fn(async () => ({
          targetInfo: {
            targetId: "project-shell",
            type: "page",
            url: "https://chatgpt.com/g/g-p-example/project",
          },
        })),
      },
      Input: {},
      close: vi.fn(async () => {}),
    } satisfies FakeClient;
    const shellConnection = {
      client: shellClient as unknown as ChromeClient,
      close: vi.fn(async () => {}),
      targetId: "project-shell",
    };
    const connectToRemoteChromeTarget = vi.fn().mockResolvedValueOnce(shellConnection);
    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return {
        ...actual,
        connectToRemoteChromeTarget,
        listRemoteChromeTargets,
      };
    });
    const { resumeBrowserSession: mockedResumeBrowserSession } =
      await import("../../src/browser/reattach.js");
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached-hidden",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "attached-hidden-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await mockedResumeBrowserSession(runtime, { timeoutMs: 2_000 }, logger, {
      waitForAssistantResponse,
      captureAssistantMarkdown,
    });

    expect(result.answerMarkdown).toBe("attached-hidden-md");
    expect(listRemoteChromeTargets).toHaveBeenCalledTimes(1);
    expect(
      connectToRemoteChromeTarget.mock.calls.some(
        (call) =>
          call[0] === "127.0.0.1" && call[1] === 9222 && call[3]?.targetId === "project-shell",
      ),
    ).toBe(true);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("retrying via target discovery"));
  });

  test("reopens the stored conversation when a cached hidden websocket target cannot be verified", async () => {
    vi.resetModules();
    const runtime = {
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      tabUrl: "https://chatgpt.com/c/expected",
      chromeTargetId: "hidden-target-1",
      conversationId: "expected",
    };
    const listRemoteChromeTargets = vi.fn(async () => [] satisfies FakeTarget[]);
    const connectToRemoteChromeTarget = vi.fn(async () => ({
      client: {
        Runtime: {
          enable: vi.fn(async () => ({})),
          evaluate: vi.fn(async () => ({ result: { value: null } })),
        },
        DOM: { enable: vi.fn(async () => ({})) },
        Input: {},
        close: vi.fn(async () => {}),
      } satisfies FakeClient as unknown as ChromeClient,
      close: vi.fn(async () => {}),
      targetId: "hidden-target-1",
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return {
        ...actual,
        connectToRemoteChromeTarget,
        listRemoteChromeTargets,
      };
    });
    const { resumeBrowserSession: mockedResumeBrowserSession } =
      await import("../../src/browser/reattach.js");
    const logger = vi.fn();
    const recoverSession = vi.fn(async () => ({
      answerText: "recovered",
      answerMarkdown: "recovered-md",
      runtime,
    }));

    const result = await mockedResumeBrowserSession(
      runtime,
      { attachRunning: true, timeoutMs: 2_000 },
      logger as BrowserLogger,
      { recoverSession },
    );

    expect(result.answerMarkdown).toBe("recovered-md");
    expect(recoverSession).toHaveBeenCalledWith(runtime, {
      attachRunning: true,
      timeoutMs: 2_000,
    });
    expect(listRemoteChromeTargets.mock.calls.length).toBeGreaterThan(1);
    expect(
      logger.mock.calls.some((call) =>
        String(call[0]).includes("reopening browser to locate the stored conversation"),
      ),
    ).toBe(true);
  }, 10_000);

  test("reuses a cached hidden websocket target when the connected target is a chat conversation", async () => {
    vi.resetModules();
    const runtime = {
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      tabUrl: "https://chatgpt.com/c/abc",
      chromeTargetId: "hidden-target-1",
    };
    const listedTargets = vi.fn(
      async () =>
        [
          { targetId: "hidden-target-1", type: "other", url: runtime.tabUrl },
        ] satisfies FakeTarget[],
    );
    const client = {
      Runtime: {
        enable: vi.fn(async () => ({})),
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression === "location.href") {
            return { result: { value: runtime.tabUrl } };
          }
          if (expression === "1+1") {
            return { result: { value: 2 } };
          }
          return { result: { value: null } };
        }),
      },
      DOM: { enable: vi.fn(async () => ({})) },
      Target: {
        getTargetInfo: vi.fn(async () => ({
          targetInfo: {
            targetId: "hidden-target-1",
            type: "other",
            url: runtime.tabUrl,
          },
        })),
      },
      Input: {},
      close: vi.fn(async () => {}),
    } satisfies FakeClient;
    const connectToRemoteChromeTarget = vi.fn(async () => ({
      client: client as unknown as ChromeClient,
      close: vi.fn(async () => {}),
      targetId: "hidden-target-1",
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return {
        ...actual,
        connectToRemoteChromeTarget,
        listRemoteChromeTargets: listedTargets,
      };
    });
    const { resumeBrowserSession: mockedResumeBrowserSession } =
      await import("../../src/browser/reattach.js");
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "reopened",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "reopened-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await mockedResumeBrowserSession(runtime, { timeoutMs: 2_000 }, logger, {
      waitForAssistantResponse,
      captureAssistantMarkdown,
    });

    expect(result.answerMarkdown).toBe("reopened-md");
    expect(result.answerText).toBe("reopened-md");
    expect(waitForAssistantResponse).toHaveBeenCalledTimes(1);
    expect(listedTargets).toHaveBeenCalledTimes(1);
  });

  test("fails closed when websocket metadata has no matched tab and no conversation identity", async () => {
    vi.resetModules();
    const runtime = {
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      tabUrl: "https://chatgpt.com/",
    };
    const listTargets = vi.fn(async () => [] satisfies FakeTarget[]) as unknown as () => Promise<
      FakeTarget[]
    >;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connectMock = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    );
    const connect = connectMock as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "attached-md");
    const listRemoteChromeTargets = vi.fn(async () => [] satisfies FakeTarget[]);
    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return {
        ...actual,
        listRemoteChromeTargets,
      };
    });
    const { resumeBrowserSession: mockedResumeBrowserSession } =
      await import("../../src/browser/reattach.js");
    const logger = vi.fn() as BrowserLogger;

    await expect(
      mockedResumeBrowserSession(runtime, { attachRunning: true, timeoutMs: 2_000 }, logger, {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      }),
    ).rejects.toThrow("Unable to locate the existing Oracle browser tab for the reusable runtime");
    expect(connect).not.toHaveBeenCalled();
    expect(listRemoteChromeTargets).toHaveBeenCalledTimes(1);
  }, 10_000);

  test("reopens the stored conversation when websocket metadata has no matched tab but a conversation id is known", async () => {
    const runtime = {
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      tabUrl: "https://chatgpt.com/g/g-p-example-oracle/c/recovered-thread",
      conversationId: "recovered-thread",
    };
    const listTargets = vi.fn(async () => [] satisfies FakeTarget[]) as unknown as () => Promise<
      FakeTarget[]
    >;
    const connect = vi.fn() as unknown as (options?: unknown) => Promise<ChromeClient>;
    const recoverSession = vi.fn(async () => ({
      answerText: "recovered",
      answerMarkdown: "recovered-md",
      runtime,
    }));
    const logger = vi.fn();

    const result = await resumeBrowserSession(
      runtime,
      { attachRunning: true, timeoutMs: 2_000 },
      logger as BrowserLogger,
      {
        listTargets,
        connect,
        recoverSession,
      },
    );

    expect(result.answerMarkdown).toBe("recovered-md");
    expect(connect).not.toHaveBeenCalled();
    expect(recoverSession).toHaveBeenCalledWith(runtime, { attachRunning: true, timeoutMs: 2_000 });
    expect(
      logger.mock.calls.some((call) =>
        String(call[0]).includes("reopening browser to locate the stored conversation"),
      ),
    ).toBe(true);
  });

  test("continues a browser follow-up through browser websocket metadata", async () => {
    const runtime = {
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeProfileRoot: "/tmp/oracle-attach-running-profile",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
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
    const pageNavigate = vi.fn(async () => {});
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          Page: { navigate: pageNavigate },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "supervisor response",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const logger = vi.fn() as BrowserLogger;

    const result = await continueBrowserSession(
      runtime,
      { attachRunning: true, timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(result.answerMarkdown).toBe("supervisor markdown");
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "ws://127.0.0.1:9222/devtools/browser/abc",
        local: true,
      }),
    );
    expect(submitPrompt).toHaveBeenCalledTimes(1);
  });

  test("continues a browser follow-up by reopening the stored conversation from a unique chat shell target", async () => {
    const conversationUrl = "https://chatgpt.com/g/g-p-example-oracle/c/right-thread";
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      tabUrl: conversationUrl,
      conversationId: "right-thread",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-home", type: "page", url: "https://chatgpt.com/" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    let currentHref = "https://chatgpt.com/";
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: currentHref } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (expression.includes(`window.location.href = ${JSON.stringify(conversationUrl)}`)) {
        currentHref = conversationUrl;
        return { result: { value: true } };
      }
      if (isTurnCountProbe(expression)) {
        return { result: { value: 4 } };
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
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 5);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "shell recovered response",
      html: "",
      meta: { messageId: "m-shell", turnId: "conversation-turn-shell" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "shell recovered markdown");
    const logger = vi.fn() as BrowserLogger;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      { prompt: "Finish the workflow with the exact result." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(result.answerMarkdown).toBe("shell recovered markdown");
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(
      evaluate.mock.calls.some((call) =>
        String(call[0]?.expression ?? "").includes(
          `window.location.href = ${JSON.stringify(conversationUrl)}`,
        ),
      ),
    ).toBe(true);
  });

  test("sidebar reopen with a known conversation id does not wait for the new follow-up prompt preview", async () => {
    const conversationUrl = "https://chatgpt.com/g/g-p-example-oracle/c/right-thread";
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      tabUrl: "https://chatgpt.com/g/g-p-example-oracle/project",
      conversationId: "right-thread",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-home", type: "page", url: "https://chatgpt.com/" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    let currentHref = "https://chatgpt.com/";
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: currentHref } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (
        expression.includes(
          `window.location.href = ${JSON.stringify("https://chatgpt.com/g/g-p-example-oracle/project")}`,
        )
      ) {
        currentHref = "https://chatgpt.com/g/g-p-example-oracle/project";
        return { result: { value: true } };
      }
      if (
        expression.includes("const conversationId =") &&
        expression.includes(JSON.stringify(runtime.conversationId))
      ) {
        currentHref = conversationUrl;
        return { result: { value: { ok: true, href: conversationUrl, count: 1, scope: "main" } } };
      }
      if (expression.includes("const needles =")) {
        return { result: { value: false } };
      }
      if (isTurnCountProbe(expression)) {
        return { result: { value: 4 } };
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
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 6);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "sidebar recovered response",
      html: "",
      meta: { messageId: "m-sidebar", turnId: "conversation-turn-sidebar" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "sidebar recovered markdown");
    const logger = vi.fn() as BrowserLogger;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      { prompt: "Finish the workflow with the exact result." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(result.answerMarkdown).toBe("sidebar recovered markdown");
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(
      evaluate.mock.calls.some((call) =>
        String(call[0]?.expression ?? "").includes("const conversationId ="),
      ),
    ).toBe(true);
    expect(
      evaluate.mock.calls.some((call) =>
        String(call[0]?.expression ?? "").includes("const needles ="),
      ),
    ).toBe(false);
  }, 10_000);

  test("project-scoped followups reopen the project shell and use the sidebar instead of direct conversation navigation", async () => {
    const projectUrl = "https://chatgpt.com/g/g-p-example/project";
    const conversationUrl = `${projectUrl}/c/right-thread`;
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      tabUrl: conversationUrl,
      conversationId: "right-thread",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-project", type: "page", url: projectUrl },
          { targetId: "target-thread", type: "other", url: conversationUrl },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    let currentHref = projectUrl;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: currentHref } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (
        expression.includes("const conversationId =") &&
        expression.includes(JSON.stringify(runtime.conversationId))
      ) {
        currentHref = conversationUrl;
        return {
          result: { value: { ok: true, href: conversationUrl, count: 1, scope: "project" } },
        };
      }
      if (isTurnCountProbe(expression)) {
        return { result: { value: 4 } };
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
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 5);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "project shell recovered response",
      html: "",
      meta: { messageId: "m-project", turnId: "conversation-turn-project" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "project shell recovered markdown");
    const logger = vi.fn() as BrowserLogger;

    const result = await continueBrowserSession(
      runtime,
      { url: projectUrl, timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      { prompt: "Continue from the project-scoped conversation." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(result.answerMarkdown).toBe("project shell recovered markdown");
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(
      evaluate.mock.calls.some((call) =>
        String(call[0]?.expression ?? "").includes("const conversationId ="),
      ),
    ).toBe(true);
    expect(
      evaluate.mock.calls.some((call) =>
        String(call[0]?.expression ?? "").includes(
          `window.location.href = ${JSON.stringify(conversationUrl)}`,
        ),
      ),
    ).toBe(false);
  }, 10_000);

  test("falls back to recovery when existing chrome attach fails", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
    };
    const listTargets = vi.fn(async () => {
      throw new Error("no targets");
    }) as unknown as () => Promise<FakeTarget[]>;
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, { listTargets, recoverSession });

    expect(result.answerText).toBe("fallback");
    expect(recoverSession).toHaveBeenCalled();
  });

  test("reuses matched non-page conversation targets while recovering a session", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-other",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
    };
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "target-other", type: "other", url: runtime.tabUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const connect = vi.fn(
      async () =>
        ({
          Runtime: {
            enable: vi.fn(),
            evaluate: vi.fn(async ({ expression }: { expression: string }) => {
              if (expression === "location.href") {
                return { result: { value: runtime.tabUrl } };
              }
              if (expression === "1+1") {
                return { result: { value: 2 } };
              }
              return { result: { value: null } };
            }),
          },
          DOM: { enable: vi.fn() },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "fallback",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "fallback-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, { timeoutMs: 2_000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
    });

    expect(result.answerText).toBe("fallback-md");
    expect(result.answerMarkdown).toBe("fallback-md");
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("does not reopen when live reattach sees an empty assistant turn", async () => {
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
      return { result: { value: null } };
    });
    const pageNavigate = vi.fn(async () => {});
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          Page: { navigate: pageNavigate },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const waitForAssistantResponse = vi.fn(async () => {
      throw new Error("assistant-response-empty-turn");
    });
    const logger = vi.fn() as BrowserLogger;

    await expect(
      resumeBrowserSession(runtime, { timeoutMs: 2_000 }, logger, {
        listTargets,
        connect,
        waitForAssistantResponse,
        recoverSession,
      }),
    ).rejects.toThrow("assistant-response-empty-turn");

    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("surfaces live reattach rate limits without reopening Chrome", async () => {
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
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const waitForAssistantResponse = vi.fn(async () => {
      throw new Error("assistant-response-rate-limited");
    });
    const logger = vi.fn() as BrowserLogger;

    await expect(
      resumeBrowserSession(runtime, { timeoutMs: 2_000 }, logger, {
        listTargets,
        connect,
        waitForAssistantResponse,
        recoverSession,
      }),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: expect.objectContaining({
        stage: "assistant-rate-limit",
        runtime: expect.objectContaining({
          chromeHost: "127.0.0.1",
          chromePort: 51559,
          chromeTargetId: "target-1",
        }),
      }),
    });

    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("continues an existing chrome conversation with a new prompt", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
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
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "supervisor response",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(ensurePromptReady).toHaveBeenCalled();
    expect(clearPromptComposer).toHaveBeenCalled();
    expect(submitPrompt).toHaveBeenCalled();
    expect(waitForAssistantResponse).toHaveBeenCalled();
    expect(result.answerMarkdown).toBe("supervisor markdown");
    expect(result.runtime?.conversationId).toBe("abc");
  });

  test("uses the pre-submit turn count as the follow-up baseline", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
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
      if (isTurnCountProbe(expression)) {
        return { result: { value: 7 } };
      }
      return { result: { value: null } };
    });
    const pageNavigate = vi.fn(async () => {});
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          Page: { navigate: pageNavigate },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "I",
      html: "<p>I</p>",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "fresh follow-up markdown");
    const logger = vi.fn() as BrowserLogger;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(submitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ baselineTurns: 7 }),
      "Follow up on the implementation.",
      logger,
    );
    expect(captureAssistantMarkdown).toHaveBeenCalledWith(
      expect.anything(),
      { messageId: "m2", turnId: "conversation-turn-2" },
      logger,
      7,
    );
    expect(result.answerMarkdown).toBe("fresh follow-up markdown");
  });

  test("ignores a stale pre-submit assistant snapshot before accepting the new follow-up answer", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        chromePort: 51559,
        chromeHost: "127.0.0.1",
        chromeTargetId: "target-1",
        tabUrl: "https://chatgpt.com/c/abc",
        conversationId: "abc",
      };
      const listTargets = vi.fn(
        async () =>
          [
            { targetId: "target-1", type: "page", url: runtime.tabUrl },
            { targetId: "target-2", type: "page", url: "about:blank" },
          ] satisfies FakeTarget[],
      ) as unknown as () => Promise<FakeTarget[]>;
      let snapshotCalls = 0;
      const staleAnswer = {
        text: "O1_1775533302",
        html: "<p>O1_1775533302</p>",
        messageId: "m-old",
        turnId: "tid-old",
        turnIndex: null,
      };
      const freshAnswer = {
        text: "O2_1775533302=/Users/paulbettner/Projects/smarty-dev/smarty-code",
        html: "<p>O2_1775533302=/Users/paulbettner/Projects/smarty-dev/smarty-code</p>",
        messageId: "m-new",
        turnId: "tid-new",
        turnIndex: null,
      };
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "location.href") {
          return { result: { value: runtime.tabUrl } };
        }
        if (expression === "1+1") {
          return { result: { value: 2 } };
        }
        if (expression.includes("extractAssistantTurn")) {
          snapshotCalls += 1;
          return {
            result: {
              value: snapshotCalls < 3 ? staleAnswer : freshAnswer,
            },
          };
        }
        if (isTurnCountProbe(expression)) {
          return { result: { value: 7 } };
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
      const ensurePromptReady = vi.fn(async () => {});
      const clearPromptComposer = vi.fn(async () => {});
      const submitPrompt = vi.fn(async () => 3);
      const waitForAssistantResponse = vi.fn(async () => ({
        text: staleAnswer.text,
        html: staleAnswer.html,
        meta: { messageId: staleAnswer.messageId, turnId: staleAnswer.turnId },
      }));
      const captureAssistantMarkdown = vi.fn(
        async (
          _Runtime: ChromeClient["Runtime"],
          meta: { messageId?: string | null; turnId?: string | null },
        ) =>
          meta.messageId === "m-new"
            ? "O2_1775533302=/Users/paulbettner/Projects/smarty-dev/smarty-code"
            : "O1_1775533302",
      );
      const logger = vi.fn() as BrowserLogger;
      logger.verbose = true;

      const promise = continueBrowserSession(
        runtime,
        { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
        logger,
        { prompt: "Run pwd in the workspace and reply with the exact result." },
        {
          listTargets,
          connect,
          ensurePromptReady,
          clearPromptComposer,
          submitPrompt,
          waitForAssistantResponse,
          captureAssistantMarkdown,
        },
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await promise;

      expect(result.answerText).toBe(
        "O2_1775533302=/Users/paulbettner/Projects/smarty-dev/smarty-code",
      );
      expect(result.answerMarkdown).toBe(
        "O2_1775533302=/Users/paulbettner/Projects/smarty-dev/smarty-code",
      );
      expect(captureAssistantMarkdown).toHaveBeenCalledWith(
        expect.anything(),
        { messageId: "m-new", turnId: "tid-new" },
        logger,
        7,
      );
      expect(logger).toHaveBeenCalledWith(
        "Detected stale assistant response; waiting for new response...",
      );
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  test("guards an existing hidden chrome follow-up before reconnecting and sending", async () => {
    vi.resetModules();
    const frontmostTarget = { name: "Zed", pid: 77 };
    const captureFrontmostProcess = vi.fn(async () => frontmostTarget);
    const hideChromeWindow = vi.fn(async (..._args: unknown[]) => {});
    const startChromeFocusGuard = vi.fn(() => vi.fn());
    const finalizeChromeFocusProtection = vi.fn(async (chrome, loggerArg, stop, restoreTarget) => {
      await hideChromeWindow(chrome as never, loggerArg as never, restoreTarget as never);
      stop?.();
    });
    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return {
        ...original,
        captureFrontmostProcess,
        hideChromeWindow,
        startChromeFocusGuard,
        finalizeChromeFocusProtection,
      };
    });

    const { continueBrowserSession: guardedContinueBrowserSession } =
      await import("../../src/browser/reattach.js");
    const runtime = {
      chromePid: 4242,
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
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
      return { result: { value: null } };
    });
    const connectMock = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    );
    const connect = connectMock as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "supervisor response",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const logger = vi.fn() as BrowserLogger;

    const result = await guardedContinueBrowserSession(
      runtime,
      { hideWindow: true, timeoutMs: 2_000, inputTimeoutMs: 1_000, modelStrategy: "ignore" },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(result.answerMarkdown).toBe("supervisor markdown");
    expect(captureFrontmostProcess).toHaveBeenCalledWith(logger);
    expect(hideChromeWindow).toHaveBeenCalledTimes(2);
    expect(hideChromeWindow).toHaveBeenNthCalledWith(1, { pid: 4242 }, logger, frontmostTarget);
    expect(hideChromeWindow).toHaveBeenNthCalledWith(2, { pid: 4242 }, logger, frontmostTarget);
    expect(startChromeFocusGuard).toHaveBeenCalledWith({ pid: 4242 }, logger, frontmostTarget);
    expect(hideChromeWindow.mock.invocationCallOrder[0]).toBeLessThan(
      connectMock.mock.invocationCallOrder[0],
    );
  });

  test("does not retry resume after a submitted follow-up hits an empty assistant turn", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
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
      if (isTurnCountProbe(expression)) {
        return { result: { value: 7 } };
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
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => {
      throw new Error("assistant-response-empty-turn");
    });
    const logger = vi.fn() as BrowserLogger;

    await expect(
      continueBrowserSession(
        runtime,
        { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
        logger,
        { prompt: "Follow up on the implementation." },
        {
          listTargets,
          connect,
          ensurePromptReady,
          clearPromptComposer,
          submitPrompt,
          waitForAssistantResponse,
        },
      ),
    ).rejects.toThrow("assistant-response-empty-turn");

    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("rechecks after a submitted follow-up hits an empty assistant shell when assistant recheck is configured", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
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
      if (isTurnCountProbe(expression)) {
        return { result: { value: 7 } };
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
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi
      .fn()
      .mockRejectedValueOnce(new Error("assistant-response-empty-turn"))
      .mockResolvedValueOnce({
        text: "LIVE_FOLLOWUP_OK_2468",
        html: "",
        meta: { messageId: "m2", turnId: "conversation-turn-2" },
      });
    const captureAssistantMarkdown = vi.fn(async () => "LIVE_FOLLOWUP_OK_2468");
    const logger = vi.fn() as BrowserLogger;

    const result = await continueBrowserSession(
      runtime,
      {
        timeoutMs: 2_000,
        inputTimeoutMs: 1_000,
        assistantRecheckDelayMs: 1,
        assistantRecheckTimeoutMs: 50,
      },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(result.answerMarkdown).toBe("LIVE_FOLLOWUP_OK_2468");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(waitForAssistantResponse).toHaveBeenCalledTimes(2);
    expect(waitForAssistantResponse.mock.calls[1]?.[1]).toBeGreaterThan(0);
    expect(waitForAssistantResponse.mock.calls[1]?.[1]).toBeLessThanOrEqual(50);
  });

  test("recovers a follow-up answer after a transient thinking scaffold", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        chromePort: 51559,
        chromeHost: "127.0.0.1",
        chromeTargetId: "target-1",
        tabUrl: "https://chatgpt.com/c/abc",
        conversationId: "abc",
      };
      const listTargets = vi.fn(
        async () =>
          [
            { targetId: "target-1", type: "page", url: runtime.tabUrl },
            { targetId: "target-2", type: "page", url: "about:blank" },
          ] satisfies FakeTarget[],
      ) as unknown as () => Promise<FakeTarget[]>;
      const baselineAnswer = "PREVIOUS_ORACLE_RESULT";
      let snapshotCalls = 0;
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "location.href") {
          return { result: { value: runtime.tabUrl } };
        }
        if (expression === "1+1") {
          return { result: { value: 2 } };
        }
        if (expression.includes("extractAssistantTurn")) {
          snapshotCalls += 1;
          if (snapshotCalls === 1) {
            return {
              result: {
                value: {
                  text: baselineAnswer,
                  html: `<p>${baselineAnswer}</p>`,
                  messageId: "m-prev",
                  turnId: "conversation-turn-1",
                },
              },
            };
          }
          if (snapshotCalls < 4) {
            return {
              result: {
                value: {
                  text: "Thinking",
                  html: '<div data-message-model-slug="gpt-5-4-thinking"><div class="result-thinking markdown"><p></p></div></div>',
                  messageId: "m-thinking",
                  turnId: "conversation-turn-2",
                },
              },
            };
          }
          return {
            result: {
              value: {
                text: "ORACLE-E2E-20260401-A",
                html: "<p>ORACLE-E2E-20260401-A</p>",
                messageId: "m-final",
                turnId: "conversation-turn-2",
              },
            },
          };
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
      const ensurePromptReady = vi.fn(async () => {});
      const clearPromptComposer = vi.fn(async () => {});
      const submitPrompt = vi.fn(async () => 3);
      const waitForAssistantResponse = vi.fn(async () => ({
        text: "Thinking",
        html: "",
        meta: { messageId: "m-thinking", turnId: "conversation-turn-2" },
      }));
      const captureAssistantMarkdown = vi
        .fn()
        .mockResolvedValueOnce("Thinking")
        .mockResolvedValueOnce("ORACLE-E2E-20260401-A");
      const logger = vi.fn() as BrowserLogger;

      const promise = continueBrowserSession(
        runtime,
        { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
        logger,
        { prompt: "Follow up on the implementation." },
        {
          listTargets,
          connect,
          ensurePromptReady,
          clearPromptComposer,
          submitPrompt,
          waitForAssistantResponse,
          captureAssistantMarkdown,
        },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await promise;

      expect(result.answerText).toBe("ORACLE-E2E-20260401-A");
      expect(result.answerMarkdown).toBe("ORACLE-E2E-20260401-A");
      expect(captureAssistantMarkdown).toHaveBeenCalledTimes(2);
      expect(logger).toHaveBeenCalledWith(
        "Recovered follow-up assistant response after transient thinking scaffold",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("refreshes a partial follow-up answer when later snapshot expands to the full control payload", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        chromePort: 51559,
        chromeHost: "127.0.0.1",
        chromeTargetId: "target-1",
        tabUrl: "https://chatgpt.com/c/abc",
        conversationId: "abc",
      };
      const listTargets = vi.fn(
        async () =>
          [
            { targetId: "target-1", type: "page", url: runtime.tabUrl },
            { targetId: "target-2", type: "page", url: "about:blank" },
          ] satisfies FakeTarget[],
      ) as unknown as () => Promise<FakeTarget[]>;
      const baselineAnswer = "PREVIOUS_ORACLE_RESULT";
      const partialAnswer =
        "I’m sending a minimal orchestrator round-trip now: a simple 2+2 task with an explicit return, and I’ll only confirm success once the result comes back here.";
      const fullAnswer = `${partialAnswer}

Starting the minimal loop test now. I am not treating it as proven until the orchestrator returns a result from the delegated task.

\`\`\`oracle_control
{"schema_version":1,"op_id":"op-minimal-round-trip","idempotency_key":"idem-minimal-round-trip","op":"handoff","workflow_id":"oracle-routing","workflow_version":0,"message":"Run a minimal orchestrator round-trip test.","message_for_user":"Starting a minimal orchestrator round-trip test now.","status":"in_progress"}
\`\`\``;
      let snapshotCalls = 0;
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "location.href") {
          return { result: { value: runtime.tabUrl } };
        }
        if (expression === "1+1") {
          return { result: { value: 2 } };
        }
        if (expression.includes("extractAssistantTurn")) {
          snapshotCalls += 1;
          return {
            result: {
              value:
                snapshotCalls === 1
                  ? {
                      text: baselineAnswer,
                      html: `<p>${baselineAnswer}</p>`,
                      messageId: "m-prev",
                      turnId: "conversation-turn-1",
                    }
                  : snapshotCalls < 4
                    ? {
                        text: partialAnswer,
                        html: `<p>${partialAnswer}</p>`,
                        messageId: "m-partial",
                        turnId: "conversation-turn-2",
                      }
                    : {
                        text: fullAnswer,
                        html: "<div>expanded</div>",
                        messageId: "m-final",
                        turnId: "conversation-turn-2",
                      },
            },
          };
        }
        if (isTurnCountProbe(expression)) {
          return { result: { value: 3 } };
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
      const ensurePromptReady = vi.fn(async () => {});
      const clearPromptComposer = vi.fn(async () => {});
      const submitPrompt = vi.fn(async () => 3);
      const waitForAssistantResponse = vi.fn(async () => ({
        text: partialAnswer,
        html: `<p>${partialAnswer}</p>`,
        meta: { messageId: "m-partial", turnId: "conversation-turn-2" },
      }));
      const captureAssistantMarkdown = vi
        .fn()
        .mockResolvedValueOnce(partialAnswer)
        .mockResolvedValueOnce(fullAnswer);
      const logger = vi.fn() as BrowserLogger;

      const promise = continueBrowserSession(
        runtime,
        { timeoutMs: 3_000, inputTimeoutMs: 1_000 },
        logger,
        { prompt: "Follow up on the implementation." },
        {
          listTargets,
          connect,
          ensurePromptReady,
          clearPromptComposer,
          submitPrompt,
          waitForAssistantResponse,
          captureAssistantMarkdown,
        },
      );
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await promise;

      expect(result.answerText).toBe(fullAnswer);
      expect(result.answerMarkdown).toBe(fullAnswer);
      expect(captureAssistantMarkdown).toHaveBeenCalledTimes(2);
      expect(captureAssistantMarkdown).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        { messageId: "m-partial", turnId: "conversation-turn-2" },
        logger,
        3,
      );
      expect(captureAssistantMarkdown).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        { messageId: "m-final", turnId: "conversation-turn-2" },
        logger,
        3,
      );
      expect(logger).toHaveBeenCalledWith("Recovered expanded assistant response during reattach");
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  test("keeps polling through an empty snapshot gap before the full follow-up payload appears", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        chromePort: 51559,
        chromeHost: "127.0.0.1",
        chromeTargetId: "target-1",
        tabUrl: "https://chatgpt.com/c/abc",
        conversationId: "abc",
      };
      const listTargets = vi.fn(
        async () =>
          [
            { targetId: "target-1", type: "page", url: runtime.tabUrl },
            { targetId: "target-2", type: "page", url: "about:blank" },
          ] satisfies FakeTarget[],
      ) as unknown as () => Promise<FakeTarget[]>;
      const baselineAnswer = "PREVIOUS_ORACLE_RESULT";
      const partialAnswer =
        "I’m sending a minimal orchestrator round-trip now: a simple 2+2 task with an explicit return, and I’ll only confirm success once the result comes back here.";
      const fullAnswer = `${partialAnswer}

Starting the minimal loop test now. I am not treating it as proven until the orchestrator returns a result from the delegated task.

\`\`\`oracle_control
{"schema_version":1,"op_id":"op-minimal-round-trip","idempotency_key":"idem-minimal-round-trip","op":"handoff","workflow_id":"oracle-routing","workflow_version":0,"message":"Run a minimal orchestrator round-trip test.","message_for_user":"Starting a minimal orchestrator round-trip test now.","status":"in_progress"}
\`\`\``;
      let snapshotCalls = 0;
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "location.href") {
          return { result: { value: runtime.tabUrl } };
        }
        if (expression === "1+1") {
          return { result: { value: 2 } };
        }
        if (expression.includes("extractAssistantTurn")) {
          snapshotCalls += 1;
          if (snapshotCalls === 1) {
            return {
              result: {
                value: {
                  text: baselineAnswer,
                  html: `<p>${baselineAnswer}</p>`,
                  messageId: "m-prev",
                  turnId: "conversation-turn-1",
                },
              },
            };
          }
          if (snapshotCalls < 4) {
            return {
              result: {
                value: {
                  text: partialAnswer,
                  html: `<p>${partialAnswer}</p>`,
                  messageId: "m-partial",
                  turnId: "conversation-turn-2",
                },
              },
            };
          }
          if (snapshotCalls < 10) {
            return { result: { value: null } };
          }
          return {
            result: {
              value: {
                text: fullAnswer,
                html: "<div>expanded</div>",
                messageId: "m-final",
                turnId: "conversation-turn-2",
              },
            },
          };
        }
        if (isTurnCountProbe(expression)) {
          return { result: { value: 3 } };
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
      const ensurePromptReady = vi.fn(async () => {});
      const clearPromptComposer = vi.fn(async () => {});
      const submitPrompt = vi.fn(async () => 3);
      const waitForAssistantResponse = vi.fn(async () => ({
        text: partialAnswer,
        html: `<p>${partialAnswer}</p>`,
        meta: { messageId: "m-partial", turnId: "conversation-turn-2" },
      }));
      const captureAssistantMarkdown = vi
        .fn()
        .mockResolvedValueOnce(partialAnswer)
        .mockResolvedValueOnce(fullAnswer);
      const logger = vi.fn() as BrowserLogger;

      const promise = continueBrowserSession(
        runtime,
        { timeoutMs: 20_000, inputTimeoutMs: 1_000 },
        logger,
        { prompt: "Follow up on the implementation." },
        {
          listTargets,
          connect,
          ensurePromptReady,
          clearPromptComposer,
          submitPrompt,
          waitForAssistantResponse,
          captureAssistantMarkdown,
        },
      );
      await vi.advanceTimersByTimeAsync(12_000);
      const result = await promise;

      expect(result.answerText).toBe(fullAnswer);
      expect(result.answerMarkdown).toBe(fullAnswer);
      expect(snapshotCalls).toBeGreaterThanOrEqual(10);
      expect(logger).toHaveBeenCalledWith("Recovered expanded assistant response during reattach");
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  test("recovers a truncated one-character follow-up when copied markdown stays stale", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        chromePort: 51559,
        chromeHost: "127.0.0.1",
        chromeTargetId: "target-1",
        tabUrl: "https://chatgpt.com/c/abc",
        conversationId: "abc",
      };
      const listTargets = vi.fn(
        async () =>
          [
            { targetId: "target-1", type: "page", url: runtime.tabUrl },
            { targetId: "target-2", type: "page", url: "about:blank" },
          ] satisfies FakeTarget[],
      ) as unknown as () => Promise<FakeTarget[]>;
      const baselineAnswer = "PREVIOUS_ORACLE_RESULT";
      const truncatedAnswer = "I";
      const fullAnswer = `I’m sending a minimal orchestrator round-trip now: a simple 2+2 task with an explicit return, and I’ll only confirm success once the result comes back here.

\`\`\`oracle_control
{"schema_version":1,"op_id":"op-minimal-round-trip","idempotency_key":"idem-minimal-round-trip","op":"handoff","workflow_id":"oracle-routing","workflow_version":0,"message":"Run a minimal orchestrator round-trip test.","message_for_user":"Starting a minimal orchestrator round-trip test now.","status":"in_progress"}
\`\`\``;
      let snapshotCalls = 0;
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "location.href") {
          return { result: { value: runtime.tabUrl } };
        }
        if (expression === "1+1") {
          return { result: { value: 2 } };
        }
        if (expression.includes("extractAssistantTurn")) {
          snapshotCalls += 1;
          return {
            result: {
              value:
                snapshotCalls === 1
                  ? {
                      text: baselineAnswer,
                      html: `<p>${baselineAnswer}</p>`,
                      messageId: "m-prev",
                      turnId: "conversation-turn-1",
                    }
                  : snapshotCalls < 25
                    ? {
                        text: truncatedAnswer,
                        html: `<p>${truncatedAnswer}</p>`,
                        messageId: "m-partial",
                        turnId: "conversation-turn-2",
                      }
                    : {
                        text: fullAnswer,
                        html: "<div>expanded</div>",
                        messageId: "m-final",
                        turnId: "conversation-turn-2",
                      },
            },
          };
        }
        if (isTurnCountProbe(expression)) {
          return { result: { value: 3 } };
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
      const ensurePromptReady = vi.fn(async () => {});
      const clearPromptComposer = vi.fn(async () => {});
      const submitPrompt = vi.fn(async () => 3);
      const waitForAssistantResponse = vi.fn(async () => ({
        text: truncatedAnswer,
        html: `<p>${truncatedAnswer}</p>`,
        meta: { messageId: "m-partial", turnId: "conversation-turn-2" },
      }));
      const captureAssistantMarkdown = vi.fn(async () => truncatedAnswer);
      const logger = vi.fn() as BrowserLogger;

      const promise = continueBrowserSession(
        runtime,
        { timeoutMs: 12_000, inputTimeoutMs: 1_000 },
        logger,
        { prompt: "Follow up on the implementation." },
        {
          listTargets,
          connect,
          ensurePromptReady,
          clearPromptComposer,
          submitPrompt,
          waitForAssistantResponse,
          captureAssistantMarkdown,
        },
      );
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await promise;

      expect(result.answerText).toBe(fullAnswer);
      expect(result.answerMarkdown).toBe(fullAnswer);
      expect(captureAssistantMarkdown).toHaveBeenCalledTimes(2);
      expect(logger).toHaveBeenCalledWith(
        "Recovered short follow-up assistant response from latest DOM snapshot",
      );
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  test("does not stall on a legitimate short follow-up answer", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        chromePort: 51559,
        chromeHost: "127.0.0.1",
        chromeTargetId: "target-1",
        tabUrl: "https://chatgpt.com/c/abc",
        conversationId: "abc",
      };
      const baselineAnswer = "PREVIOUS_ORACLE_RESULT";
      const listTargets = vi.fn(
        async () =>
          [
            { targetId: "target-1", type: "page", url: runtime.tabUrl },
            { targetId: "target-2", type: "page", url: "about:blank" },
          ] satisfies FakeTarget[],
      ) as unknown as () => Promise<FakeTarget[]>;
      const shortAnswer = "42";
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "location.href") {
          return { result: { value: runtime.tabUrl } };
        }
        if (expression === "1+1") {
          return { result: { value: 2 } };
        }
        if (expression.includes("extractAssistantTurn")) {
          return {
            result: {
              value:
                evaluate.mock.calls.filter(([params]) =>
                  String((params as { expression: string }).expression).includes(
                    "extractAssistantTurn",
                  ),
                ).length === 1
                  ? {
                      text: baselineAnswer,
                      html: `<p>${baselineAnswer}</p>`,
                      messageId: "m-prev",
                      turnId: "conversation-turn-1",
                    }
                  : {
                      text: shortAnswer,
                      html: `<p>${shortAnswer}</p>`,
                      messageId: "m-short",
                      turnId: "conversation-turn-2",
                    },
            },
          };
        }
        if (isTurnCountProbe(expression)) {
          return { result: { value: 3 } };
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
      const ensurePromptReady = vi.fn(async () => {});
      const clearPromptComposer = vi.fn(async () => {});
      const submitPrompt = vi.fn(async () => 3);
      const waitForAssistantResponse = vi.fn(async () => ({
        text: shortAnswer,
        html: `<p>${shortAnswer}</p>`,
        meta: { messageId: "m-short", turnId: "conversation-turn-2" },
      }));
      const captureAssistantMarkdown = vi.fn(async () => shortAnswer);
      const logger = vi.fn() as BrowserLogger;

      const promise = continueBrowserSession(
        runtime,
        { timeoutMs: 12_000, inputTimeoutMs: 1_000 },
        logger,
        { prompt: "Follow up on the implementation." },
        {
          listTargets,
          connect,
          ensurePromptReady,
          clearPromptComposer,
          submitPrompt,
          waitForAssistantResponse,
          captureAssistantMarkdown,
        },
      );
      let settled = false;
      promise.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBe(true);

      const result = await promise;
      expect(result.answerText).toBe(shortAnswer);
      expect(result.answerMarkdown).toBe(shortAnswer);
      expect(logger).not.toHaveBeenCalledWith(
        "Recovered short follow-up assistant response from latest DOM snapshot",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("applies model selection and thinking time before follow-up submission", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
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
    const ensurePromptReady = vi.fn(async () => {});
    const ensureModelSelection = vi.fn(async () => {});
    const ensureThinkingTime = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "supervisor response",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    await continueBrowserSession(
      runtime,
      {
        timeoutMs: 2_000,
        inputTimeoutMs: 1_000,
        desiredModel: "GPT-5.4 Pro",
        modelStrategy: "select",
        thinkingTime: "extended",
      },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        ensureModelSelection,
        ensureThinkingTime,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(ensureModelSelection).toHaveBeenCalledWith(
      expect.anything(),
      "GPT-5.4 Pro",
      logger,
      "select",
    );
    expect(ensureThinkingTime).toHaveBeenCalledWith(expect.anything(), "extended", logger);
  });

  test("reuses matched non-page conversation targets before sending a follow-up", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-other",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
    };
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "target-other", type: "other", url: runtime.tabUrl }] satisfies FakeTarget[],
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
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "reopened response",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "reopened markdown");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(connect).toHaveBeenCalledTimes(1);
    expect(ensurePromptReady).toHaveBeenCalledTimes(1);
    expect(clearPromptComposer).toHaveBeenCalledTimes(1);
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(result.answerMarkdown).toBe("reopened markdown");
  });

  test("reuses a follow-up when the expected conversation is only exposed on a non-page target", async () => {
    const runtime = {
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeTargetId: "stale-target",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "worker-target", type: "other", url: runtime.tabUrl },
          { targetId: "unrelated-page", type: "page", url: "https://chatgpt.com/c/unrelated" },
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
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 2);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "reopened response",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "reopened markdown");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(result.answerMarkdown).toBe("reopened markdown");
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("does not reopen just because the first follow-up preflight target list is stale", async () => {
    const runtime = {
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
    };
    const listTargets = vi
      .fn()
      .mockResolvedValueOnce([
        { targetId: "target-other", type: "page", url: "https://chatgpt.com/c/other" },
      ] satisfies FakeTarget[])
      .mockResolvedValueOnce([
        { targetId: "target-1", type: "page", url: runtime.tabUrl },
      ] satisfies FakeTarget[]);
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
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 2);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "stale preflight response",
      html: "",
      meta: { messageId: "m-stale", turnId: "conversation-turn-stale" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "stale preflight markdown");
    const recoverSession = vi.fn(async () => {
      throw new Error("stale preflight should not force reopen");
    });
    const logger = vi.fn() as BrowserLogger;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        recoverSession,
      },
    );

    expect(result.answerMarkdown).toBe("stale preflight markdown");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("resumes without resending when capture fails after follow-up submission", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
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
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce({
        text: "supervisor response",
        html: "",
        meta: { messageId: "m2", turnId: "conversation-turn-2" },
      });
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const recoverSession = vi.fn(async () => {
      throw new Error("should not recover by resending");
    });
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        recoverSession,
      },
    );

    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(waitForAssistantResponse).toHaveBeenCalledTimes(2);
    const initialBaseline = waitForAssistantResponse.mock.calls[0]?.[3];
    const resumedBaseline = waitForAssistantResponse.mock.calls[1]?.[3];
    expect(initialBaseline).toBe(resumedBaseline);
    expect(typeof resumedBaseline).toBe("number");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(recoverSession).not.toHaveBeenCalled();
    expect(captureAssistantMarkdown).toHaveBeenLastCalledWith(
      expect.anything(),
      { messageId: "m2", turnId: "conversation-turn-2" },
      logger,
      resumedBaseline,
    );
    expect(result.answerMarkdown).toBe("supervisor markdown");
  });

  test("falls back to the provided baseline assistant when the live baseline snapshot is blank", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        chromePort: 51559,
        chromeHost: "127.0.0.1",
        chromeTargetId: "target-1",
        tabUrl: "https://chatgpt.com/c/abc",
        conversationId: "abc",
      };
      const listTargets = vi.fn(
        async () =>
          [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[],
      ) as unknown as () => Promise<FakeTarget[]>;
      let snapshotCalls = 0;
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "location.href") {
          return { result: { value: runtime.tabUrl } };
        }
        if (expression === "1+1") {
          return { result: { value: 2 } };
        }
        if (expression.includes("extractAssistantTurn")) {
          snapshotCalls += 1;
          if (snapshotCalls === 1) {
            return { result: { value: null } };
          }
          if (snapshotCalls === 2) {
            return {
              result: {
                value: {
                  text: "PREVIOUS_ORACLE_RESULT",
                  html: "<p>PREVIOUS_ORACLE_RESULT</p>",
                  messageId: "m-prev",
                  turnId: "conversation-turn-1",
                },
              },
            };
          }
          return {
            result: {
              value: {
                text: "FRESH_ORACLE_RESULT",
                html: "<p>FRESH_ORACLE_RESULT</p>",
                messageId: "m-fresh",
                turnId: "conversation-turn-2",
              },
            },
          };
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
      const ensurePromptReady = vi.fn(async () => {});
      const clearPromptComposer = vi.fn(async () => {});
      const submitPrompt = vi.fn(async () => 3);
      const waitForAssistantResponse = vi.fn(async () => ({
        text: "PREVIOUS_ORACLE_RESULT",
        html: "<p>PREVIOUS_ORACLE_RESULT</p>",
        meta: { messageId: "m-prev", turnId: "conversation-turn-1" },
      }));
      const captureAssistantMarkdown = vi.fn(async () => "FRESH_ORACLE_RESULT");
      const logger = vi.fn() as BrowserLogger;
      logger.verbose = true;

      const promise = continueBrowserSession(
        runtime,
        { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
        logger,
        { prompt: "Follow up on the implementation." },
        {
          listTargets,
          connect,
          ensurePromptReady,
          clearPromptComposer,
          submitPrompt,
          waitForAssistantResponse,
          captureAssistantMarkdown,
          baselineAssistant: {
            text: "PREVIOUS_ORACLE_RESULT",
          },
        },
      );
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await promise;

      expect(result.answerText).toBe("FRESH_ORACLE_RESULT");
      expect(result.answerMarkdown).toBe("FRESH_ORACLE_RESULT");
      expect(logger).toHaveBeenCalledWith(
        "Detected stale assistant response; waiting for new response...",
      );
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  test("resumes without resending when attachment verification fails after send", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
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
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const clearComposerAttachments = vi.fn(async () => {});
    const uploadAttachmentFile = vi.fn(async () => true);
    const waitForAttachmentCompletion = vi.fn(async () => {});
    const waitForUserTurnAttachments = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "supervisor response",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const recoverSession = vi.fn(async () => {
      throw new Error("should not recover by resending");
    });
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      {
        prompt: "Review these files.",
        attachments: [{ path: "/tmp/context.zip", displayPath: "context.zip", sizeBytes: 4 }],
      },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        clearComposerAttachments,
        uploadAttachmentFile,
        waitForAttachmentCompletion,
        waitForUserTurnAttachments,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        recoverSession,
      },
    );

    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(waitForUserTurnAttachments).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(recoverSession).not.toHaveBeenCalled();
    expect(result.answerMarkdown).toBe("supervisor markdown");
  });

  test("resumes without resending when prompt commit verification times out after send", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
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
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => {
      throw new BrowserAutomationError(
        "Prompt did not appear in conversation before timeout (send may have failed)",
        {
          stage: "submit-prompt",
          promptSubmitted: true,
          submittedPrompt: "Follow up on the implementation.",
          baselineTurns: 3,
        },
      );
    });
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "supervisor response",
      html: "",
      meta: { messageId: "m4", turnId: "conversation-turn-4" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const recoverSession = vi.fn(async () => {
      throw new Error("should not recover by resending");
    });
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        recoverSession,
      },
    );

    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(recoverSession).not.toHaveBeenCalled();
    expect(waitForAssistantResponse).toHaveBeenCalledWith(expect.anything(), 2_000, logger, 3);
    expect(result.answerText).toBe("supervisor markdown");
    expect(result.answerMarkdown).toBe("supervisor markdown");
  });

  test("uploads attachments during follow-up prompts", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
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
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const clearComposerAttachments = vi.fn(async () => {});
    const uploadAttachmentFile = vi.fn(async () => true);
    const waitForAttachmentCompletion = vi.fn(async () => {});
    const waitForUserTurnAttachments = vi.fn(async () => true);
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "supervisor response",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      {
        prompt: "Review these files.",
        attachments: [{ path: "/tmp/context.zip", displayPath: "context.zip", sizeBytes: 4 }],
      },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        clearComposerAttachments,
        uploadAttachmentFile,
        waitForAttachmentCompletion,
        waitForUserTurnAttachments,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(clearComposerAttachments).toHaveBeenCalled();
    expect(uploadAttachmentFile).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ displayPath: "context.zip" }),
      logger,
      { expectedCount: 1 },
    );
    expect(waitForAttachmentCompletion).toHaveBeenCalled();
    expect(waitForUserTurnAttachments).toHaveBeenCalledWith(
      expect.anything(),
      ["context.zip"],
      20_000,
      logger,
    );
    expect(submitPrompt).toHaveBeenCalled();
    expect(result.answerMarkdown).toBe("supervisor markdown");
  });

  test("retries follow-up with uploaded attachments when inline prompt is too large", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
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
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const clearComposerAttachments = vi.fn(async () => {});
    const uploadAttachmentFile = vi.fn(async () => true);
    const waitForAttachmentCompletion = vi.fn(async () => {});
    const waitForUserTurnAttachments = vi.fn(async () => true);
    const submitPrompt = vi
      .fn()
      .mockRejectedValueOnce(
        new BrowserAutomationError("too large", { code: "prompt-too-large", stage: "submit" }),
      )
      .mockResolvedValueOnce(3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "retry response",
      html: "",
      meta: { messageId: "m3", turnId: "conversation-turn-3" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "retry markdown");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      {
        prompt: "Huge inline context",
        fallbackSubmission: {
          prompt: "Fallback with uploads",
          attachments: [{ path: "/tmp/fallback.zip", displayPath: "fallback.zip", sizeBytes: 4 }],
        },
      },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        clearComposerAttachments,
        uploadAttachmentFile,
        waitForAttachmentCompletion,
        waitForUserTurnAttachments,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(submitPrompt).toHaveBeenCalledTimes(2);
    expect(uploadAttachmentFile).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ displayPath: "fallback.zip" }),
      logger,
      { expectedCount: 1 },
    );
    const loggerCalls = (logger as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(loggerCalls.some((call) => String(call[0]).includes("retrying with file uploads"))).toBe(
      true,
    );
    expect(result.answerMarkdown).toBe("retry markdown");
  });

  test("uses the fallback prompt preview for reconnect alignment after a prompt-too-large retry", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
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
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const clearComposerAttachments = vi.fn(async () => {});
    const uploadAttachmentFile = vi.fn(async () => true);
    const waitForAttachmentCompletion = vi.fn(async () => {});
    const waitForUserTurnAttachments = vi.fn(async () => true);
    const submitPrompt = vi
      .fn()
      .mockRejectedValueOnce(
        new BrowserAutomationError("too large", { code: "prompt-too-large", stage: "submit" }),
      )
      .mockResolvedValueOnce(3);
    const waitForAssistantResponse = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce({
        text: "Fallback with uploads",
        html: "",
        meta: { messageId: "m4", turnId: "conversation-turn-4" },
      });
    const captureAssistantMarkdown = vi.fn(async () => "final markdown");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      {
        prompt: "Huge inline context that will not fit",
        fallbackSubmission: {
          prompt: "Fallback with uploads",
          attachments: [{ path: "/tmp/fallback.zip", displayPath: "fallback.zip", sizeBytes: 4 }],
        },
      },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        clearComposerAttachments,
        uploadAttachmentFile,
        waitForAttachmentCompletion,
        waitForUserTurnAttachments,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    const loggerCalls = (logger as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(
      loggerCalls.some((call) =>
        String(call[0]).includes("Aligned prompt-echo text to copied markdown during reattach"),
      ),
    ).toBe(true);
  }, 10_000);
});

describe("reattach helpers", () => {
  const {
    pickTarget,
    extractConversationIdFromUrl,
    buildConversationUrl,
    conversationHrefMatchesConfiguredScope,
    mergeRuntimeMetadata,
    openConversationFromSidebar,
    isTransientReattachAnswer,
  } = __test__;
  type EvaluateParams = { expression: string };
  type EvaluateResult<T> = { result: { value: T } };

  test("extracts conversation id from a chat URL", () => {
    expect(extractConversationIdFromUrl("https://chatgpt.com/c/abc-123")).toBe("abc-123");
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
    expect(
      buildConversationUrl({ conversationId: "abc" }, "https://chatgpt.com/g/g-p-example/project"),
    ).toBe("https://chatgpt.com/g/g-p-example/project/c/abc");
    expect(
      buildConversationUrl(
        {
          tabUrl: "https://chatgpt.com/g/g-p-example-oracle/c/abc",
          conversationId: "abc",
        },
        "https://chatgpt.com/g/g-p-example/project",
      ),
    ).toBe("https://chatgpt.com/g/g-p-example-oracle/c/abc");
  });

  test("rejects root-scoped chat urls when a project-scoped base is required", () => {
    const projectUrl = "https://chatgpt.com/g/g-p-example/project";

    expect(conversationHrefMatchesConfiguredScope(`${projectUrl}/c/abc`, projectUrl)).toBe(true);
    expect(
      conversationHrefMatchesConfiguredScope(
        "https://chatgpt.com/g/g-p-example-oracle/c/abc",
        projectUrl,
      ),
    ).toBe(true);
    expect(
      conversationHrefMatchesConfiguredScope(
        "https://chatgpt.com/g/g-p-example-other/c/abc",
        projectUrl,
      ),
    ).toBe(false);
    expect(conversationHrefMatchesConfiguredScope("https://chatgpt.com/c/abc", projectUrl)).toBe(
      false,
    );
  });

  test("root-scoped supervisor scope only accepts root chatgpt tabs and root conversations", () => {
    expect(
      conversationHrefMatchesConfiguredScope("https://chatgpt.com/", "https://chatgpt.com/"),
    ).toBe(true);
    expect(
      conversationHrefMatchesConfiguredScope(
        "https://chatgpt.com/c/root-thread",
        "https://chatgpt.com/",
      ),
    ).toBe(true);
    expect(
      conversationHrefMatchesConfiguredScope(
        "https://chatgpt.com/g/g-p-example/project",
        "https://chatgpt.com/",
      ),
    ).toBe(true);
    expect(
      conversationHrefMatchesConfiguredScope(
        "https://chatgpt.com/g/g-p-example-oracle/c/root-thread",
        "https://chatgpt.com/",
      ),
    ).toBe(true);
    expect(
      conversationHrefMatchesConfiguredScope("https://example.com/docs", "https://chatgpt.com/"),
    ).toBe(false);
  });

  test("treats finalizing-answer status as transient during reattach", () => {
    expect(isTransientReattachAnswer("ChatGPT said:\nFinalizing answer")).toBe(true);
    expect(isTransientReattachAnswer("Finalizing answer")).toBe(true);
    expect(isTransientReattachAnswer("ChatGPT said:Pro thinking")).toBe(true);
    expect(isTransientReattachAnswer("Pro thinking")).toBe(true);
    expect(isTransientReattachAnswer("Real answer text")).toBe(false);
  });

  test("mergeRuntimeMetadata refreshes runtime hints after relaunch", () => {
    expect(
      mergeRuntimeMetadata(
        {
          chromePid: 11,
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          userDataDir: "/tmp/old",
          tabUrl: "https://chatgpt.com/c/old",
        },
        {
          chromePid: 22,
          chromePort: 9333,
          userDataDir: "/tmp/new",
          tabUrl: "https://chatgpt.com/c/new",
          controllerPid: 44,
        },
      ),
    ).toMatchObject({
      chromePid: 22,
      chromePort: 9333,
      userDataDir: "/tmp/new",
      conversationId: "new",
      controllerPid: 44,
    });
  });

  test("pickTarget prefers chromeTargetId, then tabUrl, then a safe unique fallback page", () => {
    const targets = [
      { targetId: "t-docs", type: "page", url: "https://example.com/docs" },
      { targetId: "t-chat", type: "page", url: "https://chatgpt.com/c/first" },
      { targetId: "t-worker", type: "other", url: "https://chatgpt.com/backend" },
    ];
    expect(pickTarget(targets, { chromeTargetId: "t-chat" })).toEqual(targets[1]);
    expect(pickTarget(targets, { tabUrl: "https://chatgpt.com/c/first" })).toEqual(targets[1]);
    expect(pickTarget(targets, {})).toEqual(targets[1]);
    expect(
      pickTarget(targets, {
        tabUrl: "https://chatgpt.com/c/missing",
        conversationId: "missing",
      }),
    ).toBeUndefined();
  });

  test("pickTarget can reuse a matched non-page conversation target", () => {
    const targets = [
      { targetId: "t-docs", type: "page", url: "https://example.com/docs" },
      {
        targetId: "t-chat",
        type: "other",
        url: "https://chatgpt.com/c/right-thread",
      },
    ];

    expect(
      pickTarget(targets, {
        chromeTargetId: "stale-target",
        tabUrl: "https://chatgpt.com/c/right-thread",
        conversationId: "right-thread",
      }),
    ).toEqual(targets[1]);
  });

  test("pickTarget prefers the project shell page over a non-page project conversation target", () => {
    const targets = [
      { targetId: "t-project", type: "page", url: "https://chatgpt.com/g/g-p-example/project" },
      {
        targetId: "t-chat",
        type: "other",
        url: "https://chatgpt.com/g/g-p-example/project/c/right-thread",
      },
    ];

    expect(
      pickTarget(targets, {
        chromeTargetId: "stale-target",
        tabUrl: "https://chatgpt.com/g/g-p-example/project/c/right-thread",
        conversationId: "right-thread",
      }),
    ).toEqual(targets[0]);
  });

  test("pickTarget prefers an interactive project shell over a project conversation shadow target", () => {
    const targets = [
      {
        targetId: "t-shadow",
        type: "other",
        url: "https://chatgpt.com/g/g-p-example/project/c/right-thread",
      },
      { targetId: "t-project", type: "page", url: "https://chatgpt.com/g/g-p-example/project" },
      { targetId: "t-other", type: "page", url: "https://chatgpt.com/g/g-p-other/project" },
    ];

    expect(
      pickTarget(targets, {
        chromeTargetId: "stale-target",
        tabUrl: "https://chatgpt.com/g/g-p-example-oracle/c/right-thread",
        conversationId: "right-thread",
      }),
    ).toEqual(targets[1]);
  });

  test("pickTarget treats slugged project conversation shadow targets as non-attachable", () => {
    const targets = [
      {
        targetId: "t-shadow",
        type: "other",
        url: "https://chatgpt.com/g/g-p-example-oracle/c/right-thread",
      },
      { targetId: "t-project", type: "page", url: "https://chatgpt.com/g/g-p-example/project" },
    ];

    expect(
      pickTarget(targets, {
        chromeTargetId: "stale-target",
        tabUrl: "https://chatgpt.com/g/g-p-example-oracle/c/right-thread",
        conversationId: "right-thread",
      }),
    ).toEqual(targets[1]);
  });

  test("pickTarget fails closed when metadata is missing and multiple chat pages are open", () => {
    const targets = [
      { targetId: "t-1", type: "page", url: "https://chatgpt.com/c/first" },
      { targetId: "t-2", type: "page", url: "https://chatgpt.com/c/second" },
      { targetId: "t-3", type: "page", url: "about:blank" },
    ];

    expect(pickTarget(targets, {})).toBeUndefined();
  });

  test("pickTarget accepts raw CDP ids when targetId is absent", () => {
    const targets = [
      { id: "t-1", type: "page", url: "https://chatgpt.com/c/first" },
      { id: "t-2", type: "page", url: "https://chatgpt.com/c/second" },
    ];

    expect(pickTarget(targets, { chromeTargetId: "t-2" })).toEqual(targets[1]);
  });

  test("pickTarget refuses non-chat page targets even when chromeTargetId points at them", () => {
    const targets = [
      { targetId: "t-docs", type: "page", url: "https://example.com/docs" },
      { targetId: "t-chat", type: "page", url: "https://chatgpt.com/c/first" },
    ];

    expect(pickTarget(targets, { chromeTargetId: "t-docs" })).toBeUndefined();
  });

  test("pickTarget ignores a stale chromeTargetId when tabUrl points elsewhere", () => {
    const targets = [
      { targetId: "t-stale", type: "page", url: "https://chatgpt.com/c/old-thread" },
      { targetId: "t-fresh", type: "page", url: "https://chatgpt.com/c/new-thread" },
    ];

    expect(
      pickTarget(targets, {
        chromeTargetId: "t-stale",
        tabUrl: "https://chatgpt.com/c/new-thread",
        conversationId: "new-thread",
      }),
    ).toEqual(targets[1]);
  });

  test("pickTarget derives conversation identity from runtime tabUrl", () => {
    const targets = [
      { targetId: "t-wrong", type: "page", url: "https://chatgpt.com/c/other-thread" },
      { targetId: "t-right", type: "page", url: "https://chatgpt.com/c/right-thread" },
    ];

    expect(
      pickTarget(targets, {
        chromeTargetId: "t-missing",
        tabUrl: "https://chatgpt.com/g/g-p-example/project/c/right-thread",
      }),
    ).toEqual(targets[1]);
  });

  test("pickTarget can reuse a unique chat shell to reopen a missing conversation", () => {
    const targets = [{ targetId: "t-home", type: "page", url: "https://chatgpt.com/" }];

    expect(
      pickTarget(targets, {
        tabUrl: "https://chatgpt.com/g/g-p-example-oracle/c/right-thread",
        conversationId: "right-thread",
      }),
    ).toEqual(targets[0]);
  });

  test("hidden reusable manual-login runtimes require conversation identity metadata", async () => {
    const logger = vi.fn() as BrowserLogger;

    await expect(
      resumeBrowserSession(
        {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          userDataDir: "/tmp/oracle-hidden",
        },
        {
          manualLogin: true,
          keepBrowser: true,
          hideWindow: true,
          manualLoginProfileDir: "/tmp/oracle-hidden",
        },
        logger,
        {},
      ),
    ).rejects.toThrow(/conversation identity/i);
  });

  test("falls back to recovery instead of accepting a stale repeated follow-up response", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        chromePort: 51559,
        chromeHost: "127.0.0.1",
        chromeTargetId: "target-1",
        tabUrl: "https://chatgpt.com/c/abc",
        conversationId: "abc",
      };
      const listTargets = vi.fn(
        async () =>
          [
            { targetId: "target-1", type: "page", url: runtime.tabUrl },
            { targetId: "target-2", type: "page", url: "about:blank" },
          ] satisfies FakeTarget[],
      ) as unknown as () => Promise<FakeTarget[]>;
      const staleAnswer = {
        text: "O1_1775533302",
        html: "<p>O1_1775533302</p>",
        messageId: "m-old",
        turnId: "tid-old",
        turnIndex: null,
      };
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "location.href") {
          return { result: { value: runtime.tabUrl } };
        }
        if (expression === "1+1") {
          return { result: { value: 2 } };
        }
        if (expression.includes("extractAssistantTurn")) {
          return { result: { value: staleAnswer } };
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
      const waitForAssistantResponse = vi.fn(async () => ({
        text: staleAnswer.text,
        html: staleAnswer.html,
        meta: { messageId: staleAnswer.messageId, turnId: staleAnswer.turnId },
      }));
      const captureAssistantMarkdown = vi.fn(async () => staleAnswer.text);
      const recoverSession = vi.fn(async () => ({
        answerText: "fresh-via-recovery",
        answerMarkdown: "fresh-via-recovery",
      }));
      const logger = vi.fn() as BrowserLogger;
      logger.verbose = true;

      const promise = resumeBrowserSession(
        runtime,
        { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
        logger,
        {
          listTargets,
          connect,
          waitForAssistantResponse,
          captureAssistantMarkdown,
          recoverSession,
          promptPreview: "Run pwd in the workspace and reply with the exact result.",
          baselineTurns: 7,
          baselineAssistant: {
            text: staleAnswer.text,
            messageId: staleAnswer.messageId,
            turnId: staleAnswer.turnId,
          },
        },
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await promise;

      expect(result.answerText).toBe("fresh-via-recovery");
      expect(result.answerMarkdown).toBe("fresh-via-recovery");
      expect(recoverSession).toHaveBeenCalled();
      expect(logger).toHaveBeenCalledWith(
        "Detected stale assistant response; waiting for new response...",
      );
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  test("continueBrowserSession refuses to continue on an arbitrary existing chat when runtime identity is missing", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: "https://chatgpt.com/c/unrelated-thread" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: "https://chatgpt.com/c/unrelated-thread" } };
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
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 1);
    const logger = vi.fn() as BrowserLogger;

    await expect(
      continueBrowserSession(
        runtime,
        { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
        logger,
        { prompt: "Reply with exactly hello." },
        {
          listTargets,
          connect,
          ensurePromptReady,
          clearPromptComposer,
          submitPrompt,
        },
      ),
    ).rejects.toThrow(/missing a conversation identity/i);

    expect(ensurePromptReady).not.toHaveBeenCalled();
    expect(clearPromptComposer).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
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
    expect(call?.expression).toContain("const allowLooseFallback = !conversationId");
    expect(call?.expression).toContain("const preferProjects = true");
    expect(call?.expression).toContain("preferProjects ? pick(navItems) || pick(mainItems)");
  });

  test("openConversationFromSidebar skips loose sidebar fallback when conversationId is present", async () => {
    const evaluate = vi.fn<
      (
        params: EvaluateParams,
      ) => Promise<EvaluateResult<{ ok: boolean; href?: string; count: number }>>
    >(async () => ({
      result: { value: { ok: false, count: 0 } },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const ok = await openConversationFromSidebar(runtime, {
      conversationId: "abc",
      preferProjects: true,
      promptPreview: "this prompt should not drive fallback matching",
    });

    expect(ok).toBe(false);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain(
      "if (!target && allowLooseFallback && promptNeedles.length > 0)",
    );
    expect(call?.expression).toContain("if (!target && allowLooseFallback) {");
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

describe("__test__.pickTarget", () => {
  test("ignores a stale cached target id when it points at a different conversation in the same project", () => {
    const picked = __test__.pickTarget(
      [
        {
          targetId: "stale-target",
          type: "page",
          url: "https://chatgpt.com/g/team-space-oracle/c/wrong-thread",
        },
        {
          targetId: "fresh-target",
          type: "page",
          url: "https://chatgpt.com/g/team-space-oracle/c/right-thread",
        },
      ],
      {
        chromeTargetId: "stale-target",
        tabUrl: "https://chatgpt.com/g/team-space-oracle/c/right-thread",
        conversationId: "right-thread",
      },
      { requireMatch: true },
    );

    expect(picked).toEqual({
      targetId: "fresh-target",
      type: "page",
      url: "https://chatgpt.com/g/team-space-oracle/c/right-thread",
    });
  });
});
