import { access, rm } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";
import { __test__ } from "../../src/browser/index.js";
import type { BrowserRecoveryCleanupMetadata } from "../../src/sessionManager.js";

type BrowserAutomationErrorConstructor = new (
  message: string,
  details?: Record<string, unknown>,
  cause?: unknown,
) => Error;

type DisconnectFixtureOptions = {
  copiedProfile?: boolean;
  semanticProbeSucceeds?: boolean;
};

const targetId = "recoverable-target";
const conversationUrl = `https://chatgpt.com/c/${targetId}`;

function createClient(options: { onDisconnect?: (handler: () => void) => void }) {
  const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
    result: { value: expression === "location.href" ? conversationUrl : null },
  }));

  return {
    Network: {
      enable: vi.fn().mockResolvedValue(undefined),
      clearBrowserCookies: vi.fn().mockResolvedValue(undefined),
    },
    Page: { enable: vi.fn().mockResolvedValue(undefined) },
    Runtime: { enable: vi.fn().mockResolvedValue(undefined), evaluate },
    Target: {
      getTargetInfo: vi.fn().mockResolvedValue({
        targetInfo: { targetId, url: conversationUrl },
      }),
    },
    Emulation: { setFocusEmulationEnabled: vi.fn().mockResolvedValue(undefined) },
    on: vi.fn((event: string, handler: () => void) => {
      if (event === "disconnect") options.onDisconnect?.(handler);
    }),
  };
}

