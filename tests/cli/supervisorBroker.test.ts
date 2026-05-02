import { afterEach, describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { __test__, runSupervisorBrokerRequest } from "../../src/cli/supervisorBroker.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { sessionStore } from "../../src/sessionStore.js";

const SUPERVISOR_BROKER_ENTRY = path.join(process.cwd(), "bin", "oracle-supervisor-broker.ts");

async function waitForBrokerOutputLine(
  output: readline.Interface,
  timeoutMs: number,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting ${timeoutMs}ms for broker output.`));
    }, timeoutMs);
    const onLine = (line: string) => {
      cleanup();
      resolve(line);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Broker stdout closed before emitting a response line."));
    };
    const cleanup = () => {
      clearTimeout(timer);
      output.off("line", onLine);
      output.off("close", onClose);
    };
    output.on("line", onLine);
    output.on("close", onClose);
  });
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out waiting ${timeoutMs}ms for child process exit.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe("runSupervisorBrokerRequest", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("defaults to run_prompt operation for legacy requests", async () => {
    const runPrompt = vi.fn(async () => ({
      ok: true as const,
      sessionId: "sess-123",
      output: "ok",
    }));
    const response = await runSupervisorBrokerRequest(
      {
        prompt: "hello",
        sessionSlug: "slug-1",
      },
      { runPrompt },
    );

    expect(runPrompt).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ ok: true, sessionId: "sess-123", output: "ok" });
  });

  test("returns list_threads envelope", async () => {
    const listThreads = vi.fn(async () => ({
      ok: true as const,
      threads: [
        {
          title: "Design review",
          conversationId: "abc",
          url: "https://chatgpt.com/c/abc",
        },
      ],
    }));
    const response = await runSupervisorBrokerRequest(
      {
        operation: "list_threads",
        prompt: "",
        sessionSlug: "slug-2",
      },
      { listThreads },
    );

    expect(listThreads).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      ok: true,
      threads: [
        {
          title: "Design review",
          conversationId: "abc",
          url: "https://chatgpt.com/c/abc",
        },
      ],
    });
  });

  test("returns ok false for async operation failures", async () => {
    await expect(
      runSupervisorBrokerRequest(
        {
          operation: "run_prompt",
          prompt: "",
          sessionSlug: "slug-error",
        },
        { runPrompt: vi.fn(() => Promise.reject(new Error("prompt exploded"))) },
      ),
    ).resolves.toEqual({
      ok: false,
      error: "prompt exploded",
    });

    await expect(
      runSupervisorBrokerRequest(
        {
          operation: "list_threads",
          prompt: "",
          sessionSlug: "slug-list-error",
        },
        { listThreads: vi.fn(() => Promise.reject(new Error("list exploded"))) },
      ),
    ).resolves.toEqual({
      ok: false,
      error: "list exploded",
    });
  });

  test("list browse options default to root and honor requested projects", () => {
    expect(__test__.brokerListBrowseOptions({ prompt: "", sessionSlug: "root" })).toEqual({
      ok: true,
      rootScope: true,
      includeProjects: true,
      scopeUrl: "https://chatgpt.com/",
    });
    expect(
      __test__.brokerListDedicatedHiddenTargetUrl({ prompt: "", sessionSlug: "root" }, "root"),
    ).toBe("https://chatgpt.com/");
    expect(
      __test__.brokerListBrowseOptions({ prompt: "", sessionSlug: "root" }, "https://chatgpt.com/"),
    ).toEqual({
      ok: true,
      rootScope: true,
      includeProjects: true,
      scopeUrl: "https://chatgpt.com/",
    });

    expect(
      __test__.brokerListBrowseOptions(
        {
          prompt: "",
          sessionSlug: "project",
          browseScope: "project",
          projectUrl: "https://chatgpt.com/g/team-space/project",
        },
        "https://chatgpt.com/g/configured/project",
      ),
    ).toEqual({
      ok: true,
      projectUrl: "https://chatgpt.com/g/team-space/project",
      scopeUrl: "https://chatgpt.com/g/team-space/project",
    });
    expect(
      __test__.brokerListDedicatedHiddenTargetUrl(
        {
          prompt: "",
          sessionSlug: "project",
          browseScope: "project",
          projectUrl: "https://chatgpt.com/g/team-space/project",
        },
        "project",
      ),
    ).toBe("https://chatgpt.com/g/team-space/project");
  });

  test("configured supervisor project URL honors the current env override", () => {
    const original = process.env.ORACLE_SUPERVISOR_CHATGPT_URL;
    process.env.ORACLE_SUPERVISOR_CHATGPT_URL = "https://chatgpt.com/g/team-space-oracle/project";
    try {
      expect(
        __test__.configuredSupervisorProjectUrl({
          browser: {
            config: {
              supervisorChatgptUrl: "https://chatgpt.com/g/team-space/project",
            },
          },
        } as never),
      ).toBe("https://chatgpt.com/g/team-space-oracle/project");
    } finally {
      if (original === undefined) {
        delete process.env.ORACLE_SUPERVISOR_CHATGPT_URL;
      } else {
        process.env.ORACLE_SUPERVISOR_CHATGPT_URL = original;
      }
    }
  });

  test("root list does not synthesize local Oracle sessions by default", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-root-list-"));
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      await sessionStore.ensureStorage();
      const olderRoot = await sessionStore.createSession(
        {
          prompt: "Older root chat",
          model: "gpt-5.5",
          mode: "browser",
        },
        process.cwd(),
      );
      await sessionStore.updateSession(olderRoot.id, {
        status: "completed",
        completedAt: "2026-04-20T00:00:00.000Z",
        supervisorThread: {
          conversationId: "root-old",
          url: "https://chatgpt.com/c/root-old",
          projectUrl: "https://chatgpt.com/",
          verifiedAt: "2026-04-20T00:00:00.000Z",
        },
      });
      const projectScoped = await sessionStore.createSession(
        {
          prompt: "Project chat",
          model: "gpt-5.5",
          mode: "browser",
        },
        process.cwd(),
      );
      await sessionStore.updateSession(projectScoped.id, {
        status: "completed",
        completedAt: "2026-04-21T00:00:00.000Z",
        supervisorThread: {
          conversationId: "project-thread",
          url: "https://chatgpt.com/g/team-space-oracle/c/project-thread",
          projectUrl: "https://chatgpt.com/g/team-space-oracle/project",
          verifiedAt: "2026-04-21T00:00:00.000Z",
        },
      });
      const newerRoot = await sessionStore.createSession(
        {
          prompt: "Newer root chat",
          model: "gpt-5.5",
          mode: "browser",
        },
        process.cwd(),
      );
      await sessionStore.updateSession(newerRoot.id, {
        status: "completed",
        completedAt: "2026-04-22T00:00:00.000Z",
        browser: {
          runtime: {
            conversationId: "root-new",
          },
        },
      });
      const duplicateRoot = await sessionStore.createSession(
        {
          prompt: "Duplicate root chat",
          model: "gpt-5.5",
          mode: "browser",
        },
        process.cwd(),
      );
      await sessionStore.updateSession(duplicateRoot.id, {
        status: "completed",
        completedAt: "2026-04-19T00:00:00.000Z",
        browser: {
          runtime: {
            tabUrl: "https://chatgpt.com/c/root-new",
          },
        },
      });

      const entries = await __test__.rootListThreadsWithLocalFallback(
        [],
        "https://chatgpt.com/g/team-space-oracle/project",
      );

      expect(entries).toEqual([
        {
          kind: "project",
          title: "Oracle project",
          projectId: "team-space-oracle",
          projectUrl: "https://chatgpt.com/g/team-space-oracle/project",
        },
      ]);
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await rm(oracleHome, { recursive: true, force: true });
    }
  });

  test("root list fallback does not add local sessions when live root threads are available", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-root-live-"));
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      await sessionStore.ensureStorage();
      const localRoot = await sessionStore.createSession(
        {
          prompt: "Local root chat",
          model: "gpt-5.5",
          mode: "browser",
        },
        process.cwd(),
      );
      await sessionStore.updateSession(localRoot.id, {
        status: "completed",
        completedAt: "2026-04-22T00:00:00.000Z",
        browser: {
          runtime: {
            tabUrl: "https://chatgpt.com/c/local-root",
            conversationId: "local-root",
          },
        },
      });

      const entries = await __test__.rootListThreadsWithLocalFallback(
        [
          {
            kind: "thread",
            title: "Live root chat",
            conversationId: "live-root",
            url: "https://chatgpt.com/c/live-root",
          },
        ],
        undefined,
      );

      expect(entries).toEqual([
        {
          kind: "thread",
          title: "Live root chat",
          conversationId: "live-root",
          url: "https://chatgpt.com/c/live-root",
        },
      ]);
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await rm(oracleHome, { recursive: true, force: true });
    }
  });

  test.each(["url", "chatgptUrl", "supervisorChatgptUrl"] as const)(
    "root list fallback excludes project-scoped local sessions configured with browser.config.%s",
    async (configKey) => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-root-config-"));
      setOracleHomeDirOverrideForTest(oracleHome);
      try {
        await sessionStore.ensureStorage();
        const projectScoped = await sessionStore.createSession(
          {
            prompt: `Project chat from ${configKey}`,
            model: "gpt-5.5",
            mode: "browser",
          },
          process.cwd(),
        );
        await sessionStore.updateSession(projectScoped.id, {
          status: "completed",
          completedAt: "2026-04-22T00:00:00.000Z",
          browser: {
            config: {
              [configKey]: "https://chatgpt.com/g/team-space-oracle/project",
            },
            runtime: {
              conversationId: `project-only-${configKey}`,
            },
          },
        });

        const entries = await __test__.rootListThreadsWithLocalFallback([], undefined, {
          allowLocalFallback: true,
        });

        expect(entries).toEqual([]);
      } finally {
        setOracleHomeDirOverrideForTest(null);
        await rm(oracleHome, { recursive: true, force: true });
      }
    },
  );

  test("root list prefers the configured project URL over live canonical project rows", async () => {
    const entries = await __test__.rootListThreadsWithLocalFallback(
      [
        {
          kind: "thread",
          title: "Live root chat",
          conversationId: "live-root",
          url: "https://chatgpt.com/c/live-root",
        },
        {
          kind: "project",
          title: "Oracle project",
          projectId: "team-space",
          projectUrl: "https://chatgpt.com/g/team-space/project",
        },
      ],
      "https://chatgpt.com/g/team-space-oracle/project",
    );

    expect(entries).toEqual([
      {
        kind: "project",
        title: "Oracle project",
        projectId: "team-space-oracle",
        projectUrl: "https://chatgpt.com/g/team-space-oracle/project",
      },
      {
        kind: "thread",
        title: "Live root chat",
        conversationId: "live-root",
        url: "https://chatgpt.com/c/live-root",
      },
    ]);
  });

  test("root list fallback rejects ambiguous live threads without root URLs", async () => {
    const entries = await __test__.rootListThreadsWithLocalFallback(
      [
        {
          kind: "thread",
          title: "URL-less stale project thread",
          conversationId: "project-thread",
        },
        {
          kind: "thread",
          title: "Project-scoped thread",
          conversationId: "project-thread-2",
          url: "https://chatgpt.com/g/team-space-oracle/c/project-thread-2",
        },
        {
          kind: "thread",
          title: "Live root chat",
          conversationId: "live-root",
          url: "https://chatgpt.com/c/live-root",
        },
      ],
      undefined,
    );

    expect(entries).toEqual([
      {
        kind: "thread",
        title: "Live root chat",
        conversationId: "live-root",
        url: "https://chatgpt.com/c/live-root",
      },
    ]);
  });

  test("root list pages project rows before root threads", async () => {
    const entries = await __test__.rootListThreadsWithLocalFallback(
      [
        {
          kind: "thread",
          title: "First live root chat",
          conversationId: "root-1",
          url: "https://chatgpt.com/c/root-1",
        },
        {
          kind: "thread",
          title: "Second live root chat",
          conversationId: "root-2",
          url: "https://chatgpt.com/c/root-2",
        },
      ],
      "https://chatgpt.com/g/team-space-oracle/project",
      { offset: 0, limit: 2 },
    );

    expect(entries).toEqual([
      {
        kind: "project",
        title: "Oracle project",
        projectId: "team-space-oracle",
        projectUrl: "https://chatgpt.com/g/team-space-oracle/project",
      },
      {
        kind: "thread",
        title: "First live root chat",
        conversationId: "root-1",
        url: "https://chatgpt.com/c/root-1",
      },
    ]);
  });

  test("accepts legacy action alias for thread operations", async () => {
    const listThreads = vi.fn(async () => ({
      ok: true as const,
      threads: [{ title: "Thread", conversationId: "abc", url: "https://chatgpt.com/c/abc" }],
    }));
    const response = await runSupervisorBrokerRequest(
      {
        action: "list_threads",
        prompt: "",
        sessionSlug: "legacy-action",
      },
      { listThreads },
    );

    expect(listThreads).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      ok: true,
      threads: [{ title: "Thread", conversationId: "abc", url: "https://chatgpt.com/c/abc" }],
    });
  });

  test("returns the runtime session id for new_thread responses", async () => {
    const newThread = vi.fn(async () => ({
      ok: true as const,
      sessionId: "runtime-1",
      thread: {
        title: "New thread",
        url: "https://chatgpt.com/",
      },
    }));
    const response = await runSupervisorBrokerRequest(
      {
        operation: "new_thread",
        prompt: "",
        sessionSlug: "slug-new",
      },
      { newThread },
    );

    expect(newThread).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      ok: true,
      sessionId: "runtime-1",
      thread: {
        title: "New thread",
        url: "https://chatgpt.com/",
      },
    });
  });

  test("returns the runtime session id for attach_thread responses", async () => {
    const attachThread = vi.fn(async () => ({
      ok: true as const,
      sessionId: "runtime-2",
      thread: {
        title: "Attached thread",
        conversationId: "abc",
        url: "https://chatgpt.com/c/abc",
      },
    }));
    const response = await runSupervisorBrokerRequest(
      {
        operation: "attach_thread",
        prompt: "",
        sessionSlug: "slug-attach",
        conversationId: "abc",
      },
      { attachThread },
    );

    expect(attachThread).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      ok: true,
      sessionId: "runtime-2",
      thread: {
        title: "Attached thread",
        conversationId: "abc",
        url: "https://chatgpt.com/c/abc",
      },
    });
  });

  test("returns thread history responses", async () => {
    const threadHistory = vi.fn(async () => ({
      ok: true as const,
      sessionId: "runtime-history",
      thread: {
        title: "Attached thread",
        conversationId: "abc",
        url: "https://chatgpt.com/c/abc",
      },
      history: [
        { role: "user" as const, text: "First question" },
        { role: "assistant" as const, text: "Final answer" },
      ],
      historyWindow: {
        limit: 2,
        returnedCount: 2,
        totalCount: 5,
        truncated: true,
      },
    }));
    const response = await runSupervisorBrokerRequest(
      {
        operation: "thread_history",
        prompt: "",
        sessionSlug: "slug-attach-history",
        conversationId: "abc",
        historyLimit: 2,
      },
      { threadHistory },
    );

    expect(threadHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "thread_history",
        conversationId: "abc",
        historyLimit: 2,
      }),
    );
    expect(response).toEqual({
      ok: true,
      sessionId: "runtime-history",
      thread: {
        title: "Attached thread",
        conversationId: "abc",
        url: "https://chatgpt.com/c/abc",
      },
      history: [
        { role: "user", text: "First question" },
        { role: "assistant", text: "Final answer" },
      ],
      historyWindow: {
        limit: 2,
        returnedCount: 2,
        totalCount: 5,
        truncated: true,
      },
    });
  });

  test("requires conversationId for attach_thread", async () => {
    const response = await runSupervisorBrokerRequest({
      operation: "attach_thread",
      prompt: "",
      sessionSlug: "slug-3",
    });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain("conversationId");
    }
  });

  test("requires conversationId for thread_history", async () => {
    const response = await runSupervisorBrokerRequest({
      operation: "thread_history",
      prompt: "",
      sessionSlug: "slug-3-history",
    });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain("conversationId");
    }
  });

  test("rejects unsupported operations", async () => {
    const response = await runSupervisorBrokerRequest({
      operation: "unsupported" as "run_prompt",
      prompt: "",
      sessionSlug: "slug-4",
    });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain("Unsupported supervisor operation");
    }
  });

  test("focus protection is a no-op when no chrome pid is available", async () => {
    const action = vi.fn(async () => "ok");
    const hideChromeWindow = vi.fn(async (..._args: unknown[]) => {});
    const startChromeFocusGuard = vi.fn(() => vi.fn());
    const finalizeChromeFocusProtection = vi.fn(async () => {});

    const result = await __test__.withChromeFocusProtection(undefined, action, {
      hideChromeWindow,
      startChromeFocusGuard,
      finalizeChromeFocusProtection,
    } as never);

    expect(result).toBe("ok");
    expect(action).toHaveBeenCalledTimes(1);
    expect(hideChromeWindow).not.toHaveBeenCalled();
    expect(startChromeFocusGuard).not.toHaveBeenCalled();
    expect(finalizeChromeFocusProtection).not.toHaveBeenCalled();
  });

  test("focus protection hides chrome before and after the broker action", async () => {
    const action = vi.fn(async () => "ok");
    const hideChromeWindow = vi.fn(async (..._args: unknown[]) => {});
    const stopFocusGuard = vi.fn();
    const startChromeFocusGuard = vi.fn(() => stopFocusGuard);
    const finalizeChromeFocusProtection = vi.fn(async () => {
      await hideChromeWindow({ pid: 4242 } as never, vi.fn() as never);
      stopFocusGuard();
    });

    const result = await __test__.withChromeFocusProtection(4242, action, {
      hideChromeWindow,
      startChromeFocusGuard,
      finalizeChromeFocusProtection,
    } as never);

    expect(result).toBe("ok");
    expect(action).toHaveBeenCalledTimes(1);
    expect(startChromeFocusGuard).toHaveBeenCalledTimes(1);
    expect(finalizeChromeFocusProtection).toHaveBeenCalledTimes(1);
    expect(hideChromeWindow).toHaveBeenCalledTimes(2);
    expect(stopFocusGuard).toHaveBeenCalledTimes(1);
  });

  test("focus protection starts before connecting the supervisor runtime", async () => {
    const callOrder: string[] = [];
    const action = vi.fn(async () => {
      callOrder.push("action");
      return "ok";
    });
    const runtimeClose = vi.fn(async () => {
      callOrder.push("close");
    });
    const resolveSupervisorRuntimeContext = vi.fn(async () => {
      callOrder.push("resolve");
      return {
        sessionId: "runtime-1",
        runtime: {
          chromePid: 4242,
        },
      };
    });
    const connectSupervisorRuntime = vi.fn(async () => {
      callOrder.push("connect");
      return {
        client: { Runtime: {} } as never,
        close: runtimeClose,
        host: "127.0.0.1",
        port: 9222,
      };
    });
    const withSupervisorRuntimeAttachLease = async <T>(
      _log: (message?: string) => void,
      work: () => Promise<T>,
    ): Promise<T> => {
      callOrder.push("lease-start");
      try {
        return await work();
      } finally {
        callOrder.push("lease-end");
      }
    };
    const hideChromeWindow = vi.fn(async () => {
      callOrder.push("hide");
    });
    const startChromeFocusGuard = vi.fn(() => {
      callOrder.push("start");
      return () => {
        callOrder.push("stop");
      };
    });
    const finalizeChromeFocusProtection = vi.fn(async () => {
      callOrder.push("hide");
      callOrder.push("stop");
    });

    const result = await __test__.withSupervisorRuntime(
      {
        prompt: "",
        sessionSlug: "slug-guard",
      },
      action,
      {
        resolveSupervisorRuntimeContext,
        connectSupervisorRuntime: connectSupervisorRuntime as never,
        withSupervisorRuntimeAttachLease,
      },
      {
        hideChromeWindow,
        startChromeFocusGuard,
        finalizeChromeFocusProtection,
      } as never,
    );

    expect(result).toBe("ok");
    expect(callOrder).toEqual([
      "resolve",
      "lease-start",
      "resolve",
      "start",
      "hide",
      "connect",
      "action",
      "close",
      "hide",
      "stop",
      "lease-end",
    ]);
  });

  test("withSupervisorRuntime bootstraps a hidden thinking runtime on cold start", async () => {
    vi.stubEnv("ORACLE_BROWSERBASE_ENABLED", "0");
    const action = vi.fn(async () => "ok");
    const runtimeClose = vi.fn(async () => {});
    const resolveSupervisorRuntimeContext = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "No reachable Oracle-owned hidden browser runtime session was found. Run one Oracle browser turn first.",
        ),
      )
      .mockResolvedValue({
        sessionId: "runtime-1",
        runtime: {},
      });
    const connectSupervisorRuntime = vi.fn(async () => ({
      client: { Runtime: {} } as never,
      close: runtimeClose,
      host: "127.0.0.1",
      port: 9222,
    }));
    const withSupervisorRuntimeAttachLease = async <T>(
      _log: (message?: string) => void,
      work: () => Promise<T>,
    ): Promise<T> => await work();
    const runPrompt = vi.fn(async () => ({
      ok: true as const,
      sessionId: "bootstrap-1",
      output: "SUPERVISOR_RUNTIME_READY",
    }));

    const result = await __test__.withSupervisorRuntime(
      {
        prompt: "",
        sessionSlug: "cold-start",
      },
      action,
      {
        resolveSupervisorRuntimeContext,
        connectSupervisorRuntime: connectSupervisorRuntime as never,
        withSupervisorRuntimeAttachLease,
      },
      undefined,
      runPrompt,
    );

    expect(result).toBe("ok");
    expect(runPrompt).toHaveBeenCalledTimes(1);
    expect(runPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.5",
        browserModelStrategy: "select",
        browserModelLabel: "Thinking 5.5",
        sessionSlug: expect.stringMatching(/^oracle-supervisor-bootstrap-/),
      }),
    );
    const bootstrapCall = runPrompt.mock.calls[0] as unknown[] | undefined;
    const bootstrapRequest = bootstrapCall?.[0] as { prompt?: string } | undefined;
    expect(bootstrapRequest?.prompt).toContain("SUPERVISOR_RUNTIME_READY_");
    expect(resolveSupervisorRuntimeContext).toHaveBeenCalledTimes(2);
    expect(connectSupervisorRuntime).toHaveBeenCalledTimes(1);
    expect(runtimeClose).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
  });

  test("withSupervisorRuntime forwards shell-recovery options into runtime readiness and connect", async () => {
    vi.stubEnv("ORACLE_BROWSERBASE_ENABLED", "0");
    const action = vi.fn(async () => "ok");
    const runtimeClose = vi.fn(async () => {});
    const runtimeOptions = { allowChatgptShellRecovery: true };
    const resolvedRuntimeOptions = {
      ...runtimeOptions,
      browserProvider: "local-hidden" as const,
    };
    const resolveSupervisorRuntimeContext = vi.fn(async () => ({
      sessionId: "runtime-1",
      runtime: {
        chromePort: 9222,
        tabUrl: "https://chatgpt.com/",
      },
    }));
    const connectSupervisorRuntime = vi.fn(async () => ({
      client: { Runtime: {} } as never,
      close: runtimeClose,
      host: "127.0.0.1",
      port: 9222,
    }));
    const withSupervisorRuntimeAttachLease = async <T>(
      _log: (message?: string) => void,
      work: () => Promise<T>,
    ): Promise<T> => await work();

    const result = await __test__.withSupervisorRuntime(
      {
        prompt: "",
        sessionSlug: "shell-recovery",
      },
      action,
      {
        resolveSupervisorRuntimeContext,
        connectSupervisorRuntime: connectSupervisorRuntime as never,
        withSupervisorRuntimeAttachLease,
      },
      undefined,
      vi.fn() as never,
      runtimeOptions,
    );

    expect(result).toBe("ok");
    expect(resolveSupervisorRuntimeContext).toHaveBeenNthCalledWith(1, undefined, resolvedRuntimeOptions);
    expect(resolveSupervisorRuntimeContext).toHaveBeenNthCalledWith(2, undefined, resolvedRuntimeOptions);
    expect(connectSupervisorRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ tabUrl: "https://chatgpt.com/" }),
      resolvedRuntimeOptions,
    );
    expect(runtimeClose).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
  });

  test("withSupervisorRuntime constrains runtime selection to Browserbase when enabled", async () => {
    vi.stubEnv("ORACLE_BROWSERBASE_ENABLED", "1");
    try {
      const action = vi.fn(async () => "ok");
      const runtimeClose = vi.fn(async () => {});
      const resolveSupervisorRuntimeContext = vi.fn(async () => ({
        sessionId: "runtime-1",
        runtime: {
          browserProvider: "browserbase" as const,
          chromeBrowserWSEndpoint: "wss://connect.browserbase.com/devtools/browser/bb-runtime",
        },
      }));
      const connectSupervisorRuntime = vi.fn(async () => ({
        client: { Runtime: {} } as never,
        close: runtimeClose,
        host: "connect.browserbase.com",
        port: 443,
      }));
      const withSupervisorRuntimeAttachLease = async <T>(
        _log: (message?: string) => void,
        work: () => Promise<T>,
      ): Promise<T> => await work();

      const result = await __test__.withSupervisorRuntime(
        {
          prompt: "",
          sessionSlug: "browserbase-provider",
        },
        action,
        {
          resolveSupervisorRuntimeContext,
          connectSupervisorRuntime: connectSupervisorRuntime as never,
          withSupervisorRuntimeAttachLease,
        },
      );

      const runtimeOptions = { browserProvider: "browserbase" } as const;
      expect(result).toBe("ok");
      expect(resolveSupervisorRuntimeContext).toHaveBeenNthCalledWith(1, undefined, runtimeOptions);
      expect(resolveSupervisorRuntimeContext).toHaveBeenNthCalledWith(2, undefined, runtimeOptions);
      expect(connectSupervisorRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ browserProvider: "browserbase" }),
        runtimeOptions,
      );
      expect(runtimeClose).toHaveBeenCalledTimes(1);
      expect(action).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("broker hydrates Browserbase env from Smarty global cache when parent Codex lacks it", () => {
    const env = {
      HOME: "/Users/tester",
    } as NodeJS.ProcessEnv;

    __test__.maybeHydrateSmartyGlobalBrowserbaseEnv(env, () => ({
      BROWSERBASE_API_KEY: "bb-key",
      BROWSERBASE_PROJECT_ID: "bb-project",
    }));

    expect(env.ORACLE_BROWSERBASE_ENABLED).toBe("1");
    expect(env.ORACLE_BROWSERBASE_KEEP_ALIVE).toBe("0");
    expect(env.ORACLE_BROWSERBASE_CONTEXT_ID).toBe("d9ef39cd-4db2-40f7-be9b-636062e23bcf");
    expect(env.BROWSERBASE_API_KEY).toBe("bb-key");
    expect(env.BROWSERBASE_PROJECT_ID).toBe("bb-project");
  });

  test("broker does not hydrate Browserbase when explicitly disabled", () => {
    const env = {
      HOME: "/Users/tester",
      ORACLE_BROWSERBASE_ENABLED: "0",
    } as NodeJS.ProcessEnv;
    const loader = vi.fn(() => ({
      BROWSERBASE_API_KEY: "bb-key",
      BROWSERBASE_PROJECT_ID: "bb-project",
    }));

    __test__.maybeHydrateSmartyGlobalBrowserbaseEnv(env, loader);

    expect(loader).not.toHaveBeenCalled();
    expect(env.ORACLE_BROWSERBASE_ENABLED).toBe("0");
    expect(env.ORACLE_BROWSERBASE_KEEP_ALIVE).toBeUndefined();
  });

  test("ensureSupervisorRuntimeReady creates a Browserbase shell instead of prompt bootstrapping", async () => {
    const createBrowserbaseSupervisorShellRuntime = vi.fn(async () => ({
      sessionId: "bb-shell",
      runtime: {
        browserProvider: "browserbase" as const,
      },
    }));
    const resolveSupervisorRuntimeContext = vi.fn(async () => {
      throw new Error(
        "No reachable Oracle supervisor browserbase runtime session was found. Run one Oracle browser turn first.",
      );
    });
    const runPrompt = vi.fn();

    await __test__.ensureSupervisorRuntimeReady(
      {
        prompt: "",
        sessionSlug: "browserbase-cold-start",
        projectUrl: "https://chatgpt.com/g/team-space/project",
        cwd: "/tmp/oracle-workspace",
      },
      {
        resolveSupervisorRuntimeContext,
        connectSupervisorRuntime: vi.fn() as never,
        withSupervisorRuntimeAttachLease: vi.fn() as never,
        createBrowserbaseSupervisorShellRuntime,
      },
      runPrompt as never,
      { browserProvider: "browserbase" },
    );

    expect(createBrowserbaseSupervisorShellRuntime).toHaveBeenCalledWith({
      projectUrl: "https://chatgpt.com/g/team-space/project",
      cwd: "/tmp/oracle-workspace",
    });
    expect(runPrompt).not.toHaveBeenCalled();
  });

  test("withSupervisorRuntime reuses the Browserbase shell created during readiness", async () => {
    const action = vi.fn(async () => "ok");
    const runtimeClose = vi.fn(async () => {});
    const createBrowserbaseSupervisorShellRuntime = vi.fn(async () => ({
      sessionId: "bb-shell",
      runtime: {
        browserProvider: "browserbase" as const,
        chromeBrowserWSEndpoint: "wss://connect.browserbase.example/devtools/browser/bb-shell",
      },
    }));
    const resolveSupervisorRuntimeContext = vi.fn(async (followupSession?: string | undefined) => {
      if (!followupSession) {
        throw new Error(
          "No reachable Oracle supervisor browserbase runtime session was found. Run one Oracle browser turn first.",
        );
      }
      return {
        sessionId: followupSession,
        runtime: {
          browserProvider: "browserbase" as const,
          chromeBrowserWSEndpoint: "wss://connect.browserbase.example/devtools/browser/bb-shell",
        },
      };
    });
    const connectSupervisorRuntime = vi.fn(async () => ({
      client: { Runtime: {} } as never,
      close: runtimeClose,
      host: "connect.browserbase.example",
      port: 443,
    }));
    const withSupervisorRuntimeAttachLease = async <T>(
      _log: (message?: string) => void,
      work: () => Promise<T>,
    ): Promise<T> => await work();

    const result = await __test__.withSupervisorRuntime(
      {
        prompt: "",
        sessionSlug: "browserbase-shell-reuse",
        projectUrl: "https://chatgpt.com/g/team-space/project",
        cwd: "/tmp/oracle-workspace",
      },
      action,
      {
        resolveSupervisorRuntimeContext,
        connectSupervisorRuntime: connectSupervisorRuntime as never,
        withSupervisorRuntimeAttachLease,
        createBrowserbaseSupervisorShellRuntime,
      },
      undefined,
      vi.fn() as never,
      { browserProvider: "browserbase" },
    );

    expect(result).toBe("ok");
    expect(resolveSupervisorRuntimeContext).toHaveBeenNthCalledWith(1, undefined, {
      browserProvider: "browserbase",
    });
    expect(resolveSupervisorRuntimeContext).toHaveBeenNthCalledWith(2, "bb-shell", {
      browserProvider: "browserbase",
    });
    expect(connectSupervisorRuntime).toHaveBeenCalledTimes(1);
    expect(runtimeClose).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
  });

  test("broker shutdown releases Browserbase supervisor runtimes even if Browserbase mode is unset", async () => {
    const releaseSessions = vi.fn(async () => 1);

    await __test__.releaseBrowserbaseSupervisorRuntimesForBrokerShutdown(releaseSessions, {
      ORACLE_BROWSERBASE_ENABLED: "1",
    } as NodeJS.ProcessEnv);

    expect(releaseSessions).toHaveBeenCalledTimes(1);
    expect(releaseSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ ORACLE_BROWSERBASE_ENABLED: "1" }),
      }),
    );

    releaseSessions.mockClear();
    await __test__.releaseBrowserbaseSupervisorRuntimesForBrokerShutdown(releaseSessions, {
      ORACLE_BROWSERBASE_ENABLED: "0",
    } as NodeJS.ProcessEnv);

    expect(releaseSessions).toHaveBeenCalledTimes(1);
    expect(releaseSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ ORACLE_BROWSERBASE_ENABLED: "0" }),
      }),
    );
  });

  test("broker signal cleanup releases Browserbase supervisor runtimes before exit", async () => {
    const releaseSessions = vi.fn(async () => undefined);
    const exitFn = vi.fn();
    const processLike = new EventEmitter() as unknown as Pick<NodeJS.Process, "on" | "off"> & {
      emit: (event: string) => boolean;
    };

    const cleanup = __test__.installSupervisorBrokerBrowserbaseReleaseCleanup({
      releaseBrowserbaseSessions: releaseSessions,
      processLike,
      exitFn,
    });

    processLike.emit("SIGTERM");
    await cleanup.waitForCleanup();

    expect(releaseSessions).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(143);
    cleanup.dispose();
  });

  test("broker terminal hangup cleanup releases Browserbase supervisor runtimes before exit", async () => {
    const releaseSessions = vi.fn(async () => undefined);
    const exitFn = vi.fn();
    const processLike = new EventEmitter() as unknown as Pick<NodeJS.Process, "on" | "off"> & {
      emit: (event: string) => boolean;
    };

    const cleanup = __test__.installSupervisorBrokerBrowserbaseReleaseCleanup({
      releaseBrowserbaseSessions: releaseSessions,
      processLike,
      exitFn,
    });

    processLike.emit("SIGHUP");
    await cleanup.waitForCleanup();

    expect(releaseSessions).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(129);
    cleanup.dispose();
  });

  test("withSupervisorRuntime does not bootstrap when a specific followup session was requested", async () => {
    const resolveSupervisorRuntimeContext = vi.fn(async () => {
      throw new Error(
        "No reachable Oracle-owned hidden browser runtime session was found. Run one Oracle browser turn first.",
      );
    });
    const runPrompt = vi.fn();

    await expect(
      __test__.withSupervisorRuntime(
        {
          prompt: "",
          sessionSlug: "cold-start-followup",
          followupSession: "runtime-anchor-1",
        },
        async () => "ok",
        {
          resolveSupervisorRuntimeContext,
          connectSupervisorRuntime: vi.fn() as never,
          withSupervisorRuntimeAttachLease: async <T>(
            _log: (message?: string) => void,
            work: () => Promise<T>,
          ): Promise<T> => await work(),
        },
        undefined,
        runPrompt as never,
      ),
    ).rejects.toThrow("No reachable Oracle-owned hidden browser runtime session was found");

    expect(runPrompt).not.toHaveBeenCalled();
  });

  test("syncSupervisorRuntimeSession persists the active chrome target for a broker thread", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-broker-"));
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      await sessionStore.ensureStorage();
      const meta = await sessionStore.createSession(
        {
          prompt: "broker runtime",
          model: "gpt-5.5",
          mode: "browser",
        },
        process.cwd(),
      );
      await sessionStore.updateSession(meta.id, {
        browser: {
          config: undefined,
          runtime: {
            chromePid: 1234,
            chromePort: 9222,
            chromeHost: "127.0.0.1",
            chromeTargetId: "stale-target",
            tabUrl: "https://chatgpt.com/c/stale-thread",
            conversationId: "stale-thread",
          },
        },
      });

      await __test__.syncSupervisorRuntimeSession(
        meta.id,
        {
          title: "Fresh thread",
          url: "https://chatgpt.com/c/fresh-thread",
          conversationId: "fresh-thread",
        },
        "fresh-target",
      );

      const updated = await sessionStore.readSession(meta.id);
      expect(updated?.browser?.runtime?.chromeTargetId).toBe("fresh-target");
      expect(updated?.browser?.runtime?.tabUrl).toBe("https://chatgpt.com/c/fresh-thread");
      expect(updated?.browser?.runtime?.conversationId).toBe("fresh-thread");
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await rm(oracleHome, { recursive: true, force: true });
    }
  });

  test("syncSupervisorRuntimeSession clears ephemeral chrome targets", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-broker-"));
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      await sessionStore.ensureStorage();
      const meta = await sessionStore.createSession(
        {
          prompt: "broker runtime",
          model: "gpt-5.5",
          mode: "browser",
        },
        process.cwd(),
      );
      await sessionStore.updateSession(meta.id, {
        browser: {
          config: undefined,
          runtime: {
            chromePid: 1234,
            chromePort: 9222,
            chromeHost: "127.0.0.1",
            chromeTargetId: "stale-target",
            tabUrl: "https://chatgpt.com/c/stale-thread",
            conversationId: "stale-thread",
          },
        },
      });

      await __test__.syncSupervisorRuntimeSession(
        meta.id,
        {
          title: "Fresh thread",
          url: "https://chatgpt.com/c/fresh-thread",
          conversationId: "fresh-thread",
        },
        null,
      );

      const updated = await sessionStore.readSession(meta.id);
      expect(updated?.browser?.runtime?.chromeTargetId).toBeUndefined();
      expect(updated?.browser?.runtime?.tabUrl).toBe("https://chatgpt.com/c/fresh-thread");
      expect(updated?.browser?.runtime?.conversationId).toBe("fresh-thread");
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await rm(oracleHome, { recursive: true, force: true });
    }
  });

  test("createSupervisorThreadSession returns a fresh per-thread session id", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-thread-"));
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      await sessionStore.ensureStorage();
      const runtimeSession = await sessionStore.createSession(
        {
          prompt: "broker runtime",
          model: "gpt-5.5",
          mode: "browser",
          browserConfig: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
          search: true,
        },
        process.cwd(),
      );
      await sessionStore.updateSession(runtimeSession.id, {
        status: "completed",
        browser: {
          config: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
          runtime: {
            chromePid: 1234,
            chromePort: 9222,
            chromeHost: "127.0.0.1",
            chromeTargetId: "stale-target",
            tabUrl: "https://chatgpt.com/c/stale-thread",
            conversationId: "stale-thread",
          },
        },
      });

      const threadSessionId = await __test__.createSupervisorThreadSession(
        runtimeSession.id,
        {
          title: "Fresh thread",
          url: "https://chatgpt.com/g/team-space-oracle/c/fresh-thread",
          conversationId: "fresh-thread",
        },
        "fresh-target",
      );

      expect(threadSessionId).not.toBe(runtimeSession.id);

      const updatedRuntime = await sessionStore.readSession(runtimeSession.id);
      expect(updatedRuntime?.browser?.runtime?.chromeTargetId).toBe("stale-target");
      expect(updatedRuntime?.browser?.runtime?.tabUrl).toBe("https://chatgpt.com/c/stale-thread");
      expect(updatedRuntime?.browser?.runtime?.conversationId).toBe("stale-thread");

      const threadSession = await sessionStore.readSession(threadSessionId);
      expect(threadSession?.status).toBe("completed");
      expect(threadSession?.options.followupSessionId).toBe(runtimeSession.id);
      expect(threadSession?.browser?.runtime?.chromeTargetId).toBe("fresh-target");
      expect(threadSession?.browser?.runtime?.tabUrl).toBe(
        "https://chatgpt.com/g/team-space-oracle/c/fresh-thread",
      );
      expect(threadSession?.browser?.runtime?.conversationId).toBe("fresh-thread");
      expect(threadSession?.supervisorThread).toMatchObject({
        conversationId: "fresh-thread",
        url: "https://chatgpt.com/g/team-space-oracle/c/fresh-thread",
        projectUrl: "https://chatgpt.com/g/team-space/project",
      });
      expect(threadSession?.promptPreview).toContain("Fresh thread");
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await rm(oracleHome, { recursive: true, force: true });
    }
  });

  test("createAndSyncSupervisorThreadSession updates the parent runtime before returning the thread session", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-thread-sync-"));
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      await sessionStore.ensureStorage();
      const runtimeSession = await sessionStore.createSession(
        {
          prompt: "broker runtime",
          model: "gpt-5.5",
          mode: "browser",
          browserConfig: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
          search: true,
        },
        process.cwd(),
      );
      await sessionStore.updateSession(runtimeSession.id, {
        status: "completed",
        browser: {
          config: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
          runtime: {
            chromePid: 1234,
            chromePort: 9222,
            chromeHost: "127.0.0.1",
            chromeTargetId: "stale-target",
            tabUrl: "https://chatgpt.com/g/team-space-oracle/c/stale-thread",
            conversationId: "stale-thread",
          },
        },
      });

      const threadSessionId = await __test__.createAndSyncSupervisorThreadSession(
        runtimeSession.id,
        {
          title: "Fresh thread",
          url: "https://chatgpt.com/g/team-space-oracle/c/fresh-thread",
          conversationId: "fresh-thread",
        },
        "fresh-target",
      );

      expect(threadSessionId).not.toBe(runtimeSession.id);

      const updatedRuntime = await sessionStore.readSession(runtimeSession.id);
      expect(updatedRuntime?.browser?.runtime?.chromeTargetId).toBe("fresh-target");
      expect(updatedRuntime?.browser?.runtime?.tabUrl).toBe(
        "https://chatgpt.com/g/team-space-oracle/c/fresh-thread",
      );
      expect(updatedRuntime?.browser?.runtime?.conversationId).toBe("fresh-thread");

      const threadSession = await sessionStore.readSession(threadSessionId);
      expect(threadSession?.status).toBe("completed");
      expect(threadSession?.options.followupSessionId).toBe(runtimeSession.id);
      expect(threadSession?.browser?.runtime?.chromeTargetId).toBe("fresh-target");
      expect(threadSession?.browser?.runtime?.tabUrl).toBe(
        "https://chatgpt.com/g/team-space-oracle/c/fresh-thread",
      );
      expect(threadSession?.browser?.runtime?.conversationId).toBe("fresh-thread");
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await rm(oracleHome, { recursive: true, force: true });
    }
  });

  test("ensureSupervisorThreadSession reuses and refreshes an existing thread session", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-thread-reuse-"));
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      await sessionStore.ensureStorage();
      const runtimeSession = await sessionStore.createSession(
        {
          prompt: "broker runtime",
          model: "gpt-5.5",
          mode: "browser",
          browserConfig: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
        },
        process.cwd(),
      );
      await sessionStore.updateSession(runtimeSession.id, {
        status: "completed",
        browser: {
          config: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
          runtime: {
            chromePid: 1234,
            chromePort: 9222,
            chromeHost: "127.0.0.1",
            chromeTargetId: "runtime-target",
            tabUrl: "https://chatgpt.com/g/team-space-oracle/c/runtime-thread",
            conversationId: "runtime-thread",
          },
        },
      });
      const threadSessionId = await sessionStore.createSession(
        {
          prompt: "Supervisor thread: stale thread",
          model: "gpt-5.5",
          mode: "browser",
          browserConfig: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
          followupSessionId: runtimeSession.id,
        },
        process.cwd(),
      );
      await sessionStore.updateSession(threadSessionId.id, {
        status: "completed",
        browser: {
          config: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
          runtime: {
            chromePid: 1234,
            chromePort: 9222,
            chromeHost: "127.0.0.1",
            chromeTargetId: "stale-target",
            tabUrl: "https://chatgpt.com/g/team-space-oracle/c/stale-thread",
            conversationId: "stale-thread",
          },
        },
      });

      const resultSessionId = await __test__.ensureSupervisorThreadSession(
        threadSessionId.id,
        {
          title: "Fresh thread",
          url: "https://chatgpt.com/g/team-space-oracle/c/fresh-thread",
          conversationId: "fresh-thread",
        },
        "fresh-target",
      );

      expect(resultSessionId).toBe(threadSessionId.id);

      const updatedRuntime = await sessionStore.readSession(runtimeSession.id);
      expect(updatedRuntime?.browser?.runtime?.chromeTargetId).toBe("fresh-target");
      expect(updatedRuntime?.browser?.runtime?.tabUrl).toBe(
        "https://chatgpt.com/g/team-space-oracle/c/fresh-thread",
      );
      expect(updatedRuntime?.browser?.runtime?.conversationId).toBe("fresh-thread");

      const updatedThreadSession = await sessionStore.readSession(threadSessionId.id);
      expect(updatedThreadSession?.browser?.runtime?.chromeTargetId).toBe("fresh-target");
      expect(updatedThreadSession?.browser?.runtime?.tabUrl).toBe(
        "https://chatgpt.com/g/team-space-oracle/c/fresh-thread",
      );
      expect(updatedThreadSession?.browser?.runtime?.conversationId).toBe("fresh-thread");
      expect(updatedThreadSession?.supervisorThread).toMatchObject({
        conversationId: "fresh-thread",
        url: "https://chatgpt.com/g/team-space-oracle/c/fresh-thread",
        projectUrl: "https://chatgpt.com/g/team-space/project",
      });
      expect(updatedThreadSession?.options.followupSessionId).toBe(runtimeSession.id);
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await rm(oracleHome, { recursive: true, force: true });
    }
  });

  test("ensureSupervisorThreadSession creates a fresh thread session for a non-thread followup child", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-thread-fresh-"));
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      await sessionStore.ensureStorage();
      const runtimeSession = await sessionStore.createSession(
        {
          prompt: "broker runtime",
          model: "gpt-5.5",
          mode: "browser",
          browserConfig: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
        },
        process.cwd(),
      );
      await sessionStore.updateSession(runtimeSession.id, {
        status: "completed",
        browser: {
          config: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
          runtime: {
            chromePid: 1234,
            chromePort: 9222,
            chromeHost: "127.0.0.1",
            chromeTargetId: "runtime-target",
            tabUrl: "https://chatgpt.com/g/team-space-oracle/c/runtime-thread",
            conversationId: "runtime-thread",
          },
        },
      });
      const unrelatedFollowup = await sessionStore.createSession(
        {
          prompt: "arbitrary followup child",
          model: "gpt-5.5",
          mode: "browser",
          browserConfig: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
          followupSessionId: runtimeSession.id,
        },
        process.cwd(),
      );
      await sessionStore.updateSession(unrelatedFollowup.id, {
        status: "completed",
        browser: {
          config: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
          runtime: {
            chromePid: 1234,
            chromePort: 9222,
            chromeHost: "127.0.0.1",
            chromeTargetId: "child-target",
            tabUrl: "https://chatgpt.com/g/team-space-oracle/c/child-thread",
            conversationId: "child-thread",
          },
        },
      });

      const resultSessionId = await __test__.ensureSupervisorThreadSession(
        unrelatedFollowup.id,
        {
          title: "Fresh thread",
          url: "https://chatgpt.com/g/team-space-oracle/c/fresh-thread",
          conversationId: "fresh-thread",
        },
        "fresh-target",
      );

      expect(resultSessionId).not.toBe(unrelatedFollowup.id);

      const updatedRuntime = await sessionStore.readSession(runtimeSession.id);
      expect(updatedRuntime?.browser?.runtime?.chromeTargetId).toBe("fresh-target");
      expect(updatedRuntime?.browser?.runtime?.tabUrl).toBe(
        "https://chatgpt.com/g/team-space-oracle/c/fresh-thread",
      );
      expect(updatedRuntime?.browser?.runtime?.conversationId).toBe("fresh-thread");

      const preservedFollowup = await sessionStore.readSession(unrelatedFollowup.id);
      expect(preservedFollowup?.browser?.runtime?.chromeTargetId).toBe("child-target");
      expect(preservedFollowup?.browser?.runtime?.conversationId).toBe("child-thread");

      const threadSession = await sessionStore.readSession(resultSessionId);
      expect(threadSession?.options.followupSessionId).toBe(runtimeSession.id);
      expect(threadSession?.promptPreview).toBe("Supervisor thread: Fresh thread");
      expect(threadSession?.browser?.runtime?.chromeTargetId).toBe("fresh-target");
      expect(threadSession?.browser?.runtime?.conversationId).toBe("fresh-thread");
      expect(threadSession?.supervisorThread).toMatchObject({
        conversationId: "fresh-thread",
        url: "https://chatgpt.com/g/team-space-oracle/c/fresh-thread",
      });
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await rm(oracleHome, { recursive: true, force: true });
    }
  });

  test("ensureSupervisorThreadSession rejects reusing a thread session for another conversation", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-thread-bound-"));
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      await sessionStore.ensureStorage();
      const runtimeSession = await sessionStore.createSession(
        {
          prompt: "broker runtime",
          model: "gpt-5.5",
          mode: "browser",
          browserConfig: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
        },
        process.cwd(),
      );
      await sessionStore.updateSession(runtimeSession.id, {
        status: "completed",
        browser: {
          config: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
          runtime: {
            chromePid: 1234,
            chromePort: 9222,
            chromeHost: "127.0.0.1",
            chromeTargetId: "runtime-target",
            tabUrl: "https://chatgpt.com/g/team-space-oracle/c/right-thread",
            conversationId: "right-thread",
          },
        },
      });
      const threadSession = await sessionStore.createSession(
        {
          prompt: "Supervisor thread: Right thread",
          model: "gpt-5.5",
          mode: "browser",
          browserConfig: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
          followupSessionId: runtimeSession.id,
        },
        process.cwd(),
      );
      await sessionStore.updateSession(threadSession.id, {
        status: "completed",
        supervisorThread: {
          conversationId: "right-thread",
          url: "https://chatgpt.com/g/team-space-oracle/c/right-thread",
          projectUrl: "https://chatgpt.com/g/team-space/project",
          verifiedAt: "2026-04-14T00:00:00.000Z",
        },
        browser: {
          config: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
          runtime: {
            chromePid: 1234,
            chromePort: 9222,
            chromeHost: "127.0.0.1",
            chromeTargetId: "thread-target",
            tabUrl: "https://chatgpt.com/g/team-space-oracle/c/right-thread",
            conversationId: "right-thread",
          },
        },
      });

      await expect(
        __test__.ensureSupervisorThreadSession(
          threadSession.id,
          {
            title: "Wrong thread",
            url: "https://chatgpt.com/g/team-space-oracle/c/wrong-thread",
            conversationId: "wrong-thread",
          },
          "wrong-target",
        ),
      ).rejects.toThrow("already bound to Oracle conversation right-thread");
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await rm(oracleHome, { recursive: true, force: true });
    }
  });

  test("createSupervisorThreadSession rejects threads outside the configured project scope", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-thread-scope-"));
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      await sessionStore.ensureStorage();
      const runtimeSession = await sessionStore.createSession(
        {
          prompt: "broker runtime",
          model: "gpt-5.5",
          mode: "browser",
          browserConfig: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
        },
        process.cwd(),
      );
      await sessionStore.updateSession(runtimeSession.id, {
        status: "completed",
        browser: {
          config: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
          runtime: {
            chromePort: 9222,
            chromeHost: "127.0.0.1",
            tabUrl: "https://chatgpt.com/g/team-space-oracle/c/stale-thread",
            conversationId: "stale-thread",
          },
        },
      });

      await expect(
        __test__.createSupervisorThreadSession(
          runtimeSession.id,
          {
            title: "Root thread",
            url: "https://chatgpt.com/c/root-thread",
            conversationId: "root-thread",
          },
          "fresh-target",
        ),
      ).rejects.toThrow("outside the configured project scope");
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await rm(oracleHome, { recursive: true, force: true });
    }
  });

  test("resolveRequestedThreadUrl reuses the bound project thread URL from the followup session", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-thread-url-"));
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      await sessionStore.ensureStorage();
      const runtimeSession = await sessionStore.createSession(
        {
          prompt: "broker runtime",
          model: "gpt-5.5",
          mode: "browser",
          browserConfig: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
        },
        process.cwd(),
      );
      await sessionStore.updateSession(runtimeSession.id, {
        status: "completed",
        browser: {
          config: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
          runtime: {
            chromePort: 9222,
            chromeHost: "127.0.0.1",
            tabUrl: "https://chatgpt.com/g/team-space/project",
          },
        },
      });
      const threadSession = await sessionStore.createSession(
        {
          prompt: "Supervisor thread: Target",
          model: "gpt-5.5",
          mode: "browser",
          browserConfig: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
          followupSessionId: runtimeSession.id,
        },
        process.cwd(),
        undefined,
        "oracle-thread-target-9",
      );
      await sessionStore.updateSession(threadSession.id, {
        status: "completed",
        supervisorThread: {
          conversationId: "target-9",
          url: "https://chatgpt.com/g/team-space-oracle/c/target-9",
          projectUrl: "https://chatgpt.com/g/team-space/project",
          verifiedAt: new Date().toISOString(),
        },
      });

      const runtimeMeta = await sessionStore.readSession(runtimeSession.id);
      const threadUrl = await __test__.resolveRequestedThreadUrl(
        {
          operation: "thread_history",
          prompt: "",
          sessionSlug: "slug-history",
          conversationId: " target-9 ",
          followupSession: threadSession.id,
        },
        runtimeMeta,
      );

      expect(threadUrl).toBe("https://chatgpt.com/g/team-space-oracle/c/target-9");
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await rm(oracleHome, { recursive: true, force: true });
    }
  });

  test("resolveRequestedThreadUrl rejects followup session URLs outside the configured project scope", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-thread-url-scope-"));
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      await sessionStore.ensureStorage();
      const runtimeSession = await sessionStore.createSession(
        {
          prompt: "broker runtime",
          model: "gpt-5.5",
          mode: "browser",
          browserConfig: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
        },
        process.cwd(),
      );
      await sessionStore.updateSession(runtimeSession.id, {
        status: "completed",
        browser: {
          config: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
          runtime: {
            chromePort: 9222,
            chromeHost: "127.0.0.1",
            tabUrl: "https://chatgpt.com/g/team-space/project",
          },
        },
      });
      const threadSession = await sessionStore.createSession(
        {
          prompt: "Supervisor thread: Target",
          model: "gpt-5.5",
          mode: "browser",
          browserConfig: {
            manualLogin: true,
            keepBrowser: true,
            chatgptUrl: "https://chatgpt.com/g/team-space/project",
          },
          followupSessionId: runtimeSession.id,
        },
        process.cwd(),
        undefined,
        "oracle-thread-target-9",
      );
      await sessionStore.updateSession(threadSession.id, {
        status: "completed",
        supervisorThread: {
          conversationId: "target-9",
          url: "https://chatgpt.com/c/target-9",
          projectUrl: "https://chatgpt.com/g/team-space/project",
          verifiedAt: new Date().toISOString(),
        },
      });

      const runtimeMeta = await sessionStore.readSession(runtimeSession.id);
      const threadUrl = await __test__.resolveRequestedThreadUrl(
        {
          operation: "thread_history",
          prompt: "",
          sessionSlug: "slug-history",
          conversationId: "target-9",
          followupSession: threadSession.id,
        },
        runtimeMeta,
      );

      expect(threadUrl).toBeUndefined();
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await rm(oracleHome, { recursive: true, force: true });
    }
  });

  test("parseBackendConversationHistoryEntries normalizes backend-api mapping entries", () => {
    const history = __test__.parseBackendConversationHistoryEntries(
      {
        conversation_id: "target-9",
        mapping: {
          "assistant-1": {
            message: {
              author: { role: "assistant" },
              create_time: 2,
              content: { parts: ["First answer"] },
            },
          },
          "user-1": {
            message: {
              author: { role: "user" },
              create_time: 1,
              content: { parts: ["First question"] },
            },
          },
          "assistant-duplicate": {
            message: {
              author: { role: "assistant" },
              create_time: 3,
              content: { parts: ["First answer"] },
            },
          },
          "ignored-tool": {
            message: {
              author: { role: "tool" },
              create_time: 4,
              content: { parts: ["internal"] },
            },
          },
          "assistant-2": {
            message: {
              role: "assistant",
              create_time: 5,
              content: { parts: [{ text: "Second answer" }] },
            },
          },
        },
      },
      "target-9",
    );

    expect(history).toEqual([
      { role: "user", text: "First question" },
      { role: "assistant", text: "First answer" },
      { role: "assistant", text: "Second answer" },
    ]);
  });

  test("selectProjectScopedHistoryFallback uses backend history only when project-scoped DOM history is underfilled", () => {
    const recovered = __test__.selectProjectScopedHistoryFallback({
      projectUrl: "https://chatgpt.com/g/team-space/project",
      expectedConversationId: "target-9",
      requestedLimit: 4,
      placeholderShellUnderfill: true,
      domHistory: [{ role: "assistant", text: "Visible only" }],
      backendBody: {
        conversation_id: "target-9",
        mapping: {
          "user-1": {
            message: {
              author: { role: "user" },
              create_time: 1,
              content: { parts: ["Q1"] },
            },
          },
          "assistant-1": {
            message: {
              author: { role: "assistant" },
              create_time: 2,
              content: { parts: ["A1"] },
            },
          },
          "user-2": {
            message: {
              author: { role: "user" },
              create_time: 3,
              content: { parts: ["Q2"] },
            },
          },
          "assistant-2": {
            message: {
              author: { role: "assistant" },
              create_time: 4,
              content: { parts: ["A2"] },
            },
          },
        },
      },
    });

    expect(recovered).toEqual({
      history: [
        { role: "user", text: "Q1" },
        { role: "assistant", text: "A1" },
        { role: "user", text: "Q2" },
        { role: "assistant", text: "A2" },
      ],
      historyWindow: {
        limit: 4,
        returnedCount: 4,
        totalCount: 4,
        truncated: false,
      },
    });
    expect(
      __test__.selectProjectScopedHistoryFallback({
        projectUrl: undefined,
        expectedConversationId: "target-9",
        requestedLimit: 4,
        placeholderShellUnderfill: true,
        domHistory: [{ role: "assistant", text: "Visible only" }],
        backendBody: {
          conversation_id: "target-9",
          mapping: {},
        },
      }),
    ).toBeNull();
    expect(
      __test__.selectProjectScopedHistoryFallback({
        projectUrl: "https://chatgpt.com/g/team-space/project",
        expectedConversationId: "target-9",
        requestedLimit: 4,
        placeholderShellUnderfill: false,
        domHistory: [{ role: "assistant", text: "Visible only" }],
        backendBody: {
          conversation_id: "target-9",
          mapping: {},
        },
      }),
    ).toBeNull();
    expect(
      __test__.selectProjectScopedHistoryFallback({
        projectUrl: "https://chatgpt.com/g/team-space/project",
        expectedConversationId: "target-9",
        requestedLimit: 4,
        placeholderShellUnderfill: true,
        domHistory: [{ role: "assistant", text: "Visible only" }],
        backendBody: {
          conversation_id: "wrong-conversation",
          mapping: {
            "user-1": {
              message: {
                author: { role: "user" },
                create_time: 1,
                content: { parts: ["Q1"] },
              },
            },
            "assistant-1": {
              message: {
                author: { role: "assistant" },
                create_time: 2,
                content: { parts: ["A1"] },
              },
            },
          },
        },
      }),
    ).toBeNull();
  });

  test("recoverProjectScopedSupervisorThreadHistoryFromBackendApi captures backend-api history through CDP", async () => {
    const listeners = new Map<string, (params: Record<string, unknown>) => void>();
    const Runtime = {
      evaluate: vi.fn(async (_params?: { expression?: string }) => ({
        result: {
          value: {
            url: "https://chatgpt.com/g/team-space-oracle/c/current-1",
            conversationId: "current-1",
            title: "Current",
            isActive: true,
          },
        },
      })),
    };
    const Network = {
      enable: vi.fn(async () => ({})),
      getResponseBody: vi.fn(async ({ requestId }: { requestId: string }) => {
        expect(requestId).toBe("req-1");
        return {
          base64Encoded: false,
          body: JSON.stringify({
            conversation_id: "target-9",
            current_node: "assistant-1",
            mapping: {
              root: {},
              "user-1": {
                parent: "root",
                message: {
                  author: { role: "user" },
                  content: { parts: ["Q1"] },
                },
              },
              "assistant-1": {
                parent: "user-1",
                message: {
                  author: { role: "assistant" },
                  content: { parts: ["A1"] },
                },
              },
            },
          }),
        };
      }),
    };
    const Page = {
      enable: vi.fn(async () => ({})),
      navigate: vi.fn(async ({ url }: { url: string }) => {
        expect(url).toBe("https://chatgpt.com/g/team-space-oracle/c/target-9");
        listeners.get("Network.requestWillBeSent")?.({
          request: {
            url: "https://chatgpt.com/backend-api/conversation/target-9",
            headers: { "chatgpt-project-id": "team-space" },
          },
        });
        listeners.get("Network.responseReceived")?.({
          requestId: "req-1",
          response: {
            url: "https://chatgpt.com/backend-api/conversation/target-9",
            status: 200,
          },
        });
        listeners.get("Network.loadingFinished")?.({
          requestId: "req-1",
        });
        return {};
      }),
    };
    const client = {
      Runtime,
      Network,
      Page,
      on: vi.fn((event: string, listener: (params: Record<string, unknown>) => void) => {
        listeners.set(event, listener);
      }),
    };

    const recovered = await __test__.recoverProjectScopedSupervisorThreadHistoryFromBackendApi(
      client as never,
      {
        projectUrl: "https://chatgpt.com/g/team-space-oracle/project",
        expectedConversationId: "target-9",
        requestedLimit: 5,
        domHistory: [{ role: "assistant", text: "Only visible answer" }],
        threadUrl: "https://chatgpt.com/g/team-space-oracle/c/target-9",
        placeholderShellUnderfill: true,
      },
    );

    expect(client.on).toHaveBeenCalledTimes(4);
    expect(Network.enable).toHaveBeenCalledTimes(1);
    expect(Page.enable).toHaveBeenCalledTimes(1);
    expect(Page.navigate).toHaveBeenCalledTimes(1);
    expect(Network.getResponseBody).toHaveBeenCalledTimes(1);
    expect(Runtime.evaluate).toHaveBeenCalledTimes(1);
    const runtimeEvaluateExpression = String(Runtime.evaluate.mock.calls[0]?.[0]?.expression ?? "");
    expect(runtimeEvaluateExpression).not.toContain("/backend-api/conversation/");
    expect(recovered).toEqual({
      history: [
        { role: "user", text: "Q1" },
        { role: "assistant", text: "A1" },
      ],
      historyWindow: {
        limit: 5,
        returnedCount: 2,
        totalCount: 2,
        truncated: false,
      },
    });
  });

  test("recoverProjectScopedSupervisorThreadHistoryFromBackendApi fails closed on project header mismatch", async () => {
    const listeners = new Map<string, (params: Record<string, unknown>) => void>();
    const client = {
      Runtime: {
        evaluate: vi.fn(async () => ({
          result: {
            value: {
              url: "https://chatgpt.com/g/team-space-oracle/c/current-1",
              conversationId: "current-1",
              title: "Current",
              isActive: true,
            },
          },
        })),
      },
      Network: {
        enable: vi.fn(async () => ({})),
        getResponseBody: vi.fn(async () => ({
          base64Encoded: false,
          body: JSON.stringify({
            conversation_id: "target-9",
            current_node: "assistant-1",
            mapping: {
              root: {},
              "assistant-1": {
                parent: "root",
                message: {
                  author: { role: "assistant" },
                  content: { parts: ["A1"] },
                },
              },
            },
          }),
        })),
      },
      Page: {
        enable: vi.fn(async () => ({})),
        navigate: vi.fn(async () => {
          listeners.get("Network.requestWillBeSent")?.({
            request: {
              url: "https://chatgpt.com/backend-api/conversation/target-9",
              headers: { "chatgpt-project-id": "wrong-project" },
            },
          });
          listeners.get("Network.responseReceived")?.({
            requestId: "req-1",
            response: {
              url: "https://chatgpt.com/backend-api/conversation/target-9",
              status: 200,
            },
          });
          listeners.get("Network.loadingFinished")?.({
            requestId: "req-1",
          });
          return {};
        }),
      },
      on: vi.fn((event: string, listener: (params: Record<string, unknown>) => void) => {
        listeners.set(event, listener);
      }),
    };

    await expect(
      __test__.recoverProjectScopedSupervisorThreadHistoryFromBackendApi(client as never, {
        projectUrl: "https://chatgpt.com/g/team-space/project",
        expectedConversationId: "target-9",
        requestedLimit: 5,
        domHistory: [{ role: "assistant", text: "Only visible answer" }],
        threadUrl: "https://chatgpt.com/g/team-space-oracle/c/target-9",
        placeholderShellUnderfill: true,
      }),
    ).rejects.toThrow(
      "Oracle conversation response used project wrong-project instead of team-space.",
    );
    expect(client.Network.getResponseBody).not.toHaveBeenCalled();
  });

  test("exits cleanly after shutdown request without waiting for stdin EOF", async () => {
    const broker = spawn(process.execPath, ["--import", "tsx", SUPERVISOR_BROKER_ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const brokerOutput = readline.createInterface({
      input: broker.stdout as NodeJS.ReadableStream,
      crlfDelay: Infinity,
    });
    const stderrChunks: string[] = [];
    broker.stderr?.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });

    try {
      if (!broker.stdin) {
        throw new Error("Supervisor broker stdin is unavailable.");
      }

      broker.stdin.write(
        `${JSON.stringify({
          operation: "attach_thread",
          prompt: "",
          sessionSlug: "broker-shutdown-regression",
        })}\n`,
      );
      const validationLine = await waitForBrokerOutputLine(brokerOutput, 5000);
      const validationResponse = JSON.parse(validationLine) as { ok: boolean; error?: string };
      expect(validationResponse.ok).toBe(false);
      expect(validationResponse.error).toContain("conversationId");

      const exitPromise = waitForChildExit(broker, 5000);
      broker.stdin.write(`${JSON.stringify({ shutdown: true })}\n`);

      const { code, signal } = await exitPromise;
      expect(code).toBe(0);
      expect(signal).toBeNull();
      expect(stderrChunks.join("").trim()).toBe("");
    } finally {
      brokerOutput.close();
      if (!broker.killed && broker.exitCode === null) {
        broker.kill("SIGKILL");
      }
    }
  }, 15_000);

  test("flushes large piped broker responses before exit", async () => {
    const brokerModuleUrl = pathToFileURL(
      path.join(process.cwd(), "src", "cli", "supervisorBroker.ts"),
    ).href;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
          import { __test__ } from ${JSON.stringify(brokerModuleUrl)};

          const history = Array.from({ length: 180 }, (_, index) => ({
            role: index % 2 === 0 ? "user" : "assistant",
            text: \`entry-\${index} \${"x".repeat(512)}\`,
          }));
          await __test__.writeSupervisorBrokerResponseLine({
            ok: true,
            sessionId: "runtime-history",
            thread: {
              title: "Attached thread",
              conversationId: "abc",
              url: "https://chatgpt.com/c/abc",
            },
            history,
            historyWindow: {
              limit: 200,
              returnedCount: history.length,
              totalCount: history.length,
              truncated: false,
            },
          });
        `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: string[] = [];
    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });

    const { code, signal } = await waitForChildExit(child, 15_000);
    expect(code).toBe(0);
    expect(signal).toBeNull();
    expect(stderrChunks.join("").trim()).toBe("");

    const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
    expect(stdout.length).toBeGreaterThan(65_536);
    const response = JSON.parse(stdout) as {
      ok: boolean;
      history: Array<{ role: string; text: string }>;
      historyWindow: { returnedCount: number; totalCount: number; truncated: boolean };
    };
    expect(response.ok).toBe(true);
    expect(response.history).toHaveLength(180);
    expect(response.history.at(-1)?.text).toContain("entry-179");
    expect(response.historyWindow).toEqual({
      limit: 200,
      returnedCount: 180,
      totalCount: 180,
      truncated: false,
    });
  }, 15_000);

  test("filterSupervisorThreadsForBrokerProjectScope drops in-scope guesses that lack a URL", () => {
    expect(
      __test__.filterSupervisorThreadsForBrokerProjectScope(
        [
          {
            title: "Sidebar id only",
            conversationId: "thread-from-sidebar",
          },
          {
            title: "Scoped thread",
            url: "https://chatgpt.com/g/team-space-oracle/c/right-thread",
            conversationId: "right-thread",
          },
          {
            title: "Root chat",
            url: "https://chatgpt.com/c/root-thread",
            conversationId: "root-thread",
          },
        ],
        "https://chatgpt.com/g/team-space/project",
      ),
    ).toEqual([
      {
        title: "Scoped thread",
        url: "https://chatgpt.com/g/team-space-oracle/c/right-thread",
        conversationId: "right-thread",
      },
    ]);
  });
});
