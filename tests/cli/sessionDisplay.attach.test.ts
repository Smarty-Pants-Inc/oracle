import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionManager.ts";
import { attachSession } from "../../src/cli/sessionDisplay.ts";
import { renderMarkdownAnsi } from "../../src/cli/markdownRenderer.ts";
import { createSessionDisplayMetadata } from "./sessionDisplay.fixtures.ts";

const waitMock = vi.hoisted(() => vi.fn());
const commitSessionModelProjectionMock = vi.hoisted(() => vi.fn());
const sessionStoreMock = vi.hoisted(() => ({
  readSession: vi.fn(),
  readLog: vi.fn(),
  readModelLog: vi.fn(),
  readRequest: vi.fn(),
  updateSession: vi.fn(),
  updateModelRun: vi.fn(),
  listSessions: vi.fn(),
  filterSessions: vi.fn(),
  getPaths: vi.fn(),
  sessionsDir: vi.fn(),
}));

vi.mock("../../src/sessionStore.ts", () => ({
  sessionStore: sessionStoreMock,
  commitSessionModelProjection: commitSessionModelProjectionMock,
  wait: waitMock,
}));
vi.mock("../../src/cli/markdownRenderer.ts", () => ({
  renderMarkdownAnsi: vi.fn((text: string) => `RENDER:${text}`),
}));

const markdownMock = { renderMarkdownAnsi: vi.mocked(renderMarkdownAnsi) };
const readSessionMetadataMock = sessionStoreMock.readSession;
const readSessionLogMock = sessionStoreMock.readLog;
const readModelLogMock = sessionStoreMock.readModelLog;
const readSessionRequestMock = sessionStoreMock.readRequest;
const originalIsTty = process.stdout.isTTY;
const originalChalkLevel = chalk.level;

beforeEach(() => {
  vi.useRealTimers();
  process.exitCode = undefined;
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  chalk.level = 1;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  waitMock.mockReset();
  commitSessionModelProjectionMock.mockReset();
  for (const mock of Object.values(sessionStoreMock)) mock.mockReset();
  sessionStoreMock.sessionsDir.mockReturnValue("/tmp/sessions");
  sessionStoreMock.getPaths.mockResolvedValue({
    dir: "/tmp/sessions/sess",
    log: "/tmp/sessions/sess/session.log",
  });
  markdownMock.renderMarkdownAnsi.mockClear();
  commitSessionModelProjectionMock.mockImplementation(async (sessionId, projection) => {
    const updated = await sessionStoreMock.updateSession(sessionId, projection.session);
    const session = {
      id: sessionId,
      createdAt: "2026-08-05T00:00:00.000Z",
      status: "running" as const,
      options: {},
      ...(updated ?? {}),
      ...projection.session,
    };
    if (!projection.model) return { session };
    const model = {
      model: projection.model.model,
      status: projection.model.updates.status ?? "pending",
      ...projection.model.updates,
    };
    await sessionStoreMock.updateModelRun(sessionId, model.model, projection.model.updates);
    return { session: { ...session, models: [model] }, model };
  });
  readSessionRequestMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  process.exitCode = undefined;
  Object.defineProperty(process.stdout, "isTTY", { value: originalIsTty, configurable: true });
  chalk.level = originalChalkLevel;
  vi.restoreAllMocks();
});