async function withRemoteLateDisconnectFixture(
  verify: (fixture: {
    error: unknown;
    browserAutomationError: BrowserAutomationErrorConstructor;
    archiveChatGptConversation: Mock;
    closeRemoteConnection: Mock;
    closeTab: Mock;
    probeChromeTargetLiveness: Mock;
    providerObservedDispatchStart: boolean;
  }) => Promise<void> | void,
): Promise<void> {
  let disconnectHandler: (() => void) | undefined;
  let providerObservedDispatchStart = false;
  const closeRemoteConnection = vi.fn().mockResolvedValue(undefined);
  const closeTab = vi.fn().mockResolvedValue(true);
  const probeChromeTargetLiveness = vi.fn().mockResolvedValue({
    endpointReachable: true,
    targetFound: true,
    matchedUrl: conversationUrl,
  });
  const client = createClient({
    onDisconnect: (handler) => {
      disconnectHandler = handler;
    },
  });
  const archiveChatGptConversation = vi.fn(async () => {
    // The archive await is the last await before the completion atomicity check.
    disconnectHandler?.();
    await Promise.resolve();
    return { mode: "always", attempted: true, archived: true, conversationUrl };
  });

  vi.resetModules();
  vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
    connectToRemoteChrome: vi.fn().mockResolvedValue({
      client,
      targetId,
      close: closeRemoteConnection,
    }),
    closeTab,
  }));
  vi.doMock("../../src/browser/cookies.js", () => ({
    clearStaleChatGptConversationCookies: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("../../src/browser/pageActions.js", () => ({
    navigateToChatGPT: vi.fn().mockResolvedValue(undefined),
    ensureNotBlocked: vi.fn().mockResolvedValue(undefined),
    ensureLoggedIn: vi.fn().mockResolvedValue(undefined),
    ensurePromptReady: vi.fn().mockResolvedValue(undefined),
    ensureChatMode: vi.fn().mockResolvedValue("unchanged"),
    installJavaScriptDialogAutoDismissal: vi.fn(() => vi.fn()),
    clearPromptComposer: vi.fn().mockResolvedValue(undefined),
    readAssistantSnapshot: vi.fn().mockResolvedValue(null),
    waitForAssistantResponse: vi.fn().mockResolvedValue({ text: "completed answer", meta: {} }),
    captureAssistantMarkdown: vi.fn().mockResolvedValue("completed answer"),
  }));
  vi.doMock("../../src/browser/conversationUrlMonitor.js", () => ({
    createConversationUrlMonitor: vi.fn(() => ({
      update: vi.fn().mockResolvedValue(true),
      schedule: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    })),
  }));
  vi.doMock("../../src/browser/cdpLiveness.js", () => ({
    probeChromeTargetLiveness,
    isRecoverableChromeDisconnect: vi.fn(
      (liveness: { endpointReachable: boolean; targetFound: boolean | null }) =>
        liveness.endpointReachable && liveness.targetFound === true,
    ),
    connectionLostUserMessage: vi.fn(() => "connection lost"),
  }));
  vi.doMock("../../src/browser/providerDomFlow.js", () => ({
    runProviderSubmissionFlow: vi.fn(
      async (_adapter: unknown, context: { state?: Record<string, unknown> }) => {
        const onPromptDispatchStarted = context.state?.onPromptDispatchStarted;
        if (typeof onPromptDispatchStarted !== "function") {
          throw new Error("Test browser flow did not expose prompt dispatch state.");
        }
        await onPromptDispatchStarted();
        providerObservedDispatchStart = true;
      },
    ),
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
    appendArtifacts: vi.fn((_current: unknown, artifacts: unknown[]) => artifacts.filter(Boolean)),
    saveBrowserTranscriptArtifact: vi.fn().mockResolvedValue({ path: "/tmp/transcript.md" }),
  }));
  vi.doMock("../../src/browser/actions/archiveConversation.js", () => ({
    resolveBrowserArchiveDecision: vi.fn(() => ({
      shouldArchive: true,
      mode: "always",
      reason: "requested",
    })),
    archiveChatGptConversation,
  }));
  vi.doMock("../../src/browser/actions/thinkingStatus.js", () => ({
    startThinkingStatusMonitor: vi.fn(() => vi.fn()),
  }));

  try {
    // These modules must share the post-mock module graph.
    const [{ runBrowserMode }, { BrowserAutomationError: browserAutomationError }] =
      await Promise.all([
        import("../../src/browser/index.js"),
        import("../../src/oracle/errors.js"),
      ]);
    const error = await runBrowserMode({
      prompt: "keep this submitted conversation",
      config: {
        remoteChrome: { host: "remote.example", port: 9333 },
        cookieSync: false,
        headless: true,
        modelStrategy: "ignore",
        archiveConversations: "always",
      },
    }).catch((caught) => caught);

    await verify({
      error,
      browserAutomationError,
      archiveChatGptConversation,
      closeRemoteConnection,
      closeTab,
      probeChromeTargetLiveness,
      providerObservedDispatchStart,
    });
  } finally {
    vi.doUnmock("../../src/browser/chromeLifecycle.js");
    vi.doUnmock("../../src/browser/cookies.js");
    vi.doUnmock("../../src/browser/pageActions.js");
    vi.doUnmock("../../src/browser/conversationUrlMonitor.js");
    vi.doUnmock("../../src/browser/cdpLiveness.js");
    vi.doUnmock("../../src/browser/providerDomFlow.js");
    vi.doUnmock("../../src/browser/chatgptImages.js");
    vi.doUnmock("../../src/browser/chatgptFiles.js");
    vi.doUnmock("../../src/browser/artifacts.js");
    vi.doUnmock("../../src/browser/actions/archiveConversation.js");
    vi.doUnmock("../../src/browser/actions/thinkingStatus.js");
    vi.resetModules();
  }
}

async function withDisconnectFixture(
  options: DisconnectFixtureOptions,
  verify: (fixture: {
    error: unknown;
    closeTab: Mock;
    kill: Mock;
    connectToRemoteChromeTarget: Mock;
    probeChromeTargetLiveness: Mock;
    verifyPromptCommitted: Mock;
    profileDir: string;
    providerObservedDispatchStart: boolean;
  }) => Promise<void> | void,
): Promise<void> {
  let disconnectHandler: (() => void) | undefined;
  let profileDir = "";
  let providerObservedDispatchStart = false;
  const closeTab = vi.fn().mockResolvedValue(true);
  const kill = vi.fn();
  const probeChromeTargetLiveness = vi.fn().mockResolvedValue({
    endpointReachable: true,
    targetFound: true,
    matchedUrl: conversationUrl,
  });
  const verifyPromptCommitted = vi.fn().mockImplementation(async () => {
    if (options.semanticProbeSucceeds === false) {
      throw new Error("prompt commit not observed");
    }
    return 2;
  });
  const primaryClient = createClient({
    onDisconnect: (handler) => {
      disconnectHandler = handler;
    },
  });
  const recoveryClient = createClient({});
  const connectToRemoteChromeTarget = vi.fn().mockResolvedValue({
    client: recoveryClient,
    targetId,
    close: vi.fn().mockResolvedValue(undefined),
  });

  vi.resetModules();
  vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
    launchChrome: vi.fn(async (_config: unknown, userDataDir: string) => {
      profileDir = userDataDir;
      return {
        pid: 1234,
        port: 9230,
        process: { unref: vi.fn() },
        kill,
      };
    }),
    registerTerminationHooks: vi.fn(() => vi.fn()),
    connectWithNewTab: vi.fn().mockResolvedValue({ client: primaryClient, targetId }),
    connectToRemoteChromeTarget,
    closeTab,
  }));
  vi.doMock("../../src/browser/profileCopy.js", () => ({
    copyChromeProfile: vi.fn().mockResolvedValue("Default"),
  }));
  vi.doMock("../../src/browser/cookies.js", () => ({
    clearStaleChatGptConversationCookies: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("../../src/browser/pageActions.js", () => ({
    navigateToChatGPT: vi.fn().mockResolvedValue(undefined),
    ensureNotBlocked: vi.fn().mockResolvedValue(undefined),
    ensureLoggedIn: vi.fn().mockResolvedValue(undefined),
    ensurePromptReady: vi.fn().mockResolvedValue(undefined),
    ensureChatMode: vi.fn().mockResolvedValue("unchanged"),
    installJavaScriptDialogAutoDismissal: vi.fn(() => vi.fn()),
    clearPromptComposer: vi.fn().mockResolvedValue(undefined),
    verifyPromptCommitted,
    readAssistantSnapshot: vi.fn().mockResolvedValue(null),
  }));
  vi.doMock("../../src/browser/conversationUrlMonitor.js", () => ({
    createConversationUrlMonitor: vi.fn(() => ({
      update: vi.fn(),
      schedule: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    })),
  }));
  vi.doMock("../../src/browser/cdpLiveness.js", () => ({
    probeChromeTargetLiveness,
    isRecoverableChromeDisconnect: vi.fn(
      (liveness: { endpointReachable: boolean; targetFound: boolean | null }) =>
        liveness.endpointReachable && liveness.targetFound === true,
    ),
    connectionLostUserMessage: vi.fn(() => "connection lost"),
  }));
  vi.doMock("../../src/browser/providerDomFlow.js", () => ({
    runProviderSubmissionFlow: vi.fn(
      async (_adapter: unknown, context: { state?: Record<string, unknown> }) => {
        const onPromptDispatchStarted = context.state?.onPromptDispatchStarted;
        if (typeof onPromptDispatchStarted !== "function") {
          throw new Error("Test browser flow did not expose prompt dispatch state.");
        }
        await onPromptDispatchStarted();
        providerObservedDispatchStart = true;
        disconnectHandler?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    ),
  }));

  try {
    // The literal dynamic import is intentional: each scenario must load index.ts
    // after its CDP mocks.
    const { runBrowserMode } = await import("../../src/browser/index.js");
    const error = await runBrowserMode({
      prompt: "keep this submitted conversation",
      config: {
        cookieSync: false,
        headless: true,
        modelStrategy: "ignore",
        ...(options.copiedProfile ? { copyProfileSource: "/tmp/source-profile" } : {}),
      },
    }).catch((caught) => caught);

    await verify({
      error,
      closeTab,
      kill,
      connectToRemoteChromeTarget,
      probeChromeTargetLiveness,
      verifyPromptCommitted,
      profileDir,
      providerObservedDispatchStart,
    });
  } finally {
    if (profileDir) {
      await rm(profileDir, { recursive: true, force: true });
    }
    vi.doUnmock("../../src/browser/chromeLifecycle.js");
    vi.doUnmock("../../src/browser/profileCopy.js");
    vi.doUnmock("../../src/browser/cookies.js");
    vi.doUnmock("../../src/browser/pageActions.js");
    vi.doUnmock("../../src/browser/conversationUrlMonitor.js");
    vi.doUnmock("../../src/browser/cdpLiveness.js");
    vi.doUnmock("../../src/browser/providerDomFlow.js");
    vi.resetModules();
  }
}

describe("recoverable disconnect policy", () => {
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
});

describe("recoverable disconnect lifecycle", () => {
  test("recovers an ordinary temporary profile after a semantically committed dispatch", async () => {
    await withDisconnectFixture({}, async (fixture) => {
      expect(fixture.providerObservedDispatchStart).toBe(true);
      expect(fixture.probeChromeTargetLiveness).toHaveBeenCalledTimes(1);
      expect(fixture.connectToRemoteChromeTarget).toHaveBeenCalledWith(
        "127.0.0.1",
        9230,
        expect.any(Function),
        { targetId, browserWSEndpoint: undefined, closeTargetOnDispose: false },
      );
      expect(fixture.verifyPromptCommitted).toHaveBeenCalledWith(
        expect.objectContaining({ evaluate: expect.any(Function) }),
        "keep this submitted conversation",
        15_000,
        expect.any(Function),
        0,
      );
      expect(fixture.error).toMatchObject({
        details: {
          stage: "connection-lost",
          recoverableDisconnect: true,
          runtime: {
            promptSubmitted: true,
            recoveryCleanup: {
              transport: "local",
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
            } satisfies BrowserRecoveryCleanupMetadata,
          },
        },
      });
      expect(fixture.closeTab).not.toHaveBeenCalled();
      expect(fixture.kill).not.toHaveBeenCalled();
      await expect(access(fixture.profileDir)).resolves.toBeUndefined();
    });
  });

  test("cleans an owned copied profile instead of retaining an otherwise recoverable disconnect", async () => {
    await withDisconnectFixture({ copiedProfile: true }, async (fixture) => {
      expect(fixture.providerObservedDispatchStart).toBe(true);
      expect(fixture.probeChromeTargetLiveness).toHaveBeenCalledTimes(1);
      expect(fixture.verifyPromptCommitted).toHaveBeenCalledTimes(1);
      expect(fixture.error).toMatchObject({
        details: {
          stage: "connection-lost",
          recoverableDisconnect: false,
          disconnectCause: "copied-profile-not-reattachable",
        },
      });
      expect(fixture.closeTab).toHaveBeenCalledWith(
        9230,
        targetId,
        expect.any(Function),
        "127.0.0.1",
      );
      expect(fixture.kill).toHaveBeenCalledTimes(1);
      await expect(access(fixture.profileDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("cleans a temporary profile when the fresh semantic probe cannot confirm dispatch", async () => {
    await withDisconnectFixture({ semanticProbeSucceeds: false }, async (fixture) => {
      expect(fixture.providerObservedDispatchStart).toBe(true);
      expect(fixture.probeChromeTargetLiveness).toHaveBeenCalledTimes(1);
      expect(fixture.connectToRemoteChromeTarget).toHaveBeenCalledTimes(1);
      expect(fixture.verifyPromptCommitted).toHaveBeenCalledTimes(1);
      expect(fixture.error).toMatchObject({
        details: {
          stage: "connection-lost",
          recoverableDisconnect: false,
          disconnectCause: "prompt-commit-unverified",
          runtime: { promptSubmitted: false },
        },
      });
      expect(fixture.closeTab).toHaveBeenCalledWith(
        9230,
        targetId,
        expect.any(Function),
        "127.0.0.1",
      );
      expect(fixture.kill).toHaveBeenCalledTimes(1);
      await expect(access(fixture.profileDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("recovers a committed remote target when it disconnects during the final archive await", async () => {
    await withRemoteLateDisconnectFixture(async (fixture) => {
      expect(fixture.providerObservedDispatchStart).toBe(true);
      expect(fixture.archiveChatGptConversation).toHaveBeenCalledTimes(1);
      expect(fixture.probeChromeTargetLiveness).toHaveBeenCalledTimes(1);
      expect(fixture.error).toBeInstanceOf(fixture.browserAutomationError);
      expect(fixture.error).toMatchObject({
        details: {
          stage: "connection-lost",
          recoverableDisconnect: true,
          runtime: {
            promptSubmitted: true,
            recoveryCleanup: {
              transport: "remote",
              ownsTarget: true,
              profileKind: "none",
            },
          },
        },
      });
      expect(fixture.closeRemoteConnection).not.toHaveBeenCalled();
      expect(fixture.closeTab).not.toHaveBeenCalled();
    });
  });
});
