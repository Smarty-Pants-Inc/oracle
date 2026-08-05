import { access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";
import type * as ProfileStateModule from "../../src/browser/profileState.js";
import type {
  BrowserRecoveryCleanupMetadata,
  BrowserRuntimeMetadata,
} from "../../src/sessionManager.js";
import {
  captureProfileDirectoryIdentity,
  readOracleChromeOwner,
} from "../../src/browser/profileState.js";
import type {
  ChromeProcessIdentity,
  ChromeProcessLaunchClaim,
  OracleChromeOwnerRecord,
} from "../../src/browser/profileState.js";
import { promptIdentitySha256 } from "../../src/browser/actions/promptComposer.js";
import type { BrowserArchiveEffectReceipt } from "../../src/browser/actions/archiveConversation.js";

type BrowserAutomationErrorConstructor = new (
  message: string,
  details?: Record<string, unknown>,
  cause?: unknown,
) => Error;

type DisconnectFixtureOptions = {
  copiedProfile?: boolean;
  semanticProbeSucceeds?: boolean;
  runtimePersistenceFailsAfterCommit?: boolean;
  disconnectDuringFinalArchive?: boolean;
  ownerPublicationFailsAfterCapture?: boolean;
  targetExitsDuringFinalArchive?: boolean;
  finalIdentityChangesAfterArchive?: boolean;
  archiveNavigatesToNonConversationRoute?: boolean;
  unguardedArchiveNavigatesToNonConversationRoute?: boolean;
  archiveNavigatesToDifferentConversation?: boolean;
};

type RemoteDisconnectFixtureOptions = {
  disconnectDuringSubmission?: boolean;
  disconnectDuringFinalArchive?: boolean;
  runtimePersistenceFailsAfterCommit?: boolean;
  targetExitsDuringFinalArchive?: boolean;
  archiveNavigatesToNonConversationRoute?: boolean;
};

async function captureUnhandledRejections<T>(
  run: () => Promise<T>,
): Promise<{ result: T; unhandledRejections: unknown[] }> {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    const result = await run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { result, unhandledRejections };
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
}

function expectCompletedPublicBrowserResult(value: unknown): void {
  if (!value || typeof value !== "object") {
    throw new Error("Browser result was not an object");
  }
  for (const field of [
    "runtime",
    "bindSettlement",
    "finalize",
    "abort",
    "chromePid",
    "chromeProcessIdentity",
    "chromePort",
    "chromeHost",
    "chromeBrowserWSEndpoint",
    "chromeProfileRoot",
    "userDataDir",
    "chromeTargetId",
    "targetCloseCapability",
    "tabUrl",
    "controllerPid",
    "recoveryCleanupResources",
    "recoveryCleanupResult",
  ]) {
    expect(Reflect.get(value, field)).toBeUndefined();
  }
}

const targetId = "recoverable-target";
const conversationUrl = `https://chatgpt.com/c/${targetId}`;
type ArchivePromptLocator = {
  conversationId: string;
  promptSha256: string;
  verifiedUserTurnIndex: number;
  verifiedUserTurnId: string;
  verifiedUserMessageId: string;
  epoch: { epochId: string };
};

function archiveEffectAuthority(
  promptLocator: ArchivePromptLocator | undefined,
): BrowserArchiveEffectReceipt | undefined {
  if (!promptLocator) return undefined;
  return {
    conversationId: promptLocator.conversationId,
    promptEpoch: {
      epochId: promptLocator.epoch.epochId,
      promptSha256: promptLocator.promptSha256,
      userTurnIndex: promptLocator.verifiedUserTurnIndex,
      userTurnId: promptLocator.verifiedUserTurnId,
      userMessageId: promptLocator.verifiedUserMessageId,
    },
  };
}

function archiveResultHasCommittedEffectAuthority(
  archive: { archived?: boolean; effectAuthority?: BrowserArchiveEffectReceipt },
  locator: ArchivePromptLocator,
): boolean {
  const receipt = archive.effectAuthority;
  const epoch = receipt?.promptEpoch;
  if (!archive.archived || !receipt || !epoch) return false;
  return (
    receipt.conversationId === locator.conversationId &&
    epoch.epochId === locator.epoch.epochId &&
    epoch.promptSha256 === locator.promptSha256 &&
    epoch.userTurnIndex === locator.verifiedUserTurnIndex &&
    epoch.userTurnId === locator.verifiedUserTurnId &&
    epoch.userMessageId === locator.verifiedUserMessageId
  );
}
async function chromeProcessIdentity(
  userDataDir: string,
  pid: number,
  launchClaim: ChromeProcessLaunchClaim,
): Promise<ChromeProcessIdentity> {
  const profileDirectory = await captureProfileDirectoryIdentity(userDataDir);
  return {
    pid,
    processStartTime: "disconnect-fixture-process-generation",
    executablePath:
      profileDirectory.platform === "win32"
        ? String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`.toLowerCase()
        : profileDirectory.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : "/usr/bin/google-chrome",
    normalizedUserDataDir:
      profileDirectory.platform === "win32"
        ? profileDirectory.canonicalPath.toLowerCase()
        : profileDirectory.canonicalPath,
    launchNonce: launchClaim.nonce,
    launchClaim,
    profileDirectory,
  };
}

function createClient(options: {
  onDisconnect?: (handler: () => void) => void;
  currentUrl?: () => string;
}) {
  const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
    result: {
      value: expression === "location.href" ? (options.currentUrl?.() ?? conversationUrl) : 0,
    },
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
    verifyCommittedPromptTurn: Mock;
    verifyPromptCommitted: Mock;
    connectToRemoteChromeTarget: Mock;
    closeRemoteConnection: Mock;
    closeChromeTarget: Mock;
    probeChromeTargetLiveness: Mock;
    runtimeHints: BrowserRuntimeMetadata[];
    unhandledRejections: unknown[];
    providerObservedDispatchStart: boolean;
    committedTurnVerified: boolean;
    postArchiveIdentityVerifications: number;
  }) => Promise<void> | void,
  options: RemoteDisconnectFixtureOptions = {},
): Promise<void> {
  let disconnectHandler: (() => void) | undefined;
  let providerObservedDispatchStart = false;
  let committedTurnVerified = false;
  let currentUrl = conversationUrl;
  let postArchiveIdentityVerifications = 0;
  let assistantResponseAvailable = false;
  const runtimePersistenceError = new Error("remote runtime persistence unavailable");
  const runtimeHints: BrowserRuntimeMetadata[] = [];
  const closeRemoteConnection = vi.fn().mockResolvedValue(undefined);
  const closeChromeTarget = vi.fn().mockResolvedValue(true);
  const closeChromeTargetWithExactAuthority = vi
    .fn()
    .mockResolvedValue({ status: "completed" as const });
  const probeChromeTargetLiveness = vi.fn().mockResolvedValue({
    endpointReachable: true,
    targetFound: !options.targetExitsDuringFinalArchive,
    matchedUrl: options.targetExitsDuringFinalArchive ? undefined : conversationUrl,
  });
  const client = createClient({
    currentUrl: () => currentUrl,
    onDisconnect: (handler) => {
      disconnectHandler = handler;
    },
  });
  const recoveryClient = createClient({ currentUrl: () => currentUrl });
  const connectToRemoteChromeTarget = vi.fn().mockResolvedValue({
    client: recoveryClient,
    targetId,
    ownership: "attached",
    close: vi.fn().mockResolvedValue(undefined),
  });
  const archiveChatGptConversation = vi.fn(
    async (
      _Runtime: unknown,
      _logger: unknown,
      archiveOptions: { promptLocator?: ArchivePromptLocator },
    ) => {
      if (options.archiveNavigatesToNonConversationRoute) currentUrl = "https://chatgpt.com/";
      if (!options.disconnectDuringSubmission && options.disconnectDuringFinalArchive !== false) {
        disconnectHandler?.();
      }
      await Promise.resolve();
      return {
        mode: "always",
        attempted: true,
        archived: true,
        conversationUrl,
        effectAuthority: archiveEffectAuthority(archiveOptions.promptLocator),
      };
    },
  );
  const verifyCommittedPromptTurn = vi.fn(async () => {
    if (currentUrl !== conversationUrl && !currentUrl.includes(`/c/${targetId}`)) {
      postArchiveIdentityVerifications += 1;
      throw new Error("committed turn unavailable after archive navigation");
    }
    if (!providerObservedDispatchStart) {
      throw new Error("Committed-turn verification preceded provider dispatch");
    }
    committedTurnVerified = true;
  });
  const verifyPromptCommitted = vi.fn().mockResolvedValue({
    committedTurns: 1,
    promptSha256: promptIdentitySha256("keep this submitted conversation"),
    verifiedUserTurnIndex: 0,
    verifiedUserTurnId: "turn-0",
    verifiedUserMessageId: "message-0",
    conversationId: targetId,
  });

  vi.resetModules();
  vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
    connectToRemoteChrome: vi.fn().mockResolvedValue({
      client,
      targetId,
      ownership,
      targetCloseAuthority: {
        runExactOperation: vi.fn(),
        release: closeRemoteConnection,
      },
      close: closeRemoteConnection,
    }),
    connectToRemoteChromeTarget,
    closeChromeTarget,
    closeChromeTargetWithExactAuthority,
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
    readAssistantSnapshot: vi.fn(async () =>
      assistantResponseAvailable
        ? {
            text: "completed answer",
            html: "<p>completed answer</p>",
            turnIndex: 1,
            turnId: "assistant-turn-1",
            messageId: "assistant-message-1",
          }
        : null,
    ),
    verifyCommittedPromptTurn,
    verifyPromptCommitted,
    waitForAssistantResponse: vi.fn(async () => {
      assistantResponseAvailable = true;
      return { text: "completed answer", meta: {} };
    }),
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
    runProviderSubmissionFlow: vi.fn(() => {
      providerObservedDispatchStart = true;
      if (options.disconnectDuringSubmission) {
        disconnectHandler?.();
        return new Promise<never>(() => undefined);
      }
      return Promise.resolve({
        status: "committed" as const,
        verification: {
          committedTurns: 1,
          promptSha256: promptIdentitySha256("keep this submitted conversation"),
          verifiedUserTurnIndex: 0,
          verifiedUserTurnId: "turn-0",
          verifiedUserMessageId: "message-0",
          conversationId: targetId,
        },
      });
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
    archiveResultHasCommittedEffectAuthority,
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
    const { result: error, unhandledRejections } = await captureUnhandledRejections(() =>
      runBrowserMode({
        prompt: "keep this submitted conversation",
        config: {
          remoteChrome: { host: "remote.example", port: 9333 },
          cookieSync: false,
          manualLogin: false,
          headless: true,
          modelStrategy: "ignore",
          archiveConversations: "always",
        },
        runtimeHintCb: async (runtime) => {
          runtimeHints.push(runtime);
          if (
            options.runtimePersistenceFailsAfterCommit &&
            runtime.promptEpoch?.status === "committed"
          ) {
            throw runtimePersistenceError;
          }
        },
      }).catch((caught) => caught),
    );

    await verify({
      error,
      browserAutomationError,
      archiveChatGptConversation,
      closeRemoteConnection,
      closeChromeTarget,
      probeChromeTargetLiveness,
      verifyCommittedPromptTurn,
      verifyPromptCommitted,
      connectToRemoteChromeTarget,
      providerObservedDispatchStart,
      committedTurnVerified,
      runtimeHints,
      unhandledRejections,
      postArchiveIdentityVerifications,
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
    browserAutomationError: BrowserAutomationErrorConstructor;
    closeChromeTarget: Mock;
    kill: Mock;
    connectToRemoteChromeTarget: Mock;
    probeChromeTargetLiveness: Mock;
    verifyPromptCommitted: Mock;
    verifyCommittedPromptTurn: Mock;
    archiveChatGptConversation: Mock;
    writeOracleChromeOwner: Mock;
    profileDir: string;
    processIdentity: ChromeProcessIdentity;
    runtimeHints: BrowserRuntimeMetadata[];
    preArchiveCaptures: unknown[];
    unhandledRejections: unknown[];
    providerObservedDispatchStart: boolean;
    providerDispatchCommitVerified: boolean;
    committedTurnVerified: boolean;
    postArchiveIdentityVerifications: number;
  }) => Promise<void> | void,
): Promise<void> {
  let disconnectHandler: (() => void) | undefined;
  let profileDir = "";
  let processIdentity: ChromeProcessIdentity | null = null;
  let providerObservedDispatchStart = false;
  let providerDispatchCommitVerified = false;
  let committedTurnVerified = false;
  let assistantResponseAvailable = false;
  let finalArchiveCompleted = false;
  let currentUrl = conversationUrl;
  let postArchiveIdentityVerifications = 0;
  const ownerPublicationError = new Error("local Chrome owner publication unavailable");
  const writeOracleChromeOwner = vi.fn();
  const archiveChatGptConversation = vi.fn(
    async (
      _Runtime: unknown,
      _logger: unknown,
      archiveOptions: { promptLocator?: ArchivePromptLocator },
    ) => {
      if (options.archiveNavigatesToDifferentConversation) {
        currentUrl = "https://chatgpt.com/c/a-different-conversation";
        return {
          mode: "always",
          attempted: true,
          archived: false,
          reason: "archive-authority-mismatch",
          conversationUrl,
        };
      }
      if (
        options.archiveNavigatesToNonConversationRoute ||
        options.unguardedArchiveNavigatesToNonConversationRoute
      ) {
        currentUrl = "https://chatgpt.com/";
      }
      if (options.disconnectDuringFinalArchive) disconnectHandler?.();
      await Promise.resolve();
      finalArchiveCompleted = true;
      return {
        mode: "always",
        attempted: true,
        archived: true,
        conversationUrl,
        effectAuthority:
          options.finalIdentityChangesAfterArchive ||
          options.unguardedArchiveNavigatesToNonConversationRoute
            ? undefined
            : archiveEffectAuthority(archiveOptions.promptLocator),
      };
    },
  );
  const preArchiveCaptures: unknown[] = [];
  const verifyCommittedPromptTurn = vi.fn(async () => {
    if (finalArchiveCompleted && currentUrl !== conversationUrl) {
      postArchiveIdentityVerifications += 1;
      if (options.archiveNavigatesToDifferentConversation) {
        throw new Error("committed turn identity changed after archive navigation");
      }
      throw new Error("committed turn unavailable after archive navigation");
    }
    if (options.finalIdentityChangesAfterArchive && finalArchiveCompleted) {
      throw new Error("committed turn identity changed after archive");
    }
    if (!providerObservedDispatchStart) {
      throw new Error("Committed-turn verification preceded provider dispatch");
    }
    committedTurnVerified = true;
  });
  const runtimePersistenceError = new Error("local runtime persistence unavailable");
  const runtimeHints: BrowserRuntimeMetadata[] = [];
  const closeChromeTarget = vi.fn().mockResolvedValue(true);
  const kill = vi.fn().mockResolvedValue({ status: "stopped", pid: 1234, signal: "SIGTERM" });
  const closeChromeTargetWithExactAuthority = vi.fn(
    async ({
      targetId: exactTargetId,
      logger,
    }: {
      targetId: string;
      logger: (message: string) => void;
    }) => {
      const closed = await closeChromeTarget({
        port: 9230,
        targetId: exactTargetId,
        host: "127.0.0.1",
        logger,
      });
      return closed
        ? ({ status: "completed" } as const)
        : ({ status: "unsafe", reason: "target close was not confirmed" } as const);
    },
  );
  const probeChromeTargetLiveness = vi.fn().mockResolvedValue({
    endpointReachable: true,
    targetFound: !options.targetExitsDuringFinalArchive,
    matchedUrl: options.targetExitsDuringFinalArchive ? undefined : conversationUrl,
  });
  const verifyPromptCommitted = vi.fn().mockImplementation(async () => {
    if (options.semanticProbeSucceeds === false) {
      throw new Error("prompt commit not observed");
    }
    if (!providerObservedDispatchStart) {
      throw new Error("Prompt-commit verification preceded provider dispatch");
    }
    providerDispatchCommitVerified = true;
    return {
      committedTurns: 2,
      promptSha256: promptIdentitySha256("keep this submitted conversation"),
      verifiedUserTurnIndex: 1,
      verifiedUserTurnId: "turn-1",
      verifiedUserMessageId: "message-1",
      conversationId: targetId,
    };
  });
  const primaryClient = createClient({
    currentUrl: () => currentUrl,
    onDisconnect: (handler) => {
      disconnectHandler = handler;
    },
  });
  const recoveryClient = createClient({ currentUrl: () => currentUrl });
  const connectToRemoteChromeTarget = vi.fn().mockResolvedValue({
    client: recoveryClient,
    targetId,
    ownership: "attached",
    close: vi.fn().mockResolvedValue(undefined),
  });

  vi.resetModules();
  vi.doMock("../../src/browser/profileState.js", async (importOriginal) => {
    const actual = await importOriginal<typeof ProfileStateModule>();
    writeOracleChromeOwner.mockImplementation(
      async (userDataDir: string, owner: OracleChromeOwnerRecord) => {
        if (options.ownerPublicationFailsAfterCapture) throw ownerPublicationError;
        await actual.writeOracleChromeOwner(userDataDir, owner);
      },
    );
    return { ...actual, writeOracleChromeOwner };
  });
  vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
    launchChrome: vi.fn(
      async (
        _config: unknown,
        userDataDir: string,
        _logger: (message: string) => void,
        deps?: { launchClaim?: ChromeProcessLaunchClaim },
      ) => {
        profileDir = userDataDir;
        const launchClaim = deps?.launchClaim;
        if (!launchClaim) throw new Error("launch claim was not supplied");
        processIdentity = await chromeProcessIdentity(userDataDir, 1234, launchClaim);
        return {
          pid: 1234,
          port: 9230,
          process: { unref: vi.fn() },
          remoteDebuggingPipes: null,
          kill,
          processIdentity,
          endpointAuthority: {
            browserWSEndpoint: "ws://127.0.0.1:9230/devtools/browser/disconnect-fixture",
            kill,
            runExactOperation: vi.fn(),
            release: vi.fn().mockResolvedValue(undefined),
          },
        };
      },
    ),
    registerTerminationHooks: vi.fn(() => vi.fn()),
    connectWithNewTabWithExactAuthority: vi
      .fn()
      .mockResolvedValue({ client: primaryClient, targetId }),
    connectToRemoteChromeTarget,
    closeChromeTarget,
    closeChromeTargetWithExactAuthority,
    closeBlankChromeTabsWithExactAuthority: vi.fn().mockResolvedValue({ status: "completed" }),
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
    verifyCommittedPromptTurn,
    verifyPromptCommitted,
    readAssistantSnapshot: vi.fn(async () =>
      assistantResponseAvailable
        ? {
            text: "completed answer",
            html: "<p>completed answer</p>",
            turnIndex: 1,
            turnId: "assistant-turn-1",
            messageId: "assistant-message-1",
          }
        : null,
    ),
    waitForAssistantResponse: vi.fn(async () => {
      assistantResponseAvailable = true;
      return { text: "completed answer", meta: {} };
    }),
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
    runProviderSubmissionFlow: vi.fn(() => {
      providerObservedDispatchStart = true;
      if (
        options.disconnectDuringFinalArchive ||
        options.finalIdentityChangesAfterArchive ||
        options.archiveNavigatesToNonConversationRoute ||
        options.unguardedArchiveNavigatesToNonConversationRoute ||
        options.archiveNavigatesToDifferentConversation
      ) {
        return Promise.resolve({
          status: "committed" as const,
          verification: {
            committedTurns: 1,
            promptSha256: promptIdentitySha256("keep this submitted conversation"),
            verifiedUserTurnIndex: 0,
            verifiedUserTurnId: "turn-0",
            verifiedUserMessageId: "message-0",
            conversationId: targetId,
          },
        });
      }
      disconnectHandler?.();
      // Keep the provider dispatch in flight so the fixture can only advance through the
      // disconnect listener's fresh semantic assessment, never an event-loop timing race.
      return new Promise<never>(() => undefined);
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
    archiveResultHasCommittedEffectAuthority,
    archiveChatGptConversation,
  }));
  vi.doMock("../../src/browser/actions/thinkingStatus.js", () => ({
    startThinkingStatusMonitor: vi.fn(() => vi.fn()),
  }));

  try {
    // The literal dynamic imports are intentional: each scenario must load the runner and
    // error class from the same post-mock module graph.
    const [{ runBrowserMode }, { BrowserAutomationError: browserAutomationError }] =
      await Promise.all([
        import("../../src/browser/index.js"),
        import("../../src/oracle/errors.js"),
      ]);
    const { result: error, unhandledRejections } = await captureUnhandledRejections(() =>
      runBrowserMode({
        prompt: "keep this submitted conversation",
        config: {
          cookieSync: false,
          manualLogin: false,
          headless: true,
          modelStrategy: "ignore",
          archiveConversations:
            options.disconnectDuringFinalArchive ||
            options.finalIdentityChangesAfterArchive ||
            options.archiveNavigatesToNonConversationRoute ||
            options.unguardedArchiveNavigatesToNonConversationRoute ||
            options.archiveNavigatesToDifferentConversation
              ? "always"
              : "never",
          ...(options.copiedProfile
            ? { copyProfileSource: path.join(os.tmpdir(), "source-profile") }
            : {}),
        },
        preArchiveCaptureCb: async (capture) => {
          preArchiveCaptures.push(capture);
        },
        runtimeHintCb: async (runtime) => {
          runtimeHints.push(runtime);
          if (
            options.runtimePersistenceFailsAfterCommit &&
            runtime.promptEpoch?.status === "committed"
          ) {
            if (!providerDispatchCommitVerified) {
              throw new Error(
                "Committed runtime persistence rejection preceded verified provider dispatch",
              );
            }
            throw runtimePersistenceError;
          }
        },
      }).catch((caught) => caught),
    );
    if (!processIdentity) {
      throw new Error("Disconnect fixture did not acquire Chrome process authority");
    }

    await verify({
      error,
      browserAutomationError,
      closeChromeTarget,
      kill,
      connectToRemoteChromeTarget,
      probeChromeTargetLiveness,
      verifyPromptCommitted,
      verifyCommittedPromptTurn,
      archiveChatGptConversation,
      writeOracleChromeOwner,
      profileDir,
      processIdentity,
      runtimeHints,
      preArchiveCaptures,
      unhandledRejections,
      providerObservedDispatchStart,
      providerDispatchCommitVerified,
      committedTurnVerified,
      postArchiveIdentityVerifications,
    });
  } finally {
    if (profileDir) {
      await rm(profileDir, { recursive: true, force: true });
    }
    vi.doUnmock("../../src/browser/chromeLifecycle.js");
    vi.doUnmock("../../src/browser/profileState.js");
    vi.doUnmock("../../src/browser/profileCopy.js");
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
            chromePid: 1234,
            chromeProcessIdentity: fixture.processIdentity,
            conversationId: targetId,
            promptEpoch: {
              status: "committed",
              epochId: expect.any(String),
              promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              baselineTurns: 0,
              followUpOrdinal: 0,
              remainingFollowUps: 0,
              verifiedUserTurnIndex: 1,
              verifiedUserTurnId: "turn-1",
              verifiedUserMessageId: "message-1",
              conversationId: targetId,
            },
            recoveryCleanupResources: [
              expect.objectContaining({
                chromePid: 1234,
                chromeProcessIdentity: fixture.processIdentity,
                profileDirectoryIdentity: fixture.processIdentity.profileDirectory,
                chromePort: 9230,
                chromeHost: "127.0.0.1",
                chromeProfileRoot: fixture.profileDir,
                userDataDir: fixture.profileDir,
                chromeTargetId: targetId,
                conversationId: targetId,
                promptEpoch: expect.objectContaining({
                  status: "committed",
                  verifiedUserTurnId: "turn-1",
                  verifiedUserMessageId: "message-1",
                  conversationId: targetId,
                }),
                recoveryCleanup: {
                  ownsTarget: true,
                  profileKind: "temporary",
                  keepBrowser: false,
                  closeOwnedTargetOnComplete: false,
                } satisfies BrowserRecoveryCleanupMetadata,
              }),
            ],
          },
        },
      });
      expect(fixture.closeChromeTarget).not.toHaveBeenCalled();
      expect(fixture.kill).not.toHaveBeenCalled();
      await expect(access(fixture.profileDir)).resolves.toBeUndefined();
      await expect(readOracleChromeOwner(fixture.profileDir)).resolves.toEqual({
        port: 9230,
        processIdentity: fixture.processIdentity,
        disposition: "close-on-last-lease",
      });
    });
  }, 30_000);

  test("publishes exact local recovery when committed authority persistence rejects", async () => {
    await withDisconnectFixture({ runtimePersistenceFailsAfterCommit: true }, async (fixture) => {
      expect(fixture.providerObservedDispatchStart).toBe(true);
      expect(fixture.providerDispatchCommitVerified).toBe(true);
      expect(fixture.verifyPromptCommitted).toHaveBeenCalledTimes(1);
      expect(fixture.error).toBeInstanceOf(fixture.browserAutomationError);
      expect(fixture.error).toMatchObject({
        details: {
          stage: "connection-lost",
          recoverableDisconnect: true,
          disconnectCause: "cdp-client-disconnect",
          runtime: {
            chromePid: 1234,
            chromeProcessIdentity: fixture.processIdentity,
            chromeTargetId: targetId,
            conversationId: targetId,
            promptEpoch: expect.objectContaining({
              status: "committed",
              verifiedUserTurnIndex: 1,
              verifiedUserTurnId: "turn-1",
              verifiedUserMessageId: "message-1",
              conversationId: targetId,
            }),
            recoveryCleanupResult: { status: "pending" },
            recoveryCleanupResources: [
              expect.objectContaining({
                chromeTargetId: targetId,
                conversationId: targetId,
                promptEpoch: expect.objectContaining({
                  status: "committed",
                  verifiedUserTurnId: "turn-1",
                  verifiedUserMessageId: "message-1",
                }),
                recoveryCleanup: expect.objectContaining({
                  ownsTarget: true,
                  closeOwnedTargetOnComplete: false,
                }),
              }),
            ],
          },
        },
      });
      expect(
        fixture.runtimeHints.some((runtime) => runtime.promptEpoch?.status === "committed"),
      ).toBe(true);
      expect(fixture.unhandledRejections).toEqual([]);
      expect(fixture.closeChromeTarget).not.toHaveBeenCalled();
      expect(fixture.kill).not.toHaveBeenCalled();
      await expect(access(fixture.profileDir)).resolves.toBeUndefined();
      await expect(readOracleChromeOwner(fixture.profileDir)).resolves.toEqual({
        port: 9230,
        processIdentity: fixture.processIdentity,
        disposition: "close-on-last-lease",
      });
    });
  }, 30_000);

  test("preserves a captured local answer when final target liveness and owner publication fail", async () => {
    await withDisconnectFixture(
      {
        disconnectDuringFinalArchive: true,
        ownerPublicationFailsAfterCapture: true,
        targetExitsDuringFinalArchive: true,
      },
      async (fixture) => {
        expect(fixture.providerObservedDispatchStart).toBe(true);
        expect(fixture.committedTurnVerified).toBe(true);
        expect(fixture.archiveChatGptConversation).toHaveBeenCalledTimes(1);
        expect(fixture.probeChromeTargetLiveness).toHaveBeenCalledTimes(1);
        expect(await fixture.probeChromeTargetLiveness.mock.results[0]?.value).toMatchObject({
          endpointReachable: true,
          targetFound: false,
        });
        expect(fixture.error).not.toBeInstanceOf(fixture.browserAutomationError);
        expect(fixture.error).toMatchObject({
          answerText: "completed answer",
          answerMarkdown: "completed answer",
          archive: {
            attempted: true,
            archived: true,
            conversationUrl,
          },
          promptEpoch: {
            status: "committed",
            epochId: expect.any(String),
            promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            baselineTurns: 0,
            followUpOrdinal: 0,
            remainingFollowUps: 0,
            verifiedUserTurnIndex: 0,
            verifiedUserTurnId: "turn-0",
            verifiedUserMessageId: "message-0",
            conversationId: targetId,
          },
          warnings: expect.arrayContaining([
            expect.objectContaining({ code: "browser-final-target-liveness-pending" }),
            expect.objectContaining({ code: "browser-owner-publication-pending" }),
          ]),
        });
        expectCompletedPublicBrowserResult(fixture.error);
        expect(fixture.runtimeHints).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              promptEpoch: expect.objectContaining({
                status: "committed",
                verifiedUserTurnId: "turn-0",
                verifiedUserMessageId: "message-0",
              }),
              recoveryCleanupResources: expect.arrayContaining([
                expect.objectContaining({
                  chromePid: 1234,
                  chromeProcessIdentity: fixture.processIdentity,
                  chromeTargetId: targetId,
                  targetCloseCapability: expect.objectContaining({
                    version: 1,
                    generationId: expect.any(String),
                    capabilityId: expect.any(String),
                  }),
                  recoveryCleanup: expect.objectContaining({ ownsTarget: true }),
                }),
              ]),
            }),
          ]),
        );
        expect(fixture.writeOracleChromeOwner).toHaveBeenCalledWith(fixture.profileDir, {
          port: 9230,
          processIdentity: fixture.processIdentity,
          disposition: "close-on-last-lease",
        });
        expect(fixture.unhandledRejections).toEqual([]);
        expect(fixture.closeChromeTarget).toHaveBeenCalledWith({
          port: 9230,
          targetId,
          host: "127.0.0.1",
          logger: expect.any(Function),
        });
        expect(fixture.kill).toHaveBeenCalledTimes(1);
        await expect(access(fixture.profileDir)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readOracleChromeOwner(fixture.profileDir)).resolves.toBeNull();
      },
    );
  }, 30_000);

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
  }, 30_000);

  test("publishes a preverified local answer when confirmed archive navigation leaves its conversation", async () => {
    await withDisconnectFixture(
      { archiveNavigatesToNonConversationRoute: true },
      async (fixture) => {
        expect(fixture.archiveChatGptConversation).toHaveBeenCalledTimes(1);
        expect(fixture.archiveChatGptConversation).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.objectContaining({
            promptLocator: expect.objectContaining({
              conversationId: targetId,
              verifiedUserTurnId: "turn-0",
              verifiedUserMessageId: "message-0",
            }),
          }),
        );
        expect(fixture.postArchiveIdentityVerifications).toBe(0);
        expect(fixture.error).not.toBeInstanceOf(fixture.browserAutomationError);
        expect(fixture.error).toMatchObject({
          answerText: "completed answer",
          archive: { archived: true },
        });
      },
    );
  }, 30_000);

  test("does not accept non-conversation navigation as proof of an unguarded archive", async () => {
    await withDisconnectFixture(
      { unguardedArchiveNavigatesToNonConversationRoute: true },
      async (fixture) => {
        expect(fixture.postArchiveIdentityVerifications).toBe(1);
        expect(fixture.error).toMatchObject({
          message: "committed turn unavailable after archive navigation",
        });
        expect(fixture.error).not.toHaveProperty("answerText");
      },
    );
  }, 30_000);

  test("stages A but aborts publication before an archive effect can target B", async () => {
    await withDisconnectFixture(
      { archiveNavigatesToDifferentConversation: true },
      async (fixture) => {
        expect(fixture.archiveChatGptConversation).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.objectContaining({
            promptLocator: expect.objectContaining({ conversationId: targetId }),
          }),
        );
        expect(fixture.postArchiveIdentityVerifications).toBe(0);
        expect(fixture.preArchiveCaptures).toHaveLength(1);
        expect(fixture.preArchiveCaptures[0]).toMatchObject({
          answerText: "completed answer",
        });
        expect(fixture.preArchiveCaptures[0]).not.toHaveProperty("archive");
        expect(fixture.error).toMatchObject({
          details: {
            stage: "browser-archive",
            code: "archive-authority-mismatch",
            conversationId: targetId,
          },
        });
        expect(fixture.error).not.toHaveProperty("answerText");
      },
    );
  }, 30_000);

  test("does not publish an answer after final committed-turn identity is lost", async () => {
    await withDisconnectFixture({ finalIdentityChangesAfterArchive: true }, async (fixture) => {
      expect(fixture.providerObservedDispatchStart).toBe(true);
      expect(fixture.verifyCommittedPromptTurn).toHaveBeenCalled();
      expect(fixture.committedTurnVerified).toBe(true);
      expect(fixture.archiveChatGptConversation).toHaveBeenCalled();
      expect(fixture.error).toMatchObject({
        message: "committed turn identity changed after archive",
      });
      expect(fixture.error).not.toHaveProperty("answerText");
      expect(fixture.closeChromeTarget).toHaveBeenCalledWith(expect.objectContaining({ targetId }));
      expect(fixture.kill).toHaveBeenCalledTimes(1);
      await expect(access(fixture.profileDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  }, 30_000);

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
          runtime: {
            promptEpoch: {
              status: "pending",
              epochId: expect.any(String),
              promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              baselineTurns: 0,
              followUpOrdinal: 0,
              remainingFollowUps: 0,
            },
          },
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
  }, 30_000);

  test("routes remote assessment persistence rejection into exact pending recovery", async () => {
    await withRemoteLateDisconnectFixture(
      "created",
      async (fixture) => {
        expect(fixture.providerObservedDispatchStart).toBe(true);
        expect(fixture.archiveChatGptConversation).not.toHaveBeenCalled();
        expect(fixture.probeChromeTargetLiveness).toHaveBeenCalledTimes(1);
        expect(fixture.connectToRemoteChromeTarget).toHaveBeenCalledWith(
          "remote.example",
          9333,
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
        expect(fixture.error).toBeInstanceOf(fixture.browserAutomationError);
        expect(fixture.error).toMatchObject({
          details: {
            stage: "connection-lost",
            recoverableDisconnect: true,
            disconnectCause: "cdp-client-disconnect",
            runtime: {
              browserTransport: "cdp",
              chromeHost: "remote.example",
              chromePort: 9333,
              chromeTargetId: targetId,
              conversationId: targetId,
              promptEpoch: expect.objectContaining({
                status: "committed",
                verifiedUserTurnIndex: 0,
                verifiedUserTurnId: "turn-0",
                verifiedUserMessageId: "message-0",
                conversationId: targetId,
              }),
              recoveryCleanupResult: { status: "pending" },
              recoveryCleanupResources: [
                expect.objectContaining({
                  chromeHost: "remote.example",
                  chromePort: 9333,
                  chromeTargetId: targetId,
                  conversationId: targetId,
                  promptEpoch: expect.objectContaining({
                    status: "committed",
                    verifiedUserTurnId: "turn-0",
                    verifiedUserMessageId: "message-0",
                  }),
                  recoveryCleanup: {
                    ownsTarget: true,
                    profileKind: "none",
                    keepBrowser: false,
                    closeOwnedTargetOnComplete: false,
                  },
                }),
              ],
            },
          },
        });
        expect(
          fixture.runtimeHints.some((runtime) => runtime.promptEpoch?.status === "committed"),
        ).toBe(true);
        expect(fixture.unhandledRejections).toEqual([]);
        expect(fixture.closeRemoteConnection).not.toHaveBeenCalled();
        expect(fixture.closeChromeTarget).not.toHaveBeenCalled();
      },
      { disconnectDuringSubmission: true, runtimePersistenceFailsAfterCommit: true },
    );
  });

  test("continues remote answer capture when committed authority persistence rejects", async () => {
    await withRemoteLateDisconnectFixture(
      "created",
      async (fixture) => {
        expect(fixture.providerObservedDispatchStart).toBe(true);
        expect(fixture.committedTurnVerified).toBe(true);
        expect(fixture.archiveChatGptConversation).toHaveBeenCalledTimes(1);
        expect(fixture.error).not.toBeInstanceOf(fixture.browserAutomationError);
        expect(fixture.error).toMatchObject({
          answerText: "completed answer",
          answerMarkdown: "completed answer",
          promptEpoch: {
            status: "committed",
            epochId: expect.any(String),
            promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            baselineTurns: 0,
            followUpOrdinal: 0,
            remainingFollowUps: 0,
            verifiedUserTurnIndex: 0,
            verifiedUserTurnId: "turn-0",
            verifiedUserMessageId: "message-0",
            conversationId: targetId,
          },
          warnings: expect.arrayContaining([
            expect.objectContaining({ code: "prompt-commit-journal-pending" }),
            expect.objectContaining({ code: "direct-finalize-cleanup-pending" }),
          ]),
        });
        expectCompletedPublicBrowserResult(fixture.error);
        expect(fixture.runtimeHints).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              promptEpoch: expect.objectContaining({
                status: "committed",
                verifiedUserTurnId: "turn-0",
                verifiedUserMessageId: "message-0",
              }),
              recoveryCleanupResources: expect.arrayContaining([
                expect.objectContaining({
                  chromeHost: "remote.example",
                  chromePort: 9333,
                  chromeTargetId: targetId,
                  targetCloseCapability: expect.objectContaining({
                    version: 1,
                    generationId: expect.any(String),
                    capabilityId: expect.any(String),
                  }),
                  recoveryCleanup: expect.objectContaining({ ownsTarget: true }),
                }),
              ]),
            }),
          ]),
        );
        expect(fixture.probeChromeTargetLiveness).not.toHaveBeenCalled();
        expect(fixture.closeRemoteConnection).not.toHaveBeenCalled();
        expect(fixture.closeChromeTarget).not.toHaveBeenCalled();
        expect(fixture.unhandledRejections).toEqual([]);
      },
      { disconnectDuringFinalArchive: false, runtimePersistenceFailsAfterCommit: true },
    );
  });

  test("publishes a preverified remote answer when confirmed archive navigation leaves its conversation", async () => {
    await withRemoteLateDisconnectFixture(
      "created",
      async (fixture) => {
        expect(fixture.archiveChatGptConversation).toHaveBeenCalledTimes(1);
        expect(fixture.archiveChatGptConversation).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.objectContaining({
            promptLocator: expect.objectContaining({
              conversationId: targetId,
              verifiedUserTurnId: "turn-0",
              verifiedUserMessageId: "message-0",
            }),
          }),
        );
        expect(fixture.postArchiveIdentityVerifications).toBe(0);
        expect(fixture.error).not.toBeInstanceOf(fixture.browserAutomationError);
        expect(fixture.error).toMatchObject({
          answerText: "completed answer",
          archive: { archived: true },
        });
      },
      { archiveNavigatesToNonConversationRoute: true, disconnectDuringFinalArchive: false },
    );
  });

  test("preserves a committed remote answer with no stale cleanup claim when the final archive loses its target", async () => {
    await withRemoteLateDisconnectFixture(
      "created",
      async (fixture) => {
        expect(fixture.providerObservedDispatchStart).toBe(true);
        expect(fixture.committedTurnVerified).toBe(true);
        expect(fixture.verifyCommittedPromptTurn).toHaveBeenCalledWith(
          expect.objectContaining({ evaluate: expect.any(Function) }),
          expect.objectContaining({
            conversationId: targetId,
            verifiedUserTurnIndex: 0,
            verifiedUserTurnId: "turn-0",
            verifiedUserMessageId: "message-0",
          }),
        );
        expect(fixture.archiveChatGptConversation).toHaveBeenCalledTimes(1);
        expect(fixture.probeChromeTargetLiveness).toHaveBeenCalledTimes(1);
        expect(await fixture.probeChromeTargetLiveness.mock.results[0]?.value).toMatchObject({
          endpointReachable: true,
          targetFound: false,
        });
        expect(fixture.error).not.toBeInstanceOf(fixture.browserAutomationError);
        expect(fixture.error).toMatchObject({
          answerText: "completed answer",
          answerMarkdown: "completed answer",
          archive: {
            attempted: true,
            archived: true,
            conversationUrl,
          },
          promptEpoch: {
            status: "committed",
            epochId: expect.any(String),
            promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            baselineTurns: 0,
            followUpOrdinal: 0,
            remainingFollowUps: 0,
            verifiedUserTurnIndex: 0,
            verifiedUserTurnId: "turn-0",
            verifiedUserMessageId: "message-0",
            conversationId: targetId,
          },
          warnings: expect.arrayContaining([
            expect.objectContaining({ code: "browser-final-target-liveness-pending" }),
          ]),
        });
        expectCompletedPublicBrowserResult(fixture.error);
        expect(fixture.runtimeHints).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              recoveryCleanupResources: expect.arrayContaining([
                expect.objectContaining({
                  chromeTargetId: targetId,
                  targetCloseCapability: expect.objectContaining({
                    version: 1,
                    generationId: expect.any(String),
                    capabilityId: expect.any(String),
                  }),
                  recoveryCleanup: expect.objectContaining({ ownsTarget: true }),
                }),
              ]),
            }),
          ]),
        );
        expect(fixture.unhandledRejections).toEqual([]);
        expect(fixture.closeRemoteConnection).toHaveBeenCalledTimes(1);
        expect(fixture.closeChromeTarget).not.toHaveBeenCalled();
      },
      { targetExitsDuringFinalArchive: true },
    );
  });

  test("preserves an attached remote answer without claiming target ownership", async () => {
    await withRemoteLateDisconnectFixture("attached", async (fixture) => {
      expect(fixture.providerObservedDispatchStart).toBe(true);
      expect(fixture.committedTurnVerified).toBe(true);
      expect(fixture.verifyCommittedPromptTurn).toHaveBeenCalledWith(
        expect.objectContaining({ evaluate: expect.any(Function) }),
        expect.objectContaining({
          conversationId: targetId,
          verifiedUserTurnIndex: 0,
          verifiedUserTurnId: "turn-0",
          verifiedUserMessageId: "message-0",
        }),
      );
      expect(fixture.archiveChatGptConversation).toHaveBeenCalledTimes(1);
      expect(fixture.error).not.toBeInstanceOf(fixture.browserAutomationError);
      expect(fixture.error).toMatchObject({
        answerText: "completed answer",
        conversationId: targetId,
        promptEpoch: expect.objectContaining({
          status: "committed",
          verifiedUserTurnId: "turn-0",
          verifiedUserMessageId: "message-0",
          conversationId: targetId,
        }),
        warnings: expect.arrayContaining([
          expect.objectContaining({ code: "browser-final-target-liveness-pending" }),
        ]),
      });
      expectCompletedPublicBrowserResult(fixture.error);
      const attachedRuntime = fixture.runtimeHints.find(
        (runtime) =>
          runtime.promptEpoch?.status === "committed" &&
          runtime.recoveryCleanupResources?.some(
            (resource) =>
              resource.chromeTargetId === targetId && resource.recoveryCleanup.ownsTarget === false,
          ),
      );
      expect(attachedRuntime).toMatchObject({
        recoveryCleanupResources: [
          expect.objectContaining({
            chromeHost: "remote.example",
            chromePort: 9333,
            conversationId: targetId,
            chromeTargetId: targetId,
            promptEpoch: expect.objectContaining({
              status: "committed",
              verifiedUserTurnId: "turn-0",
              verifiedUserMessageId: "message-0",
              conversationId: targetId,
            }),
            recoveryCleanup: {
              ownsTarget: false,
              profileKind: "none",
              keepBrowser: false,
              closeOwnedTargetOnComplete: false,
            },
          }),
        ],
      });
      expect(attachedRuntime?.recoveryCleanupResources?.[0]?.targetCloseCapability).toBeUndefined();
      expect(fixture.unhandledRejections).toEqual([]);
      expect(fixture.closeRemoteConnection).not.toHaveBeenCalled();
      expect(fixture.closeChromeTarget).not.toHaveBeenCalled();
    });
  });
});
