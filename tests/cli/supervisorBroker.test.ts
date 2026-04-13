import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { __test__, runSupervisorBrokerRequest } from "../../src/cli/supervisorBroker.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { sessionStore } from "../../src/sessionStore.js";

describe("runSupervisorBrokerRequest", () => {
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
    const captureFrontmostProcess = vi.fn(async () => "Zed");
    const hideChromeWindow = vi.fn(async (..._args: unknown[]) => {});
    const startChromeFocusGuard = vi.fn(() => vi.fn());
    const finalizeChromeFocusProtection = vi.fn(async () => {});

    const result = await __test__.withChromeFocusProtection(undefined, action, {
      captureFrontmostProcess,
      hideChromeWindow,
      startChromeFocusGuard,
      finalizeChromeFocusProtection,
    } as never);

    expect(result).toBe("ok");
    expect(action).toHaveBeenCalledTimes(1);
    expect(captureFrontmostProcess).not.toHaveBeenCalled();
    expect(hideChromeWindow).not.toHaveBeenCalled();
    expect(startChromeFocusGuard).not.toHaveBeenCalled();
    expect(finalizeChromeFocusProtection).not.toHaveBeenCalled();
  });

  test("focus protection hides chrome before and after the broker action", async () => {
    const action = vi.fn(async () => "ok");
    const captureFrontmostProcess = vi.fn(async () => "Zed");
    const hideChromeWindow = vi.fn(async (..._args: unknown[]) => {});
    const stopFocusGuard = vi.fn();
    const startChromeFocusGuard = vi.fn(() => stopFocusGuard);
    const finalizeChromeFocusProtection = vi.fn(async () => {
      await hideChromeWindow({ pid: 4242 } as never, vi.fn() as never, "Zed");
      stopFocusGuard();
    });

    const result = await __test__.withChromeFocusProtection(4242, action, {
      captureFrontmostProcess,
      hideChromeWindow,
      startChromeFocusGuard,
      finalizeChromeFocusProtection,
    } as never);

    expect(result).toBe("ok");
    expect(action).toHaveBeenCalledTimes(1);
    expect(captureFrontmostProcess).toHaveBeenCalledTimes(1);
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
    const captureFrontmostProcess = vi.fn(async () => {
      callOrder.push("capture");
      return "Zed";
    });
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
        captureFrontmostProcess,
        hideChromeWindow,
        startChromeFocusGuard,
        finalizeChromeFocusProtection,
      } as never,
    );

    expect(result).toBe("ok");
    expect(callOrder).toEqual([
      "lease-start",
      "resolve",
      "capture",
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

  test("syncSupervisorRuntimeSession persists the active chrome target for a broker thread", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-broker-"));
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      await sessionStore.ensureStorage();
      const meta = await sessionStore.createSession(
        {
          prompt: "broker runtime",
          model: "gpt-5.4",
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

  test("createSupervisorThreadSession returns a fresh per-thread session id", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-thread-"));
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      await sessionStore.ensureStorage();
      const runtimeSession = await sessionStore.createSession(
        {
          prompt: "broker runtime",
          model: "gpt-5.4",
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
          model: "gpt-5.4",
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

  test("createSupervisorThreadSession rejects threads outside the configured project scope", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-supervisor-thread-scope-"));
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      await sessionStore.ensureStorage();
      const runtimeSession = await sessionStore.createSession(
        {
          prompt: "broker runtime",
          model: "gpt-5.4",
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
