import fs from "node:fs";
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
}));

import type {
  BrowserRuntimeMetadata,
  SessionArtifact,
  SessionMetadata,
  SessionModelRun,
} from "../../src/sessionManager.ts";
import * as sessionManager from "../../src/sessionManager.ts";
import type { ModelName } from "../../src/oracle.ts";
import { performSessionRun } from "../../src/cli/sessionRunner.ts";
import {
  BrowserAutomationError,
  FileValidationError,
  OracleResponseError,
  OracleTransportError,
  runOracle,
} from "../../src/oracle.ts";
import {
  runMultiModelApiSession,
  type ModelExecutionResult,
  type MultiModelRunSummary,
} from "../../src/oracle/multiModelRunner.ts";
import type { OracleResponse, RunOracleResult } from "../../src/oracle.ts";
import {
  ensureSessionArtifacts,
  runBrowserSessionExecution,
} from "../../src/browser/sessionRunner.ts";
import { sendSessionNotification } from "../../src/cli/notifier.ts";
import { getCliVersion } from "../../src/version.ts";
import { deriveModelOutputPath } from "../../src/cli/sessionRunner.ts";
import { resumeBrowserSession, settleBrowserRecoveryCleanup } from "../../src/browser/reattach.ts";
import { persistDurableBrowserAnswer } from "../../src/cli/durableAnswer.ts";
import * as browserPublicationJournal from "../../src/cli/browserPublicationJournal.js";
import { readBrowserCapturePublicationJournal } from "../../src/cli/browserPublicationJournal.js";

const baseSessionMeta: SessionMetadata = {
  id: "sess-1",
  createdAt: "2025-01-01T00:00:00Z",
  status: "pending",
  options: {},
};

const baseRunOptions = {
  prompt: "Hello",
  model: "gpt-5.2-pro" as const,
};

const committedDemoAuthority = {
  conversationId: "demo",
  promptEpoch: {
    status: "committed" as const,
    epochId: "epoch-demo",
    promptSha256: "c".repeat(64),
    baselineTurns: 0,
    followUpOrdinal: 0,
    remainingFollowUps: 0,
    verifiedUserTurnIndex: 1,
    verifiedUserTurnId: "turn-1",
    verifiedUserMessageId: "message-1",
    conversationId: "demo",
  },
} satisfies BrowserRuntimeMetadata;

const log = vi.fn();
const write = vi.fn(() => true);
const cliVersion = getCliVersion();

