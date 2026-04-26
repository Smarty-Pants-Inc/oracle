import { describe, expect, test, vi } from "vitest";
import type { RunOracleOptions } from "../../src/oracle.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import type { BrowserSessionConfig, SessionMetadata } from "../../src/sessionStore.js";
import { reportBrowserProgress } from "../../src/browser/types.js";
import {
  runBrowserSessionExecution,
  continueBrowserSessionExecution,
} from "../../src/browser/sessionRunner.js";

const baseRunOptions: RunOracleOptions = {
  prompt: "Hello world",
  model: "gpt-5.2-pro",
  file: [],
  silent: false,
};

const baseConfig: BrowserSessionConfig = {};

describe("runBrowserSessionExecution", () => {
  test("logs stats and returns usage/runtime", async () => {
    const log = vi.fn();
    const persistRuntimeHint = vi.fn();
    const executeBrowser = vi.fn(async (options) => {
      await options.runtimeHintCb?.({
        chromePort: 9999,
        chromeHost: "127.0.0.1",
        chromeTargetId: "t-1",
        tabUrl: "https://chatgpt.com/c/foo",
      });
      return {
        answerText: "ok",
        answerMarkdown: "ok",
        tookMs: 1000,
        answerTokens: 12,
        answerChars: 20,
      };
    });
    const result = await runBrowserSessionExecution(
      {
        runOptions: baseRunOptions,
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 42,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser,
        persistRuntimeHint,
      },
    );
    expect(result.usage).toEqual({
      inputTokens: 42,
      outputTokens: 12,
      reasoningTokens: 0,
      totalTokens: 54,
    });
    expect(result.runtime).toMatchObject({ chromePid: undefined });
    expect(persistRuntimeHint).toHaveBeenCalledWith(
      expect.objectContaining({ chromePort: 9999, chromeHost: "127.0.0.1", chromeTargetId: "t-1" }),
    );
    expect(log).toHaveBeenCalled();
  });

  test("passes downloadsDir through and surfaces downloaded files", async () => {
    const log = vi.fn();
    const executeBrowser = vi.fn(async () => ({
      answerText: "ok",
      answerMarkdown: "ok",
      tookMs: 50,
      answerTokens: 2,
      answerChars: 2,
      downloads: [
        {
          path: "/tmp/.oracle/sessions/sess-1/downloads/proof.txt",
          suggestedFilename: "proof.txt",
          sizeBytes: 12,
        },
      ],
    }));

    const result = await runBrowserSessionExecution(
      {
        runOptions: baseRunOptions,
        browserConfig: baseConfig,
        downloadsDir: "/tmp/.oracle/sessions/sess-1/downloads",
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 10,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser,
      },
    );

    expect(executeBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        downloadsDir: "/tmp/.oracle/sessions/sess-1/downloads",
      }),
    );
    expect(result.downloads).toEqual([
      {
        path: "/tmp/.oracle/sessions/sess-1/downloads/proof.txt",
        suggestedFilename: "proof.txt",
        sizeBytes: 12,
      },
    ]);
  });

  test("persists attach-mode runtime metadata from the browser runner", async () => {
    const log = vi.fn();
    const persistRuntimeHint = vi.fn();
    const executeBrowser = vi.fn(async (options) => {
      await options.runtimeHintCb?.({
        browserTransport: "cdp" as const,
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        chromeProfileRoot: "/Users/peter/Library/Application Support/Google/Chrome",
        chromeTargetId: "target-2",
        tabUrl: "https://chatgpt.com/c/attached",
      });
      return {
        answerText: "ok",
        answerMarkdown: "ok",
        tookMs: 100,
        answerTokens: 2,
        answerChars: 2,
        browserTransport: "cdp" as const,
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        chromeProfileRoot: "/Users/peter/Library/Application Support/Google/Chrome",
        chromeTargetId: "target-2",
        tabUrl: "https://chatgpt.com/c/attached",
      };
    });

    const result = await runBrowserSessionExecution(
      {
        runOptions: baseRunOptions,
        browserConfig: { attachRunning: true },
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 10,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser,
        persistRuntimeHint,
      },
    );

    expect(persistRuntimeHint).toHaveBeenCalledWith(
      expect.objectContaining({
        browserTransport: "cdp",
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        chromeProfileRoot: "/Users/peter/Library/Application Support/Google/Chrome",
        chromeTargetId: "target-2",
        tabUrl: "https://chatgpt.com/c/attached",
      }),
    );
    expect(result.runtime).toMatchObject({
      browserTransport: "cdp",
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeProfileRoot: "/Users/peter/Library/Application Support/Google/Chrome",
      chromeTargetId: "target-2",
      tabUrl: "https://chatgpt.com/c/attached",
    });
  });

  test("suppresses automation noise when not verbose", async () => {
    const log = vi.fn();
    const noisyLogger = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async ({ log: automationLog }) => {
          automationLog?.("Prompt textarea ready");
          noisyLogger();
          return {
            answerText: "text",
            answerMarkdown: "markdown",
            tookMs: 1,
            answerTokens: 1,
            answerChars: 4,
          };
        },
      },
    );
    expect(log.mock.calls.some((call) => /Launching browser mode/.test(String(call[0])))).toBe(
      true,
    );
    expect(log.mock.calls.some((call) => /Prompt textarea ready/.test(String(call[0])))).toBe(
      false,
    );
    expect(noisyLogger).toHaveBeenCalled(); // ensure executeBrowser ran
  });

  test("prints fallback retry logs even when not verbose", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async ({ log: automationLog }) => {
          automationLog?.("[browser] Inline prompt too large; retrying with file uploads.");
          return {
            answerText: "text",
            answerMarkdown: "markdown",
            tookMs: 1,
            answerTokens: 1,
            answerChars: 4,
          };
        },
      },
    );
    expect(
      log.mock.calls.some((call) => String(call[0]).includes("Inline prompt too large; retrying")),
    ).toBe(true);
  });

  test("passes fallback submission through to browser runner", async () => {
    const log = vi.fn();
    const executeBrowser = vi.fn(async () => ({
      answerText: "text",
      answerMarkdown: "markdown",
      tookMs: 1,
      answerTokens: 1,
      answerChars: 4,
    }));
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: {
            composerText: "fallback prompt",
            attachments: [{ path: "/repo/a.txt", displayPath: "a.txt", sizeBytes: 1 }],
            bundled: null,
          },
        }),
        executeBrowser,
      },
    );
    expect(executeBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [expect.objectContaining({ path: "/repo/a.txt", displayPath: "a.txt" })],
        },
      }),
    );
  });

  test("respects verbose logging", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: true },
        browserConfig: { keepBrowser: true },
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 1,
          attachments: [{ path: "/repo/a.txt", displayPath: "a.txt", sizeBytes: 1024 }],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "upload",
          fallback: null,
        }),
        executeBrowser: async () => ({
          answerText: "text",
          answerMarkdown: "markdown",
          tookMs: 10,
          answerTokens: 1,
          answerChars: 5,
        }),
      },
    );
    expect(log.mock.calls.some((call) => String(call[0]).includes("Browser attachments"))).toBe(
      true,
    );
  });

  test("redacts Browserbase secrets from verbose browser config logs", async () => {
    const log = vi.fn();
    const executeBrowser = vi.fn(async () => ({
      answerText: "text",
      answerMarkdown: "markdown",
      tookMs: 10,
      answerTokens: 1,
      answerChars: 5,
    }));
    const browserConfig: BrowserSessionConfig = {
      browserbase: {
        enabled: true,
        apiKey: "bb_secret_key",
        projectId: "proj_123",
        contextId: "ctx_123",
        keepAlive: true,
        region: "us-west-2",
        timeoutMs: 60_000,
        viewport: { width: 1280, height: 720 },
      },
      remoteChromeBrowserWSEndpoint:
        "wss://user:ws_secret@connect.browserbase.com/devtools/browser/sess_123?token=query_secret",
    };

    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: true },
        browserConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 1,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser,
      },
    );

    const configLog = log.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("Browser config"));
    expect(configLog).toContain('"apiKey":"[redacted]"');
    expect(configLog).toContain('"projectId":"proj_123"');
    expect(configLog).toContain('"contextId":"ctx_123"');
    expect(configLog).toContain('"keepAlive":true');
    expect(configLog).toContain('"region":"us-west-2"');
    expect(configLog).toContain('"timeoutMs":60000');
    expect(configLog).toContain('"viewport":{"width":1280,"height":720}');
    expect(configLog).not.toContain("bb_secret_key");
    expect(configLog).not.toContain("ws_secret");
    expect(configLog).not.toContain("query_secret");
    expect(executeBrowser).toHaveBeenCalledWith(expect.objectContaining({ config: browserConfig }));
  });

  test("verbose output spells out token labels", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: true },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 10,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async () => ({
          answerText: "text",
          answerMarkdown: "markdown",
          tookMs: 100,
          answerTokens: 5,
          answerChars: 10,
        }),
      },
    );

    const finishedLine = log.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.includes("↑") && line.includes("↓") && line.includes("Δ"));
    expect(finishedLine).toBeDefined();
    expect(finishedLine).toContain("[browser]");
    expect(finishedLine).not.toContain("tok(");
    expect(finishedLine).not.toContain("tokens (");
  });

  test("non-verbose output keeps short token label", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 10,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async () => ({
          answerText: "text",
          answerMarkdown: "markdown",
          tookMs: 100,
          answerTokens: 5,
          answerChars: 10,
        }),
      },
    );

    const finishedLine = log.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.includes("↑") && line.includes("↓") && line.includes("Δ"));
    expect(finishedLine).toBeDefined();
    expect(finishedLine).toContain("[browser]");
    expect(finishedLine).not.toContain("tok(");
    expect(finishedLine).not.toContain("tokens (");
  });

  test("passes heartbeat interval through to browser runner", async () => {
    const log = vi.fn();
    const executeBrowser = vi.fn(async () => ({
      answerText: "text",
      answerMarkdown: "markdown",
      tookMs: 10,
      answerTokens: 1,
      answerChars: 5,
    }));
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, heartbeatIntervalMs: 15_000 },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser,
      },
    );
    expect(executeBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ heartbeatIntervalMs: 15_000 }),
    );
  });

  test("allows Gemini in browser mode with custom executor", async () => {
    const log = vi.fn();
    const executeBrowser = vi.fn().mockResolvedValue({
      answerText: "gemini response",
      answerMarkdown: "gemini response",
      tookMs: 100,
      answerTokens: 5,
      answerChars: 15,
    });
    const result = await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, model: "gemini-3-pro" },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 1,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser,
      },
    );
    expect(result.answerText).toBe("gemini response");
    expect(executeBrowser).toHaveBeenCalled();
  });
});

