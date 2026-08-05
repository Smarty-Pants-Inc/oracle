import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  resumeBrowserSession,
  retryBrowserRecoveryCleanup,
  __test__,
} from "../../src/browser/reattach.js";
import type {
  BrowserRecoveryCleanupMetadata,
  BrowserRuntimeMetadata,
} from "../../src/sessionStore.js";
import type { BrowserRecoveryCleanupResourceMetadata } from "../../src/sessionManager.js";
import type {
  BrowserLogger,
  BrowserRunTransaction,
  ChromeClient,
} from "../../src/browser/types.js";
import {
  captureProfileDirectoryIdentity,
  readOracleChromeOwner,
  writeOracleChromeOwner,
  type ChromeProcessIdentity,
} from "../../src/browser/profileState.js";
import type { RemoteRecoverySettlementOptions } from "../../src/remote/types.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";

function syntheticChromeProcessIdentity(userDataDir: string, pid?: number): ChromeProcessIdentity {
  const resolvedUserDataDir = path.resolve(userDataDir);
  const existsLocally = existsSync(resolvedUserDataDir);
  const canonicalPath = existsLocally ? realpathSync(resolvedUserDataDir) : resolvedUserDataDir;
  const physical = existsLocally ? statSync(canonicalPath, { bigint: true }) : null;
  return {
    pid: pid ?? 1234,
    processStartTime: "test-process-generation",
    executablePath:
      process.platform === "win32"
        ? String.raw`c:\program files\google\chrome\application\chrome.exe`
        : process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : "/usr/bin/google-chrome",
    normalizedUserDataDir:
      process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath,
    launchNonce: "11111111-1111-4111-8111-111111111111",
    profileDirectory: {
      version: 1,
      platform: process.platform,
      canonicalPath,
      device: physical?.dev.toString() ?? "1",
      inode: physical?.ino.toString() ?? "1",
    },
  };
}

async function physicalChromeProcessIdentity(
  userDataDir: string,
  pid = 1234,
): Promise<ChromeProcessIdentity> {
  const profileDirectory = await captureProfileDirectoryIdentity(userDataDir);
  return {
    pid,
    processStartTime: "test-process-generation",
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
    launchNonce: "11111111-1111-4111-8111-111111111111",
    profileDirectory,
  };
}

function withRecoveryCleanup(
  runtime: BrowserRuntimeMetadata,
  recoveryCleanup: BrowserRecoveryCleanupMetadata,
  remoteRecovery?: BrowserRecoveryCleanupResourceMetadata["remoteRecovery"],
): BrowserRuntimeMetadata {
  const resource: BrowserRecoveryCleanupResourceMetadata = {
    chromePid: runtime.chromePid,
    chromeProcessIdentity: runtime.chromeProcessIdentity,
    profileDirectoryIdentity: runtime.chromeProcessIdentity?.profileDirectory,
    chromePort: runtime.chromePort,
    chromeHost: runtime.chromeHost,
    chromeBrowserWSEndpoint: runtime.chromeBrowserWSEndpoint,
    chromeProfileRoot: runtime.chromeProfileRoot,
    userDataDir: runtime.userDataDir,
    chromeTargetId: runtime.chromeTargetId,
    conversationId: runtime.conversationId,
    promptEpoch: runtime.promptEpoch,
    remoteRecovery,
    recoveryCleanup,
  };
  return { ...runtime, recoveryCleanupResources: [resource] };
}

type FakeTarget = { id?: string; targetId?: string; type?: string; url?: string };
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
  Page?: { enable: () => void };
  close: () => Promise<void> | void;
};
function withCommittedPromptEpoch(
  runtime: BrowserRuntimeMetadata = {},
  verifiedUserTurnIndex = 1,
): BrowserRuntimeMetadata {
  const conversationId =
    runtime.conversationId ?? runtime.tabUrl?.match(/\/c\/([^/?#]+)/u)?.[1] ?? "test-conversation";
  const processIdentity =
    runtime.chromeProcessIdentity ??
    (runtime.recoveryCleanupResources?.some((resource) => !resource.remoteRecovery) &&
    runtime.userDataDir
      ? syntheticChromeProcessIdentity(runtime.userDataDir, runtime.chromePid)
      : undefined);
  const promptEpoch = {
    status: "committed" as const,
    epochId: `epoch-${conversationId}`,
    promptSha256: "a".repeat(64),
    baselineTurns: 0,
    followUpOrdinal: 0,
    remainingFollowUps: 0,
    verifiedUserTurnIndex,
    conversationId,
    verifiedUserTurnId: `turn-${verifiedUserTurnIndex}`,
    verifiedUserMessageId: `message-${verifiedUserTurnIndex}`,
  };
  return {
    ...runtime,
    ...(processIdentity ? { chromeProcessIdentity: processIdentity } : {}),
    conversationId,
    promptEpoch,
    recoveryCleanupResources: runtime.recoveryCleanupResources?.map((resource) => ({
      ...resource,
      chromeProcessIdentity: resource.chromeProcessIdentity ?? processIdentity,
      profileDirectoryIdentity:
        resource.profileDirectoryIdentity ?? processIdentity?.profileDirectory,
      conversationId: resource.conversationId ?? conversationId,
      promptEpoch: resource.promptEpoch ?? promptEpoch,
    })),
  };
}

type ManualOwnerSource = "launched" | "recorded" | "rediscovered";

async function resumeFallbackWithManualOwner(profileDir: string, source: ManualOwnerSource) {
  const processIdentity = await physicalChromeProcessIdentity(profileDir);
  const cleanupOrder: string[] = [];
  const acquisitionOrder: string[] = [];
  const runtimeHints: BrowserRuntimeMetadata[] = [];
  const closeChromeTarget = vi.fn(async () => {
    cleanupOrder.push("target");
    return true;
  });
  const terminateRecordedChromeForProfile = vi.fn(async () => ({
    status: "unsafe" as const,
    pid: processIdentity.pid,
    reason: "persisted owner lookup cannot safely terminate the still-live launch",
  }));
  const cleanupStaleProfileState = vi.fn(async () => {
    cleanupOrder.push("cleanup-profile");
    return true;
  });
  const releaseBrowserTabLease = vi.fn(
    async (
      _profileDir: string,
      _leaseId: string,
      _logger?: BrowserLogger,
      options?: { onRelease?: (context: { isLastLease: boolean }) => Promise<void> },
    ) => {
      cleanupOrder.push("lease");
      await options?.onRelease?.({ isLastLease: true });
    },
  );
  const acquireBrowserTabLease = vi.fn(
    async (_profileDir: string, options?: { leaseId?: string }) => {
      acquisitionOrder.push("acquire:tab-lease");
      return {
        id: options?.leaseId ?? "fallback-lease",
        profileDirectory: processIdentity.profileDirectory,
        update: vi.fn(async () => undefined),
        release: vi.fn(async () => undefined),
      };
    },
  );
  const Runtime = {
    enable: vi.fn(async () => undefined),
    evaluate: vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("document.readyState")) return { result: { value: "complete" } };
      if (expression.includes("/api/auth/session")) {
        return { result: { value: { ok: true, status: 200, sessionAuthenticated: true } } };
      }
      if (expression.includes("const selectors =")) return { result: { value: true } };
      return { result: { value: false } };
    }),
  };
  const client = {
    Runtime,
    DOM: { enable: vi.fn(async () => undefined) },
    Page: { enable: vi.fn(async () => undefined), navigate: vi.fn(async () => undefined) },
    Network: { getAllCookies: vi.fn(async () => ({ cookies: [] })) },
    Target: { getTargets: vi.fn(async () => ({ targetInfos: [] })) },
    close: vi.fn(async () => undefined),
  } as unknown as ChromeClient;
  const kill = vi.fn(async () => {
    cleanupOrder.push("kill");
    return { status: "stopped" as const, pid: processIdentity.pid };
  });
  const owner = {
    chrome: {
      pid: processIdentity.pid,
      port: 9222,
      host: "127.0.0.1",
      remoteDebuggingPipes: undefined,
      processIdentity,
      kill,
    },
    processIdentity,
    source,
    disposition: source === "launched" ? "close-on-last-lease" : "preserve",
  };
  const acquireManualChromeOwner = vi.fn(async () => {
    acquisitionOrder.push("acquire:chrome-process");
    return owner;
  });
  const createRecoveryTarget = vi.fn(
    async (_port: number, _logger: BrowserLogger, _host?: string, targetUrl?: string) => {
      acquisitionOrder.push("acquire:chrome-target");
      return targetUrl ? "fallback-owned-target" : undefined;
    },
  );
  const runtimeHintCb = vi.fn(async (hintedRuntime: BrowserRuntimeMetadata) => {
    const pendingResource =
      hintedRuntime.recoveryCleanupResources?.at(-1)?.acquisition?.pendingResource;
    acquisitionOrder.push(`persist:${pendingResource ?? "acquired"}`);
    runtimeHints.push(structuredClone(hintedRuntime));
  });
  const releaseRecoveryLock = vi.fn(async () => undefined);

  const result = await resumeBrowserSession(
    withCommittedPromptEpoch({ tabUrl: "https://chatgpt.com/c/test-conversation" }),
    {
      manualLogin: true,
      manualLoginProfileDir: profileDir,
      timeoutMs: 1_000,
    },
    vi.fn() as BrowserLogger,
    {
      acquireRecoveryLock: vi.fn(async () => ({ release: releaseRecoveryLock })),
      acquireBrowserTabLease: acquireBrowserTabLease as never,
      acquireManualChromeOwner: acquireManualChromeOwner as never,
      createRecoveryTarget,
      connectRecoveryTarget: vi.fn(async () => ({
        client,
        targetId: "fallback-owned-target",
        ownership: "created" as const,
        close: vi.fn(async () => undefined),
      })) as never,
      waitForConversationHydration: vi.fn(async () => 1),
      verifyCommittedPromptTurn: vi.fn(async () => undefined),
      waitForAssistantResponse: vi.fn(async () => ({
        text: "fallback answer",
        html: "",
        meta: { messageId: "assistant-2", turnId: "turn-2" },
      })),
      captureAssistantMarkdown: vi.fn(async () => "fallback markdown"),
      recoveryCleanup: {
        closeChromeTarget,
        terminateRecordedChromeForProfile,
        cleanupStaleProfileState,
        releaseBrowserTabLease,
      },
      runtimeHintCb,
    },
  );
  return {
    result,
    closeChromeTarget,
    terminateRecordedChromeForProfile,
    cleanupStaleProfileState,
    kill,
    releaseBrowserTabLease,
    cleanupOrder,
    acquisitionOrder,
    runtimeHints,
    releaseRecoveryLock,
    acquireBrowserTabLease,
    acquireManualChromeOwner,
    createRecoveryTarget,
  };
}

