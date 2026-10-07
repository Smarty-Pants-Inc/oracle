import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import {
  __test__,
  classifyPreservedBrowserErrorForTest,
  formatBrowserTurnTranscript,
  isLocalChromeHostForTest,
  maybeArchiveCompletedConversationForTest,
  maybeArchiveInterruptedConversationForTest,
  redactBrowserConfigForDebugLogForTest,
  resolveRemoteTabLeaseProfileDirForTest,
  runBrowserMode,
  runSubmissionWithRecoveryForTest,
  shouldPreferSystemTmpDirForTest,
  shouldPreserveBrowserOnErrorForTest,
} from "../../src/browser/index.js";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import { redactBrowserConfigForDebugLog } from "../../src/browser/configLogging.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";

describe("background-only browser policy", () => {
  test("rejects attach-running before browser discovery can touch the primary browser", async () => {
    await expect(
      runBrowserMode({ prompt: "review", config: { attachRunning: true } }),
    ).rejects.toMatchObject({ details: { stage: "background-browser-policy" } });
  });

  test("rejects local Chrome when invoked through the agent wrapper", async () => {
    const previous = process.env.ORACLE_WRAPPER_REMOTE_ONLY;
    process.env.ORACLE_WRAPPER_REMOTE_ONLY = "1";
    try {
      await expect(
        runBrowserMode({ prompt: "review", config: { manualLogin: true } }),
      ).rejects.toMatchObject({ details: { stage: "background-browser-policy" } });
    } finally {
      if (previous === undefined) {
        delete process.env.ORACLE_WRAPPER_REMOTE_ONLY;
      } else {
        process.env.ORACLE_WRAPPER_REMOTE_ONLY = previous;
      }
    }
  });
});

describe("conversation cookie cleanup", () => {
  test("preserves an exact conversation configured as the browser URL", () => {
    const config = resolveBrowserConfig({
      url: "https://chatgpt.com/g/project/c/current-thread",
    });

    expect(__test__.conversationCookieIdsToPreserve(config, null)).toEqual(["current-thread"]);
  });

  test("seeds run affinity from the exact resume URL or configured URL", () => {
    expect(
      __test__.resolveInitialRunConversationId(
        resolveBrowserConfig({ url: "https://chatgpt.com/c/configured-thread" }),
      ),
    ).toBe("configured-thread");
    expect(
      __test__.resolveInitialRunConversationId(
        resolveBrowserConfig({
          url: "https://chatgpt.com/c/configured-thread",
          resumeConversationUrl: "https://chatgpt.com/c/resumed-thread",
        }),
      ),
    ).toBe("resumed-thread");
    expect(
      __test__.resolveInitialRunConversationUrl(
        resolveBrowserConfig({
          url: "https://chatgpt.com/g/project/c/configured-thread",
          resumeConversationUrl: "https://chatgpt.com/g/project/c/resumed-thread",
        }),
      ),
    ).toBe("https://chatgpt.com/g/project/c/resumed-thread");
  });
  test("accepts exact conversation affinity on the supported legacy ChatGPT host", () => {
    expect(
      __test__.extractExactChatGptConversationId("https://chat.openai.com/c/legacy-thread"),
    ).toBe("legacy-thread");
    expect(
      __test__.extractExactChatGptConversationId(
        "https://chat.openai.com/g/project/project/c/legacy-thread",
      ),
    ).toBe("legacy-thread");
  });

  test("does not read conversation affinity from query strings or fragments", () => {
    expect(
      __test__.extractExactChatGptConversationId(
        "https://chatgpt.com/?next=https://chatgpt.com/c/private-thread",
      ),
    ).toBeUndefined();
    expect(
      __test__.extractExactChatGptConversationId(
        "https://chatgpt.com/#https://chatgpt.com/c/private-thread",
      ),
    ).toBeUndefined();
  });
  test.each([
    [
      "root versus project route",
      "https://chatgpt.com/g/project-a/project/c/same-thread",
      "https://chatgpt.com/c/same-thread",
    ],
    [
      "cross-project route",
      "https://chatgpt.com/g/project-a/project/c/same-thread",
      "https://chatgpt.com/g/project-b/project/c/same-thread",
    ],
    [
      "cross-origin route",
      "https://chatgpt.com/c/same-thread",
      "https://chat.openai.com/c/same-thread",
    ],
  ])("rejects same-id %s affinity drift", (_case, expectedUrl, actualUrl) => {
    expect(() =>
      __test__.assertRunConversationId(
        "same-thread",
        expectedUrl,
        actualUrl,
        "strict affinity test",
      ),
    ).toThrow(/conversation changed/i);
  });

  test("accepts the exact conversation URL with a trailing slash", () => {
    expect(() =>
      __test__.assertRunConversationId(
        "same-thread",
        "https://chatgpt.com/g/project/project/c/same-thread",
        "https://chatgpt.com/g/project/project/c/same-thread/",
        "strict affinity test",
      ),
    ).not.toThrow();
  });
});

describe("remote browser identity", () => {
  test("rejects a browser swap before actual attachment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/browser-b",
        }),
      }),
    );
    try {
      await expect(
        runBrowserMode({
          prompt: "must not send",
          config: {
            remoteChrome: { host: "127.0.0.1", port: 9223 },
            remoteChromeBrowserId: "browser-a",
            remoteChromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
          },
        }),
      ).rejects.toMatchObject({
        details: {
          stage: "remote-browser-identity",
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("gives each account affinity probe a fresh input timeout after a long response", () => {
    vi.useFakeTimers();
    try {
      const runStartedAt = Date.now();
      vi.advanceTimersByTime(10 * 60_000);

      expect(Date.now() - runStartedAt).toBe(10 * 60_000);
      expect(__test__.resolveAccountAffinityProbeTimeoutMs(250)).toBe(250);
    } finally {
      vi.useRealTimers();
    }
  });
  test("rechecks the stored account digest at the requested action boundary", async () => {
    const digest = "a".repeat(64);
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: digest } }),
    };

    await expect(
      __test__.assertRemoteChatGptAccountAffinity(runtime as never, digest, "submission"),
    ).resolves.toBeUndefined();
    await expect(
      __test__.assertRemoteChatGptAccountAffinity(
        runtime as never,
        "b".repeat(64),
        "attachment upload",
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/changed before attachment upload/i),
      details: { stage: "remote-browser-identity" },
    });
  });

  test("rejects a missing stored account digest before submission", async () => {
    await expect(
      __test__.assertRemoteChatGptAccountAffinity(
        { evaluate: vi.fn() } as never,
        null,
        "submission",
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/unavailable before submission/i),
      details: { stage: "remote-browser-identity" },
    });
  });
});

