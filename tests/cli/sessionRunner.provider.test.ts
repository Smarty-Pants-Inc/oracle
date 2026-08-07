import fs from "node:fs";
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
import { OracleTransportError } from "../../src/oracle.ts";
import {
  runMultiModelApiSession,
  type MultiModelRunSummary,
} from "../../src/oracle/multiModelRunner.ts";
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
let testSessionDir: string;

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
});
