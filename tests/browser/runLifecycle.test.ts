import { describe, expect, test, vi } from "vitest";
import type { BrowserRuntimeMetadata } from "../../src/sessionManager.js";
import {
  BrowserRunLifecycleController,
  completedBrowserCaptureCleanup,
  pendingBrowserCaptureCleanup,
} from "../../src/browser/runLifecycle.js";
import { promptIdentitySha256 } from "../../src/browser/actions/promptComposer.js";

const committedVerification = {
  committedTurns: 1,
  promptSha256: promptIdentitySha256("review"),
  verifiedUserTurnIndex: 0,
  verifiedUserTurnId: "turn-0",
  verifiedUserMessageId: "message-0",
  conversationId: "captured-conversation",
};

function remoteRuntime(): BrowserRuntimeMetadata {
  return {
    browserTransport: "cdp",
    chromeHost: "remote.example",
    chromePort: 9222,
    chromeTargetId: "owned-target",
    tabUrl: "https://chatgpt.com/c/captured-conversation",
    recoveryCleanupResources: [
      {
        chromeHost: "remote.example",
        chromePort: 9222,
        chromeTargetId: "owned-target",
        recoveryCleanup: {
          ownsTarget: true,
          profileKind: "none",
          keepBrowser: false,
          closeOwnedTargetOnComplete: true,
        },
      },
    ],
  };
}

