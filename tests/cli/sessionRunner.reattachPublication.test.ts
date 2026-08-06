import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
const publishCompletedBrowserCaptureMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/cli/durableAnswer.ts", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../src/cli/durableAnswer.ts");
  return {
    ...actual,
    persistDurableBrowserAnswer: persistDurableBrowserAnswerMock,
    publishCompletedBrowserCapture: publishCompletedBrowserCaptureMock,
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

import type { BrowserRuntimeMetadata, SessionArtifact } from "../../src/sessionManager.ts";
import {
  baseRunOptions,
  baseSessionMeta,
  committedDemoAuthority,
} from "./sessionRunner.fixtures.ts";
import type { BrowserRunResult } from "../../src/browser/types.ts";
import * as sessionManager from "../../src/sessionManager.ts";
import { BrowserAutomationError } from "../../src/oracle.ts";
import { performSessionRun } from "../../src/cli/sessionRunner.ts";
import { runMultiModelApiSession } from "../../src/oracle/multiModelRunner.ts";
import {
  ensureSessionArtifacts,
  runBrowserSessionExecution,
} from "../../src/browser/sessionRunner.ts";
import { sendSessionNotification } from "../../src/cli/notifier.ts";
import { getCliVersion } from "../../src/version.ts";
import { resumeBrowserSession, settleBrowserRecoveryCleanup } from "../../src/browser/reattach.ts";
import {
  persistDurableBrowserAnswer,
  publishCompletedBrowserCapture,
} from "../../src/cli/durableAnswer.ts";
import type { DurableBrowserAnswerReceipt } from "../../src/cli/durableAnswer.ts";
import * as browserPublicationJournal from "../../src/cli/browserPublicationJournal.js";
import {
  readBrowserCapturePublicationJournal,
  reduceBrowserPublicationEvent,
} from "../../src/cli/browserPublicationJournal.js";
import type { BrowserCapturePublicationJournal } from "../../src/cli/browserPublicationJournal.js";

const log = vi.fn();

type DurableAnswerModule = {
  publishCompletedBrowserCapture: typeof publishCompletedBrowserCapture;
};
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

function receiptFor(answer: string, answerPath: string): DurableBrowserAnswerReceipt {
  const payload = Buffer.from(answer, "utf8");
  return {
    artifact: {
      kind: "transcript",
      path: answerPath,
      sha256: createHash("sha256").update(payload).digest("hex"),
      sizeBytes: payload.byteLength,
    },
  };
}

function finalizeBoundJournal(
  receipt: DurableBrowserAnswerReceipt,
): BrowserCapturePublicationJournal {
  const preparing = reduceBrowserPublicationEvent(null, {
    type: "prepare",
    journal: {
      sessionId: baseSessionMeta.id,
      receipt,
      artifacts: [receipt.artifact],
      completedAt: "2026-01-01T00:00:00.000Z",
      browserAudit: { runtime: {} },
      runtime: {},
    },
  });
  const staged = reduceBrowserPublicationEvent(preparing, {
    type: "answer-staged",
    receipt,
    artifacts: [receipt.artifact],
  });
  return reduceBrowserPublicationEvent(staged, {
    type: "finalize-bound",
    receipt,
    settlementMode: "finalize",
    runtime: {},
    browserAudit: { runtime: {} },
  });
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
  vi.mocked(publishCompletedBrowserCapture).mockReset();
  const actualDurableAnswer = await vi.importActual<DurableAnswerModule>(
    "../../src/cli/durableAnswer.ts",
  );
  vi.mocked(publishCompletedBrowserCapture).mockImplementation(
    actualDurableAnswer.publishCompletedBrowserCapture,
  );
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
  test("auto-reattaches after assistant timeout when configured", async () => {
    const automationError = new BrowserAutomationError("assistant timed out", {
      stage: "assistant-timeout",
      runtime: {
        chromePort: 9222,
        chromeHost: "127.0.0.1",
        tabUrl: "https://chatgpt.com/c/demo",
        ...committedDemoAuthority,
      },
    });
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
    const reattach = createReattachResult("ok text", "ok markdown", recoveredRuntime);
    vi.mocked(resumeBrowserSession).mockResolvedValue(reattach.value);
    vi.mocked(ensureSessionArtifacts).mockResolvedValue([
      { kind: "transcript", path: "/tmp/transcript.md" },
      { kind: "deep-research-report", path: "/tmp/deep-research-report.md" },
    ]);

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: "browser",
      browserConfig: {
        chromePath: null,
        autoReattachDelayMs: 0,
        autoReattachIntervalMs: 1000,
        autoReattachTimeoutMs: 1000,
      },
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    expect(vi.mocked(resumeBrowserSession)).toHaveBeenCalled();
    expect(vi.mocked(ensureSessionArtifacts)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: baseSessionMeta.id,
        prompt: baseRunOptions.prompt,
        answerMarkdown: "ok markdown",
        conversationUrl: "https://chatgpt.com/c/demo",
      }),
    );
    const completedCallIndex = sessionStoreMock.updateSession.mock.calls.findIndex(
      ([, updates]) =>
        updates.status === "completed" &&
        updates.artifacts?.some(
          (artifact: SessionArtifact) => artifact.kind === "deep-research-report",
        ),
    );
    const completedUpdate = sessionStoreMock.updateSession.mock.calls[completedCallIndex]?.[1];
    expect(completedUpdate).toMatchObject({
      status: "completed",
      artifacts: [
        { kind: "transcript", path: "/tmp/transcript.md" },
        { kind: "deep-research-report", path: "/tmp/deep-research-report.md" },
        expect.objectContaining({
          path: expect.stringMatching(/[\\/]artifacts[\\/]browser-answer-[a-f0-9]{64}\.md$/u),
        }),
      ],
      response: { status: "completed" },
      browser: expect.objectContaining({
        modelSelection: expect.objectContaining({ resolvedLabel: "Pro", verified: true }),
      }),
    });
    expect(vi.mocked(sendSessionNotification)).toHaveBeenCalled();
    expect(sessionStoreMock.updateSession.mock.calls).toContainEqual([
      baseSessionMeta.id,
      expect.objectContaining({
        status: "running",
        response: { status: "incomplete", incompleteReason: "incomplete-capture" },
      }),
    ]);
    expect(sessionStoreMock.updateSession.mock.invocationCallOrder.at(-1)).toBeLessThan(
      vi.mocked(sendSessionNotification).mock.invocationCallOrder.at(-1) ?? 0,
    );
    expect(reattach.finalize).toHaveBeenCalledOnce();
    expect(vi.mocked(persistDurableBrowserAnswer)).toHaveBeenCalledWith(
      {
        sessionId: baseSessionMeta.id,
        answer: "ok markdown",
        logHeader: "[auto-reattach] captured assistant response on attempt 1",
      },
      expect.objectContaining({
        artifact: expect.objectContaining({
          path: expect.stringMatching(/[\\/]artifacts[\\/]browser-answer-[a-f0-9]{64}\.md$/u),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          sizeBytes: Buffer.byteLength("ok markdown"),
        }),
      }),
    );
    expect(
      vi.mocked(resumeBrowserSession).mock.calls[0]?.[3]?.isRemotePublicationAcknowledged?.(),
    ).toBe(true);
    expect(vi.mocked(persistDurableBrowserAnswer).mock.invocationCallOrder[0]).toBeLessThan(
      sessionStoreMock.updateSession.mock.invocationCallOrder[completedCallIndex] ?? 0,
    );
    expect(reattach.finalize.mock.invocationCallOrder[0]).toBeGreaterThan(
      sessionStoreMock.updateSession.mock.invocationCallOrder[completedCallIndex] ?? 0,
    );
    expect(reattach.abort).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "does not classify a stale FINALIZE journal with a different verified receipt completed",
      matchingReceipt: false,
    },
    {
      name: "classifies a FINALIZE journal with its exact verified receipt completed",
      matchingReceipt: true,
    },
  ])("$name", async ({ matchingReceipt }) => {
    const initialRuntime = {
      chromePort: 9222,
      chromeHost: "127.0.0.1",
      tabUrl: "https://chatgpt.com/c/demo",
      ...committedDemoAuthority,
    } satisfies BrowserRuntimeMetadata;
    const recoveredRuntime = {
      ...initialRuntime,
      chromeTargetId: "TARGET-RECEIPT-AUTHORITY",
    } satisfies BrowserRuntimeMetadata;
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(
      new BrowserAutomationError("assistant timed out", {
        stage: "assistant-timeout",
        runtime: initialRuntime,
      }),
    );
    vi.mocked(resumeBrowserSession).mockResolvedValue(
      createReattachResult("captured answer", "captured answer", recoveredRuntime).value,
    );

    const artifactsDirectory = path.join(os.tmpdir(), "oracle-test-session", "artifacts");
    mkdirSync(artifactsDirectory, { recursive: true });
    const verifiedReceipt = receiptFor(
      "verified receipt",
      path.join(artifactsDirectory, "verified-receipt.md"),
    );
    writeFileSync(verifiedReceipt.artifact.path, "verified receipt");
    const staleReceipt = matchingReceipt
      ? verifiedReceipt
      : receiptFor("stale receipt", path.join(artifactsDirectory, "stale-receipt.md"));
    vi.spyOn(browserPublicationJournal, "readBrowserCapturePublicationJournal").mockResolvedValue(
      finalizeBoundJournal(staleReceipt),
    );
    const publicationError = new BrowserAutomationError("publication projection failed", {
      stage: "browser-capture-publication",
      runtime: recoveredRuntime,
      answerReceipt: verifiedReceipt,
    });
    vi.mocked(publishCompletedBrowserCapture).mockImplementationOnce(async (options) => {
      await options.publication?.bind(options.answer.sessionId);
      throw publicationError;
    });

    const run = performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: "browser",
      browserConfig: {
        chromePath: null,
        autoReattachDelayMs: 0,
        autoReattachIntervalMs: 1,
        autoReattachTimeoutMs: 1000,
      },
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    if (matchingReceipt) {
      await expect(run).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Auto-reattach answer is durable under FINALIZE authority"),
      );
      expect(
        sessionStoreMock.updateSession.mock.calls.some(([, patch]) => patch.status === "error"),
      ).toBe(false);
    } else {
      await expect(run).rejects.toThrow("publication projection failed");
      expect(log).not.toHaveBeenCalledWith(
        expect.stringContaining("Auto-reattach answer is durable under FINALIZE authority"),
      );
      expect(
        sessionStoreMock.updateSession.mock.calls.some(([, patch]) => patch.status === "error"),
      ).toBe(true);
    }
  });

  test("keeps auto-reattach completed when final runtime persistence fails once", async () => {
    const initialRuntime: BrowserRuntimeMetadata = {
      chromePort: 9222,
      chromeHost: "127.0.0.1",
      tabUrl: "https://chatgpt.com/c/demo",
      ...committedDemoAuthority,
    };
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(
      new BrowserAutomationError("assistant timed out", {
        stage: "assistant-timeout",
        runtime: initialRuntime,
      }),
    );
    const capturedRuntime: BrowserRuntimeMetadata = {
      ...initialRuntime,
      chromeTargetId: "AUTO-PUBLISHED-TARGET",
      recoveryCleanupResources: [
        {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          chromeTargetId: "AUTO-PUBLISHED-TARGET",
          conversationId: "demo",
          promptEpoch: committedDemoAuthority.promptEpoch,
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "none",
            keepBrowser: true,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" },
    };
    const retryableRuntime: BrowserRuntimeMetadata = {
      ...capturedRuntime,
      recoveryCleanupResult: {
        status: "failed",
        error: "reattach cleanup remains retryable",
        settlementMode: "finalize",
      },
    };
    const finalize = vi.fn(async () => ({
      status: "pending" as const,
      runtime: retryableRuntime,
      error: "reattach cleanup remains retryable",
    }));
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    vi.mocked(resumeBrowserSession).mockResolvedValue({
      answerText: "auto published text",
      answerMarkdown: "auto published markdown",
      runtime: capturedRuntime,
      bindSettlement: vi.fn(async () => capturedRuntime),
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
        throw new Error("auto final runtime metadata fsync failed once");
      }
      return { ...baseSessionMeta, id: sessionId, ...patch };
    });

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: { ...baseRunOptions, writeOutputPath: "/tmp/auto-published-output.md" },
      mode: "browser",
      browserConfig: {
        chromePath: null,
        autoReattachDelayMs: 0,
        autoReattachIntervalMs: 1,
        autoReattachTimeoutMs: 1000,
      },
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    expect(failedFinalRuntimeWrite).toBe(true);
    expect(vi.mocked(resumeBrowserSession)).toHaveBeenCalledTimes(1);
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
    const completedAuditRuntime =
      sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]?.browser?.runtime;
    expect(completedAuditRuntime).toMatchObject({
      conversationId: "demo",
      promptEpoch: committedDemoAuthority.promptEpoch,
      recoveryCleanupResult: {
        status: "failed",
        error: "browser-cleanup-finalize-pending: reattach cleanup remains retryable",
        settlementMode: "finalize",
      },
    });
    expect(completedAuditRuntime).not.toHaveProperty("chromeHost");
    expect(completedAuditRuntime).not.toHaveProperty("chromePort");
    expect(completedAuditRuntime).not.toHaveProperty("chromeTargetId");
    expect(completedAuditRuntime).not.toHaveProperty("tabUrl");
    expect(completedAuditRuntime).not.toHaveProperty("recoveryCleanupResources");
    expect(await readBrowserCapturePublicationJournal(baseSessionMeta.id)).toMatchObject({
      phase: "cleanup-pending",
      runtime: {
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeTargetId: "AUTO-PUBLISHED-TARGET",
        tabUrl: "https://chatgpt.com/c/demo",
        recoveryCleanupResources: expect.any(Array),
        recoveryCleanupResult: {
          status: "failed",
          error: "browser-cleanup-finalize-pending: reattach cleanup remains retryable",
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
      path.resolve("/tmp/auto-published-output.md"),
      "auto published markdown\n",
      "utf8",
    );
    expect(vi.mocked(sendSessionNotification)).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("recovered final cleanup authority persistence after retry"),
    );
  });

  test("retries auto-reattach with the newest error-carried remote runtime", async () => {
    const requestIdentity = {
      acceptedPromptSha256: ["a".repeat(64)],
      followUpOrdinal: 0,
      remainingFollowUps: 0 as const,
    };
    const initialRuntime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          remoteRecovery: {
            protocolVersion: 3,
            host: "bridge.example:9443",
            transactionToken: "3".repeat(64),
            state: "pre-receipt",
            requestIdentity,
          },
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: true },
        },
      ],
    };
    const retryRuntime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          remoteRecovery: {
            protocolVersion: 3,
            host: "bridge.example:9443",
            transactionToken: "4".repeat(64),
            state: "recoverable-error",
            requestIdentity,
          },
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: true },
        },
      ],
    };
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(
      new BrowserAutomationError("assistant timed out", {
        stage: "assistant-timeout",
        runtime: initialRuntime,
      }),
    );
    const retryError = new BrowserAutomationError("remote retry transport interrupted", {
      stage: "remote-retry",
      recoverableDisconnect: true,
      runtime: retryRuntime,
    });
    const reattach = createReattachResult("ok text", "ok markdown", retryRuntime);
    vi.mocked(resumeBrowserSession)
      .mockRejectedValueOnce(retryError)
      .mockResolvedValueOnce(reattach.value);

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: "browser",
      browserConfig: {
        chromePath: null,
        autoReattachDelayMs: 0,
        autoReattachIntervalMs: 1,
        autoReattachTimeoutMs: 1000,
      },
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    expect(vi.mocked(resumeBrowserSession)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(resumeBrowserSession).mock.calls[0]?.[0]).toBe(initialRuntime);
    expect(vi.mocked(resumeBrowserSession).mock.calls[1]?.[0]).toBe(retryRuntime);
    const retryRuntimePersistenceIndex = sessionStoreMock.updateSession.mock.calls.findIndex(
      ([, patch]) => patch.browser?.runtime === retryRuntime,
    );
    expect(retryRuntimePersistenceIndex).toBeGreaterThanOrEqual(0);
    expect(
      sessionStoreMock.updateSession.mock.invocationCallOrder[retryRuntimePersistenceIndex],
    ).toBeLessThan(vi.mocked(resumeBrowserSession).mock.invocationCallOrder[1] ?? 0);
  });

  test("stops auto-reattach on a terminal remote outcome without restoring stale authority", async () => {
    const initialRuntime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          remoteRecovery: {
            protocolVersion: 3,
            host: "bridge.example:9443",
            transactionToken: "5".repeat(64),
            state: "pre-receipt",
            requestIdentity: {
              acceptedPromptSha256: ["b".repeat(64)],
              followUpOrdinal: 0,
              remainingFollowUps: 0,
            },
          },
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: true },
        },
      ],
    };
    const terminalRuntime: BrowserRuntimeMetadata = {};
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(
      new BrowserAutomationError("assistant timed out", {
        stage: "assistant-timeout",
        runtime: initialRuntime,
      }),
    );
    vi.mocked(resumeBrowserSession).mockRejectedValueOnce(
      new BrowserAutomationError("Remote transaction was already finalized.", {
        stage: "remote-retry",
        code: "remote-transaction-finalized",
        recoverableDisconnect: false,
        runtime: terminalRuntime,
      }),
    );

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: "browser",
      browserConfig: {
        chromePath: null,
        autoReattachDelayMs: 0,
        autoReattachIntervalMs: 1,
        autoReattachTimeoutMs: 1000,
      },
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    expect(vi.mocked(resumeBrowserSession)).toHaveBeenCalledTimes(1);
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      errorMessage: "Remote transaction was already finalized.",
      response: { status: "error", incompleteReason: "incomplete-capture" },
      browser: { runtime: terminalRuntime },
      error: {
        category: "browser-automation",
        details: { recoverableDisconnect: false, runtime: terminalRuntime },
      },
    });
    expect(finalUpdate?.browser?.runtime).toEqual(terminalRuntime);
    expect(
      sessionStoreMock.updateSession.mock.calls.some(([, patch]) => patch.status === "completed"),
    ).toBe(false);
    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Auto-reattach stopped on terminal browser outcome",
    );
  });

  test("aborts auto-reattach when durable answer persistence fails", async () => {
    const automationError = new BrowserAutomationError("assistant timed out", {
      stage: "assistant-timeout",
      runtime: {
        chromePort: 9222,
        chromeHost: "127.0.0.1",
        tabUrl: "https://chatgpt.com/c/demo",
        ...committedDemoAuthority,
      },
    });
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);
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
    const reattach = createReattachResult("ok text", "ok markdown", recoveredRuntime);
    vi.mocked(resumeBrowserSession).mockResolvedValue(reattach.value);
    vi.mocked(persistDurableBrowserAnswer).mockRejectedValueOnce(new Error("answer fsync failed"));

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: {
          chromePath: null,
          autoReattachDelayMs: 0,
          autoReattachIntervalMs: 1,
          autoReattachTimeoutMs: 1000,
        },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("answer fsync failed");

    expect(vi.mocked(resumeBrowserSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendSessionNotification)).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "error",
      errorMessage: "answer fsync failed",
      browser: { runtime: expect.objectContaining({ chromeTargetId: "TARGET-1" }) },
      response: { status: "error", incompleteReason: "incomplete-capture" },
    });
    expect(
      sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]?.browser?.runtime,
    ).not.toHaveProperty("recoveryCleanupResources");
    expect(reattach.abort).toHaveBeenCalledOnce();
    expect(reattach.finalize).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      reattach.abort.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      vi.mocked(resumeBrowserSession).mock.calls[0]?.[3]?.isRemotePublicationAcknowledged?.(),
    ).toBe(false);
  });

  test("does not project an unverified receipt after ambiguous auto journal recovery", async () => {
    const initialRuntime = {
      chromePort: 9222,
      chromeHost: "127.0.0.1",
      tabUrl: "https://chatgpt.com/c/demo",
      ...committedDemoAuthority,
    } satisfies BrowserRuntimeMetadata;
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(
      new BrowserAutomationError("assistant timed out", {
        stage: "assistant-timeout",
        runtime: initialRuntime,
      }),
    );
    vi.mocked(resumeBrowserSession).mockResolvedValue(
      createReattachResult("captured answer", "captured answer", initialRuntime).value,
    );
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
        browserConfig: {
          chromePath: null,
          autoReattachDelayMs: 0,
          autoReattachIntervalMs: 1,
          autoReattachTimeoutMs: 1000,
        },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("publication recovery remains pending");

    const failureUpdate = sessionStoreMock.updateSession.mock.calls
      .map(([, updates]) => updates)
      .findLast((updates) => updates.status === "error");
    expect(failureUpdate).toMatchObject({
      status: "error",
      response: { status: "error", incompleteReason: "incomplete-capture" },
    });
    expect(failureUpdate?.artifacts).toBeUndefined();
    expect(vi.mocked(persistDurableBrowserAnswer)).not.toHaveBeenCalled();
  });

  test("auto-reattach stops after a hard cap when it cannot capture an answer", async () => {
    vi.useFakeTimers();
    try {
      const automationError = new BrowserAutomationError("assistant timed out", {
        stage: "assistant-timeout",
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
          ...committedDemoAuthority,
        },
      });
      vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);
      vi.mocked(resumeBrowserSession).mockRejectedValue(new Error("not ready"));

      const pending = performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: {
          chromePath: null,
          autoReattachDelayMs: 0,
          autoReattachIntervalMs: 60 * 60 * 1000,
          autoReattachTimeoutMs: 1000,
        },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      });

      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 5_000);
      await pending;

      expect(vi.mocked(resumeBrowserSession).mock.calls.length).toBeGreaterThanOrEqual(2);
      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({
        status: "error",
        response: { status: "incomplete", incompleteReason: "incomplete-capture" },
      });
      const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logLines).toContain("Auto-reattach stopped");
      expect(logLines).toContain(
        "This run did not return cleanly, but it may still be alive. Reattach:",
      );
      expect(logLines).toContain("oracle session sess-1 --render");
      expect(logLines).toContain("oracle session sess-1 --live");
      expect(logLines).toContain("oracle session sess-1 --harvest");
    } finally {
      vi.useRealTimers();
    }
  });
});
