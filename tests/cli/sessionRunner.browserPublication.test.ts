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
import * as sessionManager from "../../src/sessionManager.ts";
import { performSessionRun } from "../../src/cli/sessionRunner.ts";
import { runMultiModelApiSession } from "../../src/oracle/multiModelRunner.ts";
import {
  ensureSessionArtifacts,
  runBrowserSessionExecution,
} from "../../src/browser/sessionRunner.ts";
import { sendSessionNotification } from "../../src/cli/notifier.ts";
import { getCliVersion } from "../../src/version.ts";
import { resumeBrowserSession, settleBrowserRecoveryCleanup } from "../../src/browser/reattach.ts";
import { persistDurableBrowserAnswer } from "../../src/cli/durableAnswer.ts";
import * as browserPublicationJournal from "../../src/cli/browserPublicationJournal.js";
import { readBrowserCapturePublicationJournal } from "../../src/cli/browserPublicationJournal.js";

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
  test("invokes browser runner when mode is browser", async () => {
    const pendingRuntime: BrowserRuntimeMetadata = {
      chromePid: 123,
      chromePort: 9222,
      userDataDir: "/tmp/profile",
      chromeTargetId: "owned-target",
      recoveryCleanupResources: [
        {
          chromePid: 123,
          chromePort: 9222,
          userDataDir: "/tmp/profile",
          chromeTargetId: "owned-target",
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "temporary",
            keepBrowser: false,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" },
    };
    const finalizedRuntime: BrowserRuntimeMetadata = {
      chromePid: 123,
      chromePort: 9222,
      userDataDir: "/tmp/profile",
      chromeTargetId: "owned-target",
    };
    const finalize = vi.fn(async () => ({
      status: "completed" as const,
      runtime: finalizedRuntime,
    }));
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime: finalizedRuntime }));
    vi.mocked(runBrowserSessionExecution).mockResolvedValue({
      usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 0, totalTokens: 150 },
      elapsedMs: 2000,
      runtime: pendingRuntime,
      modelSelection: {
        requestedModel: "GPT-5.5 Pro",
        resolvedLabel: "Pro",
        strategy: "select",
        status: "already-selected",
        verified: true,
        source: "chatgpt-model-picker",
        capturedAt: "2026-05-13T00:00:00.000Z",
      },
      warnings: [
        {
          code: "browser-pro-fast-large-run",
          severity: "warning",
          message: "Large browser Pro run completed quickly.",
        },
      ],
      answerText: "Answer",
      promptText: "Normalized submitted prompt",
      artifacts: [{ kind: "transcript", path: "/tmp/transcript.md" }],
      bindSettlement: vi.fn(async () => ({
        ...pendingRuntime,
        recoveryCleanupResult: { status: "pending" as const, settlementMode: "finalize" as const },
      })),
      finalize,
      abort,
    });

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: { ...baseRunOptions, writeOutputPath: "/tmp/browser-output.md" },
      mode: "browser",
      browserConfig: { chromePath: null },
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    expect(vi.mocked(runBrowserSessionExecution)).toHaveBeenCalled();
    expect(commitSessionModelProjectionMock).toHaveBeenCalledWith(
      baseSessionMeta.id,
      expect.objectContaining({
        session: expect.objectContaining({ status: "completed" }),
        model: expect.objectContaining({
          model: "gpt-5.2-pro",
          updates: expect.objectContaining({ status: "completed" }),
        }),
      }),
    );
    expect(vi.mocked(sendSessionNotification)).toHaveBeenCalled();
    const completedCallIndex = sessionStoreMock.updateSession.mock.calls.findIndex(
      (call) => call[1]?.status === "completed",
    );
    const completedUpdate = sessionStoreMock.updateSession.mock.calls[completedCallIndex]?.[1];
    const cleanupUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(completedUpdate).toMatchObject({
      status: "completed",
      browser: expect.objectContaining({
        runtime: expect.objectContaining({
          recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
        }),
        modelSelection: expect.objectContaining({ resolvedLabel: "Pro" }),
        warnings: [expect.objectContaining({ code: "browser-pro-fast-large-run" })],
      }),
      artifacts: [
        { kind: "transcript", path: "/tmp/transcript.md" },
        expect.objectContaining({
          kind: "transcript",
          path: expect.stringMatching(/[\\/]artifacts[\\/]browser-answer-[a-f0-9]{64}\.md$/u),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ],
    });
    expect(completedUpdate).toHaveProperty("errorMessage", undefined);
    expect(completedUpdate?.browser?.runtime).not.toHaveProperty("chromePid");
    expect(completedUpdate?.browser?.runtime).not.toHaveProperty("chromeTargetId");
    expect(completedUpdate?.browser?.runtime).not.toHaveProperty("userDataDir");
    expect(completedUpdate?.browser?.runtime).not.toHaveProperty("recoveryCleanupResources");
    expect(cleanupUpdate?.browser?.runtime).not.toHaveProperty("chromePid");
    expect(cleanupUpdate?.browser?.runtime).not.toHaveProperty("chromeTargetId");
    expect(cleanupUpdate?.browser?.runtime).not.toHaveProperty("userDataDir");
    expect(cleanupUpdate?.browser?.runtime).not.toHaveProperty("recoveryCleanupResources");
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
    expect(vi.mocked(persistDurableBrowserAnswer)).toHaveBeenCalledWith(
      {
        sessionId: baseSessionMeta.id,
        answer: "Answer",
      },
      expect.objectContaining({
        artifact: expect.objectContaining({
          path: expect.stringMatching(/[\\/]artifacts[\\/]browser-answer-[a-f0-9]{64}\.md$/u),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          sizeBytes: Buffer.byteLength("Answer"),
        }),
      }),
    );
    expect(vi.mocked(ensureSessionArtifacts)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: baseSessionMeta.id,
        prompt: "Normalized submitted prompt",
        logger: expect.any(Function),
      }),
    );
    expect(vi.mocked(persistDurableBrowserAnswer).mock.invocationCallOrder[0]).toBeLessThan(
      sessionStoreMock.updateSession.mock.invocationCallOrder[completedCallIndex] ?? 0,
    );
    expect(finalize.mock.invocationCallOrder[0]).toBeGreaterThan(
      sessionStoreMock.updateSession.mock.invocationCallOrder[completedCallIndex] ?? 0,
    );
    expect(sessionStoreMock.updateSession.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      finalize.mock.invocationCallOrder[0] ?? 0,
    );
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "running" }),
    );
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "completed" }),
    );
    expect(sessionStoreMock.updateSession.mock.invocationCallOrder.at(-1)).toBeLessThan(
      vi.mocked(sendSessionNotification).mock.invocationCallOrder.at(-1) ?? 0,
    );
    expect(vi.mocked(sendSessionNotification).mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      (
        fsPromises.writeFile as unknown as { mock: { invocationCallOrder: number[] } }
      ).mock.invocationCallOrder.at(-1) ?? 0,
    );
  });

  test("persists retryable cleanup authority when browser finalization throws", async () => {
    const runtime: BrowserRuntimeMetadata = {
      chromeTargetId: "remote-finalize-target",
      recoveryCleanupResources: [
        {
          chromeTargetId: "remote-finalize-target",
          remoteRecovery: {
            protocolVersion: 3,
            host: "bridge.example:9443",
            transactionToken: "a".repeat(64),
            state: "pending",
          },
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: false,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" },
    };
    const finalize = vi.fn(async () => {
      throw new Error("bridge temporarily unavailable");
    });
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    vi.mocked(runBrowserSessionExecution).mockResolvedValue({
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 },
      elapsedMs: 100,
      runtime,
      answerText: "durable remote answer",
      bindSettlement: vi.fn(async () => ({
        ...runtime,
        recoveryCleanupResult: { status: "pending" as const, settlementMode: "finalize" as const },
      })),
      finalize,
      abort,
    });

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: "browser",
      browserConfig: {},
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    expect(finalize).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    const completedRuntime =
      sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]?.browser?.runtime;
    expect(completedRuntime?.recoveryCleanupResult).toMatchObject({
      status: "failed",
      error: expect.stringContaining("bridge temporarily unavailable"),
      settlementMode: "finalize",
    });
    expect(completedRuntime).not.toHaveProperty("chromeTargetId");
    expect(completedRuntime).not.toHaveProperty("recoveryCleanupResources");
    expect(await readBrowserCapturePublicationJournal(baseSessionMeta.id)).toMatchObject({
      phase: "cleanup-pending",
      runtime: {
        chromeTargetId: "remote-finalize-target",
        recoveryCleanupResources: [
          expect.objectContaining({
            remoteRecovery: expect.objectContaining({
              transactionToken: "a".repeat(64),
              state: "pending",
            }),
          }),
        ],
      },
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("cleanup remains pending"));
  });

  test("keeps a published browser run completed when final runtime persistence fails once", async () => {
    const capturedRuntime: BrowserRuntimeMetadata = {
      chromePort: 9222,
      chromeTargetId: "published-runtime-target",
      tabUrl: "https://chatgpt.com/c/published-runtime",
      recoveryCleanupResources: [
        {
          chromePort: 9222,
          chromeTargetId: "published-runtime-target",
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: false,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" },
    };
    const retryableRuntime: BrowserRuntimeMetadata = {
      ...capturedRuntime,
      recoveryCleanupResult: {
        status: "failed",
        error: "target close remains retryable",
        settlementMode: "finalize",
      },
    };
    const finalize = vi.fn(async () => ({
      status: "pending" as const,
      runtime: retryableRuntime,
      error: "target close remains retryable",
    }));
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    vi.mocked(runBrowserSessionExecution).mockResolvedValue({
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 },
      elapsedMs: 500,
      runtime: capturedRuntime,
      answerText: "published answer",
      bindSettlement: vi.fn(async () => ({
        ...capturedRuntime,
        recoveryCleanupResult: { status: "pending" as const, settlementMode: "finalize" as const },
      })),
      finalize,
      abort,
    });
    let failedFinalRuntimeWrite = false;
    sessionStoreMock.updateSession.mockImplementation(async (sessionId, patch) => {
      if (
        !failedFinalRuntimeWrite &&
        patch.status === "completed" &&
        patch.browser?.runtime?.recoveryCleanupResult?.status === "failed"
      ) {
        failedFinalRuntimeWrite = true;
        throw new Error("final runtime metadata fsync failed once");
      }
      return { ...baseSessionMeta, id: sessionId, ...patch };
    });

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: { ...baseRunOptions, writeOutputPath: "/tmp/published-browser-output.md" },
      mode: "browser",
      browserConfig: { chromePath: null },
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    expect(failedFinalRuntimeWrite).toBe(true);
    expect(finalize).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession.mock.calls).toContainEqual([
      baseSessionMeta.id,
      expect.objectContaining({
        status: "completed",
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            path: expect.stringMatching(/[\\/]artifacts[\\/]browser-answer-[a-f0-9]{64}\.md$/u),
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          }),
        ]),
      }),
    ]);
    expect(
      sessionStoreMock.updateSession.mock.calls.some(([, patch]) => patch.status === "error"),
    ).toBe(false);
    const finalAuditRuntime =
      sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]?.browser?.runtime;
    expect(finalAuditRuntime?.recoveryCleanupResult).toMatchObject({
      status: "failed",
      error: "browser-cleanup-finalize-pending: target close remains retryable",
      settlementMode: "finalize",
    });
    expect(finalAuditRuntime).not.toHaveProperty("chromeTargetId");
    expect(finalAuditRuntime).not.toHaveProperty("tabUrl");
    expect(finalAuditRuntime).not.toHaveProperty("recoveryCleanupResources");
    expect(await readBrowserCapturePublicationJournal(baseSessionMeta.id)).toMatchObject({
      phase: "cleanup-pending",
      runtime: {
        chromeTargetId: "published-runtime-target",
        recoveryCleanupResources: expect.any(Array),
        recoveryCleanupResult: {
          status: "failed",
          error: "browser-cleanup-finalize-pending: target close remains retryable",
          settlementMode: "finalize",
        },
      },
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "completed" }),
    );
    expect(
      sessionStoreMock.updateModelRun.mock.calls.some(([, , patch]) => patch.status === "error"),
    ).toBe(false);
    expect(fsPromises.writeFile).toHaveBeenCalledWith(
      path.resolve("/tmp/published-browser-output.md"),
      "published answer\n",
      "utf8",
    );
    expect(vi.mocked(sendSessionNotification)).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("recovered final cleanup authority persistence after retry"),
    );
  });

  test("keeps FINALIZE authority after a transient terminal metadata failure", async () => {
    const pendingRuntime: BrowserRuntimeMetadata = {
      chromePort: 9222,
      chromeTargetId: "fallback-target",
      tabUrl: "https://chatgpt.com/c/fallback-answer",
      recoveryCleanupResources: [
        {
          chromePort: 9222,
          chromeTargetId: "fallback-target",
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: false,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" },
    };
    const finalize = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    vi.mocked(runBrowserSessionExecution).mockResolvedValue({
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 },
      elapsedMs: 500,
      runtime: pendingRuntime,
      answerText: "captured but not yet durable",
      artifacts: [{ kind: "transcript", path: "/tmp/pending-transcript.md" }],
      bindSettlement: vi.fn(async () => ({
        ...pendingRuntime,
        recoveryCleanupResult: { status: "pending" as const, settlementMode: "finalize" as const },
      })),
      finalize,
      abort,
    });
    let failedCompletedWrite = false;
    sessionStoreMock.updateSession.mockImplementation(async (sessionId, patch) => {
      if (!failedCompletedWrite && patch.status === "completed") {
        failedCompletedWrite = true;
        throw new Error("terminal metadata disk full");
      }
      return { ...baseSessionMeta, id: sessionId, ...patch };
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

    expect(failedCompletedWrite).toBe(true);
    expect(finalize).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(
      sessionStoreMock.updateSession.mock.calls.some(([, patch]) => patch.status === "error"),
    ).toBe(false);
    expect(sessionStoreMock.updateSession.mock.calls).toContainEqual([
      baseSessionMeta.id,
      expect.objectContaining({
        status: "completed",
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            path: expect.stringMatching(/[\\/]artifacts[\\/]browser-answer-[a-f0-9]{64}\.md$/u),
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          }),
        ]),
      }),
    ]);
  });

  test("keeps a verified browser answer out of terminal error when projection repair fails", async () => {
    const runtime: BrowserRuntimeMetadata = {
      chromePort: 9222,
      chromeTargetId: "model-run-target",
      tabUrl: "https://chatgpt.com/c/model-run-answer",
    };
    const finalize = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    vi.mocked(runBrowserSessionExecution).mockResolvedValue({
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 },
      elapsedMs: 500,
      runtime,
      answerText: "captured answer",
      bindSettlement: vi.fn(async () => runtime),
      finalize,
      abort,
    });
    sessionStoreMock.updateModelRun.mockImplementation(async (_sessionId, _model, patch) => {
      if (patch.status === "completed") {
        throw new Error("model run metadata disk full");
      }
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

    expect(commitSessionModelProjectionMock).toHaveBeenCalledTimes(2);
    expect(
      sessionStoreMock.updateModelRun.mock.calls.filter(
        ([, , patch]) => patch.status === "completed",
      ),
    ).toHaveLength(2);
    expect(
      sessionStoreMock.updateSession.mock.calls.some(([, patch]) => patch.status === "error"),
    ).toBe(false);
    expect(finalize).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    await expect(readBrowserCapturePublicationJournal(baseSessionMeta.id)).resolves.toMatchObject({
      phase: "finalize-bound",
      model: "gpt-5.2-pro",
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("terminal session/model projection remains pending"),
    );
  });

  test("aborts and preserves browser authority when durable answer persistence fails", async () => {
    const pendingRuntime: BrowserRuntimeMetadata = {
      chromePort: 9222,
      chromeTargetId: "durability-target",
      tabUrl: "https://chatgpt.com/c/durability-answer",
      recoveryCleanupResources: [
        {
          chromePort: 9222,
          chromeTargetId: "durability-target",
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: false,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" },
    };
    const retainedRuntime: BrowserRuntimeMetadata = {
      ...pendingRuntime,
      recoveryCleanupResult: { status: "failed", error: "target retained for retry" },
    };
    const finalize = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    const abort = vi.fn(async () => ({
      status: "pending" as const,
      runtime: retainedRuntime,
      error: "target retained for retry",
    }));
    vi.mocked(runBrowserSessionExecution).mockResolvedValue({
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 },
      elapsedMs: 500,
      runtime: pendingRuntime,
      answerText: "captured answer",
      bindSettlement: vi.fn(async () => pendingRuntime),
      finalize,
      abort,
    });
    vi.mocked(persistDurableBrowserAnswer).mockRejectedValueOnce(new Error("answer fsync failed"));

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
    ).rejects.toThrow("answer fsync failed");

    expect(finalize).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
    expect(sessionStoreMock.updateSession.mock.calls).not.toContainEqual([
      baseSessionMeta.id,
      expect.objectContaining({ status: "completed" }),
    ]);
    let errorUpdate: unknown;
    for (const call of sessionStoreMock.updateSession.mock.calls) {
      if (call[1]?.status === "error") errorUpdate = call[1];
    }
    expect(errorUpdate).toMatchObject({
      browser: {
        runtime: {
          chromeTargetId: "durability-target",
          recoveryCleanupResources: [
            expect.objectContaining({
              recoveryCleanup: expect.objectContaining({ ownsTarget: true }),
            }),
          ],
          recoveryCleanupResult: {
            status: "failed",
            error: "target retained for retry",
            settlementMode: "abort",
          },
        },
      },
    });
  });

  test("does not project an unreconciled browser publication intent as an artifact", async () => {
    const runtime: BrowserRuntimeMetadata = {
      chromePort: 9222,
      chromeTargetId: "unreconciled-publication-target",
      tabUrl: "https://chatgpt.com/c/unreconciled-publication",
    };
    vi.mocked(runBrowserSessionExecution).mockResolvedValue({
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 },
      elapsedMs: 500,
      runtime,
      answerText: "answer that was never persisted",
      bindSettlement: vi.fn(),
      finalize: vi.fn(),
      abort: vi.fn(),
    });
    vi.spyOn(browserPublicationJournal, "readBrowserCapturePublicationJournal")
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("journal reconciliation read failed"));
    vi.spyOn(sessionManager, "writeFileAtomicDurable").mockRejectedValueOnce(
      new Error("journal write failed before answer persistence"),
    );

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
    ).rejects.toThrow("publication recovery remains pending");

    expect(persistDurableBrowserAnswer).not.toHaveBeenCalled();
    const errorUpdate = sessionStoreMock.updateSession.mock.calls.find(
      (call) => call[1]?.status === "error",
    )?.[1];
    expect(errorUpdate).toBeDefined();
    expect(errorUpdate).not.toHaveProperty("artifacts");
  });
});
