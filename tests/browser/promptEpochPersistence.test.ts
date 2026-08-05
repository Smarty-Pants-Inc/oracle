import { describe, expect, test, vi } from "vitest";
import type { BrowserRuntimeMetadata } from "../../src/sessionManager.js";
import { captureProfileDirectoryIdentity } from "../../src/browser/profileState.js";
import { hasRecoverableChatGptConversation } from "../../src/browser/reattachability.js";
import { promptIdentitySha256 } from "../../src/browser/actions/promptComposer.js";
import type * as PromptComposerModule from "../../src/browser/actions/promptComposer.js";

const conversationId = "epoch-conversation";
const conversationUrl = `https://chatgpt.com/c/${conversationId}`;

type Transport = "local" | "remote";

type FakeTurn = {
  role: "user" | "assistant";
  text: string;
  turnId: string;
  messageId: string;
};

function findLastTurnIndex(turns: readonly FakeTurn[], role: FakeTurn["role"]): number {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.role === role) return index;
  }
  return -1;
}

function browserRuntimeFromError(error: unknown): BrowserRuntimeMetadata | undefined {
  if (!error || typeof error !== "object") return undefined;
  const details = Reflect.get(error, "details");
  if (!details || typeof details !== "object") return undefined;
  const runtime = Reflect.get(details, "runtime");
  return runtime && typeof runtime === "object" ? (runtime as BrowserRuntimeMetadata) : undefined;
}

type PromptResetPersistenceTransition = {
  from: BrowserRuntimeMetadata;
  to: BrowserRuntimeMetadata;
};

function isPromptResetPersistenceTransition(
  previous: BrowserRuntimeMetadata | undefined,
  next: BrowserRuntimeMetadata,
): previous is BrowserRuntimeMetadata {
  const previousGeneration = previous?.recoveryCleanupResources?.[0]?.acquisition?.generationId;
  return (
    previous?.promptEpoch?.status === "committed" &&
    next.promptEpoch === undefined &&
    typeof previousGeneration === "string" &&
    previousGeneration.length > 0 &&
    next.recoveryCleanupResources?.[0]?.acquisition?.generationId === previousGeneration
  );
}

