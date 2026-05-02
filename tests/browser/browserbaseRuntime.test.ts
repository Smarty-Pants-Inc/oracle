import { afterEach, describe, expect, test, vi } from "vitest";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";

type BrowserbaseClientInstance = {
  createContext: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  getDebugUrls: ReturnType<typeof vi.fn>;
  requestSessionRelease: ReturnType<typeof vi.fn>;
};

type RuntimeHarness = {
  browserbaseInstances: BrowserbaseClientInstance[];
  connectToRemoteChrome: ReturnType<typeof vi.fn>;
  launchChrome: ReturnType<typeof vi.fn>;
  startChromeFocusGuard: ReturnType<typeof vi.fn>;
  hideChromeWindow: ReturnType<typeof vi.fn>;
  registerTerminationHooks: ReturnType<typeof vi.fn>;
  cleanupStaleProfileState: ReturnType<typeof vi.fn>;
  acquireProfileRunLock: ReturnType<typeof vi.fn>;
};

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("runBrowserMode Browserbase runtime integration", () => {
  test("creates a Browserbase session, uses remote websocket CDP, skips local Chrome lifecycle, persists runtime metadata, and releases when not keepAlive", async () => {
    const harness = mockBrowserRuntime({
      keepAlive: false,
      connectUrl: "wss://connect.browserbase.com/devtools/browser/bb-session-1",
    });
    const { runBrowserMode } = await import("../../src/browser/index.js");
    const runtimeHints: unknown[] = [];
    const logger = vi.fn() as BrowserLogger;
    logger.sessionLog = vi.fn();

    const result = await runBrowserMode({
      prompt: "Use Browserbase.",
      runtimeHintCb: async (hint) => {
        runtimeHints.push(hint);
      },
      log: logger,
      config: {
        browserbase: {
          enabled: true,
          apiKey: "bb_key",
          projectId: "proj_123",
          contextId: "ctx_123",
          persist: true,
          keepAlive: false,
          region: "us-west-2",
          timeoutMs: 60_000,
          viewport: { width: 1280, height: 720 },
        },
        chromePath: "/Applications/Local Chrome.app/Contents/MacOS/Google Chrome",
        cookieSync: true,
        hideWindow: true,
        manualLoginProfileDir: "/tmp/local-profile-must-not-be-used",
        modelStrategy: "ignore",
      },
    });

    const browserbase = harness.browserbaseInstances[0];
    expect(browserbase.createContext).not.toHaveBeenCalled();
    expect(browserbase.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_123",
        contextId: "ctx_123",
        persistContext: true,
        keepAlive: false,
        region: "us-west-2",
        timeout: 60,
        browserSettings: expect.objectContaining({
          viewport: { width: 1280, height: 720 },
        }),
      }),
    );
    expect(harness.connectToRemoteChrome).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      logger,
      expect.any(String),
      "wss://connect.browserbase.com/devtools/browser/bb-session-1",
      expect.objectContaining({ closeTargetOnDispose: true }),
    );
    expect(harness.launchChrome).not.toHaveBeenCalled();
    expect(harness.startChromeFocusGuard).not.toHaveBeenCalled();
    expect(harness.hideChromeWindow).not.toHaveBeenCalled();
    expect(harness.registerTerminationHooks).not.toHaveBeenCalled();
    expect(harness.cleanupStaleProfileState).not.toHaveBeenCalled();
    expect(harness.acquireProfileRunLock).not.toHaveBeenCalled();
    expect(runtimeHints).toContainEqual(
      expect.objectContaining({
        browserTransport: "cdp",
        browserbaseSessionId: "bb-session-1",
        browserbaseProjectId: "proj_123",
        chromeBrowserWSEndpoint: "wss://connect.browserbase.com/devtools/browser/bb-session-1",
        chromeTargetId: "target-browserbase",
        userDataDir: undefined,
      }),
    );
    expect(result).toMatchObject({
      browserTransport: "cdp",
      browserbaseSessionId: "bb-session-1",
      browserbaseProjectId: "proj_123",
      chromeBrowserWSEndpoint: "wss://connect.browserbase.com/devtools/browser/bb-session-1",
      userDataDir: undefined,
      answerMarkdown: "Browserbase answer",
    });
    expect(browserbase.requestSessionRelease).toHaveBeenCalledWith("bb-session-1", "proj_123");
  });

  test("keeps the Browserbase session alive when keepAlive is enabled", async () => {
    const harness = mockBrowserRuntime({
      keepAlive: true,
      connectUrl: "wss://connect.browserbase.com/devtools/browser/bb-session-keep",
    });
    const { runBrowserMode } = await import("../../src/browser/index.js");
    const logger = vi.fn() as BrowserLogger;
    const runtimeHints: unknown[] = [];

    await runBrowserMode({
      prompt: "Keep Browserbase alive.",
      log: logger,
      runtimeHintCb: async (hint) => {
        runtimeHints.push(hint);
      },
      config: {
        browserbase: {
          enabled: true,
          apiKey: "bb_key",
          projectId: "proj_123",
          keepAlive: true,
        },
        modelStrategy: "ignore",
      },
    });

    const browserbase = harness.browserbaseInstances[0];
    expect(browserbase.createContext).toHaveBeenCalledWith({ projectId: "proj_123" });
    expect(browserbase.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ contextId: "ctx_created", keepAlive: true }),
    );
    expect(runtimeHints).toContainEqual(
      expect.objectContaining({ browserbaseSessionId: "bb-session-keep" }),
    );
    expect(browserbase.requestSessionRelease).not.toHaveBeenCalled();
  });

  test("releases a keep-alive Browserbase session when setup fails before metadata is persisted", async () => {
    const harness = mockBrowserRuntime({
      keepAlive: true,
      connectUrl: undefined,
    });
    const { runBrowserMode } = await import("../../src/browser/index.js");
    const logger = vi.fn() as BrowserLogger;

    await expect(
      runBrowserMode({
        prompt: "Keep Browserbase alive only after handoff.",
        log: logger,
        config: {
          browserbase: {
            enabled: true,
            apiKey: "bb_key",
            projectId: "proj_123",
            keepAlive: true,
          },
          modelStrategy: "ignore",
        },
      }),
    ).rejects.toThrow(/did not return a CDP connectUrl/i);

    const browserbase = harness.browserbaseInstances[0];
    expect(browserbase.requestSessionRelease).toHaveBeenCalledWith("bb-session-keep", "proj_123");
  });

  test("propagates the created Browserbase context project id when explicit project id is absent", async () => {
    vi.stubEnv("ORACLE_BROWSERBASE_PROJECT_ID", "");
    vi.stubEnv("BROWSERBASE_PROJECT_ID", "");
    const harness = mockBrowserRuntime({
      keepAlive: false,
      connectUrl: "wss://connect.browserbase.com/devtools/browser/bb-session-1",
    });
    const { runBrowserMode } = await import("../../src/browser/index.js");
    const logger = vi.fn() as BrowserLogger;

    const result = await runBrowserMode({
      prompt: "Use Browserbase.",
      log: logger,
      config: {
        browserbase: {
          enabled: true,
          apiKey: "bb_key",
        },
        modelStrategy: "ignore",
      },
    });

    const browserbase = harness.browserbaseInstances[0];
    expect(browserbase.createContext).toHaveBeenCalledWith({ projectId: undefined });
    expect(browserbase.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ contextId: "ctx_created", projectId: "proj_123" }),
    );
    expect(result.browserbaseProjectId).toBe("proj_123");
    expect(browserbase.requestSessionRelease).toHaveBeenCalledWith("bb-session-1", "proj_123");
  });

  test("rejects Browserbase timeouts outside the provider range", async () => {
    mockBrowserRuntime({
      keepAlive: false,
      connectUrl: "wss://connect.browserbase.com/devtools/browser/bb-session-1",
    });
    const { runBrowserMode } = await import("../../src/browser/index.js");
    const logger = vi.fn() as BrowserLogger;

    await expect(
      runBrowserMode({
        prompt: "Use Browserbase.",
        log: logger,
        config: {
          browserbase: {
            enabled: true,
            apiKey: "bb_key",
            projectId: "proj_123",
            timeoutMs: 30_000,
          },
          modelStrategy: "ignore",
        },
      }),
    ).rejects.toThrow(/between 60s and 6h/i);
  });

  test("releases the Browserbase session when remote CDP setup fails", async () => {
    const harness = mockBrowserRuntime({
      keepAlive: false,
      connectUrl: "wss://connect.browserbase.com/devtools/browser/bb-session-1",
      connectFails: true,
    });
    const { runBrowserMode } = await import("../../src/browser/index.js");
    const logger = vi.fn() as BrowserLogger;

    await expect(
      runBrowserMode({
        prompt: "Use Browserbase.",
        log: logger,
        config: {
          browserbase: {
            enabled: true,
            apiKey: "bb_key",
            projectId: "proj_123",
            contextId: "ctx_123",
          },
          modelStrategy: "ignore",
        },
      }),
    ).rejects.toThrow(/CDP unavailable/i);

    const browserbase = harness.browserbaseInstances[0];
    expect(browserbase.requestSessionRelease).toHaveBeenCalledWith("bb-session-1", "proj_123");
  });
});

