import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { __test__ } from "../../src/cli/supervisorBrokerRuntime.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

const HIDDEN_PROFILE_DIR = path.join(os.homedir(), ".oracle", "browser-profile-hidden");
const SUPERVISOR_PROJECT_URL = "https://chatgpt.com/g/team-space/project";
const SUPERVISOR_CONVERSATION_ROOT = "https://chatgpt.com/g/team-space";
const SUPERVISOR_ORACLE_CONVERSATION_ROOT = "https://chatgpt.com/g/team-space-oracle";
const SUPERVISOR_ORACLE_PROJECT_URL = `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/project`;

function runtimeSession(
  id: string,
  status: SessionMetadata["status"],
  startedAt: string,
): SessionMetadata {
  const conversationId = id.replace(/[^a-zA-Z0-9-]/g, "-");
  return {
    id,
    createdAt: startedAt,
    startedAt,
    status,
    options: { model: "gpt-5.5-pro" },
    browser: {
      runtime: {
        chromePort: 9222,
        tabUrl: `${SUPERVISOR_CONVERSATION_ROOT}/c/${conversationId}`,
        conversationId,
      },
      config: {
        manualLogin: true,
        keepBrowser: true,
        hideWindow: true,
        attachRunning: false,
        launcher: "chrome",
        manualLoginProfileDir: HIDDEN_PROFILE_DIR,
        chatgptUrl: SUPERVISOR_PROJECT_URL,
      },
    },
  };
}

function browserbaseRuntimeSession(
  id: string,
  status: SessionMetadata["status"],
  startedAt: string,
): SessionMetadata {
  const conversationId = id.replace(/[^a-zA-Z0-9-]/g, "-");
  return {
    id,
    createdAt: startedAt,
    startedAt,
    status,
    options: { model: "gpt-5.5-pro" },
    browser: {
      runtime: {
        browserProvider: "browserbase",
        browserbaseSessionId: `bb-${conversationId}`,
        browserbaseProjectId: "bb-project",
        browserbaseContextId: "bb-context",
        browserbaseKeepAlive: true,
        chromeHost: "connect.browserbase.com",
        chromePort: 443,
        chromeBrowserWSEndpoint: `wss://connect.browserbase.com/devtools/browser/bb-${conversationId}`,
        tabUrl: `${SUPERVISOR_CONVERSATION_ROOT}/c/${conversationId}`,
        conversationId,
      },
      config: {
        manualLogin: true,
        keepBrowser: true,
        attachRunning: false,
        manualLoginProfileDir: null,
        chatgptUrl: SUPERVISOR_PROJECT_URL,
        browserbase: {
          enabled: true,
          projectId: "bb-project",
          contextId: "bb-context",
          keepAlive: true,
        },
      },
    },
  };
}