async function runTwoTurnResetFailure(transport: Transport) {
  const turns: FakeTurn[] = [];
  let composerText = "";
  let lastDurablyPersistedRuntime: BrowserRuntimeMetadata | undefined;
  const durablyPersistedRuntimes: BrowserRuntimeMetadata[] = [];
  let committedRuntime: BrowserRuntimeMetadata | undefined;
  let rejectedResetTransition: PromptResetPersistenceTransition | undefined;
  const closeChromeTarget = vi.fn().mockResolvedValue(true);
  const killChrome = vi.fn().mockResolvedValue({ status: "stopped", pid: 4321, signal: "SIGTERM" });
  const closeConnection = vi.fn().mockResolvedValue(undefined);
  const verifyCommittedPromptTurn = vi.fn().mockResolvedValue(undefined);
  const clearPromptComposer = vi.fn(async () => {
    composerText = "";
  });
  const insertText = vi.fn(async ({ text }: { text: string }) => {
    composerText = text;
  });

  const Runtime = {
    enable: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href" || expression.includes('typeof location === "object"')) {
        return { result: { value: conversationUrl } };
      }
      if (expression.includes("matchedUserTurnIndex") || expression.includes("userMatched")) {
        const userTurnIndex = findLastTurnIndex(turns, "user");
        const userTurn = userTurnIndex >= 0 ? turns[userTurnIndex] : undefined;
        return {
          result: {
            value: {
              baseline: Math.max(0, userTurnIndex),
              turnsCount: turns.length,
              matchedUserTurnIndex: userTurnIndex >= 0 ? userTurnIndex : null,
              matchedUserTurnId: userTurn?.turnId ?? null,
              matchedUserMessageId: userTurn?.messageId ?? null,
              hasNewTurn: userTurnIndex >= 0,
              userMatched: userTurnIndex >= 0,
              prefixMatched: false,
              lastMatched: userTurnIndex >= 0,
              stopVisible: true,
              assistantVisible: turns.some((turn) => turn.role === "assistant"),
              composerCleared: composerText.length === 0,
              inConversation: true,
              conversationId,
            },
          },
        };
      }
      if (
        expression.includes("const containers") &&
        expression.includes("querySelectorAll") &&
        expression.trim().endsWith(".length")
      ) {
        return { result: { value: turns.length } };
      }
      if (expression.includes("document.readyState")) {
        return { result: { value: { ready: true, composer: true, fileInput: false } } };
      }
      if (expression.includes("focused: true")) {
        return { result: { value: { focused: true } } };
      }
      if (expression.includes("editorText")) {
        return {
          result: {
            value: {
              editorText: composerText,
              fallbackValue: "",
              activeValue: composerText,
            },
          },
        };
      }
      if (expression.includes("button.scrollIntoView")) {
        const index = turns.length;
        turns.push({
          role: "user",
          text: composerText,
          turnId: `turn-${index}`,
          messageId: `message-${index}`,
        });
        composerText = "";
        return { result: { value: { status: "clicked" } } };
      }
      return { result: { value: false } };
    }),
  };
  const Input = {
    insertText,
    dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
    dispatchMouseEvent: vi.fn().mockResolvedValue(undefined),
  };
  const submitPrompt = vi.fn(
    async (
      { input, baselineTurns }: { input: { insertText: typeof insertText }; baselineTurns: number },
      prompt: string,
    ) => {
      if (baselineTurns !== turns.length) {
        throw new Error("fixture prompt baseline does not match the conversation");
      }
      await input.insertText({ text: prompt });
      const index = turns.length;
      turns.push({
        role: "user",
        text: composerText,
        turnId: `turn-${index}`,
        messageId: `message-${index}`,
      });
      composerText = "";
      return {
        committedTurns: turns.length,
        promptSha256: promptIdentitySha256(prompt),
        verifiedUserTurnIndex: index,
        verifiedUserTurnId: `turn-${index}`,
        verifiedUserMessageId: `message-${index}`,
        conversationId,
      };
    },
  );
  const client = {
    Network: {
      enable: vi.fn().mockResolvedValue(undefined),
      clearBrowserCookies: vi.fn().mockResolvedValue(undefined),
    },
    Page: {
      enable: vi.fn().mockResolvedValue(undefined),
      reload: vi.fn().mockResolvedValue(undefined),
    },
    Runtime,
    Input,
    DOM: { enable: vi.fn().mockResolvedValue(undefined) },
    Target: {
      getTargetInfo: vi.fn().mockResolvedValue({
        targetInfo: { targetId: "epoch-target", url: conversationUrl },
      }),
    },
    Emulation: { setFocusEmulationEnabled: vi.fn().mockResolvedValue(undefined) },
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };

  vi.resetModules();
  vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
    launchChrome: vi.fn(async (_config: unknown, userDataDir: string) => {
      const profileDirectory = await captureProfileDirectoryIdentity(userDataDir);
      return {
        pid: 4321,
        port: 9230,
        process: { unref: vi.fn() },
        processIdentity: {
          pid: 4321,
          processStartTime: "epoch-fixture-process-generation",
          executablePath:
            profileDirectory.platform === "win32"
              ? String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`
              : profileDirectory.platform === "darwin"
                ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                : "/usr/bin/google-chrome",
          normalizedUserDataDir:
            profileDirectory.platform === "win32"
              ? profileDirectory.canonicalPath.toLowerCase()
              : profileDirectory.canonicalPath,
          launchNonce: "22222222-2222-4222-8222-222222222222",
          profileDirectory,
        },
        kill: killChrome,
      };
    }),
    registerTerminationHooks: vi.fn(() => vi.fn()),
    positionChromeWindowOffscreen: vi.fn().mockResolvedValue(undefined),
    connectWithNewTab: vi.fn().mockResolvedValue({ client, targetId: "epoch-target" }),
    connectToRemoteChrome: vi.fn().mockResolvedValue({
      client,
      targetId: "epoch-target",
      ownership: "created",
      close: closeConnection,
    }),
    connectToRemoteChromeTarget: vi.fn(),
    closeChromeTarget,
    closeBlankChromeTabs: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("../../src/browser/profileState.js", () => ({
    captureProfileDirectoryIdentity,
    createChromeProcessLaunchClaim: (generationId: string) => ({
      version: 1 as const,
      generationId,
      nonce: "b0000000-0000-4000-8000-00000000000b",
    }),
    cleanupStaleProfileState: vi.fn().mockResolvedValue(undefined),
    acquireProfileRunLock: vi.fn(),
    isSafeChromeTerminationOutcome: vi.fn(() => true),
    terminateRecordedChromeForProfile: vi.fn().mockResolvedValue({ status: "not-running" }),
    writeOracleChromeOwner: vi.fn().mockResolvedValue(undefined),
    removeProfileDirectoryIfIdentityMatches: vi.fn().mockResolvedValue(true),
  }));
  vi.doMock("../../src/browser/cookies.js", () => ({
    clearStaleChatGptConversationCookies: vi.fn().mockResolvedValue(undefined),
    syncCookies: vi.fn().mockResolvedValue(0),
  }));
  vi.doMock("../../src/browser/actions/promptComposer.js", async () => ({
    ...(await vi.importActual<typeof PromptComposerModule>(
      "../../src/browser/actions/promptComposer.js",
    )),
    submitPrompt,
  }));
  vi.doMock("../../src/browser/actions/navigation.js", () => ({
    ensurePromptReady: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("../../src/browser/pageActions.js", () => ({
    navigateToChatGPT: vi.fn().mockResolvedValue(undefined),
    navigateToPromptReadyWithFallback: vi.fn().mockResolvedValue(undefined),
    ensureNotBlocked: vi.fn().mockResolvedValue(undefined),
    ensureLoggedIn: vi.fn().mockResolvedValue(undefined),
    ensurePromptReady: vi.fn().mockResolvedValue(undefined),
    ensureChatMode: vi.fn().mockResolvedValue("unchanged"),
    waitForResumedConversationHydration: vi.fn().mockResolvedValue(undefined),
    ensureChatGptScopeRetained: vi.fn().mockResolvedValue(undefined),
    installJavaScriptDialogAutoDismissal: vi.fn(() => vi.fn()),
    ensureModelSelection: vi.fn(),
    clearPromptComposer,
    waitForAssistantResponse: vi.fn(async () => {
      if (!turns.some((turn) => turn.role === "assistant")) {
        const index = turns.length;
        turns.push({
          role: "assistant",
          text: "prompt one answer",
          turnId: `turn-${index}`,
          messageId: `message-${index}`,
        });
      }
      return {
        text: "prompt one answer",
        html: "<p>prompt one answer</p>",
        meta: { turnId: "turn-1", messageId: "message-1" },
      };
    }),
    captureAssistantMarkdown: vi.fn().mockResolvedValue("prompt one answer"),
    clearComposerAttachments: vi.fn().mockResolvedValue(undefined),
    uploadAttachmentFile: vi.fn(),
    waitForAttachmentCompletion: vi.fn().mockResolvedValue(undefined),
    waitForUserTurnAttachments: vi.fn().mockResolvedValue(true),
    readAssistantSnapshot: vi.fn(async () => {
      const index = findLastTurnIndex(turns, "assistant");
      if (index < 0) return null;
      const turn = turns[index];
      return {
        text: turn.text,
        html: `<p>${turn.text}</p>`,
        turnIndex: index,
        turnId: turn.turnId,
        messageId: turn.messageId,
      };
    }),
    verifyPromptCommitted: vi.fn(),
    verifyCommittedPromptTurn,
  }));
  vi.doMock("../../src/browser/conversationUrlMonitor.js", () => ({
    createConversationUrlMonitor: vi.fn(() => ({
      update: vi.fn().mockResolvedValue(true),
      schedule: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    })),
  }));
  vi.doMock("../../src/browser/chatgptImages.js", () => ({
    collectGeneratedImageArtifacts: vi.fn().mockResolvedValue({
      answerText: "",
      markdownSuffix: "",
      generatedImages: [],
      savedImages: [],
      imageCount: 0,
    }),
  }));
  vi.doMock("../../src/browser/chatgptFiles.js", () => ({
    collectChatGptFileArtifacts: vi.fn().mockResolvedValue({
      files: [],
      savedFiles: [],
      fileCount: 0,
    }),
  }));
  vi.doMock("../../src/browser/artifacts.js", () => ({
    appendArtifacts: vi.fn((current: unknown[] | undefined, artifacts: unknown[]) => [
      ...(current ?? []),
      ...artifacts.filter(Boolean),
    ]),
    saveBrowserTranscriptArtifact: vi.fn().mockResolvedValue(null),
    saveDeepResearchReportArtifact: vi.fn().mockResolvedValue(null),
  }));
  vi.doMock("../../src/browser/actions/archiveConversation.js", () => ({
    resolveBrowserArchiveDecision: vi.fn(() => ({
      shouldArchive: false,
      mode: "never",
      reason: "disabled",
    })),
    archiveChatGptConversation: vi.fn(),
  }));
  vi.doMock("../../src/browser/actions/thinkingStatus.js", () => ({
    startThinkingStatusMonitor: vi.fn(() => vi.fn()),
  }));

  try {
    // The production runner must load after the per-transport module mocks are installed.
    const { runBrowserMode } = await import("../../src/browser/index.js");
    const error = await runBrowserMode({
      prompt: "prompt one",
      followUpPrompts: ["prompt two"],
      config: {
        ...(transport === "remote" ? { remoteChrome: { host: "remote.example", port: 9333 } } : {}),
        cookieSync: false,
        manualLogin: false,
        headless: true,
        modelStrategy: "ignore",
        archiveConversations: "never",
      },
      runtimeHintCb: async (runtime) => {
        if (isPromptResetPersistenceTransition(lastDurablyPersistedRuntime, runtime)) {
          rejectedResetTransition ??= { from: lastDurablyPersistedRuntime, to: runtime };
          throw new Error("simulated prompt-two reset persistence failure");
        }
        lastDurablyPersistedRuntime = runtime;
        durablyPersistedRuntimes.push(runtime);
        if (runtime.promptEpoch?.status === "committed") {
          committedRuntime = runtime;
        }
      },
    }).catch((caught) => caught);

    return {
      error,
      committedRuntime,
      rejectedResetTransition,
      durablyPersistedRuntimes,
      clearPromptComposer,
      insertText,
      closeChromeTarget,
      killChrome,
      verifyCommittedPromptTurn,
      closeConnection,
    };
  } finally {
    vi.doUnmock("../../src/browser/chromeLifecycle.js");
    vi.doUnmock("../../src/browser/profileState.js");
    vi.doUnmock("../../src/browser/cookies.js");
    vi.doUnmock("../../src/browser/actions/navigation.js");
    vi.doUnmock("../../src/browser/actions/promptComposer.js");
    vi.doUnmock("../../src/browser/pageActions.js");
    vi.doUnmock("../../src/browser/conversationUrlMonitor.js");
    vi.doUnmock("../../src/browser/chatgptImages.js");
    vi.doUnmock("../../src/browser/chatgptFiles.js");
    vi.doUnmock("../../src/browser/artifacts.js");
    vi.doUnmock("../../src/browser/actions/archiveConversation.js");
    vi.doUnmock("../../src/browser/actions/thinkingStatus.js");
    vi.resetModules();
  }
}

describe("semantic prompt epoch persistence", () => {
  test.each(["local", "remote"] as const)(
    "%s run fails closed before composing prompt two when its reset is not durable",
    async (transport) => {
      const fixture = await runTwoTurnResetFailure(transport);
      const runtime = browserRuntimeFromError(fixture.error);

      expect(fixture.insertText).toHaveBeenCalledTimes(1);
      expect(fixture.insertText).toHaveBeenCalledWith({ text: "prompt one" });
      expect(fixture.clearPromptComposer).toHaveBeenCalledTimes(1);
      expect(fixture.committedRuntime).toMatchObject({
        conversationId,
        promptEpoch: {
          status: "committed",
          epochId: expect.any(String),
          promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          baselineTurns: 0,
          followUpOrdinal: 0,
          remainingFollowUps: 1,
          verifiedUserTurnIndex: 0,
          verifiedUserTurnId: "turn-0",
          verifiedUserMessageId: "message-0",
          conversationId,
        },
      });
      expect(fixture.rejectedResetTransition).toMatchObject({
        from: {
          promptEpoch: fixture.committedRuntime?.promptEpoch,
        },
        to: {
          promptEpoch: undefined,
        },
      });
      expect(
        fixture.rejectedResetTransition?.to.recoveryCleanupResources?.[0]?.acquisition
          ?.generationId,
      ).toBe(
        fixture.rejectedResetTransition?.from.recoveryCleanupResources?.[0]?.acquisition
          ?.generationId,
      );
      const committedPersistenceIndex = fixture.durablyPersistedRuntimes.findIndex(
        (persistedRuntime) => persistedRuntime.promptEpoch?.status === "committed",
      );
      expect(committedPersistenceIndex).toBeGreaterThan(0);
      expect(
        fixture.durablyPersistedRuntimes
          .slice(0, committedPersistenceIndex)
          .some(
            (persistedRuntime) =>
              persistedRuntime.recoveryCleanupResources?.[0]?.acquisition?.generationId !==
              undefined,
          ),
      ).toBe(true);
      expect(fixture.durablyPersistedRuntimes.at(-1)).toMatchObject({
        promptEpoch: fixture.committedRuntime?.promptEpoch,
      });
      const promptPersistenceError = (fixture.error as Error & { cause?: unknown }).cause;
      expect(fixture.error).toMatchObject({
        details: {
          stage: "browser-capture-finalization",
          code: "unpublished-cleanup-pending",
          runtime: {
            promptEpoch: fixture.committedRuntime?.promptEpoch,
          },
        },
      });
      expect(promptPersistenceError).toMatchObject({
        details: {
          stage: "prompt-epoch-persistence",
          code: "prompt-epoch-persistence-failed",
          runtime: {
            promptEpoch: fixture.committedRuntime?.promptEpoch,
          },
        },
      });
      expect(fixture.verifyCommittedPromptTurn).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          epoch: fixture.committedRuntime?.promptEpoch,
          conversationId,
          promptSha256: promptIdentitySha256("prompt one"),
          verifiedUserTurnIndex: 0,
          verifiedUserTurnId: "turn-0",
          verifiedUserMessageId: "message-0",
        }),
      );
      expect(hasRecoverableChatGptConversation(runtime)).toBe(true);
      expect(fixture.closeChromeTarget).not.toHaveBeenCalled();
      expect(fixture.killChrome).not.toHaveBeenCalled();
      expect(fixture.closeConnection).not.toHaveBeenCalled();
    },
  );
});