describe("continueBrowserSessionExecution", () => {
  test("continues a stored browser session with inline prompt text", async () => {
    const log = vi.fn();
    const parentSession: SessionMetadata = {
      id: "parent",
      createdAt: "2025-01-01T00:00:00Z",
      status: "completed",
      mode: "browser",
      options: {},
      response: {
        status: "completed",
        assistantOutput: "PREVIOUS_ORACLE_RESULT",
      },
      browser: {
        config: {},
        runtime: { chromePort: 9222, chromeHost: "127.0.0.1", tabUrl: "https://chatgpt.com/c/abc" },
      },
    };
    const continueBrowser = vi.fn(async () => ({
      answerText: "continued",
      answerMarkdown: "continued",
      tookMs: 321,
      answerTokens: 9,
      runtime: { chromePort: 9222, chromeHost: "127.0.0.1", tabUrl: "https://chatgpt.com/c/abc" },
    }));
    const persistRuntimeHint = vi.fn();

    const result = await continueBrowserSessionExecution(
      {
        runOptions: baseRunOptions,
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
        parentSession,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 42,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "never",
          attachmentMode: "inline",
          fallback: null,
        }),
        continueBrowser,
        persistRuntimeHint,
      },
    );

    expect(continueBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ chromePort: 9222 }),
      baseConfig,
      expect.any(Function),
      expect.objectContaining({ prompt: "prompt", attachments: [] }),
      expect.objectContaining({
        baselineAssistant: {
          text: "PREVIOUS_ORACLE_RESULT",
        },
      }),
    );
    expect(persistRuntimeHint).toHaveBeenCalled();
    expect(result).toMatchObject({
      usage: { inputTokens: 42, outputTokens: 9, totalTokens: 51 },
      elapsedMs: 321,
      answerText: "continued",
    });
  });

  test("threads downloadsDir into browser follow-ups and returns downloads", async () => {
    const log = vi.fn();
    const parentSession: SessionMetadata = {
      id: "parent",
      createdAt: "2025-01-01T00:00:00Z",
      status: "completed",
      mode: "browser",
      options: {},
      response: {
        status: "completed",
        assistantOutput: "PREVIOUS_ORACLE_RESULT",
      },
      browser: {
        config: {},
        runtime: { chromePort: 9222, chromeHost: "127.0.0.1", tabUrl: "https://chatgpt.com/c/abc" },
      },
    };
    const continueBrowser = vi.fn(async () => ({
      answerText: "continued",
      answerMarkdown: "continued",
      tookMs: 321,
      answerTokens: 9,
      downloads: [
        {
          path: "/tmp/.oracle/sessions/sess-1/downloads/proof.txt",
          suggestedFilename: "proof.txt",
          sizeBytes: 12,
        },
      ],
      runtime: { chromePort: 9222, chromeHost: "127.0.0.1", tabUrl: "https://chatgpt.com/c/abc" },
    }));

    const result = await continueBrowserSessionExecution(
      {
        runOptions: baseRunOptions,
        browserConfig: baseConfig,
        downloadsDir: "/tmp/.oracle/sessions/sess-1/downloads",
        cwd: "/repo",
        log,
        parentSession,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 42,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "never",
          attachmentMode: "inline",
          fallback: null,
        }),
        continueBrowser,
      },
    );

    expect(continueBrowser).toHaveBeenCalledWith(
      expect.anything(),
      baseConfig,
      expect.any(Function),
      expect.objectContaining({
        downloadsDir: "/tmp/.oracle/sessions/sess-1/downloads",
      }),
      expect.objectContaining({
        downloadsDir: "/tmp/.oracle/sessions/sess-1/downloads",
      }),
    );
    expect(result.downloads).toEqual([
      {
        path: "/tmp/.oracle/sessions/sess-1/downloads/proof.txt",
        suggestedFilename: "proof.txt",
        sizeBytes: 12,
      },
    ]);
  });

  test("persists follow-up progress and writes milestone logs even when not verbose", async () => {
    const log = vi.fn();
    const sessionLog = vi.fn();
    const persistProgress = vi.fn();
    const parentSession: SessionMetadata = {
      id: "parent",
      createdAt: "2025-01-01T00:00:00Z",
      status: "completed",
      mode: "browser",
      options: {},
      response: { status: "completed", assistantOutput: "prior answer" },
      browser: {
        config: {},
        runtime: { chromePort: 9222, chromeHost: "127.0.0.1", tabUrl: "https://chatgpt.com/c/abc" },
      },
    };
    const continueBrowser = vi.fn(async (_runtime, _config, browserLog) => {
      await reportBrowserProgress(browserLog, {
        stage: "thread-bound",
        message: "Bound to existing ChatGPT conversation abc.",
        runtime: {
          chromeTargetId: "target-1",
          tabUrl: "https://chatgpt.com/c/abc",
          conversationId: "abc",
        },
      });
      return {
        answerText: "continued",
        answerMarkdown: "continued",
        tookMs: 321,
        answerTokens: 9,
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          chromeTargetId: "target-1",
          tabUrl: "https://chatgpt.com/c/abc",
          conversationId: "abc",
        },
      };
    });

    await continueBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
        sessionLog,
        persistProgress,
        parentSession,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 42,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "never",
          attachmentMode: "inline",
          fallback: null,
        }),
        continueBrowser,
      },
    );

    expect(persistProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "thread-bound",
        message: "Bound to existing ChatGPT conversation abc.",
      }),
    );
    expect(sessionLog).toHaveBeenCalledWith(
      "[browser-progress:thread-bound] Bound to existing ChatGPT conversation abc.",
    );
    expect(log.mock.calls.some((call) => String(call[0]).includes("thread-bound"))).toBe(false);
  });

  test("passes follow-up attachments and fallback submission through", async () => {
    const log = vi.fn();
    const parentSession: SessionMetadata = {
      id: "parent",
      createdAt: "2025-01-01T00:00:00Z",
      status: "completed",
      mode: "browser",
      options: {},
      browser: {
        config: {},
        runtime: { chromePort: 9222, chromeHost: "127.0.0.1", tabUrl: "https://chatgpt.com/c/abc" },
      },
    };
    const continueBrowser = vi.fn(async () => ({
      answerText: "continued",
      answerMarkdown: "continued",
      tookMs: 321,
      answerTokens: 9,
      runtime: { chromePort: 9222, chromeHost: "127.0.0.1", tabUrl: "https://chatgpt.com/c/abc" },
    }));

    await continueBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: true },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
        parentSession,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 42,
          attachments: [{ path: "/repo/context.zip", displayPath: "context.zip", sizeBytes: 4 }],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "always",
          attachmentMode: "upload",
          fallback: {
            composerText: "fallback prompt",
            attachments: [
              { path: "/repo/fallback.zip", displayPath: "fallback.zip", sizeBytes: 4 },
            ],
            bundled: null,
          },
        }),
        continueBrowser,
      },
    );

    expect(continueBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ chromePort: 9222 }),
      baseConfig,
      expect.any(Function),
      {
        prompt: "prompt",
        attachments: [expect.objectContaining({ displayPath: "context.zip" })],
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [expect.objectContaining({ displayPath: "fallback.zip" })],
        },
      },
      expect.any(Object),
    );
  });

  test("merges inherited browser runtime when a follow-up returns only partial runtime metadata", async () => {
    const log = vi.fn();
    const parentSession: SessionMetadata = {
      id: "parent",
      createdAt: "2025-01-01T00:00:00Z",
      status: "completed",
      mode: "browser",
      options: {},
      browser: {
        config: {},
        runtime: {
          browserTransport: "cdp",
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/original",
          chromeTargetId: "target-parent",
          tabUrl: "https://chatgpt.com/g/g-p-example/project/c/demo",
          conversationId: "demo",
          controllerPid: 111,
        },
      },
    };
    const continueBrowser = vi.fn(async () => ({
      answerText: "continued",
      answerMarkdown: "continued",
      tookMs: 321,
      answerTokens: 9,
      runtime: {
        chromePort: 9222,
        chromeHost: "127.0.0.1",
        tabUrl: "https://chatgpt.com/g/g-p-example/project/c/demo",
      },
    }));
    const persistRuntimeHint = vi.fn();

    const result = await continueBrowserSessionExecution(
      {
        runOptions: baseRunOptions,
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
        parentSession,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 42,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "never",
          attachmentMode: "inline",
          fallback: null,
        }),
        continueBrowser,
        persistRuntimeHint,
      },
    );

    expect(persistRuntimeHint).toHaveBeenCalledWith(
      expect.objectContaining({
        chromeTargetId: "target-parent",
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/original",
        conversationId: "demo",
      }),
    );
    expect(result.runtime).toMatchObject({
      chromeTargetId: "target-parent",
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/original",
      conversationId: "demo",
    });
  });

  test("clears stale conversation id when follow-up runtime moves to a non-conversation URL", async () => {
    const log = vi.fn();
    const parentSession: SessionMetadata = {
      id: "parent",
      createdAt: "2025-01-01T00:00:00Z",
      status: "completed",
      mode: "browser",
      options: {},
      browser: {
        config: {},
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/abc",
          conversationId: "abc",
        },
      },
    };

    const result = await continueBrowserSessionExecution(
      {
        runOptions: baseRunOptions,
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
        parentSession,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 10,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "never",
          attachmentMode: "inline",
          fallback: null,
        }),
        continueBrowser: vi.fn(async () => ({
          answerText: "continued",
          answerMarkdown: "continued",
          tookMs: 10,
          answerTokens: 2,
          runtime: {
            chromePort: 9222,
            chromeHost: "127.0.0.1",
            tabUrl: "https://chatgpt.com/g/g-p-example-oracle/project",
          },
        })),
      },
    );

    expect(result.runtime.tabUrl).toBe("https://chatgpt.com/g/g-p-example-oracle/project");
    expect(result.runtime.conversationId).toBeUndefined();
  });

  test("wraps generic followup failures as BrowserAutomationError", async () => {
    const parentSession: SessionMetadata = {
      id: "parent",
      createdAt: "2025-01-01T00:00:00Z",
      status: "completed",
      mode: "browser",
      options: {},
      browser: {
        config: {},
        runtime: { chromePort: 9222, chromeHost: "127.0.0.1", tabUrl: "https://chatgpt.com/c/abc" },
      },
    };

    await expect(
      continueBrowserSessionExecution(
        {
          runOptions: baseRunOptions,
          browserConfig: baseConfig,
          cwd: "/repo",
          log: vi.fn(),
          parentSession,
        },
        {
          assemblePrompt: async () => ({
            markdown: "prompt",
            composerText: "prompt",
            estimatedInputTokens: 42,
            attachments: [],
            inlineFileCount: 0,
            tokenEstimateIncludesInlineFiles: false,
            attachmentsPolicy: "never",
            attachmentMode: "inline",
            fallback: null,
          }),
          continueBrowser: async () => {
            throw new Error("chrome disappeared");
          },
        },
      ),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      message: "chrome disappeared",
      details: {
        stage: "continue-browser",
        runtime: expect.objectContaining({ chromePort: 9222, tabUrl: "https://chatgpt.com/c/abc" }),
      },
    } satisfies Partial<BrowserAutomationError>);
  });
});