afterEach(() => {
  vi.doUnmock("../../src/browser/browserbase.js");
  vi.doUnmock("../../src/browser/chromeLifecycle.js");
  vi.doUnmock("../../src/browser/cookies.js");
  vi.doUnmock("../../src/browser/detect.js");
  vi.doUnmock("../../src/browser/playwrightSupervisor.js");
  vi.doUnmock("../../src/browser/profileState.js");
  vi.doUnmock("../../src/sessionStore.js");
  vi.doUnmock("chrome-remote-interface");
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("supervisorBrokerRuntime", () => {
  test("uses a configurable supervisor runtime CDP command timeout", () => {
    expect(__test__.supervisorRuntimeCdpCommandTimeoutMs({})).toBe(30_000);
    expect(
      __test__.supervisorRuntimeCdpCommandTimeoutMs({
        ORACLE_SUPERVISOR_RUNTIME_CDP_COMMAND_TIMEOUT_MS: "120000",
      }),
    ).toBe(120_000);
    expect(
      __test__.supervisorRuntimeCdpCommandTimeoutMs({
        ORACLE_SUPERVISOR_RUNTIME_CDP_COMMAND_TIMEOUT_MS: "nope",
      }),
    ).toBe(30_000);
  });

  test("fails slow supervisor runtime CDP commands with the configured timeout", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ORACLE_SUPERVISOR_RUNTIME_CDP_COMMAND_TIMEOUT_MS", "25");
    try {
      const pending = expect(
        __test__.withSupervisorRuntimeCdpTimeout(new Promise(() => {}), "testing Runtime"),
      ).rejects.toThrow(/Timed out testing Runtime after 25ms/);

      await vi.advanceTimersByTimeAsync(25);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  test("prefers supervisor-style hidden runtimes over attach-running sessions", () => {
    const picked = __test__.pickReusableRuntimeCandidate([
      {
        ...runtimeSession("attach-running-newer", "running", "2026-03-31T10:05:00.000Z"),
        browser: {
          runtime: {
            chromePort: 9222,
          },
          config: {
            attachRunning: true,
          },
        },
      },
      {
        ...runtimeSession("manual-login-older", "completed", "2026-03-31T10:00:00.000Z"),
        browser: {
          runtime: {
            chromePort: 53332,
          },
          config: {
            manualLogin: true,
            keepBrowser: true,
            hideWindow: true,
            attachRunning: false,
            manualLoginProfileDir: HIDDEN_PROFILE_DIR,
            chatgptUrl: SUPERVISOR_PROJECT_URL,
          },
        },
      },
    ]);

    expect(picked?.id).toBe("manual-login-older");
  });

  test("uses the requested supervisor browser provider when picking reusable runtimes", () => {
    const localHidden = runtimeSession("local-hidden", "completed", "2026-03-31T10:05:00.000Z");
    const browserbase = browserbaseRuntimeSession(
      "browserbase",
      "completed",
      "2026-03-31T10:00:00.000Z",
    );

    expect(__test__.pickReusableRuntimeCandidate([localHidden, browserbase])?.id).toBe(
      "local-hidden",
    );
    expect(
      __test__.pickReusableRuntimeCandidate([localHidden, browserbase], {
        browserProvider: "browserbase",
      })?.id,
    ).toBe("browserbase");
  });

  test("ignores attach-running sessions when no owned hidden runtime exists", () => {
    const picked = __test__.pickReusableRuntimeCandidate([
      {
        ...runtimeSession("attach-running-only", "running", "2026-03-31T10:05:00.000Z"),
        browser: {
          runtime: {
            chromePort: 9222,
          },
          config: {
            attachRunning: true,
          },
        },
      },
    ]);

    expect(picked).toBeUndefined();
  });

  test("rejects hidden runtimes pinned to the ChatGPT root", () => {
    const picked = __test__.pickReusableRuntimeCandidate([
      {
        ...runtimeSession("hidden-root-chat", "completed", "2026-03-31T10:05:00.000Z"),
        browser: {
          runtime: {
            chromePort: 9222,
            tabUrl: "https://chatgpt.com/c/hidden-root-chat",
            conversationId: "hidden-root-chat",
          },
          config: {
            manualLogin: true,
            keepBrowser: true,
            hideWindow: true,
            attachRunning: false,
            launcher: "chrome",
            manualLoginProfileDir: HIDDEN_PROFILE_DIR,
            chatgptUrl: "https://chatgpt.com/",
          },
        },
      },
    ]);

    expect(picked).toBeUndefined();
  });

  test("prefers completed reusable runtimes over running sessions", () => {
    const picked = __test__.pickReusableRuntimeCandidate([
      runtimeSession("completed-newer", "completed", "2026-03-31T10:05:00.000Z"),
      runtimeSession("running-older", "running", "2026-03-31T10:00:00.000Z"),
    ]);

    expect(picked?.id).toBe("completed-newer");
  });

  test("does not let dead-controller running sessions outrank newer completed runtimes", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      throw error;
    });

    const picked = __test__.pickReusableRuntimeCandidate([
      runtimeSession("completed-newer", "completed", "2026-03-31T10:05:00.000Z"),
      {
        ...runtimeSession("running-zombie", "running", "2026-03-31T10:00:00.000Z"),
        browser: {
          runtime: {
            chromePort: 9222,
            controllerPid: 4242,
          },
          config: {
            manualLogin: true,
            keepBrowser: true,
            hideWindow: true,
            attachRunning: false,
            launcher: "chrome",
            manualLoginProfileDir: HIDDEN_PROFILE_DIR,
            chatgptUrl: SUPERVISOR_PROJECT_URL,
          },
        },
      },
    ]);

    expect(spy).not.toHaveBeenCalled();
    expect(picked?.id).toBe("completed-newer");
  });

  test("falls back to the newest completed reusable runtime when nothing is running", () => {
    const picked = __test__.pickReusableRuntimeCandidate([
      runtimeSession("completed-older", "completed", "2026-03-31T10:00:00.000Z"),
      runtimeSession("completed-newer", "completed", "2026-03-31T10:05:00.000Z"),
    ]);

    expect(picked?.id).toBe("completed-newer");
  });

  test("prefers an unbound hidden runtime over a newer bound supervisor thread session", () => {
    const picked = __test__.pickReusableRuntimeCandidate([
      runtimeSession("root-runtime", "completed", "2026-03-31T10:00:00.000Z"),
      {
        ...runtimeSession("bound-thread-session", "completed", "2026-03-31T10:05:00.000Z"),
        supervisorThread: {
          conversationId: "bound-thread",
          url: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/bound-thread`,
          projectUrl: SUPERVISOR_PROJECT_URL,
          verifiedAt: "2026-03-31T10:05:00.000Z",
        },
      },
    ]);

    expect(picked?.id).toBe("root-runtime");
  });

  test("infers the canonical project scope from project conversation urls", () => {
    expect(
      __test__.inferSupervisorRuntimeScopeUrl({
        tabUrl: "https://chatgpt.com/g/team-space/c/expected",
        conversationId: "expected",
      }),
    ).toBe(SUPERVISOR_PROJECT_URL);
    expect(
      __test__.inferSupervisorRuntimeScopeUrl({
        tabUrl: "https://chatgpt.com/g/team-space-oracle/c/expected",
        conversationId: "expected",
      }),
    ).toBe(SUPERVISOR_ORACLE_PROJECT_URL);
  });

  test("accepts canonical project-shell recovery targets for the same normalized project family", () => {
    const picked = __test__.pickSafeSupervisorRecoveryTarget(
      [
        { targetId: "project-shell", type: "page", url: SUPERVISOR_PROJECT_URL },
        {
          targetId: "main-chat",
          type: "page",
          url: "https://chatgpt.com/c/main-thread",
        },
      ],
      {
        chromePort: 9222,
        tabUrl: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/expected`,
        conversationId: "expected",
      },
    );

    expect(picked?.targetId).toBe("project-shell");
  });

  test("accepts duplicate identical exact-scope project shell pages as a safe recovery target", () => {
    const picked = __test__.pickSafeSupervisorRecoveryTarget(
      [
        { targetId: "project-shell-1", type: "page", url: SUPERVISOR_PROJECT_URL },
        { targetId: "project-shell-2", type: "page", url: SUPERVISOR_PROJECT_URL },
      ],
      {
        chromePort: 9222,
        tabUrl: `${SUPERVISOR_CONVERSATION_ROOT}/c/expected`,
        conversationId: "expected",
      },
    );

    expect(picked?.targetId).toBe("project-shell-1");
  });

  test("accepts a unique ChatGPT shell page only when shell recovery is allowed", () => {
    const targets = [{ targetId: "chatgpt-shell", type: "page", url: "https://chatgpt.com/" }];
    const runtime = {
      chromePort: 9222,
      tabUrl: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/expected`,
      conversationId: "expected",
    };

    expect(__test__.pickSafeSupervisorRecoveryTarget(targets, runtime)).toBeUndefined();
    expect(
      __test__.pickSafeSupervisorRecoveryTarget(targets, runtime, {
        allowChatgptShellRecovery: true,
      })?.targetId,
    ).toBe("chatgpt-shell");
  });

  test("prefers the exact inferred project shell over the ChatGPT root shell during shell recovery", () => {
    const picked = __test__.pickSafeSupervisorRecoveryTarget(
      [
        { targetId: "chatgpt-shell-a", type: "page", url: "https://chatgpt.com/" },
        { targetId: "chatgpt-shell-b", type: "page", url: SUPERVISOR_PROJECT_URL },
      ],
      {
        chromePort: 9222,
        tabUrl: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/expected`,
        conversationId: "expected",
      },
      { allowChatgptShellRecovery: true },
    );

    expect(picked?.targetId).toBe("chatgpt-shell-b");
  });

  test("selects the exact inferred project shell when both canonical and slugged targets are present", () => {
    const picked = __test__.pickSafeSupervisorRecoveryTarget(
      [
        { targetId: "project-shell-1", type: "page", url: SUPERVISOR_PROJECT_URL },
        {
          targetId: "project-shell-2",
          type: "page",
          url: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/project`,
        },
      ],
      {
        chromePort: 9222,
        tabUrl: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/expected`,
        conversationId: "expected",
      },
    );

    expect(picked?.targetId).toBe("project-shell-2");
  });

  test("accepts the unique remaining page in the exact inferred project scope", () => {
    const picked = __test__.pickSafeSupervisorRecoveryTarget(
      [
        {
          targetId: "other-thread",
          type: "page",
          url: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/other-thread`,
        },
        {
          targetId: "main-chat",
          type: "page",
          url: "https://chatgpt.com/c/main-thread",
        },
      ],
      {
        chromePort: 9222,
        tabUrl: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/expected`,
        conversationId: "expected",
      },
    );

    expect(picked?.targetId).toBe("other-thread");
  });

  test("accepts a reachable runtime when only the unique project shell target remains", async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true });
    const listTargets = vi.fn(async () => [
      {
        targetId: "project-shell",
        type: "page",
        url: SUPERVISOR_PROJECT_URL,
      },
    ]);

    const picked = await __test__.pickReachableRuntimeCandidate(
      [
        {
          ...runtimeSession("shell-recoverable", "completed", "2026-03-31T10:05:00.000Z"),
          browser: {
            runtime: {
              chromeHost: "127.0.0.1",
              chromePort: 9222,
              tabUrl: `${SUPERVISOR_CONVERSATION_ROOT}/c/shell-recoverable`,
              conversationId: "shell-recoverable",
            },
            config: {
              manualLogin: true,
              keepBrowser: true,
              hideWindow: true,
              attachRunning: false,
              launcher: "chrome",
              manualLoginProfileDir: HIDDEN_PROFILE_DIR,
              chatgptUrl: SUPERVISOR_PROJECT_URL,
            },
          },
        },
      ],
      probe,
      listTargets,
    );

    expect(picked?.id).toBe("shell-recoverable");
    expect(listTargets).toHaveBeenCalledTimes(1);
  });

  test("uses Browserbase websocket target listing instead of local DevTools probing", async () => {
    vi.resetModules();
    vi.stubEnv("ORACLE_BROWSERBASE_API_KEY", "bb-test-key");
    const getSession = vi.fn(async () => ({
      id: "bb-browserbase",
      projectId: "bb-project",
      contextId: "bb-context",
      status: "RUNNING" as const,
      connectUrl: "wss://connect.browserbase.com/devtools/browser/bb-browserbase",
    }));
    vi.doMock("../../src/browser/browserbase.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/browserbase.js")>(
        "../../src/browser/browserbase.js",
      );
      return {
        ...original,
        BrowserbaseClient: vi.fn().mockImplementation(function BrowserbaseClient() {
          return { getSession };
        }),
      };
    });
    const { __test__: runtimeTest } = await import("../../src/cli/supervisorBrokerRuntime.js");
    const probe = vi.fn();
    const listTargets = vi.fn(async () => [
      {
        targetId: "browserbase-target",
        type: "page",
        url: `${SUPERVISOR_CONVERSATION_ROOT}/c/browserbase`,
      },
    ]);

    const picked = await runtimeTest.pickReachableRuntimeCandidate(
      [browserbaseRuntimeSession("browserbase", "completed", "2026-03-31T10:05:00.000Z")],
      probe,
      listTargets,
      { browserProvider: "browserbase" },
    );

    expect(picked?.id).toBe("browserbase");
    expect(probe).not.toHaveBeenCalled();
    expect(listTargets).toHaveBeenCalledWith({
      host: "connect.browserbase.com",
      port: 443,
      browserWSEndpoint: "wss://connect.browserbase.com/devtools/browser/bb-browserbase",
    });
  });

  test("seeds ChatGPT cookies before persisting a Browserbase supervisor shell", async () => {
    vi.resetModules();
    vi.stubEnv("ORACLE_BROWSERBASE_ENABLED", "1");
    vi.stubEnv("ORACLE_BROWSERBASE_API_KEY", "bb-test-key");
    vi.stubEnv("ORACLE_BROWSERBASE_PROJECT_ID", "bb-project");
    vi.stubEnv("ORACLE_BROWSERBASE_CONTEXT_ID", "bb-context");
    const browserbaseCreateSession = vi.fn(async () => ({
      id: "bb-shell",
      projectId: "bb-project",
      contextId: "bb-context",
      status: "RUNNING" as const,
      connectUrl: "wss://connect.browserbase.com/devtools/browser/bb-shell",
    }));
    const requestSessionRelease = vi.fn(async () => ({ id: "bb-shell", status: "COMPLETED" }));
    const network = {
      clearBrowserCookies: vi.fn(async () => ({})),
      enable: vi.fn(async () => ({})),
    };
    const page = {
      enable: vi.fn(async () => ({})),
      navigate: vi.fn(async () => ({})),
    };
    const connection = {
      client: { Network: network, Page: page },
      close: vi.fn(async () => {}),
      targetId: "shell-target",
    };
    const connectToRemoteChromeTarget = vi.fn(async () => connection);
    const syncCookies = vi.fn(async () => 7);
    const createOracleSession = vi.fn(async () => ({ id: "oracle-shell" }));
    const updateSession = vi.fn(async () => ({ id: "oracle-shell" }));

    vi.doMock("../../src/browser/browserbase.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/browserbase.js")>(
        "../../src/browser/browserbase.js",
      );
      return {
        ...original,
        BrowserbaseClient: vi.fn().mockImplementation(function BrowserbaseClient() {
          return { createSession: browserbaseCreateSession, requestSessionRelease };
        }),
      };
    });
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectToRemoteChromeTarget,
      getBrowserWebSocketDebuggerUrl: vi.fn(),
      listRemoteChromeTargets: vi.fn(),
    }));
    vi.doMock("../../src/browser/cookies.js", () => ({ syncCookies }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        createSession: createOracleSession,
        updateSession,
      },
    }));
    const { createBrowserbaseSupervisorShellRuntime } =
      await import("../../src/cli/supervisorBrokerRuntime.js");

    await createBrowserbaseSupervisorShellRuntime({
      projectUrl: SUPERVISOR_PROJECT_URL,
      cwd: "/repo",
    });

    expect(syncCookies).toHaveBeenCalledWith(
      network,
      SUPERVISOR_PROJECT_URL,
      undefined,
      expect.any(Function),
      {
        allowErrors: true,
        filterNames: expect.arrayContaining([
          "__Secure-next-auth.session-token.0",
          "__Secure-next-auth.session-token.1",
          "oai-client-auth-info",
          "oai-sc",
        ]),
      },
    );
    expect(network.clearBrowserCookies).toHaveBeenCalledTimes(1);
    expect(page.navigate).toHaveBeenCalledWith({ url: SUPERVISOR_PROJECT_URL });
    expect(updateSession).toHaveBeenCalledWith(
      "oracle-shell",
      expect.objectContaining({
        browser: expect.objectContaining({
          runtime: expect.objectContaining({
            browserbaseSessionId: "bb-shell",
            chromeTargetId: "shell-target",
          }),
        }),
      }),
    );
    expect(requestSessionRelease).not.toHaveBeenCalled();
  });

  test("skips stale running Browserbase runtimes when the provider session is completed", async () => {
    vi.resetModules();
    vi.stubEnv("ORACLE_BROWSERBASE_API_KEY", "bb-test-key");
    const meta = browserbaseRuntimeSession(
      "browserbase-stale",
      "running",
      "2026-03-31T10:05:00.000Z",
    );
    meta.progress = {
      stage: "browser",
      message: "starting",
      updatedAt: "2026-03-31T10:05:01.000Z",
    };
    meta.mode = "browser";
    meta.browser!.runtime!.controllerPid = 999999999;
    const updateSession = vi.fn(async (_sessionId: string, updates: Partial<SessionMetadata>) => ({
      ...meta,
      ...updates,
    }));
    const getSession = vi.fn(async () => ({
      id: "bb-browserbase-stale",
      projectId: "bb-project",
      status: "COMPLETED" as const,
    }));
    const listTargets = vi.fn();

    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        updateSession,
      },
    }));
    vi.doMock("../../src/browser/browserbase.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/browserbase.js")>(
        "../../src/browser/browserbase.js",
      );
      return {
        ...original,
        BrowserbaseClient: vi.fn().mockImplementation(function BrowserbaseClient() {
          return { getSession };
        }),
      };
    });
    const { __test__ } = await import("../../src/cli/supervisorBrokerRuntime.js");
    expect(
      __test__.pickReusableRuntimeCandidate([meta], { browserProvider: "browserbase" })?.id,
    ).toBe("browserbase-stale");

    const picked = await __test__.pickReachableRuntimeCandidate([meta], vi.fn(), listTargets, {
      browserProvider: "browserbase",
    });

    expect(picked).toBeUndefined();
    expect(getSession).toHaveBeenCalledWith("bb-browserbase-stale");
    expect(listTargets).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledWith(
      "browserbase-stale",
      expect.objectContaining({
        status: "error",
        errorMessage: expect.stringContaining("is COMPLETED"),
        browser: expect.objectContaining({
          runtime: expect.objectContaining({
            browserbaseKeepAlive: false,
            chromeBrowserWSEndpoint: undefined,
          }),
        }),
        progress: expect.objectContaining({
          message: expect.stringContaining("is COMPLETED"),
        }),
      }),
    );
  });

  test("accepts a reachable runtime when only duplicate identical project shell targets remain", async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true });
    const listTargets = vi.fn(async () => [
      {
        targetId: "project-shell-1",
        type: "page",
        url: SUPERVISOR_PROJECT_URL,
      },
      {
        targetId: "project-shell-2",
        type: "page",
        url: SUPERVISOR_PROJECT_URL,
      },
    ]);

    const picked = await __test__.pickReachableRuntimeCandidate(
      [
        {
          ...runtimeSession("shell-recoverable-duplicate", "completed", "2026-03-31T10:05:00.000Z"),
          browser: {
            runtime: {
              chromeHost: "127.0.0.1",
              chromePort: 9222,
              tabUrl: `${SUPERVISOR_CONVERSATION_ROOT}/c/shell-recoverable-duplicate`,
              conversationId: "shell-recoverable-duplicate",
            },
            config: {
              manualLogin: true,
              keepBrowser: true,
              hideWindow: true,
              attachRunning: false,
              launcher: "chrome",
              manualLoginProfileDir: HIDDEN_PROFILE_DIR,
              chatgptUrl: SUPERVISOR_PROJECT_URL,
            },
          },
        },
      ],
      probe,
      listTargets,
    );

    expect(picked?.id).toBe("shell-recoverable-duplicate");
    expect(listTargets).toHaveBeenCalledTimes(1);
  });

  test("accepts a reachable runtime when canonical and slugged project shell targets remain in an exact slugged scope", async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true });
    const listTargets = vi.fn(async () => [
      {
        targetId: "project-shell-1",
        type: "page",
        url: SUPERVISOR_PROJECT_URL,
      },
      {
        targetId: "project-shell-2",
        type: "page",
        url: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/project`,
      },
    ]);

    const picked = await __test__.pickReachableRuntimeCandidate(
      [
        {
          ...runtimeSession("shell-recoverable-slugged", "completed", "2026-03-31T10:05:00.000Z"),
          browser: {
            runtime: {
              chromeHost: "127.0.0.1",
              chromePort: 9222,
              tabUrl: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/shell-recoverable-slugged`,
              conversationId: "shell-recoverable-slugged",
            },
            config: {
              manualLogin: true,
              keepBrowser: true,
              hideWindow: true,
              attachRunning: false,
              launcher: "chrome",
              manualLoginProfileDir: HIDDEN_PROFILE_DIR,
              chatgptUrl: SUPERVISOR_ORACLE_PROJECT_URL,
            },
          },
        },
      ],
      probe,
      listTargets,
    );

    expect(picked?.id).toBe("shell-recoverable-slugged");
    expect(listTargets).toHaveBeenCalledTimes(1);
  });

  test("accepts a reachable runtime when only a unique ChatGPT root shell target remains and shell recovery is allowed", async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true });
    const listTargets = vi.fn(async () => [
      {
        targetId: "chatgpt-shell",
        type: "page",
        url: "https://chatgpt.com/",
      },
    ]);

    const picked = await __test__.pickReachableRuntimeCandidate(
      [
        {
          ...runtimeSession("shell-root-recoverable", "completed", "2026-03-31T10:05:00.000Z"),
          browser: {
            runtime: {
              chromeHost: "127.0.0.1",
              chromePort: 9222,
              tabUrl: `${SUPERVISOR_ORACLE_PROJECT_URL}`,
            },
            config: {
              manualLogin: true,
              keepBrowser: true,
              hideWindow: true,
              attachRunning: false,
              launcher: "chrome",
              manualLoginProfileDir: HIDDEN_PROFILE_DIR,
              chatgptUrl: SUPERVISOR_ORACLE_PROJECT_URL,
            },
          },
        },
      ],
      probe,
      listTargets,
      { allowChatgptShellRecovery: true },
    );

    expect(picked?.id).toBe("shell-root-recoverable");
    expect(listTargets).toHaveBeenCalledTimes(1);
  });

  test("skips an unreachable preferred hidden runtime and falls back to the next reachable hidden candidate", async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "ECONNREFUSED" })
      .mockResolvedValueOnce({ ok: true });
    const listTargets = vi.fn().mockResolvedValue([
      {
        targetId: "hidden-stale-target",
        type: "page",
        url: `${SUPERVISOR_CONVERSATION_ROOT}/c/hidden-stale`,
      },
    ]);

    const picked = await __test__.pickReachableRuntimeCandidate(
      [
        {
          ...runtimeSession("hidden-reachable", "completed", "2026-03-31T10:05:00.000Z"),
          browser: {
            runtime: {
              chromeHost: "127.0.0.1",
              chromePort: 9222,
              tabUrl: `${SUPERVISOR_CONVERSATION_ROOT}/c/hidden-reachable`,
              conversationId: "hidden-reachable",
            },
            config: {
              manualLogin: true,
              keepBrowser: true,
              hideWindow: true,
              attachRunning: false,
              manualLoginProfileDir: HIDDEN_PROFILE_DIR,
              chatgptUrl: SUPERVISOR_PROJECT_URL,
            },
          },
        },
        {
          ...runtimeSession("hidden-stale", "completed", "2026-03-31T10:00:00.000Z"),
          browser: {
            runtime: {
              chromeHost: "127.0.0.1",
              chromePort: 53332,
              tabUrl: `${SUPERVISOR_CONVERSATION_ROOT}/c/hidden-stale`,
              conversationId: "hidden-stale",
            },
            config: {
              manualLogin: true,
              keepBrowser: true,
              hideWindow: true,
              attachRunning: false,
              manualLoginProfileDir: HIDDEN_PROFILE_DIR,
              chatgptUrl: SUPERVISOR_PROJECT_URL,
            },
          },
        },
      ],
      probe,
      listTargets,
    );

    expect(picked?.id).toBe("hidden-stale");
    expect(probe).toHaveBeenNthCalledWith(1, {
      host: "127.0.0.1",
      port: 9222,
      attempts: 1,
      timeoutMs: 1000,
    });
    expect(probe).toHaveBeenNthCalledWith(2, {
      host: "127.0.0.1",
      port: 53332,
      attempts: 1,
      timeoutMs: 1000,
    });
    expect(listTargets).toHaveBeenCalledTimes(1);
    expect(listTargets).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 53332,
      browserWSEndpoint: undefined,
    });
  });

  test("returns nothing when only attach-running runtimes remain reachable", async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true });
    const listTargets = vi
      .fn()
      .mockRejectedValueOnce(new Error("No inspectable targets"))
      .mockResolvedValueOnce([
        {
          targetId: "hidden-stale-target",
          type: "page",
          url: `${SUPERVISOR_CONVERSATION_ROOT}/c/hidden-stale`,
        },
      ]);

    const picked = await __test__.pickReachableRuntimeCandidate(
      [
        {
          ...runtimeSession("hidden-stale", "completed", "2026-03-31T10:05:00.000Z"),
          browser: {
            runtime: {
              chromeHost: "127.0.0.1",
              chromePort: 53332,
              tabUrl: `${SUPERVISOR_CONVERSATION_ROOT}/c/hidden-stale`,
              conversationId: "hidden-stale",
            },
            config: {
              manualLogin: true,
              keepBrowser: true,
              hideWindow: true,
              attachRunning: false,
              manualLoginProfileDir: HIDDEN_PROFILE_DIR,
              chatgptUrl: SUPERVISOR_PROJECT_URL,
            },
          },
        },
        {
          ...runtimeSession("attach-running-live", "running", "2026-03-31T10:00:00.000Z"),
          browser: {
            runtime: {
              chromeHost: "127.0.0.1",
              chromePort: 9222,
            },
            config: {
              attachRunning: true,
            },
          },
        },
      ],
      probe,
      listTargets,
    );

    expect(picked).toBeUndefined();
    expect(listTargets).toHaveBeenCalledTimes(1);
    expect(listTargets).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 53332,
      browserWSEndpoint: undefined,
    });
  });

  test("ignores running hidden runtimes when choosing a reusable supervisor runtime", async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true });
    const listTargets = vi.fn().mockResolvedValueOnce([
      {
        targetId: "hidden-stale-target",
        type: "page",
        url: `${SUPERVISOR_CONVERSATION_ROOT}/c/hidden-stale`,
      },
    ]);

    const picked = await __test__.pickReachableRuntimeCandidate(
      [
        {
          ...runtimeSession("hidden-stale", "completed", "2026-03-31T10:05:00.000Z"),
          browser: {
            runtime: {
              chromeHost: "127.0.0.1",
              chromePort: 53332,
              tabUrl: `${SUPERVISOR_CONVERSATION_ROOT}/c/hidden-stale`,
              conversationId: "hidden-stale",
            },
            config: {
              manualLogin: true,
              keepBrowser: true,
              hideWindow: true,
              attachRunning: false,
              manualLoginProfileDir: HIDDEN_PROFILE_DIR,
              chatgptUrl: SUPERVISOR_PROJECT_URL,
            },
          },
        },
        {
          ...runtimeSession("hidden-live", "running", "2026-03-31T10:00:00.000Z"),
          browser: {
            runtime: {
              chromeHost: "127.0.0.1",
              chromePort: 9222,
              tabUrl: `${SUPERVISOR_CONVERSATION_ROOT}/c/hidden-live`,
              conversationId: "hidden-live",
            },
            config: {
              manualLogin: true,
              keepBrowser: true,
              hideWindow: true,
              attachRunning: false,
              manualLoginProfileDir: HIDDEN_PROFILE_DIR,
              chatgptUrl: SUPERVISOR_PROJECT_URL,
            },
          },
        },
      ],
      probe,
      listTargets,
    );

    expect(picked?.id).toBe("hidden-stale");
    expect(listTargets).toHaveBeenCalledTimes(1);
    expect(listTargets).toHaveBeenNthCalledWith(1, {
      host: "127.0.0.1",
      port: 53332,
      browserWSEndpoint: undefined,
    });
  });

  test("classifies only hidden reusable manual-login runtimes as supervisor-owned", () => {
    expect(
      __test__.isOwnedSupervisorRuntime({
        ...runtimeSession("owned", "running", "2026-03-31T10:00:00.000Z"),
        browser: {
          runtime: { chromePort: 9222 },
          config: {
            manualLogin: true,
            keepBrowser: true,
            hideWindow: true,
            attachRunning: false,
            launcher: "chrome",
            manualLoginProfileDir: HIDDEN_PROFILE_DIR,
            chatgptUrl: SUPERVISOR_PROJECT_URL,
          },
        },
      }),
    ).toBe(true);

    expect(
      __test__.isOwnedSupervisorRuntime({
        ...runtimeSession("visible", "running", "2026-03-31T10:00:00.000Z"),
        browser: {
          runtime: { chromePort: 9222 },
          config: {
            manualLogin: true,
            keepBrowser: true,
            hideWindow: false,
            attachRunning: false,
            launcher: "chrome",
            chatgptUrl: SUPERVISOR_PROJECT_URL,
          },
        },
      }),
    ).toBe(false);

    expect(
      __test__.isOwnedSupervisorRuntime({
        ...runtimeSession("wrong-profile", "running", "2026-03-31T10:00:00.000Z"),
        browser: {
          runtime: { chromePort: 9222 },
          config: {
            manualLogin: true,
            keepBrowser: true,
            hideWindow: true,
            attachRunning: false,
            launcher: "chrome",
            manualLoginProfileDir: "/tmp/not-the-supervisor-profile",
            chatgptUrl: SUPERVISOR_PROJECT_URL,
          },
        },
      }),
    ).toBe(false);

    expect(
      __test__.isOwnedSupervisorRuntime({
        ...runtimeSession("remote", "running", "2026-03-31T10:00:00.000Z"),
        browser: {
          runtime: { chromePort: 9222 },
          config: {
            manualLogin: true,
            keepBrowser: true,
            hideWindow: true,
            attachRunning: false,
            launcher: "chrome",
            remoteChrome: { host: "127.0.0.1", port: 9222 },
            manualLoginProfileDir: HIDDEN_PROFILE_DIR,
            chatgptUrl: SUPERVISOR_PROJECT_URL,
          },
        },
      }),
    ).toBe(false);

    expect(
      __test__.isOwnedSupervisorRuntime({
        ...runtimeSession("attach", "running", "2026-03-31T10:00:00.000Z"),
        browser: {
          runtime: { chromePort: 9222 },
          config: {
            attachRunning: true,
          },
        },
      }),
    ).toBe(false);
  });

  test("classifies only kept-alive Browserbase project runtimes as Browserbase supervisors", () => {
    const released = browserbaseRuntimeSession("released", "completed", "2026-03-31T10:00:00.000Z");
    released.browser!.runtime!.browserbaseKeepAlive = false;

    expect(
      __test__.isBrowserbaseSupervisorRuntime(
        browserbaseRuntimeSession("browserbase", "completed", "2026-03-31T10:00:00.000Z"),
      ),
    ).toBe(true);

    expect(__test__.isBrowserbaseSupervisorRuntime(released)).toBe(false);
  });

  test("releases kept-alive Browserbase supervisor sessions and marks them non-reusable", async () => {
    const meta = browserbaseRuntimeSession("browserbase", "completed", "2026-03-31T10:00:00.000Z");
    const requestSessionRelease = vi.fn(async () => ({
      id: "bb-browserbase",
      projectId: "bb-project",
      status: "COMPLETED" as const,
    }));
    const createClient = vi.fn(() => ({ requestSessionRelease }));
    const updateSession = vi.fn(async (_sessionId: string, updates: Partial<SessionMetadata>) => ({
      ...meta,
      ...updates,
    }));

    const released = await __test__.releaseBrowserbaseSupervisorRuntimeSessions({
      env: { ORACLE_BROWSERBASE_API_KEY: "bb-test-key" } as NodeJS.ProcessEnv,
      listSessions: async () => [meta],
      updateSession,
      createClient,
    });

    expect(released).toBe(1);
    expect(createClient).toHaveBeenCalledWith({
      apiKey: "bb-test-key",
      projectId: "bb-project",
    });
    expect(requestSessionRelease).toHaveBeenCalledWith("bb-browserbase", "bb-project");
    expect(updateSession).toHaveBeenCalledWith(
      "browserbase",
      expect.objectContaining({
        browser: expect.objectContaining({
          runtime: expect.objectContaining({
            browserbaseKeepAlive: false,
            browserbaseSessionId: "bb-browserbase",
            chromeBrowserWSEndpoint: undefined,
          }),
        }),
      }),
    );
  });

  test("releases stale Browserbase supervisor sessions even when the websocket endpoint is gone", async () => {
    const meta = browserbaseRuntimeSession("browserbase", "completed", "2026-03-31T10:00:00.000Z");
    delete meta.browser!.runtime!.chromeBrowserWSEndpoint;
    const requestSessionRelease = vi.fn(async () => ({
      id: "bb-browserbase",
      projectId: "bb-project",
      status: "COMPLETED" as const,
    }));
    const updateSession = vi.fn(async (_sessionId: string, updates: Partial<SessionMetadata>) => ({
      ...meta,
      ...updates,
    }));

    const released = await __test__.releaseBrowserbaseSupervisorRuntimeSessions({
      env: { ORACLE_BROWSERBASE_API_KEY: "bb-test-key" } as NodeJS.ProcessEnv,
      listSessions: async () => [meta],
      updateSession,
      createClient: () => ({ requestSessionRelease }),
    });

    expect(__test__.isBrowserbaseSupervisorRuntime(meta)).toBe(false);
    expect(__test__.isReleasableBrowserbaseSupervisorRuntime(meta)).toBe(true);
    expect(released).toBe(1);
    expect(requestSessionRelease).toHaveBeenCalledWith("bb-browserbase", "bb-project");
  });

  test("resolveSupervisorRuntimeContext rejects a hinted non-owned runtime", async () => {
    vi.resetModules();
    vi.resetModules();
    const attachRunningMeta = {
      ...runtimeSession("attach", "running", "2026-03-31T10:00:00.000Z"),
      browser: {
        runtime: {
          chromePort: 9222,
        },
        config: {
          attachRunning: true,
        },
      },
    } satisfies SessionMetadata;
    const readSession = vi.fn(async () => attachRunningMeta);
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession,
        listSessions: vi.fn(),
      },
    }));
    const { resolveSupervisorRuntimeContext } =
      await import("../../src/cli/supervisorBrokerRuntime.js");

    await expect(resolveSupervisorRuntimeContext("attach")).rejects.toThrow(
      /not an Oracle-owned hidden browser runtime/i,
    );
    expect(readSession).toHaveBeenCalledWith("attach");
  });

  test("resolveSupervisorRuntimeContext strips an unvalidated cached chrome pid", async () => {
    vi.resetModules();
    const ownedMeta = {
      ...runtimeSession("owned", "completed", "2026-03-31T10:00:00.000Z"),
      browser: {
        runtime: {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromePid: 4242,
          tabUrl: `${SUPERVISOR_CONVERSATION_ROOT}/c/owned`,
          conversationId: "owned",
        },
        config: {
          manualLogin: true,
          keepBrowser: true,
          hideWindow: true,
          attachRunning: false,
          launcher: "chrome",
          manualLoginProfileDir: HIDDEN_PROFILE_DIR,
          chatgptUrl: SUPERVISOR_PROJECT_URL,
        },
      },
    } satisfies SessionMetadata;
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: vi.fn(async () => ownedMeta),
        listSessions: vi.fn(),
      },
    }));
    vi.doMock("../../src/browser/profileState.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/browser/profileState.js")>(
        "../../src/browser/profileState.js",
      );
      return {
        ...actual,
        readChromePid: vi.fn(async () => null),
        chromePidMatchesUserDataDir: vi.fn(async () => false),
        resolveChromePidForUserDataDir: vi.fn(async () => null),
      };
    });
    vi.doMock("../../src/browser/detect.js", () => ({
      readDevToolsActivePortInfo: vi.fn(async () => ({
        port: 9222,
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/owned",
      })),
    }));

    const { resolveSupervisorRuntimeContext } =
      await import("../../src/cli/supervisorBrokerRuntime.js");
    const context = await resolveSupervisorRuntimeContext("owned");

    expect(context.runtime.chromePid).toBeUndefined();
    expect(context.runtime.chromePort).toBe(9222);
  });

  test("resolveSupervisorRuntimeContext returns the unbound ancestor session id for a hinted bound thread session", async () => {
    vi.resetModules();
    const parentMeta = {
      ...runtimeSession("owned-root", "completed", "2026-03-31T10:00:00.000Z"),
      browser: {
        runtime: {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromePid: 4242,
          tabUrl: `${SUPERVISOR_CONVERSATION_ROOT}/c/owned-root`,
          conversationId: "owned-root",
        },
        config: {
          manualLogin: true,
          keepBrowser: true,
          hideWindow: true,
          attachRunning: false,
          launcher: "chrome",
          manualLoginProfileDir: HIDDEN_PROFILE_DIR,
          chatgptUrl: SUPERVISOR_PROJECT_URL,
        },
      },
    } satisfies SessionMetadata;
    const boundThreadMeta = {
      ...runtimeSession("owned-thread", "completed", "2026-03-31T10:05:00.000Z"),
      options: {
        model: "gpt-5.5-pro",
        followupSessionId: "owned-root",
      },
      supervisorThread: {
        conversationId: "owned-thread",
        url: `${SUPERVISOR_CONVERSATION_ROOT}/c/owned-thread`,
        projectUrl: SUPERVISOR_PROJECT_URL,
        verifiedAt: "2026-03-31T10:05:00.000Z",
      },
      browser: {
        runtime: {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromePid: 4242,
          tabUrl: `${SUPERVISOR_CONVERSATION_ROOT}/c/owned-thread`,
          conversationId: "owned-thread",
        },
        config: {
          manualLogin: true,
          keepBrowser: true,
          hideWindow: true,
          attachRunning: false,
          launcher: "chrome",
          manualLoginProfileDir: HIDDEN_PROFILE_DIR,
          chatgptUrl: SUPERVISOR_PROJECT_URL,
        },
      },
    } satisfies SessionMetadata;
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: vi.fn(async (id: string) => {
          if (id === "owned-thread") {
            return boundThreadMeta;
          }
          if (id === "owned-root") {
            return parentMeta;
          }
          return null;
        }),
        listSessions: vi.fn(),
      },
    }));
    vi.doMock("../../src/browser/profileState.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/browser/profileState.js")>(
        "../../src/browser/profileState.js",
      );
      return {
        ...actual,
        readChromePid: vi.fn(async () => null),
        chromePidMatchesUserDataDir: vi.fn(async () => false),
        resolveChromePidForUserDataDir: vi.fn(async () => null),
      };
    });
    vi.doMock("../../src/browser/detect.js", () => ({
      readDevToolsActivePortInfo: vi.fn(async () => ({
        port: 9222,
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/owned-thread",
      })),
    }));

    const { resolveSupervisorRuntimeContext } =
      await import("../../src/cli/supervisorBrokerRuntime.js");
    const context = await resolveSupervisorRuntimeContext("owned-thread");

    expect(context.sessionId).toBe("owned-root");
    expect(context.runtime.conversationId).toBe("owned-thread");
  });

  test("resolveMutableSupervisorRuntimeAnchorSessionId fails closed when a bound thread session has no reusable parent runtime", async () => {
    await expect(
      __test__.resolveMutableSupervisorRuntimeAnchorSessionId(
        {
          ...runtimeSession("owned-thread", "completed", "2026-03-31T10:05:00.000Z"),
          options: {
            model: "gpt-5.5-pro",
            followupSessionId: "missing-parent",
          },
          supervisorThread: {
            conversationId: "owned-thread",
            url: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/owned-thread`,
            projectUrl: SUPERVISOR_PROJECT_URL,
            verifiedAt: "2026-03-31T10:05:00.000Z",
          },
        },
        vi.fn(async () => null),
      ),
    ).rejects.toThrow(/parent session missing-parent was not found/i);
  });

  test("resolveSupervisorRuntimeContext rejects a hinted hidden runtime outside the configured project scope", async () => {
    vi.resetModules();
    const ownedMeta = {
      ...runtimeSession("owned-root-chat", "completed", "2026-03-31T10:00:00.000Z"),
      browser: {
        runtime: {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromePid: 4242,
          tabUrl: "https://chatgpt.com/c/owned-root-chat",
          conversationId: "owned-root-chat",
        },
        config: {
          manualLogin: true,
          keepBrowser: true,
          hideWindow: true,
          attachRunning: false,
          launcher: "chrome",
          manualLoginProfileDir: HIDDEN_PROFILE_DIR,
          chatgptUrl: SUPERVISOR_PROJECT_URL,
        },
      },
    } satisfies SessionMetadata;
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: vi.fn(async () => ownedMeta),
        listSessions: vi.fn(),
      },
    }));

    const { resolveSupervisorRuntimeContext } =
      await import("../../src/cli/supervisorBrokerRuntime.js");

    await expect(resolveSupervisorRuntimeContext("owned-root-chat")).rejects.toThrow(
      /outside the configured chatgpt scope/i,
    );
  });

  test("resolveSupervisorRuntimeContext allows a hinted ChatGPT root shell runtime only when shell recovery is enabled", async () => {
    vi.resetModules();
    const ownedMeta = {
      ...runtimeSession("owned-root-shell", "completed", "2026-03-31T10:00:00.000Z"),
      browser: {
        runtime: {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromePid: 4242,
          tabUrl: "https://chatgpt.com/",
        },
        config: {
          manualLogin: true,
          keepBrowser: true,
          hideWindow: true,
          attachRunning: false,
          launcher: "chrome",
          manualLoginProfileDir: HIDDEN_PROFILE_DIR,
          chatgptUrl: SUPERVISOR_ORACLE_PROJECT_URL,
        },
      },
    } satisfies SessionMetadata;
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: vi.fn(async () => ownedMeta),
        listSessions: vi.fn(),
      },
    }));
    vi.doMock("../../src/browser/profileState.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/browser/profileState.js")>(
        "../../src/browser/profileState.js",
      );
      return {
        ...actual,
        readChromePid: vi.fn(async () => null),
        chromePidMatchesUserDataDir: vi.fn(async () => false),
        resolveChromePidForUserDataDir: vi.fn(async () => null),
      };
    });
    vi.doMock("../../src/browser/detect.js", () => ({
      readDevToolsActivePortInfo: vi.fn(async () => ({
        port: 9222,
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/owned-root-shell",
      })),
    }));

    const { resolveSupervisorRuntimeContext } =
      await import("../../src/cli/supervisorBrokerRuntime.js");

    await expect(resolveSupervisorRuntimeContext("owned-root-shell")).rejects.toThrow(
      /outside the configured chatgpt scope/i,
    );

    const context = await resolveSupervisorRuntimeContext("owned-root-shell", {
      allowChatgptShellRecovery: true,
    });

    expect(context.sessionId).toBe("owned-root-shell");
    expect(context.runtime.tabUrl).toBe("https://chatgpt.com/");
    expect(context.runtime.conversationId).toBeUndefined();
  });

  test("resolveSupervisorRuntimeContext rejects a hinted running hidden runtime", async () => {
    vi.resetModules();
    const ownedMeta = {
      ...runtimeSession("owned-running", "running", "2026-03-31T10:00:00.000Z"),
      response: { status: "running" },
    } satisfies SessionMetadata;
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: vi.fn(async () => ownedMeta),
        listSessions: vi.fn(),
      },
    }));

    const { resolveSupervisorRuntimeContext } =
      await import("../../src/cli/supervisorBrokerRuntime.js");

    await expect(resolveSupervisorRuntimeContext("owned-running")).rejects.toThrow(
      /not reusable yet/i,
    );
  });

  test("resolveSupervisorRuntimeContext reuses a hinted running hidden runtime when its controller died", async () => {
    vi.resetModules();
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 4242) {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      return true;
    });
    const ownedMeta = {
      ...runtimeSession("owned-dead-controller", "running", "2026-03-31T10:00:00.000Z"),
      mode: "browser",
      response: { status: "running" },
      browser: {
        runtime: {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromePid: 1111,
          controllerPid: 4242,
          tabUrl: `${SUPERVISOR_CONVERSATION_ROOT}/c/owned-dead-controller`,
          conversationId: "owned-dead-controller",
        },
        config: {
          manualLogin: true,
          keepBrowser: true,
          hideWindow: true,
          attachRunning: false,
          launcher: "chrome",
          manualLoginProfileDir: HIDDEN_PROFILE_DIR,
          chatgptUrl: SUPERVISOR_PROJECT_URL,
        },
      },
    } satisfies SessionMetadata;
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: vi.fn(async () => ownedMeta),
        listSessions: vi.fn(),
      },
    }));
    vi.doMock("../../src/browser/profileState.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/browser/profileState.js")>(
        "../../src/browser/profileState.js",
      );
      return {
        ...actual,
        readChromePid: vi.fn(async () => null),
        chromePidMatchesUserDataDir: vi.fn(async () => false),
        resolveChromePidForUserDataDir: vi.fn(async () => null),
      };
    });
    vi.doMock("../../src/browser/detect.js", () => ({
      readDevToolsActivePortInfo: vi.fn(async () => ({
        port: 9222,
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/owned-dead-controller",
      })),
    }));

    const { resolveSupervisorRuntimeContext } =
      await import("../../src/cli/supervisorBrokerRuntime.js");
    const context = await resolveSupervisorRuntimeContext("owned-dead-controller");

    expect(context.sessionId).toBe("owned-dead-controller");
    expect(context.runtime.chromePort).toBe(9222);
    expect(killSpy).toHaveBeenCalledWith(4242, 0);
  });

  test("pickReachableRuntimeCandidate skips hidden runtimes outside the configured project scope", async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true });
    const listTargets = vi.fn().mockResolvedValue([
      {
        targetId: "hidden-good-target",
        type: "page",
        url: `${SUPERVISOR_CONVERSATION_ROOT}/c/hidden-good`,
      },
    ]);

    const picked = await __test__.pickReachableRuntimeCandidate(
      [
        {
          ...runtimeSession("hidden-wrong-scope", "running", "2026-03-31T10:05:00.000Z"),
          browser: {
            runtime: {
              chromeHost: "127.0.0.1",
              chromePort: 9222,
              tabUrl: "https://chatgpt.com/c/hidden-wrong-scope",
              conversationId: "hidden-wrong-scope",
            },
            config: {
              manualLogin: true,
              keepBrowser: true,
              hideWindow: true,
              attachRunning: false,
              manualLoginProfileDir: HIDDEN_PROFILE_DIR,
              chatgptUrl: SUPERVISOR_PROJECT_URL,
            },
          },
        },
        {
          ...runtimeSession("hidden-good", "completed", "2026-03-31T10:00:00.000Z"),
          browser: {
            runtime: {
              chromeHost: "127.0.0.1",
              chromePort: 53332,
              tabUrl: `${SUPERVISOR_CONVERSATION_ROOT}/c/hidden-good`,
              conversationId: "hidden-good",
            },
            config: {
              manualLogin: true,
              keepBrowser: true,
              hideWindow: true,
              attachRunning: false,
              manualLoginProfileDir: HIDDEN_PROFILE_DIR,
              chatgptUrl: SUPERVISOR_PROJECT_URL,
            },
          },
        },
      ],
      probe,
      listTargets,
    );

    expect(picked?.id).toBe("hidden-good");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 53332,
      attempts: 1,
      timeoutMs: 1000,
    });
  });

  test("requires an exact reusable tab match for browser websocket runtimes", () => {
    const target = __test__.pickSupervisorRuntimeTarget(
      [
        { targetId: "other-tab", type: "page", url: "https://chatgpt.com/c/other" },
        { targetId: "docs-tab", type: "page", url: "https://example.com/docs" },
      ],
      {
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        chromeTargetId: "missing-tab",
        tabUrl: "https://chatgpt.com/c/expected",
        conversationId: "expected",
      },
      true,
    );

    expect(target).toBeUndefined();
  });

  test("browser websocket runtimes refuse to attach to an arbitrary page target", async () => {
    vi.resetModules();
    const connectToRemoteChromeTarget = vi.fn();
    const listRemoteChromeTargets = vi.fn(async () => [
      { targetId: "other-tab", type: "page", url: "https://chatgpt.com/c/other" },
      { targetId: "docs-tab", type: "page", url: "https://example.com/docs" },
    ]);

    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectToRemoteChromeTarget,
      listRemoteChromeTargets,
    }));

    const { connectSupervisorRuntime } = await import("../../src/cli/supervisorBrokerRuntime.js");

    await expect(
      connectSupervisorRuntime({
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        chromeTargetId: "missing-tab",
        tabUrl: "https://chatgpt.com/c/expected",
        conversationId: "expected",
      }),
    ).rejects.toThrow(/existing Oracle browser tab/i);

    expect(listRemoteChromeTargets).toHaveBeenCalledTimes(1);
    expect(connectToRemoteChromeTarget).toHaveBeenCalledTimes(1);
  });

  test("browser websocket runtimes attach directly to a cached hidden target", async () => {
    vi.resetModules();
    const connection = {
      client: {
        Runtime: { enable: vi.fn(async () => ({})) },
        Target: {
          getTargetInfo: vi.fn(async () => ({
            targetInfo: {
              targetId: "hidden-target-1",
              type: "page",
              url: "https://chatgpt.com/c/expected",
            },
          })),
        },
      },
      close: vi.fn(async () => {}),
      targetId: "hidden-target-1",
    };
    const connectToRemoteChromeTarget = vi.fn(async () => connection);
    const listRemoteChromeTargets = vi.fn();

    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectToRemoteChromeTarget,
      listRemoteChromeTargets,
    }));

    const { connectSupervisorRuntime } = await import("../../src/cli/supervisorBrokerRuntime.js");

    const result = await connectSupervisorRuntime({
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeTargetId: "hidden-target-1",
      tabUrl: "https://chatgpt.com/c/expected",
    });

    expect(connectToRemoteChromeTarget).toHaveBeenCalledWith(
      "127.0.0.1",
      9222,
      expect.any(Function),
      expect.objectContaining({
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        targetId: "hidden-target-1",
        closeTargetOnDispose: false,
      }),
    );
    expect(listRemoteChromeTargets).not.toHaveBeenCalled();
    expect(result.targetId).toBe("hidden-target-1");
    await result.close();
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  test("browser websocket runtimes reject a cached target id that resolves to the wrong conversation", async () => {
    vi.resetModules();
    const connection = {
      client: {
        Runtime: { enable: vi.fn(async () => ({})) },
        Target: {
          getTargetInfo: vi.fn(async () => ({
            targetInfo: {
              targetId: "hidden-target-1",
              type: "page",
              url: "https://chatgpt.com/c/wrong-thread",
            },
          })),
        },
      },
      close: vi.fn(async () => {}),
      targetId: "hidden-target-1",
    };
    const connectToRemoteChromeTarget = vi.fn(async () => connection);
    const listRemoteChromeTargets = vi.fn(async () => [
      { targetId: "other-tab", type: "page", url: "https://chatgpt.com/c/other" },
    ]);

    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectToRemoteChromeTarget,
      listRemoteChromeTargets,
    }));

    const { connectSupervisorRuntime } = await import("../../src/cli/supervisorBrokerRuntime.js");

    await expect(
      connectSupervisorRuntime({
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        chromeTargetId: "hidden-target-1",
        tabUrl: "https://chatgpt.com/c/expected",
        conversationId: "expected",
      }),
    ).rejects.toThrow(/Unable to locate the existing Oracle browser tab/i);

    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(listRemoteChromeTargets).toHaveBeenCalledTimes(1);
  });

  test("browser websocket runtimes reject an unverifiable cached target id", async () => {
    vi.resetModules();
    const connection = {
      client: {
        Runtime: { enable: vi.fn(async () => ({})) },
      },
      close: vi.fn(async () => {}),
      targetId: "hidden-target-1",
    };
    const connectToRemoteChromeTarget = vi.fn(async () => connection);
    const listRemoteChromeTargets = vi.fn(async () => [
      { targetId: "other-tab", type: "page", url: "https://chatgpt.com/c/other" },
    ]);

    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectToRemoteChromeTarget,
      listRemoteChromeTargets,
    }));

    const { connectSupervisorRuntime } = await import("../../src/cli/supervisorBrokerRuntime.js");

    await expect(
      connectSupervisorRuntime({
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        chromeTargetId: "hidden-target-1",
        tabUrl: "https://chatgpt.com/c/expected",
        conversationId: "expected",
      }),
    ).rejects.toThrow(/Unable to locate the existing Oracle browser tab/i);

    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(listRemoteChromeTargets).toHaveBeenCalledTimes(1);
  });

  test("browser websocket runtimes can reuse a cached non-page conversation target", async () => {
    vi.resetModules();
    const connection = {
      client: {
        Runtime: { enable: vi.fn(async () => ({})) },
        DOM: { enable: vi.fn(async () => ({})) },
        Target: {
          getTargetInfo: vi.fn(async () => ({
            targetInfo: {
              targetId: "hidden-target-1",
              type: "other",
              url: "https://chatgpt.com/c/expected",
            },
          })),
        },
      },
      close: vi.fn(async () => {}),
      targetId: "hidden-target-1",
    };
    const connectToRemoteChromeTarget = vi.fn().mockResolvedValue(connection);
    const listRemoteChromeTargets = vi.fn(async () => []);

    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectToRemoteChromeTarget,
      listRemoteChromeTargets,
    }));

    const { connectSupervisorRuntime } = await import("../../src/cli/supervisorBrokerRuntime.js");

    const result = await connectSupervisorRuntime({
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeTargetId: "hidden-target-1",
      tabUrl: "https://chatgpt.com/c/expected",
      conversationId: "expected",
    });

    expect(listRemoteChromeTargets).not.toHaveBeenCalled();
    expect(connectToRemoteChromeTarget).toHaveBeenCalledTimes(1);
    expect(result.targetId).toBe("hidden-target-1");
    await result.close();
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  test("browser websocket runtimes fall back to discovery when the cached target resolves to the wrong conversation", async () => {
    vi.resetModules();
    const staleConnection = {
      client: {
        Runtime: { enable: vi.fn(async () => ({})) },
        Target: {
          getTargetInfo: vi.fn(async () => ({
            targetInfo: {
              targetId: "hidden-target-1",
              type: "page",
              url: "https://chatgpt.com/c/other",
            },
          })),
        },
      },
      close: vi.fn(async () => {}),
      targetId: "hidden-target-1",
    };
    const freshConnection = {
      client: {
        Runtime: { enable: vi.fn(async () => ({})) },
        DOM: { enable: vi.fn(async () => ({})) },
        Target: {
          getTargetInfo: vi.fn(async () => ({
            targetInfo: {
              targetId: "expected-target",
              type: "page",
              url: "https://chatgpt.com/c/expected",
            },
          })),
        },
      },
      close: vi.fn(async () => {}),
      targetId: "expected-target",
    };
    const connectToRemoteChromeTarget = vi
      .fn()
      .mockResolvedValueOnce(staleConnection)
      .mockResolvedValueOnce(freshConnection);
    const listRemoteChromeTargets = vi.fn(async () => [
      { targetId: "expected-target", type: "page", url: "https://chatgpt.com/c/expected" },
    ]);

    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectToRemoteChromeTarget,
      listRemoteChromeTargets,
    }));

    const { connectSupervisorRuntime } = await import("../../src/cli/supervisorBrokerRuntime.js");

    const result = await connectSupervisorRuntime({
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeTargetId: "hidden-target-1",
      tabUrl: "https://chatgpt.com/c/expected",
      conversationId: "expected",
    });

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
    expect(result.targetId).toBe("expected-target");
    await result.close();
    expect(freshConnection.close).toHaveBeenCalledTimes(1);
  });

  test("browser websocket recovery rejects a selected target when Target.getTargetInfo omits the URL", async () => {
    vi.resetModules();
    const staleConnection = {
      client: {
        Runtime: { enable: vi.fn(async () => ({})) },
        Target: {
          getTargetInfo: vi.fn(async () => ({
            targetInfo: {
              targetId: "hidden-target-1",
              type: "page",
              url: "https://chatgpt.com/c/other",
            },
          })),
        },
      },
      close: vi.fn(async () => {}),
      targetId: "hidden-target-1",
    };
    const missingUrlConnection = {
      client: {
        Runtime: { enable: vi.fn(async () => ({})) },
        DOM: { enable: vi.fn(async () => ({})) },
        Target: {
          getTargetInfo: vi.fn(async () => ({
            targetInfo: {
              targetId: "expected-target",
              type: "page",
            },
          })),
        },
      },
      close: vi.fn(async () => {}),
      targetId: "expected-target",
    };
    const connectToRemoteChromeTarget = vi
      .fn()
      .mockResolvedValueOnce(staleConnection)
      .mockResolvedValueOnce(missingUrlConnection);
    const listRemoteChromeTargets = vi.fn(async () => [
      { targetId: "expected-target", type: "page", url: "https://chatgpt.com/c/expected" },
    ]);

    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectToRemoteChromeTarget,
      listRemoteChromeTargets,
    }));

    const { connectSupervisorRuntime } = await import("../../src/cli/supervisorBrokerRuntime.js");

    await expect(
      connectSupervisorRuntime({
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        chromeTargetId: "hidden-target-1",
        tabUrl: "https://chatgpt.com/c/expected",
        conversationId: "expected",
      }),
    ).rejects.toThrow(/selected Oracle runtime target/i);

    expect(staleConnection.close).toHaveBeenCalledTimes(1);
    expect(missingUrlConnection.close).toHaveBeenCalledTimes(1);
    expect(listRemoteChromeTargets).toHaveBeenCalledTimes(1);
  });

  test("browser websocket runtimes can recover through a canonical project shell in the same normalized family", async () => {
    vi.resetModules();
    const staleConnection = {
      client: {
        Runtime: { enable: vi.fn(async () => ({})) },
        Target: {
          getTargetInfo: vi.fn(async () => ({
            targetInfo: {
              targetId: "stale-target",
              type: "page",
              url: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/other-thread`,
            },
          })),
        },
      },
      close: vi.fn(async () => {}),
      targetId: "stale-target",
    };
    const recoveredConnection = {
      client: {
        Runtime: { enable: vi.fn(async () => ({})) },
        DOM: { enable: vi.fn(async () => ({})) },
        Target: {
          getTargetInfo: vi.fn(async () => ({
            targetInfo: {
              targetId: "project-shell",
              type: "page",
              url: SUPERVISOR_PROJECT_URL,
            },
          })),
        },
      },
      close: vi.fn(async () => {}),
      targetId: "project-shell",
    };
    const connectToRemoteChromeTarget = vi
      .fn()
      .mockResolvedValueOnce(staleConnection)
      .mockResolvedValueOnce(recoveredConnection);
    const listRemoteChromeTargets = vi.fn(async () => [
      {
        targetId: "project-shell",
        type: "page",
        url: SUPERVISOR_PROJECT_URL,
      },
    ]);

    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectToRemoteChromeTarget,
      listRemoteChromeTargets,
    }));

    const { connectSupervisorRuntime } = await import("../../src/cli/supervisorBrokerRuntime.js");

    const result = await connectSupervisorRuntime({
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeTargetId: "stale-target",
      tabUrl: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/expected`,
      conversationId: "expected",
    });

    expect(staleConnection.close).toHaveBeenCalledTimes(1);
    expect(listRemoteChromeTargets).toHaveBeenCalledTimes(1);
    expect(connectToRemoteChromeTarget).toHaveBeenCalledTimes(2);
    expect(result.targetId).toBe("project-shell");
    await result.close();
    expect(recoveredConnection.close).toHaveBeenCalledTimes(1);
  });

  test("browser websocket runtimes can recover through the unique remaining page in the exact inferred project scope", async () => {
    vi.resetModules();
    const staleConnection = {
      client: {
        Runtime: { enable: vi.fn(async () => ({})) },
        Target: {
          getTargetInfo: vi.fn(async () => ({
            targetInfo: {
              targetId: "stale-target",
              type: "page",
              url: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/other-thread`,
            },
          })),
        },
      },
      close: vi.fn(async () => {}),
      targetId: "stale-target",
    };
    const recoveredConnection = {
      client: {
        Runtime: { enable: vi.fn(async () => ({})) },
        DOM: { enable: vi.fn(async () => ({})) },
        Target: {
          getTargetInfo: vi.fn(async () => ({
            targetInfo: {
              targetId: "remaining-thread",
              type: "page",
              url: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/remaining-thread`,
            },
          })),
        },
      },
      close: vi.fn(async () => {}),
      targetId: "remaining-thread",
    };
    const connectToRemoteChromeTarget = vi
      .fn()
      .mockResolvedValueOnce(staleConnection)
      .mockResolvedValueOnce(recoveredConnection);
    const listRemoteChromeTargets = vi.fn(async () => [
      {
        targetId: "remaining-thread",
        type: "page",
        url: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/remaining-thread`,
      },
      {
        targetId: "main-chat",
        type: "page",
        url: "https://chatgpt.com/c/main-thread",
      },
    ]);

    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectToRemoteChromeTarget,
      listRemoteChromeTargets,
    }));

    const { connectSupervisorRuntime } = await import("../../src/cli/supervisorBrokerRuntime.js");

    const result = await connectSupervisorRuntime({
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeTargetId: "stale-target",
      tabUrl: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/expected`,
      conversationId: "expected",
    });

    expect(staleConnection.close).toHaveBeenCalledTimes(1);
    expect(listRemoteChromeTargets).toHaveBeenCalledTimes(1);
    expect(connectToRemoteChromeTarget).toHaveBeenNthCalledWith(
      2,
      "127.0.0.1",
      9222,
      expect.any(Function),
      expect.objectContaining({
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        targetId: "remaining-thread",
      }),
    );
    expect(result.targetId).toBe("remaining-thread");
    await result.close();
    expect(recoveredConnection.close).toHaveBeenCalledTimes(1);
  });

  test("browser websocket runtimes fail closed when only other conversation tabs remain in project scope", async () => {
    vi.resetModules();
    const connectToRemoteChromeTarget = vi.fn().mockRejectedValueOnce(new Error("Target closed"));
    const listRemoteChromeTargets = vi.fn(async () => [
      {
        targetId: "other-a",
        type: "page",
        url: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/other-a`,
      },
      {
        targetId: "other-b",
        type: "page",
        url: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/other-b`,
      },
    ]);

    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectToRemoteChromeTarget,
      listRemoteChromeTargets,
    }));

    const { connectSupervisorRuntime } = await import("../../src/cli/supervisorBrokerRuntime.js");

    await expect(
      connectSupervisorRuntime({
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        chromeTargetId: "missing-target",
        tabUrl: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/expected`,
        conversationId: "expected",
      }),
    ).rejects.toThrow(
      /Unable to locate the existing Oracle browser tab|Unable to safely locate a reusable Oracle browser tab/i,
    );

    expect(connectToRemoteChromeTarget).toHaveBeenCalledTimes(1);
    expect(listRemoteChromeTargets).toHaveBeenCalledTimes(1);
  });

  test("browser websocket runtimes can recover through a unique ChatGPT shell only when allowed", async () => {
    vi.resetModules();
    const shellClient = {
      Runtime: { enable: vi.fn(async () => ({})) },
      DOM: { enable: vi.fn(async () => ({})) },
      Target: {
        getTargetInfo: vi.fn(async () => ({
          targetInfo: {
            targetId: "chatgpt-shell",
            type: "page",
            url: "https://chatgpt.com/",
          },
        })),
      },
      close: vi.fn(async () => {}),
    };
    const CDP = vi.fn(async () => shellClient);
    const recoveredConnection = {
      client: shellClient,
      close: vi.fn(async () => {}),
      targetId: "chatgpt-shell",
    };
    const connectToRemoteChromeTarget = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("Target closed");
      })
      .mockImplementationOnce(async () => {
        throw new Error("Target closed");
      })
      .mockImplementationOnce(async () => recoveredConnection);
    const listRemoteChromeTargets = vi.fn(async () => [
      { targetId: "chatgpt-shell", type: "page", url: "https://chatgpt.com/" },
    ]);

    vi.doMock("chrome-remote-interface", () => ({
      default: CDP,
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectToRemoteChromeTarget,
      listRemoteChromeTargets,
    }));

    const { connectSupervisorRuntime } = await import("../../src/cli/supervisorBrokerRuntime.js");
    const runtime = {
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeTargetId: "stale-target",
      tabUrl: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/expected`,
      conversationId: "expected",
    };

    await expect(connectSupervisorRuntime(runtime)).rejects.toThrow(
      /Unable to locate the existing Oracle browser tab|Unable to safely locate a reusable Oracle browser tab/i,
    );

    const result = await connectSupervisorRuntime(runtime, {
      allowChatgptShellRecovery: true,
    });

    expect(result.targetId).toBe("chatgpt-shell");
    expect(connectToRemoteChromeTarget).toHaveBeenNthCalledWith(
      3,
      "127.0.0.1",
      9222,
      expect.any(Function),
      expect.objectContaining({
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        targetId: "chatgpt-shell",
        closeTargetOnDispose: false,
      }),
    );
    expect(CDP).not.toHaveBeenCalled();
    await result.close();
    expect(recoveredConnection.close).toHaveBeenCalledTimes(1);
  });

  test("browser websocket recovery re-verifies the selected target before returning the runtime", async () => {
    vi.resetModules();
    const fallbackConnection = {
      client: {
        Runtime: { enable: vi.fn(async () => ({})) },
        DOM: { enable: vi.fn(async () => ({})) },
        Target: {
          getTargetInfo: vi.fn(async () => ({
            targetInfo: {
              targetId: "unexpected-target",
              type: "page",
              url: "https://chatgpt.com/c/unexpected",
            },
          })),
        },
      },
      close: vi.fn(async () => {}),
      targetId: "expected-target",
    };
    const connectToRemoteChromeTarget = vi
      .fn()
      .mockRejectedValueOnce(new Error("Target closed"))
      .mockResolvedValueOnce(fallbackConnection);
    const listRemoteChromeTargets = vi.fn(async () => [
      {
        targetId: "expected-target",
        type: "page",
        url: "https://chatgpt.com/c/expected",
      },
    ]);

    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectToRemoteChromeTarget,
      listRemoteChromeTargets,
    }));

    const { connectSupervisorRuntime } = await import("../../src/cli/supervisorBrokerRuntime.js");

    await expect(
      connectSupervisorRuntime({
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        chromeTargetId: "stale-target",
        tabUrl: "https://chatgpt.com/c/expected",
        conversationId: "expected",
      }),
    ).rejects.toThrow(/selected Oracle runtime target/i);

    expect(connectToRemoteChromeTarget).toHaveBeenCalledTimes(2);
    expect(listRemoteChromeTargets).toHaveBeenCalledTimes(1);
    expect(fallbackConnection.close).toHaveBeenCalledTimes(1);
  });

  test("browser websocket recovery verifies the selected page target by id", async () => {
    vi.resetModules();
    const getTargetInfo = vi.fn(async (params?: { targetId?: string }) => ({
      targetInfo:
        params?.targetId === "expected-target"
          ? {
              targetId: "expected-target",
              type: "page",
              url: "https://chatgpt.com/c/expected",
            }
          : {
              targetId: "browser-target",
              type: "browser",
              url: "",
            },
    }));
    const fallbackConnection = {
      client: {
        Runtime: { enable: vi.fn(async () => ({})) },
        DOM: { enable: vi.fn(async () => ({})) },
        Target: { getTargetInfo },
      },
      close: vi.fn(async () => {}),
      targetId: "expected-target",
    };
    const connectToRemoteChromeTarget = vi
      .fn()
      .mockRejectedValueOnce(new Error("Target closed"))
      .mockResolvedValueOnce(fallbackConnection);
    const listRemoteChromeTargets = vi.fn(async () => [
      { targetId: "expected-target", type: "page", url: "https://chatgpt.com/c/expected" },
    ]);

    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectToRemoteChromeTarget,
      listRemoteChromeTargets,
    }));

    const { connectSupervisorRuntime } = await import("../../src/cli/supervisorBrokerRuntime.js");

    const result = await connectSupervisorRuntime({
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeTargetId: "stale-target",
      tabUrl: "https://chatgpt.com/c/expected",
      conversationId: "expected",
    });

    expect(result.targetId).toBe("expected-target");
    expect(getTargetInfo).toHaveBeenCalledWith({ targetId: "expected-target" });
    await result.close();
  });

  test("browser websocket runtimes fall back to host:port discovery when the cached browser websocket endpoint is stale", async () => {
    vi.resetModules();
    const cdpClient = {
      Runtime: { enable: vi.fn(async () => ({})) },
      DOM: { enable: vi.fn(async () => ({})) },
      Target: {
        getTargetInfo: vi.fn(async () => ({
          targetInfo: {
            targetId: "expected-target",
            type: "page",
            url: "https://chatgpt.com/c/expected",
          },
        })),
      },
      close: vi.fn(async () => {}),
    };
    const CDP = vi.fn(async () => cdpClient);
    const connectToRemoteChromeTarget = vi.fn(async () => {
      throw new Error("Unexpected server response: 404");
    });
    const listRemoteChromeTargets = vi.fn(async () => [
      { targetId: "expected-target", type: "page", url: "https://chatgpt.com/c/expected" },
    ]);

    vi.doMock("chrome-remote-interface", () => ({
      default: CDP,
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectToRemoteChromeTarget,
      listRemoteChromeTargets,
    }));

    const { connectSupervisorRuntime } = await import("../../src/cli/supervisorBrokerRuntime.js");

    const result = await connectSupervisorRuntime({
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/stale",
      chromeTargetId: "stale-target",
      tabUrl: "https://chatgpt.com/c/expected",
      conversationId: "expected",
    });

    expect(connectToRemoteChromeTarget).toHaveBeenCalledTimes(1);
    expect(listRemoteChromeTargets).toHaveBeenCalledTimes(1);
    expect(listRemoteChromeTargets).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      browserWSEndpoint: undefined,
    });
    expect(CDP).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      target: "expected-target",
    });
    expect(result.targetId).toBe("expected-target");
    await result.close();
    expect(cdpClient.close).toHaveBeenCalledTimes(1);
  });

  test("connectSupervisorRuntime surfaces a clear error when the cached runtime has no tabs", async () => {
    vi.resetModules();
    const listRemoteChromeTargets = vi.fn(async () => {
      throw new Error("No inspectable targets");
    });
    const mkdir = vi.fn(async () => undefined);
    const connectPlaywrightSupervisor = vi.fn(async () => ({
      listPages: () => [],
      captureArtifacts: vi.fn(async () => ({ warnings: [] })),
      close: vi.fn(async () => undefined),
    }));

    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return {
        ...actual,
        listRemoteChromeTargets,
      };
    });
    vi.doMock("../../src/browser/playwrightSupervisor.js", () => ({
      connectPlaywrightSupervisor,
    }));
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return { ...actual, default: { ...actual, mkdir }, mkdir };
    });

    const { connectSupervisorRuntime } = await import("../../src/cli/supervisorBrokerRuntime.js");

    await expect(
      connectSupervisorRuntime({
        chromeHost: "127.0.0.1",
        chromePort: 9222,
      }),
    ).rejects.toThrow(/reusable Oracle browser tab/i);

    expect(listRemoteChromeTargets).toHaveBeenCalledTimes(1);
    expect(connectPlaywrightSupervisor).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  });

  test("captureSupervisorRuntimeArtifacts returns page inventory and best-effort artifact paths", async () => {
    vi.resetModules();
    const close = vi.fn(async () => undefined);
    const mkdir = vi.fn(async () => undefined);
    const captureArtifacts = vi.fn(async ({ screenshotPath }: { screenshotPath?: string }) => ({
      screenshotPath,
      warnings: ["trace disabled"],
    }));
    const connectPlaywrightSupervisor = vi.fn(async () => ({
      listPages: () => [
        {
          contextIndex: 0,
          pageIndex: 0,
          url: SUPERVISOR_PROJECT_URL,
          normalizedUrl: SUPERVISOR_PROJECT_URL,
        },
      ],
      captureArtifacts,
      close,
    }));

    vi.doMock("../../src/browser/playwrightSupervisor.js", () => ({
      connectPlaywrightSupervisor,
    }));
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return { ...actual, default: { ...actual, mkdir }, mkdir };
    });

    const { __test__ } = await import("../../src/cli/supervisorBrokerRuntime.js");
    const result = await __test__.captureSupervisorRuntimeArtifacts(
      {
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        userDataDir: HIDDEN_PROFILE_DIR,
        conversationId: "expected",
      },
      "recover-failure",
      "synthetic-failure",
    );

    expect(connectPlaywrightSupervisor).toHaveBeenCalledTimes(1);
    expect(captureArtifacts).toHaveBeenCalledTimes(1);
    expect(result?.pages).toHaveLength(1);
    expect(result?.pages[0]?.normalizedUrl).toBe(SUPERVISOR_PROJECT_URL);
    expect(result?.screenshotPath).toContain("/.oracle/sessions/expected/artifacts/");
    expect(result?.warnings).toContain("reason: synthetic-failure");
    expect(result?.warnings).toContain("trace disabled");
    expect(mkdir).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("captureSupervisorRuntimeArtifacts skips non-hidden runtimes", async () => {
    vi.resetModules();
    const mkdir = vi.fn(async () => undefined);
    const connectPlaywrightSupervisor = vi.fn();

    vi.doMock("../../src/browser/playwrightSupervisor.js", () => ({
      connectPlaywrightSupervisor,
    }));
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return { ...actual, default: { ...actual, mkdir }, mkdir };
    });

    const { __test__ } = await import("../../src/cli/supervisorBrokerRuntime.js");
    const result = await __test__.captureSupervisorRuntimeArtifacts(
      {
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        userDataDir: "/tmp/oracle-visible-profile",
        conversationId: "expected",
      },
      "recover-failure",
      "synthetic-failure",
    );

    expect(result).toBeNull();
    expect(connectPlaywrightSupervisor).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  });

  test("owned hidden runtimes without conversation identity are skipped for reuse", async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true });
    const listTargets = vi.fn();

    const picked = await __test__.pickReachableRuntimeCandidate(
      [
        {
          ...runtimeSession("missing-identity", "running", "2026-03-31T10:05:00.000Z"),
          browser: {
            runtime: {
              chromeHost: "127.0.0.1",
              chromePort: 9222,
            },
            config: {
              manualLogin: true,
              keepBrowser: true,
              hideWindow: true,
              attachRunning: false,
              manualLoginProfileDir: HIDDEN_PROFILE_DIR,
              chatgptUrl: SUPERVISOR_PROJECT_URL,
            },
          },
        },
      ],
      probe,
      listTargets,
    );

    expect(picked).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
    expect(listTargets).not.toHaveBeenCalled();
  });

  test("requires an exact target match when runtime metadata names a specific thread", () => {
    const picked = __test__.pickSupervisorRuntimeTarget(
      [{ targetId: "other", type: "page", url: "https://chatgpt.com/c/other" }],
      {
        chromePort: 9222,
        tabUrl: "https://chatgpt.com/c/expected",
        conversationId: "expected",
      },
      false,
    );

    expect(picked).toBeUndefined();
  });
});
