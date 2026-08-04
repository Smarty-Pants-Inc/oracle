import { access, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";
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
function chromeProcessIdentity(userDataDir: string, pid = 1234) {
  return {
    pid,
    processStartTime: "disconnect-fixture-process-generation",
    executablePath: "/usr/bin/google-chrome",
    normalizedUserDataDir: path.resolve(userDataDir),
    launchNonce: "33333333-3333-4333-8333-333333333333",
  };
}

function createClient(options: { onDisconnect?: (handler: () => void) => void }) {
  const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
    result: { value: expression === "location.href" ? conversationUrl : 0 },
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
  ownership: "created" | "attached",
  verify: (fixture: {
    error: unknown;
    browserAutomationError: BrowserAutomationErrorConstructor;
    archiveChatGptConversation: Mock;
    closeRemoteConnection: Mock;
    closeChromeTarget: Mock;
    probeChromeTargetLiveness: Mock;
    providerObservedDispatchStart: boolean;
  }) => Promise<void> | void,
): Promise<void> {
  let disconnectHandler: (() => void) | undefined;
  let providerObservedDispatchStart = false;
  const closeRemoteConnection = vi.fn().mockResolvedValue(undefined);
  const closeChromeTarget = vi.fn().mockResolvedValue(true);
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
      ownership,
      close: closeRemoteConnection,
    }),
    closeChromeTarget,
    closeBlankChromeTabs: vi.fn().mockResolvedValue(undefined),
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
    runProviderSubmissionFlow: vi.fn(async () => {
      providerObservedDispatchStart = true;
      return {
        status: "committed" as const,
        verification: {
          committedTurns: 1,
          verifiedUserTurnIndex: 0,
          conversationId: targetId,
        },
      };
    }),
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
    saveBrowserTranscriptArtifact: vi.fn().mockResolvedValue({
      path: path.join(os.tmpdir(), "transcript.md"),
    }),
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
      closeChromeTarget,
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
    closeChromeTarget: Mock;
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
  const closeChromeTarget = vi.fn().mockResolvedValue(true);
  const kill = vi.fn().mockResolvedValue(undefined);
  const probeChromeTargetLiveness = vi.fn().mockResolvedValue({
    endpointReachable: true,
    targetFound: true,
    matchedUrl: conversationUrl,
  });
  const verifyPromptCommitted = vi.fn().mockImplementation(async () => {
    if (options.semanticProbeSucceeds === false) {
      throw new Error("prompt commit not observed");
    }
    return {
      committedTurns: 2,
      verifiedUserTurnIndex: 1,
      conversationId: targetId,
    };
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
    ownership: "attached",
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
        processIdentity: chromeProcessIdentity(userDataDir),
      };
    }),
    registerTerminationHooks: vi.fn(() => vi.fn()),
    connectWithNewTab: vi.fn().mockResolvedValue({ client: primaryClient, targetId }),
    connectToRemoteChromeTarget,
    closeChromeTarget,
    closeBlankChromeTabs: vi.fn().mockResolvedValue(undefined),
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
    runProviderSubmissionFlow: vi.fn(async () => {
      providerObservedDispatchStart = true;
      disconnectHandler?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      return { status: "attempted" as const };
    }),
  }));

  try {
    // The literal dynamic import is intentional: each scenario must load index.ts
    // after its CDP mocks.
    const { runBrowserMode } = await import("../../src/browser/index.js");
    const error = await runBrowserMode({
      prompt: "keep this submitted conversation",
      config: {
        cookieSync: false,
        manualLogin: false,
        headless: true,
        modelStrategy: "ignore",
        ...(options.copiedProfile
          ? { copyProfileSource: path.join(os.tmpdir(), "source-profile") }
          : {}),
      },
    }).catch((caught) => caught);

    await verify({
      error,
      closeChromeTarget,
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
        60_000,
        expect.any(Function),
        0,
      );
      expect(fixture.error).toMatchObject({
        details: {
          stage: "connection-lost",
          recoverableDisconnect: true,
          runtime: {
            promptSubmitted: true,
            chromePid: 1234,
            chromeProcessIdentity: chromeProcessIdentity(fixture.profileDir),
            conversationId: targetId,
            promptEpoch: {
              status: "committed",
              epochId: expect.any(String),
              promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              baselineTurns: 0,
              followUpOrdinal: 0,
              remainingFollowUps: 0,
              verifiedUserTurnIndex: 1,
              conversationId: targetId,
            },
            recoveryCleanup: {
              transport: "local",
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
            } satisfies BrowserRecoveryCleanupMetadata,
          },
        },
      });
      expect(fixture.closeChromeTarget).not.toHaveBeenCalled();
      expect(fixture.kill).not.toHaveBeenCalled();
      await expect(access(fixture.profileDir)).resolves.toBeUndefined();
      await expect(readFile(path.join(fixture.profileDir, "chrome.pid"), "utf8")).resolves.toBe(
        "1234\n",
      );
      const persistedIdentity = JSON.parse(
        await readFile(path.join(fixture.profileDir, "chrome-process-identity.json"), "utf8"),
      ) as unknown;
      expect(persistedIdentity).toEqual(chromeProcessIdentity(fixture.profileDir));
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
      expect(fixture.closeChromeTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 9230,
          targetId,
          host: "127.0.0.1",
        }),
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
      expect(fixture.closeChromeTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 9230,
          targetId,
          host: "127.0.0.1",
        }),
      );
      expect(fixture.kill).toHaveBeenCalledTimes(1);
      await expect(access(fixture.profileDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("recovers a committed remote target when it disconnects during the final archive await", async () => {
    await withRemoteLateDisconnectFixture("created", async (fixture) => {
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
            conversationId: targetId,
            promptEpoch: {
              status: "committed",
              epochId: expect.any(String),
              promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              baselineTurns: 0,
              followUpOrdinal: 0,
              remainingFollowUps: 0,
              verifiedUserTurnIndex: 0,
              conversationId: targetId,
            },
            recoveryCleanup: {
              transport: "remote",
              ownsTarget: true,
              profileKind: "none",
            },
          },
        },
      });
      expect(fixture.closeRemoteConnection).not.toHaveBeenCalled();
      expect(fixture.closeChromeTarget).not.toHaveBeenCalled();
    });
  });

  test("records an attached remote fallback target as user-owned", async () => {
    await withRemoteLateDisconnectFixture("attached", async (fixture) => {
      expect(fixture.error).toMatchObject({
        details: {
          stage: "connection-lost",
          recoverableDisconnect: true,
          runtime: {
            chromeTargetId: targetId,
            recoveryCleanup: {
              transport: "remote",
              ownsTarget: false,
              profileKind: "none",
            },
          },
        },
      });
      expect(fixture.closeChromeTarget).not.toHaveBeenCalled();
    });
  });
});