function createReattachResult(
  answerText: string,
  answerMarkdown: string,
  runtime: BrowserRuntimeMetadata,
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

function createCleanupRuntime(
  targetId: string,
  status: "pending" | "failed" = "pending",
): BrowserRuntimeMetadata {
  return {
    chromePort: 9222,
    chromeHost: "127.0.0.1",
    chromeTargetId: targetId,
    tabUrl: "https://chatgpt.com/c/demo",
    ...committedDemoAuthority,
    recoveryCleanupResources: [
      {
        chromePort: 9222,
        chromeHost: "127.0.0.1",
        chromeTargetId: targetId,
        conversationId: "demo",
        promptEpoch: committedDemoAuthority.promptEpoch,
        recoveryCleanup: {
          ownsTarget: true,
          profileKind: "temporary",
          keepBrowser: false,
        },
      },
    ],
    recoveryCleanupResult:
      status === "failed"
        ? { status, error: `cleanup failed for ${targetId}`, settlementMode: "abort" }
        : { status },
  };
}

function createPendingChromeAcquisitionRuntime(): BrowserRuntimeMetadata {
  const userDataDir = path.resolve("/tmp/oracle-pending-acquisition");
  const generationId = "70000000-0000-4000-8000-000000000007";
  return {
    browserTransport: "cdp",
    chromePid: 7_777,
    chromeHost: "127.0.0.1",
    chromeProfileRoot: userDataDir,
    userDataDir,
    controllerPid: 2_147_483_647,
    recoveryCleanupResources: [
      {
        chromePid: 7_777,
        chromeHost: "127.0.0.1",
        chromeProfileRoot: userDataDir,
        userDataDir,
        profileDirectoryIdentity: {
          version: 1,
          platform: process.platform,
          canonicalPath: userDataDir,
          device: "1",
          inode: "2",
        },
        acquisition: {
          generationId,
          pendingResource: "chrome-process",
          processOwnerProvenance: "temporary-launch",
          processLaunchClaim: {
            version: 1,
            generationId,
            nonce: "80000000-0000-4000-8000-000000000008",
          },
          processOwnerDisposition: "close-on-last-lease",
        },
        recoveryCleanup: {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
          closeOwnedTargetOnComplete: false,
        },
      },
    ],
    recoveryCleanupResult: { status: "pending" },
  };
}

async function withExactEnv<T>(
  updates: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const originals = new Map<string, string | undefined>();
  for (const name of Object.keys(updates)) {
    originals.set(name, process.env[name]);
    const value = updates[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of originals) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
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
  test("completes API sessions and records usage", async () => {
    const liveResult: RunOracleResult = {
      mode: "live",
      usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 0, totalTokens: 30 },
      elapsedMs: 1234,
      response: { id: "resp", usage: {}, output: [] },
    };
    vi.mocked(runOracle).mockResolvedValue(liveResult);

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: "api",
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    expect(sessionStoreMock.updateSession).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runOracle)).toHaveBeenCalled();
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "completed",
      usage: { totalTokens: 30 },
      response: expect.objectContaining({ responseId: expect.any(String) }),
    });
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
    expect(vi.mocked(sendSessionNotification)).toHaveBeenCalled();
    expect(sessionStoreMock.updateSession.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      vi.mocked(sendSessionNotification).mock.invocationCallOrder.at(-1) ?? 0,
    );
  });

  test("writes final assistant output to disk for single-model runs", async () => {
    const liveResult: RunOracleResult = {
      mode: "live",
      usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 },
      elapsedMs: 500,
      response: {
        id: "resp",
        usage: {},
        output: [{ type: "message", content: [{ type: "output_text", text: "Saved text" }] }],
      },
    };
    vi.mocked(runOracle).mockResolvedValue(liveResult);

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: { ...baseRunOptions, writeOutputPath: "/tmp/out.md" },
      mode: "api",
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    const writeCalls = (fsPromises.writeFile as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const expectedPath = path.resolve("/tmp/out.md");
    expect(writeCalls).toContainEqual([
      expectedPath,
      expect.stringContaining("Saved text\n"),
      "utf8",
    ]);
    expect(sessionStoreMock.updateSession.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      vi.mocked(fsPromises.writeFile).mock.invocationCallOrder.at(-1) ?? 0,
    );
    const logLines = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logLines).toContain("Saved assistant output");
  });

  test("streams per-model output as each model finishes when TTY", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: "gpt-5.1", status: "running" } as SessionModelRun,
        { model: "gemini-3-pro", status: "running" } as SessionModelRun,
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockImplementation(
      async (_sessionId: string, model: string) => `Answer:\nfrom ${model}`,
    );

    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true as unknown as boolean);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;

    vi.mocked(runMultiModelApiSession).mockImplementation(async (params) => {
      const fulfilled: ModelExecutionResult[] = [
        {
          model: "gemini-3-pro" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "gemini answer",
          logPath: "log-gemini",
        },
        {
          model: "gpt-5.1" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "gpt answer",
          logPath: "log-gpt",
        },
      ];

      if (params.onModelDone) {
        for (const entry of fulfilled) {
          await params.onModelDone(entry);
        }
      }

      return {
        fulfilled,
        rejected: [],
        elapsedMs: 1000,
      } as MultiModelRunSummary;
    });

    await performSessionRun({
      sessionMeta,
      runOptions: { ...baseRunOptions, models: ["gpt-5.1", "gemini-3-pro"] },
      mode: "api",
      cwd: "/tmp",
      log: logSpy,
      write: writeSpy,
      version: cliVersion,
    });

    const written = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(written).toContain("from gemini-3-pro");
    expect(written).toContain("from gpt-5.1");
    const geminiIndex = written.indexOf("from gemini-3-pro");
    const gptIndex = written.indexOf("from gpt-5.1");
    expect(geminiIndex).toBeGreaterThan(-1);
    expect(gptIndex).toBeGreaterThan(-1);
    expect(geminiIndex).toBeLessThan(gptIndex);

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  }, 15_000);

  test("strips OSC progress codes from stored model logs", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: "gpt-5.1", status: "running" } as SessionModelRun,
        { model: "gemini-3-pro", status: "running" } as SessionModelRun,
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue(
      "\u001b]9;4;3;;Waiting for API\u001b\\Please provide design",
    );

    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true as unknown as boolean);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = true;

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: "gpt-5.1" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "other",
          logPath: "log-gpt",
        },
        {
          model: "gemini-3-pro" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "fallback text",
          logPath: "log-gem",
        },
      ],
      rejected: [],
      elapsedMs: 123,
    };

    vi.mocked(runMultiModelApiSession).mockImplementation(async (params) => {
      if (params.onModelDone) {
        for (const entry of summary.fulfilled) {
          await params.onModelDone(entry);
        }
      }
      return summary;
    });

    await performSessionRun({
      sessionMeta,
      runOptions: { ...baseRunOptions, models: ["gpt-5.1", "gemini-3-pro"] },
      mode: "api",
      cwd: "/tmp",
      log: logSpy,
      write: writeSpy,
      version: cliVersion,
    });

    const combined =
      writeSpy.mock.calls.map((c) => c[0]).join("") + logSpy.mock.calls.map((c) => c[0]).join("");
    expect(combined).toContain("Please provide design");
    // OSC progress codes should be preserved when replaying logs so terminals can render them.
    expect(combined).toContain("\u001b]9;4;");

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  });

  test("writes per-model outputs during multi-model runs when writeOutputPath provided", async () => {
    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: "gpt-5.2-pro" as ModelName,
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            reasoningTokens: 0,
            totalTokens: 3,
            cost: 0.01,
          },
          answerText: "pro answer",
          logPath: "log-pro",
        },
        {
          model: "gemini-3-pro" as ModelName,
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            reasoningTokens: 0,
            totalTokens: 3,
            cost: 0.02,
          },
          answerText: "gemini answer",
          logPath: "log-gemini",
        },
      ],
      rejected: [],
      elapsedMs: 1200,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    await performSessionRun({
      sessionMeta: {
        ...baseSessionMeta,
        models: [
          { model: "gpt-5.2-pro", status: "pending" } as SessionModelRun,
          { model: "gemini-3-pro", status: "pending" } as SessionModelRun,
        ],
      },
      runOptions: {
        ...baseRunOptions,
        models: ["gpt-5.2-pro", "gemini-3-pro"],
        writeOutputPath: "/tmp/out.md",
      },
      mode: "api",
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    const writeCalls = (fsPromises.writeFile as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const expectedProPath = path.resolve("/tmp/out.gpt-5.2-pro.md");
    const expectedGeminiPath = path.resolve("/tmp/out.gemini-3-pro.md");
    const expectedManifestPath = path.resolve("/tmp/out.oracle.json");
    expect(writeCalls).toContainEqual([
      expectedProPath,
      expect.stringContaining("pro answer\n"),
      "utf8",
    ]);
    expect(writeCalls).toContainEqual([
      expectedGeminiPath,
      expect.stringContaining("gemini answer\n"),
      "utf8",
    ]);
    const manifestCall = writeCalls.find((call) => call[0] === expectedManifestPath);
    expect(manifestCall).toBeDefined();
    const manifest = JSON.parse(manifestCall?.[1] as string);
    expect(manifest).toMatchObject({
      version: 1,
      sessionId: "sess-1",
      status: "completed",
      outputBasePath: path.resolve("/tmp/out.md"),
      models: [
        {
          model: "gpt-5.2-pro",
          status: "completed",
          outputPath: expectedProPath,
          logPath: "log-pro",
          usage: { totalTokens: 3 },
        },
        {
          model: "gemini-3-pro",
          status: "completed",
          outputPath: expectedGeminiPath,
          logPath: "log-gemini",
          usage: { totalTokens: 3 },
        },
      ],
    });
    const logLines = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logLines).toContain("Saved outputs:");
    expect(logLines).toContain(`gpt-5.2-pro -> ${expectedProPath}`);
    expect(logLines).toContain(`Output manifest: ${expectedManifestPath}`);
    expect(logLines).toContain("Run logs:");
    expect(logLines).toContain("gemini-3-pro -> log-gemini");
  });

  test("prints one aggregate header and colored summary for multi-model runs", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: "gpt-5.1", status: "running" } as SessionModelRun,
        { model: "gemini-3-pro", status: "running" } as SessionModelRun,
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue("Answer:\nfrom model");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true as unknown as boolean);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: "gpt-5.1" as ModelName,
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            reasoningTokens: 0,
            totalTokens: 30,
            cost: 0.01,
          },
          answerText: "ans-gpt",
          logPath: "log-gpt",
        },
        {
          model: "gemini-3-pro" as ModelName,
          usage: {
            inputTokens: 5,
            outputTokens: 5,
            reasoningTokens: 0,
            totalTokens: 10,
            cost: 0.02,
          },
          answerText: "ans-gemini",
          logPath: "log-gemini",
        },
      ],
      rejected: [],
      elapsedMs: 1234,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    await performSessionRun({
      sessionMeta,
      runOptions: { ...baseRunOptions, models: ["gpt-5.1", "gemini-3-pro"] },
      mode: "api",
      cwd: "/tmp",
      log: logSpy,
      write: writeSpy,
      version: cliVersion,
    });

    const logsCombined = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logsCombined).toContain("Calling gpt-5.1, gemini-3-pro");
    expect((logsCombined.match(/Calling gpt-5.1/g) ?? []).length).toBe(1);
    expect((logsCombined.match(/Tip: no files attached/g) ?? []).length).toBe(1);
    expect(
      (logsCombined.match(/Tip: brief prompts often yield generic answers/g) ?? []).length,
    ).toBe(1);
    expect(logsCombined).toContain("2/2 models");
    expect(logsCombined).toContain("↑");
    expect(logsCombined).toContain("↓");
    expect(logsCombined).toContain("Δ");

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  });

  test("uses warning color when some models fail", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: "gpt-5.1", status: "running" },
        { model: "gemini-3-pro", status: "running" },
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue("Answer:\npartial");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true as unknown as boolean);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: "gpt-5.1" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "ok",
          logPath: "log-ok",
        },
      ],
      rejected: [{ model: "gemini-3-pro" as ModelName, reason: new Error("boom") }],
      elapsedMs: 500,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    await expect(
      performSessionRun({
        sessionMeta,
        runOptions: { ...baseRunOptions, models: ["gpt-5.1", "gemini-3-pro"] },
        mode: "api",
        cwd: "/tmp",
        log: logSpy,
        write: writeSpy,
        version: cliVersion,
      }),
    ).rejects.toThrow("boom");

    const logsCombined = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logsCombined).toContain("Calling gpt-5.1, gemini-3-pro");
    expect(logsCombined).toContain("1/2 models");
    expect(logsCombined).toContain("Multi-model result: partial success, 1/2 succeeded");
    expect(logsCombined).toContain("Failures:");
    expect(logsCombined).toContain("gemini-3-pro: boom");

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  });

  test("allows partial multi-model success when requested", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: "gpt-5.1", status: "running" },
        { model: "gemini-3-pro", status: "running" },
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue("Answer:\npartial");

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: "gpt-5.1" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "ok",
          logPath: "log-ok",
        },
      ],
      rejected: [{ model: "gemini-3-pro" as ModelName, reason: new Error("boom") }],
      elapsedMs: 500,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    await performSessionRun({
      sessionMeta,
      runOptions: {
        ...baseRunOptions,
        models: ["gpt-5.1", "gemini-3-pro"],
        partialMode: "ok",
      },
      mode: "api",
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({ status: "partial" });
    const logsCombined = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logsCombined).toContain("Multi-model result: partial success, 1/2 succeeded");
    expect(logsCombined).toContain("Failures:");
  });

  test("prints classified provider failures with recovery hints", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: "gpt-5.1", status: "running" },
        { model: "claude-4.6-sonnet", status: "running" },
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue("Answer:\npartial");
    const providerError = new Error("invalid x-api-key: sk-ant-secret123456789");

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: "gpt-5.1" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "ok",
          logPath: "log-ok",
        },
      ],
      rejected: [
        {
          model: "claude-4.6-sonnet" as ModelName,
          reason: providerError,
        },
      ],
      elapsedMs: 500,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    await withExactEnv(
      {
        ANTHROPIC_API_KEY: "ak-native-test-key",
        OPENROUTER_API_KEY: undefined,
      },
      () =>
        performSessionRun({
          sessionMeta,
          runOptions: {
            ...baseRunOptions,
            models: ["gpt-5.1", "claude-4.6-sonnet"],
            partialMode: "ok",
          },
          mode: "api",
          cwd: "/tmp",
          log,
          write,
          version: cliVersion,
        }),
    );

    const logsCombined = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logsCombined).toContain("claude-4.6-sonnet: auth failed");
    expect(logsCombined).toContain("key: ANTHROPIC_API_KEY");
    expect(logsCombined).toContain("provider said: invalid x-api-key: [redacted]");
    expect(logsCombined).toContain("fix: refresh ANTHROPIC_API_KEY");
    expect(logsCombined).toContain("oracle doctor --providers --models claude-4.6-sonnet");
    expect(logsCombined).not.toContain("sk-ant-secret123456789");
  });

  test("sanitizes rethrown provider failures when partial success is not allowed", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: "gpt-5.1", status: "running" },
        { model: "claude-4.6-sonnet", status: "running" },
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue("Answer:\npartial");
    const providerError = new Error("invalid x-api-key: sk-ant-secret123456789");

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: "gpt-5.1" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "ok",
          logPath: "log-ok",
        },
      ],
      rejected: [
        {
          model: "claude-4.6-sonnet" as ModelName,
          reason: providerError,
        },
      ],
      elapsedMs: 500,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    let thrown: unknown;
    try {
      await withExactEnv(
        {
          ANTHROPIC_API_KEY: "ak-native-test-key",
          OPENROUTER_API_KEY: undefined,
        },
        () =>
          performSessionRun({
            sessionMeta,
            runOptions: {
              ...baseRunOptions,
              models: ["gpt-5.1", "claude-4.6-sonnet"],
            },
            mode: "api",
            cwd: "/tmp",
            log,
            write,
            version: cliVersion,
          }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("claude-4.6-sonnet: auth failed");
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();

    const logsCombined = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logsCombined).toContain("ERROR: claude-4.6-sonnet: auth failed");
    expect(logsCombined).toContain("provider said: invalid x-api-key: [redacted]");
    expect(logsCombined).not.toContain("sk-ant-secret123456789");
    expect(providerError.message).toBe("invalid x-api-key: sk-ant-secret123456789");
  });

  test("preserves transport metadata when sanitizing rethrown provider failures", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [{ model: "gpt-5.2-pro", status: "running" }],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue("");
    const transportError = new OracleTransportError(
      "model-unavailable",
      "The requested model does not exist for sk-secret123456789",
    );

    const summary: MultiModelRunSummary = {
      fulfilled: [],
      rejected: [
        {
          model: "gpt-5.2-pro" as ModelName,
          reason: transportError,
        },
      ],
      elapsedMs: 500,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    let thrown: unknown;
    try {
      await performSessionRun({
        sessionMeta,
        runOptions: {
          ...baseRunOptions,
          models: ["gpt-5.2-pro", "gpt-5.1"],
        },
        mode: "api",
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      reason: "model-unavailable",
      message: expect.stringContaining("gpt-5.2-pro: model unavailable"),
    });
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      transport: { reason: "model-unavailable" },
    });
    expect(finalUpdate?.errorMessage).toContain("gpt-5.2-pro: model unavailable");
    expect(finalUpdate?.errorMessage).not.toContain("sk-secret123456789");
    const logsCombined = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logsCombined).toContain("Transport: model-unavailable");
    expect(logsCombined).not.toContain("sk-secret123456789");
    expect(transportError.message).toBe(
      "The requested model does not exist for sk-secret123456789",
    );
  });

  test("prints tips before the first model heading in multi-model TTY streaming", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: "gpt-5.1", status: "running" } as SessionModelRun,
        { model: "gemini-3-pro", status: "running" } as SessionModelRun,
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockImplementation(
      async (_sessionId: string, model: string) => `Answer for ${model}`,
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true as unknown as boolean);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = true;

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: "gpt-5.1" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "ans-gpt",
          logPath: "log-gpt",
        },
      ],
      rejected: [],
      elapsedMs: 321,
    };
    vi.mocked(runMultiModelApiSession).mockImplementation(async (params) => {
      if (params.onModelDone) {
        for (const entry of summary.fulfilled) {
          await params.onModelDone(entry);
        }
      }
      return summary;
    });

    await performSessionRun({
      sessionMeta,
      runOptions: { ...baseRunOptions, models: ["gpt-5.1", "gemini-3-pro"], prompt: "short" },
      mode: "api",
      cwd: "/tmp",
      log: logSpy,
      write: writeSpy,
      version: cliVersion,
    });

    const logMessages = logSpy.mock.calls.map((c) => c[0]);
    const tipIndex = logMessages.findIndex(
      (line) => typeof line === "string" && line.includes("Tip: no files attached"),
    );
    const headingIndex = logMessages.findIndex(
      (line) => typeof line === "string" && line.includes("[gpt-5.1]"),
    );
    expect(tipIndex).toBeGreaterThan(-1);
    expect(headingIndex).toBeGreaterThan(-1);
    expect(tipIndex).toBeLessThan(headingIndex);

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  });

  test("omits tips when files are attached and prompt is long", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: "gpt-5.1", status: "running" } as SessionModelRun,
        { model: "gemini-3-pro", status: "running" } as SessionModelRun,
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue("Answer:\nfrom model");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true as unknown as boolean);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;

    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, "oracle-tip.txt");
    fs.writeFileSync(tmpFile, "content");

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: "gpt-5.1" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "ans-gpt",
          logPath: "log-gpt",
        },
        {
          model: "gemini-3-pro" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "ans-gem",
          logPath: "log-gemini",
        },
      ],
      rejected: [],
      elapsedMs: 999,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    await performSessionRun({
      sessionMeta,
      runOptions: {
        ...baseRunOptions,
        prompt: "a".repeat(100),
        file: [tmpFile],
        models: ["gpt-5.1", "gemini-3-pro"],
      },
      mode: "api",
      cwd: tmpDir,
      log: logSpy,
      write: writeSpy,
      version: cliVersion,
    });

    const logsCombined = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logsCombined).toContain("Calling gpt-5.1, gemini-3-pro");
    expect(logsCombined).not.toContain("Tip: no files attached");
    expect(logsCombined).not.toContain("Tip: brief prompts often yield generic answers");

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  }, 10_000);

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

  test("keeps the published answer completed when optional model-run projection fails", async () => {
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

    const completedCallIndex = sessionStoreMock.updateSession.mock.calls.findIndex(
      (call) => call[1]?.status === "completed",
    );
    const completedModelRunIndex = sessionStoreMock.updateModelRun.mock.calls.findIndex(
      (call) => call[2]?.status === "completed",
    );
    const errorUpdate = sessionStoreMock.updateSession.mock.calls.find(
      (call) => call[1]?.status === "error",
    )?.[1];
    expect(
      sessionStoreMock.updateSession.mock.invocationCallOrder[completedCallIndex],
    ).toBeLessThan(
      sessionStoreMock.updateModelRun.mock.invocationCallOrder[completedModelRunIndex] ?? 0,
    );
    expect(errorUpdate).toBeUndefined();
    expect(finalize).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("model-run projection failed"));
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

  test("writes browser answers to disk when writeOutputPath provided", async () => {
    const runtime: BrowserRuntimeMetadata = {
      chromePid: 1,
      chromePort: 9222,
      userDataDir: "/tmp/chrome",
    };
    vi.mocked(runBrowserSessionExecution).mockResolvedValue({
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 },
      elapsedMs: 500,
      runtime,
      answerText: "browser answer",
      bindSettlement: vi.fn(async () => runtime),
      finalize: vi.fn(async () => ({ status: "completed" as const, runtime })),
      abort: vi.fn(async () => ({ status: "completed" as const, runtime })),
    });

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: { ...baseRunOptions, writeOutputPath: "/tmp/browser-out.md" },
      mode: "browser",
      browserConfig: { chromePath: null },
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    const writeCalls = (fsPromises.writeFile as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const expectedPath = path.resolve("/tmp/browser-out.md");
    expect(writeCalls).toContainEqual([
      expectedPath,
      expect.stringContaining("browser answer\n"),
      "utf8",
    ]);
  });

  test("write-output failures warn but keep session successful", async () => {
    const liveResult: RunOracleResult = {
      mode: "live",
      usage: { inputTokens: 5, outputTokens: 5, reasoningTokens: 0, totalTokens: 10 },
      elapsedMs: 300,
      response: {
        id: "resp",
        usage: {},
        output: [{ type: "message", content: [{ type: "output_text", text: "content" }] }],
      },
    };
    vi.mocked(runOracle).mockResolvedValue(liveResult);
    const eacces = new Error("EACCES");
    // @ts-expect-error simulate code
    eacces.code = "EACCES";
    vi.mocked(fsPromises.writeFile)
      .mockRejectedValueOnce(eacces as never)
      .mockResolvedValueOnce(
        undefined as unknown as Awaited<ReturnType<typeof fsPromises.writeFile>>,
      );

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: { ...baseRunOptions, writeOutputPath: "/tmp/out.md" },
        mode: "api",
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).resolves.not.toThrow();

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({ status: "completed" });
    const logLines = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logLines).toContain("write-output fallback");
    const calls = (fsPromises.writeFile as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls[0][0]).toBe(path.resolve("/tmp/out.md"));
    expect(calls[1][0]).toMatch(/out\.fallback/);
  });

  test("refuses to write inside session storage path", async () => {
    const sessionsDir = sessionStoreMock.sessionsDir();
    const liveResult: RunOracleResult = {
      mode: "live",
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 },
      elapsedMs: 100,
      response: {
        id: "resp",
        usage: {},
        output: [{ type: "message", content: [{ type: "output_text", text: "blocked" }] }],
      },
    };
    vi.mocked(runOracle).mockResolvedValue(liveResult);

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: { ...baseRunOptions, writeOutputPath: path.join(sessionsDir, "out.md") },
      mode: "api",
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    expect(fsPromises.writeFile).not.toHaveBeenCalled();
    const logLines = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logLines).toContain("refusing to write inside session storage");
  });

  test("deriveModelOutputPath appends model when base has no extension", () => {
    const result = deriveModelOutputPath("/tmp/out", "gpt-5.2-pro");
    const expected = path.join(path.dirname("/tmp/out"), "out.gpt-5.2-pro");
    expect(result).toBe(expected);
  });

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

  test("reconciles exact epoch-less acquisition authority before restarting a stale browser session", async () => {
    const pendingRuntime = createPendingChromeAcquisitionRuntime();
    const retainedRuntime: BrowserRuntimeMetadata = {
      ...pendingRuntime,
      recoveryCleanupResult: {
        status: "failed",
        error: "Chrome process launch discovery is temporarily unavailable",
        settlementMode: "abort",
      },
    };
    vi.mocked(settleBrowserRecoveryCleanup).mockResolvedValueOnce({
      finalization: {
        status: "pending",
        runtime: retainedRuntime,
        error: "Chrome process launch discovery is temporarily unavailable",
      },
      persistence: { status: "persisted" },
    });

    await expect(
      performSessionRun({
        sessionMeta: {
          ...baseSessionMeta,
          status: "running",
          mode: "browser",
          browser: { config: { chromePath: null }, runtime: pendingRuntime },
        },
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow(/acquisition cleanup remains pending/i);

    expect(settleBrowserRecoveryCleanup).toHaveBeenCalledWith(
      pendingRuntime,
      expect.any(Function),
      expect.objectContaining({
        recoveryLockPath: path.join(os.tmpdir(), "oracle-test-session", "browser-recovery.lock"),
      }),
      "abort",
    );
    expect(runBrowserSessionExecution).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "error",
      browser: { runtime: retainedRuntime },
      error: {
        category: "browser-automation",
        details: { code: "browser-acquisition-cleanup-pending", runtime: retainedRuntime },
      },
    });
  });

  test("starts a replacement browser only after exact acquisition cleanup completes", async () => {
    const pendingRuntime = createPendingChromeAcquisitionRuntime();
    const recoveredRuntime: BrowserRuntimeMetadata = {
      browserTransport: "cdp",
    };
    const freshRuntime: BrowserRuntimeMetadata = {
      browserTransport: "cdp",
      ...committedDemoAuthority,
    };
    const finalize = vi.fn(async () => ({
      status: "completed" as const,
      runtime: freshRuntime,
    }));
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime: freshRuntime }));
    vi.mocked(settleBrowserRecoveryCleanup).mockResolvedValueOnce({
      finalization: { status: "completed", runtime: recoveredRuntime },
      persistence: { status: "persisted" },
    });
    vi.mocked(runBrowserSessionExecution).mockResolvedValueOnce({
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 },
      elapsedMs: 100,
      runtime: freshRuntime,
      answerText: "replacement browser answer",
      bindSettlement: vi.fn(async () => freshRuntime),
      finalize,
      abort,
    });

    await performSessionRun({
      sessionMeta: {
        ...baseSessionMeta,
        status: "error",
        mode: "browser",
        browser: { config: { chromePath: null }, runtime: pendingRuntime },
      },
      runOptions: baseRunOptions,
      mode: "browser",
      browserConfig: { chromePath: null },
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    expect(settleBrowserRecoveryCleanup).toHaveBeenCalledWith(
      pendingRuntime,
      expect.any(Function),
      expect.any(Object),
      "abort",
    );
    expect(vi.mocked(settleBrowserRecoveryCleanup).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runBrowserSessionExecution).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(finalize).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "completed",
      browser: { runtime: freshRuntime },
    });
  });

  test("rejects PID-only acquisition state without starting recovery or a replacement browser", async () => {
    const pendingRuntime = createPendingChromeAcquisitionRuntime();
    const resource = pendingRuntime.recoveryCleanupResources?.[0];
    if (!resource?.acquisition) throw new Error("Missing acquisition fixture");
    const malformedRuntime: BrowserRuntimeMetadata = {
      ...pendingRuntime,
      recoveryCleanupResources: [
        {
          ...resource,
          acquisition: { ...resource.acquisition, processLaunchClaim: undefined },
        },
      ],
    };

    await expect(
      performSessionRun({
        sessionMeta: {
          ...baseSessionMeta,
          status: "error",
          mode: "browser",
          browser: { config: { chromePath: null }, runtime: malformedRuntime },
        },
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow(/authority is incomplete or malformed/i);

    expect(settleBrowserRecoveryCleanup).not.toHaveBeenCalled();
    expect(runBrowserSessionExecution).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "error",
      browser: { runtime: malformedRuntime },
      error: {
        category: "browser-automation",
        details: { code: "browser-acquisition-authority-invalid", runtime: malformedRuntime },
      },
    });
  });

  test("rejects conflicting positive acquisition identities before cleanup admission", async () => {
    const pendingRuntime = createPendingChromeAcquisitionRuntime();
    const resource = pendingRuntime.recoveryCleanupResources?.[0];
    const launchClaim = resource?.acquisition?.processLaunchClaim;
    const profileDirectory = resource?.profileDirectoryIdentity;
    if (!resource || !launchClaim || !profileDirectory) {
      throw new Error("Missing exact acquisition fixture");
    }
    const normalizedUserDataDir =
      process.platform === "win32"
        ? profileDirectory.canonicalPath.toLowerCase()
        : profileDirectory.canonicalPath;
    const executablePath =
      process.platform === "win32"
        ? String.raw`c:\program files\google\chrome\application\chrome.exe`
        : process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : "/usr/bin/google-chrome";
    const resourceIdentity = {
      pid: 7_777,
      processStartTime: "resource-process-generation",
      executablePath,
      normalizedUserDataDir,
      launchNonce: launchClaim.nonce,
      launchClaim,
      profileDirectory,
    };
    const conflictingClaim = {
      ...launchClaim,
      nonce: "90000000-0000-4000-8000-000000000009",
    };
    const mismatchedRuntime: BrowserRuntimeMetadata = {
      ...pendingRuntime,
      chromeProcessIdentity: {
        ...resourceIdentity,
        processStartTime: "conflicting-process-generation",
        launchNonce: conflictingClaim.nonce,
        launchClaim: conflictingClaim,
      },
      recoveryCleanupResources: [{ ...resource, chromeProcessIdentity: resourceIdentity }],
    };

    await expect(
      performSessionRun({
        sessionMeta: {
          ...baseSessionMeta,
          status: "error",
          mode: "browser",
          browser: { config: { chromePath: null }, runtime: mismatchedRuntime },
        },
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow(/authority is incomplete or malformed/i);

    expect(settleBrowserRecoveryCleanup).not.toHaveBeenCalled();
    expect(runBrowserSessionExecution).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "error",
      browser: { runtime: mismatchedRuntime },
      error: {
        category: "browser-automation",
        details: { code: "browser-acquisition-authority-invalid", runtime: mismatchedRuntime },
      },
    });
  });

  test("rejects epoch-less recovery authority", async () => {
    const automationError = new BrowserAutomationError("Chrome disconnected", {
      stage: "connection-lost",
      recoverableDisconnect: true,
      disconnectCause: "cdp-client-disconnect",
      runtime: {
        chromePort: 9222,
        chromeHost: "127.0.0.1",
        chromeTargetId: "TARGET-1",
        tabUrl: "https://chatgpt.com/c/demo",
      },
    });
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
    ).rejects.toThrow("Chrome disconnected");

    expect(vi.mocked(resumeBrowserSession)).not.toHaveBeenCalled();
    const logLines = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logLines).toContain(
      "Chrome disconnected without recoverable current-prompt commit authority; marking session error.",
    );
    expect(logLines).not.toContain("oracle session sess-1 --render");
    expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "error",
      response: { status: "error", incompleteReason: "chrome-disconnected" },
    });
  });

  test("does not reattach remote cleanup authority after settlement", async () => {
    const runtime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          remoteRecovery: {
            protocolVersion: 3,
            host: "bridge.example:9443",
            transactionToken: "f".repeat(64),
            state: "pre-receipt",
          },
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: true },
        },
      ],
      recoveryCleanupResult: { status: "failed", settlementMode: "finalize" },
    };
    const automationError = new BrowserAutomationError("Chrome disconnected", {
      stage: "connection-lost",
      recoverableDisconnect: true,
      runtime,
    });
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
    ).rejects.toThrow("Chrome disconnected");

    expect(vi.mocked(resumeBrowserSession)).not.toHaveBeenCalled();
    expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "error",
      browser: { runtime },
    });
  });

  test("retains remote-only pre-receipt authority and prints reattach guidance", async () => {
    const remoteRuntime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          remoteRecovery: {
            protocolVersion: 3,
            host: "bridge.example:9443",
            transactionToken: "d".repeat(64),
            state: "pre-receipt",
            requestIdentity: {
              acceptedPromptSha256: ["e".repeat(64)],
              followUpOrdinal: 0,
              remainingFollowUps: 0,
            },
          },
          recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: true },
        },
      ],
    };
    const automationError = new BrowserAutomationError(
      "Remote browser response disconnected before the durable receipt.",
      {
        stage: "remote-retry",
        recoverableDisconnect: true,
        runtime: remoteRuntime,
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
    ).rejects.toThrow(/remote browser response disconnected/i);

    const logLines = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logLines).toContain("oracle session sess-1 --render");
    expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "error",
      browser: {
        runtime: remoteRuntime,
      },
    });
    expect(vi.mocked(resumeBrowserSession)).not.toHaveBeenCalled();
  });

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
    const reattach = createReattachResult(
      "recovered answer",
      "recovered **answer**",
      recoveredRuntime,
    );
    vi.mocked(resumeBrowserSession).mockResolvedValueOnce(reattach.value);
    vi.mocked(ensureSessionArtifacts).mockResolvedValueOnce([
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
    const completedUpdate = sessionStoreMock.updateSession.mock.calls.find(
      ([, updates]) => updates.status === "completed",
    )?.[1];
    expect(completedUpdate).toMatchObject({
      status: "completed",
      response: { status: "completed" },
      browser: {
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
    vi.spyOn(
      browserPublicationJournal,
      "writeBrowserCapturePublicationJournal",
    ).mockRejectedValueOnce(new Error("journal write failed before answer persistence"));

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

  test("records response metadata when runOracle throws OracleResponseError", async () => {
    const errorResponse: OracleResponse = { id: "resp-error", output: [], usage: {} };
    vi.mocked(runOracle).mockRejectedValue(new OracleResponseError("boom", errorResponse));

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "api",
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("boom");

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      response: expect.objectContaining({ responseId: "resp-error" }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "running" }),
    );
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "error" }),
    );
  });

  test("captures transport failures when OracleTransportError thrown", async () => {
    vi.mocked(runOracle).mockRejectedValue(new OracleTransportError("client-timeout", "timeout"));

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "api",
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("timeout");

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      transport: { reason: "client-timeout" },
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "error" }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Transport"));
  });

  test("stores api-error transport message for later rendering", async () => {
    vi.mocked(runOracle).mockRejectedValue(new OracleTransportError("api-error", "quota exceeded"));

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "api",
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("quota exceeded");

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      transport: { reason: "api-error" },
      errorMessage: "quota exceeded",
    });
  });

  test("captures user errors when OracleUserError thrown", async () => {
    vi.mocked(runOracle).mockRejectedValue(
      new FileValidationError("too large", { path: "foo.txt" }),
    );

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "api",
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("too large");

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      error: expect.objectContaining({ category: "file-validation", message: "too large" }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "error" }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("User error (file-validation)"));
  });
});
