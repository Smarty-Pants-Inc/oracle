import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { __test__ } from "../../src/cli/supervisorBrokerRuntime.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

const HIDDEN_PROFILE_DIR = path.join(os.homedir(), ".oracle", "browser-profile-hidden");
const SUPERVISOR_PROJECT_URL = "https://chatgpt.com/g/team-space/project";
const SUPERVISOR_CONVERSATION_ROOT = "https://chatgpt.com/g/team-space";
const SUPERVISOR_ORACLE_CONVERSATION_ROOT = "https://chatgpt.com/g/team-space-oracle";

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
    options: { model: "gpt-5.4-pro" },
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

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("supervisorBrokerRuntime", () => {
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

  test("accepts hidden runtimes pinned to the ChatGPT root", () => {
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

    expect(picked?.id).toBe("hidden-root-chat");
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
    ).toBe(SUPERVISOR_PROJECT_URL);
  });

  test("prefers the project shell recovery target for -oracle conversation runtimes", () => {
    const picked = __test__.pickSafeSupervisorRecoveryTarget(
      [
        { targetId: "project-shell", type: "page", url: SUPERVISOR_PROJECT_URL },
        {
          targetId: "other-thread",
          type: "page",
          url: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/other-thread`,
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

  test("accepts duplicate identical project shell pages as a safe recovery target", () => {
    const picked = __test__.pickSafeSupervisorRecoveryTarget(
      [
        { targetId: "project-shell-1", type: "page", url: SUPERVISOR_PROJECT_URL },
        { targetId: "project-shell-2", type: "page", url: SUPERVISOR_PROJECT_URL },
      ],
      {
        chromePort: 9222,
        tabUrl: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/expected`,
        conversationId: "expected",
      },
    );

    expect(picked?.targetId).toBe("project-shell-1");
  });

  test("treats canonical and slugged project shell pages as equivalent recovery targets", () => {
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

    expect(picked?.targetId).toBe("project-shell-1");
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
              tabUrl: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/shell-recoverable`,
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
              tabUrl: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/shell-recoverable-duplicate`,
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

  test("accepts a reachable runtime when only canonical and slugged project shell targets remain", async () => {
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
              chatgptUrl: SUPERVISOR_PROJECT_URL,
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
        model: "gpt-5.4-pro",
        followupSessionId: "owned-root",
      },
      supervisorThread: {
        conversationId: "owned-thread",
        url: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/owned-thread`,
        projectUrl: SUPERVISOR_PROJECT_URL,
        verifiedAt: "2026-03-31T10:05:00.000Z",
      },
      browser: {
        runtime: {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromePid: 4242,
          tabUrl: `${SUPERVISOR_ORACLE_CONVERSATION_ROOT}/c/owned-thread`,
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
            model: "gpt-5.4-pro",
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

  test("browser websocket runtimes can recover via the unique project shell target from stale -oracle metadata", async () => {
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
    const freshConnection = {
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
      .mockResolvedValueOnce(freshConnection);
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
    expect(connectToRemoteChromeTarget).toHaveBeenNthCalledWith(
      2,
      "127.0.0.1",
      9222,
      expect.any(Function),
      expect.objectContaining({
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        targetId: "project-shell",
      }),
    );
    expect(result.targetId).toBe("project-shell");
    await result.close();
    expect(freshConnection.close).toHaveBeenCalledTimes(1);
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

    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return {
        ...actual,
        listRemoteChromeTargets,
      };
    });

    const { connectSupervisorRuntime } = await import("../../src/cli/supervisorBrokerRuntime.js");

    await expect(
      connectSupervisorRuntime({
        chromeHost: "127.0.0.1",
        chromePort: 9222,
      }),
    ).rejects.toThrow(/reusable Oracle browser tab/i);

    expect(listRemoteChromeTargets).toHaveBeenCalledTimes(1);
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