describe("generated image response failures", () => {
  test("rejects a current Retry failure instead of accepting its text as an image answer", async () => {
    const evaluate = vi.fn().mockResolvedValue({
      result: {
        value: {
          text: "Something went wrong while generating the response.",
          turnIndex: 2,
          uiError: "temporary_unavailable",
        },
      },
    });
    await expect(
      __test__.pollGeneratedImageOrTextAssistantResponse(
        { evaluate } as unknown as Parameters<
          typeof __test__.pollGeneratedImageOrTextAssistantResponse
        >[0],
        30_000,
        2,
      ),
    ).rejects.toMatchObject({
      details: { stage: "assistant-ui-error", code: "chatgpt-ui-warning" },
    });
    expect(evaluate).toHaveBeenCalledOnce();
  });
});

describe("shouldPreserveBrowserOnErrorForTest", () => {
  test("preserves the browser for headful cloudflare challenge errors", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(true);
  });

  test("preserves post-submit Cloudflare codes emitted under another stage", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected after submit.", {
      stage: "submit-prompt",
      code: "cloudflare-challenge",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(true);
  });

  test("does not preserve the browser for headless cloudflare challenge errors", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, true)).toBe(false);
  });

  test("preserves the browser for headful assistant capture errors", () => {
    const timeout = new BrowserAutomationError("assistant timed out", {
      stage: "assistant-timeout",
    });
    const recheck = new BrowserAutomationError("assistant recheck failed", {
      stage: "assistant-recheck",
    });
    const uiError = new BrowserAutomationError("assistant failed", {
      stage: "assistant-ui-error",
    });

    expect(shouldPreserveBrowserOnErrorForTest(timeout, false)).toBe(true);
    expect(shouldPreserveBrowserOnErrorForTest(recheck, false)).toBe(true);
    expect(shouldPreserveBrowserOnErrorForTest(uiError, false)).toBe(true);
    expect(classifyPreservedBrowserErrorForTest(timeout, false)).toBe("reattachable-capture");
    expect(classifyPreservedBrowserErrorForTest(recheck, false)).toBe("reattachable-capture");
    expect(classifyPreservedBrowserErrorForTest(uiError, false)).toBe("reattachable-capture");
  });

  test("does not preserve assistant capture errors in headless mode", () => {
    const error = new BrowserAutomationError("assistant timed out", {
      stage: "assistant-timeout",
    });

    expect(shouldPreserveBrowserOnErrorForTest(error, true)).toBe(false);
    expect(classifyPreservedBrowserErrorForTest(error, true)).toBeNull();
  });

  test("does not preserve the browser for unrelated browser errors", () => {
    const error = new BrowserAutomationError("other browser error", {
      stage: "execute-browser",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(false);
    expect(classifyPreservedBrowserErrorForTest(error, false)).toBeNull();
  });

  test("classifies Cloudflare preservation separately from assistant capture preservation", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });

    expect(classifyPreservedBrowserErrorForTest(error, false)).toBe("cloudflare-challenge");
  });
});

describe("authenticated model-selection errors", () => {
  test("preserves picker diagnostics without adding cookie guidance", () => {
    const error = new BrowserAutomationError(
      'Unable to find model option matching "GPT-5.2 Instant". Available: GPT-5.6 Sol.',
      { stage: "model-selection" },
    );

    const normalized = __test__.normalizeAuthenticatedModelSelectionError(error);

    expect(normalized).toBe(error);
    expect(normalized.message).toContain("Available: GPT-5.6 Sol");
    expect(normalized.message).not.toMatch(/cookies|log in/i);
  });
});

