import { describe, expect, test } from "vitest";
import type { SessionModelRun } from "../../src/sessionStore.js";
import { consultInputSchema } from "../../src/mcp/types.ts";
import {
  buildConsultBrowserConfig,
  summarizeModelRunsForConsult,
} from "../../src/mcp/tools/consult.ts";

describe("summarizeModelRunsForConsult", () => {
  test("maps per-model metadata into consult summaries", () => {
    const runs: SessionModelRun[] = [
      {
        model: "gpt-5.2-pro",
        status: "completed",
        startedAt: "2025-11-19T00:00:00Z",
        completedAt: "2025-11-19T00:00:30Z",
        usage: { inputTokens: 1000, outputTokens: 200, reasoningTokens: 0, totalTokens: 1200 },
        response: { id: "resp_123", requestId: "req_456", status: "completed" },
        log: { path: "models/gpt-5.2-pro.log" },
      },
    ];
    const result = summarizeModelRunsForConsult(runs);
    expect(result).toEqual([
      expect.objectContaining({
        model: "gpt-5.2-pro",
        status: "completed",
        usage: expect.objectContaining({ totalTokens: 1200 }),
        response: expect.objectContaining({ id: "resp_123" }),
        logPath: "models/gpt-5.2-pro.log",
      }),
    ]);
  });

  test("returns undefined for empty lists", () => {
    expect(summarizeModelRunsForConsult([])).toBeUndefined();
    expect(summarizeModelRunsForConsult(undefined)).toBeUndefined();
  });

  test("merges browser defaults from config for consult runs", () => {
    const config = buildConsultBrowserConfig({
      userConfig: {
        browser: {
          chatgptUrl: "https://chatgpt.com/g/g-p-foo/project",
          debugPort: 9224,
          keepBrowser: true,
          manualLogin: true,
          manualLoginProfileDir: "/tmp/oracle-profile",
          thinkingTime: "extended",
        },
      },
      env: {},
      runModel: "gpt-5.1",
      inputModel: "gpt-5.1",
    });

    expect(config).toMatchObject({
      chatgptUrl: "https://chatgpt.com/g/g-p-foo/project",
      url: "https://chatgpt.com/g/g-p-foo/project",
      debugPort: 9224,
      keepBrowser: true,
      manualLogin: true,
      manualLoginProfileDir: "/tmp/oracle-profile",
      thinkingTime: "extended",
      desiredModel: "GPT-5.2",
      cookieSync: false,
    });
  });

  test("applies the managed local Chrome defaults for bare consult browser runs on macOS", () => {
    const config = buildConsultBrowserConfig({
      userConfig: {},
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
    });

    const expectsManagedChrome = process.platform === "darwin";
    expect(config.manualLogin).toBe(expectsManagedChrome ? true : undefined);
    expect(config.hideWindow).toBe(expectsManagedChrome ? true : undefined);
    expect(config.keepBrowser).toBe(expectsManagedChrome ? true : undefined);
  });

  test("does not apply managed local Chrome defaults to remote Chrome consult runs", () => {
    const config = buildConsultBrowserConfig({
      userConfig: {
        browser: {
          remoteChrome: {
            host: "10.0.0.8",
            port: 9222,
          },
        },
      },
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
    });

    expect(config.manualLogin).toBeUndefined();
    expect(config.hideWindow).toBeUndefined();
    expect(config.keepBrowser).toBeUndefined();
  });

  test("lets explicit consult inputs override config defaults", () => {
    const config = buildConsultBrowserConfig({
      userConfig: {
        browser: {
          keepBrowser: false,
          manualLogin: false,
          manualLoginProfileDir: "/tmp/config-profile",
          thinkingTime: "light",
        },
      },
      env: {
        ORACLE_BROWSER_PROFILE_DIR: "/tmp/env-profile",
      },
      runModel: "claude-3.7-sonnet",
      inputModel: "claude-3.7-sonnet",
      browserModelLabel: "Claude Sonnet",
      browserKeepBrowser: true,
      browserThinkingTime: "heavy",
    });

    expect(config).toMatchObject({
      keepBrowser: true,
      manualLogin: true,
      manualLoginProfileDir: "/tmp/env-profile",
      thinkingTime: "heavy",
      desiredModel: "Claude Sonnet",
      cookieSync: false,
    });
  });

  test("respects manual-login cookie sync when configured", () => {
    const config = buildConsultBrowserConfig({
      userConfig: {
        browser: {
          manualLogin: true,
          manualLoginCookieSync: true,
          manualLoginProfileDir: "/tmp/oracle-profile",
        },
      },
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
    });

    expect(config).toMatchObject({
      manualLogin: true,
      manualLoginCookieSync: true,
      manualLoginProfileDir: "/tmp/oracle-profile",
      cookieSync: true,
    });
  });

  test("keeps canonical GPT browser targets when the input model is an alias", () => {
    const config = buildConsultBrowserConfig({
      userConfig: {},
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5-pro",
    });

    expect(config.desiredModel).toBe("GPT-5.4 Pro");
  });

  test("prefers an explicit GPT browser label override when provided", () => {
    const config = buildConsultBrowserConfig({
      userConfig: {},
      env: {},
      runModel: "gpt-5.4-pro",
      inputModel: "gpt-5.4-pro",
      browserModelLabel: "Pro",
    });

    expect(config.desiredModel).toBe("Pro");
  });

  test("passes through an explicit browser model strategy", () => {
    const config = buildConsultBrowserConfig({
      userConfig: {},
      env: {},
      runModel: "gpt-5.4",
      inputModel: "gpt-5.4",
      browserModelStrategy: "current",
    });

    expect(config.modelStrategy).toBe("current");
  });

  test("accepts browser model strategy through the public consult schema", () => {
    const parsed = consultInputSchema.parse({
      prompt: "hi",
      engine: "browser",
      browserModelStrategy: "ignore",
    });

    expect(parsed.browserModelStrategy).toBe("ignore");
  });

  test("rejects select-mode Pro targeting in Temporary Chat", () => {
    expect(() =>
      buildConsultBrowserConfig({
        userConfig: {
          browser: {
            chatgptUrl: "https://chatgpt.com/?temporary-chat=true",
          },
        },
        env: {},
        runModel: "gpt-5.4-pro",
        inputModel: "gpt-5.4-pro",
        browserModelStrategy: "select",
      }),
    ).toThrow(/Temporary Chat mode does not expose Pro models/);
  });
});
