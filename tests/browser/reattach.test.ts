import { describe, expect, test, vi } from "vitest";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import {
  continueBrowserSession,
  resumeBrowserSession,
  __test__,
} from "../../src/browser/reattach.js";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";

type FakeTarget = { targetId?: string; type?: string; url?: string };
type FakeClient = {
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Runtime: {
    enable: () => void;
    evaluate: (params: {
      expression: string;
      returnByValue?: boolean;
    }) => Promise<{ result: { value: unknown } }>;
  };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  DOM: { enable: () => void };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Input: Record<string, never>;
  close: () => Promise<void> | void;
};

describe("resumeBrowserSession", () => {
  test("selects target and captures markdown via stubs", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "Hello PATH plan",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "markdown response");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
    });

    expect(result.answerMarkdown).toBe("markdown response");
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 51559, target: "target-1" }),
    );
    expect(waitForAssistantResponse).toHaveBeenCalled();
    expect(captureAssistantMarkdown).toHaveBeenCalled();
  });

  test("falls back to recovery when chrome port is missing", async () => {
    const runtime = {
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, { recoverSession });

    expect(result.answerMarkdown).toBe("fallback-md");
    expect(recoverSession).toHaveBeenCalled();
  });

  test("tries live reattach from browser websocket metadata before falling back", async () => {
    const runtime = {
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeProfileRoot: "/tmp/oracle-attach-running-profile",
      tabUrl: "https://chatgpt.com/c/abc",
      chromeTargetId: "target-2",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-2", type: "page", url: "https://chatgpt.com/c/abc" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connectMock = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    );
    const connect = connectMock as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "attached-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(
      runtime,
      { attachRunning: true, timeoutMs: 2_000 },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(result.answerMarkdown).toBe("attached-md");
    expect(listTargets).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "ws://127.0.0.1:9222/devtools/browser/abc",
        local: true,
      }),
    );
  });

  test("falls back to the default devtools target when websocket metadata has no matched tab", async () => {
    const runtime = {
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const listTargets = vi.fn(async () => [] satisfies FakeTarget[]) as unknown as () => Promise<
      FakeTarget[]
    >;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connectMock = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    );
    const connect = connectMock as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "attached-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(
      runtime,
      { attachRunning: true, timeoutMs: 2_000 },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(result.answerMarkdown).toBe("attached-md");
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 9222,
      }),
    );
    expect(connect).not.toHaveBeenCalledWith(
      expect.objectContaining({
        target: "ws://127.0.0.1:9222/devtools/browser/abc",
        local: true,
      }),
    );
  });

  test("continues a browser follow-up through browser websocket metadata", async () => {
    const runtime = {
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeProfileRoot: "/tmp/oracle-attach-running-profile",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
      chromeTargetId: "target-2",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-2", type: "page", url: "https://chatgpt.com/c/abc" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "supervisor response",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const logger = vi.fn() as BrowserLogger;

    const result = await continueBrowserSession(
      runtime,
      { attachRunning: true, timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(result.answerMarkdown).toBe("supervisor markdown");
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "ws://127.0.0.1:9222/devtools/browser/abc",
        local: true,
      }),
    );
    expect(submitPrompt).toHaveBeenCalledTimes(1);
  });

  test("falls back to recovery when existing chrome attach fails", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
    };
    const listTargets = vi.fn(async () => {
      throw new Error("no targets");
    }) as unknown as () => Promise<FakeTarget[]>;
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, { listTargets, recoverSession });

    expect(result.answerText).toBe("fallback");
    expect(recoverSession).toHaveBeenCalled();
  });

  test("continues an existing chrome conversation with a new prompt", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "supervisor response",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(ensurePromptReady).toHaveBeenCalled();
    expect(clearPromptComposer).toHaveBeenCalled();
    expect(submitPrompt).toHaveBeenCalled();
    expect(waitForAssistantResponse).toHaveBeenCalled();
    expect(result.answerMarkdown).toBe("supervisor markdown");
    expect(result.runtime?.conversationId).toBe("abc");
  });

  test("guards an existing hidden chrome follow-up before reconnecting and sending", async () => {
    vi.resetModules();
    const frontmostTarget = { name: "Zed", pid: 77 };
    const captureFrontmostProcess = vi.fn(async () => frontmostTarget);
    const hideChromeWindow = vi.fn(async () => {});
    const startChromeFocusGuard = vi.fn(() => vi.fn());
    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return {
        ...original,
        captureFrontmostProcess,
        hideChromeWindow,
        startChromeFocusGuard,
      };
    });

    const { continueBrowserSession: guardedContinueBrowserSession } =
      await import("../../src/browser/reattach.js");
    const runtime = {
      chromePid: 4242,
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
    };
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connectMock = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    );
    const connect = connectMock as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "supervisor response",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const logger = vi.fn() as BrowserLogger;

    const result = await guardedContinueBrowserSession(
      runtime,
      { hideWindow: true, timeoutMs: 2_000, inputTimeoutMs: 1_000, modelStrategy: "ignore" },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(result.answerMarkdown).toBe("supervisor markdown");
    expect(captureFrontmostProcess).toHaveBeenCalledWith(logger);
    expect(hideChromeWindow).toHaveBeenCalledTimes(2);
    expect(hideChromeWindow).toHaveBeenNthCalledWith(1, { pid: 4242 }, logger, frontmostTarget);
    expect(hideChromeWindow).toHaveBeenNthCalledWith(2, { pid: 4242 }, logger);
    expect(startChromeFocusGuard).toHaveBeenCalledWith({ pid: 4242 }, logger, frontmostTarget);
    expect(hideChromeWindow.mock.invocationCallOrder[0]).toBeLessThan(
      connectMock.mock.invocationCallOrder[0],
    );
  });

  test("recovers a follow-up answer after a transient thinking scaffold", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        chromePort: 51559,
        chromeHost: "127.0.0.1",
        chromeTargetId: "target-1",
        tabUrl: "https://chatgpt.com/c/abc",
        conversationId: "abc",
      };
      const listTargets = vi.fn(
        async () =>
          [
            { targetId: "target-1", type: "page", url: runtime.tabUrl },
            { targetId: "target-2", type: "page", url: "about:blank" },
          ] satisfies FakeTarget[],
      ) as unknown as () => Promise<FakeTarget[]>;
      let snapshotCalls = 0;
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "location.href") {
          return { result: { value: runtime.tabUrl } };
        }
        if (expression === "1+1") {
          return { result: { value: 2 } };
        }
        if (expression.includes("extractAssistantTurn")) {
          snapshotCalls += 1;
          if (snapshotCalls < 3) {
            return {
              result: {
                value: {
                  text: "Thinking",
                  html: '<div data-message-model-slug="gpt-5-4-thinking"><div class="result-thinking markdown"><p></p></div></div>',
                  messageId: "m-thinking",
                  turnId: "conversation-turn-2",
                },
              },
            };
          }
          return {
            result: {
              value: {
                text: "ORACLE-E2E-20260401-A",
                html: "<p>ORACLE-E2E-20260401-A</p>",
                messageId: "m-final",
                turnId: "conversation-turn-2",
              },
            },
          };
        }
        return { result: { value: null } };
      });
      const connect = vi.fn(
        async () =>
          ({
            Runtime: { enable: vi.fn(), evaluate },
            DOM: { enable: vi.fn() },
            Input: {},
            close: vi.fn(async () => {}),
          }) satisfies FakeClient,
      ) as unknown as (options?: unknown) => Promise<ChromeClient>;
      const ensurePromptReady = vi.fn(async () => {});
      const clearPromptComposer = vi.fn(async () => {});
      const submitPrompt = vi.fn(async () => 3);
      const waitForAssistantResponse = vi.fn(async () => ({
        text: "Thinking",
        html: "",
        meta: { messageId: "m-thinking", turnId: "conversation-turn-2" },
      }));
      const captureAssistantMarkdown = vi
        .fn()
        .mockResolvedValueOnce("Thinking")
        .mockResolvedValueOnce("ORACLE-E2E-20260401-A");
      const logger = vi.fn() as BrowserLogger;

      const promise = continueBrowserSession(
        runtime,
        { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
        logger,
        { prompt: "Follow up on the implementation." },
        {
          listTargets,
          connect,
          ensurePromptReady,
          clearPromptComposer,
          submitPrompt,
          waitForAssistantResponse,
          captureAssistantMarkdown,
        },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await promise;

      expect(result.answerText).toBe("ORACLE-E2E-20260401-A");
      expect(result.answerMarkdown).toBe("ORACLE-E2E-20260401-A");
      expect(captureAssistantMarkdown).toHaveBeenCalledTimes(2);
      expect(logger).toHaveBeenCalledWith(
        "Recovered follow-up assistant response after transient thinking scaffold",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("refreshes a partial follow-up answer when later snapshot expands to the full control payload", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        chromePort: 51559,
        chromeHost: "127.0.0.1",
        chromeTargetId: "target-1",
        tabUrl: "https://chatgpt.com/c/abc",
        conversationId: "abc",
      };
      const listTargets = vi.fn(
        async () =>
          [
            { targetId: "target-1", type: "page", url: runtime.tabUrl },
            { targetId: "target-2", type: "page", url: "about:blank" },
          ] satisfies FakeTarget[],
      ) as unknown as () => Promise<FakeTarget[]>;
      const partialAnswer =
        "I’m sending a minimal orchestrator round-trip now: a simple 2+2 task with an explicit return, and I’ll only confirm success once the result comes back here.";
      const fullAnswer = `${partialAnswer}

Starting the minimal loop test now. I am not treating it as proven until the orchestrator returns a result from the delegated task.

\`\`\`oracle_control
{"op":"handoff","message":"Run a minimal orchestrator round-trip test.","message_for_user":"Starting a minimal orchestrator round-trip test now.","workflow_version":0,"status":"in_progress"}
\`\`\``;
      let snapshotCalls = 0;
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression === "location.href") {
          return { result: { value: runtime.tabUrl } };
        }
        if (expression === "1+1") {
          return { result: { value: 2 } };
        }
        if (expression.includes("extractAssistantTurn")) {
          snapshotCalls += 1;
          return {
            result: {
              value:
                snapshotCalls < 3
                  ? {
                      text: partialAnswer,
                      html: `<p>${partialAnswer}</p>`,
                      messageId: "m-partial",
                      turnId: "conversation-turn-2",
                    }
                  : {
                      text: fullAnswer,
                      html: "<div>expanded</div>",
                      messageId: "m-final",
                      turnId: "conversation-turn-2",
                    },
            },
          };
        }
        if (expression.includes("document.querySelectorAll(")) {
          return { result: { value: 3 } };
        }
        return { result: { value: null } };
      });
      const connect = vi.fn(
        async () =>
          ({
            Runtime: { enable: vi.fn(), evaluate },
            DOM: { enable: vi.fn() },
            Input: {},
            close: vi.fn(async () => {}),
          }) satisfies FakeClient,
      ) as unknown as (options?: unknown) => Promise<ChromeClient>;
      const ensurePromptReady = vi.fn(async () => {});
      const clearPromptComposer = vi.fn(async () => {});
      const submitPrompt = vi.fn(async () => 3);
      const waitForAssistantResponse = vi.fn(async () => ({
        text: partialAnswer,
        html: `<p>${partialAnswer}</p>`,
        meta: { messageId: "m-partial", turnId: "conversation-turn-2" },
      }));
      const captureAssistantMarkdown = vi
        .fn()
        .mockResolvedValueOnce(partialAnswer)
        .mockResolvedValueOnce(fullAnswer);
      const logger = vi.fn() as BrowserLogger;

      const promise = continueBrowserSession(
        runtime,
        { timeoutMs: 3_000, inputTimeoutMs: 1_000 },
        logger,
        { prompt: "Follow up on the implementation." },
        {
          listTargets,
          connect,
          ensurePromptReady,
          clearPromptComposer,
          submitPrompt,
          waitForAssistantResponse,
          captureAssistantMarkdown,
        },
      );
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await promise;

      expect(result.answerText).toBe(fullAnswer);
      expect(result.answerMarkdown).toBe(fullAnswer);
      expect(captureAssistantMarkdown).toHaveBeenCalledTimes(2);
      expect(captureAssistantMarkdown).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        { messageId: "m-partial", turnId: "conversation-turn-2" },
        logger,
        2,
      );
      expect(captureAssistantMarkdown).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        { messageId: "m-final", turnId: "conversation-turn-2" },
        logger,
        2,
      );
      expect(logger).toHaveBeenCalledWith("Recovered expanded assistant response during reattach");
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  test("applies model selection and thinking time before follow-up submission", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
    };
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const ensureModelSelection = vi.fn(async () => {});
    const ensureThinkingTime = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "supervisor response",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    await continueBrowserSession(
      runtime,
      {
        timeoutMs: 2_000,
        inputTimeoutMs: 1_000,
        desiredModel: "GPT-5.4 Pro",
        modelStrategy: "select",
        thinkingTime: "extended",
      },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        ensureModelSelection,
        ensureThinkingTime,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(ensureModelSelection).toHaveBeenCalledWith(
      expect.anything(),
      "GPT-5.4 Pro",
      logger,
      "select",
    );
    expect(ensureThinkingTime).toHaveBeenCalledWith(expect.anything(), "extended", logger);
  });

  test("resumes without resending when capture fails after follow-up submission", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
    };
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce({
        text: "supervisor response",
        html: "",
        meta: { messageId: "m2", turnId: "conversation-turn-2" },
      });
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const recoverSession = vi.fn(async () => {
      throw new Error("should not recover by resending");
    });
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        recoverSession,
      },
    );

    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(waitForAssistantResponse).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(recoverSession).not.toHaveBeenCalled();
    expect(result.answerMarkdown).toBe("supervisor markdown");
  });

  test("resumes without resending when attachment verification fails after send", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
    };
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const clearComposerAttachments = vi.fn(async () => {});
    const uploadAttachmentFile = vi.fn(async () => true);
    const waitForAttachmentCompletion = vi.fn(async () => {});
    const waitForUserTurnAttachments = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "supervisor response",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const recoverSession = vi.fn(async () => {
      throw new Error("should not recover by resending");
    });
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      {
        prompt: "Review these files.",
        attachments: [{ path: "/tmp/context.zip", displayPath: "context.zip", sizeBytes: 4 }],
      },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        clearComposerAttachments,
        uploadAttachmentFile,
        waitForAttachmentCompletion,
        waitForUserTurnAttachments,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        recoverSession,
      },
    );

    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(waitForUserTurnAttachments).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(recoverSession).not.toHaveBeenCalled();
    expect(result.answerMarkdown).toBe("supervisor markdown");
  });

  test("uploads attachments during follow-up prompts", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const clearComposerAttachments = vi.fn(async () => {});
    const uploadAttachmentFile = vi.fn(async () => true);
    const waitForAttachmentCompletion = vi.fn(async () => {});
    const waitForUserTurnAttachments = vi.fn(async () => true);
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "supervisor response",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      {
        prompt: "Review these files.",
        attachments: [{ path: "/tmp/context.zip", displayPath: "context.zip", sizeBytes: 4 }],
      },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        clearComposerAttachments,
        uploadAttachmentFile,
        waitForAttachmentCompletion,
        waitForUserTurnAttachments,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(clearComposerAttachments).toHaveBeenCalled();
    expect(uploadAttachmentFile).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ displayPath: "context.zip" }),
      logger,
      { expectedCount: 1 },
    );
    expect(waitForAttachmentCompletion).toHaveBeenCalled();
    expect(waitForUserTurnAttachments).toHaveBeenCalledWith(
      expect.anything(),
      ["context.zip"],
      20_000,
      logger,
    );
    expect(submitPrompt).toHaveBeenCalled();
    expect(result.answerMarkdown).toBe("supervisor markdown");
  });

  test("retries follow-up with uploaded attachments when inline prompt is too large", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
    };
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const clearComposerAttachments = vi.fn(async () => {});
    const uploadAttachmentFile = vi.fn(async () => true);
    const waitForAttachmentCompletion = vi.fn(async () => {});
    const waitForUserTurnAttachments = vi.fn(async () => true);
    const submitPrompt = vi
      .fn()
      .mockRejectedValueOnce(
        new BrowserAutomationError("too large", { code: "prompt-too-large", stage: "submit" }),
      )
      .mockResolvedValueOnce(3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "retry response",
      html: "",
      meta: { messageId: "m3", turnId: "conversation-turn-3" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "retry markdown");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      {
        prompt: "Huge inline context",
        fallbackSubmission: {
          prompt: "Fallback with uploads",
          attachments: [{ path: "/tmp/fallback.zip", displayPath: "fallback.zip", sizeBytes: 4 }],
        },
      },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        clearComposerAttachments,
        uploadAttachmentFile,
        waitForAttachmentCompletion,
        waitForUserTurnAttachments,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(submitPrompt).toHaveBeenCalledTimes(2);
    expect(uploadAttachmentFile).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ displayPath: "fallback.zip" }),
      logger,
      { expectedCount: 1 },
    );
    const loggerCalls = (logger as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(loggerCalls.some((call) => String(call[0]).includes("retrying with file uploads"))).toBe(
      true,
    );
    expect(result.answerMarkdown).toBe("retry markdown");
  });

  test("uses the fallback prompt preview for reconnect alignment after a prompt-too-large retry", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
    };
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const clearComposerAttachments = vi.fn(async () => {});
    const uploadAttachmentFile = vi.fn(async () => true);
    const waitForAttachmentCompletion = vi.fn(async () => {});
    const waitForUserTurnAttachments = vi.fn(async () => true);
    const submitPrompt = vi
      .fn()
      .mockRejectedValueOnce(
        new BrowserAutomationError("too large", { code: "prompt-too-large", stage: "submit" }),
      )
      .mockResolvedValueOnce(3);
    const waitForAssistantResponse = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce({
        text: "Fallback with uploads",
        html: "",
        meta: { messageId: "m4", turnId: "conversation-turn-4" },
      });
    const captureAssistantMarkdown = vi.fn(async () => "final markdown");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      {
        prompt: "Huge inline context that will not fit",
        fallbackSubmission: {
          prompt: "Fallback with uploads",
          attachments: [{ path: "/tmp/fallback.zip", displayPath: "fallback.zip", sizeBytes: 4 }],
        },
      },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        clearComposerAttachments,
        uploadAttachmentFile,
        waitForAttachmentCompletion,
        waitForUserTurnAttachments,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    const loggerCalls = (logger as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(
      loggerCalls.some((call) =>
        String(call[0]).includes("Aligned prompt-echo text to copied markdown during reattach"),
      ),
    ).toBe(true);
  });
});

