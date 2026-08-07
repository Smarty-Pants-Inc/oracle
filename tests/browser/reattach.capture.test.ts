import { describe, expect, test, vi } from "vitest";
import { resumeBrowserSession, __test__ } from "../../src/browser/reattach.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";
import type { ChromeClient } from "../../src/browser/types.js";
import type { RecordedChromeTerminationOutcome } from "../../src/browser/profileState.js";
import { promptIdentitySha256 } from "../../src/browser/actions/committedPrompt.js";
import {
  authenticatedLocalTargetCleanupDeps,
  createTemporaryProfileFixture,
  createBrowserLogger,
  physicalChromeProcessIdentity,
  withCommittedPromptEpoch,
  withRecoveryCleanup,
  type FakeClient,
  type FakeTarget,
} from "./reattachTestHelpers.js";

function executorStyleGeminiRecoveryRuntime(options: {
  targetId: string;
  promptSha256: string;
  userId: string;
}): BrowserRuntimeMetadata {
  const generationId = `generation-${options.targetId}`;
  const promptEpoch = {
    status: "committed" as const,
    epochId: `epoch-${options.targetId}`,
    promptSha256: options.promptSha256,
    baselineTurns: 0,
    followUpOrdinal: 0,
    remainingFollowUps: 0,
    verifiedUserTurnIndex: 0,
    verifiedUserTurnId: options.userId,
    verifiedUserMessageId: options.userId,
    conversationId: options.targetId,
  };
  return {
    chromePort: 51559,
    chromeHost: "127.0.0.1",
    chromeTargetId: options.targetId,
    tabUrl: `about:blank#oracle-acquisition=${generationId}`,
    conversationId: options.targetId,
    promptEpoch,
    recoveryCleanupResources: [
      {
        chromePort: 51559,
        chromeHost: "127.0.0.1",
        chromeTargetId: options.targetId,
        conversationId: options.targetId,
        promptEpoch,
        targetCloseCapability: {
          version: 1,
          generationId,
          capabilityId: `capability-${options.targetId}`,
          targetId: options.targetId,
        },
        tabLease: {
          id: `lease-${options.targetId}`,
          generationId,
          profileDirectory: {
            version: 2,
            platform: process.platform,
            canonicalPath: `/tmp/oracle-${options.targetId}`,
            device: "1",
            inode: "2",
            birthtimeNs: "3",
          },
        },
        acquisition: {
          generationId,
          targetMarkerUrl: `about:blank#oracle-acquisition=${generationId}`,
        },
        recoveryCleanup: {
          ownsTarget: true,
          profileKind: "manual-login",
          keepBrowser: false,
          closeOwnedTargetOnComplete: true,
        },
      },
    ],
    recoveryCleanupResult: { status: "pending" },
  };
}

