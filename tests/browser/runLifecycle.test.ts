import { describe, expect, test, vi } from "vitest";
import type { BrowserRuntimeMetadata } from "../../src/sessionManager.js";
import {
  BrowserRunLifecycleController,
  completedBrowserCaptureCleanup,
  pendingBrowserCaptureCleanup,
} from "../../src/browser/runLifecycle.js";

const committedVerification = {
  committedTurns: 1,
  verifiedUserTurnIndex: 0,
  conversationId: "captured-conversation",
};

function remoteRuntime(): BrowserRuntimeMetadata {
  return {
    browserTransport: "cdp",
    chromeHost: "remote.example",
    chromePort: 9222,
    chromeTargetId: "owned-target",
    tabUrl: "https://chatgpt.com/c/captured-conversation",
    recoveryCleanup: {
      transport: "remote",
      ownsTarget: true,
      profileKind: "none",
      keepBrowser: false,
    },
  };
}

describe("BrowserRunLifecycleController", () => {
  test("enforces acquire, dispatch, verify, capture, publication, and finalization phases", async () => {
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
    expect(lifecycle.phase()).toMatchObject({
      kind: "dispatching",
      epoch: { status: "pending", baselineTurns: 0 },
    });
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
    expect(lifecycle.phase()).toMatchObject({
      kind: "capturing",
      epoch: { status: "committed", conversationId: "captured-conversation" },
    });

    const transaction = lifecycle.issueCapture({
      answerText: "captured answer",
      answerMarkdown: "captured answer",
      tookMs: 1,
      answerTokens: 2,
      answerChars: 15,
    });

    expect(lifecycle.phase()).toEqual({ kind: "caller-publication" });
    expect(transaction.promptSubmitted).toBe(true);
    expect(transaction.promptEpoch).toMatchObject({ status: "committed" });
    expect(transaction.runtime.recoveryCleanupResult).toEqual({ status: "pending" });
    expect(settleResources).not.toHaveBeenCalled();
    expect(await lifecycle.settleIfUnpublished()).toBeNull();

    await transaction.finalize();
    await transaction.abort();

    expect(settleResources).toHaveBeenCalledTimes(1);
    expect(settleResources).toHaveBeenCalledWith(
      "finalize",
      expect.objectContaining({ recoveryCleanupResult: { status: "pending" } }),
    );
    expect(lifecycle.phase()).toEqual({ kind: "completed", mode: "finalize" });
    expect(persistRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        promptSubmitted: true,
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
    await lifecycle.recordPromptCommitVerification(committedVerification, firstIdentity);
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
          conversationId: "second-conversation",
        },
        firstIdentity,
      ),
    ).rejects.toThrow(/current prompt epoch/i);

    await lifecycle.recordPromptCommitVerification(
      {
        committedTurns: 3,
        verifiedUserTurnIndex: 2,
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
          promptSubmitted: false,
          promptEpoch: { status: "pending" },
        },
      },
    });
    expect(lifecycle.phase()).toMatchObject({
      kind: "dispatching",
      epoch: { status: "pending" },
    });
  });

  test("records failed cleanup as an explicit pending-cleanup terminal phase", async () => {
    const lifecycle = new BrowserRunLifecycleController({
      getRuntime: remoteRuntime,
      settleResources: async (_mode, runtime) =>
        pendingBrowserCaptureCleanup(runtime, "target close was not confirmed"),
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

    const finalization = await transaction.abort();

    expect(finalization).toMatchObject({
      status: "pending",
      error: "target close was not confirmed",
    });
    expect(lifecycle.phase()).toEqual({
      kind: "cleanup-pending",
      mode: "abort",
      error: "target close was not confirmed",
    });
  });
});
