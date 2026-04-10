import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ensureModelSelection,
  waitForAssistantResponse,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  navigateToChatGPT,
  navigateToPromptReadyWithFallback,
  ensurePromptReady,
  ensureNotBlocked,
  ensureLoggedIn,
  buildAssistantSnapshotExpressionForTest,
} from "../../src/browser/pageActions.js";
import * as attachments from "../../src/browser/actions/attachments.js";
import * as attachmentDataTransfer from "../../src/browser/actions/attachmentDataTransfer.js";
import type { ChromeClient } from "../../src/browser/types.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";

const logger = vi.fn();

beforeEach(() => {
  logger.mockClear();
});

describe("ensureModelSelection", () => {
  test("logs when model already selected", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { status: "already-selected", label: "GPT-5.2 Pro" } },
      }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureModelSelection(runtime, "GPT-5.2 Pro", logger)).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith("Model picker: GPT-5.2 Pro");
  });

  test("throws when option missing", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { status: "option-not-found" } } }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureModelSelection(runtime, "GPT-5 Pro", logger)).rejects.toThrow(
      /Unable to find model option matching/,
    );
  });

  test("includes temporary chat hint when Pro is unavailable", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            status: "option-not-found",
            hint: { temporaryChat: true, availableOptions: ["Auto", "Thinking"] },
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureModelSelection(runtime, "GPT-5.2 Pro", logger)).rejects.toThrow(
      /Temporary Chat/i,
    );
  });

  test("throws when button missing", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { status: "button-missing" } } }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureModelSelection(runtime, "Instant", logger)).rejects.toThrow(
      /Unable to locate the ChatGPT model selector button/,
    );
  });
});

describe("navigateToChatGPT", () => {
  test("navigates and waits for ready state", async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: "loading" } })
        .mockResolvedValueOnce({ result: { value: "complete" } }),
    } as unknown as ChromeClient["Runtime"];
    await navigateToChatGPT(
      { navigate } as unknown as ChromeClient["Page"],
      runtime,
      "https://chat.openai.com",
      logger,
    );
    expect(navigate).toHaveBeenCalledWith({ url: "https://chat.openai.com" });
    expect(runtime.evaluate).toHaveBeenCalledTimes(2);
  });
});

describe("navigateToPromptReadyWithFallback", () => {
  test("falls back to base URL when prompt is missing", async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    const ensureNotBlockedMock = vi.fn().mockResolvedValue(undefined);
    const ensurePromptReadyMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("Prompt textarea did not appear before timeout"))
      .mockResolvedValueOnce(undefined);
    const runtime = {} as unknown as ChromeClient["Runtime"];
    const page = {} as unknown as ChromeClient["Page"];

    await expect(
      navigateToPromptReadyWithFallback(
        page,
        runtime,
        {
          url: "https://chatgpt.com/g/missing/project",
          fallbackUrl: "https://chatgpt.com/",
          timeoutMs: 5_000,
          headless: false,
          logger,
        },
        {
          navigateToChatGPT: navigate,
          ensureNotBlocked: ensureNotBlockedMock,
          ensurePromptReady: ensurePromptReadyMock,
        },
      ),
    ).resolves.toEqual({ usedFallback: true });

    expect(navigate).toHaveBeenNthCalledWith(
      1,
      page,
      runtime,
      "https://chatgpt.com/g/missing/project",
      logger,
    );
    expect(navigate).toHaveBeenNthCalledWith(2, page, runtime, "https://chatgpt.com/", logger);
    expect(ensureNotBlockedMock).toHaveBeenCalledTimes(2);
    expect(ensurePromptReadyMock).toHaveBeenNthCalledWith(1, runtime, 5_000, logger);
    expect(ensurePromptReadyMock).toHaveBeenNthCalledWith(2, runtime, 120_000, logger);
  });
});

describe("ensurePromptReady", () => {
  test("resolves when input selector enabled", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: true } }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensurePromptReady(runtime, 1000, logger)).resolves.toBeUndefined();
    expect(logger).not.toHaveBeenCalled();
  });

  test("throws when timeout reached", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: false } }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensurePromptReady(runtime, 0, logger)).rejects.toThrow(/textarea did not appear/i);
  });
});

