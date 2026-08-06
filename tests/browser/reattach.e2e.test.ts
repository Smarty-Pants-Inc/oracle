import { describe, expect, test, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { BrowserRuntimeMetadata } from "../../src/sessionManager.js";
import type { ChromeLaunchResult } from "../../src/browser/chromeLifecycle.js";
import type { BrowserRunResult } from "../../src/browser/types.js";

vi.mock("../../src/browser/reattach.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../src/browser/reattach.js");
  return {
    ...actual,
    resumeBrowserSession: vi.fn(),
  };
});
function committedRuntime(
  conversationId: string,
  runtime: BrowserRuntimeMetadata = {},
): BrowserRuntimeMetadata {
  const promptEpoch = {
    status: "committed" as const,
    epochId: `epoch-${conversationId}`,
    promptSha256: "b".repeat(64),
    baselineTurns: 0,
    followUpOrdinal: 0,
    remainingFollowUps: 0,
    verifiedUserTurnIndex: 0,
    verifiedUserTurnId: "turn-0",
    verifiedUserMessageId: "message-0",
    conversationId,
  };
  return {
    ...runtime,
    conversationId,
    promptEpoch,
    recoveryCleanupResources: runtime.recoveryCleanupResources?.map((resource) => ({
      ...resource,
      conversationId: resource.conversationId ?? conversationId,
      promptEpoch: resource.promptEpoch ?? promptEpoch,
    })),
  };
}