describe("resumeBrowserSession", { timeout: 15_000 }, () => {
  test("selects target and captures markdown via stubs", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-profile-"));
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
    const closeChromeTarget = vi.fn(async () => {
      cleanupOrder.push("target");
      return true;
    });
    const terminateRecordedChromeForProfile = vi.fn(async () => {
      cleanupOrder.push("terminate");
      return { status: "stopped", pid: 1234, signal: "SIGTERM" } as const;
    });
    const removeProfile = vi.fn(async () => {
      cleanupOrder.push("remove-profile");
      return true;
    });
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
      waitForConversationHydration,
      verifyCommittedPromptTurn,
      recoveryCleanup: { closeChromeTarget, terminateRecordedChromeForProfile, removeProfile },
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
    expect(closeChromeTarget).toHaveBeenCalledWith(
      expect.objectContaining({ port: 51559, targetId: "target-1" }),
    );
    expect(terminateRecordedChromeForProfile).toHaveBeenCalledWith(
      profileDir,
      runtime.chromeProcessIdentity,
      logger,
    );
    expect(removeProfile).toHaveBeenCalledWith(profileDir);
    await rm(profileDir, { recursive: true, force: true });
  }, 15_000);

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
    const logger = vi.fn() as BrowserLogger;

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
          promptSha256: "current-prompt-sha256",
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
        resumeBrowserSession(runtime, {}, vi.fn() as BrowserLogger, {
          listTargets: vi.fn(async () => {
            throw new Error("prior assistant answer must not be captured");
          }),
          waitForAssistantResponse,
        }),
      ).rejects.toThrow(/prompt epoch|conversation|follow-up/i);
    }
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
  });

  test("rejects a live conversation whose committed prompt identity no longer matches", async () => {
    const runtime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    });
    const listTargets = vi.fn(async () => [
      { targetId: "target-1", type: "page", url: runtime.tabUrl },
    ]) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
      result: { value: expression === "location.href" ? runtime.tabUrl : 2 },
    }));
    const close = vi.fn(async () => undefined);
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn();
    const captureAssistantMarkdown = vi.fn();
    const recoverSession = vi.fn();
    const verifyCommittedPromptTurn = vi.fn(async () => {
      throw new BrowserAutomationError("Committed prompt digest differs from the live user turn.", {
        stage: "browser-recovery-prompt-identity",
        code: "committed-prompt-identity-mismatch",
      });
    });

    await expect(
      resumeBrowserSession(runtime, { timeoutMs: 2000 }, vi.fn() as BrowserLogger, {
        listTargets,
        connect,
        waitForConversationHydration: vi.fn(async () => 2),
        verifyCommittedPromptTurn,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        recoverSession,
      }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: "committed-prompt-identity-mismatch" }),
    });

    expect(close).toHaveBeenCalledOnce();
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    expect(captureAssistantMarkdown).not.toHaveBeenCalled();
    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("uses Deep Research completion path when reattaching research sessions", async () => {
    const runtime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/deep",
    });
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
      if (expression.includes("querySelectorAll")) {
        return { result: { value: 3 } };
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
          Page: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn();
    const captureAssistantMarkdown = vi.fn();
    const waitForDeepResearchCompletion = vi.fn(async () => ({
      text: "Deep report body",
      html: "<p>Deep report body</p>",
      meta: { turnId: null, messageId: null },
    }));
    const verifyCommittedPromptTurn = vi.fn(async () => undefined);
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(
      runtime,
      { timeoutMs: 2000, researchMode: "deep" },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        waitForDeepResearchCompletion,
        waitForConversationHydration: vi.fn(async () => 2),
        verifyCommittedPromptTurn,
      },
    );

    expect(result.answerMarkdown).toBe("Deep report body");
    expect(waitForDeepResearchCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ evaluate }),
      logger,
      2000,
      2,
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        requireScopedTargetOwner: true,
        expectedConversationId: "deep",
        expectedPromptTurn: expect.objectContaining({
          conversationId: "deep",
          verifiedUserTurnIndex: 1,
          verifiedUserTurnId: "turn-1",
          verifiedUserMessageId: "message-1",
        }),
      }),
    );
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    await result.abort();
    expect(captureAssistantMarkdown).not.toHaveBeenCalled();
  });

  test("falls back to recovery when chrome port is missing", async () => {
    const runtime = withCommittedPromptEpoch({
      tabUrl: "https://chatgpt.com/c/abc",
    });
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, { recoverSession });

    expect(result.answerMarkdown).toBe("fallback-md");
    expect(recoverSession).toHaveBeenCalled();
    await result.abort();
  });

  test("journals fallback acquisition intent and exact identities before later side effects", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-journal-order-"));
    try {
      const {
        result,
        acquisitionOrder,
        runtimeHints,
        acquireBrowserTabLease,
        createRecoveryTarget,
      } = await resumeFallbackWithManualOwner(profileDir, "launched");

      expect(acquisitionOrder).toEqual([
        "persist:tab-lease",
        "acquire:tab-lease",
        "persist:chrome-process",
        "acquire:chrome-process",
        "persist:chrome-target",
        "acquire:chrome-target",
        "persist:acquired",
      ]);
      const leaseIntent = runtimeHints[0]?.recoveryCleanupResources?.at(-1);
      const targetIntent = runtimeHints[2]?.recoveryCleanupResources?.at(-1);
      const acquired = runtimeHints[3]?.recoveryCleanupResources?.at(-1);
      expect(leaseIntent).toMatchObject({
        tabLease: { id: expect.any(String) },
        acquisition: { generationId: expect.any(String), pendingResource: "tab-lease" },
      });
      expect(acquireBrowserTabLease).toHaveBeenCalledWith(
        profileDir,
        expect.objectContaining({ leaseId: leaseIntent?.tabLease?.id }),
      );
      expect(targetIntent).toMatchObject({
        chromeProcessIdentity: expect.any(Object),
        acquisition: {
          generationId: leaseIntent?.acquisition?.generationId,
          pendingResource: "chrome-target",
          targetMarkerUrl: expect.stringContaining("oracle-acquisition="),
        },
      });
      expect(createRecoveryTarget).toHaveBeenCalledWith(
        9222,
        expect.any(Function),
        "127.0.0.1",
        targetIntent?.acquisition?.targetMarkerUrl,
      );
      expect(acquired).toMatchObject({
        chromeTargetId: "fallback-owned-target",
        acquisition: { generationId: leaseIntent?.acquisition?.generationId },
      });
      expect(acquired?.acquisition?.pendingResource).toBeUndefined();

      await expect(result.abort()).resolves.toMatchObject({ status: "completed" });
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("keeps fallback process acquisition pending when its post-owner persistence is interrupted", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-crash-window-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir, 5_151);
    const interruption = new Error("controller interrupted after canonical owner creation");
    const runtimeHints: BrowserRuntimeMetadata[] = [];
    const retainedKill = vi.fn(async () => ({
      status: "unsafe" as const,
      pid: processIdentity.pid,
      reason: "simulated process interruption retained no live kill handle",
    }));
    const releaseRecoveryLock = vi.fn(async () => undefined);
    const owner = {
      chrome: {
        pid: processIdentity.pid,
        port: 9222,
        host: "127.0.0.1",
        remoteDebuggingPipes: undefined,
        processIdentity,
        kill: retainedKill,
      },
      processIdentity,
      source: "launched" as const,
      disposition: "close-on-last-lease" as const,
    };
    const releaseBrowserTabLease = vi.fn(
      async (
        _profileDir: string,
        _leaseId: string,
        _logger?: BrowserLogger,
        options?: {
          onRelease?: (context: { isLastLease: boolean }) => Promise<void>;
          expectedProfileIdentity?: ChromeProcessIdentity["profileDirectory"];
        },
      ) => {
        await options?.onRelease?.({ isLastLease: true });
      },
    );
    const acquireManualChromeOwner = vi.fn(async () => {
      await writeOracleChromeOwner(profileDir, {
        port: owner.chrome.port,
        processIdentity,
        disposition: owner.disposition,
      });
      return owner;
    });

    try {
      await expect(
        resumeBrowserSession(
          withCommittedPromptEpoch({ tabUrl: "https://chatgpt.com/c/crash-window" }),
          { manualLogin: true, manualLoginProfileDir: profileDir, timeoutMs: 1_000 },
          vi.fn() as BrowserLogger,
          {
            acquireBrowserTabLease: vi.fn(async () => ({
              id: "crash-window-lease",
              profileDirectory: processIdentity.profileDirectory,
              update: vi.fn(async () => undefined),
              release: vi.fn(async () => undefined),
            })) as never,
            acquireManualChromeOwner: acquireManualChromeOwner as never,
            runtimeHintCb: async (hint) => {
              runtimeHints.push(structuredClone(hint));
              if (
                hint.recoveryCleanupResources?.at(-1)?.acquisition?.pendingResource ===
                "chrome-target"
              ) {
                throw interruption;
              }
            },
            recoveryCleanup: { releaseBrowserTabLease },
            acquireRecoveryLock: vi.fn(async () => ({ release: releaseRecoveryLock })),
          },
        ),
      ).rejects.toMatchObject({ details: { code: "fallback-cleanup-pending" } });

      expect(await readOracleChromeOwner(profileDir)).toMatchObject({
        processIdentity,
        disposition: "close-on-last-lease",
      });
      const crashRuntime = runtimeHints.find(
        (hint) =>
          hint.recoveryCleanupResources?.at(-1)?.acquisition?.pendingResource === "chrome-process",
      );
      if (!crashRuntime) throw new Error("Chrome process acquisition intent was not persisted");
      const crashResource = crashRuntime?.recoveryCleanupResources?.at(-1);
      expect(crashResource).toMatchObject({
        acquisition: {
          pendingResource: "chrome-process",
          processOwnerProvenance: "manual-canonical-owner",
        },
      });
      expect(crashResource?.chromeProcessIdentity).toBeUndefined();

      const terminateRecordedChromeForProfile = vi.fn(async () => ({
        status: "stopped" as const,
        pid: processIdentity.pid,
        signal: "SIGTERM" as const,
      }));
      const recovery = await __test__.finalizeRecoveredRuntime(
        crashRuntime,
        vi.fn() as BrowserLogger,
        {
          readOracleChromeOwner: vi.fn(async () => null),
          terminateRecordedChromeForProfile,
        },
      );

      expect(recovery.status).toBe("pending");
      expect(recovery.runtime.recoveryCleanupResources).toEqual([crashResource]);
      expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
      expect(retainedKill).not.toHaveBeenCalled();
      expect(releaseRecoveryLock).toHaveBeenCalledOnce();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("fallback reattach uses retained kill authority for a temporary Chrome launch", async () => {
    let profileDir: string | null = null;
    const cleanupOrder: string[] = [];
    const kill = vi.fn(async () => {
      cleanupOrder.push("kill");
      return { status: "stopped" as const, pid: 4321, signal: "SIGTERM" as const };
    });
    const acquireTemporaryChromeOwner = vi.fn(
      async (_resolved: unknown, launchedProfileDir: string) => {
        profileDir = launchedProfileDir;
        return {
          pid: 4321,
          port: 9222,
          host: "127.0.0.1",
          remoteDebuggingPipes: undefined,
          processIdentity: await physicalChromeProcessIdentity(launchedProfileDir, 4321),
          kill,
        };
      },
    );
    const Runtime = {
      enable: vi.fn(async () => undefined),
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("document.readyState")) return { result: { value: "complete" } };
        if (expression.includes("hasChallengeScript")) {
          return { result: { value: { shell: true } } };
        }
        if (expression.includes("suspicious activity detected"))
          return { result: { value: false } };
        if (expression.includes("/api/auth/session")) {
          return { result: { value: { ok: true, status: 200, sessionAuthenticated: true } } };
        }
        if (expression.includes("const selectors =")) return { result: { value: true } };
        throw new Error(`Unexpected Runtime.evaluate expression: ${expression}`);
      }),
    };
    const client = {
      Runtime,
      DOM: { enable: vi.fn(async () => undefined) },
      Page: { enable: vi.fn(async () => undefined), navigate: vi.fn(async () => undefined) },
      Network: { getAllCookies: vi.fn(async () => ({ cookies: [] })) },
      Target: { getTargets: vi.fn(async () => ({ targetInfos: [] })) },
      close: vi.fn(async () => undefined),
    } as unknown as ChromeClient;
    const closeChromeTarget = vi.fn(async () => {
      cleanupOrder.push("target");
      return true;
    });
    const terminateRecordedChromeForProfile = vi.fn(async () => ({
      status: "unsafe" as const,
      pid: 4321,
      reason: "persisted owner lookup cannot safely terminate the still-live launch",
    }));
    const removeProfile = vi.fn(async () => {
      cleanupOrder.push("remove-profile");
      return true;
    });

    try {
      const result = await resumeBrowserSession(
        withCommittedPromptEpoch({ tabUrl: "https://chatgpt.com/c/test-conversation" }),
        { cookieSync: false, headless: true, manualLogin: false, timeoutMs: 1_000 },
        vi.fn() as BrowserLogger,
        {
          launchChrome: acquireTemporaryChromeOwner as never,
          acquireRecoveryLock: vi.fn(async () => ({
            release: vi.fn(async () => undefined),
          })),
          createRecoveryTarget: vi.fn(async () => "fallback-owned-target"),
          connectRecoveryTarget: vi.fn(async () => ({
            client,
            targetId: "fallback-owned-target",
            ownership: "created" as const,
            close: vi.fn(async () => undefined),
          })) as never,
          waitForConversationHydration: vi.fn(async () => 1),
          verifyCommittedPromptTurn: vi.fn(async () => undefined),
          waitForAssistantResponse: vi.fn(async () => ({
            text: "fallback answer",
            html: "",
            meta: { messageId: "assistant-2", turnId: "turn-2" },
          })),
          captureAssistantMarkdown: vi.fn(async () => "fallback markdown"),
          recoveryCleanup: {
            closeChromeTarget,
            terminateRecordedChromeForProfile,
            removeProfile,
          },
        },
      );
      expect(acquireTemporaryChromeOwner).toHaveBeenCalledWith(
        expect.objectContaining({ headless: true }),
        expect.stringMatching(/oracle-reattach-/),
        expect.any(Function),
      );

      await expect(result.abort()).resolves.toMatchObject({ status: "completed" });
      expect(closeChromeTarget).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: "fallback-owned-target" }),
      );
      expect(kill).toHaveBeenCalledOnce();
      expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
      expect(cleanupOrder).toEqual(["target", "kill", "remove-profile"]);
    } finally {
      if (profileDir) await rm(profileDir, { recursive: true, force: true });
    }
  }, 15_000);

  test("fallback reattach tears down a launched manual-login Chrome owner", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-launched-owner-"));
    try {
      const {
        result,
        closeChromeTarget,
        terminateRecordedChromeForProfile,
        cleanupStaleProfileState,
        kill,
        cleanupOrder,
        releaseRecoveryLock,
      } = await resumeFallbackWithManualOwner(profileDir, "launched");

      expect(result.runtime.recoveryCleanupResources).toEqual([
        expect.objectContaining({
          chromeTargetId: "fallback-owned-target",
          tabLease: expect.any(Object),
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "manual-login",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        }),
      ]);
      await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
      expect(closeChromeTarget).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: "fallback-owned-target" }),
      );
      expect(kill).toHaveBeenCalledOnce();
      expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
      expect(cleanupStaleProfileState).toHaveBeenCalledOnce();
      expect(releaseRecoveryLock).toHaveBeenCalledOnce();
      expect(cleanupOrder).toEqual(["target", "lease", "kill", "cleanup-profile"]);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 15_000);

  test.each(["recorded", "rediscovered"] as const)(
    "fallback reattach preserves a %s manual-login Chrome owner while cleaning its target and lease",
    async (source) => {
      const profileDir = await mkdtemp(path.join(os.tmpdir(), `oracle-reattach-${source}-owner-`));
      try {
        const {
          result,
          closeChromeTarget,
          terminateRecordedChromeForProfile,
          cleanupStaleProfileState,
          kill,
          cleanupOrder,
          releaseRecoveryLock,
        } = await resumeFallbackWithManualOwner(profileDir, source);

        expect(result.runtime.recoveryCleanupResources).toEqual([
          expect.objectContaining({
            chromeTargetId: "fallback-owned-target",
            tabLease: expect.any(Object),
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "manual-login",
              keepBrowser: true,
              closeOwnedTargetOnComplete: true,
            },
          }),
        ]);
        await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
        expect(closeChromeTarget).toHaveBeenCalledWith(
          expect.objectContaining({ targetId: "fallback-owned-target" }),
        );
        expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
        expect(cleanupStaleProfileState).not.toHaveBeenCalled();
        expect(kill).not.toHaveBeenCalled();
        expect(releaseRecoveryLock).toHaveBeenCalledOnce();
        expect(cleanupOrder).toEqual(["target", "lease"]);
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
  );

  test("tries live reattach from browser websocket metadata before falling back", async () => {
    const runtime = withCommittedPromptEpoch({
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeProfileRoot: path.join(os.tmpdir(), "oracle-attach-running-profile"),
      tabUrl: "https://chatgpt.com/c/abc",
      chromeTargetId: "target-2",
    });
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
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "attached-md");
    const verifyCommittedPromptTurn = vi.fn(async () => undefined);
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
        waitForConversationHydration: vi.fn(async () => 2),
        verifyCommittedPromptTurn,
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
    await result.abort();
  });

  test("closes the attached client before falling back to recovery", async () => {
    const runtime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    });
    const listTargets = vi.fn(async () => {
      return [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[];
    }) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const close = vi.fn(async () => {});
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "must not be captured from an unhydrated shell",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const waitForConversationHydration = vi.fn(async () => {
      throw new Error("saved conversation did not hydrate");
    });
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      waitForConversationHydration,
      recoverSession,
    });

    expect(result.answerText).toBe("fallback");
    expect(close).toHaveBeenCalledOnce();
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    expect(recoverSession).toHaveBeenCalled();
    await result.abort();
  });
  test("fails closed when the original target is missing among unrelated user tabs", async () => {
    const profileRoot = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-refresh-"));
    const refreshedPort = 63332;
    const refreshedEndpoint = `ws://127.0.0.1:${refreshedPort}/devtools/browser/refreshed`;
    const fallbackProfileRoot = path.join(profileRoot, "fallback-profile");
    await writeFile(
      path.join(profileRoot, "DevToolsActivePort"),
      `${refreshedPort}\n/devtools/browser/refreshed\n`,
      "utf8",
    );

    try {
      const runtime = withCommittedPromptEpoch(
        withRecoveryCleanup(
          {
            chromePort: 41111,
            chromeHost: "127.0.0.1",
            chromeBrowserWSEndpoint: "ws://127.0.0.1:41111/devtools/browser/stale",
            chromeProfileRoot: profileRoot,
            chromeTargetId: "missing-original-target",
            tabUrl: "https://chatgpt.com/c/abc",
          },
          {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        ),
      );
      const listTargets = vi.fn(async () => [
        { targetId: "unrelated-target", type: "page", url: "https://chatgpt.com/c/unrelated" },
        { targetId: "same-conversation-user-tab", type: "page", url: runtime.tabUrl },
      ]) as unknown as () => Promise<FakeTarget[]>;
      const connect = vi.fn(async () => {
        throw new Error("must not attach to a user-owned target");
      }) as unknown as (options?: unknown) => Promise<ChromeClient>;
      const waitForConversationHydration = vi.fn(async () => 2);
      const recoverSession = vi.fn(async (authoritativeRuntime: BrowserRuntimeMetadata) => ({
        answerText: "fallback",
        answerMarkdown: "fallback-md",
        runtime: {
          ...authoritativeRuntime,
          chromePid: 4242,
          chromePort: 64443,
          chromeBrowserWSEndpoint: undefined,
          chromeProfileRoot: fallbackProfileRoot,
          userDataDir: fallbackProfileRoot,
          chromeTargetId: undefined,
        },
      }));
      const closeChromeTarget = vi.fn(async () => false);

      const result = await resumeBrowserSession(runtime, {}, vi.fn() as BrowserLogger, {
        listTargets,
        connect,
        waitForConversationHydration,
        recoverSession,
        recoveryCleanup: { closeChromeTarget },
      });

      expect(result.answerMarkdown).toBe("fallback-md");
      expect(connect).not.toHaveBeenCalled();
      expect(waitForConversationHydration).not.toHaveBeenCalled();
      expect(recoverSession).toHaveBeenCalledWith(
        expect.objectContaining({
          chromePort: refreshedPort,
          chromeBrowserWSEndpoint: refreshedEndpoint,
          chromeTargetId: undefined,
        }),
        {},
      );
      expect(result.runtime.recoveryCleanupResources).toEqual([
        expect.objectContaining({
          chromePort: refreshedPort,
          chromeBrowserWSEndpoint: refreshedEndpoint,
          chromeTargetId: "missing-original-target",
        }),
      ]);

      const finalized = await result.finalize();
      expect(finalized).toMatchObject({
        status: "pending",
        error: expect.stringContaining("Chrome target close was not confirmed"),
      });
      expect(closeChromeTarget).toHaveBeenCalledOnce();
    } finally {
      await rm(profileRoot, { recursive: true, force: true });
    }
  });

  test("does not recover when an explicit browser tab reference is missing", async () => {
    const runtime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "stored-target",
      tabUrl: "https://chatgpt.com/c/abc",
    });
    const recoverSession = vi.fn(async () => ({
      answerText: "must not recover",
      answerMarkdown: "must not recover",
    }));
    const connect = vi.fn();

    await expect(
      resumeBrowserSession(
        runtime,
        { browserTabRef: "missing-explicit-target", timeoutMs: 2_000 },
        vi.fn() as BrowserLogger,
        {
          listTargets: vi.fn(async () => [
            { targetId: "other-target", type: "page", url: runtime.tabUrl },
          ]),
          connect,
          recoverSession,
        },
      ),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        code: "explicit-browser-tab-missing",
        reattachClassification: "explicit-selector-terminal",
      }),
    });

    expect(connect).not.toHaveBeenCalled();
    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("does not recover when an explicit browser tab reference is ambiguous", async () => {
    const runtime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "stored-target",
      tabUrl: "https://chatgpt.com/c/abc",
    });
    const recoverSession = vi.fn(async () => ({
      answerText: "must not recover",
      answerMarkdown: "must not recover",
    }));
    const connect = vi.fn();

    await expect(
      resumeBrowserSession(
        runtime,
        { browserTabRef: "abc", timeoutMs: 2_000 },
        vi.fn() as BrowserLogger,
        {
          listTargets: vi.fn(async () => [
            { targetId: "duplicate-1", type: "page", url: runtime.tabUrl },
            { targetId: "duplicate-2", type: "page", url: runtime.tabUrl },
          ]),
          connect,
          recoverSession,
        },
      ),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        code: "explicit-browser-tab-ambiguous",
        reattachClassification: "explicit-selector-terminal",
      }),
    });

    expect(connect).not.toHaveBeenCalled();
    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("rejects explicit target authority before remote recovery contact or persistence", async () => {
    const remoteRecovery = {
      protocolVersion: 3,
      host: "remote.example.test:9443",
      transactionToken: "e".repeat(64),
      state: "pending" as const,
    };
    const runtime = withRecoveryCleanup(
      {},
      {
        ownsTarget: false,
        profileKind: "none",
        keepBrowser: false,
      },
      remoteRecovery,
    );
    const acquireRecoveryLock = vi.fn();
    const resolveRemoteRecoveryConfig = vi.fn();
    const resumeRemoteBrowserTransaction = vi.fn();
    const runtimeHintCb = vi.fn();

    await expect(
      resumeBrowserSession(
        runtime,
        { browserTabRef: "explicit-remote-target", timeoutMs: 2_000 },
        vi.fn() as BrowserLogger,
        {
          acquireRecoveryLock,
          resumeRemoteBrowserTransaction,
          runtimeHintCb,
          recoveryCleanup: { resolveRemoteRecoveryConfig },
        },
      ),
    ).rejects.toMatchObject({
      details: {
        stage: "browser-reattach-explicit-target",
        code: "explicit-browser-tab-unsupported",
        browserTabRef: "explicit-remote-target",
        reattachClassification: "explicit-selector-terminal",
      },
    });

    expect(acquireRecoveryLock).not.toHaveBeenCalled();
    expect(resolveRemoteRecoveryConfig).not.toHaveBeenCalled();
    expect(resumeRemoteBrowserTransaction).not.toHaveBeenCalled();
    expect(runtimeHintCb).not.toHaveBeenCalled();
  });

  test("allows explicit-only local tab selection without claiming ownership", async () => {
    const runtime = withCommittedPromptEpoch(
      withRecoveryCleanup(
        {
          chromePort: 51559,
          chromeHost: "127.0.0.1",
          chromeTargetId: "missing-original-target",
          tabUrl: "https://chatgpt.com/c/abc",
        },
        {
          ownsTarget: false,
          profileKind: "none",
          keepBrowser: true,
        },
      ),
    );
    const listTargets = vi.fn(async () => [
      { targetId: "borrowed-target", type: "page", url: runtime.tabUrl },
    ]) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
      result: { value: expression === "location.href" ? runtime.tabUrl : 2 },
    }));
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close: vi.fn(async () => undefined),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const closeChromeTarget = vi.fn(async () => true);
    const resumeRemoteBrowserTransaction = vi.fn();

    const result = await resumeBrowserSession(
      runtime,
      { browserTabRef: "borrowed-target", timeoutMs: 2_000 },
      vi.fn() as BrowserLogger,
      {
        listTargets,
        connect,
        waitForConversationHydration: vi.fn(async () => 2),
        verifyCommittedPromptTurn: vi.fn(async () => undefined),
        waitForAssistantResponse: vi.fn(async () => ({
          text: "borrowed capture",
          html: "",
          meta: { messageId: "m1", turnId: "conversation-turn-3" },
        })),
        captureAssistantMarkdown: vi.fn(async () => "borrowed capture"),
        recoveryCleanup: { closeChromeTarget },
        resumeRemoteBrowserTransaction,
      },
    );

    expect(result.runtime).toMatchObject({
      chromeTargetId: "borrowed-target",
      recoveryCleanupResources: [
        expect.objectContaining({
          chromeTargetId: "borrowed-target",
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "none",
            keepBrowser: true,
          },
        }),
      ],
    });
    expect((await result.finalize()).status).toBe("completed");
    expect(closeChromeTarget).not.toHaveBeenCalled();
    expect(resumeRemoteBrowserTransaction).not.toHaveBeenCalled();
  });

  test("resumes projected pre-receipt remote authority without a local committed epoch", async () => {
    const requestIdentity = {
      acceptedPromptSha256: ["a".repeat(64)],
      followUpOrdinal: 0,
      remainingFollowUps: 0 as const,
    };
    const remoteRecovery = {
      protocolVersion: 3,
      host: "remote.example.test:9443",
      transactionToken: "d".repeat(64),
      state: "pre-receipt" as const,
      requestIdentity,
    };
    const runtime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          remoteRecovery,
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "none",
            keepBrowser: false,
          },
        },
      ],
    };
    const capturedRecovery = { ...remoteRecovery, state: "pending" as const };
    const capturedRuntime = withCommittedPromptEpoch(
      withRecoveryCleanup(
        {},
        {
          ownsTarget: false,
          profileKind: "none",
          keepBrowser: false,
        },
        capturedRecovery,
      ),
    );
    const settlementEvents: string[] = [];
    const finalize = vi.fn(async () => {
      settlementEvents.push("cleanup:finalize");
      return { status: "completed" as const, runtime: {} };
    });
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    const transaction = {
      answerText: "remote answer",
      answerMarkdown: "remote markdown",
      tookMs: 1,
      answerTokens: 2,
      answerChars: 13,
      runtime: capturedRuntime,
      finalize,
      abort,
    } satisfies BrowserRunTransaction;
    const resumeRemoteBrowserTransaction = vi.fn(async () => transaction);
    const listTargets = vi.fn(async () => []);
    const recoverSession = vi.fn(async () => ({
      answerText: "local fallback",
      answerMarkdown: "local fallback",
    }));
    const runtimeHintCb = vi.fn(async (hintedRuntime: BrowserRuntimeMetadata) => {
      settlementEvents.push(
        `persist:${hintedRuntime.recoveryCleanupResult?.settlementMode ?? "unbound"}`,
      );
    });
    const release = vi.fn(async () => undefined);

    const result = await resumeBrowserSession(runtime, {}, vi.fn() as BrowserLogger, {
      resumeRemoteBrowserTransaction,
      listTargets,
      recoverSession,
      runtimeHintCb,
      acquireRecoveryLock: vi.fn(async () => ({ release })),
      recoveryCleanup: {
        resolveRemoteRecoveryConfig: vi.fn(async () => ({
          host: remoteRecovery.host,
          token: "remote-auth-token",
        })),
      },
    });

    expect(result.answerMarkdown).toBe("remote markdown");
    expect(resumeRemoteBrowserTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime,
        configuredHost: remoteRecovery.host,
        authToken: "remote-auth-token",
        runtimeHintCb,
      }),
    );
    expect(listTargets).not.toHaveBeenCalled();
    expect(recoverSession).not.toHaveBeenCalled();
    expect((await result.finalize()).status).toBe("completed");
    expect(settlementEvents).toEqual(["persist:finalize", "cleanup:finalize", "persist:unbound"]);
    expect(runtimeHintCb).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
      }),
    );
    expect(runtimeHintCb).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ recoveryCleanupResult: expect.anything() }),
    );
    expect(finalize).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("recovery resource finalization", { timeout: 15_000 }, () => {
  const { finalizeRecoveredRuntime } = __test__;
  const stopped = { status: "stopped", pid: 1234, signal: "SIGTERM" } as const;

  test("derives the recovery lock from prompt identity and ordered cleanup authority", () => {
    const profileDir = path.join(os.tmpdir(), "oracle-browser-lock-identity");
    const runtime = withCommittedPromptEpoch(
      withRecoveryCleanup(
        {
          chromeProcessIdentity: syntheticChromeProcessIdentity(profileDir),
          chromeProfileRoot: profileDir,
          userDataDir: profileDir,
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/old",
          chromeTargetId: "old-target",
        },
        {
          ownsTarget: true,
          profileKind: "temporary",
          keepBrowser: false,
          closeOwnedTargetOnComplete: true,
        },
      ),
    );

    expect(
      __test__.defaultRecoveryLockPath({
        ...runtime,
        chromeHost: "localhost",
        chromePort: 9333,
        chromeBrowserWSEndpoint: "ws://localhost:9333/devtools/browser/new",
        chromeTargetId: "new-target",
      }),
    ).toBe(__test__.defaultRecoveryLockPath(runtime));
  });

  test("treats an already-absent contained temporary profile as complete", async () => {
    const profileDir = path.join(os.tmpdir(), "oracle-browser-already-absent-cleanup");
    await rm(profileDir, { recursive: true, force: true });
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const removeProfile = vi.fn(async () => true);

    const result = await finalizeRecoveredRuntime(
      withRecoveryCleanup(
        { userDataDir: profileDir },
        {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
        },
      ),
      vi.fn() as BrowserLogger,
      { terminateRecordedChromeForProfile, removeProfile },
    );

    expect(result.status).toBe("completed");
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    expect(removeProfile).not.toHaveBeenCalled();
  });

  test("removes an exact temporary profile even when no process was launched", async () => {
    const profileDir = await mkdtemp(
      path.join(os.tmpdir(), "oracle-browser-missing-process-identity-"),
    );
    const profileDirectoryIdentity = (await physicalChromeProcessIdentity(profileDir))
      .profileDirectory;
    const removeProfile = vi.fn(async () => true);
    try {
      const result = await finalizeRecoveredRuntime(
        {
          userDataDir: profileDir,
          recoveryCleanupResources: [
            {
              userDataDir: profileDir,
              profileDirectoryIdentity,
              recoveryCleanup: {
                ownsTarget: false,
                profileKind: "temporary",
                keepBrowser: false,
              },
            },
          ],
        },
        vi.fn() as BrowserLogger,
        { removeProfile },
      );

      expect(result.status).toBe("completed");
      expect(removeProfile).toHaveBeenCalledWith(profileDir);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("preserves cleanup when persisted process identity lacks physical profile authority", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-legacy-identity-"));
    const legacyIdentity = {
      pid: 1234,
      processStartTime: "legacy-process-generation",
      executablePath: "/usr/bin/google-chrome",
      normalizedUserDataDir: profileDir,
      launchNonce: "22222222-2222-4222-8222-222222222222",
    } as unknown as ChromeProcessIdentity;
    const runtime = withRecoveryCleanup(
      {
        chromeProcessIdentity: legacyIdentity,
        userDataDir: profileDir,
      },
      {
        ownsTarget: false,
        profileKind: "temporary",
        keepBrowser: false,
      },
    );
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    try {
      expect(() => __test__.defaultRecoveryLockPath(runtime)).not.toThrow();
      const resource = runtime.recoveryCleanupResources?.[0];
      expect(resource).toBeDefined();
      expect(() =>
        __test__.recoveryCleanupGroupKey(resource as BrowserRecoveryCleanupResourceMetadata),
      ).not.toThrow();

      const result = await finalizeRecoveredRuntime(runtime, vi.fn() as BrowserLogger, {
        terminateRecordedChromeForProfile,
      });

      expect(result).toMatchObject({
        status: "pending",
        error: expect.stringContaining("physical profile identity cleanup metadata is missing"),
      });
      expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("does not enter manual lease teardown without physical profile authority", async () => {
    const profileDir = await mkdtemp(
      path.join(os.tmpdir(), "oracle-browser-legacy-manual-profile-"),
    );
    const profileDirectory = await captureProfileDirectoryIdentity(profileDir);
    const legacyIdentity = {
      pid: 1234,
      processStartTime: "legacy-process-generation",
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
      launchNonce: "33333333-3333-4333-8333-333333333333",
    } as unknown as ChromeProcessIdentity;
    const teardownBrowserResourcesIfNoActiveLeases = vi.fn(async () => ({
      status: "completed" as const,
    }));

    try {
      const result = await finalizeRecoveredRuntime(
        withRecoveryCleanup(
          { chromeProcessIdentity: legacyIdentity, userDataDir: profileDir },
          {
            ownsTarget: false,
            profileKind: "manual-login",
            keepBrowser: false,
          },
        ),
        vi.fn() as BrowserLogger,
        { teardownBrowserResourcesIfNoActiveLeases },
      );

      expect(result).toMatchObject({
        status: "pending",
        error: expect.stringContaining("physical profile identity cleanup metadata is missing"),
      });
      expect(teardownBrowserResourcesIfNoActiveLeases).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("defers cleanup until finalize and runs the finalizer once", async () => {
    const events: string[] = [];
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-fallback-profile-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir);
    const runtime = withCommittedPromptEpoch(
      withRecoveryCleanup(
        {
          chromePort: 9222,
          chromeTargetId: "original-target",
          chromeProcessIdentity: processIdentity,
          userDataDir: profileDir,
        },
        {
          ownsTarget: true,
          profileKind: "temporary",
          keepBrowser: false,
          closeOwnedTargetOnComplete: true,
        },
      ),
    );
    const logger = vi.fn() as BrowserLogger;
    const result = await resumeBrowserSession(runtime, {}, logger, {
      recoverSession: vi.fn(async () => {
        events.push("fallback-capture");
        return { answerText: "fallback", answerMarkdown: "fallback" };
      }),
      recoveryCleanup: {
        closeChromeTarget: vi.fn(async () => {
          events.push("close-target");
          return true;
        }),
        terminateRecordedChromeForProfile: vi.fn(async () => {
          events.push("terminate");
          return stopped;
        }),
        removeProfile: vi.fn(async () => {
          events.push("remove-profile");
          await rm(profileDir, { recursive: true, force: true });
          return true;
        }),
      },
    });

    expect(events).toEqual(["fallback-capture"]);
    expect(result.runtime.recoveryCleanupResult).toEqual({ status: "pending" });
    const first = await result.finalize();
    const second = await result.finalize();
    expect(first.status).toBe("completed");
    expect(second).toBe(first);
    expect(events).toEqual(["fallback-capture", "close-target", "terminate", "remove-profile"]);
  });

  test("abort settles abort resources without running finalize", async () => {
    const finalizeResources = vi.fn(async () => ({
      status: "completed" as const,
      runtime: {},
    }));
    const abortResources = vi.fn(async () => ({
      status: "completed" as const,
      runtime: {},
    }));
    const result = await resumeBrowserSession(
      withCommittedPromptEpoch(),
      {},
      vi.fn() as BrowserLogger,
      {
        recoverSession: vi.fn(async () => ({
          answerText: "captured",
          answerMarkdown: "captured",
          finalizeResources,
          abortResources,
        })),
      },
    );

    await expect(result.abort()).resolves.toMatchObject({ status: "completed" });
    expect(abortResources).toHaveBeenCalledOnce();
    expect(finalizeResources).not.toHaveBeenCalled();
  });

  test("retains cleanup authority when Chrome termination is unsafe", async () => {
    const removeProfile = vi.fn(async () => true);
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-unsafe-cleanup-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir);
    try {
      const result = await finalizeRecoveredRuntime(
        withRecoveryCleanup(
          {
            userDataDir: profileDir,
            chromeProcessIdentity: processIdentity,
          },
          {
            ownsTarget: false,
            profileKind: "copied",
            keepBrowser: false,
          },
        ),
        vi.fn() as BrowserLogger,
        {
          terminateRecordedChromeForProfile: vi.fn(async () => ({
            status: "unsafe" as const,
            reason: "pid mismatch",
          })),
          removeProfile,
        },
      );

      expect(result).toMatchObject({
        status: "pending",
        runtime: {
          recoveryCleanupResources: [
            expect.objectContaining({
              userDataDir: profileDir,
              chromeProcessIdentity: processIdentity,
              profileDirectoryIdentity: processIdentity.profileDirectory,
              recoveryCleanup: {
                ownsTarget: false,
                profileKind: "copied",
                keepBrowser: false,
                closeOwnedTargetOnComplete: undefined,
              },
            }),
          ],
          recoveryCleanupResult: {
            status: "failed",
            error: expect.stringContaining("pid mismatch"),
          },
        },
      });
      expect(removeProfile).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("closes every shared-process target before one teardown", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-shared-group-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir);
    const events: string[] = [];
    const oldResource = {
      chromeProcessIdentity: processIdentity,
      chromePort: 9111,
      userDataDir: profileDir,
      chromeTargetId: "old-target",
      recoveryCleanup: {
        ownsTarget: true,
        profileKind: "temporary" as const,
        keepBrowser: false,
        closeOwnedTargetOnComplete: true,
      },
    };
    const currentResource = {
      ...oldResource,
      chromePort: 9222,
      chromeTargetId: "current-target",
    };
    try {
      const result = await finalizeRecoveredRuntime(
        {
          chromeProcessIdentity: processIdentity,
          chromePort: 9222,
          userDataDir: profileDir,
          chromeTargetId: "current-target",
          recoveryCleanupResources: [oldResource, { ...oldResource }, currentResource],
        },
        vi.fn() as BrowserLogger,
        {
          closeChromeTarget: vi.fn(async ({ targetId, port }) => {
            events.push(`close:${targetId}:${port}`);
            return true;
          }),
          terminateRecordedChromeForProfile: vi.fn(async () => {
            events.push("terminate");
            return stopped;
          }),
          removeProfile: vi.fn(async () => {
            events.push("remove-profile");
            return true;
          }),
        },
      );

      expect(result.status).toBe("completed");
      expect(events).toEqual([
        "close:old-target:9222",
        "close:current-target:9222",
        "terminate",
        "remove-profile",
      ]);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });
  test("holds the current lease through shared target close and atomic manual teardown", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-manual-lease-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir, 5151);
    try {
      const events: string[] = [];
      const releaseBrowserTabLease = vi.fn(
        async (
          _profileDir: string,
          _leaseId: string,
          _logger: BrowserLogger | undefined,
          options?: {
            onRelease?: (context: { isLastLease: boolean }) => Promise<void>;
            expectedProfileIdentity?: ChromeProcessIdentity["profileDirectory"];
          },
        ) => {
          events.push("release-current-lease");
          await options?.onRelease?.({ isLastLease: true });
        },
      );
      const oldResource: BrowserRecoveryCleanupResourceMetadata = {
        chromeProcessIdentity: processIdentity,
        profileDirectoryIdentity: processIdentity.profileDirectory,
        chromePort: 9222,
        userDataDir: profileDir,
        chromeTargetId: "old-target",
        recoveryCleanup: {
          ownsTarget: true,
          profileKind: "manual-login",
          keepBrowser: false,
          closeOwnedTargetOnComplete: true,
        },
      };
      const currentResource: BrowserRecoveryCleanupResourceMetadata = {
        ...oldResource,
        chromeTargetId: "current-target",
        tabLease: {
          id: "current-lease",
          profileDirectory: processIdentity.profileDirectory,
        },
      };
      const result = await finalizeRecoveredRuntime(
        {
          chromeProcessIdentity: processIdentity,
          chromePort: 9222,
          userDataDir: profileDir,
          chromeTargetId: "current-target",
          recoveryCleanupResources: [oldResource, currentResource],
        },
        vi.fn() as BrowserLogger,
        {
          closeChromeTarget: vi.fn(async ({ targetId }) => {
            events.push(`close:${targetId}`);
            return true;
          }),
          terminateRecordedChromeForProfile: vi.fn(async () => {
            events.push("terminate");
            return stopped;
          }),
          cleanupStaleProfileState: vi.fn(async () => {
            events.push("cleanup-profile-state");
            return true;
          }),
          releaseBrowserTabLease,
        },
      );

      expect(result.status).toBe("completed");
      expect(events).toEqual([
        "close:old-target",
        "close:current-target",
        "release-current-lease",
        "terminate",
        "cleanup-profile-state",
      ]);
      expect(releaseBrowserTabLease).toHaveBeenCalledOnce();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("does not let a permanently failing old group block current cleanup", async () => {
    const oldProfile = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-old-group-"));
    const currentProfile = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-current-group-"));
    const events: string[] = [];
    const oldIdentity = await physicalChromeProcessIdentity(oldProfile, 1111);
    const currentIdentity = await physicalChromeProcessIdentity(currentProfile, 2222);
    const oldResource: BrowserRecoveryCleanupResourceMetadata = {
      chromeProcessIdentity: oldIdentity,
      profileDirectoryIdentity: oldIdentity.profileDirectory,
      chromePort: 9222,
      userDataDir: oldProfile,
      chromeTargetId: "old-target",
      recoveryCleanup: {
        ownsTarget: true,
        profileKind: "temporary",
        keepBrowser: false,
        closeOwnedTargetOnComplete: true,
      },
    };
    const currentResource: BrowserRecoveryCleanupResourceMetadata = {
      chromeProcessIdentity: currentIdentity,
      profileDirectoryIdentity: currentIdentity.profileDirectory,
      chromePort: 9333,
      userDataDir: currentProfile,
      chromeTargetId: "current-target",
      recoveryCleanup: {
        ownsTarget: true,
        profileKind: "temporary",
        keepBrowser: false,
        closeOwnedTargetOnComplete: true,
      },
    };
    try {
      const result = await finalizeRecoveredRuntime(
        {
          chromeProcessIdentity: currentIdentity,
          chromePort: 9333,
          userDataDir: currentProfile,
          chromeTargetId: "current-target",
          recoveryCleanupResources: [oldResource, currentResource],
        },
        vi.fn() as BrowserLogger,
        {
          closeChromeTarget: vi.fn(async ({ targetId }) => {
            events.push(`close:${targetId}`);
            return targetId !== "old-target";
          }),
          terminateRecordedChromeForProfile: vi.fn(async (profileDir) => {
            events.push(`terminate:${profileDir}`);
            return stopped;
          }),
          removeProfile: vi.fn(async (profileDir) => {
            events.push(`remove:${profileDir}`);
            return true;
          }),
        },
      );

      expect(result.status).toBe("pending");
      expect(events).toEqual([
        "close:old-target",
        "close:current-target",
        `terminate:${currentProfile}`,
        `remove:${currentProfile}`,
      ]);
      expect(result.runtime.recoveryCleanupResources).toEqual([
        expect.objectContaining({ chromeTargetId: "old-target" }),
      ]);
    } finally {
      await rm(oldProfile, { recursive: true, force: true });
      await rm(currentProfile, { recursive: true, force: true });
    }
  }, 15_000);

  test("retries only resources that failed the previous cleanup pass", async () => {
    const oldProfile = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-retry-old-group-"));
    const currentProfile = await mkdtemp(
      path.join(os.tmpdir(), "oracle-browser-retry-current-group-"),
    );
    const events: string[] = [];
    let oldAttempts = 0;
    const cleanupDeps = {
      closeChromeTarget: vi.fn(async ({ targetId }: { targetId: string }) => {
        events.push(`close:${targetId}`);
        if (targetId !== "old-target") return true;
        oldAttempts += 1;
        return oldAttempts > 1;
      }),
      terminateRecordedChromeForProfile: vi.fn(async (profileDir: string) => {
        events.push(`terminate:${profileDir}`);
        return stopped;
      }),
      removeProfile: vi.fn(async (profileDir: string) => {
        events.push(`remove:${profileDir}`);
        return true;
      }),
    };
    const oldIdentity = await physicalChromeProcessIdentity(oldProfile, 3333);
    const currentIdentity = await physicalChromeProcessIdentity(currentProfile, 4444);
    const oldResource: BrowserRecoveryCleanupResourceMetadata = {
      chromeProcessIdentity: oldIdentity,
      profileDirectoryIdentity: oldIdentity.profileDirectory,
      chromePort: 9333,
      userDataDir: oldProfile,
      chromeTargetId: "old-target",
      recoveryCleanup: {
        ownsTarget: true,
        profileKind: "temporary",
        keepBrowser: false,
        closeOwnedTargetOnComplete: true,
      },
    };
    const currentResource: BrowserRecoveryCleanupResourceMetadata = {
      chromeProcessIdentity: currentIdentity,
      profileDirectoryIdentity: currentIdentity.profileDirectory,
      chromePort: 9444,
      userDataDir: currentProfile,
      chromeTargetId: "current-target",
      recoveryCleanup: {
        ownsTarget: true,
        profileKind: "temporary",
        keepBrowser: false,
        closeOwnedTargetOnComplete: true,
      },
    };
    try {
      const first = await finalizeRecoveredRuntime(
        {
          chromeProcessIdentity: currentIdentity,
          chromePort: 9444,
          userDataDir: currentProfile,
          chromeTargetId: "current-target",
          recoveryCleanupResources: [oldResource, currentResource],
        },
        vi.fn() as BrowserLogger,
        cleanupDeps,
      );

      expect(first.status).toBe("pending");
      expect(first.runtime.recoveryCleanupResources).toHaveLength(1);
      const second = await finalizeRecoveredRuntime(
        first.runtime,
        vi.fn() as BrowserLogger,
        cleanupDeps,
      );

      expect(second.status).toBe("completed");
      expect(events).toEqual([
        "close:old-target",
        "close:current-target",
        `terminate:${currentProfile}`,
        `remove:${currentProfile}`,
        "close:old-target",
        `terminate:${oldProfile}`,
        `remove:${oldProfile}`,
      ]);
    } finally {
      await rm(oldProfile, { recursive: true, force: true });
      await rm(currentProfile, { recursive: true, force: true });
    }
  });

  test("settles a direct remote-CDP owned target locally without remote transaction authority", async () => {
    const closeChromeTarget = vi.fn(async () => true);
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const result = await finalizeRecoveredRuntime(
      withCommittedPromptEpoch(
        withRecoveryCleanup(
          {
            chromeHost: "remote.example.test",
            chromePort: 9222,
            chromeBrowserWSEndpoint: "wss://remote.example.test/devtools/browser/direct",
            chromeTargetId: "direct-owned-target",
          },
          {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        ),
      ),
      vi.fn() as BrowserLogger,
      { closeChromeTarget, terminateRecordedChromeForProfile },
    );

    expect(result.status).toBe("completed");
    expect(closeChromeTarget).toHaveBeenCalledWith({
      host: "remote.example.test",
      port: 9222,
      browserWSEndpoint: "wss://remote.example.test/devtools/browser/direct",
      targetId: "direct-owned-target",
      logger: expect.any(Function),
    });
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });
  test.each([
    { mode: "finalize" as const, expectedCloses: 0 },
    { mode: "abort" as const, expectedCloses: 1 },
  ])(
    "$mode keeps reused-process disposition separate from owned-target disposition",
    async ({ mode, expectedCloses }) => {
      const closeChromeTarget = vi.fn(async () => true);
      const runtime = withRecoveryCleanup(
        {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeTargetId: "reused-owner-target",
        },
        {
          ownsTarget: true,
          profileKind: "none",
          keepBrowser: true,
          closeOwnedTargetOnComplete: false,
        },
      );

      await expect(
        finalizeRecoveredRuntime(runtime, vi.fn() as BrowserLogger, { closeChromeTarget }, mode),
      ).resolves.toMatchObject({ status: "completed" });
      expect(closeChromeTarget).toHaveBeenCalledTimes(expectedCloses);
    },
  );

  test("fails closed when an owned target lacks its persisted finalize disposition", async () => {
    const closeChromeTarget = vi.fn(async () => true);
    const runtime = withRecoveryCleanup(
      {
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeTargetId: "missing-finalize-disposition",
      },
      {
        ownsTarget: true,
        profileKind: "none",
        keepBrowser: true,
      },
    );

    await expect(
      finalizeRecoveredRuntime(runtime, vi.fn() as BrowserLogger, { closeChromeTarget }),
    ).resolves.toMatchObject({
      status: "pending",
      error: expect.stringContaining("finalize disposition is missing"),
    });
    expect(closeChromeTarget).not.toHaveBeenCalled();
  });

  test("settles remote cleanup once without direct host Chrome operations", async () => {
    const remoteRecovery = {
      protocolVersion: 3,
      host: "remote.example.test:9443",
      transactionToken: "a".repeat(64),
      state: "pending" as const,
    };
    const runtime = withCommittedPromptEpoch(
      withRecoveryCleanup(
        {
          chromeHost: "remote.example.test",
          chromePort: 9222,
          chromeTargetId: "remote-owned-target",
        },
        {
          ownsTarget: true,
          profileKind: "none",
          keepBrowser: false,
          closeOwnedTargetOnComplete: true,
        },
        remoteRecovery,
      ),
    );
    const currentResource = runtime.recoveryCleanupResources?.[0];
    if (!currentResource) throw new Error("test cleanup resource is missing");
    const closeChromeTarget = vi.fn(async () => true);
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const settleRemoteBrowserRecovery = vi.fn(async () => ({
      status: "completed" as const,
      runtime: {},
    }));
    const resolveRemoteRecoveryConfig = vi.fn(async () => ({
      host: remoteRecovery.host,
      token: "configured-auth-secret",
    }));
    const result = await finalizeRecoveredRuntime(
      {
        ...runtime,
        recoveryCleanupResources: [
          {
            ...currentResource,
            chromeHost: "stale-remote.example.test",
            chromePort: 9111,
            chromeTargetId: "borrowed-target",
            recoveryCleanup: {
              ownsTarget: false,
              profileKind: "none",
              keepBrowser: false,
            },
          },
          currentResource,
        ],
      },
      vi.fn() as BrowserLogger,
      {
        closeChromeTarget,
        terminateRecordedChromeForProfile,
        settleRemoteBrowserRecovery,
        resolveRemoteRecoveryConfig,
        isRemotePublicationAcknowledged: () => true,
      },
    );

    expect(result.status).toBe("completed");
    expect(settleRemoteBrowserRecovery).toHaveBeenCalledOnce();
    expect(settleRemoteBrowserRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        configuredHost: remoteRecovery.host,
        authToken: "configured-auth-secret",
        runtime: expect.objectContaining({
          recoveryCleanupResources: expect.arrayContaining([
            expect.objectContaining({ remoteRecovery }),
          ]),
        }),
        mode: "finalize",
      }),
    );
    expect(resolveRemoteRecoveryConfig).toHaveBeenCalledOnce();
    expect(closeChromeTarget).not.toHaveBeenCalled();
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });

  test("retries retained cleanup authority under the recovery lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-retry-test-"));
    const profileDir = await mkdtemp(path.join(root, "oracle-browser-retry-cleanup-"));
    try {
      const result = await retryBrowserRecoveryCleanup(
        withRecoveryCleanup(
          {
            userDataDir: profileDir,
            chromeProcessIdentity: await physicalChromeProcessIdentity(profileDir),
            recoveryCleanupResult: {
              status: "failed",
              error: "previous termination failure",
              settlementMode: "finalize",
            },
          },
          {
            ownsTarget: false,
            profileKind: "temporary",
            keepBrowser: false,
          },
        ),
        vi.fn() as BrowserLogger,
        {
          recoveryLockPath: path.join(root, "browser-recovery.lock"),
          recoveryCleanup: {
            terminateRecordedChromeForProfile: vi.fn(async () => stopped),
            removeProfile: vi.fn(async () => true),
          },
        },
      );

      expect(result).toEqual({
        status: "completed",
        runtime: {
          userDataDir: profileDir,
          chromeProcessIdentity: await physicalChromeProcessIdentity(profileDir),
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolves a journaled target acquisition marker after restart", async () => {
    const markerUrl = "about:blank#oracle-acquisition=marker-generation";
    const closeChromeTarget = vi.fn(async () => true);
    const listChromeTargets = vi.fn(async () => [
      {
        targetId: "marker-target",
        type: "page",
        url: markerUrl,
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/marker-target",
      },
    ]);
    const runtime: BrowserRuntimeMetadata = {
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      recoveryCleanupResources: [
        {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          acquisition: {
            generationId: "marker-generation",
            pendingResource: "chrome-target",
            targetMarkerUrl: markerUrl,
          },
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: true,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
      recoveryCleanupResult: {
        status: "failed",
        error: "controller exited after target creation",
        settlementMode: "abort",
      },
    };

    await expect(
      retryBrowserRecoveryCleanup(runtime, vi.fn() as BrowserLogger, {
        acquireRecoveryLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
        recoveryCleanup: { closeChromeTarget, listChromeTargets },
      }),
    ).resolves.toEqual({
      status: "completed",
      runtime: { chromeHost: "127.0.0.1", chromePort: 9222 },
    });
    expect(listChromeTargets).toHaveBeenCalledOnce();
    expect(closeChromeTarget).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "marker-target" }),
    );
  });

  test("preserves manual-login resources while another lease is active", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-active-lease-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir);
    try {
      const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
      const cleanupStaleProfileState = vi.fn(async () => true);
      const result = await finalizeRecoveredRuntime(
        withRecoveryCleanup(
          {
            userDataDir: profileDir,
            chromeProcessIdentity: processIdentity,
          },
          {
            ownsTarget: false,
            profileKind: "manual-login",
            keepBrowser: false,
          },
        ),
        vi.fn() as BrowserLogger,
        {
          teardownBrowserResourcesIfNoActiveLeases: vi.fn(async () => ({
            status: "preserved" as const,
            reason: "active-leases" as const,
          })),
          terminateRecordedChromeForProfile,
          cleanupStaleProfileState,
        },
      );

      expect(result.status).toBe("pending");
      expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
      expect(cleanupStaleProfileState).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("terminates and clears manual-login state inside atomic teardown", async () => {
    const events: string[] = [];
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-manual-teardown-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir);
    try {
      const cleanupStaleProfileState = vi.fn(async () => {
        events.push("cleanup-profile-state");
        return true;
      });
      const teardownBrowserResourcesIfNoActiveLeases = vi.fn(
        async (_dir: string, teardown: () => Promise<boolean>) =>
          (await teardown())
            ? { status: "completed" as const }
            : { status: "preserved" as const, reason: "teardown-unsafe" as const },
      );
      const result = await finalizeRecoveredRuntime(
        withRecoveryCleanup(
          { userDataDir: profileDir, chromeProcessIdentity: processIdentity },
          {
            ownsTarget: false,
            profileKind: "manual-login",
            keepBrowser: false,
          },
        ),
        vi.fn() as BrowserLogger,
        {
          teardownBrowserResourcesIfNoActiveLeases,
          terminateRecordedChromeForProfile: vi.fn(async () => {
            events.push("terminate");
            return stopped;
          }),
          cleanupStaleProfileState,
        },
      );

      expect(result.status).toBe("completed");
      expect(events).toEqual(["terminate", "cleanup-profile-state"]);
      expect(cleanupStaleProfileState).toHaveBeenCalledWith(profileDir, expect.any(Function), {
        lockRemovalMode: "never",
        expectedProfileIdentity: processIdentity.profileDirectory,
      });
      expect(teardownBrowserResourcesIfNoActiveLeases).toHaveBeenCalledWith(
        profileDir,
        expect.any(Function),
        {
          logger: expect.any(Function),
          expectedProfileIdentity: processIdentity.profileDirectory,
        },
      );
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("keeps remote settlement retryable and idempotent without CDP fallback", async () => {
    const remoteRecovery = {
      protocolVersion: 3,
      host: "remote.example.test:9443",
      transactionToken: "b".repeat(64),
      state: "pending" as const,
    };
    const closeChromeTarget = vi.fn(async () => true);
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    let attempts = 0;
    const settlementModes: Array<"finalize" | "abort"> = [];
    const settleRemoteBrowserRecovery = vi.fn(
      async ({ runtime, mode }: RemoteRecoverySettlementOptions) => {
        settlementModes.push(mode ?? "finalize");
        attempts += 1;
        if (attempts === 1) {
          return {
            status: "pending" as const,
            runtime: {
              ...runtime,
              recoveryCleanupResult: {
                status: "failed" as const,
                error: "remote finalize still pending",
              },
            },
            error: "remote finalize still pending",
          };
        }
        return { status: "completed" as const, runtime: {} };
      },
    );
    const resolveRemoteRecoveryConfig = vi.fn(async () => ({
      host: remoteRecovery.host,
      token: "configured-auth-secret",
    }));
    const deps = {
      closeChromeTarget,
      terminateRecordedChromeForProfile,
      settleRemoteBrowserRecovery,
      resolveRemoteRecoveryConfig,
      isRemotePublicationAcknowledged: () => true,
    };
    const first = await finalizeRecoveredRuntime(
      withCommittedPromptEpoch(
        withRecoveryCleanup(
          {
            chromeHost: "remote.example.test",
            chromePort: 9222,
            chromeBrowserWSEndpoint: "wss://remote.example.test/devtools/browser/abc",
            chromeTargetId: "remote-owned-target",
          },
          {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
          remoteRecovery,
        ),
      ),
      vi.fn() as BrowserLogger,
      deps,
    );

    expect(first).toMatchObject({
      status: "pending",
      runtime: {
        recoveryCleanupResources: [
          expect.objectContaining({
            chromeHost: "remote.example.test",
            chromePort: 9222,
            chromeBrowserWSEndpoint: "wss://remote.example.test/devtools/browser/abc",
            chromeTargetId: "remote-owned-target",
            remoteRecovery,
            conversationId: "test-conversation",
            promptEpoch: expect.objectContaining({
              status: "committed",
              verifiedUserTurnId: "turn-1",
              verifiedUserMessageId: "message-1",
            }),
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "none",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          }),
        ],
      },
    });
    expect(JSON.stringify(first.runtime)).not.toContain("configured-auth-secret");
    const second = await retryBrowserRecoveryCleanup(
      first.runtime,
      vi.fn() as BrowserLogger,
      {
        recoveryCleanup: deps,
        acquireRecoveryLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
        isRemotePublicationAcknowledged: () => true,
      },
      "finalize",
    );
    expect(second.status).toBe("completed");
    expect(settleRemoteBrowserRecovery).toHaveBeenCalledTimes(2);
    expect(resolveRemoteRecoveryConfig).toHaveBeenCalledTimes(2);
    expect(settlementModes).toEqual(["finalize", "finalize"]);
    expect(closeChromeTarget).not.toHaveBeenCalled();
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });

  test("requires durable remote publication before finalize but permits abort", async () => {
    const remoteRecovery = {
      protocolVersion: 3,
      host: "remote.example.test:9443",
      transactionToken: "c".repeat(64),
      state: "pending" as const,
    };
    const runtime = withCommittedPromptEpoch(
      withRecoveryCleanup(
        {
          chromeHost: "remote.example.test",
          chromePort: 9222,
          chromeTargetId: "remote-owned-target",
        },
        {
          ownsTarget: true,
          profileKind: "none",
          keepBrowser: false,
          closeOwnedTargetOnComplete: true,
        },
        remoteRecovery,
      ),
    );
    const settleRemoteBrowserRecovery = vi.fn(async () => ({
      status: "completed" as const,
      runtime: {},
    }));
    const deps = {
      settleRemoteBrowserRecovery,
      resolveRemoteRecoveryConfig: vi.fn(async () => ({ host: remoteRecovery.host })),
      isRemotePublicationAcknowledged: () => false,
    };

    const blocked = await finalizeRecoveredRuntime(runtime, vi.fn() as BrowserLogger, deps);
    expect(blocked).toMatchObject({
      status: "pending",
      error: expect.stringContaining("durable answer publication acknowledgment"),
    });
    expect(settleRemoteBrowserRecovery).not.toHaveBeenCalled();

    const aborted = await finalizeRecoveredRuntime(
      blocked.runtime,
      vi.fn() as BrowserLogger,
      deps,
      "abort",
    );
    expect(aborted.status).toBe("completed");
    expect(settleRemoteBrowserRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "abort" }),
    );
  });

  test("rejects a conflicting explicit remote settlement mode before taking the lock", async () => {
    const remoteRecovery = {
      protocolVersion: 3,
      host: "remote.example.test:9443",
      transactionToken: "e".repeat(64),
      state: "pending" as const,
    };
    const runtime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          remoteRecovery,
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "none",
            keepBrowser: false,
          },
        },
      ],
      recoveryCleanupResult: {
        status: "failed",
        error: "retry finalize",
        settlementMode: "finalize",
      },
    };
    const acquireRecoveryLock = vi.fn();

    await expect(
      retryBrowserRecoveryCleanup(
        runtime,
        vi.fn() as BrowserLogger,
        { acquireRecoveryLock },
        "abort",
      ),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: { code: "settlement-mode-conflict", runtime },
    });
    expect(acquireRecoveryLock).not.toHaveBeenCalled();
  });

  test.each(["finalize", "abort"] as const)(
    "retries local cleanup using its persisted %s settlement mode",
    async (settlementMode) => {
      const runtime: BrowserRuntimeMetadata = {
        recoveryCleanupResult: {
          status: "failed",
          error: "interrupted settlement",
          settlementMode,
        },
        recoveryCleanupResources: [
          {
            chromeHost: "127.0.0.1",
            chromePort: 9222,
            chromeTargetId: "owned-local-target",
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "none",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      };
      const closeChromeTarget = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      const result = await retryBrowserRecoveryCleanup(runtime, vi.fn() as BrowserLogger, {
        acquireRecoveryLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
        recoveryCleanup: { closeChromeTarget },
      });

      expect(result).toMatchObject({
        status: "pending",
        runtime: {
          recoveryCleanupResult: {
            status: "failed",
            settlementMode,
          },
        },
      });
      expect(closeChromeTarget).toHaveBeenCalledOnce();
      await expect(
        retryBrowserRecoveryCleanup(
          result.runtime,
          vi.fn() as BrowserLogger,
          { acquireRecoveryLock: vi.fn() },
          settlementMode === "finalize" ? "abort" : "finalize",
        ),
      ).rejects.toMatchObject({
        details: { code: "settlement-mode-conflict" },
      });
      await expect(
        retryBrowserRecoveryCleanup(result.runtime, vi.fn() as BrowserLogger, {
          acquireRecoveryLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
          recoveryCleanup: { closeChromeTarget },
        }),
      ).resolves.toMatchObject({ status: "completed" });
      expect(closeChromeTarget).toHaveBeenCalledTimes(2);
    },
  );

  test("rejects cleanup authority without a persisted or explicit settlement mode", async () => {
    const runtime: BrowserRuntimeMetadata = {
      recoveryCleanupResult: { status: "failed", error: "controller crashed before binding" },
      recoveryCleanupResources: [
        {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeTargetId: "unbound-owned-target",
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: true,
            closeOwnedTargetOnComplete: false,
          },
        },
      ],
    };
    const acquireRecoveryLock = vi.fn();

    await expect(
      retryBrowserRecoveryCleanup(runtime, vi.fn() as BrowserLogger, { acquireRecoveryLock }),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: { code: "settlement-mode-missing", runtime },
    });
    expect(acquireRecoveryLock).not.toHaveBeenCalled();
  });

  test("rejects serialized temporary profiles outside approved runtime roots", async () => {
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const result = await finalizeRecoveredRuntime(
      withRecoveryCleanup(
        {
          userDataDir: path.join(
            path.parse(os.tmpdir()).root,
            "oracle-outside-runtime",
            "oracle-browser-malicious",
          ),
        },
        {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
        },
      ),
      vi.fn() as BrowserLogger,
      { terminateRecordedChromeForProfile },
    );

    expect(result).toMatchObject({ status: "pending", error: expect.stringMatching(/outside/) });
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });

  test("rejects noncanonical temporary profile paths before termination", async () => {
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const profileDir = `${path.join(os.tmpdir(), "oracle-browser-parent")}${path.sep}..${path.sep}oracle-browser-traversal`;
    const result = await finalizeRecoveredRuntime(
      withRecoveryCleanup(
        { userDataDir: profileDir },
        {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
        },
      ),
      vi.fn() as BrowserLogger,
      { terminateRecordedChromeForProfile },
    );

    expect(result).toMatchObject({ status: "pending", error: expect.stringMatching(/canonical/) });
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });

  test("serializes concurrent recovery for one session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-lock-test-"));
    const recoveryLockPath = path.join(root, "browser-recovery.lock");
    const logger = vi.fn() as BrowserLogger;
    const recoverSession = vi.fn(async () => ({ answerText: "ok", answerMarkdown: "ok" }));
    const runtime = withCommittedPromptEpoch();
    try {
      const first = await resumeBrowserSession(runtime, {}, logger, {
        recoverSession,
        recoveryLockPath,
      });
      await expect(
        resumeBrowserSession(runtime, {}, logger, { recoverSession, recoveryLockPath }),
      ).rejects.toThrow(/already in progress/i);
      await first.abort();
      const next = await resumeBrowserSession(runtime, {}, logger, {
        recoverSession,
        recoveryLockPath,
      });
      await next.abort();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("releases the recovery lock after pending cleanup and reacquires it for retry", async () => {
    const runtime = withCommittedPromptEpoch();
    const lockReleases = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
    let nextLock = 0;
    const acquireRecoveryLock = vi.fn(async () => {
      const release = lockReleases[nextLock];
      nextLock += 1;
      if (!release) throw new Error("unexpected recovery lock acquisition");
      return { release };
    });
    let cleanupAttempt = 0;
    const finalizeResources = vi.fn(async () => {
      cleanupAttempt += 1;
      return cleanupAttempt === 1
        ? { status: "pending" as const, runtime, error: "cleanup remains pending" }
        : { status: "completed" as const, runtime };
    });
    const result = await resumeBrowserSession(runtime, {}, vi.fn() as BrowserLogger, {
      acquireRecoveryLock,
      recoverSession: vi.fn(async () => ({
        answerText: "captured",
        answerMarkdown: "captured",
        finalizeResources,
      })),
    });

    await expect(result.finalize()).resolves.toMatchObject({ status: "pending" });
    expect(acquireRecoveryLock).toHaveBeenCalledOnce();
    expect(lockReleases[0]).toHaveBeenCalledOnce();

    await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
    expect(acquireRecoveryLock).toHaveBeenCalledTimes(2);
    expect(lockReleases[1]).toHaveBeenCalledOnce();
    expect(finalizeResources).toHaveBeenCalledTimes(2);
  });

  test("does not finalize resources after failed fallback recovery", async () => {
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const removeProfile = vi.fn(async () => true);
    const runtime = withCommittedPromptEpoch(
      withRecoveryCleanup(
        { chromePort: 9222, userDataDir: path.join(os.tmpdir(), "oracle-browser-failed-recovery") },
        {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
        },
      ),
    );

    await expect(
      resumeBrowserSession(runtime, {}, vi.fn() as BrowserLogger, {
        listTargets: vi.fn(async () => {
          throw new Error("live capture failed");
        }),
        recoverSession: vi.fn(async () => {
          throw new Error("fallback capture failed");
        }),
        recoveryCleanup: { terminateRecordedChromeForProfile, removeProfile },
      }),
    ).rejects.toThrow("fallback capture failed");
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    expect(removeProfile).not.toHaveBeenCalled();
  });
});

describe("reattach helpers", () => {
  const {
    pickTarget,
    extractConversationIdFromUrl,
    buildConversationUrl,
    openConversationFromSidebar,
    createOwnedRecoveryTargetConnection,
  } = __test__;
  type EvaluateParams = { expression: string };
  type EvaluateResult<T> = { result: { value: T } };

  test("extracts conversation id from a chat URL", () => {
    expect(extractConversationIdFromUrl("https://chatgpt.com/c/abc-123")).toBe("abc-123");
    expect(
      extractConversationIdFromUrl(
        "https://chatgpt.com/c/WEB:32229414-5afa-4478-890c-9ca80aa82430",
      ),
    ).toBeUndefined();
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

  test("creates and binds a dedicated owned recovery target", async () => {
    const logger = vi.fn() as BrowserLogger;
    const createRecoveryTarget = vi.fn(async () => "created-target");
    const closeConnection = vi.fn(async () => undefined);
    const connectRecoveryTarget = vi.fn(async () => ({
      client: { close: vi.fn(async () => undefined) } as unknown as ChromeClient,
      targetId: "created-target",
      ownership: "attached" as const,
      close: closeConnection,
    }));

    const connection = await createOwnedRecoveryTargetConnection(
      { host: "127.0.0.1", port: 63333 },
      logger,
      { createRecoveryTarget, connectRecoveryTarget },
    );

    expect(createRecoveryTarget).toHaveBeenCalledWith(63333, logger, "127.0.0.1", undefined);
    expect(connectRecoveryTarget).toHaveBeenCalledWith("127.0.0.1", 63333, logger, {
      targetId: "created-target",
      closeTargetOnDispose: false,
    });
    expect(connection).toMatchObject({ targetId: "created-target", ownership: "created" });
    await connection.close();
    expect(closeConnection).toHaveBeenCalledOnce();
  });

  test("rejects a recovery connection that is not bound to the created target", async () => {
    const logger = vi.fn() as BrowserLogger;
    const closeConnection = vi.fn(async () => undefined);
    const closeChromeTarget = vi.fn(async () => true);

    await expect(
      createOwnedRecoveryTargetConnection({ host: "127.0.0.1", port: 63333 }, logger, {
        createRecoveryTarget: vi.fn(async () => "created-target"),
        connectRecoveryTarget: vi.fn(async () => ({
          client: { close: vi.fn(async () => undefined) } as unknown as ChromeClient,
          targetId: "different-target",
          ownership: "attached" as const,
          close: closeConnection,
        })),
        recoveryCleanup: { closeChromeTarget },
      }),
    ).rejects.toThrow(/different-target.*created-target/i);
    expect(closeConnection).toHaveBeenCalledOnce();
    expect(closeChromeTarget).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 63333,
      targetId: "created-target",
      logger,
    });
  });

  test("pickTarget requires the stored target and committed conversation to match", () => {
    const targets = [
      { targetId: "t-1", type: "page", url: "https://chatgpt.com/c/first" },
      { targetId: "t-2", type: "page", url: "https://chatgpt.com/c/second" },
      { targetId: "t-3", type: "page", url: "about:blank" },
    ];
    expect(
      pickTarget(targets, {
        chromeTargetId: "t-1",
        tabUrl: "https://chatgpt.com/c/first",
        conversationId: "first",
      }),
    ).toEqual(targets[0]);
    expect(
      pickTarget(targets, {
        chromeTargetId: "t-2",
        tabUrl: "https://chatgpt.com/c/first",
        conversationId: "first",
      }),
    ).toBeUndefined();
    expect(pickTarget(targets, { tabUrl: "https://chatgpt.com/c/first" })).toBeUndefined();
    expect(pickTarget(targets, {})).toBeUndefined();
    expect(
      pickTarget([{ targetId: "external", type: "page", url: "https://example.com/c/first" }], {
        chromeTargetId: "external",
        conversationId: "first",
      }),
    ).toBeUndefined();
  });

  test("pickTarget permits only an explicitly referenced borrowed target", () => {
    const targets = [
      { targetId: "t-1", type: "page", url: "https://chatgpt.com/c/first" },
      { targetId: "t-2", type: "page", url: "https://chatgpt.com/c/second" },
    ];
    expect(pickTarget(targets, { conversationId: "second" }, "t-2")).toEqual(targets[1]);
    expect(pickTarget(targets, { conversationId: "second" }, "second")).toEqual(targets[1]);
    expect(pickTarget(targets, { conversationId: "second" }, "missing")).toBeUndefined();
    expect(pickTarget(targets, { conversationId: "second" }, "current")).toBeUndefined();
    const ambiguous = [
      { targetId: "same-1", type: "page", url: "https://chatgpt.com/c/same" },
      { targetId: "same-2", type: "page", url: "https://chatgpt.com/c/same" },
    ];
    expect(pickTarget(ambiguous, { conversationId: "same" }, "same")).toBeUndefined();
    expect(
      pickTarget(ambiguous, { conversationId: "same" }, "https://chatgpt.com/c/same"),
    ).toBeUndefined();
  });

  test("pickTarget keeps the saved target among duplicate conversation tabs", () => {
    const targets = [
      { targetId: "duplicate", type: "page", url: "https://chatgpt.com/c/same" },
      { targetId: "submitted", type: "page", url: "https://chatgpt.com/c/same" },
    ];

    expect(
      pickTarget(targets, {
        chromeTargetId: "submitted",
        conversationId: "same",
      }),
    ).toEqual(targets[1]);
  });

  test("pickTarget understands CDP list ids when conversation identity agrees", () => {
    const targets = [
      { id: "page-1", type: "page", url: "https://chatgpt.com/c/first" },
      { id: "page-2", type: "page", url: "about:blank" },
    ];

    expect(
      pickTarget(targets, {
        chromeTargetId: "page-1",
        conversationId: "first",
      }),
    ).toEqual(targets[0]);
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
});