describe("browser run target cleanup", () => {
  test("never retains a copied profile after a preserved browser error", () => {
    expect(
      __test__.shouldKeepLocalBrowserOpen({
        effectiveKeepBrowser: false,
        preserveBrowserOnError: true,
        usingCopiedProfile: true,
      }),
    ).toBe(false);
  });

  test("keeps existing retention semantics for ordinary profiles", () => {
    expect(
      __test__.shouldKeepLocalBrowserOpen({
        effectiveKeepBrowser: false,
        preserveBrowserOnError: true,
        usingCopiedProfile: false,
      }),
    ).toBe(true);
  });

  test("keeps the completed conversation tab when keepBrowser is enabled", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: true,
        keepBrowser: true,
      }),
    ).toBe(false);
  });

  test("closes owned completed tabs by default", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: true,
        keepBrowser: false,
      }),
    ).toBe(true);
  });

  test("closes a completed service-owned tab while keeping shared Chrome alive", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: true,
        keepBrowser: true,
        closeOwnedTabOnComplete: true,
      }),
    ).toBe(true);
  });

  test("does not close attached targets", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: false,
        keepBrowser: false,
        closeOwnedTabOnComplete: true,
      }),
    ).toBe(false);
  });

  test("closes owned incomplete targets by default", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "attempted",
        ownsTarget: true,
        keepBrowser: false,
        closeOwnedTabOnComplete: true,
      }),
    ).toBe(true);
  });

  test("keeps owned incomplete targets only for explicit recovery", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "attempted",
        ownsTarget: true,
        keepBrowser: false,
        closeOwnedTabOnComplete: true,
        preserveForRecovery: true,
      }),
    ).toBe(false);
  });

  test("schedules final blank cleanup for retained manual-login Chrome", () => {
    expect(
      __test__.shouldCleanupBlankTabsAfterLastLease({
        runStatus: "complete",
        ownsTarget: true,
        connectionClosedUnexpectedly: false,
        manualLogin: true,
        keepBrowser: true,
        chromePort: 9222,
      }),
    ).toBe(true);
    expect(
      __test__.shouldCleanupBlankTabsAfterLastLease({
        runStatus: "complete",
        ownsTarget: true,
        connectionClosedUnexpectedly: false,
        manualLogin: true,
        keepBrowser: false,
        chromePort: 9222,
      }),
    ).toBe(false);
    expect(
      __test__.shouldCleanupBlankTabsAfterLastLease({
        runStatus: "attempted",
        ownsTarget: true,
        connectionClosedUnexpectedly: false,
        manualLogin: true,
        keepBrowser: true,
        chromePort: 9222,
      }),
    ).toBe(false);
    expect(
      __test__.shouldCleanupBlankTabsAfterLastLease({
        runStatus: "complete",
        ownsTarget: false,
        connectionClosedUnexpectedly: false,
        manualLogin: true,
        keepBrowser: true,
        chromePort: 9222,
      }),
    ).toBe(false);
    expect(
      __test__.shouldCleanupBlankTabsAfterLastLease({
        runStatus: "complete",
        ownsTarget: true,
        connectionClosedUnexpectedly: true,
        manualLogin: true,
        keepBrowser: true,
        chromePort: 9222,
      }),
    ).toBe(false);
  });

  test("keeps shared Chrome alive when another tab lease remains", async () => {
    const terminateSharedChrome = vi.fn(async () => true);
    const closeOwnedRunTarget = vi.fn(async () => undefined);
    const cleanupBlankTabs = vi.fn(async () => undefined);
    const logger = vi.fn();
    const lease = {
      id: "lease-one",
      update: vi.fn(async () => undefined),
      release: vi.fn(async ({ onRelease }) => {
        await onRelease?.({ isLastLease: false });
      }),
    };

    const result = await __test__.releaseLocalBrowserTabLease({
      lease,
      closeOwnedRunTarget,
      cleanupBlankTabs,
      terminateSharedChrome,
      logger,
    });

    expect(result).toEqual({ keepBrowserOpen: true, terminationHandled: false });
    expect(closeOwnedRunTarget).toHaveBeenCalledOnce();
    expect(cleanupBlankTabs).not.toHaveBeenCalled();
    expect(terminateSharedChrome).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("Other ChatGPT tab leases"));
  });

  test("terminates shared Chrome only inside the final tab lease release", async () => {
    const order: string[] = [];
    const logger = vi.fn();
    const lease = {
      id: "lease-last",
      update: vi.fn(async () => undefined),
      release: vi.fn(async ({ onRelease }) => {
        order.push("release-start");
        await onRelease?.({ isLastLease: true });
        order.push("release-finish");
      }),
    };

    const result = await __test__.releaseLocalBrowserTabLease({
      lease,
      closeOwnedRunTarget: async () => {
        order.push("close-target");
      },
      cleanupBlankTabs: async () => {
        order.push("cleanup-blank");
      },
      terminateSharedChrome: async () => {
        order.push("terminate-chrome");
        return true;
      },
      logger,
    });

    expect(result).toEqual({ keepBrowserOpen: false, terminationHandled: true });
    expect(order).toEqual([
      "release-start",
      "close-target",
      "cleanup-blank",
      "terminate-chrome",
      "release-finish",
    ]);
  });

  test("fails closed when final shared Chrome termination cannot be verified", async () => {
    const logger = vi.fn();
    const lease = {
      id: "lease-last-failed-termination",
      update: vi.fn(async () => undefined),
      release: vi.fn(async ({ onRelease }) => {
        await onRelease?.({ isLastLease: true });
      }),
    };

    const result = await __test__.releaseLocalBrowserTabLease({
      lease,
      closeOwnedRunTarget: async () => undefined,
      cleanupBlankTabs: async () => undefined,
      terminateSharedChrome: async () => false,
      logger,
    });

    expect(result).toEqual({ keepBrowserOpen: true, terminationHandled: false });
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("Could not verify shared Chrome termination"),
    );
  });

  test("surfaces a registry unlock failure after final-lease cleanup succeeds", async () => {
    const logger = vi.fn();
    const releaseFailure = new Error("registry lock removal exhausted");
    const lease = {
      id: "lease-last-unlock-failure",
      update: vi.fn(async () => undefined),
      release: vi.fn(async ({ onRelease }) => {
        await onRelease?.({ isLastLease: true });
        throw releaseFailure;
      }),
    };

    const result = await __test__.releaseLocalBrowserTabLease({
      lease,
      closeOwnedRunTarget: async () => undefined,
      cleanupBlankTabs: async () => undefined,
      terminateSharedChrome: async () => true,
      logger,
    });

    expect(result).toEqual({
      keepBrowserOpen: false,
      terminationHandled: true,
      releaseError: releaseFailure,
    });
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("restart Oracle/Codex MCP"));
  });

  test("fails closed when the tab lease release decision is unavailable", async () => {
    const terminateSharedChrome = vi.fn(async () => true);
    const logger = vi.fn();
    const lease = {
      id: "lease-unknown",
      update: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };

    const result = await __test__.releaseLocalBrowserTabLease({
      lease,
      closeOwnedRunTarget: async () => undefined,
      cleanupBlankTabs: async () => undefined,
      terminateSharedChrome,
      logger,
    });

    expect(result).toEqual({ keepBrowserOpen: true, terminationHandled: false });
    expect(terminateSharedChrome).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("Could not verify final"));
  });

  test("marks a completed result when browser cleanup is not confirmed", () => {
    const result = {
      answerText: "kept answer",
      answerMarkdown: "kept answer",
      tookMs: 1,
      answerTokens: 2,
      answerChars: 11,
      warnings: undefined,
    };

    __test__.appendBrowserCleanupWarning(result, 2);

    expect(result.answerText).toBe("kept answer");
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "browser-cleanup-incomplete",
        details: { failureCount: 2 },
      }),
    ]);
  });
});

describe("attachment upload timeout policy", () => {
  const attachment = (sizeBytes?: number) => ({
    path: "/tmp/attachment",
    displayPath: "attachment",
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
  });

  test("adds size budget for a roughly 24 MB attachment", () => {
    expect(__test__.resolveAttachmentUploadTimeoutMs([attachment(24.4 * 1024 * 1024)])).toBe(
      95_000,
    );
  });

  test("keeps the existing conservative budget for unknown sizes", () => {
    expect(__test__.resolveAttachmentUploadTimeoutMs([attachment()])).toBe(45_000);
  });

  test("adds budget for multiple attachments", () => {
    expect(__test__.resolveAttachmentUploadTimeoutMs([attachment(), attachment()])).toBe(65_000);
  });

  test("uses inputTimeoutMs as a floor", () => {
    expect(__test__.resolveAttachmentUploadTimeoutMs([attachment()], 60_000)).toBe(60_000);
  });

  test("caps automatic scaling for very large attachments", () => {
    expect(__test__.resolveAttachmentUploadTimeoutMs([attachment(100 * 1024 * 1024)])).toBe(
      180_000,
    );
  });

  test("preserves an explicit inputTimeoutMs above the automatic cap", () => {
    expect(__test__.resolveAttachmentUploadTimeoutMs([attachment()], 300_000)).toBe(300_000);
  });
});

