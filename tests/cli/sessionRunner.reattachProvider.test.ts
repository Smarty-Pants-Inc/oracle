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
import { baseRunOptions, baseSessionMeta } from "./sessionRunner.fixtures.ts";
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
  test("keeps committed Gemini capture failures running for exact reattach", async () => {
    const runtime = {
      chromePort: 9222,
      chromeHost: "127.0.0.1",
      chromeTargetId: "gemini-target-1",
      conversationId: "gemini-target-1",
      promptEpoch: {
        status: "committed" as const,
        epochId: "gemini-epoch-1",
        promptSha256: "d".repeat(64),
        baselineTurns: 0,
        followUpOrdinal: 0,
        remainingFollowUps: 0,
        verifiedUserTurnIndex: 0,
        verifiedUserTurnId: "data-message-id:gemini-user-current",
        verifiedUserMessageId: "data-message-id:gemini-user-current",
        conversationId: "gemini-target-1",
      },
      recoveryCleanupResources: [
        {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          chromeTargetId: "gemini-target-1",
          conversationId: "gemini-target-1",
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "manual-login" as const,
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" as const },
    } satisfies BrowserRuntimeMetadata;
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(
      new BrowserAutomationError("Gemini response capture failed after commit", {
        stage: "gemini-response-capture",
        code: "gemini-response-capture-recoverable",
        reattachable: true,
        runtime,
      }),
    );
    vi.mocked(resumeBrowserSession).mockRejectedValueOnce(
      new BrowserAutomationError("Gemini answer is still generating", {
        stage: "gemini-response-capture",
        code: "gemini-reattach-capture-pending",
        reattachable: true,
        runtime,
      }),
    );

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: "browser",
      browserConfig: {
        chromePath: null,
        desiredModel: "gemini-3-pro-deep-think",
        timeoutMs: 2_000,
      },
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    expect(vi.mocked(resumeBrowserSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resumeBrowserSession)).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({ desiredModel: "gemini-3-pro-deep-think" }),
      expect.any(Function),
      expect.any(Object),
    );
    expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "running",
      completedAt: undefined,
      browser: { runtime },
      response: { status: "running", incompleteReason: "incomplete-capture" },
    });
    const logLines = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logLines).toContain(
      "Gemini response capture remains incomplete; keeping session running for exact reattach.",
    );
  });

  test("preserves provider-id-less Gemini cleanup authority without advertising reattach", async () => {
    const runtime = {
      chromePort: 9222,
      chromeHost: "127.0.0.1",
      chromeTargetId: "gemini-target-synthetic",
      conversationId: "gemini-target-synthetic",
      promptEpoch: {
        status: "committed" as const,
        epochId: "gemini-epoch-synthetic",
        promptSha256: "e".repeat(64),
        baselineTurns: 0,
        followUpOrdinal: 0,
        remainingFollowUps: 0,
        verifiedUserTurnIndex: 0,
        verifiedUserTurnId: "gemini-dom-turn:0:synthetic",
        verifiedUserMessageId: "gemini-dom-turn:0:synthetic",
        conversationId: "gemini-target-synthetic",
      },
      recoveryCleanupResources: [
        {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          chromeTargetId: "gemini-target-synthetic",
          conversationId: "gemini-target-synthetic",
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "manual-login" as const,
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" as const },
    } satisfies BrowserRuntimeMetadata;
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(
      new BrowserAutomationError("Gemini response identity is unavailable after commit", {
        stage: "gemini-response-capture",
        code: "gemini-reattach-authority-unavailable",
        reattachable: false,
        runtime,
      }),
    );

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: {
          chromePath: null,
          desiredModel: "gemini-3-pro-deep-think",
        },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("Gemini response identity is unavailable after commit");

    expect(vi.mocked(resumeBrowserSession)).not.toHaveBeenCalled();
    expect(vi.mocked(settleBrowserRecoveryCleanup)).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "error",
      browser: { runtime },
      response: { status: "error", incompleteReason: "incomplete-capture" },
      error: {
        category: "browser-automation",
        details: {
          stage: "gemini-response-capture",
          code: "gemini-reattach-authority-unavailable",
          reattachable: false,
        },
      },
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({
        status: "error",
        response: { status: "error", incompleteReason: "incomplete-capture" },
      }),
    );
    const logLines = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logLines).toContain(
      'run "oracle session sess-1" to retry owned browser cleanup without resubmitting',
    );
    expect(logLines).not.toContain("keeping session running");
    expect(logLines).not.toContain("--render");
    expect(logLines).not.toContain("--live");
    expect(logLines).not.toContain("--harvest");
  });

  test("records runtime and guidance when cloudflare challenge is detected", async () => {
    const automationError = new BrowserAutomationError(
      "Cloudflare challenge detected. Complete the “Just a moment…” check in the open browser, then rerun.",
      {
        stage: "cloudflare-challenge",
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          userDataDir: "/tmp/oracle-browser-profile",
        },
        reuseProfileHint:
          'oracle --engine browser --browser-manual-login --browser-manual-login-profile-dir "/tmp/oracle-browser-profile"',
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
    ).rejects.toThrow("Cloudflare challenge detected");

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      browser: expect.objectContaining({
        config: expect.any(Object),
        runtime: expect.objectContaining({
          chromePort: 9222,
          userDataDir: "/tmp/oracle-browser-profile",
        }),
      }),
      error: expect.objectContaining({
        category: "browser-automation",
        details: expect.objectContaining({ stage: "cloudflare-challenge" }),
      }),
    });
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).toContain(
      "Cloudflare challenge detected; browser left running so you can complete the check.",
    );
    expect(logLines).toContain(
      "Reuse this browser profile with: oracle --engine browser --browser-manual-login",
    );
    expect(logLines).not.toContain("oracle session sess-1 --render");
  });

  test("does not advertise reattach for a removed copied profile after Cloudflare", async () => {
    const automationError = new BrowserAutomationError(
      "Cloudflare challenge detected. Copy-profile runs cannot be retained.",
      {
        stage: "cloudflare-challenge",
        reattachable: false,
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
    ).rejects.toThrow("Copy-profile runs cannot be retained");

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate?.browser?.runtime).toBeUndefined();
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).toContain("Cloudflare challenge detected; copied profile closed and removed.");
    expect(logLines).not.toContain("browser left running");
    expect(logLines).not.toContain("oracle session sess-1 --render");
  });

  test("does not auto-reattach after a copied-profile assistant timeout", async () => {
    const automationError = new BrowserAutomationError("assistant timed out", {
      stage: "assistant-timeout",
      reattachable: false,
    });
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: {
          chromePath: null,
          copyProfileSource: "/tmp/source-profile",
          autoReattachIntervalMs: 100,
        },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("assistant timed out");

    expect(resumeBrowserSession).not.toHaveBeenCalled();
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate?.browser?.runtime).toBeUndefined();
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).not.toContain("capture incomplete for reattach");
    expect(logLines).not.toContain("oracle session sess-1 --render");
  });
});