describe("reattach helpers", () => {
  const {
    pickTarget,
    extractConversationIdFromUrl,
    buildConversationUrl,
    mergeRuntimeMetadata,
    openConversationFromSidebar,
  } = __test__;
  type EvaluateParams = { expression: string };
  type EvaluateResult<T> = { result: { value: T } };

  test("extracts conversation id from a chat URL", () => {
    expect(extractConversationIdFromUrl("https://chatgpt.com/c/abc-123")).toBe("abc-123");
    expect(extractConversationIdFromUrl("")).toBeUndefined();
  });

  test("builds conversation URL from tabUrl or conversationId", () => {
    expect(
      buildConversationUrl(
        { tabUrl: "https://chatgpt.com/c/live", conversationId: "ignored" },
        "https://chatgpt.com/",
      ),
    ).toBe("https://chatgpt.com/c/live");
    expect(buildConversationUrl({ conversationId: "abc" }, "https://chatgpt.com/")).toBe(
      "https://chatgpt.com/c/abc",
    );
  });

  test("mergeRuntimeMetadata refreshes runtime hints after relaunch", () => {
    expect(
      mergeRuntimeMetadata(
        {
          chromePid: 11,
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          userDataDir: "/tmp/old",
          tabUrl: "https://chatgpt.com/c/old",
        },
        {
          chromePid: 22,
          chromePort: 9333,
          userDataDir: "/tmp/new",
          tabUrl: "https://chatgpt.com/c/new",
          controllerPid: 44,
        },
      ),
    ).toMatchObject({
      chromePid: 22,
      chromePort: 9333,
      userDataDir: "/tmp/new",
      conversationId: "new",
      controllerPid: 44,
    });
  });

  test("pickTarget prefers chromeTargetId, then tabUrl, then first page", () => {
    const targets = [
      { targetId: "t-1", type: "page", url: "https://chatgpt.com/c/first" },
      { targetId: "t-2", type: "page", url: "https://chatgpt.com/c/second" },
      { targetId: "t-3", type: "page", url: "about:blank" },
    ];
    expect(pickTarget(targets, { chromeTargetId: "t-2" })).toEqual(targets[1]);
    expect(pickTarget(targets, { tabUrl: "https://chatgpt.com/c/first" })).toEqual(targets[0]);
    expect(pickTarget(targets, {})).toEqual(targets[0]);
  });

  test("openConversationFromSidebar passes conversationId and projects preference", async () => {
    const evaluate = vi.fn<
      (
        params: EvaluateParams,
      ) => Promise<EvaluateResult<{ ok: boolean; href?: string; count: number }>>
    >(async () => ({
      result: { value: { ok: true, href: "https://chatgpt.com/c/abc", count: 3 } },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const ok = await openConversationFromSidebar(runtime, {
      conversationId: "abc",
      preferProjects: true,
    });

    expect(ok).toBe(true);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain('const conversationId = "abc"');
    expect(call?.expression).toContain("const preferProjects = true");
  });

  test("openConversationFromSidebar handles missing conversationId", async () => {
    const evaluate = vi.fn<
      (params: EvaluateParams) => Promise<EvaluateResult<{ ok: boolean; count: number }>>
    >(async () => ({
      result: { value: { ok: false, count: 0 } },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const ok = await openConversationFromSidebar(runtime, { preferProjects: false });

    expect(ok).toBe(false);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain("const conversationId = null");
    expect(call?.expression).toContain("const preferProjects = false");
  });
});