function chromeProcessIdentity(userDataDir: string, pid: number) {
  const canonicalPath = path.resolve(userDataDir);
  const normalizedUserDataDir =
    process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
  return {
    pid,
    processStartTime: "e2e-process-generation",
    executablePath:
      process.platform === "win32"
        ? String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`.toLowerCase()
        : process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : "/usr/bin/google-chrome",
    normalizedUserDataDir,
    launchNonce: "44444444-4444-4444-8444-444444444444",
    profileDirectory: {
      version: 1 as const,
      platform: process.platform,
      canonicalPath,
      device: "1",
      inode: "2",
    },
  };
}

function createReattachResult(
  answerText: string,
  answerMarkdown: string,
  runtime: BrowserRuntimeMetadata,
  onFinalize?: () => Promise<void> | void,
  fields: Partial<BrowserRunResult> = {},
) {
  const capturedRuntime = runtime.recoveryCleanupResources?.length
    ? { ...runtime, recoveryCleanupResult: { status: "pending" as const } }
    : runtime;
  const finalizedRuntime = { ...capturedRuntime };
  delete finalizedRuntime.recoveryCleanupResources;
  delete finalizedRuntime.recoveryCleanupResult;
  return {
    ...fields,
    answerText,
    answerMarkdown,
    runtime: capturedRuntime,
    bindSettlement: vi.fn(async (mode: "finalize" | "abort") =>
      capturedRuntime.recoveryCleanupResources?.length
        ? {
            ...capturedRuntime,
            recoveryCleanupResult: { status: "pending" as const, settlementMode: mode },
          }
        : capturedRuntime,
    ),
    finalize: vi.fn(async () => {
      await onFinalize?.();
      return { status: "completed" as const, runtime: finalizedRuntime };
    }),
    abort: vi.fn(async () => ({ status: "completed" as const, runtime: finalizedRuntime })),
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
  test("retries resource-only browser cleanup for a completed session", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { sessionStore } = await import("../../src/sessionStore.js");
      const updateSession = vi.spyOn(sessionStore, "updateSession");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");
      // Dynamic import preserves the per-test module graph after vi.resetModules and home override.
      const { persistDurableBrowserAnswer } = await import("../../src/cli/durableAnswer.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        { prompt: "Test prompt", model: "gpt-5.2-pro", mode: "browser", browserConfig: {} },
        path.join(tmpHome, "repo"),
      );
      const receipt = await persistDurableBrowserAnswer({
        sessionId: sessionMeta.id,
        answer: "Previously published browser answer",
      });
      await sessionStore.updateSession(sessionMeta.id, {
        status: "completed",
        mode: "browser",
        artifacts: [receipt.artifact],
        browser: {
          config: {},
          runtime: {
            recoveryCleanupResources: [
              {
                chromeHost: "remote.example.test",
                chromePort: 9222,
                recoveryCleanup: {
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

      expect(updateSession).toHaveBeenCalledWith(
        sessionMeta.id,
        expect.objectContaining({
          browser: expect.objectContaining({
            runtime: expect.objectContaining({
              recoveryCleanupResult: expect.objectContaining({
                status: "pending",
                settlementMode: "finalize",
                lockReleasePending: true,
              }),
            }),
          }),
        }),
      );
      const persisted = await sessionStore.readSession(sessionMeta.id);
      expect(persisted?.browser?.runtime).not.toHaveProperty("recoveryCleanupResources");
      expect(persisted?.browser?.runtime).not.toHaveProperty("recoveryCleanupResult");
      await expect(
        fs.stat(
          path.join((await sessionStore.getPaths(sessionMeta.id)).dir, "browser-recovery.lock"),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
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
      const paths = await sessionStore.getPaths(sessionMeta.id);
      const recoveredFilePath = path.join(paths.dir, "artifacts", "remote-result.zip");
      const recoveredReportPath = path.join(paths.dir, "artifacts", "deep-research-report.md");
      const recoveredTranscriptPath = path.join(paths.dir, "artifacts", "transcript.md");
      await fs.mkdir(path.dirname(recoveredFilePath), { recursive: true });
      await Promise.all([
        fs.writeFile(recoveredFilePath, "remote file"),
        fs.writeFile(recoveredReportPath, "# Recovered report"),
        fs.writeFile(recoveredTranscriptPath, "# Recovered transcript"),
      ]);
      const recoveredFile = {
        kind: "file" as const,
        path: recoveredFilePath,
        url: "bridge-artifact",
        filename: "remote-result.zip",
      };
      const recoveredModel = {
        requestedModel: "gpt-5.2-pro",
        resolvedLabel: "Pro",
        strategy: "select" as const,
        status: "already-selected" as const,
        verified: true,
        source: "chatgpt-model-picker" as const,
        capturedAt: "2026-08-05T00:00:00.000Z",
      };
      let durableCompletionObserved = false;
      const reattachResult = createReattachResult(
        "ok text",
        "ok markdown",
        runtime,
        async () => {
          const durable = await sessionStore.readSession(sessionMeta.id);
          durableCompletionObserved =
            durable?.status === "completed" && durable.response?.status === "completed";
        },
        {
          answerHtml: "<p>ok html</p>",
          artifacts: [
            { kind: "deep-research-report", path: recoveredReportPath },
            { kind: "transcript", path: recoveredTranscriptPath },
          ],
          savedFiles: [recoveredFile],
          archive: { mode: "auto", attempted: true, archived: true },
          modelSelection: recoveredModel,
          warnings: [{ code: "remote-warning", severity: "warning", message: "Recovered warning" }],
          tookMs: 42,
          answerTokens: 7,
          answerChars: 7,
        },
      );
      resumeMock.mockResolvedValue(reattachResult);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.response?.status).toBe("completed");
      expect(resumeMock).toHaveBeenCalledTimes(1);
      expect(resumeMock.mock.calls[0]?.[3]).toEqual(
        expect.objectContaining({ sessionId: sessionMeta.id }),
      );
      const runs = updated?.models ?? [];
      expect(runs.some((r) => r.status === "completed")).toBe(true);
      expect(durableCompletionObserved).toBe(true);
      expect(updated?.elapsedMs).toBe(42);
      expect(updated?.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "file", path: recoveredFilePath }),
          expect.objectContaining({ kind: "deep-research-report", path: recoveredReportPath }),
          expect.objectContaining({ kind: "transcript", path: recoveredTranscriptPath }),
        ]),
      );
      expect(updated?.browser).toMatchObject({
        archive: { mode: "auto", attempted: true, archived: true },
        modelSelection: recoveredModel,
        warnings: [{ code: "remote-warning", severity: "warning", message: "Recovered warning" }],
      });
      expect(reattachResult.finalize).toHaveBeenCalledOnce();
      expect(reattachResult.abort).not.toHaveBeenCalled();
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
      const canonicalRuntime = { ...runtime, tabUrl: "https://chatgpt.com/c/demo" };
      resumeMock.mockResolvedValue(
        createReattachResult("ok text", "ok markdown", canonicalRuntime),
      );
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
      const persistSpy = vi.spyOn(sessionStore, "updateSession");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      expect(resumeMock).toHaveBeenCalledTimes(1);
      expect(resumeMock.mock.calls[0]?.[0]?.tabUrl).toBe("https://chatgpt.com/c/demo");
      const canonicalWriteIndex = persistSpy.mock.calls.findIndex(
        ([, patch]) => patch.browser?.runtime?.tabUrl === "https://chatgpt.com/c/demo",
      );
      expect(canonicalWriteIndex).toBeGreaterThanOrEqual(0);
      expect(persistSpy.mock.invocationCallOrder[canonicalWriteIndex] ?? 0).toBeLessThan(
        resumeMock.mock.invocationCallOrder[0] ?? 0,
      );
      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.browser?.runtime).not.toHaveProperty("tabUrl");
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
      const canonicalRuntime = { ...runtime, tabUrl: "https://chatgpt.com/c/deep-project" };
      resumeMock.mockResolvedValue(
        createReattachResult(
          "# Deep report\n\nRecovered report body.",
          "# Deep report\n\nRecovered report body.",
          canonicalRuntime,
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
      const persistSpy = vi.spyOn(sessionStore, "updateSession");
      const paths = await sessionStore.getPaths(sessionMeta.id);
      await fs.writeFile(paths.log, "Answer:\nCalled tool\n", "utf8");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      expect(resumeMock).toHaveBeenCalledTimes(1);
      expect(resumeMock.mock.calls[0]?.[0]?.tabUrl).toBe("https://chatgpt.com/c/deep-project");
      const canonicalWriteIndex = persistSpy.mock.calls.findIndex(
        ([, patch]) => patch.browser?.runtime?.tabUrl === "https://chatgpt.com/c/deep-project",
      );
      expect(canonicalWriteIndex).toBeGreaterThanOrEqual(0);
      expect(persistSpy.mock.invocationCallOrder[canonicalWriteIndex] ?? 0).toBeLessThan(
        resumeMock.mock.invocationCallOrder[0] ?? 0,
      );
      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.browser?.runtime).not.toHaveProperty("tabUrl");
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
        recoveryCleanupResources: [
          {
            chromePid: 4242,
            chromeProcessIdentity: processIdentity,
            profileDirectoryIdentity: processIdentity.profileDirectory,
            chromePort: 51559,
            chromeHost: "127.0.0.1",
            chromeProfileRoot: profileDir,
            userDataDir: profileDir,
            chromeTargetId: "t-1",
            targetCloseCapability: {
              version: 1,
              generationId: "termination-generation",
              capabilityId: "termination-target-capability",
            },
            acquisition: { generationId: "termination-generation" },
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
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
        kill: vi.fn().mockResolvedValue({ status: "stopped", pid: 4242, signal: "SIGTERM" }),
      };
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      let resolveSignalHandled!: () => void;
      const signalHandled = new Promise<void>((resolve) => {
        resolveSignalHandled = resolve;
      });
      const removeHooks = registerTerminationHooks(
        chrome as unknown as ChromeLaunchResult,
        profileDir,
        false,
        () => {},
        { isInFlight: () => true, emitRuntimeHint, onSignalHandled: resolveSignalHandled },
      );

      process.emit("SIGINT");
      await signalHandled;

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
