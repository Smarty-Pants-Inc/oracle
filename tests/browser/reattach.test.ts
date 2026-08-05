import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  resumeBrowserSession,
  retryBrowserRecoveryCleanup,
  __test__,
  type ReattachCleanupDeps,
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
  type OracleChromeOwnerRecord,
  type RecordedChromeTerminationOutcome,
} from "../../src/browser/profileState.js";
import type { RemoteRecoverySettlementOptions } from "../../src/remote/types.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import { acquireBrowserTabLease } from "../../src/browser/tabLeaseRegistry.js";
import type { ExactChromeTargetCleanupResult } from "../../src/browser/chromeLifecycle.js";
import { retainChromeTargetCloseCapability } from "../../src/browser/targetCloseAuthority.js";
import { promptIdentitySha256 } from "../../src/browser/actions/promptComposer.js";

function createBrowserLogger(): BrowserLogger {
  return vi.fn<(message: string) => void>();
}

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

function withRetainedTargetCapability(
  resource: BrowserRecoveryCleanupResourceMetadata,
  generationId = `test-target-generation:${resource.chromeTargetId ?? "missing"}`,
): BrowserRecoveryCleanupResourceMetadata {
  const targetId = resource.chromeTargetId;
  if (!targetId) throw new Error("Retained target capability fixture requires a target id");
  return {
    ...resource,
    targetCloseCapability: {
      version: 1,
      generationId,
      capabilityId: `test-target-capability:${generationId}:${targetId}`,
    },
    acquisition: { ...resource.acquisition, generationId },
  };
}

function withRecoveryCleanup(
  runtime: BrowserRuntimeMetadata,
  recoveryCleanup: BrowserRecoveryCleanupMetadata,
  remoteRecovery?: BrowserRecoveryCleanupResourceMetadata["remoteRecovery"],
  resourceOverrides: Omit<Partial<BrowserRecoveryCleanupResourceMetadata>, "recoveryCleanup"> = {},
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
    ...resourceOverrides,
    recoveryCleanup,
  };
  const exactResource =
    recoveryCleanup.ownsTarget &&
    !remoteRecovery &&
    runtime.chromeTargetId &&
    runtime.chromeProcessIdentity &&
    !resourceOverrides.acquisition &&
    !Object.prototype.hasOwnProperty.call(resourceOverrides, "targetCloseCapability")
      ? withRetainedTargetCapability(resource)
      : resource;
  return { ...runtime, recoveryCleanupResources: [exactResource] };
}

function authenticatedLocalTargetCleanupDeps(
  behavior: {
    closeTarget?: (targetId: string) => ExactChromeTargetCleanupResult;
    kill?: (userDataDir: string, pid: number) => RecordedChromeTerminationOutcome;
    mockRetainedTargetClose?: boolean;
    onRelease?: () => void;
  } = {},
): Pick<
  ReattachCleanupDeps,
  | "verifyProfileDirectoryIdentity"
  | "inspectChromeProcessIdentity"
  | "retainChromeEndpointAuthority"
  | "closeChromeTargetWithExactAuthority"
  | "closeChromeTargetWithRetainedCapability"
  | "listChromeTargetsWithExactAuthority"
> {
  return {
    verifyProfileDirectoryIdentity: vi.fn(async () => true),
    inspectChromeProcessIdentity: vi.fn(async () => "current" as const),
    retainChromeEndpointAuthority: vi.fn(
      async (
        options: Parameters<NonNullable<ReattachCleanupDeps["retainChromeEndpointAuthority"]>>[0],
      ) => ({
        browserWSEndpoint:
          options.browserWSEndpoint ??
          `ws://${options.host}:${options.port}/devtools/browser/authenticated-cleanup`,
        kill: vi.fn(async (): Promise<RecordedChromeTerminationOutcome> => {
          return (
            behavior.kill?.(options.userDataDir, options.processIdentity.pid) ?? {
              status: "stopped",
              pid: options.processIdentity.pid,
              signal: "SIGTERM",
            }
          );
        }),
        release: vi.fn(async () => {
          behavior.onRelease?.();
        }),
      }),
    ),
    closeChromeTargetWithExactAuthority: vi.fn(
      async ({ targetId }) => behavior.closeTarget?.(targetId) ?? { status: "completed" as const },
    ),
    ...(behavior.mockRetainedTargetClose === false
      ? {}
      : {
          closeChromeTargetWithRetainedCapability: vi.fn(
            async ({ targetId }) =>
              behavior.closeTarget?.(targetId) ?? { status: "completed" as const },
          ),
        }),
    listChromeTargetsWithExactAuthority: vi.fn(async () => ({
      status: "completed" as const,
      value: [],
    })),
  };
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

function createAttachedReattachClient(tabUrl: string) {
  const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
    result: { value: expression === "location.href" ? tabUrl : 2 },
  }));
  const client = {
    Runtime: { enable: vi.fn(), evaluate },
    DOM: { enable: vi.fn() },
    close: vi.fn(async () => undefined),
  } satisfies FakeClient;
  const connect = vi.fn(async () => client) as unknown as (
    options?: unknown,
  ) => Promise<ChromeClient>;
  return { client, connect, evaluate };
}

function withOwnedTargetResource(
  runtime: BrowserRuntimeMetadata,
  targetId: string,
  capability?: { version: 1; generationId: string; capabilityId: string },
): BrowserRuntimeMetadata {
  const resource: BrowserRecoveryCleanupResourceMetadata = {
    chromeHost: runtime.chromeHost,
    chromePort: runtime.chromePort,
    chromeTargetId: targetId,
    ...(capability ? { targetCloseCapability: capability } : {}),
    conversationId: runtime.conversationId,
    promptEpoch: runtime.promptEpoch,
    acquisition: {
      generationId: "owned-generation",
      targetMarkerUrl: "about:blank#oracle-acquisition=owned-generation",
    },
    recoveryCleanup: {
      ownsTarget: true,
      profileKind: "none",
      keepBrowser: true,
      closeOwnedTargetOnComplete: true,
    },
  };
  return {
    ...runtime,
    recoveryCleanupResources: [resource],
    recoveryCleanupResult: { status: "pending" },
  };
}

async function resumeExplicitTargetFixture(options: {
  runtime: BrowserRuntimeMetadata;
  browserTabRef: string;
  targets: FakeTarget[];
  recoveryCleanup?: ReattachCleanupDeps;
}) {
  const { connect } = createAttachedReattachClient(options.runtime.tabUrl ?? "");
  const release = vi.fn(async () => undefined);
  const result = await resumeBrowserSession(
    options.runtime,
    { browserTabRef: options.browserTabRef, timeoutMs: 2_000 },
    createBrowserLogger(),
    {
      acquireRecoveryLock: vi.fn(async () => ({ release })),
      listTargets: vi.fn(async () => options.targets) as unknown as () => Promise<FakeTarget[]>,
      connect,
      waitForConversationHydration: vi.fn(async () => 2),
      verifyCommittedPromptTurn: vi.fn(async () => undefined),
      waitForAssistantResponse: vi.fn(async () => ({
        text: "reattached capture",
        html: "",
        meta: { messageId: "m1", turnId: "conversation-turn-3" },
      })),
      captureAssistantMarkdown: vi.fn(async () => "reattached capture"),
      recoveryCleanup: options.recoveryCleanup,
    },
  );
  return { result, connect, release };
}
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

