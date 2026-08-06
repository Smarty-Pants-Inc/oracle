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
import { baseSessionMeta, committedDemoAuthority } from "./sessionRunner.fixtures.ts";
import { persistBrowserSessionOutcome } from "../../src/cli/browserSessionOutcome.ts";
import { runMultiModelApiSession } from "../../src/oracle/multiModelRunner.ts";
import {
  ensureSessionArtifacts,
  runBrowserSessionExecution,
} from "../../src/browser/sessionRunner.ts";
import { resumeBrowserSession, settleBrowserRecoveryCleanup } from "../../src/browser/reattach.ts";
import { persistDurableBrowserAnswer } from "../../src/cli/durableAnswer.ts";

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

describe("persistBrowserSessionOutcome", () => {
  test("retries an ambiguous commit when session and model branches disagree", async () => {
    const runtime: BrowserRuntimeMetadata = {
      chromePort: 9222,
      tabUrl: "https://chatgpt.com/c/demo",
      ...committedDemoAuthority,
    };
    commitSessionModelProjectionMock.mockRejectedValueOnce(new Error("ambiguous metadata rename"));
    sessionStoreMock.readSession.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ...baseSessionMeta,
      status: "running",
      mode: "browser",
      completedAt: undefined,
      errorMessage: "Chrome disconnected",
      browser: { config: {}, runtime },
      response: { status: "running", incompleteReason: "chrome-disconnected" },
      models: [{ model: "gpt-5.2-pro", status: "error" }],
    });

    await persistBrowserSessionOutcome(baseSessionMeta.id, {
      kind: "recovery-running",
      browser: { config: {} },
      runtime,
      response: { status: "running", incompleteReason: "chrome-disconnected" },
      reason: "Chrome disconnected",
      artifacts: undefined,
      receipt: undefined,
      errorMetadata: undefined,
      transportMetadata: undefined,
      modelProjection: { model: "gpt-5.2-pro", updates: {} },
    });

    expect(commitSessionModelProjectionMock).toHaveBeenCalledTimes(2);
    for (const [, projection] of commitSessionModelProjectionMock.mock.calls) {
      expect(projection.session).toMatchObject({
        status: "running",
        response: { status: "running", incompleteReason: "chrome-disconnected" },
      });
      expect(projection.model).toMatchObject({
        model: "gpt-5.2-pro",
        updates: { status: "running", completedAt: undefined },
      });
    }
  });

  test("accepts an ambiguous commit only when both branches match", async () => {
    const runtime: BrowserRuntimeMetadata = {
      chromePort: 9222,
      tabUrl: "https://chatgpt.com/c/demo",
      ...committedDemoAuthority,
    };
    commitSessionModelProjectionMock.mockRejectedValueOnce(
      new Error("metadata rename result unknown"),
    );
    sessionStoreMock.readSession.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ...baseSessionMeta,
      status: "running",
      mode: "browser",
      completedAt: undefined,
      errorMessage: "Chrome disconnected",
      browser: { config: {}, runtime },
      response: { status: "running", incompleteReason: "chrome-disconnected" },
      transport: undefined,
      error: undefined,
      models: [
        {
          model: "gpt-5.2-pro",
          status: "running",
          completedAt: undefined,
        },
      ],
      modelProjectionAuthority: "session",
    });

    await persistBrowserSessionOutcome(baseSessionMeta.id, {
      kind: "recovery-running",
      browser: { config: {} },
      runtime,
      response: { status: "running", incompleteReason: "chrome-disconnected" },
      reason: "Chrome disconnected",
      artifacts: undefined,
      receipt: undefined,
      errorMetadata: undefined,
      transportMetadata: undefined,
      modelProjection: { model: "gpt-5.2-pro", updates: {} },
    });

    expect(commitSessionModelProjectionMock).toHaveBeenCalledTimes(1);
  });
});
