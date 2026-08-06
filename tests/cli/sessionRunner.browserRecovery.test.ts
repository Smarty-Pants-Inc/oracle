import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/oracle.ts", async () => {
  const actual = await vi.importActual<typeof import("../../src/oracle.ts")>("../../src/oracle.ts");
  return {
    ...actual,
    runOracle: vi.fn(),
  };
});

vi.mock("../../src/oracle/multiModelRunner.ts", () => ({
  runMultiModelApiSession: vi.fn(),
}));

vi.mock("../../src/browser/sessionRunner.ts", () => ({
  runBrowserSessionExecution: vi.fn(),
  ensureSessionArtifacts: vi.fn(async ({ existingArtifacts }) => existingArtifacts),
}));

vi.mock("../../src/browser/reattach.ts", () => ({
  resumeBrowserSession: vi.fn(),
  settleBrowserRecoveryCleanup: vi.fn(),
}));
const persistDurableBrowserAnswerMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/cli/durableAnswer.ts", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../src/cli/durableAnswer.ts");
  return {
    ...actual,
    persistDurableBrowserAnswer: persistDurableBrowserAnswerMock,
  };
});

vi.mock("../../src/cli/notifier.ts", () => ({
  sendSessionNotification: vi.fn(async () => undefined),
  deriveNotificationSettingsFromMetadata: vi.fn(() => ({ enabled: true, sound: false })),
}));

const commitSessionModelProjectionMock = vi.hoisted(() => vi.fn());

const sessionStoreMock = vi.hoisted(() => ({
  updateSession: vi.fn(),
  createLogWriter: vi.fn(),
  updateModelRun: vi.fn(),
  readLog: vi.fn(),
  readSession: vi.fn(),
  readRequest: vi.fn(),
  ensureStorage: vi.fn(),
  listSessions: vi.fn(),
  filterSessions: vi.fn(),
  getPaths: vi.fn(),
  readModelLog: vi.fn(),
  sessionsDir: vi.fn().mockReturnValue("/tmp/.oracle/sessions"),
}));

vi.mock("../../src/sessionStore.ts", () => ({
  sessionStore: sessionStoreMock,
  commitSessionModelProjection: commitSessionModelProjectionMock,
}));

import type { BrowserRuntimeMetadata } from "../../src/sessionManager.ts";
import {
  baseRunOptions,
  baseSessionMeta,
  committedDemoAuthority,
  createCleanupRuntime,
} from "./sessionRunner.fixtures.ts";
import { performSessionRun } from "../../src/cli/sessionRunner.ts";
import { BrowserAutomationError } from "../../src/oracle.ts";
import { runMultiModelApiSession } from "../../src/oracle/multiModelRunner.ts";
import {
  ensureSessionArtifacts,
  runBrowserSessionExecution,
} from "../../src/browser/sessionRunner.ts";
import { resumeBrowserSession, settleBrowserRecoveryCleanup } from "../../src/browser/reattach.ts";
import { persistDurableBrowserAnswer } from "../../src/cli/durableAnswer.ts";
import { getCliVersion } from "../../src/version.ts";