async function resumeFallbackWithManualOwner(
  profileDir: string,
  source: ManualOwnerSource,
  behavior: {
    isLastLease?: boolean;
    endpointReleaseFailures?: number;
    captureError?: Error;
    runtimeHints?: BrowserRuntimeMetadata[];
  } = {},
) {
  const processIdentity = await physicalChromeProcessIdentity(profileDir);
  const cleanupOrder: string[] = [];
  const acquisitionOrder: string[] = [];
  const runtimeHints = behavior.runtimeHints ?? [];
  const closeChromeTargetWithExactAuthority = vi.fn(async () => {
    cleanupOrder.push("target");
    return { status: "completed" as const };
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
      releaseOptions?: { onRelease?: (context: { isLastLease: boolean }) => Promise<void> },
    ) => {
      cleanupOrder.push("lease");
      await releaseOptions?.onRelease?.({ isLastLease: behavior.isLastLease ?? true });
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
    return { status: "stopped" as const, pid: processIdentity.pid, signal: "SIGTERM" as const };
  });
  let remainingEndpointReleaseFailures = behavior.endpointReleaseFailures ?? 0;
  const releaseEndpointAuthority = vi.fn(async () => {
    cleanupOrder.push("endpoint");
    if (remainingEndpointReleaseFailures > 0) {
      remainingEndpointReleaseFailures -= 1;
      throw new Error("transient endpoint release failure");
    }
  });
  const endpointAuthority = {
    browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/fallback-owner",
    kill,
    runExactOperation: vi.fn(),
    release: releaseEndpointAuthority,
  };
  const owner = {
    chrome: {
      pid: processIdentity.pid,
      port: 9222,
      host: "127.0.0.1",
      remoteDebuggingPipes: undefined,
      processIdentity,
      endpointAuthority,
      kill,
    },
    processIdentity,
    source,
    disposition: source === "launched" ? "close-on-last-lease" : "preserve",
    endpointAuthority,
  };
  const acquireManualChromeOwner = vi.fn(async () => {
    acquisitionOrder.push("acquire:chrome-process");
    return owner;
  });
  const connectRecoveryTargetWithExactAuthority = vi.fn(
    async ({
      authority,
      targetUrl,
    }: {
      authority: typeof endpointAuthority;
      targetUrl?: string;
    }) => {
      acquisitionOrder.push("acquire:chrome-target");
      if (!targetUrl) return { status: "unsafe" as const, reason: "missing target marker" };
      return {
        status: "completed" as const,
        value: {
          client,
          targetId: "fallback-owned-target",
          ownership: "created" as const,
          browserWSEndpoint: authority.browserWSEndpoint,
          close: vi.fn(async () => undefined),
        },
      };
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
    createBrowserLogger(),
    {
      acquireRecoveryLock: vi.fn(async () => ({ release: releaseRecoveryLock })),
      acquireBrowserTabLease: acquireBrowserTabLease as never,
      acquireManualChromeOwner: acquireManualChromeOwner as never,
      connectRecoveryTargetWithExactAuthority: connectRecoveryTargetWithExactAuthority as never,
      waitForConversationHydration: vi.fn(async () => 1),
      verifyCommittedPromptTurn: vi.fn(async () => undefined),
      waitForAssistantResponse: vi.fn(async () => {
        if (behavior.captureError) throw behavior.captureError;
        return {
          text: "fallback answer",
          html: "",
          meta: { messageId: "assistant-2", turnId: "turn-2" },
        };
      }),
      captureAssistantMarkdown: vi.fn(async () => "fallback markdown"),
      recoveryCleanup: {
        verifyProfileDirectoryIdentity: vi.fn(async () => true),
        inspectChromeProcessIdentity: vi.fn(async () => "current" as const),
        retainChromeEndpointAuthority: vi.fn(async () => ({
          browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/fallback-cleanup",
          kill,
          release: vi.fn(async () => undefined),
        })),
        closeChromeTargetWithExactAuthority,
        terminateRecordedChromeForProfile,
        cleanupStaleProfileState,
        releaseBrowserTabLease,
      },
      runtimeHintCb,
    },
  );
  return {
    result,
    closeChromeTargetWithExactAuthority,
    terminateRecordedChromeForProfile,
    cleanupStaleProfileState,
    kill,
    releaseEndpointAuthority,
    releaseBrowserTabLease,
    cleanupOrder,
    acquisitionOrder,
    runtimeHints,
    releaseRecoveryLock,
    acquireBrowserTabLease,
    acquireManualChromeOwner,
    connectRecoveryTargetWithExactAuthority,
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
    expect(removeProfile).toHaveBeenCalledWith(profileDir);
    await rm(profileDir, { recursive: true, force: true });
  }, 15_000);

  test("harvests the exact committed Gemini target without resubmitting", async () => {
    const promptSha256 = promptIdentitySha256("New request");
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "gemini-target-1",
      conversationId: "gemini-target-1",
      promptEpoch: {
        status: "committed" as const,
        epochId: "gemini-epoch-1",
        promptSha256,
        baselineTurns: 0,
        followUpOrdinal: 0,
        remainingFollowUps: 0,
        verifiedUserTurnIndex: 0,
        verifiedUserTurnId: `gemini-dom-turn:0:${promptSha256}`,
        verifiedUserMessageId: `gemini-dom-turn:0:${promptSha256}`,
        conversationId: "gemini-target-1",
      },
    } satisfies BrowserRuntimeMetadata;
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
                  stableId: null,
                },
                {
                  kind: "response",
                  postBaseline: true,
                  text: "exact recovered Gemini answer",
                  stableId: null,
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

  test("never reopens or resubmits when the exact committed Gemini target is missing", async () => {
    const baseRuntime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "gemini-target-missing",
      conversationId: "gemini-target-missing",
    });
    const runtime: BrowserRuntimeMetadata = {
      ...baseRuntime,
      promptEpoch: {
        ...baseRuntime.promptEpoch!,
        promptSha256: promptIdentitySha256("New request"),
      },
    };
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

  test("preserves exact abort cleanup authority without entering answer reattach", async () => {
    const runtime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "cleanup-only-target",
      tabUrl: "https://chatgpt.com/c/cleanup-only",
      recoveryCleanupResources: [
        withRetainedTargetCapability({
          chromePort: 51559,
          chromeHost: "127.0.0.1",
          chromeTargetId: "cleanup-only-target",
          conversationId: "cleanup-only",
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        }),
      ],
    });
    if (runtime.promptEpoch?.status !== "committed") throw new Error("missing committed epoch");
    runtime.promptEpoch.remainingFollowUps = 1;
    const listTargets = vi.fn();
    const waitForAssistantResponse = vi.fn();
    const recoverSession = vi.fn();

    await expect(
      resumeBrowserSession(runtime, {}, createBrowserLogger(), {
        listTargets,
        waitForAssistantResponse,
        recoverSession,
      }),
    ).rejects.toMatchObject({
      details: {
        code: "committed-prompt-identity-mismatch",
        reattachClassification: "cleanup-only-abort",
        remainingFollowUps: 1,
        runtime,
      },
    });
    expect(listTargets).not.toHaveBeenCalled();
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    expect(recoverSession).not.toHaveBeenCalled();
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
      resumeBrowserSession(runtime, { timeoutMs: 2000 }, createBrowserLogger(), {
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
    const logger = createBrowserLogger();
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
    const logger = createBrowserLogger();

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
        acquireManualChromeOwner,
        connectRecoveryTargetWithExactAuthority,
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
        acquisition: {
          generationId: expect.any(String),
          pendingResource: "tab-lease",
          processLaunchClaim: {
            version: 1,
            generationId: expect.any(String),
            nonce: expect.any(String),
          },
          processOwnerDisposition: "close-on-last-lease",
        },
      });
      expect(acquireBrowserTabLease).toHaveBeenCalledWith(
        profileDir,
        expect.objectContaining({ leaseId: leaseIntent?.tabLease?.id }),
      );
      expect(acquireManualChromeOwner).toHaveBeenCalledWith(
        profileDir,
        expect.any(Object),
        expect.any(Function),
        expect.any(String),
        { launchClaim: leaseIntent?.acquisition?.processLaunchClaim },
      );
      expect(targetIntent).toMatchObject({
        chromeProcessIdentity: expect.any(Object),
        acquisition: {
          generationId: leaseIntent?.acquisition?.generationId,
          pendingResource: "chrome-target",
          targetMarkerUrl: expect.stringContaining("oracle-acquisition="),
        },
      });
      expect(connectRecoveryTargetWithExactAuthority).toHaveBeenCalledWith({
        authority: expect.objectContaining({
          browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/fallback-owner",
        }),
        targetUrl: targetIntent?.acquisition?.targetMarkerUrl,
        closeTargetOnDispose: false,
      });
      expect(acquired).toMatchObject({
        chromeTargetId: "fallback-owned-target",
        targetCloseCapability: {
          version: 1,
          generationId: leaseIntent?.acquisition?.generationId,
          capabilityId: expect.any(String),
        },
        acquisition: { generationId: leaseIntent?.acquisition?.generationId },
      });
      expect(acquired?.acquisition?.pendingResource).toBeUndefined();

      await expect(result.abort()).resolves.toMatchObject({ status: "completed" });
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("persists completed fallback abort runtime before rethrowing the primary error", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-abort-runtime-"));
    const primaryError = new Error("assistant capture failed");
    const runtimeHints: BrowserRuntimeMetadata[] = [];
    try {
      await expect(
        resumeFallbackWithManualOwner(profileDir, "launched", {
          captureError: primaryError,
          runtimeHints,
        }),
      ).rejects.toBe(primaryError);

      expect(runtimeHints.some((hint) => (hint.recoveryCleanupResources?.length ?? 0) > 0)).toBe(
        true,
      );
      const persistedAbortRuntime = runtimeHints.at(-1);
      expect(persistedAbortRuntime).toMatchObject({
        conversationId: "test-conversation",
        promptEpoch: { status: "committed", conversationId: "test-conversation" },
      });
      expect(persistedAbortRuntime).not.toHaveProperty("recoveryCleanupResources");
      expect(persistedAbortRuntime).not.toHaveProperty("recoveryCleanupResult");
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("keeps fallback process acquisition pending when owner lookup and launch discovery are unavailable", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-crash-window-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir, 5_151);
    const interruption = new Error("controller interrupted after canonical owner creation");
    const runtimeHints: BrowserRuntimeMetadata[] = [];
    const retainedKill = vi.fn(async () => ({
      status: "unsafe" as const,
      pid: processIdentity.pid,
      reason: "simulated process interruption retained no live kill handle",
    }));
    const retainedRelease = vi.fn(async () => undefined);
    const retainedEndpointAuthority = {
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/crash-window",
      kill: retainedKill,
      release: retainedRelease,
    };
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
      endpointAuthority: retainedEndpointAuthority,
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
    let persistenceInterrupted = false;

    try {
      await expect(
        resumeBrowserSession(
          withCommittedPromptEpoch({ tabUrl: "https://chatgpt.com/c/crash-window" }),
          { manualLogin: true, manualLoginProfileDir: profileDir, timeoutMs: 1_000 },
          createBrowserLogger(),
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
                !persistenceInterrupted &&
                hint.recoveryCleanupResources?.at(-1)?.acquisition?.pendingResource ===
                  "chrome-target"
              ) {
                persistenceInterrupted = true;
                throw interruption;
              }
            },
            recoveryCleanup: {
              ...authenticatedLocalTargetCleanupDeps(),
              releaseBrowserTabLease,
            },
            acquireRecoveryLock: vi.fn(async () => ({ release: releaseRecoveryLock })),
          },
        ),
      ).rejects.toMatchObject({ details: { code: "fallback-cleanup-pending" } });

      expect(await readOracleChromeOwner(profileDir)).toMatchObject({
        processIdentity,
        disposition: "close-on-last-lease",
      });
      const ownerRuntime = runtimeHints.find(
        (hint) =>
          hint.recoveryCleanupResources?.at(-1)?.acquisition?.pendingResource === "chrome-target",
      );
      expect(ownerRuntime?.recoveryCleanupResources?.at(-1)?.chromeBrowserWSEndpoint).toBe(
        retainedEndpointAuthority.browserWSEndpoint,
      );
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
          processLaunchClaim: {
            version: 1,
            generationId: expect.any(String),
            nonce: expect.any(String),
          },
          processOwnerDisposition: "close-on-last-lease",
        },
      });
      expect(crashResource?.chromeProcessIdentity).toBeUndefined();

      const terminateRecordedChromeForProfile = vi.fn(async () => ({
        status: "stopped" as const,
        pid: processIdentity.pid,
        signal: "SIGTERM" as const,
      }));
      const releaseAcquisitionRecoveryLock = vi.fn(async () => undefined);
      const recovery = await retryBrowserRecoveryCleanup(
        crashRuntime,
        createBrowserLogger(),
        {
          acquireRecoveryLock: vi.fn(async () => ({
            release: releaseAcquisitionRecoveryLock,
          })),
          recoveryCleanup: {
            readOracleChromeOwner: vi.fn(async () => null),
            verifyProfileDirectoryIdentity: vi.fn(async () => true),
            inspectRunningChromeProcessesForLaunchClaim: vi.fn(async () => {
              throw new Error("process enumeration unavailable");
            }),
            terminateRecordedChromeForProfile,
          },
        },
        "abort",
      );

      expect(recovery.status).toBe("pending");
      expect(recovery.runtime.recoveryCleanupResources).toEqual([crashResource]);
      expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
      expect(retainedKill).toHaveBeenCalledOnce();
      expect(releaseRecoveryLock).toHaveBeenCalledOnce();
      expect(releaseAcquisitionRecoveryLock).toHaveBeenCalledOnce();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("keeps a pre-owner launch acquisition pending when its durable claim is missing", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-launch-claim-missing-"));
    try {
      const profileDirectoryIdentity = await captureProfileDirectoryIdentity(profileDir);
      const resource: BrowserRecoveryCleanupResourceMetadata = {
        profileDirectoryIdentity,
        chromeHost: "127.0.0.1",
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        acquisition: {
          generationId: "70000000-0000-4000-8000-000000000007",
          pendingResource: "chrome-process",
          processOwnerProvenance: "temporary-launch",
          processOwnerDisposition: "close-on-last-lease",
        },
        recoveryCleanup: {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
          closeOwnedTargetOnComplete: false,
        },
      };
      const inspectRunningChromeProcessesForLaunchClaim = vi.fn();

      const recovery = await __test__.finalizeRecoveredRuntime(
        {
          browserTransport: "cdp",
          chromeHost: "127.0.0.1",
          chromeProfileRoot: profileDir,
          userDataDir: profileDir,
          recoveryCleanupResources: [resource],
          recoveryCleanupResult: { status: "pending" },
        },
        createBrowserLogger(),
        { inspectRunningChromeProcessesForLaunchClaim },
      );

      expect(recovery).toMatchObject({
        status: "pending",
        runtime: { recoveryCleanupResources: [resource] },
        error: expect.stringMatching(/launch claim is missing or invalid/i),
      });
      expect(inspectRunningChromeProcessesForLaunchClaim).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("keeps recovered process acquisition pending until its endpoint authority releases", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-acquisition-release-retry-"));
    try {
      const launchClaim = {
        version: 1 as const,
        generationId: "80000000-0000-4000-8000-000000000008",
        nonce: "90000000-0000-4000-8000-000000000009",
      };
      const processIdentity = {
        ...(await physicalChromeProcessIdentity(profileDir, 8_008)),
        launchClaim,
      };
      const resource: BrowserRecoveryCleanupResourceMetadata = {
        chromeHost: "127.0.0.1",
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        profileDirectoryIdentity: processIdentity.profileDirectory,
        acquisition: {
          generationId: launchClaim.generationId,
          pendingResource: "chrome-process",
          processOwnerProvenance: "manual-canonical-owner",
          processLaunchClaim: launchClaim,
          processOwnerDisposition: "preserve",
        },
        recoveryCleanup: {
          ownsTarget: false,
          profileKind: "manual-login",
          keepBrowser: false,
          closeOwnedTargetOnComplete: false,
        },
      };
      const endpointRelease = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("transient endpoint release failure"))
        .mockResolvedValueOnce(undefined);
      const endpointAuthority = {
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/recovered-acquisition",
        kill: vi.fn(),
        release: endpointRelease,
      };
      const retainChromeEndpointAuthority = vi.fn(async () => endpointAuthority);
      const recoveryDeps: ReattachCleanupDeps = {
        verifyProfileDirectoryIdentity: vi.fn(async () => true),
        readOracleChromeOwner: vi.fn(async () => null),
        inspectRunningChromeProcessesForLaunchClaim: vi.fn(async () => ({
          exactMatches: [{ pid: processIdentity.pid, port: 9222 }],
          conflictingProfilePids: [],
        })),
        captureChromeProcessIdentity: vi.fn(async () => processIdentity),
        retainChromeEndpointAuthority,
        writeOracleChromeOwner: vi.fn(async () => undefined),
        verifyChromeProcessIdentity: vi.fn(async () => true),
      };
      const runtime: BrowserRuntimeMetadata = {
        browserTransport: "cdp",
        chromeHost: "127.0.0.1",
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        recoveryCleanupResources: [resource],
        recoveryCleanupResult: { status: "pending" },
      };
      const releaseAcquisitionRecoveryLock = vi.fn(async () => undefined);
      const acquireRecoveryLock = vi.fn(async () => ({
        release: releaseAcquisitionRecoveryLock,
      }));

      const pending = await retryBrowserRecoveryCleanup(
        runtime,
        createBrowserLogger(),
        { acquireRecoveryLock, recoveryCleanup: recoveryDeps },
        "abort",
      );

      expect(pending).toMatchObject({
        status: "pending",
        error: "Exact Chrome endpoint release failed: transient endpoint release failure",
        runtime: {
          recoveryCleanupResources: [
            {
              chromeProcessIdentity: processIdentity,
              chromePort: 9222,
              chromeBrowserWSEndpoint: endpointAuthority.browserWSEndpoint,
              acquisition: { pendingResource: "chrome-process" },
              recoveryCleanup: { keepBrowser: true, profileKind: "manual-login" },
            },
          ],
          recoveryCleanupResult: { settlementMode: "abort" },
        },
      });
      expect(retainChromeEndpointAuthority).toHaveBeenCalledOnce();

      const completed = await retryBrowserRecoveryCleanup(
        pending.runtime,
        createBrowserLogger(),
        { acquireRecoveryLock, recoveryCleanup: recoveryDeps },
        "abort",
      );

      expect(completed).toMatchObject({ status: "completed" });
      expect(completed.runtime.recoveryCleanupResources).toBeUndefined();
      expect(endpointRelease).toHaveBeenCalledTimes(2);
      expect(retainChromeEndpointAuthority).toHaveBeenCalledOnce();
      expect(releaseAcquisitionRecoveryLock).toHaveBeenCalledTimes(2);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("does not overwrite a replacement owner published before recovery promotion acquires the profile lock", async () => {
    const profileDir = await mkdtemp(
      path.join(os.tmpdir(), "oracle-browser-owner-promotion-race-"),
    );
    try {
      const launchClaim = {
        version: 1 as const,
        generationId: "a0000000-0000-4000-8000-00000000000a",
        nonce: "a1000000-0000-4000-8000-00000000000a",
      };
      const replacementClaim = {
        version: 1 as const,
        generationId: "b0000000-0000-4000-8000-00000000000b",
        nonce: "b1000000-0000-4000-8000-00000000000b",
      };
      const profileDirectory = await captureProfileDirectoryIdentity(profileDir);
      const replacementOwner = {
        port: 9_223,
        processIdentity: {
          ...(await physicalChromeProcessIdentity(profileDir, 9_223)),
          launchClaim: replacementClaim,
        },
        disposition: "preserve" as const,
      };
      let owner: OracleChromeOwnerRecord | null = null;
      const releasePromotionLock = vi.fn(async () => undefined);
      const acquireProfileRunLock = vi.fn(async () => {
        // The competing publisher completed while recovery was waiting to
        // serialize. Recovery must re-read this replacement under its lock.
        owner = replacementOwner;
        return {
          path: path.join(profileDir, "oracle-automation.lock"),
          lockId: "promotion-race-lock",
          profileDirectory,
          release: releasePromotionLock,
        };
      });
      const writeOracleChromeOwner = vi.fn(
        async (_userDataDir: string, nextOwner: OracleChromeOwnerRecord) => {
          owner = nextOwner;
        },
      );
      const resource: BrowserRecoveryCleanupResourceMetadata = {
        chromeHost: "127.0.0.1",
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        profileDirectoryIdentity: profileDirectory,
        acquisition: {
          generationId: launchClaim.generationId,
          pendingResource: "chrome-process",
          processOwnerProvenance: "temporary-launch",
          processLaunchClaim: launchClaim,
          processOwnerDisposition: "close-on-last-lease",
        },
        recoveryCleanup: {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
          closeOwnedTargetOnComplete: false,
        },
      };

      const recovery = await __test__.finalizeRecoveredRuntime(
        withCommittedPromptEpoch({
          browserTransport: "cdp",
          chromeHost: "127.0.0.1",
          chromeProfileRoot: profileDir,
          userDataDir: profileDir,
          recoveryCleanupResources: [resource],
          recoveryCleanupResult: { status: "pending" },
        }),
        createBrowserLogger(),
        {
          verifyProfileDirectoryIdentity: vi.fn(async () => true),
          acquireProfileRunLock,
          readOracleChromeOwner: vi.fn(async () => owner),
          writeOracleChromeOwner,
        },
      );

      expect(recovery).toMatchObject({
        status: "pending",
        error: expect.stringMatching(/does not match the persisted launch generation/i),
      });
      expect(owner).toBe(replacementOwner);
      expect(writeOracleChromeOwner).not.toHaveBeenCalled();
      expect(releasePromotionLock).toHaveBeenCalledOnce();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("converges when the exact claimed Chrome generation is already gone", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-claim-gone-"));
    try {
      const profileDirectoryIdentity = await captureProfileDirectoryIdentity(profileDir);
      const launchClaim = {
        version: 1 as const,
        generationId: "80000000-0000-4000-8000-000000000008",
        nonce: "90000000-0000-4000-8000-000000000009",
      };
      const resource: BrowserRecoveryCleanupResourceMetadata = {
        profileDirectoryIdentity,
        chromeHost: "127.0.0.1",
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        acquisition: {
          generationId: launchClaim.generationId,
          pendingResource: "chrome-process",
          processOwnerProvenance: "temporary-launch",
          processLaunchClaim: launchClaim,
          processOwnerDisposition: "close-on-last-lease",
        },
        recoveryCleanup: {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
          closeOwnedTargetOnComplete: false,
        },
      };
      const removeProfile = vi.fn(async () => true);

      const recovery = await __test__.finalizeRecoveredRuntime(
        {
          browserTransport: "cdp",
          chromeHost: "127.0.0.1",
          chromeProfileRoot: profileDir,
          userDataDir: profileDir,
          recoveryCleanupResources: [resource],
          recoveryCleanupResult: { status: "pending" },
        },
        createBrowserLogger(),
        {
          verifyProfileDirectoryIdentity: vi.fn(async () => true),
          readOracleChromeOwner: vi.fn(async () => null),
          inspectRunningChromeProcessesForLaunchClaim: vi.fn(async () => ({
            exactMatches: [],
            conflictingProfilePids: [],
          })),
          removeProfile,
        },
      );

      expect(recovery.status).toBe("completed");
      expect(recovery.runtime.recoveryCleanupResources).toBeUndefined();
      expect(removeProfile).toHaveBeenCalledWith(profileDir);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test.each([
    [
      "a conflicting profile process",
      { exactMatches: [], conflictingProfilePids: [7_001] },
      /unauthenticated process generation/i,
    ],
    [
      "multiple exact process generations",
      {
        exactMatches: [
          { pid: 7_002, port: 9222 },
          { pid: 7_003, port: 9222 },
        ],
        conflictingProfilePids: [],
      },
      /multiple process generations/i,
    ],
  ] as const)("fails closed when launch recovery finds %s", async (_label, discovery, error) => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-launch-claim-conflict-"));
    try {
      const profileDirectoryIdentity = await captureProfileDirectoryIdentity(profileDir);
      const launchClaim = {
        version: 1 as const,
        generationId: "80000000-0000-4000-8000-000000000008",
        nonce: "90000000-0000-4000-8000-000000000009",
      };
      const resource: BrowserRecoveryCleanupResourceMetadata = {
        profileDirectoryIdentity,
        chromeHost: "127.0.0.1",
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        acquisition: {
          generationId: launchClaim.generationId,
          pendingResource: "chrome-process",
          processOwnerProvenance: "temporary-launch",
          processLaunchClaim: launchClaim,
          processOwnerDisposition: "close-on-last-lease",
        },
        recoveryCleanup: {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
          closeOwnedTargetOnComplete: false,
        },
      };
      const captureChromeProcessIdentity = vi.fn();
      const writeOracleChromeOwner = vi.fn();

      const recovery = await __test__.finalizeRecoveredRuntime(
        {
          browserTransport: "cdp",
          chromeHost: "127.0.0.1",
          chromeProfileRoot: profileDir,
          userDataDir: profileDir,
          recoveryCleanupResources: [resource],
          recoveryCleanupResult: { status: "pending" },
        },
        createBrowserLogger(),
        {
          verifyProfileDirectoryIdentity: vi.fn(async () => true),
          readOracleChromeOwner: vi.fn(async () => null),
          inspectRunningChromeProcessesForLaunchClaim: vi.fn(async () => discovery),
          captureChromeProcessIdentity,
          writeOracleChromeOwner,
        },
      );

      expect(recovery).toMatchObject({
        status: "pending",
        runtime: { recoveryCleanupResources: [resource] },
        error: expect.stringMatching(error),
      });
      expect(captureChromeProcessIdentity).not.toHaveBeenCalled();
      expect(writeOracleChromeOwner).not.toHaveBeenCalled();
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
        const processIdentity = await physicalChromeProcessIdentity(launchedProfileDir, 4321);
        return {
          pid: 4321,
          port: 9222,
          host: "127.0.0.1",
          remoteDebuggingPipes: undefined,
          processIdentity,
          endpointAuthority: {
            browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/fallback-temporary",
            kill,
            runExactOperation: vi.fn(),
            release: vi.fn(async () => undefined),
          },
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
    const connectRecoveryTargetWithExactAuthority = vi.fn(async () => ({
      status: "completed" as const,
      value: {
        client,
        targetId: "fallback-owned-target",
        ownership: "created" as const,
        close: vi.fn(async () => undefined),
      },
    }));
    const exactCleanupDeps = authenticatedLocalTargetCleanupDeps({
      closeTarget: () => {
        cleanupOrder.push("target");
        return { status: "completed" };
      },
      mockRetainedTargetClose: false,
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
        createBrowserLogger(),
        {
          launchChrome: acquireTemporaryChromeOwner as never,
          acquireRecoveryLock: vi.fn(async () => ({
            release: vi.fn(async () => undefined),
          })),
          connectRecoveryTargetWithExactAuthority: connectRecoveryTargetWithExactAuthority as never,
          waitForConversationHydration: vi.fn(async () => 1),
          verifyCommittedPromptTurn: vi.fn(async () => undefined),
          waitForAssistantResponse: vi.fn(async () => ({
            text: "fallback answer",
            html: "",
            meta: { messageId: "assistant-2", turnId: "turn-2" },
          })),
          captureAssistantMarkdown: vi.fn(async () => "fallback markdown"),
          recoveryCleanup: {
            ...exactCleanupDeps,
            terminateRecordedChromeForProfile,
            removeProfile,
          },
        },
      );
      expect(acquireTemporaryChromeOwner).toHaveBeenCalledWith(
        expect.objectContaining({ headless: true }),
        expect.stringMatching(/oracle-reattach-/),
        expect.any(Function),
        {
          launchClaim: expect.objectContaining({
            version: 1,
            generationId: expect.any(String),
            nonce: expect.any(String),
          }),
        },
      );
      expect(result.runtime.chromeBrowserWSEndpoint).toBe(
        "ws://127.0.0.1:9222/devtools/browser/fallback-temporary",
      );

      await expect(result.abort()).resolves.toMatchObject({ status: "completed" });
      expect(exactCleanupDeps.closeChromeTargetWithExactAuthority).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: "fallback-owned-target" }),
      );
      expect(connectRecoveryTargetWithExactAuthority).toHaveBeenCalledWith(
        expect.objectContaining({
          authority: expect.objectContaining({
            browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/fallback-temporary",
          }),
          targetUrl: expect.stringContaining("oracle-acquisition="),
          closeTargetOnDispose: false,
        }),
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
        closeChromeTargetWithExactAuthority,
        terminateRecordedChromeForProfile,
        cleanupStaleProfileState,
        kill,
        releaseEndpointAuthority,
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
      expect(closeChromeTargetWithExactAuthority).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: "fallback-owned-target" }),
      );
      expect(kill).toHaveBeenCalledOnce();
      expect(releaseEndpointAuthority).toHaveBeenCalledOnce();
      expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
      expect(cleanupStaleProfileState).toHaveBeenCalledOnce();
      expect(releaseRecoveryLock).toHaveBeenCalledOnce();
      expect(cleanupOrder).toEqual(["target", "lease", "kill", "cleanup-profile", "endpoint"]);
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
          closeChromeTargetWithExactAuthority,
          terminateRecordedChromeForProfile,
          cleanupStaleProfileState,
          kill,
          releaseEndpointAuthority,
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
        expect(closeChromeTargetWithExactAuthority).toHaveBeenCalledWith(
          expect.objectContaining({ targetId: "fallback-owned-target" }),
        );
        expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
        expect(cleanupStaleProfileState).not.toHaveBeenCalled();
        expect(kill).not.toHaveBeenCalled();
        expect(releaseEndpointAuthority).toHaveBeenCalledOnce();
        expect(releaseRecoveryLock).toHaveBeenCalledOnce();
        expect(cleanupOrder).toEqual(["target", "lease", "endpoint"]);
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
  );

  test("fallback active-lease handoff releases only retained endpoint authority", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-active-owner-"));
    try {
      const { result, kill, cleanupStaleProfileState, releaseEndpointAuthority, cleanupOrder } =
        await resumeFallbackWithManualOwner(profileDir, "launched", { isLastLease: false });

      await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
      expect(kill).not.toHaveBeenCalled();
      expect(cleanupStaleProfileState).not.toHaveBeenCalled();
      expect(releaseEndpointAuthority).toHaveBeenCalledOnce();
      expect(cleanupOrder).toEqual(["target", "lease", "endpoint"]);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("fallback endpoint release failure retains retryable settled cleanup authority", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-endpoint-retry-"));
    try {
      const { result, kill, releaseEndpointAuthority, runtimeHints } =
        await resumeFallbackWithManualOwner(profileDir, "recorded", { endpointReleaseFailures: 1 });

      const pending = await result.finalize();
      expect(pending).toMatchObject({
        status: "pending",
        runtime: {
          chromeTargetId: undefined,
          recoveryCleanupResources: [
            {
              chromeTargetId: undefined,
              tabLease: undefined,
              recoveryCleanup: {
                ownsTarget: false,
                profileKind: "manual-login",
                keepBrowser: true,
              },
            },
          ],
        },
        error: "Exact Chrome endpoint release failed: transient endpoint release failure",
      });
      expect(runtimeHints.at(-1)).toMatchObject({
        chromeTargetId: undefined,
        recoveryCleanupResources: [
          {
            chromeTargetId: undefined,
            tabLease: undefined,
            recoveryCleanup: { ownsTarget: false, keepBrowser: true },
          },
        ],
        recoveryCleanupResult: { status: "failed", settlementMode: "finalize" },
      });
      expect(kill).not.toHaveBeenCalled();
      await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
      expect(releaseEndpointAuthority).toHaveBeenCalledTimes(2);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

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
    const logger = createBrowserLogger();

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
    const logger = createBrowserLogger();

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

      const result = await resumeBrowserSession(runtime, {}, createBrowserLogger(), {
        listTargets,
        connect,
        waitForConversationHydration,
        recoverSession,
      });

      expect(result.answerMarkdown).toBe("fallback-md");
      expect(connect).not.toHaveBeenCalled();
      expect(waitForConversationHydration).not.toHaveBeenCalled();
      expect(recoverSession).toHaveBeenCalledWith(
        expect.objectContaining({
          chromePort: 41111,
          chromeBrowserWSEndpoint: "ws://127.0.0.1:41111/devtools/browser/stale",
          chromeTargetId: undefined,
        }),
        {},
      );
      expect(result.runtime.recoveryCleanupResources).toEqual([
        expect.objectContaining({
          chromePort: 41111,
          chromeBrowserWSEndpoint: "ws://127.0.0.1:41111/devtools/browser/stale",
          chromeTargetId: "missing-original-target",
        }),
      ]);

      const finalized = await result.finalize();
      expect(finalized).toMatchObject({
        status: "pending",
        error: expect.stringContaining("Pre-upgrade browser session"),
      });
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
        createBrowserLogger(),
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
        createBrowserLogger(),
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
        createBrowserLogger(),
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
    const resumeRemoteBrowserTransaction = vi.fn();

    const result = await resumeBrowserSession(
      runtime,
      { browserTabRef: "borrowed-target", timeoutMs: 2_000 },
      createBrowserLogger(),
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
        resumeRemoteBrowserTransaction,
      },
    );

    expect(result.runtime).toMatchObject({
      chromeTargetId: "borrowed-target",
      recoveryCleanupResources: [
        expect.objectContaining({
          chromeTargetId: "missing-original-target",
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "none",
            keepBrowser: true,
          },
        }),
      ],
    });
    expect((await result.finalize()).status).toBe("completed");
    expect(resumeRemoteBrowserTransaction).not.toHaveBeenCalled();
  });

  test("keeps owned T1 unchanged while explicitly borrowing T2 in the same conversation", async () => {
    const baseRuntime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "owned-t1",
      tabUrl: "https://chatgpt.com/c/shared",
    });
    const capability = {
      version: 1 as const,
      generationId: "owned-generation",
      capabilityId: "owned-capability",
    };
    const runtime = withOwnedTargetResource(baseRuntime, "owned-t1", capability);
    const closeChromeTargetWithRetainedCapability = vi.fn(async () => ({
      status: "completed" as const,
    }));

    const { result } = await resumeExplicitTargetFixture({
      runtime,
      browserTabRef: "borrowed-t2",
      targets: [
        { targetId: "owned-t1", type: "page", url: runtime.tabUrl },
        { targetId: "borrowed-t2", type: "page", url: runtime.tabUrl },
      ],
      recoveryCleanup: { closeChromeTargetWithRetainedCapability },
    });

    expect(result.runtime.chromeTargetId).toBe("borrowed-t2");
    expect(result.runtime.recoveryCleanupResources).toEqual(runtime.recoveryCleanupResources);
    expect(__test__.reconcileReattachTargetAuthority(runtime, "borrowed-t2").authority).toEqual({
      kind: "borrowed",
    });

    const boundRuntime = await result.bindSettlement("finalize");
    expect(boundRuntime.recoveryCleanupResources).toEqual(runtime.recoveryCleanupResources);
    expect(boundRuntime.recoveryCleanupResult).toMatchObject({
      status: "pending",
      settlementMode: "finalize",
    });
    expect(closeChromeTargetWithRetainedCapability).not.toHaveBeenCalled();

    const finalized = await result.finalize();
    expect(closeChromeTargetWithRetainedCapability).toHaveBeenCalledWith({
      capability,
      targetId: "owned-t1",
      logger: expect.any(Function),
    });
    expect(finalized).toMatchObject({
      status: "completed",
      runtime: { chromeTargetId: "borrowed-t2" },
    });
    expect(finalized.runtime.recoveryCleanupResources).toBeUndefined();
  });

  test("retains selector-named T1 ownership after exact generation proof", async () => {
    const baseRuntime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "owned-t1",
      tabUrl: "https://chatgpt.com/c/shared",
    });
    const capability = {
      version: 1 as const,
      generationId: "owned-generation",
      capabilityId: "owned-capability",
    };
    const runtime = withOwnedTargetResource(baseRuntime, "owned-t1", capability);
    const closeChromeTargetWithRetainedCapability = vi.fn(async () => ({
      status: "completed" as const,
    }));

    const { result } = await resumeExplicitTargetFixture({
      runtime,
      browserTabRef: "owned-t1",
      targets: [
        { targetId: "owned-t1", type: "page", url: runtime.tabUrl },
        { targetId: "borrowed-t2", type: "page", url: runtime.tabUrl },
      ],
      recoveryCleanup: { closeChromeTargetWithRetainedCapability },
    });

    expect(__test__.reconcileReattachTargetAuthority(runtime, "owned-t1").authority).toEqual({
      kind: "owned",
      generationId: "owned-generation",
      capabilityId: "owned-capability",
    });
    expect(result.runtime.recoveryCleanupResources).toEqual(runtime.recoveryCleanupResources);
    expect(result.runtime.recoveryCleanupResources?.[0]?.recoveryCleanup.ownsTarget).toBe(true);
    await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
    expect(closeChromeTargetWithRetainedCapability).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "owned-t1", capability }),
    );
  });

  test("keeps unproven selector-named T1 pending without downgrading ownership", async () => {
    const baseRuntime = withCommittedPromptEpoch({
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "owned-t1",
      tabUrl: "https://chatgpt.com/c/shared",
    });
    const runtime = withOwnedTargetResource(baseRuntime, "owned-t1");
    const closeChromeTargetWithRetainedCapability = vi.fn(async () => ({
      status: "completed" as const,
    }));

    const { result } = await resumeExplicitTargetFixture({
      runtime,
      browserTabRef: "owned-t1",
      targets: [{ targetId: "owned-t1", type: "page", url: runtime.tabUrl }],
      recoveryCleanup: { closeChromeTargetWithRetainedCapability },
    });

    expect(__test__.reconcileReattachTargetAuthority(runtime, "owned-t1").authority).toEqual({
      kind: "borrowed",
    });
    expect(result.runtime.recoveryCleanupResources).toEqual(runtime.recoveryCleanupResources);
    expect(result.runtime.recoveryCleanupResources?.[0]?.recoveryCleanup.ownsTarget).toBe(true);
    await expect(result.finalize()).resolves.toMatchObject({
      status: "pending",
      runtime: {
        recoveryCleanupResources: [
          expect.objectContaining({
            chromeTargetId: "owned-t1",
            recoveryCleanup: expect.objectContaining({ ownsTarget: true }),
          }),
        ],
      },
    });

    expect(closeChromeTargetWithRetainedCapability).not.toHaveBeenCalled();
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
      bindSettlement: vi.fn(async (mode: "finalize" | "abort") => ({
        ...capturedRuntime,
        recoveryCleanupResult: { status: "pending" as const, settlementMode: mode },
      })),
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

    const result = await resumeBrowserSession(runtime, {}, createBrowserLogger(), {
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

  test("does not promote endpoint metadata after the recorded Chrome generation exits", async () => {
    const profileDir = path.join(os.tmpdir(), "oracle-reattach-exited-generation");
    const processIdentity = syntheticChromeProcessIdentity(profileDir, 9_101);
    const readActivePort = vi.fn(async () => ({
      port: 63332,
      browserWSEndpoint: "ws://127.0.0.1:63332/devtools/browser/replacement",
      path: path.join(profileDir, "DevToolsActivePort"),
    }));
    const retainEndpointAuthority = vi.fn();

    await expect(
      __test__.refreshAttachRuntime(
        {
          chromeProcessIdentity: processIdentity,
          chromeProfileRoot: profileDir,
          chromePort: 41111,
          chromeBrowserWSEndpoint: "ws://127.0.0.1:41111/devtools/browser/recorded",
        },
        {
          inspectProcessIdentity: vi.fn(async () => "exited" as const),
          readActivePort,
          retainEndpointAuthority,
        },
      ),
    ).resolves.toBeNull();
    expect(readActivePort).not.toHaveBeenCalled();
    expect(retainEndpointAuthority).not.toHaveBeenCalled();
  });

  test("refreshes endpoint metadata only through exact retained process authority", async () => {
    const profileDir = path.join(os.tmpdir(), "oracle-reattach-current-generation");
    const processIdentity = syntheticChromeProcessIdentity(profileDir, 9_102);
    const release = vi.fn(async () => undefined);
    const exactEndpoint = "ws://127.0.0.1:63333/devtools/browser/exact-generation";
    const retainEndpointAuthority = vi.fn(async () => ({
      browserWSEndpoint: exactEndpoint,
      kill: vi.fn(async () => ({
        status: "unsafe" as const,
        reason: "Test refresh authority is release-only",
      })),
      release,
    }));
    const runtime = withRecoveryCleanup(
      {
        chromeProcessIdentity: processIdentity,
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        chromePort: 41112,
        chromeBrowserWSEndpoint: "ws://127.0.0.1:41112/devtools/browser/recorded",
        chromeTargetId: "recorded-target",
      },
      {
        ownsTarget: true,
        profileKind: "none",
        keepBrowser: true,
        closeOwnedTargetOnComplete: true,
      },
    );
    const ownedResource = runtime.recoveryCleanupResources?.[0];
    if (!ownedResource) throw new Error("owned refresh fixture is missing");
    const exactRuntime: BrowserRuntimeMetadata = {
      ...runtime,
      recoveryCleanupResources: [
        {
          ...ownedResource,
          targetCloseCapability: {
            version: 1,
            generationId: "refresh-generation",
            capabilityId: "refresh-capability",
          },
          acquisition: {
            generationId: "refresh-generation",
            targetMarkerUrl: "about:blank#oracle-acquisition=refresh-generation",
          },
        },
      ],
    };

    const refreshed = await __test__.refreshAttachRuntime(exactRuntime, {
      inspectProcessIdentity: vi.fn(async () => "current" as const),
      readActivePort: vi.fn(async () => ({
        port: 63333,
        browserWSEndpoint: exactEndpoint,
        path: path.join(profileDir, "DevToolsActivePort"),
      })),
      retainEndpointAuthority,
    });

    expect(refreshed).toMatchObject({
      chromePort: 63333,
      chromeBrowserWSEndpoint: exactEndpoint,
      recoveryCleanupResources: [
        expect.objectContaining({
          chromePort: 63333,
          chromeBrowserWSEndpoint: exactEndpoint,
          chromeTargetId: "recorded-target",
        }),
      ],
    });
    expect(retainEndpointAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 63333,
        userDataDir: profileDir,
        processIdentity,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  test("preserves a restarted replacement endpoint exposing the same target id and marker", async () => {
    const profileDir = path.join(os.tmpdir(), "oracle-browser-replacement-process");
    const processIdentity = syntheticChromeProcessIdentity(profileDir, 9_103);
    const retainChromeEndpointAuthority = vi.fn();
    const result = await finalizeRecoveredRuntime(
      withRecoveryCleanup(
        {
          chromeProcessIdentity: processIdentity,
          chromeProfileRoot: profileDir,
          userDataDir: profileDir,
          chromePort: 63334,
          chromeBrowserWSEndpoint: "ws://127.0.0.1:63334/devtools/browser/replacement",
          chromeTargetId: "reused-target",
        },
        {
          ownsTarget: true,
          profileKind: "none",
          keepBrowser: true,
          closeOwnedTargetOnComplete: true,
        },
        undefined,
        {
          targetCloseCapability: {
            version: 1,
            generationId: "generation-a",
            capabilityId: "lost-after-server-restart",
          },
          acquisition: {
            generationId: "generation-a",
            targetMarkerUrl: "about:blank#oracle-acquisition=generation-a",
          },
        },
      ),
      createBrowserLogger(),
      {
        verifyProfileDirectoryIdentity: vi.fn(async () => true),
        inspectChromeProcessIdentity: vi.fn(async () => "current" as const),
        retainChromeEndpointAuthority,
      },
    );

    expect(result).toMatchObject({
      status: "pending",
      error: expect.stringContaining("no longer live"),
    });
    expect(retainChromeEndpointAuthority).not.toHaveBeenCalled();
  });

  test("does not mutate a replacement process, endpoint, or profile during deferred teardown", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-replacement-owner-"));
    const recordedIdentity = await physicalChromeProcessIdentity(profileDir, 9_107);
    const replacementIdentity = {
      ...recordedIdentity,
      pid: 9_108,
      processStartTime: "replacement",
    };
    const retainChromeEndpointAuthority = vi.fn();
    const closeChromeTargetWithExactAuthority = vi.fn();
    const removeProfile = vi.fn(async () => true);
    try {
      const result = await finalizeRecoveredRuntime(
        withRecoveryCleanup(
          {
            chromePort: 63336,
            chromeProcessIdentity: recordedIdentity,
            chromeProfileRoot: profileDir,
            userDataDir: profileDir,
          },
          {
            ownsTarget: false,
            profileKind: "temporary",
            keepBrowser: false,
          },
        ),
        createBrowserLogger(),
        {
          verifyProfileDirectoryIdentity: vi.fn(async () => true),
          inspectChromeProcessIdentity: vi.fn(async (_profileDir, identity) =>
            identity.pid === recordedIdentity.pid ? "exited" : "current",
          ),
          readOracleChromeOwner: vi.fn(async () => ({
            port: 63337,
            processIdentity: replacementIdentity,
            disposition: "preserve" as const,
          })),
          retainChromeEndpointAuthority,
          closeChromeTargetWithExactAuthority,
          removeProfile,
        },
      );

      expect(result).toMatchObject({
        status: "pending",
        error: expect.stringContaining("replacement process generation"),
      });
      expect(retainChromeEndpointAuthority).not.toHaveBeenCalled();
      expect(closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
      expect(removeProfile).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });
  test("preserves pre-upgrade target authority without endpoint reconstruction", async () => {
    const profileDir = path.join(os.tmpdir(), "oracle-browser-legacy-target-authority");
    const processIdentity = syntheticChromeProcessIdentity(profileDir, 9_104);
    const retainChromeEndpointAuthority = vi.fn();
    const result = await finalizeRecoveredRuntime(
      withRecoveryCleanup(
        {
          chromeProcessIdentity: processIdentity,
          chromeProfileRoot: profileDir,
          userDataDir: profileDir,
          chromePort: 63335,
          chromeTargetId: "persisted-target",
        },
        {
          ownsTarget: true,
          profileKind: "none",
          keepBrowser: true,
          closeOwnedTargetOnComplete: true,
        },
        undefined,
        { acquisition: { generationId: "legacy-generation" } },
      ),
      createBrowserLogger(),
      {
        retainChromeEndpointAuthority,
      },
    );

    expect(result).toMatchObject({
      status: "pending",
      error: expect.stringContaining("Pre-upgrade browser session"),
      runtime: {
        recoveryCleanupResult: {
          status: "failed",
          error: expect.stringContaining("Pre-upgrade browser session"),
          settlementMode: "finalize",
        },
        recoveryCleanupResources: [expect.objectContaining({ chromeTargetId: "persisted-target" })],
      },
    });
    expect(retainChromeEndpointAuthority).not.toHaveBeenCalled();
  });

  test("closes through the retained in-process opaque target capability", async () => {
    const close = vi.fn(async () => ({ status: "completed" as const }));
    const release = vi.fn(async () => undefined);
    const capability = retainChromeTargetCloseCapability({
      generationId: "live-generation",
      targetId: "valid-target",
      close: async () => close(),
      release,
    });
    const runtime = withRecoveryCleanup(
      {
        chromeTargetId: "valid-target",
      },
      {
        ownsTarget: true,
        profileKind: "none",
        keepBrowser: true,
        closeOwnedTargetOnComplete: true,
      },
      undefined,
      {
        targetCloseCapability: capability,
        acquisition: { generationId: "live-generation" },
      },
    );
    const result = await finalizeRecoveredRuntime(runtime, createBrowserLogger(), {});
    const replay = await finalizeRecoveredRuntime(runtime, createBrowserLogger(), {});

    expect(result.status).toBe("completed");
    expect(replay.status).toBe("completed");
    expect(close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
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
      createBrowserLogger(),
      { terminateRecordedChromeForProfile, removeProfile },
    );

    expect(result.status).toBe("completed");
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    expect(removeProfile).not.toHaveBeenCalled();
  });

  test("does not treat an absent profile as proof that an exact Chrome generation stopped", async () => {
    const profileDir = path.join(os.tmpdir(), "oracle-browser-absent-live-generation");
    await rm(profileDir, { recursive: true, force: true });
    const processIdentity = syntheticChromeProcessIdentity(profileDir, 9_109);
    const retainChromeEndpointAuthority = vi.fn();
    const removeProfile = vi.fn(async () => true);

    const result = await finalizeRecoveredRuntime(
      withRecoveryCleanup(
        { chromePort: 63338, userDataDir: profileDir, chromeProcessIdentity: processIdentity },
        {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
        },
      ),
      createBrowserLogger(),
      {
        verifyProfileDirectoryIdentity: vi.fn(async () => false),
        retainChromeEndpointAuthority,
        removeProfile,
      },
    );

    expect(result).toMatchObject({
      status: "pending",
      error: expect.stringContaining("physical profile generation could not be verified"),
    });
    expect(retainChromeEndpointAuthority).not.toHaveBeenCalled();
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
        createBrowserLogger(),
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

      const result = await finalizeRecoveredRuntime(runtime, createBrowserLogger(), {
        terminateRecordedChromeForProfile,
      });

      expect(result).toMatchObject({
        status: "pending",
        error: expect.stringContaining("no exact process/profile identity"),
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
        createBrowserLogger(),
        { teardownBrowserResourcesIfNoActiveLeases },
      );

      expect(result).toMatchObject({
        status: "pending",
        error: expect.stringContaining("no exact process/profile identity"),
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
    const logger = createBrowserLogger();
    const result = await resumeBrowserSession(runtime, {}, logger, {
      recoverSession: vi.fn(async () => {
        events.push("fallback-capture");
        return { answerText: "fallback", answerMarkdown: "fallback" };
      }),
      recoveryCleanup: {
        ...authenticatedLocalTargetCleanupDeps({
          closeTarget: (targetId) => {
            events.push(`close-${targetId}`);
            return { status: "completed" };
          },
          kill: (_profileDir, pid) => {
            events.push("terminate");
            return { ...stopped, pid };
          },
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
    expect(events).toEqual([
      "fallback-capture",
      "close-original-target",
      "terminate",
      "remove-profile",
    ]);
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
      createBrowserLogger(),
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
            chromePort: 9222,
            userDataDir: profileDir,
            chromeProcessIdentity: processIdentity,
          },
          {
            ownsTarget: false,
            profileKind: "copied",
            keepBrowser: false,
          },
        ),
        createBrowserLogger(),
        {
          ...authenticatedLocalTargetCleanupDeps({
            kill: () => ({ status: "unsafe", reason: "pid mismatch" }),
          }),
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
    const oldResource = withRetainedTargetCapability({
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
    });
    const currentResource = withRetainedTargetCapability({
      ...oldResource,
      chromePort: 9222,
      chromeTargetId: "current-target",
    });
    try {
      const result = await finalizeRecoveredRuntime(
        {
          chromeProcessIdentity: processIdentity,
          chromePort: 9222,
          userDataDir: profileDir,
          chromeTargetId: "current-target",
          recoveryCleanupResources: [oldResource, { ...oldResource }, currentResource],
        },
        createBrowserLogger(),
        {
          ...authenticatedLocalTargetCleanupDeps({
            closeTarget: (targetId) => {
              events.push(`close:${targetId}`);
              return { status: "completed" };
            },
            kill: (_profileDir, pid) => {
              events.push("terminate");
              return { ...stopped, pid };
            },
          }),
          removeProfile: vi.fn(async () => {
            events.push("remove-profile");
            return true;
          }),
        },
      );

      expect(result.status).toBe("completed");
      expect(events).toEqual([
        "close:old-target",
        "close:current-target",
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
      const oldResource: BrowserRecoveryCleanupResourceMetadata = withRetainedTargetCapability({
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
      });
      const currentResource: BrowserRecoveryCleanupResourceMetadata = withRetainedTargetCapability({
        ...oldResource,
        chromeTargetId: "current-target",
        tabLease: {
          id: "current-lease",
          profileDirectory: processIdentity.profileDirectory,
        },
      });
      const result = await finalizeRecoveredRuntime(
        {
          chromeProcessIdentity: processIdentity,
          chromePort: 9222,
          userDataDir: profileDir,
          chromeTargetId: "current-target",
          recoveryCleanupResources: [oldResource, currentResource],
        },
        createBrowserLogger(),
        {
          ...authenticatedLocalTargetCleanupDeps({
            closeTarget: (targetId) => {
              events.push(`close:${targetId}`);
              return { status: "completed" };
            },
            kill: (_profileDir, pid) => {
              events.push("terminate");
              return { ...stopped, pid };
            },
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
    const oldResource: BrowserRecoveryCleanupResourceMetadata = withRetainedTargetCapability({
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
    });
    const currentResource: BrowserRecoveryCleanupResourceMetadata = withRetainedTargetCapability({
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
    });
    try {
      const result = await finalizeRecoveredRuntime(
        {
          chromeProcessIdentity: currentIdentity,
          chromePort: 9333,
          userDataDir: currentProfile,
          chromeTargetId: "current-target",
          recoveryCleanupResources: [oldResource, currentResource],
        },
        createBrowserLogger(),
        {
          ...authenticatedLocalTargetCleanupDeps({
            closeTarget: (targetId) => {
              events.push(`close:${targetId}`);
              return targetId === "old-target"
                ? { status: "unsafe", reason: "old target close failed" }
                : { status: "completed" };
            },
            kill: (profileDir, pid) => {
              events.push(`terminate:${profileDir}`);
              return { ...stopped, pid };
            },
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
      ...authenticatedLocalTargetCleanupDeps({
        closeTarget: (targetId) => {
          events.push(`close:${targetId}`);
          if (targetId !== "old-target") return { status: "completed" };
          oldAttempts += 1;
          return oldAttempts > 1
            ? { status: "completed" }
            : { status: "unsafe", reason: "old target close failed" };
        },
        kill: (profileDir, pid) => {
          events.push(`terminate:${profileDir}`);
          return { ...stopped, pid };
        },
      }),
      removeProfile: vi.fn(async (profileDir: string) => {
        events.push(`remove:${profileDir}`);
        return true;
      }),
    };
    const oldIdentity = await physicalChromeProcessIdentity(oldProfile, 3333);
    const currentIdentity = await physicalChromeProcessIdentity(currentProfile, 4444);
    const oldResource: BrowserRecoveryCleanupResourceMetadata = withRetainedTargetCapability({
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
    });
    const currentResource: BrowserRecoveryCleanupResourceMetadata = withRetainedTargetCapability({
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
    });
    try {
      const first = await finalizeRecoveredRuntime(
        {
          chromeProcessIdentity: currentIdentity,
          chromePort: 9444,
          userDataDir: currentProfile,
          chromeTargetId: "current-target",
          recoveryCleanupResources: [oldResource, currentResource],
        },
        createBrowserLogger(),
        cleanupDeps,
      );

      expect(first.status).toBe("pending");
      expect(first.runtime.recoveryCleanupResources).toHaveLength(1);
      const second = await finalizeRecoveredRuntime(
        first.runtime,
        createBrowserLogger(),
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

  test("preserves a direct remote-CDP target without retained transaction authority", async () => {
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
      createBrowserLogger(),
      { terminateRecordedChromeForProfile },
    );

    expect(result).toMatchObject({
      status: "pending",
      error: expect.stringContaining("Pre-upgrade browser session"),
      runtime: {
        recoveryCleanupResult: {
          status: "failed",
          error: expect.stringContaining("Pre-upgrade browser session"),
          settlementMode: "finalize",
        },
        recoveryCleanupResources: [
          expect.objectContaining({ chromeTargetId: "direct-owned-target" }),
        ],
      },
    });
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });
  test.each([
    { mode: "finalize" as const, expectedCloses: 0 },
    { mode: "abort" as const, expectedCloses: 1 },
  ])(
    "$mode keeps reused-process disposition separate from owned-target disposition",
    async ({ mode, expectedCloses }) => {
      const profileDir = path.join(os.tmpdir(), "oracle-browser-reused-owner-target");
      const processIdentity = syntheticChromeProcessIdentity(profileDir, 9_105);
      const closeChromeTargetWithRetainedCapability = vi.fn(async () => ({
        status: "completed" as const,
      }));
      const runtime = withRecoveryCleanup(
        {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeProcessIdentity: processIdentity,
          userDataDir: profileDir,
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
        finalizeRecoveredRuntime(
          runtime,
          createBrowserLogger(),
          { ...authenticatedLocalTargetCleanupDeps(), closeChromeTargetWithRetainedCapability },
          mode,
        ),
      ).resolves.toMatchObject({ status: "completed" });
      expect(closeChromeTargetWithRetainedCapability).toHaveBeenCalledTimes(expectedCloses);
    },
  );

  test("fails closed when an owned target lacks its persisted finalize disposition", async () => {
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

    await expect(finalizeRecoveredRuntime(runtime, createBrowserLogger())).resolves.toMatchObject({
      status: "pending",
      error: expect.stringContaining("finalize disposition is missing"),
    });
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
      createBrowserLogger(),
      {
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
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });

  test("retries no-target cleanup through exact endpoint shutdown under the recovery lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-retry-test-"));
    const profileDir = await mkdtemp(path.join(root, "oracle-browser-retry-cleanup-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir);
    const events: string[] = [];
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    try {
      const result = await retryBrowserRecoveryCleanup(
        withRecoveryCleanup(
          {
            chromePort: 9222,
            userDataDir: profileDir,
            chromeProcessIdentity: processIdentity,
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
        createBrowserLogger(),
        {
          recoveryLockPath: path.join(root, "browser-recovery.lock"),
          recoveryCleanup: {
            ...authenticatedLocalTargetCleanupDeps({
              kill: (_profileDir, pid) => {
                events.push("browser-close");
                return { ...stopped, pid };
              },
              onRelease: () => events.push("release-endpoint"),
            }),
            terminateRecordedChromeForProfile,
            removeProfile: vi.fn(async () => {
              events.push("remove-profile");
              return true;
            }),
          },
        },
      );

      expect(result).toEqual({
        status: "completed",
        runtime: {
          chromePort: 9222,
          userDataDir: profileDir,
          chromeProcessIdentity: processIdentity,
        },
      });
      expect(events).toEqual(["browser-close", "remove-profile", "release-endpoint"]);
      expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves a journaled target acquisition marker after restart", async () => {
    const markerUrl = "about:blank#oracle-acquisition=marker-generation";
    const profileDir = path.join(os.tmpdir(), "oracle-browser-marker-generation");
    const processIdentity = syntheticChromeProcessIdentity(profileDir, 9_106);
    const closeChromeTargetWithExactAuthority = vi.fn(async () => ({
      status: "completed" as const,
    }));
    const listChromeTargetsWithExactAuthority = vi.fn(async () => ({
      status: "completed" as const,
      value: [
        {
          targetId: "marker-target",
          type: "page",
          url: markerUrl,
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/marker-target",
        },
      ],
    }));
    const runtime: BrowserRuntimeMetadata = {
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeProcessIdentity: processIdentity,
      userDataDir: profileDir,
      recoveryCleanupResources: [
        {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeProcessIdentity: processIdentity,
          profileDirectoryIdentity: processIdentity.profileDirectory,
          userDataDir: profileDir,
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
      retryBrowserRecoveryCleanup(runtime, createBrowserLogger(), {
        acquireRecoveryLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
        recoveryCleanup: {
          ...authenticatedLocalTargetCleanupDeps(),
          closeChromeTargetWithExactAuthority,
          listChromeTargetsWithExactAuthority,
        },
      }),
    ).resolves.toMatchObject({
      status: "pending",
      error: expect.stringContaining(
        "target acquisition ended before exact target close authority was published",
      ),
      runtime: {
        recoveryCleanupResources: [
          expect.objectContaining({
            acquisition: expect.objectContaining({ pendingResource: "chrome-target" }),
          }),
        ],
      },
    });
    expect(listChromeTargetsWithExactAuthority).not.toHaveBeenCalled();
    expect(closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
  });

  test("preserves manual-login resources while another lease is active", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-active-lease-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir);
    try {
      const kill = vi.fn();
      const cleanupStaleProfileState = vi.fn(async () => true);
      const result = await finalizeRecoveredRuntime(
        withRecoveryCleanup(
          {
            chromePort: 9222,
            userDataDir: profileDir,
            chromeProcessIdentity: processIdentity,
          },
          {
            ownsTarget: false,
            profileKind: "manual-login",
            keepBrowser: false,
          },
        ),
        createBrowserLogger(),
        {
          ...authenticatedLocalTargetCleanupDeps({
            kill: (_profileDir, pid) => {
              kill();
              return { ...stopped, pid };
            },
          }),
          teardownBrowserResourcesIfNoActiveLeases: vi.fn(async () => ({
            status: "preserved" as const,
            reason: "active-leases" as const,
          })),
          cleanupStaleProfileState,
        },
      );

      expect(result.status).toBe("pending");
      expect(kill).not.toHaveBeenCalled();
      expect(cleanupStaleProfileState).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("replays exact teardown when last lease cleanup completed before result persistence", async () => {
    const profileDir = await mkdtemp(
      path.join(os.tmpdir(), "oracle-browser-missing-lease-replay-"),
    );
    const processIdentity = await physicalChromeProcessIdentity(profileDir);
    try {
      const lease = await acquireBrowserTabLease(profileDir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "missing-lease-replay",
      });
      const staleRuntime = withRecoveryCleanup(
        { chromePort: 9222, userDataDir: profileDir, chromeProcessIdentity: processIdentity },
        {
          ownsTarget: false,
          profileKind: "manual-login",
          keepBrowser: false,
        },
      );
      const staleResource = staleRuntime.recoveryCleanupResources?.[0];
      if (!staleResource) throw new Error("missing cleanup resource fixture");
      staleResource.tabLease = {
        id: lease.id,
        profileDirectory: lease.profileDirectory,
      };
      const kill = vi.fn();
      const cleanupStaleProfileState = vi.fn(async () => true);
      const deps = {
        ...authenticatedLocalTargetCleanupDeps({
          kill: (_profileDir, pid) => {
            kill();
            return { ...stopped, pid };
          },
        }),
        cleanupStaleProfileState,
      };

      await expect(
        finalizeRecoveredRuntime(staleRuntime, createBrowserLogger(), deps),
      ).resolves.toMatchObject({ status: "completed" });
      await expect(
        finalizeRecoveredRuntime(staleRuntime, createBrowserLogger(), deps),
      ).resolves.toMatchObject({ status: "completed" });

      expect(kill).toHaveBeenCalledTimes(2);
      expect(cleanupStaleProfileState).toHaveBeenCalledTimes(2);
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
          { chromePort: 9222, userDataDir: profileDir, chromeProcessIdentity: processIdentity },
          {
            ownsTarget: false,
            profileKind: "manual-login",
            keepBrowser: false,
          },
        ),
        createBrowserLogger(),
        {
          ...authenticatedLocalTargetCleanupDeps({
            kill: (_profileDir, pid) => {
              events.push("terminate");
              return { ...stopped, pid };
            },
          }),
          teardownBrowserResourcesIfNoActiveLeases,
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
      createBrowserLogger(),
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
      createBrowserLogger(),
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

    const blocked = await finalizeRecoveredRuntime(runtime, createBrowserLogger(), deps);
    expect(blocked).toMatchObject({
      status: "pending",
      error: expect.stringContaining("durable answer publication acknowledgment"),
    });
    expect(settleRemoteBrowserRecovery).not.toHaveBeenCalled();

    const aborted = await finalizeRecoveredRuntime(
      blocked.runtime,
      createBrowserLogger(),
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
      retryBrowserRecoveryCleanup(runtime, createBrowserLogger(), { acquireRecoveryLock }, "abort"),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: { code: "settlement-mode-conflict", runtime },
    });
    expect(acquireRecoveryLock).not.toHaveBeenCalled();
  });

  test.each(["finalize", "abort"] as const)(
    "retries local cleanup using its persisted %s settlement mode",
    async (settlementMode) => {
      const profileDir = path.join(
        os.tmpdir(),
        `oracle-browser-persisted-${settlementMode}-settlement`,
      );
      const processIdentity = syntheticChromeProcessIdentity(profileDir, 9_107);
      const runtime: BrowserRuntimeMetadata = {
        chromeProcessIdentity: processIdentity,
        userDataDir: profileDir,
        recoveryCleanupResult: {
          status: "failed",
          error: "interrupted settlement",
          settlementMode,
        },
        recoveryCleanupResources: [
          withRetainedTargetCapability({
            chromeHost: "127.0.0.1",
            chromePort: 9222,
            chromeProcessIdentity: processIdentity,
            profileDirectoryIdentity: processIdentity.profileDirectory,
            userDataDir: profileDir,
            chromeTargetId: "owned-local-target",
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "none",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          }),
        ],
      };
      const closeChromeTargetWithRetainedCapability = vi
        .fn()
        .mockResolvedValueOnce({ status: "unsafe", reason: "target close was not confirmed" })
        .mockResolvedValueOnce({ status: "completed" });

      const result = await retryBrowserRecoveryCleanup(runtime, createBrowserLogger(), {
        acquireRecoveryLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
        recoveryCleanup: {
          ...authenticatedLocalTargetCleanupDeps(),
          closeChromeTargetWithRetainedCapability,
        },
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
      expect(closeChromeTargetWithRetainedCapability).toHaveBeenCalledOnce();
      await expect(
        retryBrowserRecoveryCleanup(
          result.runtime,
          createBrowserLogger(),
          { acquireRecoveryLock: vi.fn() },
          settlementMode === "finalize" ? "abort" : "finalize",
        ),
      ).rejects.toMatchObject({
        details: { code: "settlement-mode-conflict" },
      });
      await expect(
        retryBrowserRecoveryCleanup(result.runtime, createBrowserLogger(), {
          acquireRecoveryLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
          recoveryCleanup: {
            ...authenticatedLocalTargetCleanupDeps(),
            closeChromeTargetWithRetainedCapability,
          },
        }),
      ).resolves.toMatchObject({ status: "completed" });
      expect(closeChromeTargetWithRetainedCapability).toHaveBeenCalledTimes(2);
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
      retryBrowserRecoveryCleanup(runtime, createBrowserLogger(), { acquireRecoveryLock }),
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
      createBrowserLogger(),
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
      createBrowserLogger(),
      { terminateRecordedChromeForProfile },
    );

    expect(result).toMatchObject({ status: "pending", error: expect.stringMatching(/canonical/) });
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });

  test("serializes concurrent recovery for one session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-lock-test-"));
    const recoveryLockPath = path.join(root, "browser-recovery.lock");
    const logger = createBrowserLogger();
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
    const result = await resumeBrowserSession(runtime, {}, createBrowserLogger(), {
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
      resumeBrowserSession(runtime, {}, createBrowserLogger(), {
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

  test("creates and binds a dedicated owned recovery target through exact authority", async () => {
    const logger = createBrowserLogger();
    const closeConnection = vi.fn(async () => undefined);
    const endpointAuthority = {
      browserWSEndpoint: "ws://127.0.0.1:63333/devtools/browser/generation-a",
      kill: vi.fn(),
      runExactOperation: vi.fn(),
      release: vi.fn(),
    };
    const connectRecoveryTargetWithExactAuthority = vi.fn(async () => ({
      status: "completed" as const,
      value: {
        client: { close: vi.fn(async () => undefined) } as unknown as ChromeClient,
        targetId: "created-target",
        ownership: "created" as const,
        close: closeConnection,
      },
    }));

    const connection = await createOwnedRecoveryTargetConnection(
      endpointAuthority as never,
      "generation-a",
      logger,
      { connectRecoveryTargetWithExactAuthority: connectRecoveryTargetWithExactAuthority as never },
      "about:blank#oracle-acquisition=generation-a",
    );

    expect(connectRecoveryTargetWithExactAuthority).toHaveBeenCalledWith({
      authority: endpointAuthority,
      targetUrl: "about:blank#oracle-acquisition=generation-a",
      closeTargetOnDispose: false,
    });
    expect(connection).toMatchObject({ targetId: "created-target", ownership: "created" });
    await connection.close();
    expect(closeConnection).toHaveBeenCalledOnce();
  });

  test("failure-closes an acquired recovery target only through exact authority", async () => {
    const logger = createBrowserLogger();
    const closeConnection = vi.fn(async () => undefined);
    const closeChromeTargetWithExactAuthority = vi.fn(async () => ({
      status: "completed" as const,
    }));
    const endpointAuthority = {
      browserWSEndpoint: "ws://127.0.0.1:63333/devtools/browser/generation-a",
      kill: vi.fn(),
      runExactOperation: vi.fn(),
      release: vi.fn(),
    };

    await expect(
      createOwnedRecoveryTargetConnection(
        endpointAuthority as never,
        "generation-a",
        logger,
        {
          connectRecoveryTargetWithExactAuthority: vi.fn(async () => ({
            status: "completed" as const,
            value: {
              client: { close: vi.fn(async () => undefined) } as unknown as ChromeClient,
              targetId: "created-target",
              ownership: "created" as const,
              close: closeConnection,
            },
          })) as never,
          recoveryCleanup: { closeChromeTargetWithExactAuthority },
        },
        undefined,
        async () => {
          throw new Error("target journal unavailable");
        },
      ),
    ).rejects.toThrow("target journal unavailable");
    expect(closeConnection).toHaveBeenCalledOnce();
    expect(closeChromeTargetWithExactAuthority).toHaveBeenCalledWith({
      authority: endpointAuthority,
      targetId: "created-target",
      logger,
    });
  });

  test("does not acquire a recovery target from generation B after generation A exits", async () => {
    const generationBCreateTarget = vi.fn();
    const generationBAttachTarget = vi.fn();
    const endpointAuthority = {
      browserWSEndpoint: "ws://127.0.0.1:63333/devtools/browser/generation-a",
      kill: vi.fn(),
      runExactOperation: vi.fn(),
      release: vi.fn(),
    };
    const connectRecoveryTargetWithExactAuthority = vi.fn(async () => ({
      status: "gone" as const,
    }));

    await expect(
      createOwnedRecoveryTargetConnection(
        endpointAuthority as never,
        "generation-a",
        createBrowserLogger(),
        {
          connectRecoveryTargetWithExactAuthority: connectRecoveryTargetWithExactAuthority as never,
        },
      ),
    ).rejects.toThrow(/generation exited/i);
    expect(generationBCreateTarget).not.toHaveBeenCalled();
    expect(generationBAttachTarget).not.toHaveBeenCalled();
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