describe("BrowserRunLifecycleController", () => {
  test("enforces acquisition, dispatch verification, capture publication, and finalization", async () => {
    const persistRuntime = vi.fn(async (_runtime: BrowserRuntimeMetadata) => undefined);
    const settleResources = vi.fn(
      async (_mode: "finalize" | "abort", runtime: BrowserRuntimeMetadata) =>
        completedBrowserCaptureCleanup(runtime),
    );
    const lifecycle = new BrowserRunLifecycleController({
      getRuntime: remoteRuntime,
      persistRuntime,
      settleResources,
    });

    await expect(lifecycle.beginPromptDispatch("review", 0, 0, 0)).rejects.toMatchObject({
      details: { code: "browser-run-lifecycle-transition-invalid", phase: "acquiring" },
    });

    lifecycle.markAcquired();
    await lifecycle.resetPrompt();
    const identity = await lifecycle.beginPromptDispatch("review", 0, 0, 0);
    expect(lifecycle.promptDispatch()).toMatchObject({
      status: "pending",
      prompt: "review",
      baselineTurns: 0,
    });
    expect(lifecycle.promptEpoch()).toMatchObject({ status: "pending", baselineTurns: 0 });
    expect(() =>
      lifecycle.issueCapture({
        answerText: "unverified answer",
        answerMarkdown: "unverified answer",
        tookMs: 1,
        answerTokens: 2,
        answerChars: 17,
      }),
    ).toThrow(/dispatching phase/i);

    await lifecycle.recordPromptCommitVerification(committedVerification, identity);
    expect(lifecycle.promptDispatch()).toMatchObject({ status: "committed" });
    expect(lifecycle.promptEpoch()).toMatchObject({
      status: "committed",
      conversationId: "captured-conversation",
    });

    const transaction = lifecycle.issueCapture({
      answerText: "captured answer",
      answerMarkdown: "captured answer",
      tookMs: 1,
      answerTokens: 2,
      answerChars: 15,
    });

    expect(transaction.promptEpoch).toMatchObject({ status: "committed" });
    expect(transaction.runtime.recoveryCleanupResult).toEqual({ status: "pending" });
    expect(transaction.runtime.recoveryCleanupResources).toEqual([
      expect.objectContaining({
        conversationId: "captured-conversation",
        promptEpoch: expect.objectContaining({
          status: "committed",
          verifiedUserTurnId: "turn-0",
          verifiedUserMessageId: "message-0",
        }),
      }),
    ]);
    expect(settleResources).not.toHaveBeenCalled();
    expect(await lifecycle.settleIfUnpublished()).toBeNull();

    const finalization = await transaction.finalize();
    await expect(transaction.abort()).rejects.toMatchObject({
      details: {
        code: "browser-run-lifecycle-settlement-conflict",
        requestedMode: "abort",
        boundMode: "finalize",
      },
    });

    expect(settleResources).toHaveBeenCalledTimes(1);
    expect(settleResources).toHaveBeenCalledWith(
      "finalize",
      expect.objectContaining({
        recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
      }),
    );
    expect(finalization.status).toBe("completed");
    expect(persistRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        promptEpoch: expect.objectContaining({ status: "committed" }),
      }),
    );
  });

  test("resets committed authority before a follow-up and rejects superseded evidence", async () => {
    const lifecycle = new BrowserRunLifecycleController({
      getRuntime: remoteRuntime,
      settleResources: async (_mode, runtime) => completedBrowserCaptureCleanup(runtime),
    });
    lifecycle.markAcquired();

    const firstIdentity = await lifecycle.beginPromptDispatch("first prompt", 0, 0, 1);
    await lifecycle.recordPromptCommitVerification(
      { ...committedVerification, promptSha256: firstIdentity.promptSha256 },
      firstIdentity,
    );
    await lifecycle.resetPrompt();
    const secondIdentity = await lifecycle.beginPromptDispatch("second prompt", 2, 1, 0);

    expect(lifecycle.isPromptCommitted()).toBe(false);
    expect(lifecycle.promptDispatch()).toMatchObject({
      status: "pending",
      prompt: "second prompt",
      baselineTurns: 2,
      followUpOrdinal: 1,
      remainingFollowUps: 0,
    });
    await expect(
      lifecycle.recordPromptCommitVerification(
        {
          committedTurns: 3,
          verifiedUserTurnIndex: 2,
          verifiedUserTurnId: "turn-2",
          verifiedUserMessageId: "message-2",
          promptSha256: secondIdentity.promptSha256,
          conversationId: "second-conversation",
        },
        firstIdentity,
      ),
    ).rejects.toThrow(/current prompt epoch/i);

    await lifecycle.recordPromptCommitVerification(
      {
        committedTurns: 3,
        verifiedUserTurnIndex: 2,
        verifiedUserTurnId: "turn-2",
        verifiedUserMessageId: "message-2",
        promptSha256: secondIdentity.promptSha256,
        conversationId: "second-conversation",
      },
      secondIdentity,
    );
    expect(lifecycle.isPromptCommitted()).toBe(true);
  });

  test("restores pending authority when committed evidence is not durable", async () => {
    const persistRuntime = vi
      .fn(async (_runtime: BrowserRuntimeMetadata) => undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("session store unavailable"));
    const lifecycle = new BrowserRunLifecycleController({
      getRuntime: remoteRuntime,
      persistRuntime,
      settleResources: async (_mode, runtime) => completedBrowserCaptureCleanup(runtime),
    });
    lifecycle.markAcquired();
    const identity = await lifecycle.beginPromptDispatch("review", 0, 0, 0);

    await expect(
      lifecycle.recordPromptCommitVerification(committedVerification, identity),
    ).rejects.toMatchObject({
      details: {
        code: "prompt-epoch-persistence-failed",
        runtime: {
          promptEpoch: { status: "pending" },
        },
      },
    });
    expect(lifecycle.promptDispatch()).toMatchObject({ status: "pending", prompt: "review" });
    expect(lifecycle.promptEpoch()).toMatchObject({ status: "pending" });
  });

  test.each([
    { mode: "finalize" as const, oppositeMode: "abort" as const },
    { mode: "abort" as const, oppositeMode: "finalize" as const },
  ])(
    "retries pending $mode cleanup in the bound mode using the latest runtime",
    async ({ mode, oppositeMode }) => {
      const settleResources = vi
        .fn(async (_mode: "finalize" | "abort", runtime: BrowserRuntimeMetadata) =>
          completedBrowserCaptureCleanup(runtime),
        )
        .mockImplementationOnce(async (_mode, runtime) =>
          pendingBrowserCaptureCleanup(
            {
              ...runtime,
              chromeTargetId: "retry-target",
              recoveryCleanupResources: runtime.recoveryCleanupResources?.map((resource) => ({
                ...resource,
                chromeTargetId: "retry-target",
              })),
            },
            "target close was not confirmed",
          ),
        );
      const lifecycle = new BrowserRunLifecycleController({
        getRuntime: remoteRuntime,
        settleResources,
      });
      lifecycle.markAcquired();
      const identity = await lifecycle.beginPromptDispatch("review", 0, 0, 0);
      await lifecycle.recordPromptCommitVerification(committedVerification, identity);
      const transaction = lifecycle.issueCapture({
        answerText: "captured answer",
        answerMarkdown: "captured answer",
        tookMs: 1,
        answerTokens: 2,
        answerChars: 15,
      });

      const first = await transaction[mode]();

      expect(first).toMatchObject({
        status: "pending",
        error: "target close was not confirmed",
        runtime: {
          chromeTargetId: "retry-target",
          recoveryCleanupResources: [expect.objectContaining({ chromeTargetId: "retry-target" })],
          recoveryCleanupResult: {
            status: "failed",
            error: "target close was not confirmed",
            settlementMode: mode,
          },
        },
      });
      await expect(transaction[oppositeMode]()).rejects.toMatchObject({
        details: {
          code: "browser-run-lifecycle-settlement-conflict",
          requestedMode: oppositeMode,
          boundMode: mode,
        },
      });

      const second = await transaction[mode]();
      const cached = await transaction[mode]();

      expect(second).toMatchObject({
        status: "completed",
        runtime: { chromeTargetId: "retry-target" },
      });
      expect(cached).toBe(second);
      expect(settleResources).toHaveBeenCalledTimes(2);
      expect(settleResources).toHaveBeenNthCalledWith(
        2,
        mode,
        expect.objectContaining({
          chromeTargetId: "retry-target",
          recoveryCleanupResult: {
            status: "pending",
            settlementMode: mode,
          },
          recoveryCleanupResources: [expect.objectContaining({ chromeTargetId: "retry-target" })],
        }),
      );
    },
  );

  test.each(["finalize", "abort"] as const)(
    "persists %s authority before cleanup side effects",
    async (mode) => {
      const events: string[] = [];
      const persistRuntime = vi.fn(async (runtime: BrowserRuntimeMetadata) => {
        events.push(`persist:${runtime.recoveryCleanupResult?.settlementMode ?? "unbound"}`);
      });
      const settleResources = vi.fn(
        async (settlementMode: "finalize" | "abort", runtime: BrowserRuntimeMetadata) => {
          events.push(`cleanup:${settlementMode}`);
          return completedBrowserCaptureCleanup(runtime);
        },
      );
      const lifecycle = new BrowserRunLifecycleController({
        getRuntime: remoteRuntime,
        persistRuntime,
        settleResources,
      });
      lifecycle.markAcquired();
      const identity = await lifecycle.beginPromptDispatch("review", 0, 0, 0);
      await lifecycle.recordPromptCommitVerification(committedVerification, identity);
      const transaction = lifecycle.issueCapture({
        answerText: "captured answer",
        answerMarkdown: "captured answer",
        tookMs: 1,
        answerTokens: 2,
        answerChars: 15,
      });
      events.length = 0;

      await transaction[mode]();

      expect(events).toEqual([`persist:${mode}`, `cleanup:${mode}`]);
      expect(persistRuntime).toHaveBeenLastCalledWith(
        expect.objectContaining({
          recoveryCleanupResult: { status: "pending", settlementMode: mode },
        }),
      );
    },
  );

  test("does not start cleanup when bound runtime persistence fails", async () => {
    const persistenceError = new Error("session runtime store unavailable");
    const persistRuntime = vi.fn(async (runtime: BrowserRuntimeMetadata) => {
      if (runtime.recoveryCleanupResult?.settlementMode === "finalize") {
        throw persistenceError;
      }
    });
    const settleResources = vi.fn(
      async (_mode: "finalize" | "abort", runtime: BrowserRuntimeMetadata) =>
        completedBrowserCaptureCleanup(runtime),
    );
    const lifecycle = new BrowserRunLifecycleController({
      getRuntime: remoteRuntime,
      persistRuntime,
      settleResources,
    });
    lifecycle.markAcquired();
    const identity = await lifecycle.beginPromptDispatch("review", 0, 0, 0);
    await lifecycle.recordPromptCommitVerification(committedVerification, identity);
    const transaction = lifecycle.issueCapture({
      answerText: "captured answer",
      answerMarkdown: "captured answer",
      tookMs: 1,
      answerTokens: 2,
      answerChars: 15,
    });

    await expect(transaction.finalize()).resolves.toMatchObject({
      status: "pending",
      error: persistenceError.message,
      runtime: {
        recoveryCleanupResult: {
          status: "failed",
          error: persistenceError.message,
          settlementMode: "finalize",
        },
      },
    });
    expect(settleResources).not.toHaveBeenCalled();
  });

  test("binds thrown unpublished cleanup failure to abort", async () => {
    const settleResources = vi.fn(async () => {
      throw new Error("profile removal was not confirmed");
    });
    const lifecycle = new BrowserRunLifecycleController({
      getRuntime: remoteRuntime,
      settleResources,
    });
    lifecycle.markAcquired();

    const result = await lifecycle.settleIfUnpublished();

    expect(settleResources).toHaveBeenCalledWith(
      "abort",
      expect.objectContaining({
        recoveryCleanupResult: { status: "pending", settlementMode: "abort" },
      }),
    );
    expect(result).toMatchObject({
      status: "pending",
      error: "profile removal was not confirmed",
      runtime: {
        recoveryCleanupResult: {
          status: "failed",
          error: "profile removal was not confirmed",
          settlementMode: "abort",
        },
      },
    });
  });
});