describe("resumeBrowserSession", { timeout: 15_000 }, () => {
  test("selects target and captures markdown via stubs", async () => {
    const { profileDir, temporaryProfileAuthority, cleanup } = await createTemporaryProfileFixture(
      "oracle-reattach-profile-",
    );
    const processIdentity = await physicalChromeProcessIdentity(profileDir);
    const runtime = withCommittedPromptEpoch(
      withRecoveryCleanup(
        {
          chromePort: 51559,
          chromeHost: "127.0.0.1",
          chromeTargetId: "target-1",
          chromeProcessIdentity: processIdentity,
          userDataDir: profileDir,
          tabUrl: "https://chatgpt.com/c/abc",
        },
        {
          ownsTarget: true,
          profileKind: "temporary",
          keepBrowser: false,
          closeOwnedTargetOnComplete: true,
        },
        undefined,
        { temporaryProfileAuthority },
      ),
    );
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
    const cleanupOrder: string[] = [];
    const close = vi.fn(async () => {
      cleanupOrder.push("connection");
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "Hello PATH plan",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "markdown response");
    const waitForConversationHydration = vi.fn(async () => 2);
    const verifyCommittedPromptTurn = vi.fn(async () => undefined);
    const terminateRecordedChromeForProfile = vi.fn(async () => ({
      status: "stopped" as const,
      pid: 1234,
      signal: "SIGTERM" as const,
    }));
    const stopped = {
      status: "stopped",
      signal: "SIGTERM",
    } satisfies RecordedChromeTerminationOutcome;
    const exactCleanupDeps = authenticatedLocalTargetCleanupDeps({
      closeTarget: () => {
        cleanupOrder.push("target");
        return { status: "completed" };
      },
      kill: (_profileDir, pid) => {
        cleanupOrder.push("terminate");
        return { ...stopped, pid };
      },
    });
    const removeProfile = vi.fn(async () => {
      cleanupOrder.push("remove-profile");
      return true;
    });
    const logger = createBrowserLogger();
    logger.verbose = true;

    const result = await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      sessionId: "test-owner",
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
      waitForConversationHydration,
      verifyCommittedPromptTurn,
      recoveryCleanup: {
        ...exactCleanupDeps,
        terminateRecordedChromeForProfile,
        removeProfile,
      },
    });

    expect(result.answerMarkdown).toBe("markdown response");
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 51559, target: "target-1" }),
    );
    expect(verifyCommittedPromptTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: "abc",
        verifiedUserTurnIndex: 1,
        verifiedUserTurnId: "turn-1",
        verifiedUserMessageId: "message-1",
      }),
    );
    expect(waitForAssistantResponse).toHaveBeenCalledWith(
      expect.anything(),
      2000,
      logger,
      2,
      "abc",
      expect.objectContaining({ conversationId: "abc", verifiedUserTurnIndex: 1 }),
    );
    expect(captureAssistantMarkdown).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageId: "m1", turnId: "conversation-turn-1" }),
      logger,
      "abc",
      expect.objectContaining({ conversationId: "abc", verifiedUserTurnIndex: 1 }),
    );
    expect(waitForConversationHydration).toHaveBeenCalledWith(expect.anything(), 2000, logger, {
      requirePriorTurns: true,
      requirePromptReady: false,
      expectedConversationUrl: runtime.tabUrl,
    });
    expect(waitForConversationHydration.mock.invocationCallOrder[0]).toBeLessThan(
      verifyCommittedPromptTurn.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(verifyCommittedPromptTurn.mock.invocationCallOrder[0]).toBeLessThan(
      waitForAssistantResponse.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(close).toHaveBeenCalledOnce();
    expect(cleanupOrder).toEqual(["connection"]);
    const finalization = await result.finalize();
    expect(finalization.status).toBe("completed");
    expect(cleanupOrder).toEqual(["connection", "target", "terminate", "remove-profile"]);
    expect(exactCleanupDeps.closeChromeTargetWithRetainedCapability).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "target-1" }),
    );
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    expect(removeProfile).toHaveBeenCalledWith(profileDir, processIdentity.profileDirectory);
    await cleanup();
  }, 15_000);

  test("harvests the exact committed Gemini provider identity after DOM history shift", async () => {
    const promptSha256 = promptIdentitySha256("New request");
    const runtime = executorStyleGeminiRecoveryRuntime({
      targetId: "gemini-target-1",
      promptSha256,
      userId: "data-message-id:user-current",
    });
    const listTargets = vi.fn(async () => [
      {
        targetId: "gemini-target-1",
        type: "page",
        url: "https://gemini.google.com/app/conversation-1",
      },
      { targetId: "foreign-target", type: "page", url: "https://gemini.google.com/app/other" },
    ]);
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "1+1") return { result: { value: 2 } };
      if (expression.includes("const ordered =")) {
        return {
          result: {
            value: JSON.stringify({
              entries: [
                {
                  kind: "user",
                  postBaseline: true,
                  text: "New request",
                  stableId: "data-message-id:user-older",
                },
                {
                  kind: "response",
                  postBaseline: true,
                  text: "wrong repeated-prompt answer",
                  stableId: "data-message-id:response-older",
                  completionMarked: true,
                  visibleSpinner: false,
                },
                {
                  kind: "user",
                  postBaseline: true,
                  text: "New request",
                  stableId: "data-message-id:user-current",
                },
                {
                  kind: "response",
                  postBaseline: true,
                  text: "exact recovered Gemini answer",
                  stableId: "data-message-id:response-current",
                  completionMarked: true,
                  visibleSpinner: false,
                },
              ],
            }),
          },
        };
      }
      return { result: { value: null } };
    });
    const close = vi.fn(async () => undefined);
    const connect = vi.fn(async () => ({
      Runtime: { enable: vi.fn(async () => undefined), evaluate },
      DOM: { enable: vi.fn(async () => undefined) },
      close,
    })) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const recoverSession = vi.fn();
    const waitForAssistantResponse = vi.fn();
    const release = vi.fn(async () => undefined);

    const result = await resumeBrowserSession(
      runtime,
      { desiredModel: "gemini-3-pro-deep-think", timeoutMs: 2_000 },
      createBrowserLogger(),
      {
        listTargets,
        connect,
        recoverSession,
        waitForAssistantResponse,
        acquireRecoveryLock: vi.fn(async () => ({ release })),
      },
    );

    expect(result.answerText).toBe("exact recovered Gemini answer");
    expect(result.answerMarkdown).toBe("exact recovered Gemini answer");
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 51559, target: "gemini-target-1" }),
    );
    expect(recoverSession).not.toHaveBeenCalled();
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    await result.abort();
  });

  test("refuses synthetic Gemini DOM authority after history shift and repeated prompt", async () => {
    const promptSha256 = promptIdentitySha256("New request");
    const syntheticUserId = `gemini-dom-turn:0:${promptSha256}`;
    const runtime = executorStyleGeminiRecoveryRuntime({
      targetId: "gemini-target-1",
      promptSha256,
      userId: syntheticUserId,
    });
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "1+1") return { result: { value: 2 } };
      if (expression.includes("const ordered =")) {
        return {
          result: {
            value: JSON.stringify({
              entries: [
                {
                  kind: "user",
                  postBaseline: true,
                  text: "New request",
                  stableId: null,
                },
                {
                  kind: "response",
                  postBaseline: true,
                  text: "wrong repeated-prompt answer",
                  stableId: "data-message-id:response-older",
                  completionMarked: true,
                  visibleSpinner: false,
                },
                {
                  kind: "user",
                  postBaseline: true,
                  text: "New request",
                  stableId: null,
                },
                {
                  kind: "response",
                  postBaseline: true,
                  text: "unidentifiable original answer",
                  stableId: "data-message-id:response-current",
                  completionMarked: true,
                  visibleSpinner: false,
                },
              ],
            }),
          },
        };
      }
      return { result: { value: null } };
    });
    const close = vi.fn(async () => undefined);
    const connect = vi.fn(async () => ({
      Runtime: { enable: vi.fn(async () => undefined), evaluate },
      DOM: { enable: vi.fn(async () => undefined) },
      close,
    })) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const recoverSession = vi.fn();
    const release = vi.fn(async () => undefined);

    await expect(
      resumeBrowserSession(
        runtime,
        { desiredModel: "gemini-3-pro-deep-think", timeoutMs: 2_000 },
        createBrowserLogger(),
        {
          listTargets: vi.fn(async () => [
            {
              targetId: "gemini-target-1",
              type: "page",
              url: "https://gemini.google.com/app/conversation-1",
            },
          ]),
          connect,
          recoverSession,
          acquireRecoveryLock: vi.fn(async () => ({ release })),
        },
      ),
    ).rejects.toMatchObject({
      details: {
        code: "gemini-reattach-authority-unavailable",
        reattachable: false,
      },
    });
    expect(
      evaluate.mock.calls.some(([input]) => input.expression.includes("const ordered =")),
    ).toBe(false);
    expect(recoverSession).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  test("never reopens or resubmits when the exact committed Gemini target is missing", async () => {
    const runtime = executorStyleGeminiRecoveryRuntime({
      targetId: "gemini-target-missing",
      promptSha256: promptIdentitySha256("New request"),
      userId: "data-message-id:user-current",
    });
    const recoverSession = vi.fn();
    const release = vi.fn(async () => undefined);

    await expect(
      resumeBrowserSession(
        runtime,
        { desiredModel: "gemini-3-pro-deep-think", timeoutMs: 2_000 },
        createBrowserLogger(),
        {
          listTargets: vi.fn(async () => []),
          recoverSession,
          acquireRecoveryLock: vi.fn(async () => ({ release })),
        },
      ),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: {
        stage: "gemini-response-capture",
        code: "gemini-reattach-target-mismatch",
        reattachable: true,
        runtime,
      },
    });
    expect(recoverSession).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("uses the committed prompt epoch as the assistant turn floor", async () => {
    const runtime = withCommittedPromptEpoch(
      {
        chromePort: 51559,
        chromeHost: "127.0.0.1",
        chromeTargetId: "target-1",
        tabUrl: "https://chatgpt.com/c/abc",
      },
      2,
    );
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
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "live reattach pro 123",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-4" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "live reattach pro 123");
    const verifyCommittedPromptTurn = vi.fn(async () => undefined);
    const logger = createBrowserLogger();

    const result = await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
      waitForConversationHydration: vi.fn(async () => 2),
      verifyCommittedPromptTurn,
    });
    await result.abort();

    expect(waitForAssistantResponse).toHaveBeenCalledWith(
      expect.anything(),
      2000,
      logger,
      3,
      "abc",
      expect.objectContaining({
        conversationId: "abc",
        verifiedUserTurnIndex: 2,
        verifiedUserTurnId: "turn-2",
        verifiedUserMessageId: "message-2",
      }),
    );
  });

  test("rejects unauthorized or incomplete prompt epochs", async () => {
    const unauthorizedRuntimes: BrowserRuntimeMetadata[] = [
      {
        chromePort: 51559,
        tabUrl: "https://chatgpt.com/c/abc",
      },
      {
        chromePort: 51559,
        tabUrl: "https://chatgpt.com/c/abc",
        promptEpoch: {
          status: "pending",
          epochId: "follow-up-pending",
          promptSha256: "pending-prompt-sha256",
          baselineTurns: 4,
          followUpOrdinal: 1,
          remainingFollowUps: 0,
        },
      },
      {
        chromePort: 51559,
        conversationId: "abc",
        tabUrl: "https://chatgpt.com/c/abc",
        promptEpoch: {
          status: "committed",
          epochId: "wrong-conversation",
          promptSha256: "wrong-conversation-sha256",
          baselineTurns: 4,
          followUpOrdinal: 0,
          remainingFollowUps: 0,
          verifiedUserTurnIndex: 4,
          verifiedUserTurnId: "turn-4",
          verifiedUserMessageId: "message-4",
          conversationId: "different-conversation",
        },
      },
      {
        chromePort: 51559,
        conversationId: "abc",
        tabUrl: "https://example.com/c/abc",
        promptEpoch: {
          status: "committed",
          epochId: "hostile-stored-url",
          promptSha256: "f".repeat(64),
          baselineTurns: 4,
          followUpOrdinal: 0,
          remainingFollowUps: 0,
          verifiedUserTurnIndex: 4,
          verifiedUserTurnId: "turn-4",
          verifiedUserMessageId: "message-4",
          conversationId: "abc",
        },
      },
      {
        chromePort: 51559,
        conversationId: "abc",
        chromeTargetId: "target-1",
        tabUrl: "https://chatgpt.com/c/abc",
        promptEpoch: {
          status: "committed",
          epochId: "follow-ups-remain",
          promptSha256: "c".repeat(64),
          baselineTurns: 4,
          followUpOrdinal: 0,
          remainingFollowUps: 1,
          verifiedUserTurnIndex: 4,
          verifiedUserTurnId: "turn-4",
          verifiedUserMessageId: "message-4",
          conversationId: "abc",
        },
      },
      {
        chromePort: 51559,
        conversationId: "abc",
        chromeTargetId: "target-1",
        tabUrl: "https://chatgpt.com/c/abc",
        promptEpoch: {
          status: "committed",
          epochId: " ",
          promptSha256: " ",
          baselineTurns: 5,
          followUpOrdinal: 0,
          remainingFollowUps: 0,
          verifiedUserTurnIndex: 4,
          verifiedUserTurnId: " ",
          verifiedUserMessageId: " ",
          conversationId: "abc",
        },
      },
    ];
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "prior prompt answer",
      html: "",
      meta: { messageId: "prior-answer", turnId: "conversation-turn-3" },
    }));

    for (const runtime of unauthorizedRuntimes) {
      await expect(
        resumeBrowserSession(runtime, {}, createBrowserLogger(), {
          listTargets: vi.fn(async () => {
            throw new Error("prior assistant answer must not be captured");
          }),
          waitForAssistantResponse,
        }),
      ).rejects.toThrow(/prompt epoch|conversation|follow-up/i);
    }
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
  });
});