describe("ensureNotBlocked", () => {
  test("throws descriptive error when cloudflare detected", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: "Just a moment..." } }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureNotBlocked(runtime, true, logger)).rejects.toThrow(/headless mode/i);
    expect(logger).toHaveBeenCalledWith("Cloudflare anti-bot page detected");
  });

  test("passes through when title clean", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: "ChatGPT" } })
        .mockResolvedValueOnce({ result: { value: false } }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureNotBlocked(runtime, false, logger)).resolves.toBeUndefined();
  });

  test("throws structured browser error when headful cloudflare is detected", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: "Just a moment..." } }),
    } as unknown as ChromeClient["Runtime"];
    try {
      await ensureNotBlocked(runtime, false, logger);
      throw new Error("expected ensureNotBlocked to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserAutomationError);
      expect((error as BrowserAutomationError).details).toMatchObject({
        stage: "cloudflare-challenge",
        headless: false,
      });
    }
  });
});

describe("ensureLoggedIn", () => {
  test("logs success when session is present", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { ok: true, status: 200, url: "/backend-api/me" } },
      }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureLoggedIn(runtime, logger, { appliedCookies: 2 })).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("Login check passed"));
  });

  test("throws with cookie guidance when cookies missing", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: false,
            status: 401,
            url: "/backend-api/me",
            domLoginCta: true,
            onAuthPage: true,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureLoggedIn(runtime, logger, { appliedCookies: 0 })).rejects.toThrow(
      /inline cookies/i,
    );
  });

  test("uses remote hint for remote sessions", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { ok: false, status: 401, url: "/backend-api/me" } },
      }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureLoggedIn(runtime, logger, { remoteSession: true })).rejects.toThrow(
      /remote Chrome session/i,
    );
  });
});