function mockBrowserRuntime({
  keepAlive,
  connectUrl,
  connectFails = false,
}: {
  keepAlive: boolean;
  connectUrl: string | undefined;
  connectFails?: boolean;
}): RuntimeHarness {
  const browserbaseInstances: BrowserbaseClientInstance[] = [];
  const createSession = vi.fn(async () => ({
    id: keepAlive ? "bb-session-keep" : "bb-session-1",
    projectId: "proj_123",
    status: "RUNNING",
    connectUrl,
    contextId: keepAlive ? "ctx_created" : "ctx_123",
  }));
  const createContext = vi.fn(async () => ({
    id: "ctx_created",
    projectId: "proj_123",
  }));
  const getDebugUrls = vi.fn(async () => ({
    debuggerFullscreenUrl: "https://browserbase.example/full",
    debuggerUrl: "https://browserbase.example",
    pages: [],
    wsUrl: connectUrl,
  }));
  const requestSessionRelease = vi.fn(async () => ({
    id: "bb-session-1",
    projectId: "proj_123",
    status: "COMPLETED",
  }));

  vi.doMock("../../src/browser/browserbase.js", () => ({
    BrowserbaseClient: vi.fn().mockImplementation(function BrowserbaseClient() {
      const instance = { createContext, createSession, getDebugUrls, requestSessionRelease };
      browserbaseInstances.push(instance);
      return instance;
    }),
  }));
  vi.doMock("../../src/browser/cookies.js", () => ({
    syncCookies: vi.fn(async () => 2),
  }));

  const client = makeChromeClient();
  const connectToRemoteChrome = vi.fn(async () => {
    if (connectFails) {
      throw new Error("CDP unavailable");
    }
    return {
      client: client as unknown as ChromeClient,
      targetId: "target-browserbase",
      browserWSEndpoint: connectUrl,
      close: vi.fn(async () => {}),
    };
  });
  const launchChrome = vi.fn(async () => {
    throw new Error("Browserbase mode must not launch local Chrome.");
  });
  const startChromeFocusGuard = vi.fn(() => {
    throw new Error("Browserbase mode must not start the local Chrome focus guard.");
  });
  const hideChromeWindow = vi.fn(async () => {
    throw new Error("Browserbase mode must not hide a local Chrome window.");
  });
  const registerTerminationHooks = vi.fn(() => vi.fn());

  vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
    const original = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
      "../../src/browser/chromeLifecycle.js",
    );
    return {
      ...original,
      connectToRemoteChrome,
      launchChrome,
      startChromeFocusGuard,
      hideChromeWindow,
      registerTerminationHooks,
    };
  });

  vi.doMock("../../src/browser/pageActions.js", async () => {
    const original = await vi.importActual<typeof import("../../src/browser/pageActions.js")>(
      "../../src/browser/pageActions.js",
    );
    return {
      ...original,
      navigateToChatGPT: vi.fn(async () => {}),
      navigateToPromptReadyWithFallback: vi.fn(async () => {}),
      ensureNotBlocked: vi.fn(async () => {}),
      ensureLoggedIn: vi.fn(async () => {}),
      ensureBackendApiReachable: vi.fn(async () => {}),
      ensurePromptReady: vi.fn(async () => {}),
      installJavaScriptDialogAutoDismissal: vi.fn(() => vi.fn()),
      clearPromptComposer: vi.fn(async () => {}),
      clearComposerAttachments: vi.fn(async () => {}),
      uploadAttachmentFile: vi.fn(async () => true),
      waitForAttachmentCompletion: vi.fn(async () => {}),
      waitForUserTurnAttachments: vi.fn(async () => ({ matched: true })),
      readAssistantSnapshot: vi.fn(async () => ({
        text: "Previous assistant",
        html: "<p>Previous assistant</p>",
        turnId: "turn-1",
        messageId: "message-1",
      })),
      waitForAssistantResponse: vi.fn(async () => ({
        text: "Browserbase answer",
        html: "<p>Browserbase answer</p>",
        meta: { turnId: "turn-1", messageId: "message-1" },
      })),
      captureAssistantMarkdown: vi.fn(async () => "Browserbase answer"),
    };
  });

  vi.doMock("../../src/browser/providerDomFlow.js", () => ({
    runProviderSubmissionFlow: vi.fn(async () => {}),
  }));
  vi.doMock("../../src/browser/playwrightDownloads.js", () => ({
    captureAssistantDownloads: vi.fn(async () => []),
  }));

  const cleanupStaleProfileState = vi.fn(async () => {});
  const acquireProfileRunLock = vi.fn(async () => ({ release: vi.fn(async () => {}) }));
  vi.doMock("../../src/browser/profileState.js", async () => {
    const original = await vi.importActual<typeof import("../../src/browser/profileState.js")>(
      "../../src/browser/profileState.js",
    );
    return {
      ...original,
      cleanupStaleProfileState,
      acquireProfileRunLock,
    };
  });

  return {
    browserbaseInstances,
    connectToRemoteChrome,
    launchChrome,
    startChromeFocusGuard,
    hideChromeWindow,
    registerTerminationHooks,
    cleanupStaleProfileState,
    acquireProfileRunLock,
  };
}

function makeChromeClient() {
  const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
    if (expression === "location.href") {
      return { result: { value: "https://chatgpt.com/c/browserbase-thread" } };
    }
    if (expression.includes("turnCount")) {
      return {
        result: {
          value: {
            href: "https://chatgpt.com/c/browserbase-thread",
            inConversation: true,
            turnCount: 2,
          },
        },
      };
    }
    if (expression.includes("window.location.href") || expression.includes("location.href")) {
      return { result: { value: "https://chatgpt.com/c/browserbase-thread" } };
    }
    return { result: { value: null } };
  });
  return {
    Network: { enable: vi.fn(async () => {}) },
    Page: { enable: vi.fn(async () => {}), navigate: vi.fn(async () => {}) },
    Runtime: { enable: vi.fn(async () => {}), evaluate },
    DOM: { enable: vi.fn(async () => {}) },
    Input: {},
    Target: {
      getTargetInfo: vi.fn(async () => ({
        targetInfo: {
          targetId: "target-browserbase",
          url: "https://chatgpt.com/c/browserbase-thread",
        },
      })),
    },
    on: vi.fn(),
    close: vi.fn(async () => {}),
  };
}
