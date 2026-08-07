import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

import type { SessionMetadata, SessionModelRun } from "../../src/sessionManager.ts";
import { baseRunOptions, baseSessionMeta } from "./sessionRunner.fixtures.ts";
import type { ModelName } from "../../src/oracle.ts";
import { performSessionRun } from "../../src/cli/sessionRunner.ts";
import { runOracle } from "../../src/oracle.ts";
import {
  runMultiModelApiSession,
  type ModelExecutionResult,
  type MultiModelRunSummary,
} from "../../src/oracle/multiModelRunner.ts";
import type { RunOracleResult } from "../../src/oracle.ts";
import {
  ensureSessionArtifacts,
  runBrowserSessionExecution,
} from "../../src/browser/sessionRunner.ts";
import { sendSessionNotification } from "../../src/cli/notifier.ts";
import { getCliVersion } from "../../src/version.ts";
import { resumeBrowserSession, settleBrowserRecoveryCleanup } from "../../src/browser/reattach.ts";
import { persistDurableBrowserAnswer } from "../../src/cli/durableAnswer.ts";

const log = vi.fn();
const write = vi.fn(() => true);
const cliVersion = getCliVersion();
let testSessionDir: string;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  testSessionDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "oracle-test-session-"));
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
    dir: testSessionDir,
    metadata: path.join(testSessionDir, "metadata.json"),
    log: path.join(testSessionDir, "session.log"),
    request: path.join(testSessionDir, "request.json"),
  });
  vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
  vi.spyOn(fsPromises, "writeFile").mockResolvedValue(undefined);
});
afterEach(async () => {
  await fsPromises.rm(testSessionDir, { recursive: true, force: true });
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
});