describe("waitForAssistantResponse", () => {
  test("returns captured assistant payload", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          type: "object",
          value: { text: "Answer", html: "<p>Answer</p>", messageId: "mid", turnId: "tid" },
        },
      }),
    } as unknown as ChromeClient["Runtime"];
    const result = await waitForAssistantResponse(runtime, 1000, logger);
    expect(result.text).toBe("Answer");
    expect(result.meta).toEqual({ messageId: "mid", turnId: "tid" });
  });

  test("aborts poller when evaluation wins (no background polling)", async () => {
    vi.useFakeTimers();
    try {
      let snapshotCalls = 0;
      const payload = {
        text: "Answer payload long enough to skip the watchdog",
        html: "<p>Answer payload long enough to skip the watchdog</p>",
        messageId: "mid",
        turnId: "tid",
      };
      const evaluate = vi
        .fn()
        .mockImplementation(async (params: { expression?: string; awaitPromise?: boolean }) => {
          if (params?.awaitPromise) {
            return { result: { type: "object", value: payload } };
          }
          const expression = String(params?.expression ?? "");
          if (expression.includes("extractAssistantTurn")) {
            snapshotCalls += 1;
            // First snapshot call is the watchdog poller; keep it slow so the evaluation wins the race.
            if (snapshotCalls === 1) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return { result: { value: payload } };
          }
          return { result: { value: false } };
        });

      const runtime = { evaluate } as unknown as ChromeClient["Runtime"];
      const promise = waitForAssistantResponse(runtime, 30_000, logger);
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await promise;
      expect(result.text).toBe("Answer payload long enough to skip the watchdog");

      const callsAtReturn = evaluate.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(evaluate.mock.calls.length).toBe(callsAtReturn);
    } finally {
      vi.useRealTimers();
    }
  });

  test("response observer watches character data mutations", async () => {
    let capturedExpression = "";
    const runtime = {
      evaluate: vi.fn().mockImplementation((params) => {
        if (params?.awaitPromise) {
          capturedExpression = String(params?.expression ?? "");
          throw new Error("stop");
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];
    await expect(waitForAssistantResponse(runtime, 100, logger)).rejects.toThrow("stop");
    expect(capturedExpression).toContain("characterData: true");
    expect(capturedExpression).toContain("copy-turn-action-button");
    expect(capturedExpression).toContain("isLastAssistantTurnFinished");
    expect(capturedExpression).toContain("lastAssistantTurn.querySelector(FINISHED_SELECTOR)");
    expect(capturedExpression).not.toContain("document.querySelector(FINISHED_SELECTOR)");
    expect(capturedExpression).toContain("lastAssistantTurn.querySelectorAll('.markdown')");
    expect(capturedExpression).not.toContain("document.querySelectorAll('.markdown')");
    expect(capturedExpression).toContain("data-message-author-role");
    expect(capturedExpression).toContain("role === 'assistant'");
  });

  test("falls back to snapshot when observer fails", async () => {
    const evaluate = vi
      .fn()
      .mockImplementation(async (params: { expression?: string; awaitPromise?: boolean }) => {
        if (params?.awaitPromise) {
          throw new Error("observer failed");
        }
        if (
          typeof params?.expression === "string" &&
          params.expression.includes("extractAssistantTurn")
        ) {
          return {
            result: {
              value: {
                text: "Recovered",
                html: "<p>Recovered</p>",
                messageId: "mid",
                turnId: "tid",
              },
            },
          };
        }
        return { result: { value: null } };
      });
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];
    const result = await waitForAssistantResponse(runtime, 200, logger);
    expect(result.text).toBe("Recovered");
    expect(evaluate).toHaveBeenCalled();
  });

  test("keeps the watchdog alive when the observer only sees placeholder text", async () => {
    const placeholder = {
      text: "ChatGPT said:",
      html: "<p>ChatGPT said:</p>",
      messageId: "mid",
      turnId: "tid",
    };
    const evaluate = vi
      .fn()
      .mockImplementation(async (params: { expression?: string; awaitPromise?: boolean }) => {
        const expression = String(params?.expression ?? "");
        if (params?.awaitPromise && expression.includes("MutationObserver")) {
          return { result: { type: "object", value: placeholder } };
        }
        if (params?.awaitPromise && expression.includes("const BUTTON_SELECTOR")) {
          return {
            result: {
              value: {
                success: true,
                markdown: "BROKER-SMOKE-OK",
              },
            },
          };
        }
        if (expression.includes("extractAssistantTurn")) {
          return { result: { value: placeholder } };
        }
        if (expression.includes(`Boolean(document.querySelector('[data-testid="stop-button"]'))`)) {
          return { result: { value: false } };
        }
        if (expression.includes("hasAssistantFinishedActions")) {
          return { result: { value: true } };
        }
        return { result: { value: null } };
      });
    const runtime = {
      evaluate,
      terminateExecution: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChromeClient["Runtime"];

    const result = await waitForAssistantResponse(runtime, 1_500, logger);

    expect(result.text).toBe("BROKER-SMOKE-OK");
    expect(
      evaluate.mock.calls.some(([params]) =>
        String((params as { expression?: string }).expression ?? "").includes(
          "const BUTTON_SELECTOR",
        ),
      ),
    ).toBe(true);
  }, 10_000);

  test("does not treat a user-turn copy button as assistant completion", async () => {
    vi.useFakeTimers();
    try {
      let snapshotCalls = 0;
      const placeholder = {
        text: "ChatGPT said:",
        html: "<p>ChatGPT said:</p>",
        messageId: "mid",
        turnId: "tid",
      };
      const answer = {
        text: "BROKER-THINKING-OK",
        html: "<p>BROKER-THINKING-OK</p>",
        messageId: "mid-answer",
        turnId: "tid-answer",
      };
      const evaluate = vi
        .fn()
        .mockImplementation(async (params: { expression?: string; awaitPromise?: boolean }) => {
          const expression = String(params?.expression ?? "");
          if (params?.awaitPromise && expression.includes("MutationObserver")) {
            return { result: { type: "object", value: placeholder } };
          }
          if (params?.awaitPromise && expression.includes("const BUTTON_SELECTOR")) {
            throw new Error("copy fallback should not be used for user-turn buttons");
          }
          if (expression.includes("extractAssistantTurn")) {
            snapshotCalls += 1;
            return {
              result: {
                value: snapshotCalls < 4 ? placeholder : answer,
              },
            };
          }
          if (
            expression.includes(`Boolean(document.querySelector('[data-testid="stop-button"]'))`)
          ) {
            return { result: { value: false } };
          }
          if (expression.includes("hasAssistantFinishedActions")) {
            return { result: { value: false } };
          }
          return { result: { value: null } };
        });
      const runtime = {
        evaluate,
        terminateExecution: vi.fn().mockResolvedValue(undefined),
      } as unknown as ChromeClient["Runtime"];

      const promise = waitForAssistantResponse(runtime, 10_000, logger);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await promise;

      expect(result.text).toBe("BROKER-THINKING-OK");
      expect(
        evaluate.mock.calls.some(([params]) =>
          String((params as { expression?: string }).expression ?? "").includes(
            "const BUTTON_SELECTOR",
          ),
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not copy a stale earlier assistant turn when the current turn has no copy button yet", async () => {
    vi.useFakeTimers();
    try {
      let snapshotCalls = 0;
      const placeholder = {
        text: "ChatGPT said:",
        html: "<p>ChatGPT said:</p>",
        messageId: "mid-current",
        turnId: "tid-current",
        turnIndex: 3,
      };
      const answer = {
        text: "BROKER-FRESH-OK after enough stable cycles",
        html: "<p>BROKER-FRESH-OK after enough stable cycles</p>",
        messageId: "mid-answer",
        turnId: "tid-answer",
        turnIndex: 3,
      };
      const evaluate = vi
        .fn()
        .mockImplementation(async (params: { expression?: string; awaitPromise?: boolean }) => {
          const expression = String(params?.expression ?? "");
          if (params?.awaitPromise && expression.includes("MutationObserver")) {
            return { result: { type: "object", value: placeholder } };
          }
          if (params?.awaitPromise && expression.includes("const BUTTON_SELECTOR")) {
            return {
              result: {
                value: {
                  success: false,
                  status: "missing-button",
                },
              },
            };
          }
          if (expression.includes("extractAssistantTurn")) {
            snapshotCalls += 1;
            return {
              result: {
                value: snapshotCalls < 4 ? placeholder : answer,
              },
            };
          }
          if (
            expression.includes(`Boolean(document.querySelector('[data-testid="stop-button"]'))`)
          ) {
            return { result: { value: false } };
          }
          if (expression.includes("hasAssistantFinishedActions")) {
            return { result: { value: true } };
          }
          return { result: { value: null } };
        });
      const runtime = {
        evaluate,
        terminateExecution: vi.fn().mockResolvedValue(undefined),
      } as unknown as ChromeClient["Runtime"];

      const promise = waitForAssistantResponse(runtime, 10_000, logger, 3);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await promise;

      expect(result.text).toBe("BROKER-FRESH-OK after enough stable cycles");
      expect(
        evaluate.mock.calls.some(([params]) =>
          String((params as { expression?: string }).expression ?? "").includes(
            "const MIN_TURN_INDEX = 3",
          ),
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  test("snapshot extractor invokes the markdown fallback instead of returning the function object", () => {
    const expression = buildAssistantSnapshotExpressionForTest(3);
    expect(expression).toContain("const fallback = (() => {");
    expect(expression).toContain("return fallback() ?? extracted;");
  });

  test("waits for the watchdog when the observer returns an incomplete short answer before completion markers appear", async () => {
    vi.useFakeTimers();
    try {
      let snapshotCalls = 0;
      const earlyCapture = {
        text: "Thinking",
        html: "<p>Thinking</p>",
        messageId: "mid-thinking",
        turnId: "tid-thinking",
      };
      const answer = {
        text: "ORACLE-WATCHDOG-FINAL-20260401",
        html: "<p>ORACLE-WATCHDOG-FINAL-20260401</p>",
        messageId: "mid-answer",
        turnId: "tid-answer",
      };
      const evaluate = vi
        .fn()
        .mockImplementation(async (params: { expression?: string; awaitPromise?: boolean }) => {
          const expression = String(params?.expression ?? "");
          if (params?.awaitPromise && expression.includes("MutationObserver")) {
            return { result: { type: "object", value: earlyCapture } };
          }
          if (params?.awaitPromise && expression.includes("const BUTTON_SELECTOR")) {
            throw new Error("copy fallback should not run for incomplete early captures");
          }
          if (expression.includes("extractAssistantTurn")) {
            snapshotCalls += 1;
            return {
              result: {
                value: snapshotCalls < 18 ? null : answer,
              },
            };
          }
          if (
            expression.includes(`Boolean(document.querySelector('[data-testid="stop-button"]'))`)
          ) {
            return { result: { value: false } };
          }
          if (expression.includes("hasAssistantFinishedActions")) {
            return { result: { value: false } };
          }
          return { result: { value: null } };
        });
      const runtime = {
        evaluate,
        terminateExecution: vi.fn().mockResolvedValue(undefined),
      } as unknown as ChromeClient["Runtime"];

      const promise = waitForAssistantResponse(runtime, 20_000, logger);
      await vi.advanceTimersByTimeAsync(12_000);
      const result = await promise;

      expect(result.text).toBe("ORACLE-WATCHDOG-FINAL-20260401");
      expect(snapshotCalls).toBeGreaterThanOrEqual(18);
    } finally {
      vi.useRealTimers();
    }
  });

  test("ignores thinking-summary-only turns until the real assistant text appears", async () => {
    vi.useFakeTimers();
    try {
      let snapshotCalls = 0;
      const thinkingSummary = {
        text: "ChatGPT said:\nThought for a couple of seconds",
        html: '<div data-message-model-slug="gpt-5-4-thinking"><div class="result-thinking markdown"><p></p></div></div>',
        messageId: "mid-thinking",
        turnId: "tid-thinking",
      };
      const answer = {
        text: "ORACLE-THINKING-FINAL",
        html: "<p>ORACLE-THINKING-FINAL</p>",
        messageId: "mid-answer",
        turnId: "tid-answer",
      };
      const evaluate = vi
        .fn()
        .mockImplementation(async (params: { expression?: string; awaitPromise?: boolean }) => {
          const expression = String(params?.expression ?? "");
          if (params?.awaitPromise && expression.includes("MutationObserver")) {
            return { result: { type: "object", value: thinkingSummary } };
          }
          if (params?.awaitPromise && expression.includes("const BUTTON_SELECTOR")) {
            throw new Error("copy fallback should not be used for thinking summaries");
          }
          if (expression.includes("extractAssistantTurn")) {
            snapshotCalls += 1;
            return {
              result: {
                value: snapshotCalls < 4 ? thinkingSummary : answer,
              },
            };
          }
          if (
            expression.includes(`Boolean(document.querySelector('[data-testid="stop-button"]'))`)
          ) {
            return { result: { value: false } };
          }
          if (expression.includes("hasAssistantFinishedActions")) {
            return { result: { value: false } };
          }
          return { result: { value: null } };
        });
      const runtime = {
        evaluate,
        terminateExecution: vi.fn().mockResolvedValue(undefined),
      } as unknown as ChromeClient["Runtime"];

      const promise = waitForAssistantResponse(runtime, 10_000, logger);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await promise;

      expect(result.text).toBe("ORACLE-THINKING-FINAL");
      expect(
        evaluate.mock.calls.some(([params]) =>
          String((params as { expression?: string }).expression ?? "").includes(
            "const BUTTON_SELECTOR",
          ),
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("uploadAttachmentFile", () => {
  let transferSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    transferSpy = vi
      .spyOn(attachmentDataTransfer, "transferAttachmentViaDataTransfer")
      .mockResolvedValue({ fileName: "oracle-browser-smoke.txt", size: 1 });
  });

  afterEach(() => {
    transferSpy.mockRestore();
  });

  test.skip("selects DOM input and uploads file", async () => {
    logger.mockClear();
    vi.spyOn(attachments, "waitForAttachmentVisible").mockResolvedValue(undefined);
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn().mockResolvedValue({ nodeId: 2 }),
      setFileInputFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { matched: true, found: true } } }),
    } as unknown as ChromeClient["Runtime"];
    await expect(
      uploadAttachmentFile(
        { runtime, dom },
        { path: "/tmp/foo.md", displayPath: "foo.md" },
        logger,
      ),
    ).resolves.toBe(true);
    expect(dom.querySelector).toHaveBeenCalled();
    expect(dom.setFileInputFiles).toHaveBeenCalledWith({ nodeId: 2, files: ["/tmp/foo.md"] });
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("Attachment queued"));
  }, 15_000);

  test("throws when file input missing", async () => {
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn().mockResolvedValue({ nodeId: 0 }),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn(),
    } as unknown as ChromeClient["Runtime"];
    await expect(
      uploadAttachmentFile(
        { runtime, dom },
        { path: "/tmp/foo.md", displayPath: "foo.md" },
        logger,
      ),
    ).rejects.toThrow(/unable to locate.*attachment input/i);
  });

  test("skips upload when attachment already present (ellipsis-aware detection)", async () => {
    logger.mockClear();
    let capturedPresenceExpression = "";
    const dom = {
      getDocument: vi.fn(),
      querySelector: vi.fn(),
      setFileInputFiles: vi.fn(),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("text.includes('…')")) {
          capturedPresenceExpression = expr;
          return { result: { value: { ui: true, input: false } } };
        }
        return { result: { value: { ui: false, input: false } } };
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      uploadAttachmentFile(
        { runtime, dom },
        { path: "/tmp/SettingsStore.swift", displayPath: "SettingsStore.swift" },
        logger,
      ),
    ).resolves.toBe(true);

    expect(capturedPresenceExpression).toContain("text.includes('…')");
    expect(capturedPresenceExpression).toContain("text.includes('...')");
    expect(dom.getDocument).not.toHaveBeenCalled();
    expect(dom.setFileInputFiles).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringMatching(/Attachment already present/i));
  });

  test("skips reupload when file already queued in input", async () => {
    logger.mockClear();
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn(),
      setFileInputFiles: vi.fn(),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("matchesExpected")) {
          return { result: { value: { ui: false, input: true } } };
        }
        if (expr.includes("baselineChipCount") && expr.includes("baselineChips")) {
          return {
            result: {
              value: {
                ok: true,
                baselineChipCount: 0,
                baselineChips: [],
                baselineUploading: false,
                order: [0],
              },
            },
          };
        }
        if (expr.includes("normalizedNoExt") && expr.includes("selectors")) {
          return { result: { value: { found: true } } };
        }
        if (expr.includes("attachmentSelectors") && expr.includes("attachment-cards")) {
          return { result: { value: { found: true } } };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      uploadAttachmentFile(
        { runtime, dom },
        { path: "/tmp/oracle-browser-smoke.txt", displayPath: "oracle-browser-smoke.txt" },
        logger,
      ),
    ).resolves.toBe(true);

    expect(dom.setFileInputFiles).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringMatching(/already queued/i));
  });

  test("skips upload when file count already satisfies expected count", async () => {
    logger.mockClear();
    const dom = {
      getDocument: vi.fn(),
      querySelector: vi.fn(),
      setFileInputFiles: vi.fn(),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("matchesExpected")) {
          return {
            result: {
              value: {
                ui: false,
                input: false,
                chipCount: 0,
                inputCount: 0,
                uploading: false,
                chipSignature: "",
                fileCount: 1,
              },
            },
          };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      uploadAttachmentFile(
        { runtime, dom },
        { path: "/tmp/oracle-browser-smoke.txt", displayPath: "oracle-browser-smoke.txt" },
        logger,
        { expectedCount: 1 },
      ),
    ).resolves.toBe(true);

    expect(dom.getDocument).not.toHaveBeenCalled();
    expect(dom.setFileInputFiles).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringMatching(/composer shows 1 file/i));
  });

  test("skips upload when input count already satisfies expected count", async () => {
    logger.mockClear();
    const dom = {
      getDocument: vi.fn(),
      querySelector: vi.fn(),
      setFileInputFiles: vi.fn(),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("matchesExpected")) {
          return {
            result: {
              value: {
                ui: false,
                input: false,
                chipCount: 0,
                inputCount: 1,
                uploading: false,
                chipSignature: "",
                fileCount: 0,
              },
            },
          };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      uploadAttachmentFile(
        { runtime, dom },
        { path: "/tmp/oracle-browser-smoke.txt", displayPath: "oracle-browser-smoke.txt" },
        logger,
        { expectedCount: 1 },
      ),
    ).resolves.toBe(true);

    expect(dom.getDocument).not.toHaveBeenCalled();
    expect(dom.setFileInputFiles).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringMatching(/composer shows 1 file/i));
  });

  test("avoids retrying other inputs once upload shows progress", async () => {
    logger.mockClear();
    let readSignalCalls = 0;
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn().mockResolvedValue({ nodeId: 2 }),
      setFileInputFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("matchesExpected")) {
          readSignalCalls += 1;
          return {
            result: {
              value: {
                ui: false,
                input: false,
                chipCount: 0,
                inputCount: 0,
                uploading: readSignalCalls >= 3,
                chipSignature: "",
              },
            },
          };
        }
        if (expr.includes("baselineChipCount") && expr.includes("baselineChips")) {
          return {
            result: {
              value: {
                ok: true,
                baselineChipCount: 0,
                baselineChips: [],
                baselineUploading: false,
                baselineInputCount: 0,
                order: [0, 1],
              },
            },
          };
        }
        if (
          expr.includes("chipCount") &&
          expr.includes("composerText") &&
          expr.includes("uploading")
        ) {
          return {
            result: {
              value: {
                chipCount: 1,
                chips: [],
                inputNames: ["oracle-browser-smoke.txt"],
                composerText: "",
                uploading: true,
              },
            },
          };
        }
        if (expr.includes("attachmentSelectors") && expr.includes("found")) {
          return { result: { value: { found: true } } };
        }
        if (expr.includes("normalizedNoExt") && expr.includes("selectors")) {
          return { result: { value: { found: true } } };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      uploadAttachmentFile(
        { runtime, dom },
        { path: "/tmp/oracle-browser-smoke.txt", displayPath: "oracle-browser-smoke.txt" },
        logger,
      ),
    ).resolves.toBe(true);

    expect(dom.querySelector).toHaveBeenCalledTimes(1);
    expect(dom.setFileInputFiles).toHaveBeenCalledTimes(1);
  });

  test("checks for late attachment signals before trying alternate inputs", async () => {
    logger.mockClear();
    let readSignalCalls = 0;
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn().mockResolvedValue({ nodeId: 2 }),
      setFileInputFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("matchesExpected")) {
          readSignalCalls += 1;
          if (readSignalCalls < 3) {
            return {
              result: {
                value: {
                  ui: false,
                  input: false,
                  chipCount: 0,
                  inputCount: 0,
                  uploading: false,
                  chipSignature: "",
                },
              },
            };
          }
          return {
            result: {
              value: {
                ui: false,
                input: false,
                chipCount: 1,
                inputCount: 0,
                uploading: false,
                chipSignature: "late-chip",
              },
            },
          };
        }
        if (expr.includes("baselineChipCount") && expr.includes("baselineChips")) {
          return {
            result: {
              value: {
                ok: true,
                baselineChipCount: 0,
                baselineChips: [],
                baselineUploading: false,
                baselineInputCount: 0,
                order: [0, 1],
              },
            },
          };
        }
        if (
          expr.includes("chipCount") &&
          expr.includes("composerText") &&
          expr.includes("uploading")
        ) {
          return {
            result: {
              value: {
                chipCount: 0,
                chips: [],
                inputNames: [],
                composerText: "",
                uploading: false,
              },
            },
          };
        }
        if (expr.includes("normalizedNoExt") && expr.includes("selectors")) {
          return { result: { value: { found: false } } };
        }
        if (expr.includes("attachmentSelectors") && expr.includes("attachment-cards")) {
          return { result: { value: { found: true } } };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    vi.useFakeTimers();
    const uploadPromise = uploadAttachmentFile(
      { runtime, dom },
      { path: "/tmp/oracle-browser-smoke.txt", displayPath: "oracle-browser-smoke.txt" },
      logger,
    );
    await Promise.resolve();
    await vi.runAllTimersAsync();
    await expect(uploadPromise).resolves.toBe(true);
    vi.useRealTimers();

    expect(dom.querySelector).toHaveBeenCalledTimes(1);
    expect(dom.setFileInputFiles).toHaveBeenCalledTimes(1);
  });

  test("defers data transfer fallback when attachment signals appear after setFileInputFiles", async () => {
    logger.mockClear();
    vi.spyOn(attachments, "waitForAttachmentVisible").mockResolvedValue(undefined);
    let readSignalCalls = 0;
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn().mockResolvedValue({ nodeId: 2 }),
      setFileInputFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("matchesExpected")) {
          readSignalCalls += 1;
          if (readSignalCalls === 1) {
            return {
              result: {
                value: {
                  ui: false,
                  input: false,
                  chipCount: 0,
                  inputCount: 0,
                  uploading: false,
                  chipSignature: "",
                  fileCount: 0,
                },
              },
            };
          }
          return {
            result: {
              value: {
                ui: true,
                input: false,
                chipCount: 1,
                inputCount: 1,
                uploading: false,
                chipSignature: "chip",
                fileCount: 1,
              },
            },
          };
        }
        if (expr.includes("baselineChipCount") && expr.includes("baselineChips")) {
          return {
            result: {
              value: {
                ok: true,
                baselineChipCount: 0,
                baselineChips: [],
                baselineUploading: false,
                baselineInputCount: 0,
                baselineFileCount: 0,
                order: [0],
              },
            },
          };
        }
        if (
          expr.includes("chipCount") &&
          expr.includes("composerText") &&
          expr.includes("uploading")
        ) {
          return {
            result: {
              value: {
                chipCount: 1,
                chips: [],
                inputNames: ["oracle-browser-smoke.txt"],
                composerText: "",
                uploading: false,
              },
            },
          };
        }
        if (expr.includes("attachmentSelectors") && expr.includes("attachment-cards")) {
          return { result: { value: { found: true } } };
        }
        if (expr.includes("normalizedNoExt") && expr.includes("selectors")) {
          return { result: { value: { found: true } } };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      uploadAttachmentFile(
        { runtime, dom },
        { path: "/tmp/oracle-browser-smoke.txt", displayPath: "oracle-browser-smoke.txt" },
        logger,
      ),
    ).resolves.toBe(true);

    expect(transferSpy).not.toHaveBeenCalled();
  });

  test("clears stale file inputs before trying alternate candidates", async () => {
    logger.mockClear();
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn().mockResolvedValue({ nodeId: 2 }),
      setFileInputFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("matchesExpected")) {
          return {
            result: {
              value: {
                ui: false,
                input: false,
                chipCount: 0,
                inputCount: 0,
                uploading: false,
                chipSignature: "",
                fileCount: 0,
              },
            },
          };
        }
        if (expr.includes("baselineChipCount") && expr.includes("baselineChips")) {
          return {
            result: {
              value: {
                ok: true,
                baselineChipCount: 0,
                baselineChips: [],
                baselineUploading: false,
                baselineInputCount: 0,
                baselineFileCount: 0,
                order: [0, 1],
              },
            },
          };
        }
        if (expr.includes('input[type="file"][data-oracle-upload-idx') && expr.includes("names")) {
          return { result: { value: { names: [], value: "", count: 0 } } };
        }
        if (
          expr.includes("chipCount") &&
          expr.includes("composerText") &&
          expr.includes("uploading")
        ) {
          return {
            result: {
              value: {
                chipCount: 0,
                chips: [],
                inputNames: [],
                composerText: "",
                uploading: false,
              },
            },
          };
        }
        if (expr.includes("attachmentSelectors") && expr.includes("attachment-cards")) {
          return { result: { value: { found: false } } };
        }
        if (expr.includes("normalizedNoExt") && expr.includes("selectors")) {
          return { result: { value: { found: false } } };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    vi.useFakeTimers();
    const uploadPromise = uploadAttachmentFile(
      { runtime, dom },
      { path: "/tmp/oracle-browser-smoke.txt", displayPath: "oracle-browser-smoke.txt" },
      logger,
    );
    const handledPromise = uploadPromise.catch((error) => error as Error);
    await Promise.resolve();
    await vi.runAllTimersAsync();
    const error = await handledPromise;
    vi.useRealTimers();

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Attachment did not register/i);
    expect(dom.setFileInputFiles).toHaveBeenCalledWith({ nodeId: 2, files: [] });
  });

  test("uses file-count signal to avoid retrying alternate inputs", async () => {
    logger.mockClear();
    vi.spyOn(attachments, "waitForAttachmentVisible").mockResolvedValue(undefined);
    let readSignalCalls = 0;
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn().mockResolvedValue({ nodeId: 2 }),
      setFileInputFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("matchesExpected")) {
          readSignalCalls += 1;
          return {
            result: {
              value: {
                ui: false,
                input: false,
                chipCount: 0,
                inputCount: 0,
                uploading: false,
                chipSignature: "",
                fileCount: readSignalCalls >= 3 ? 1 : 0,
              },
            },
          };
        }
        if (expr.includes("baselineChipCount") && expr.includes("baselineChips")) {
          return {
            result: {
              value: {
                ok: true,
                baselineChipCount: 0,
                baselineChips: [],
                baselineUploading: false,
                baselineInputCount: 0,
                baselineFileCount: 0,
                order: [0, 1],
              },
            },
          };
        }
        if (
          expr.includes("chipCount") &&
          expr.includes("composerText") &&
          expr.includes("uploading")
        ) {
          return {
            result: {
              value: {
                chipCount: 0,
                chips: [],
                inputNames: [],
                composerText: "",
                uploading: false,
              },
            },
          };
        }
        if (expr.includes("attachmentSelectors") && expr.includes("attachment-cards")) {
          return { result: { value: { found: true } } };
        }
        if (expr.includes("normalizedNoExt") && expr.includes("selectors")) {
          return { result: { value: { found: true } } };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    vi.useFakeTimers();
    const uploadPromise = uploadAttachmentFile(
      { runtime, dom },
      { path: "/tmp/oracle-browser-smoke.txt", displayPath: "oracle-browser-smoke.txt" },
      logger,
    );
    await Promise.resolve();
    await vi.runAllTimersAsync();
    await expect(uploadPromise).resolves.toBe(true);
    vi.useRealTimers();

    expect(dom.querySelector).toHaveBeenCalledTimes(1);
    expect(dom.setFileInputFiles).toHaveBeenCalledTimes(1);
  });
});