describe("manual-login profile setup gate", () => {
  test("fails fast for an uninitialized manual-login profile unless setup keeps Chrome open", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-empty-profile-"));
    try {
      await expect(
        __test__.assertManualLoginProfileReadyForRun({
          userDataDir: dir,
          keepBrowser: false,
        }),
      ).rejects.toThrow(/private Chrome profile/i);

      await expect(
        __test__.assertManualLoginProfileReadyForRun({
          userDataDir: dir,
          keepBrowser: true,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("accepts an initialized manual-login Chrome profile", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-initialized-profile-"));
    try {
      await mkdir(path.join(dir, "Default"));
      await expect(
        __test__.assertManualLoginProfileReadyForRun({
          userDataDir: dir,
          keepBrowser: false,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("formats the first-time setup command with the selected profile", () => {
    expect(__test__.formatManualLoginSetupCommand("/tmp/oracle profile")).toContain(
      '--browser-manual-login-profile-dir "/tmp/oracle profile"',
    );
  });

  test("caps non-setup manual-login waits so MCP callers fail fast", () => {
    expect(__test__.resolveManualLoginWaitMs(20 * 60_000, false)).toBe(30_000);
    expect(__test__.resolveManualLoginWaitMs(5_000, false)).toBe(5_000);
    expect(__test__.resolveManualLoginWaitMs(20 * 60_000, true)).toBe(20 * 60_000);
  });
});

describe("thinking time selection policy", () => {
  test("keeps explicit effort selection enabled for Deep Research", () => {
    const config = resolveBrowserConfig({
      desiredModel: "gpt-5.6-sol",
      thinkingTime: "pro",
      researchMode: "deep",
    });

    expect(__test__.shouldApplyThinkingTimeSelection(config)).toBe(true);
  });

  test("does not select an effort when none was requested", () => {
    const config = resolveBrowserConfig({ researchMode: "deep" });

    expect(__test__.shouldApplyThinkingTimeSelection(config)).toBe(false);
  });
});

describe("formatBrowserTurnTranscript", () => {
  test("keeps single-turn browser output unchanged", () => {
    expect(
      formatBrowserTurnTranscript([
        {
          label: "Initial response",
          answerText: "plain answer",
          answerMarkdown: "**plain answer**",
        },
      ]),
    ).toEqual({
      answerText: "plain answer",
      answerMarkdown: "**plain answer**",
    });
  });

  test("formats multi-turn consult output with follow-up prompts", () => {
    const result = formatBrowserTurnTranscript([
      {
        label: "Initial response",
        answerText: "initial answer",
        answerMarkdown: "initial answer",
      },
      {
        label: "Follow-up 1",
        prompt: "Challenge your previous recommendation.",
        answerText: "revised answer",
        answerMarkdown: "revised answer",
      },
    ]);

    expect(result.answerMarkdown).toContain("## Initial response");
    expect(result.answerMarkdown).toContain("## Follow-up 1");
    expect(result.answerMarkdown).toContain(
      "### Prompt\n\nChallenge your previous recommendation.",
    );
    expect(result.answerMarkdown).toContain("### Answer\n\nrevised answer");
    expect(result.answerText).toBe(result.answerMarkdown);
  });
});

describe("ChatGPT UI warning detection", () => {
  test("classifies request-speed warnings as rate limits", () => {
    expect(
      __test__.classifyChatGptUiWarningText(
        "You are sending too many requests too quickly. Please try again later.",
      ),
    ).toBe("rate_limit");
  });

  test("classifies visually mangled request-speed modal text as rate limits", () => {
    expect(
      __test__.classifyChatGptUiWarningText(
        "Too many reque t. You’re making reque t too quickly. We’ve temporarily limited access to your conversations. Please wait a few minutes before trying again.",
      ),
    ).toBe("rate_limit");
  });

  test("classifies bare retry-later warnings as temporary unavailability", () => {
    expect(__test__.classifyChatGptUiWarningText("Try again later.")).toBe("temporary_unavailable");
  });

  test("collects visible warning candidates from the browser DOM", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              text: "You are sending too many requests too quickly. Please try again later.",
              source: "selector",
              role: "alert",
              ariaLive: "assertive",
              selector: '[role="alert"]',
            },
            {
              text: "ordinary page text",
              source: "visible-warning-text",
            },
          ],
        },
      }),
    };

    await expect(__test__.collectChatGptUiWarnings(Runtime as never)).resolves.toEqual([
      {
        type: "rate_limit",
        message: "You are sending too many requests too quickly. Please try again later.",
        source: "selector",
        role: "alert",
        ariaLive: "assertive",
        selector: '[role="alert"]',
      },
    ]);
    const expression = Runtime.evaluate.mock.calls[0]?.[0]?.expression;
    expect(expression).not.toContain("createTreeWalker");
    expect(expression).not.toContain('[class*="error" i]');
    expect(expression).not.toContain('[class*="warning" i]');
    expect(expression).toContain("current = current.parentElement");
    expect(expression).toContain("Number.parseFloat(currentStyle.opacity || '1') === 0");
  });

  test("redacts account and token-like values from warning details", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              text: "Sign in as private@example.test with session_token=secret-session-value",
              source: "selector",
              role: "dialog",
              selector: '[role="dialog"]',
            },
          ],
        },
      }),
    };

    const warnings = await __test__.collectChatGptUiWarnings(Runtime as never);
    expect(warnings).toEqual([
      {
        type: "auth_or_challenge",
        message: "Sign in as [redacted-email] with session_token=[redacted]",
        source: "selector",
        role: "dialog",
        ariaLive: null,
        selector: '[role="dialog"]',
      },
    ]);
    expect(JSON.stringify(warnings)).not.toContain("private@example.test");
    expect(JSON.stringify(warnings)).not.toContain("secret-session-value");
  });

  test("builds a structured timeout error when ChatGPT shows a blocking warning", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              text: "You are sending too many requests too quickly. Please try again later.",
              source: "selector",
              role: "alert",
              ariaLive: "assertive",
              selector: '[role="alert"]',
            },
          ],
        },
      }),
    };
    const logger = vi.fn<(message: string) => void>();

    const error = await __test__.createAssistantTimeoutError({
      Runtime: Runtime as never,
      logger: logger as never,
      runtime: { chromePort: 9222 },
      diagnostics: { domPath: "/tmp/assistant-timeout.dom.json" },
      cause: new Error("timeout"),
    });

    expect(error.message).toContain("rate-limit warning");
    expect(error.details).toMatchObject({
      stage: "assistant-timeout",
      code: "chatgpt-ui-warning",
      runtime: { chromePort: 9222 },
      diagnostics: { domPath: "/tmp/assistant-timeout.dom.json" },
      uiWarning: {
        type: "rate_limit",
        message: "You are sending too many requests too quickly. Please try again later.",
      },
    });
    expect(logger).toHaveBeenCalledWith(
      "[browser] ChatGPT UI warning detected (rate_limit): You are sending too many requests too quickly. Please try again later.",
    );
  });

  test("keeps the generic timeout error when no blocking warning is visible", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: [] } }),
    };

    const error = await __test__.createAssistantTimeoutError({
      Runtime: Runtime as never,
      logger: vi.fn() as never,
      runtime: { chromePort: 9222 },
      cause: new Error("timeout"),
    });

    expect(error.message).toBe(
      "Assistant response timed out before completion; reattach later to capture the answer.",
    );
    expect(error.details).toMatchObject({
      stage: "assistant-timeout",
      runtime: { chromePort: 9222 },
    });
    expect(error.details).not.toHaveProperty("uiWarning");
  });

  test("routes plain response observer timeouts through assistant timeout handling", () => {
    expect(__test__.isAssistantResponseTimeoutError(new Error("Response timeout"))).toBe(true);
    expect(__test__.isAssistantResponseTimeoutError(new Error("Navigation timeout"))).toBe(false);
  });

  test("waits for prior turns to hydrate before retrying capture after a stall reload", async () => {
    vi.useFakeTimers();
    try {
      let reloaded = false;
      let hydrated = false;
      const responseProbeHydrationStates: boolean[] = [];
      const partial = { text: "Synthetic preamble.", messageId: "mid", turnId: "tid" };
      const complete = {
        text: "Synthetic complete answer after safe reload.",
        messageId: "mid",
        turnId: "tid",
      };
      const Runtime = {
        evaluate: vi.fn(async (params: { expression?: string; awaitPromise?: boolean }) => {
          const expression = String(params.expression ?? "");
          if (expression === "location.href") {
            return { result: { value: "https://chatgpt.com/c/synthetic-recovery" } };
          }
          if (expression.startsWith("document.querySelectorAll(")) {
            return { result: { value: hydrated ? 2 : 0 } };
          }
          if (expression.includes("const selectors =")) {
            return { result: { value: true } };
          }
          if (params.awaitPromise && expression.includes("MutationObserver")) {
            responseProbeHydrationStates.push(hydrated);
            if (!reloaded) {
              return new Promise(() => undefined);
            }
            return { result: { type: "object", value: complete } };
          }
          if (params.awaitPromise) {
            return { result: { type: "object", value: reloaded ? complete : partial } };
          }
          if (expression.includes("Find the LAST assistant turn")) {
            return { result: { value: reloaded } };
          }
          return { result: { value: false } };
        }),
        terminateExecution: vi.fn().mockResolvedValue(undefined),
      };
      const Page = {
        navigate: vi.fn(async () => {
          reloaded = true;
          setTimeout(() => {
            hydrated = true;
          }, 250);
          return {};
        }),
      };

      const promise = __test__.waitForAssistantResponseWithReload(
        Runtime as never,
        Page as never,
        3_000,
        vi.fn() as never,
        undefined,
        "synthetic-recovery",
        "https://chatgpt.com/c/synthetic-recovery",
      );
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(promise).resolves.toMatchObject({ text: complete.text });
      expect(Page.navigate).toHaveBeenCalledOnce();
      expect(responseProbeHydrationStates).toEqual([false, true]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("browser follow-ups", () => {
  test("rejects direct attachment basename collisions before launching Chrome", async () => {
    await expect(
      runBrowserMode({
        prompt: "test",
        attachments: [
          { path: "/tmp/first/SKILL.md", displayPath: "first/SKILL.md" },
          { path: "/tmp/second/SKILL.md", displayPath: "second/SKILL.md" },
        ],
      }),
    ).rejects.toMatchObject({
      details: {
        stage: "upload",
        code: "attachment-basename-collision",
        collisions: [
          {
            basename: "SKILL.md",
            files: ["first/SKILL.md", "second/SKILL.md"],
          },
        ],
        files: ["first/SKILL.md", "second/SKILL.md"],
      },
    });
  });

  test("rejects copy-profile with manual-login before launching Chrome", async () => {
    await expect(
      runBrowserMode({
        prompt: "test",
        config: {
          manualLogin: true,
          copyProfileSource: "/tmp/source-profile",
        },
      }),
    ).rejects.toThrow(/cannot be combined.*browser-manual-login/i);
  });

  test("rejects copy-profile with existing-browser modes before connecting", async () => {
    await expect(
      runBrowserMode({
        prompt: "test",
        config: {
          attachRunning: true,
          copyProfileSource: "/tmp/source-profile",
        },
      }),
    ).rejects.toThrow(/cannot be combined.*remote Chrome/i);
    await expect(
      runBrowserMode({
        prompt: "test",
        config: {
          remoteChrome: { host: "127.0.0.1", port: 9222 },
          copyProfileSource: "/tmp/source-profile",
        },
      }),
    ).rejects.toThrow(/cannot be combined.*remote Chrome/i);
  });

  test("rejects Deep Research follow-ups before launching Chrome", async () => {
    await expect(
      runBrowserMode({
        prompt: "research this",
        followUpPrompts: ["now challenge the report"],
        config: { researchMode: "deep" },
      }),
    ).rejects.toThrow(/follow-ups are not supported with Deep Research/i);
  });
});

describe("browser conversation archiving", () => {
  test("archives interrupted project one-shots in auto mode", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValueOnce({
        result: {
          value: {
            status: "archived",
            conversationUrl: "https://chatgpt.com/g/g-p-demo/project/c/abc",
          },
        },
      }),
    };
    const log = vi.fn();

    await expect(
      maybeArchiveInterruptedConversationForTest({
        Runtime: runtime as never,
        logger: log as never,
        config: resolveBrowserConfig({
          archiveConversations: "auto",
          chatgptUrl: "https://chatgpt.com/g/g-p-demo/project",
        }),
        accountDigest: "a".repeat(64),
        conversationUrl: "https://chatgpt.com/g/g-p-demo/project/c/abc",
        followUpCount: 0,
      }),
    ).resolves.toMatchObject({
      mode: "auto",
      attempted: true,
      archived: true,
      conversationUrl: "https://chatgpt.com/g/g-p-demo/project/c/abc",
    });
    expect(runtime.evaluate).toHaveBeenCalledTimes(1);
  });

  test("does not archive a completed remote run after the account changes", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValueOnce({
        result: {
          value: {
            status: "skipped",
            reason: "affinity-mismatch",
            conversationUrl: "https://chatgpt.com/c/abc",
          },
        },
      }),
    };

    await expect(
      maybeArchiveCompletedConversationForTest({
        Runtime: runtime as never,
        logger: vi.fn() as never,
        config: resolveBrowserConfig({
          archiveConversations: "always",
          remoteChrome: { host: "127.0.0.1", port: 9223 },
          remoteChromeBrowserId: "browser-a",
          remoteChromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
          remoteChromeAccountDigest: "a".repeat(64),
        }),
        accountDigest: "a".repeat(64),
        conversationUrl: "https://chatgpt.com/c/abc",
        followUpCount: 0,
        requiredArtifactsSaved: true,
      }),
    ).resolves.toMatchObject({
      attempted: false,
      archived: false,
      reason: "affinity-mismatch",
    });
    expect(runtime.evaluate).toHaveBeenCalledTimes(1);
  });

  test("does not archive a completed run after the conversation changes", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValueOnce({
        result: {
          value: {
            status: "skipped",
            reason: "affinity-mismatch",
            conversationUrl: "https://chatgpt.com/c/other",
          },
        },
      }),
    };

    await expect(
      maybeArchiveCompletedConversationForTest({
        Runtime: runtime as never,
        logger: vi.fn() as never,
        config: resolveBrowserConfig({ archiveConversations: "always" }),
        accountDigest: "a".repeat(64),
        conversationUrl: "https://chatgpt.com/c/abc",
        followUpCount: 0,
        requiredArtifactsSaved: true,
      }),
    ).resolves.toMatchObject({
      attempted: false,
      archived: false,
      reason: "affinity-mismatch",
      conversationUrl: "https://chatgpt.com/c/abc",
    });
    expect(runtime.evaluate).toHaveBeenCalledTimes(1);
  });

  test("does not substitute the current conversation during interrupted archiving", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValueOnce({
        result: {
          value: {
            status: "skipped",
            reason: "affinity-mismatch",
            conversationUrl: "https://chatgpt.com/c/other",
          },
        },
      }),
    };

    await expect(
      maybeArchiveInterruptedConversationForTest({
        Runtime: runtime as never,
        logger: vi.fn() as never,
        config: resolveBrowserConfig({ archiveConversations: "always" }),
        accountDigest: "a".repeat(64),
        conversationUrl: "https://chatgpt.com/c/abc",
        followUpCount: 0,
      }),
    ).resolves.toMatchObject({
      attempted: false,
      archived: false,
      reason: "affinity-mismatch",
      conversationUrl: "https://chatgpt.com/c/abc",
    });
    expect(runtime.evaluate).toHaveBeenCalledTimes(1);
  });

  test("does not archive any run without an originating account digest", async () => {
    const runtime = { evaluate: vi.fn() };

    await expect(
      maybeArchiveCompletedConversationForTest({
        Runtime: runtime as never,
        logger: vi.fn() as never,
        config: resolveBrowserConfig({ archiveConversations: "always" }),
        conversationUrl: "https://chatgpt.com/c/abc",
        followUpCount: 0,
        requiredArtifactsSaved: true,
      }),
    ).resolves.toMatchObject({
      attempted: false,
      archived: false,
      reason: "affinity-mismatch",
    });
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });

  test("does not archive any run with a malformed originating account digest", async () => {
    const runtime = { evaluate: vi.fn() };

    await expect(
      maybeArchiveCompletedConversationForTest({
        Runtime: runtime as never,
        logger: vi.fn() as never,
        config: resolveBrowserConfig({ archiveConversations: "always" }),
        accountDigest: "not-a-digest",
        conversationUrl: "https://chatgpt.com/c/abc",
        followUpCount: 0,
        requiredArtifactsSaved: true,
      }),
    ).resolves.toMatchObject({
      attempted: false,
      archived: false,
      reason: "affinity-mismatch",
    });
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });

  test("archives once when the bound account and conversation still match", async () => {
    const accountDigest = "a".repeat(64);
    const conversationUrl = "https://chatgpt.com/c/abc";
    const runtime = {
      evaluate: vi.fn().mockResolvedValueOnce({
        result: { value: { status: "archived", conversationUrl } },
      }),
    };

    await expect(
      maybeArchiveCompletedConversationForTest({
        Runtime: runtime as never,
        logger: vi.fn() as never,
        config: resolveBrowserConfig({
          archiveConversations: "always",
          remoteChrome: { host: "127.0.0.1", port: 9223 },
          remoteChromeBrowserId: "browser-a",
          remoteChromeBrowserWSEndpoint: "ws://127.0.0.1:9223/devtools/browser/browser-a",
          remoteChromeAccountDigest: accountDigest,
        }),
        accountDigest,
        conversationUrl,
        followUpCount: 0,
        requiredArtifactsSaved: true,
      }),
    ).resolves.toMatchObject({
      attempted: true,
      archived: true,
      conversationUrl,
    });
    expect(runtime.evaluate).toHaveBeenCalledTimes(1);
  });

  test("does not attempt interrupted archive before a conversation exists", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValueOnce({
        result: { value: "https://chatgpt.com/g/g-p-demo/project" },
      }),
    };

    await expect(
      maybeArchiveInterruptedConversationForTest({
        Runtime: runtime as never,
        logger: vi.fn() as never,
        config: resolveBrowserConfig({
          archiveConversations: "auto",
          chatgptUrl: "https://chatgpt.com/g/g-p-demo/project",
        }),
        conversationUrl: "https://chatgpt.com/g/g-p-demo/project",
        followUpCount: 0,
      }),
    ).resolves.toBeNull();
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });

  test("does not attempt archive when required local artifacts were not saved", async () => {
    const runtime = {
      evaluate: vi.fn(),
    };
    const log = vi.fn();

    await expect(
      maybeArchiveCompletedConversationForTest({
        Runtime: runtime as never,
        logger: log as never,
        config: resolveBrowserConfig({ archiveConversations: "always" }),
        conversationUrl: "https://chatgpt.com/c/abc",
        followUpCount: 0,
        requiredArtifactsSaved: false,
      }),
    ).resolves.toMatchObject({
      mode: "always",
      attempted: false,
      archived: false,
      reason: "artifact-save-failed",
    });
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });
});

