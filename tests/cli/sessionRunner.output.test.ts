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
import {
  FileValidationError,
  OracleResponseError,
  OracleTransportError,
  runOracle,
} from "../../src/oracle.ts";
import { runMultiModelApiSession } from "../../src/oracle/multiModelRunner.ts";
import type { OracleResponse, RunOracleResult } from "../../src/oracle.ts";
import {
  ensureSessionArtifacts,
  runBrowserSessionExecution,
} from "../../src/browser/sessionRunner.ts";
import { getCliVersion } from "../../src/version.ts";
import { deriveModelOutputPath } from "../../src/cli/sessionRunner.ts";
import { resumeBrowserSession, settleBrowserRecoveryCleanup } from "../../src/browser/reattach.ts";
import { persistDurableBrowserAnswer } from "../../src/cli/durableAnswer.ts";

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