const log = vi.fn();
const write = vi.fn(() => true);
const cliVersion = getCliVersion();

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  const testSessionDir = path.join(os.tmpdir(), "oracle-test-session");
  await fsPromises.rm(testSessionDir, { recursive: true, force: true });
  await fsPromises.mkdir(testSessionDir, { recursive: true });
  Object.values(sessionStoreMock).forEach((fn) => {
    if (typeof fn === "function" && "mockReset" in fn) {
      fn.mockReset();
    }
  });
  commitSessionModelProjectionMock.mockReset();
  vi.mocked(runMultiModelApiSession).mockReset();
  vi.mocked(resumeBrowserSession).mockReset();
  vi.mocked(settleBrowserRecoveryCleanup).mockReset();
  vi.mocked(runBrowserSessionExecution).mockReset();
  vi.mocked(ensureSessionArtifacts).mockReset();
  vi.mocked(persistDurableBrowserAnswer).mockReset();
  vi.mocked(persistDurableBrowserAnswer).mockImplementation(async (_options, expectedReceipt) => {
    if (!expectedReceipt) throw new Error("publication intent receipt missing");
    return expectedReceipt;
  });
  vi.mocked(ensureSessionArtifacts).mockImplementation(
    async ({ existingArtifacts }) => existingArtifacts,
  );
  vi.mocked(runMultiModelApiSession).mockResolvedValue({
    fulfilled: [],
    rejected: [],
    elapsedMs: 0,
  });
  sessionStoreMock.updateSession.mockImplementation(async (sessionId, updates) => ({
    ...baseSessionMeta,
    id: sessionId,
    ...updates,
  }));
  sessionStoreMock.updateModelRun.mockImplementation(async (_sessionId, model, updates) => ({
    model,
    status: "running",
    ...updates,
  }));
  commitSessionModelProjectionMock.mockImplementation(async (sessionId, projection) => {
    const baseSession = await sessionStoreMock.updateSession(sessionId, projection.session);
    if (!projection.model) return { session: baseSession };
    const model = await sessionStoreMock.updateModelRun(
      sessionId,
      projection.model.model,
      projection.model.updates,
    );
    const session = {
      ...baseSession,
      models: [model],
      modelProjectionAuthority: "session",
    };
    return { session, model };
  });
  sessionStoreMock.readSession.mockResolvedValue(null);
  sessionStoreMock.createLogWriter.mockReturnValue({
    logLine: vi.fn(),
    writeChunk: vi.fn(),
    stream: { end: vi.fn() },
  });
  sessionStoreMock.readModelLog.mockResolvedValue("model log body");
  sessionStoreMock.sessionsDir.mockReturnValue("/tmp/.oracle/sessions");
  sessionStoreMock.getPaths.mockResolvedValue({
    dir: path.join(os.tmpdir(), "oracle-test-session"),
    metadata: path.join(os.tmpdir(), "oracle-test-session", "metadata.json"),
    log: path.join(os.tmpdir(), "oracle-test-session", "session.log"),
    request: path.join(os.tmpdir(), "oracle-test-session", "request.json"),
  });
  vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
  vi.spyOn(fsPromises, "writeFile").mockResolvedValue(undefined);
});