describe("remote Chrome option warnings", () => {
  test("does not mark browser-chrome-path as ignored for attach-running", () => {
    expect(
      __test__.listIgnoredRemoteChromeFlags({
        attachRunning: true,
        chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }),
    ).not.toContain("--browser-chrome-path");
  });

  test("marks browser-chrome-path as ignored for classic remote-chrome", () => {
    expect(
      __test__.listIgnoredRemoteChromeFlags({
        attachRunning: false,
        chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }),
    ).toContain("--browser-chrome-path");
  });

  test("marks browser-headless as ignored for classic remote-chrome", () => {
    expect(
      __test__.listIgnoredRemoteChromeFlags({
        attachRunning: false,
        headless: true,
      }),
    ).toContain("--browser-headless");
  });
});

describe("remote Chrome cleanup", () => {
  test("unrefs a kept browser so the CLI can exit after preserving Chrome", () => {
    const unref = vi.fn();

    __test__.detachKeptChromeProcess({
      process: { unref } as never,
    });

    expect(unref).toHaveBeenCalledTimes(1);
  });

  test("closes the dedicated target after a completed run", async () => {
    const closeConnection = vi.fn().mockResolvedValue(undefined);
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: false,
      connection: { close: closeConnection },
      client: { close: closeClient },
      preserveTarget: false,
    });

    expect(closeConnection).toHaveBeenCalledTimes(1);
    expect(closeClient).not.toHaveBeenCalled();
  });

  test("disconnects the browser transport while retaining an incomplete target", async () => {
    const closeConnection = vi.fn().mockResolvedValue(undefined);
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: false,
      connection: { close: closeConnection },
      client: { close: closeClient },
      preserveTarget: true,
    });

    expect(closeConnection).toHaveBeenCalledExactlyOnceWith({ preserveTarget: true });
    expect(closeClient).not.toHaveBeenCalled();
  });

  test("detaches raw target clients when a run attaches to an existing remote tab", async () => {
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: false,
      connection: null,
      client: { close: closeClient },
      preserveTarget: false,
    });

    expect(closeClient).toHaveBeenCalledTimes(1);
  });

  test("releases an already-lost connection without closing its target", async () => {
    const closeConnection = vi.fn().mockResolvedValue(undefined);
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: true,
      connection: { close: closeConnection },
      client: { close: closeClient },
      preserveTarget: true,
    });

    expect(closeConnection).toHaveBeenCalledExactlyOnceWith({ preserveTarget: true });
    expect(closeClient).not.toHaveBeenCalled();
  });
});