describe("waitForAttachmentVisible", () => {
  test("treats file input name match as a valid visibility signal", async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    const evaluate = vi
      .fn()
      .mockResolvedValue({ result: { value: { found: true, source: "file-input" } } });
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    await expect(
      attachments.waitForAttachmentVisible(runtime, "oracle-browser-smoke.txt", 100, logger),
    ).resolves.toBeUndefined();

    const call = (evaluate as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as
      | { expression?: string }
      | undefined;
    const capturedExpression = String(call?.expression ?? "");
    expect(capturedExpression).toContain("source: 'file-input'");
    expect(capturedExpression).toContain('input[type="file"]');
    expect(capturedExpression).toContain("attachments?");
  });
});

describe("waitForAttachmentCompletion", () => {
  test("resolves when composer ready", async () => {
    const evaluate = vi.fn();
    evaluate.mockImplementation(async () => {
      const call = evaluate.mock.calls.length;
      if (call <= 1) {
        return { result: { value: { state: "disabled", uploading: true, filesAttached: true } } };
      }
      return { result: { value: { state: "ready", uploading: false, filesAttached: true } } };
    });
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];
    vi.useFakeTimers();
    const promise = waitForAttachmentCompletion(runtime, 5_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
    expect(runtime.evaluate).toHaveBeenCalled();
  });

  test("resolves when send button missing but files present", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValueOnce({
        result: { value: { state: "missing", uploading: false, filesAttached: true } },
      }),
    } as unknown as ChromeClient["Runtime"];
    await expect(waitForAttachmentCompletion(runtime, 200)).resolves.toBeUndefined();
  });

  test("rejects when timeout reached", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { state: "disabled", uploading: true, filesAttached: false } },
      }),
    } as unknown as ChromeClient["Runtime"];
    await expect(waitForAttachmentCompletion(runtime, 200)).rejects.toThrow(
      /Attachments did not finish/,
    );
  });
});
