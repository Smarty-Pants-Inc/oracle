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
} from "./sessionRunner.fixtures.ts";
import type { BrowserRunResult } from "../../src/browser/types.ts";
import { performSessionRun } from "../../src/cli/sessionRunner.ts";
import { BrowserAutomationError } from "../../src/oracle.ts";
import { runMultiModelApiSession } from "../../src/oracle/multiModelRunner.ts";
import {
  ensureSessionArtifacts,
  runBrowserSessionExecution,
} from "../../src/browser/sessionRunner.ts";
import { resumeBrowserSession, settleBrowserRecoveryCleanup } from "../../src/browser/reattach.ts";
import { persistDurableBrowserAnswer } from "../../src/cli/durableAnswer.ts";
import { readBrowserCapturePublicationJournal } from "../../src/cli/browserPublicationJournal.js";
import { getCliVersion } from "../../src/version.ts";

const log = vi.fn();
const write = vi.fn(() => true);
const cliVersion = getCliVersion();

function createReattachResult(
  answerText: string,
  answerMarkdown: string,
  runtime: BrowserRuntimeMetadata,
  fields: Partial<BrowserRunResult> = {},
) {
  const preSettlementCleanupResult = runtime.recoveryCleanupResult;
  const capturedRuntime = runtime.recoveryCleanupResources?.length
    ? {
        ...runtime,
        recoveryCleanupResult: preSettlementCleanupResult ?? { status: "pending" as const },
      }
    : runtime;
  const finalizedRuntime = { ...capturedRuntime };
  delete finalizedRuntime.recoveryCleanupResources;
  delete finalizedRuntime.recoveryCleanupResult;
  const bindSettlement = vi.fn(async () => capturedRuntime);
  const finalize = vi.fn(async () => ({ status: "completed" as const, runtime: finalizedRuntime }));
  const abort = vi.fn(async () => ({ status: "completed" as const, runtime: finalizedRuntime }));
  return {
    value: {
      ...fields,
      answerText,
      answerMarkdown,
      runtime: capturedRuntime,
      bindSettlement,
      finalize,
      abort,
    },
    finalize,
    abort,
  };
}

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
  test("marks a non-recoverable disconnect as an error without reattach", async () => {
    const automationError = new BrowserAutomationError(
      "Chrome window closed before oracle finished. Please keep it open until completion.",
      {
        stage: "connection-lost",
        recoverableDisconnect: false,
        disconnectCause: "chrome-closed",
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
        },
      },
    );
    vi.mocked(runBrowserSessionExecution).mockImplementationOnce(async () => {
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
    ).rejects.toThrow(/Chrome window closed/);

    expect(vi.mocked(resumeBrowserSession)).not.toHaveBeenCalled();
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).toContain(
      "Chrome disconnected without recoverable current-prompt commit authority; marking session error.",
    );
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(commitSessionModelProjectionMock).toHaveBeenCalledWith(
      baseSessionMeta.id,
      expect.objectContaining({
        session: expect.objectContaining({
          status: "error",
          response: { status: "error", incompleteReason: "chrome-disconnected" },
        }),
        model: expect.objectContaining({
          model: "gpt-5.2-pro",
          updates: expect.objectContaining({ status: "error" }),
        }),
      }),
    );
    expect(finalUpdate).toMatchObject({
      status: "error",
      response: { status: "error", incompleteReason: "chrome-disconnected" },
    });
  });

  test("connection-loss recovery is one-shot by default (no infinite retry loop)", async () => {
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
          chromeTargetId: "TARGET-1",
          ...committedDemoAuthority,
        },
      },
    );
    vi.mocked(runBrowserSessionExecution).mockImplementationOnce(async () => {
      throw automationError;
    });
    vi.mocked(resumeBrowserSession).mockRejectedValueOnce(new Error("target not ready yet"));

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
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).toContain("Auto-reattach will try up to 1 attempt(s).");
    expect(logLines).toContain("Auto-reattach stopped after 1 attempt(s)");
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "running",
      response: { status: "running", incompleteReason: "chrome-disconnected" },
    });
  });

  test("auto-reattaches after connection loss and marks session completed", async () => {
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
          chromeTargetId: "TARGET-1",
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
          chromeTargetId: "TARGET-1",
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
    const recoveredRuntime = {
      chromePort: 9222,
      chromeHost: "127.0.0.1",
      chromeTargetId: "TARGET-1",
      tabUrl: "https://chatgpt.com/c/demo",
      ...committedDemoAuthority,
      recoveryCleanupResources: [
        {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          chromeTargetId: "TARGET-1",
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "none" as const,
            keepBrowser: true,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" as const },
    } satisfies BrowserRuntimeMetadata;
    const recoveredArtifact = {
      kind: "file" as const,
      path: "/tmp/recovering-session/artifacts/remote-result.zip",
      url: "bridge-artifact",
      filename: "remote-result.zip",
    };
    const recoveredModel = {
      requestedModel: "Pro",
      resolvedLabel: "Pro",
      strategy: "select" as const,
      status: "already-selected" as const,
      verified: true,
      source: "chatgpt-model-picker" as const,
      capturedAt: "2026-08-05T00:00:00.000Z",
    };
    const reattach = createReattachResult(
      "recovered answer",
      "recovered **answer**",
      recoveredRuntime,
      {
        answerHtml: "<p>recovered answer</p>",
        savedFiles: [recoveredArtifact],
        archive: { mode: "auto", attempted: true, archived: true },
        modelSelection: recoveredModel,
        warnings: [{ code: "remote-warning", severity: "warning", message: "Recovered warning" }],
        tookMs: 42,
        answerTokens: 2,
        answerChars: 16,
      },
    );
    vi.mocked(resumeBrowserSession).mockResolvedValueOnce(reattach.value);
    vi.mocked(ensureSessionArtifacts).mockResolvedValueOnce([
      recoveredArtifact,
      { kind: "transcript", path: "/tmp/transcript.md" },
    ]);

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
    expect(vi.mocked(resumeBrowserSession).mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ sessionId: baseSessionMeta.id }),
    );
    expect(vi.mocked(ensureSessionArtifacts)).toHaveBeenCalledWith(
      expect.objectContaining({
        existingArtifacts: [recoveredArtifact],
      }),
    );
    const completedUpdate = sessionStoreMock.updateSession.mock.calls.find(
      ([, updates]) => updates.status === "completed",
    )?.[1];
    expect(completedUpdate).toMatchObject({
      status: "completed",
      elapsedMs: 42,
      response: { status: "completed" },
      artifacts: expect.arrayContaining([
        expect.objectContaining({ kind: "file", path: recoveredArtifact.path }),
        expect.objectContaining({ kind: "transcript", path: "/tmp/transcript.md" }),
      ]),
      browser: {
        archive: { mode: "auto", attempted: true, archived: true },
        modelSelection: recoveredModel,
        warnings: [{ code: "remote-warning", severity: "warning", message: "Recovered warning" }],
        runtime: {
          conversationId: "demo",
          promptEpoch: committedDemoAuthority.promptEpoch,
          recoveryCleanupResult: { status: "pending" },
        },
      },
    });
    expect(completedUpdate?.browser?.runtime).not.toHaveProperty("chromeHost");
    expect(completedUpdate?.browser?.runtime).not.toHaveProperty("chromePort");
    expect(completedUpdate?.browser?.runtime).not.toHaveProperty("chromeTargetId");
    expect(completedUpdate?.browser?.runtime).not.toHaveProperty("tabUrl");
    expect(completedUpdate?.browser?.runtime).not.toHaveProperty("recoveryCleanupResources");
    expect(await readBrowserCapturePublicationJournal(baseSessionMeta.id)).toBeNull();
    expect(reattach.finalize).toHaveBeenCalledOnce();
    expect(reattach.abort).not.toHaveBeenCalled();
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).toContain("Auto-reattach succeeded; session marked completed.");
  });

  test("persists copied-profile cleanup authority even though capture reattach is ineligible", async () => {
    const cleanupRuntime: BrowserRuntimeMetadata = {
      chromePid: 123,
      chromePort: 9222,
      chromeHost: "127.0.0.1",
      userDataDir: "/tmp/copied-profile",
      recoveryCleanupResources: [
        {
          chromePid: 123,
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          userDataDir: "/tmp/copied-profile",
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "copied",
            keepBrowser: false,
          },
        },
      ],
      recoveryCleanupResult: {
        status: "failed",
        error: "profile removal was not confirmed",
        settlementMode: "finalize",
      },
    };
    const originalFailure = new Error("assistant capture failed");
    const automationError = new BrowserAutomationError(
      "Browser cleanup remains pending: profile removal was not confirmed",
      {
        stage: "browser-capture-finalization",
        code: "unpublished-cleanup-pending",
        runtime: cleanupRuntime,
        cleanupError: "profile removal was not confirmed",
      },
      originalFailure,
    );
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null, copyProfileSource: "/tmp/source-profile" },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toBe(automationError);

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      browser: { runtime: cleanupRuntime },
      error: {
        category: "browser-automation",
        details: { code: "unpublished-cleanup-pending", runtime: cleanupRuntime },
      },
    });
    expect(resumeBrowserSession).not.toHaveBeenCalled();
    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain(
      "oracle session sess-1 --render",
    );
  });

  test("marks copied-profile connection loss as non-reattachable", async () => {
    const automationError = new BrowserAutomationError(
      "Chrome window closed before oracle finished.",
      {
        stage: "connection-lost",
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
        },
      },
    );
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null, copyProfileSource: "/tmp/source-profile" },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("Chrome window closed");

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({ status: "error" });
    expect(finalUpdate?.browser?.runtime).toBeUndefined();
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "error" }),
    );
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).not.toContain("keeping session running for reattach");
    expect(logLines).not.toContain("oracle session sess-1 --render");
  });

  test("marks early browser disconnect as error before a conversation exists", async () => {
    const automationError = new BrowserAutomationError(
      "Chrome window closed before oracle reached the composer.",
      {
        stage: "connection-lost",
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/",
        },
      },
    );
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);

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
    ).rejects.toThrow(/Chrome window closed/);

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      response: { status: "error", incompleteReason: "chrome-disconnected" },
      browser: expect.objectContaining({ runtime: expect.objectContaining({ chromePort: 9222 }) }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({
        status: "error",
        response: { status: "error", incompleteReason: "chrome-disconnected" },
      }),
    );
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).toContain(
      "Chrome disconnected without recoverable current-prompt commit authority; marking session error.",
    );
    expect(logLines).not.toContain("oracle session sess-1 --render");
  });

  test("marks browser capture incomplete when assistant response times out", async () => {
    const automationError = new BrowserAutomationError(
      "ChatGPT displayed a rate-limit warning while waiting for the assistant: Too many requests.",
      {
        stage: "assistant-timeout",
        code: "chatgpt-ui-warning",
        uiWarning: {
          type: "rate_limit",
          message: "Too many requests.",
        },
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
          ...committedDemoAuthority,
        },
        diagnostics: {
          domPath: "/tmp/.oracle/sessions/sess-1/artifacts/assistant-timeout.dom.json",
          screenshotPath: "/tmp/.oracle/sessions/sess-1/artifacts/assistant-timeout.png",
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

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      response: { status: "incomplete", incompleteReason: "incomplete-capture" },
      browser: expect.objectContaining({
        runtime: expect.objectContaining({ chromePort: 9222 }),
        modelSelection: expect.objectContaining({ resolvedLabel: "Pro", verified: true }),
      }),
      error: expect.objectContaining({
        details: expect.objectContaining({
          code: "chatgpt-ui-warning",
          uiWarning: {
            type: "rate_limit",
            message: "Too many requests.",
          },
          diagnostics: expect.objectContaining({
            domPath: "/tmp/.oracle/sessions/sess-1/artifacts/assistant-timeout.dom.json",
            screenshotPath: "/tmp/.oracle/sessions/sess-1/artifacts/assistant-timeout.png",
          }),
        }),
      }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({
        status: "error",
        response: { status: "incomplete", incompleteReason: "incomplete-capture" },
        error: expect.objectContaining({
          details: expect.objectContaining({
            diagnostics: expect.objectContaining({
              domPath: "/tmp/.oracle/sessions/sess-1/artifacts/assistant-timeout.dom.json",
              screenshotPath: "/tmp/.oracle/sessions/sess-1/artifacts/assistant-timeout.png",
            }),
          }),
        }),
      }),
    );
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).toContain(
      "ERROR: ChatGPT displayed a rate-limit warning while waiting for the assistant: Too many requests.",
    );
    expect(logLines).toContain(
      "Assistant response timed out; marking capture incomplete for reattach.",
    );
    expect(logLines).toContain("oracle session sess-1 --render");
  });
});