describe("image-only assistant turn detection", () => {
  test("treats ChatGPT image-only chrome text as non-answer UI", () => {
    expect(__test__.isImageOnlyUiChromeText("Stopped thinking\nEdit")).toBe(true);
    expect(__test__.isImageOnlyUiChromeText("Edit")).toBe(true);
    expect(__test__.isImageOnlyUiChromeText("Thought for 12s Edit")).toBe(true);
    expect(__test__.isImageOnlyUiChromeText("Reasoning Thought for 12s Edit")).toBe(true);
    expect(__test__.isImageOnlyUiChromeText("Pro thinking Thought for 3.5s Edit")).toBe(true);
    expect(__test__.isImageOnlyUiChromeText("PR169_IMAGE_OK")).toBe(false);
  });
});

describe("redactBrowserConfigForDebugLogForTest", () => {
  test("redacts inline cookies and private browser affinity while preserving safe context", () => {
    const redacted = redactBrowserConfigForDebugLogForTest({
      inlineCookies: [
        { name: "__Secure-next-auth.session-token", value: "secret-token" },
        { name: "_account", value: "secret-account" },
      ],
      inlineCookiesSource: "inline-file",
      remoteChrome: { host: "127.0.0.1", port: 9222 },
      remoteChromeBrowserWSEndpoint: "wss://private.example/devtools/browser/secret",
      remoteChromeAccountDigest: "a".repeat(64),
      expectedAccountDigest: "b".repeat(64),
      expectedEmail: "owner@example.com",
      remoteChromeProfileRoot: "/private/profile/root",
      browserTabRef: "tab-secret",
      resumeConversationUrl: "https://chatgpt.com/g/private/project/c/private-thread",
      debug: true,
      metadata: { sessionToken: "nested-session-secret", safe: "visible" },
      nested: { cookies: { value: "nested-cookie-secret" }, token: "nested-token-secret" },
    });

    expect(redacted).toMatchObject({
      inlineCookies: "[redacted:2 cookies]",
      inlineCookieCount: 2,
      inlineCookiesSource: "inline-file",
      remoteChrome: true,
      remoteChromeBrowserWSEndpoint: true,
      remoteChromeAccountDigest: true,
      expectedAccountDigest: true,
      expectedEmail: true,
      remoteChromeProfileRoot: true,
      browserTabRef: true,
      resumeConversationUrl: true,
      debug: true,
      metadata: { sessionToken: true, safe: "visible" },
      nested: { cookies: true, token: true },
    });
    const serialized = JSON.stringify(redacted);
    for (const secret of [
      "secret-token",
      "secret-account",
      "private.example",
      "owner@example.com",
      "/private/profile/root",
      "private-thread",
      "nested-session-secret",
      "nested-cookie-secret",
      "nested-token-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("leaves missing inline cookies unchanged", () => {
    expect(redactBrowserConfigForDebugLog({ debug: true })).toEqual({ debug: true });
  });
});

describe("shouldPreferSystemTmpDirForTest", () => {
  test("prefers /tmp for Linux tmpdirs under a hidden home segment", () => {
    expect(shouldPreferSystemTmpDirForTest("linux", "/home/openclaw/.tmp", "/home/openclaw")).toBe(
      true,
    );
    expect(
      shouldPreferSystemTmpDirForTest("linux", "/home/openclaw/.cache/tmp", "/home/openclaw"),
    ).toBe(true);
  });

  test("keeps normal Linux tmpdirs and non-Linux platforms unchanged", () => {
    expect(shouldPreferSystemTmpDirForTest("linux", "/tmp", "/home/openclaw")).toBe(false);
    expect(shouldPreferSystemTmpDirForTest("linux", "/home/openclaw/tmp", "/home/openclaw")).toBe(
      false,
    );
    expect(shouldPreferSystemTmpDirForTest("darwin", "/Users/me/.tmp", "/Users/me")).toBe(false);
  });

  test("does not treat sibling home paths as inside the home directory", () => {
    expect(shouldPreferSystemTmpDirForTest("linux", "/home/openclaw2/.tmp", "/home/openclaw")).toBe(
      false,
    );
  });
});

describe("runSubmissionWithRecoveryForTest", () => {
  test("rejects colliding fallback basenames before preparing or submitting fallback", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large", { code: "prompt-too-large" }),
      );
    const prepareFallbackSubmission = vi.fn().mockResolvedValue(undefined);

    await expect(
      runSubmissionWithRecoveryForTest({
        prompt: "inline prompt",
        attachments: [],
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [
            { path: "/tmp/first/SKILL.md", displayPath: "first/SKILL.md", sizeBytes: 5 },
            { path: "/tmp/second/SKILL.md", displayPath: "second/SKILL.md", sizeBytes: 6 },
          ],
        },
        submit,
        reloadPromptComposer: vi.fn().mockResolvedValue(undefined),
        prepareFallbackSubmission,
        logger: vi.fn<(message: string) => void>(),
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        'inline prompt was too large, but its upload fallback cannot safely include multiple files named "SKILL.md"',
      ),
      details: {
        stage: "upload-fallback",
        code: "attachment-basename-collision",
        collisions: [
          {
            basename: "SKILL.md",
            files: ["first/SKILL.md", "second/SKILL.md"],
          },
        ],
        files: ["first/SKILL.md", "second/SKILL.md"],
      },
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("inline prompt", []);
    expect(prepareFallbackSubmission).not.toHaveBeenCalled();
  });

  test("preserves prompt-too-large fallback after a dead-composer retry", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new BrowserAutomationError("dead composer", { code: "dead-composer" }))
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large", { code: "prompt-too-large" }),
      )
      .mockResolvedValueOnce({
        baselineTurns: 7,
        baselineAssistantText: "done",
      });
    const reloadPromptComposer = vi.fn().mockResolvedValue(undefined);
    const prepareFallbackSubmission = vi.fn().mockResolvedValue(undefined);
    const logger = vi.fn<(message: string) => void>();

    await expect(
      runSubmissionWithRecoveryForTest({
        prompt: "inline prompt",
        attachments: [],
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [{ path: "/tmp/fallback.txt", displayPath: "fallback.txt", sizeBytes: 12 }],
        },
        submit,
        reloadPromptComposer,
        prepareFallbackSubmission,
        logger,
      }),
    ).resolves.toEqual({
      baselineTurns: 7,
      baselineAssistantText: "done",
    });

    expect(reloadPromptComposer).toHaveBeenCalledTimes(1);
    expect(prepareFallbackSubmission).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      "[browser] Inline prompt too large; retrying with file uploads.",
    );
    expect(submit).toHaveBeenNthCalledWith(1, "inline prompt", []);
    expect(submit).toHaveBeenNthCalledWith(2, "inline prompt", []);
    expect(submit).toHaveBeenNthCalledWith(3, "fallback prompt", [
      expect.objectContaining({ displayPath: "fallback.txt" }),
    ]);
  });

  test("materializes fallback attachments before retrying a prompt-too-large submit", async () => {
    const fallbackSubmission = {
      prompt: "unbundled fallback",
      attachments: [{ path: "/tmp/one.txt", displayPath: "one.txt", sizeBytes: 3 }],
      prepare: vi.fn(async () => {
        fallbackSubmission.prompt = "bundled fallback";
        fallbackSubmission.attachments = [
          {
            path: "/tmp/attachments-bundle.zip",
            displayPath: "attachments-bundle.zip",
            sizeBytes: 12,
          },
        ];
      }),
    };
    const submit = vi
      .fn()
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large", { code: "prompt-too-large" }),
      )
      .mockResolvedValueOnce({
        baselineTurns: 1,
        baselineAssistantText: "ok",
      });

    await runSubmissionWithRecoveryForTest({
      prompt: "inline prompt",
      attachments: [],
      fallbackSubmission,
      submit,
      reloadPromptComposer: vi.fn().mockResolvedValue(undefined),
      prepareFallbackSubmission: vi.fn().mockResolvedValue(undefined),
      logger: vi.fn<(message: string) => void>(),
    });

    expect(fallbackSubmission.prepare).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenNthCalledWith(2, "bundled fallback", [
      expect.objectContaining({ displayPath: "attachments-bundle.zip" }),
    ]);
  });

  test("throws when prompt-too-large happens again after fallback", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large", { code: "prompt-too-large" }),
      )
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large again", { code: "prompt-too-large" }),
      );

    await expect(
      runSubmissionWithRecoveryForTest({
        prompt: "inline prompt",
        attachments: [],
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [],
        },
        submit,
        reloadPromptComposer: vi.fn().mockResolvedValue(undefined),
        prepareFallbackSubmission: vi.fn().mockResolvedValue(undefined),
        logger: vi.fn<(message: string) => void>(),
      }),
    ).rejects.toThrow(/prompt too large again/i);
  });
});

