import { describe, expect, test, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { BrowserRuntimeMetadata } from "../../src/sessionManager.js";

vi.mock("../../src/browser/reattach.js", () => ({
  resumeBrowserSession: vi.fn(),
  retryBrowserRecoveryCleanup: vi.fn(async (runtime: BrowserRuntimeMetadata) => ({
    status: "completed",
    runtime: {
      ...runtime,
      recoveryCleanupBacklog: undefined,
      recoveryCleanupResult: undefined,
    },
  })),
}));
function committedRuntime(
  conversationId: string,
  runtime: BrowserRuntimeMetadata = {},
): BrowserRuntimeMetadata {
  return {
    ...runtime,
    promptSubmitted: true,
    conversationId,
    promptEpoch: {
      status: "committed",
      epochId: `epoch-${conversationId}`,
      promptSha256: "b".repeat(64),
      baselineTurns: 0,
      followUpOrdinal: 0,
      remainingFollowUps: 0,
      verifiedUserTurnIndex: 0,
      conversationId,
    },
  };
}

function chromeProcessIdentity(userDataDir: string, pid: number) {
  return {
    pid,
    processStartTime: "e2e-process-generation",
    executablePath: "/usr/bin/google-chrome",
    normalizedUserDataDir: path.resolve(userDataDir),
    launchNonce: "44444444-4444-4444-8444-444444444444",
  };
}

function createReattachResult(
  answerText: string,
  answerMarkdown: string,
  runtime: BrowserRuntimeMetadata,
  onFinalize?: () => Promise<void> | void,
) {
  const capturedRuntime =
    runtime.recoveryCleanup || runtime.recoveryCleanupBacklog?.length
      ? { ...runtime, recoveryCleanupResult: { status: "pending" as const } }
      : runtime;
  const finalizedRuntime = { ...capturedRuntime };
  delete finalizedRuntime.recoveryCleanup;
  delete finalizedRuntime.recoveryCleanupBacklog;
  delete finalizedRuntime.recoveryCleanupResult;
  return {
    answerText,
    answerMarkdown,
    runtime: capturedRuntime,
    finalize: vi.fn(async () => {
      await onFinalize?.();
      return { status: "completed" as const, runtime: finalizedRuntime };
    }),
    abandon: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("browser reattach end-to-end (simulated)", () => {
  test("retries backlog-only browser cleanup for a completed session", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { retryBrowserRecoveryCleanup } = await import("../../src/browser/reattach.js");
      const retryMock = vi.mocked(retryBrowserRecoveryCleanup);
      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        { prompt: "Test prompt", model: "gpt-5.2-pro", mode: "browser", browserConfig: {} },
        path.join(tmpHome, "repo"),
      );
      await sessionStore.updateSession(sessionMeta.id, {
        status: "completed",
        mode: "browser",
        browser: {
          config: {},
          runtime: {
            recoveryCleanupBacklog: [
              {
                chromeHost: "remote.example.test",
                chromePort: 9222,
                recoveryCleanup: {
                  transport: "remote",
                  ownsTarget: false,
                  profileKind: "none",
                  keepBrowser: true,
                },
              },
            ],
            recoveryCleanupResult: { status: "failed", error: "previous cleanup failed" },
          },
        },
        response: { status: "completed" },
      });
      vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      expect(retryMock).toHaveBeenCalledTimes(1);
      expect(retryMock).toHaveBeenCalledWith(
        expect.objectContaining({ recoveryCleanupBacklog: expect.any(Array) }),
        expect.any(Function),
        expect.objectContaining({
          recoveryLockPath: path.join(
            (await sessionStore.getPaths(sessionMeta.id)).dir,
            "browser-recovery.lock",
          ),
        }),
      );
      const persisted = await sessionStore.readSession(sessionMeta.id);
      expect(persisted?.browser?.runtime).not.toHaveProperty("recoveryCleanupBacklog");
      expect(persisted?.browser?.runtime).not.toHaveProperty("recoveryCleanupResult");
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("marks session completed after reconnection", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Test prompt",
          model: "gpt-5.2-pro",
          mode: "browser",
          browserConfig: {},
        },
        "/repo",
      );
      await sessionStore.updateModelRun(sessionMeta.id, "gpt-5.2-pro", {
        status: "running",
        startedAt: new Date().toISOString(),
      });
      const runtime = committedRuntime("demo", {
        chromePort: 51559,
        chromeHost: "127.0.0.1",
        chromeTargetId: "t-1",
        tabUrl: "https://chatgpt.com/c/demo",
      });
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        mode: "browser",
        browser: {
          config: {},
          runtime,
        },
        response: { status: "running", incompleteReason: "chrome-disconnected" },
        error: {
          category: "browser-automation",
          message: "Chrome disconnected",
          details: { stage: "connection-lost", recoverableDisconnect: true },
        },
      });
      let durableCompletionObserved = false;
      const reattachResult = createReattachResult("ok text", "ok markdown", runtime, async () => {
        const durable = await sessionStore.readSession(sessionMeta.id);
        durableCompletionObserved =
          durable?.status === "completed" && durable.response?.status === "completed";
      });
      resumeMock.mockResolvedValue(reattachResult);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.response?.status).toBe("completed");
      expect(resumeMock).toHaveBeenCalledTimes(1);
      const runs = updated?.models ?? [];
      expect(runs.some((r) => r.status === "completed")).toBe(true);
      expect(durableCompletionObserved).toBe(true);
      expect(reattachResult.finalize).toHaveBeenCalledOnce();
      expect(reattachResult.abandon).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("does not reattach a disconnect explicitly classified as non-recoverable", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      resumeMock.mockResolvedValue(
        createReattachResult("should not happen", "nope", committedRuntime("demo")),
      );

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Test prompt",
          model: "gpt-5.2-pro",
          mode: "browser",
          browserConfig: {},
        },
        "/repo",
      );
      await sessionStore.updateSession(sessionMeta.id, {
        status: "error",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        mode: "browser",
        browser: {
          config: {},
          runtime: {
            chromePort: 51559,
            chromeHost: "127.0.0.1",
            chromeTargetId: "t-1",
            tabUrl: "https://chatgpt.com/c/demo",
            promptSubmitted: false,
          },
        },
        response: { status: "error", incompleteReason: "chrome-disconnected" },
        error: {
          category: "browser-automation",
          message: "Chrome disconnected before prompt commit",
          details: { stage: "connection-lost", recoverableDisconnect: false },
        },
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      expect(resumeMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("reattaches a live chrome-disconnected session with a stale cached URL", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Test prompt",
          model: "gpt-5.2-pro",
          mode: "browser",
          browserConfig: {},
        },
        "/repo",
      );
      const runtime = committedRuntime("demo", {
        chromeProfileRoot: path.join(tmpHome, "chrome-profile"),
        chromeHost: "127.0.0.1",
        chromeTargetId: "t-1",
        tabUrl: "https://chatgpt.com/",
      });
      resumeMock.mockResolvedValue(createReattachResult("ok text", "ok markdown", runtime));
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        mode: "browser",
        browser: {
          config: {},
          runtime,
        },
        response: { status: "running", incompleteReason: "chrome-disconnected" },
        error: {
          category: "browser-automation",
          message: "Chrome disconnected",
          details: { stage: "connection-lost", recoverableDisconnect: true },
        },
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      expect(resumeMock).toHaveBeenCalledTimes(1);
      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe("completed");
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("reattaches completed Deep Research sessions that only captured a tool placeholder", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      const runtime = committedRuntime("deep", {
        chromePort: 51559,
        chromeHost: "127.0.0.1",
        chromeTargetId: "t-1",
        tabUrl: "https://chatgpt.com/c/deep",
      });
      resumeMock.mockResolvedValue(
        createReattachResult(
          "# Deep report\n\nRecovered report body.",
          "# Deep report\n\nRecovered report body.",
          runtime,
        ),
      );

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Deep research prompt",
          model: "gpt-5.6-sol-pro",
          mode: "browser",
          browserConfig: { researchMode: "deep" },
        },
        "/repo",
      );
      await sessionStore.updateModelRun(sessionMeta.id, "gpt-5.6-sol-pro", {
        status: "completed",
        usage: { inputTokens: 0, outputTokens: 3, reasoningTokens: 0, totalTokens: 3 },
      });
      await sessionStore.updateSession(sessionMeta.id, {
        status: "completed",
        mode: "browser",
        usage: { inputTokens: 0, outputTokens: 3, reasoningTokens: 0, totalTokens: 3 },
        browser: {
          config: { researchMode: "deep" },
          runtime,
        },
        response: { status: "completed" },
      });
      const paths = await sessionStore.getPaths(sessionMeta.id);
      await fs.writeFile(paths.log, "Answer:\nCalled tool\n", "utf8");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      const updated = await sessionStore.readSession(sessionMeta.id);
      const log = await sessionStore.readLog(sessionMeta.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.response?.status).toBe("completed");
      expect(resumeMock).toHaveBeenCalledTimes(1);
      expect(log).toContain("Recovered report body");
      expect(log).not.toContain("Called tool");
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("reattaches completed Deep Research placeholders from a project URL", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      const runtime = committedRuntime("deep-project", {
        tabUrl: "https://chatgpt.com/g/g-p-demo/project",
      });
      resumeMock.mockResolvedValue(
        createReattachResult(
          "# Deep report\n\nRecovered report body.",
          "# Deep report\n\nRecovered report body.",
          runtime,
        ),
      );

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Deep research prompt",
          model: "gpt-5.5-pro",
          mode: "browser",
          browserConfig: { researchMode: "deep" },
        },
        "/repo",
      );
      await sessionStore.updateSession(sessionMeta.id, {
        status: "completed",
        mode: "browser",
        usage: { inputTokens: 0, outputTokens: 3, reasoningTokens: 0, totalTokens: 3 },
        browser: {
          config: { researchMode: "deep" },
          runtime,
        },
        response: { status: "completed" },
      });
      const paths = await sessionStore.getPaths(sessionMeta.id);
      await fs.writeFile(paths.log, "Answer:\nCalled tool\n", "utf8");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      expect(resumeMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("reattaches an authorized disconnect when controller pid is gone", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Test prompt",
          model: "gpt-5.2-pro",
          mode: "browser",
          browserConfig: {},
        },
        "/repo",
      );
      await sessionStore.updateModelRun(sessionMeta.id, "gpt-5.2-pro", {
        status: "running",
        startedAt: new Date().toISOString(),
      });
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        mode: "browser",
        browser: {
          config: {},
          runtime: {
            chromePort: 51559,
            chromeHost: "127.0.0.1",
            chromeTargetId: "t-1",
            tabUrl: "https://chatgpt.com/c/demo",
            controllerPid: undefined,
          },
        },
      });

      const deadController = spawn(process.execPath, ["-e", "process.exit(0)"], {
        stdio: "ignore",
      });
      await once(deadController, "exit");
      const runtime = committedRuntime("demo", {
        chromePort: 51559,
        chromeHost: "127.0.0.1",
        chromeTargetId: "t-1",
        tabUrl: "https://chatgpt.com/c/demo",
        controllerPid: deadController.pid ?? undefined,
      });
      resumeMock.mockResolvedValue(createReattachResult("ok text", "ok markdown", runtime));
      await sessionStore.updateSession(sessionMeta.id, {
        browser: {
          config: {},
          runtime,
        },
        response: { status: "running", incompleteReason: "chrome-disconnected" },
        error: {
          category: "browser-automation",
          message: "Chrome disconnected",
          details: { stage: "connection-lost", recoverableDisconnect: true },
        },
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.response?.status).toBe("completed");
      expect(resumeMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("reattaches after CLI termination when Chrome is left running", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);

      const { registerTerminationHooks } = await import("../../src/browser/chromeLifecycle.js");
      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Test prompt",
          model: "gpt-5.2-pro",
          mode: "browser",
          browserConfig: {},
        },
        "/repo",
      );
      await sessionStore.updateModelRun(sessionMeta.id, "gpt-5.2-pro", {
        status: "running",
        startedAt: new Date().toISOString(),
      });
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        mode: "browser",
        browser: { config: {} },
        response: { status: "running" },
      });

      const deadController = spawn(process.execPath, ["-e", "process.exit(0)"], {
        stdio: "ignore",
      });
      await once(deadController, "exit");
      const deadControllerPid = deadController.pid ?? undefined;
      const profileDir = path.join(tmpHome, "oracle-browser-termination-profile");
      const processIdentity = chromeProcessIdentity(profileDir, 4242);
      const runtime = committedRuntime("demo", {
        chromePid: 4242,
        chromeProcessIdentity: processIdentity,
        chromePort: 51559,
        chromeHost: "127.0.0.1",
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        chromeTargetId: "t-1",
        tabUrl: "https://chatgpt.com/c/demo",
        controllerPid: deadControllerPid,
        recoveryCleanup: {
          transport: "local",
          ownsTarget: true,
          profileKind: "temporary",
          keepBrowser: false,
        },
      });
      resumeMock.mockResolvedValue(createReattachResult("ok text", "ok markdown", runtime));

      const emitRuntimeHint = async () => {
        await sessionStore.updateSession(sessionMeta.id, {
          browser: {
            config: {},
            runtime,
          },
          response: { status: "running", incompleteReason: "chrome-disconnected" },
          error: {
            category: "browser-automation",
            message: "Chrome disconnected",
            details: { stage: "connection-lost", recoverableDisconnect: true },
          },
        });
      };

      const chrome = {
        pid: 4242,
        port: 51559,
        processIdentity,
        kill: vi.fn().mockResolvedValue(undefined),
      };
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const removeHooks = registerTerminationHooks(
        chrome as unknown as import("chrome-launcher").LaunchedChrome,
        profileDir,
        false,
        () => {},
        { isInFlight: () => true, emitRuntimeHint },
      );

      process.emit("SIGINT");
      for (let i = 0; i < 20; i += 1) {
        const refreshed = await sessionStore.readSession(sessionMeta.id);
        if (refreshed?.browser?.runtime?.chromePort) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      removeHooks();
      exitSpy.mockRestore();

      expect(chrome.kill).not.toHaveBeenCalled();

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });
      logSpy.mockRestore();

      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.response?.status).toBe("completed");
      expect(resumeMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);
});