describe("performSessionRun", () => {
  test("records metadata when browser automation fails", async () => {
    const automationError = new BrowserAutomationError("automation failed", {
      stage: "execute-browser",
    });
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);
    const staleSessionMeta = {
      ...baseSessionMeta,
      browser: {
        config: { desiredModel: "Old Pro" },
        runtime: { tabUrl: "https://chatgpt.com/c/old" },
        modelSelection: {
          requestedModel: "Old Pro",
          resolvedLabel: "Old Pro",
          strategy: "select" as const,
          status: "already-selected" as const,
          verified: true,
          source: "chatgpt-model-picker" as const,
          capturedAt: "2026-07-02T00:00:00.000Z",
        },
      },
    };

    await expect(
      performSessionRun({
        sessionMeta: staleSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("automation failed");

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      errorMessage: "automation failed",
      browser: expect.objectContaining({ config: expect.any(Object) }),
    });
    expect(finalUpdate?.browser?.runtime).toBeUndefined();
    expect(finalUpdate?.browser).not.toHaveProperty("modelSelection");
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "error" }),
    );
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).not.toContain("Next steps (browser fallback)");
    expect(logLines).not.toContain("--engine api");
    expect(logLines).not.toContain("This run did not return cleanly");
  });

  test("preserves persisted runtime hints when browser automation fails without runtime details", async () => {
    const automationError = new BrowserAutomationError(
      "Prompt did not appear in conversation before timeout (send may have failed)",
      { stage: "submit-prompt", code: "prompt-commit-timeout" },
    );
    vi.mocked(runBrowserSessionExecution).mockImplementationOnce(async (_args, deps) => {
      // Simulate the runtime hint emitted right after the send click,
      // before commit verification fails.
      await (
        deps as {
          persistRuntimeHint?: (
            runtime: Record<string, unknown>,
            modelSelection?: Record<string, unknown>,
          ) => Promise<void>;
        }
      ).persistRuntimeHint?.(
        {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
          conversationId: "demo",
          promptEpoch: {
            status: "pending",
            epochId: "epoch-demo-pending",
            promptSha256: "d".repeat(64),
            baselineTurns: 0,
            followUpOrdinal: 0,
            remainingFollowUps: 0,
          },
        },
        {
          requestedModel: "Pro",
          resolvedLabel: "Pro",
          strategy: "select",
          status: "already-selected",
          verified: true,
          source: "chatgpt-model-picker",
          capturedAt: "2026-07-03T00:00:00.000Z",
        },
      );
      throw automationError;
    });

    await expect(
      performSessionRun({
        sessionMeta: { ...baseSessionMeta },
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow(/prompt did not appear/i);

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      browser: expect.objectContaining({
        config: expect.any(Object),
        runtime: expect.objectContaining({
          tabUrl: "https://chatgpt.com/c/demo",
          promptEpoch: expect.objectContaining({ status: "pending", baselineTurns: 0 }),
        }),
        modelSelection: expect.objectContaining({ resolvedLabel: "Pro", verified: true }),
      }),
      error: expect.objectContaining({
        details: expect.objectContaining({ code: "prompt-commit-timeout" }),
      }),
    });
  });

  test("does not overwrite completed cleanup with the stale pending runtime on the escaping error", async () => {
    const pendingRuntime = createCleanupRuntime("TARGET-SETTLED");
    const completedRuntime: BrowserRuntimeMetadata = { ...pendingRuntime };
    delete completedRuntime.recoveryCleanupResources;
    delete completedRuntime.recoveryCleanupResult;
    const automationError = new BrowserAutomationError("automation failed after cleanup", {
      stage: "connection-lost",
      recoverableDisconnect: true,
      runtime: pendingRuntime,
    });
    vi.mocked(runBrowserSessionExecution).mockImplementationOnce(async (_args, deps) => {
      await deps?.persistRuntimeHint?.(pendingRuntime);
      await deps?.persistRuntimeHint?.(completedRuntime);
      throw automationError;
    });

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("automation failed after cleanup");
    expect(resumeBrowserSession).not.toHaveBeenCalled();

    const completedHintIndex = sessionStoreMock.updateSession.mock.calls.findIndex(
      ([, update]) =>
        update.browser?.runtime?.chromeTargetId === "TARGET-SETTLED" &&
        update.browser.runtime.recoveryCleanupResources === undefined,
    );
    expect(completedHintIndex).toBeGreaterThanOrEqual(0);
    const updatesAfterCompletion =
      sessionStoreMock.updateSession.mock.calls.slice(completedHintIndex);
    for (const [, update] of updatesAfterCompletion) {
      const persistedRuntime = update.browser?.runtime;
      if (!persistedRuntime) continue;
      expect(persistedRuntime).not.toHaveProperty("recoveryCleanupResources");
      expect(persistedRuntime).not.toHaveProperty("recoveryCleanupResult");
    }
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      browser: {
        runtime: {
          chromeTargetId: "TARGET-SETTLED",
          conversationId: "demo",
          promptEpoch: expect.objectContaining({ status: "committed", epochId: "epoch-demo" }),
        },
      },
      error: {
        details: {
          runtime: expect.objectContaining({
            chromeTargetId: "TARGET-SETTLED",
            promptEpoch: expect.objectContaining({ status: "committed" }),
          }),
        },
      },
    });
    expect(finalUpdate?.browser?.runtime).not.toHaveProperty("recoveryCleanupResources");
    expect(finalUpdate?.browser?.runtime).not.toHaveProperty("recoveryCleanupResult");
    expect(finalUpdate?.error?.details?.runtime).not.toHaveProperty("recoveryCleanupResources");
    expect(finalUpdate?.error?.details?.runtime).not.toHaveProperty("recoveryCleanupResult");
  });

  test("accepts a recoverable error runtime with a new exact target after prior cleanup completed", async () => {
    const settledRuntime = createCleanupRuntime("TARGET-OLD");
    const completedRuntime: BrowserRuntimeMetadata = { ...settledRuntime };
    delete completedRuntime.recoveryCleanupResources;
    delete completedRuntime.recoveryCleanupResult;
    const newerRuntime = createCleanupRuntime("TARGET-NEW");
    const automationError = new BrowserAutomationError("new target disconnected", {
      stage: "execute-browser",
      runtime: newerRuntime,
    });
    vi.mocked(runBrowserSessionExecution).mockImplementationOnce(async (_args, deps) => {
      await deps?.persistRuntimeHint?.(settledRuntime);
      await deps?.persistRuntimeHint?.(completedRuntime);
      throw automationError;
    });

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("new target disconnected");

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate?.browser?.runtime).toMatchObject({
      chromeTargetId: "TARGET-NEW",
      recoveryCleanupResult: { status: "pending" },
      promptEpoch: expect.objectContaining({ status: "committed", epochId: "epoch-demo" }),
    });
    expect(finalUpdate?.error?.details?.runtime).toMatchObject({
      chromeTargetId: "TARGET-NEW",
      recoveryCleanupResult: { status: "pending" },
    });
  });

  test("keeps failed cleanup authority over an older pending error snapshot", async () => {
    const failedRuntime = createCleanupRuntime("TARGET-FAILED", "failed");
    const stalePendingRuntime = createCleanupRuntime("TARGET-FAILED");
    const automationError = new BrowserAutomationError("stale cleanup snapshot escaped", {
      stage: "execute-browser",
      runtime: stalePendingRuntime,
    });
    vi.mocked(runBrowserSessionExecution).mockImplementationOnce(async (_args, deps) => {
      await deps?.persistRuntimeHint?.(failedRuntime);
      throw automationError;
    });

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("stale cleanup snapshot escaped");

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate?.browser?.runtime?.recoveryCleanupResult).toEqual({
      status: "failed",
      error: "cleanup failed for TARGET-FAILED",
      settlementMode: "abort",
    });
    expect(finalUpdate?.error?.details?.runtime).toMatchObject({
      chromeTargetId: "TARGET-FAILED",
      recoveryCleanupResult: {
        status: "failed",
        error: "cleanup failed for TARGET-FAILED",
        settlementMode: "abort",
      },
    });
  });

  test("keeps session running when browser connection is lost", async () => {
    const automationError = new BrowserAutomationError(
      "Chrome DevTools client disconnected before oracle finished; the browser target appears still alive.",
      {
        stage: "connection-lost",
        recoverableDisconnect: true,
        disconnectCause: "cdp-client-disconnect",
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
          ...committedDemoAuthority,
        },
      },
    );
    vi.mocked(runBrowserSessionExecution).mockImplementationOnce(async (_args, deps) => {
      await deps?.persistRuntimeHint?.(
        {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
          ...committedDemoAuthority,
        },
        {
          requestedModel: "Pro",
          resolvedLabel: "Pro",
          strategy: "select",
          status: "already-selected",
          verified: true,
          source: "chatgpt-model-picker",
          capturedAt: "2026-07-03T00:00:00.000Z",
        },
      );
      throw automationError;
    });
    vi.mocked(resumeBrowserSession).mockRejectedValueOnce(new Error("target not ready"));

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: "browser",
      browserConfig: { chromePath: null },
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    expect(vi.mocked(resumeBrowserSession)).toHaveBeenCalledTimes(1);
    expect(commitSessionModelProjectionMock).toHaveBeenCalledWith(
      baseSessionMeta.id,
      expect.objectContaining({
        session: expect.objectContaining({
          status: "running",
          response: { status: "running", incompleteReason: "chrome-disconnected" },
        }),
        model: expect.objectContaining({
          model: "gpt-5.2-pro",
          updates: expect.objectContaining({ status: "running" }),
        }),
      }),
    );
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "running",
      response: { status: "running", incompleteReason: "chrome-disconnected" },
      browser: expect.objectContaining({
        runtime: expect.objectContaining({ chromePort: 9222 }),
        modelSelection: expect.objectContaining({ resolvedLabel: "Pro", verified: true }),
      }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "running" }),
    );
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).toContain(
      "Chrome disconnected before completion; keeping session running for reattach.",
    );
    expect(logLines).toContain("oracle session sess-1 --render");
    expect(logLines).toContain("Auto-reattach attempt 1");
  });
});