describe("resolveRemoteTabLeaseProfileDirForTest", () => {
  test("coordinates remote Chrome only when a manual-login profile is configured", () => {
    const coordinated = resolveBrowserConfig({
      remoteChrome: { host: "127.0.0.1", port: 9222 },
      manualLogin: true,
      manualLoginProfileDir: "/tmp/oracle-profile",
    });
    expect(resolveRemoteTabLeaseProfileDirForTest(coordinated)).toBe(
      path.resolve("/tmp/oracle-profile"),
    );

    const uncoordinated = resolveBrowserConfig({
      remoteChrome: { host: "127.0.0.1", port: 9222 },
      manualLogin: false,
      manualLoginProfileDir: "/tmp/oracle-profile",
    });
    expect(resolveRemoteTabLeaseProfileDirForTest(uncoordinated)).toBeNull();
  });
});

describe("isLocalChromeHostForTest", () => {
  test.each(["localhost", "LOCALHOST", "127.0.0.1", "127.12.34.56", "::1", "[::1]"])(
    "accepts loopback host %s",
    (host) => {
      expect(isLocalChromeHostForTest(host)).toBe(true);
    },
  );

  test.each(["remote-host", "192.168.1.5", "10.0.0.2", "2001:db8::1"])(
    "rejects remote host %s",
    (host) => {
      expect(isLocalChromeHostForTest(host)).toBe(false);
    },
  );
});