describe("attachSession terminal rendering", () => {
  const baseMeta: SessionMetadata = createSessionDisplayMetadata();

  test("prints persisted lifecycle metadata", async () => {
    const lifecycleMeta: SessionMetadata = {
      ...baseMeta,
      status: "completed",
      lifecycle: {
        engine: "api",
        execution: "background",
        attached: false,
        detached: true,
        reattachCommand: "oracle session sess",
      },
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(lifecycleMeta);
    readSessionLogMock.mockResolvedValue("");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: false });

    expect(logSpy).toHaveBeenCalledWith("Execution: api/bg (detached)");
    expect(logSpy).toHaveBeenCalledWith("Reattach: oracle session sess");
  });

  test("propagates a detached worker failure only when requested", async () => {
    const failedMeta: SessionMetadata = {
      ...baseMeta,
      status: "error",
      errorMessage: "browser failed",
    };
    readSessionMetadataMock.mockResolvedValue(failedMeta);
    readSessionLogMock.mockResolvedValue("ERROR: browser failed");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: false, suppressMetadata: true });
    expect(process.exitCode).toBeUndefined();

    await attachSession("sess", {
      renderMarkdown: false,
      suppressMetadata: true,
      propagateFailure: true,
    });

    expect(process.exitCode).toBe(1);
  });

  test("stops waiting when a detached browser worker exits before completion", async () => {
    const runningMeta: SessionMetadata = {
      ...baseMeta,
      status: "running",
      mode: "browser",
      browser: {
        runtime: {
          controllerPid: 2_147_483_647,
          tabUrl: "https://chatgpt.com/c/example",
        },
      },
      lifecycle: {
        engine: "browser",
        execution: "background",
        attached: false,
        detached: true,
        workerPid: 2_147_483_647,
        reattachCommand: "oracle session sess",
      },
    } as SessionMetadata;
    readSessionMetadataMock
      .mockResolvedValueOnce({
        ...runningMeta,
        browser: {
          ...runningMeta.browser,
          runtime: {
            ...runningMeta.browser?.runtime,
            controllerPid: process.pid,
          },
        },
        lifecycle: {
          ...runningMeta.lifecycle,
          workerPid: process.pid,
        },
      } as SessionMetadata)
      .mockResolvedValue(runningMeta);
    readSessionLogMock.mockResolvedValue("response streaming");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", {
      renderMarkdown: false,
      suppressMetadata: true,
      propagateFailure: true,
    });

    expect(process.exitCode).toBe(1);
    expect(waitMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Detached worker exited before the session reached a terminal state"),
    );
    expect(sessionStoreMock.updateSession).toHaveBeenCalledWith(
      "sess",
      expect.objectContaining({
        status: "error",
        response: { status: "incomplete", incompleteReason: "incomplete-capture" },
      }),
    );
  });

  test("does not reattach while the detached browser worker is alive", async () => {
    const runningMeta: SessionMetadata = {
      ...baseMeta,
      status: "running",
      mode: "browser",
      response: { status: "incomplete", incompleteReason: "incomplete-capture" },
      browser: {
        runtime: {
          controllerPid: process.pid,
          tabUrl: "https://chatgpt.com/c/example",
        },
      },
      lifecycle: {
        engine: "browser",
        execution: "background",
        attached: false,
        detached: true,
        workerPid: process.pid,
        reattachCommand: "oracle session sess",
      },
    } as SessionMetadata;
    readSessionMetadataMock
      .mockResolvedValueOnce(runningMeta)
      .mockResolvedValueOnce({ ...runningMeta, status: "completed" });
    readSessionLogMock.mockResolvedValue("response streaming");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: false, suppressMetadata: true });

    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Attempting to reattach to the existing Chrome session"),
    );
  });

  test("stops an ordinary attachment when its detached worker exits", async () => {
    const runningMeta: SessionMetadata = {
      ...baseMeta,
      status: "running",
      mode: "browser",
      browser: {
        runtime: {
          controllerPid: process.pid,
          tabUrl: "https://chatgpt.com/c/example",
        },
      },
      lifecycle: {
        engine: "browser",
        execution: "background",
        attached: false,
        detached: true,
        workerPid: process.pid,
        reattachCommand: "oracle session sess",
      },
    } as SessionMetadata;
    const deadMeta = {
      ...runningMeta,
      browser: {
        ...runningMeta.browser,
        runtime: {
          ...runningMeta.browser?.runtime,
          controllerPid: 2_147_483_647,
        },
      },
      lifecycle: {
        ...runningMeta.lifecycle,
        workerPid: 2_147_483_647,
      },
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValueOnce(runningMeta).mockResolvedValue(deadMeta);
    readSessionLogMock.mockResolvedValue("response streaming");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: false, suppressMetadata: true });

    expect(process.exitCode).toBeUndefined();
    expect(sessionStoreMock.updateSession).toHaveBeenCalledWith(
      "sess",
      expect.objectContaining({ status: "error" }),
    );
  });

  test("does not replace completion persisted as the worker exits", async () => {
    const runningMeta: SessionMetadata = {
      ...baseMeta,
      status: "running",
      mode: "browser",
      lifecycle: {
        engine: "browser",
        execution: "background",
        attached: false,
        detached: true,
        workerPid: process.pid,
        reattachCommand: "oracle session sess",
      },
    } as SessionMetadata;
    const deadSnapshot = {
      ...runningMeta,
      lifecycle: {
        ...runningMeta.lifecycle,
        workerPid: 2_147_483_647,
      },
    } as SessionMetadata;
    const completedMeta = { ...deadSnapshot, status: "completed" } as SessionMetadata;
    readSessionMetadataMock
      .mockResolvedValueOnce(runningMeta)
      .mockResolvedValueOnce(deadSnapshot)
      .mockResolvedValue(completedMeta);
    readSessionLogMock.mockResolvedValue("Answer:\ncompleted");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", {
      renderMarkdown: false,
      suppressMetadata: true,
      propagateFailure: true,
    });

    expect(process.exitCode).toBeUndefined();
    expect(sessionStoreMock.updateSession).not.toHaveBeenCalled();
  });

  test("prints chain metadata for follow-up sessions", async () => {
    const followupMeta: SessionMetadata = {
      ...baseMeta,
      options: {
        previousResponseId: "resp_parent_1234",
        followupSessionId: "parent-session",
      },
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(followupMeta);
    readSessionLogMock.mockResolvedValue("Answer:\nchild output");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: false });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Chain: parent-session (resp_parent_1234) -> sess"),
    );
  });

  test("prints all model runs with status and tokens", async () => {
    const multiMeta: SessionMetadata = {
      ...baseMeta,
      models: [
        {
          model: "gpt-5.2-pro",
          status: "completed",
          usage: { inputTokens: 10, outputTokens: 12, reasoningTokens: 0, totalTokens: 24 },
        },
        {
          model: "gemini-3-pro",
          status: "running",
          usage: { inputTokens: 10, outputTokens: 0, reasoningTokens: 0, totalTokens: 10 },
        },
      ],
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(multiMeta);
    readSessionLogMock.mockResolvedValue("Answer:\nhi");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: false });

    expect(logSpy).toHaveBeenCalledWith("Models:");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/gpt-5\.2-pro.*completed tok=12\/24/),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/gemini-3-pro.*running tok=0\/10/));
  });

  test("ignores empty model filter from CLI defaults", async () => {
    const multiMeta: SessionMetadata = {
      ...baseMeta,
      models: [
        {
          model: "gpt-5.2-pro",
          status: "completed",
          usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 },
        },
      ],
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(multiMeta);
    readSessionLogMock.mockResolvedValue("Answer:\nbody");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(process.stdout, "write");

    await attachSession("sess", { renderMarkdown: false, model: "" });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("gpt-5.2-pro"));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("Answer:"));
  });

  test("falls back to session log when per-model logs are empty", async () => {
    const multiMeta: SessionMetadata = {
      ...baseMeta,
      models: [
        {
          model: "gpt-5.2-pro",
          status: "completed",
          usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 },
        },
      ],
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(multiMeta);
    readSessionLogMock.mockResolvedValue("Answer:\nfrom-session-log");
    // model log missing/empty
    readModelLogMock.mockResolvedValue("");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(process.stdout, "write");

    await attachSession("sess", { renderMarkdown: false });

    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("Answer:\nfrom-session-log"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("gpt-5.2-pro"));
  });

  test("renders markdown when requested and rich tty", async () => {
    readSessionMetadataMock.mockResolvedValue(baseMeta);
    readSessionLogMock.mockResolvedValue("Answer:\nhello *world*");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const writeSpy = vi.spyOn(process.stdout, "write");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: true });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Prompt:"));
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledWith("Answer:\nhello *world*");
    expect(writeSpy).toHaveBeenCalledWith("RENDER:Answer:\nhello *world*");
  });

  test("skips render when too large", async () => {
    readSessionMetadataMock.mockResolvedValue(baseMeta);
    readSessionLogMock.mockResolvedValue("A".repeat(210_000));
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const writeSpy = vi.spyOn(process.stdout, "write");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: true });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Prompt:"));
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledTimes(1);
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledWith(
      expect.stringContaining("Prompt here"),
    );
    expect(writeSpy).toHaveBeenCalled(); // raw write
  });

  test("streams rendered chunks during running sessions and honors safe breaks", async () => {
    const runningMeta: SessionMetadata = { ...baseMeta, status: "running" };
    const completedMeta: SessionMetadata = { ...baseMeta, status: "completed" };
    readSessionMetadataMock.mockResolvedValueOnce(runningMeta).mockResolvedValueOnce(completedMeta);
    sessionStoreMock.readSession
      .mockResolvedValueOnce(runningMeta)
      .mockResolvedValueOnce(completedMeta);
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    readSessionLogMock
      .mockResolvedValueOnce("Answer:\n| a | b |\n")
      .mockResolvedValueOnce("Answer:\n| a | b |\n| c | d |\n\nDone\n");
    const writeSpy = vi.spyOn(process.stdout, "write");
    waitMock.mockResolvedValue(undefined);

    await attachSession("sess", { renderMarkdown: true });

    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledTimes(2);
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledWith(
      expect.stringContaining("Prompt here"),
    );
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledWith(
      expect.stringContaining("Answer:\n| a | b |"),
    );
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("RENDER:Answer"));
  });

  test("falls back to raw streaming when live render exceeds cap", async () => {
    const runningMeta: SessionMetadata = { ...baseMeta, status: "running" };
    const completedMeta: SessionMetadata = { ...baseMeta, status: "completed" };
    readSessionMetadataMock.mockResolvedValueOnce(runningMeta).mockResolvedValueOnce(completedMeta);
    sessionStoreMock.readSession
      .mockResolvedValueOnce(runningMeta)
      .mockResolvedValueOnce(completedMeta);
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const huge = "A".repeat(210_000);
    readSessionLogMock.mockResolvedValueOnce(huge).mockResolvedValueOnce(huge);
    waitMock.mockResolvedValue(undefined);

    await attachSession("sess", { renderMarkdown: true });

    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledWith(
      expect.stringContaining("Prompt here"),
    );
  });

  test("suppresses prompt when renderPrompt is false", async () => {
    readSessionMetadataMock.mockResolvedValue(baseMeta);
    readSessionLogMock.mockResolvedValue("Answer:\nhello");
    readSessionRequestMock.mockResolvedValue({ prompt: "Hidden prompt" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: true, renderPrompt: false });

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("Prompt:"));
  });

  test("shows completion summary with cost and slug when available", async () => {
    const metaWithUsage: SessionMetadata = {
      ...baseMeta,
      status: "completed",
      model: "gpt-5.2-pro",
      mode: "api",
      elapsedMs: 1234,
      usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 0, totalTokens: 30, cost: 1.23 },
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(metaWithUsage);
    readSessionLogMock.mockResolvedValue("Answer:\nhello");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: true });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("↑"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("↓"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Δ"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("$1.23"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("slug=sess"));
  });

  test("treats partial sessions as terminal", async () => {
    const partialMeta: SessionMetadata = {
      ...baseMeta,
      status: "partial",
      model: "gpt-5.1",
      mode: "api",
      elapsedMs: 1234,
      usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 0, totalTokens: 30 },
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(partialMeta);
    sessionStoreMock.readSession.mockResolvedValue(partialMeta);
    readSessionLogMock.mockResolvedValue("Answer:\npartial result");
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const writeSpy = vi.spyOn(process.stdout, "write");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: false });

    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("Answer:\npartial result"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("↑"));
    expect(waitMock).not.toHaveBeenCalled();
  });

  test("falls back to metadata prompt when request is missing", async () => {
    readSessionMetadataMock.mockResolvedValue({ ...baseMeta, options: { prompt: "From meta" } });
    readSessionLogMock.mockResolvedValue("Answer:\nhello");
    readSessionRequestMock.mockResolvedValue(null);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await attachSession("sess", { renderMarkdown: true });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Prompt:"));
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledWith("Answer:\nhello");
  });

  test("prints all per-model logs when multi-model session completes", async () => {
    const multiMeta: SessionMetadata = {
      ...baseMeta,
      models: [
        {
          model: "gpt-5.2-pro",
          status: "completed",
          usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 },
        },
        {
          model: "gemini-3-pro",
          status: "completed",
          usage: { inputTokens: 4, outputTokens: 5, reasoningTokens: 0, totalTokens: 9 },
        },
      ],
    } as SessionMetadata;

    readSessionMetadataMock.mockResolvedValue(multiMeta);
    sessionStoreMock.readSession.mockResolvedValue(multiMeta);
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const writeSpy = vi.spyOn(process.stdout, "write");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    sessionStoreMock.readModelLog
      .mockResolvedValueOnce("Answer:\nfrom gpt-5.2-pro")
      .mockResolvedValueOnce("Answer:\nfrom gemini");

    await attachSession("sess", { renderMarkdown: false });

    const written = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(written).toContain("from gpt-5.2-pro");
    expect(written).toContain("=== gemini-3-pro ===");
    expect(written).toContain("from gemini");
    expect(sessionStoreMock.readModelLog).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Models:"));
  });

  test("prints only the selected model log when a model filter is provided", async () => {
    const multiMeta: SessionMetadata = {
      ...baseMeta,
      models: [
        { model: "gpt-5.2-pro", status: "completed" },
        { model: "gemini-3-pro", status: "completed" },
      ],
    } as SessionMetadata;

    readSessionMetadataMock.mockResolvedValue(multiMeta);
    sessionStoreMock.readSession.mockResolvedValue(multiMeta);
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt here" });
    const writeSpy = vi.spyOn(process.stdout, "write");
    sessionStoreMock.readModelLog.mockResolvedValueOnce("Answer:\nfrom gemini only");

    await attachSession("sess", { renderMarkdown: false, model: "Gemini-3-Pro" });

    const written = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(written).toContain("from gemini only");
    expect(written).not.toContain("gpt-5.2-pro");
    expect(sessionStoreMock.readModelLog).toHaveBeenCalledTimes(1);
    expect(sessionStoreMock.readModelLog).toHaveBeenCalledWith("sess", "gemini-3-pro");
  });

  test("exits with error when requested model is not part of the session", async () => {
    const multiMeta: SessionMetadata = {
      ...baseMeta,
      models: [
        { model: "gpt-5.2-pro", status: "completed" },
        { model: "gemini-3-pro", status: "completed" },
      ],
    } as SessionMetadata;

    readSessionMetadataMock.mockResolvedValue(multiMeta);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await attachSession("sess", { model: "claude-4.0" });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Model "claude-4.0" not found'));
    expect(process.exitCode).toBe(1);
    expect(sessionStoreMock.readModelLog).not.toHaveBeenCalled();
  });

  test("falls back to per-model log when metadata is legacy but filter provided", async () => {
    const legacyMeta: SessionMetadata = {
      ...baseMeta,
      model: "gpt-5.2-pro",
      models: undefined,
    } as SessionMetadata;

    readSessionMetadataMock.mockResolvedValue(legacyMeta);
    sessionStoreMock.readSession.mockResolvedValue(legacyMeta);
    readSessionRequestMock.mockResolvedValue({ prompt: "Prompt legacy" });
    sessionStoreMock.readModelLog.mockResolvedValue("Answer:\nlegacy per-model");
    const writeSpy = vi.spyOn(process.stdout, "write");

    await attachSession("sess", { renderMarkdown: false, model: "gpt-5.2-pro" });

    const written = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(written).toContain("legacy per-model");
    expect(sessionStoreMock.readModelLog).toHaveBeenCalledTimes(1);
    expect(sessionStoreMock.readModelLog).toHaveBeenCalledWith("sess", "gpt-5.2-pro");
    expect(sessionStoreMock.readLog).not.toHaveBeenCalled();
  });
});
