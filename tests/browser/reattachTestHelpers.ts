import { vi } from "vitest";
import path from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import { resumeBrowserSession, type ReattachCleanupDeps } from "../../src/browser/reattach.js";
import type {
  BrowserRecoveryCleanupMetadata,
  BrowserRuntimeMetadata,
} from "../../src/sessionStore.js";
import type { BrowserRecoveryCleanupResourceMetadata } from "../../src/sessionManager.js";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";
import {
  captureProfileDirectoryIdentity,
  type ChromeProcessIdentity,
  type RecordedChromeTerminationOutcome,
} from "../../src/browser/profileState.js";
import type { ExactChromeTargetCleanupResult } from "../../src/browser/chromeLifecycle.js";
export function createBrowserLogger(): BrowserLogger {
  return vi.fn<(message: string) => void>();
}

export function syntheticChromeProcessIdentity(
  userDataDir: string,
  pid?: number,
): ChromeProcessIdentity {
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
      version: 2,
      platform: process.platform,
      canonicalPath,
      device: physical?.dev.toString() ?? "1",
      inode: physical?.ino.toString() ?? "1",
      birthtimeNs: physical?.birthtimeNs.toString() ?? "3",
    },
  };
}

export async function physicalChromeProcessIdentity(
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

export function withRetainedTargetCapability(
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
      targetId,
      ...(resource.chromeBrowserWSEndpoint
        ? { browserWSEndpoint: resource.chromeBrowserWSEndpoint }
        : {}),
    },
    acquisition: { ...resource.acquisition, generationId },
  };
}

export function withRecoveryCleanup(
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

export function authenticatedLocalTargetCleanupDeps(
  behavior: {
    closeTarget?: (targetId: string) => ExactChromeTargetCleanupResult;
    kill?: (userDataDir: string, pid: number) => RecordedChromeTerminationOutcome;
    mockRetainedTargetClose?: boolean;
    onRelease?: () => void;
  } = {},
): Pick<
  ReattachCleanupDeps,
  | "ownerId"
  | "verifyProfileDirectoryIdentity"
  | "inspectChromeProcessIdentity"
  | "retainChromeEndpointAuthority"
  | "closeChromeTargetWithExactAuthority"
  | "closeChromeTargetWithRetainedCapability"
  | "listChromeTargetsWithExactAuthority"
> {
  return {
    ownerId: "test-owner",
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

export type FakeTarget = { id?: string; targetId?: string; type?: string; url?: string };
export type FakeClient = {
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

export function createAttachedReattachClient(tabUrl: string) {
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

export function withOwnedTargetResource(
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

export async function resumeExplicitTargetFixture(options: {
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
      sessionId: "test-owner",
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
export function withCommittedPromptEpoch(
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

export type ManualOwnerSource = "launched" | "recorded" | "rediscovered";

export async function resumeFallbackWithManualOwner(
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
      _lease: Parameters<NonNullable<ReattachCleanupDeps["releaseBrowserTabLease"]>>[1],
      _logger?: BrowserLogger,
      releaseOptions?: { onRelease?: (context: { isLastLease: boolean }) => Promise<void> },
    ) => {
      cleanupOrder.push("lease");
      await releaseOptions?.onRelease?.({ isLastLease: behavior.isLastLease ?? true });
    },
  );
  const acquireBrowserTabLease = vi.fn(
    async (
      _profileDir: string,
      options: { leaseId?: string; sessionId: string; generationId: string },
    ) => {
      acquisitionOrder.push("acquire:tab-lease");
      return {
        id: options.leaseId ?? "fallback-lease",
        sessionId: options.sessionId,
        generationId: options.generationId,
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
      sessionId: "test-owner",
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
        settleManualChromeOwner: vi.fn(async (settlementProfileDir, settlementOwner) => {
          if (settlementProfileDir !== profileDir || settlementOwner !== owner) {
            throw new Error(
              "Fallback settlement did not receive its exact acquired owner authority",
            );
          }
          if (settlementOwner.disposition !== "close-on-last-lease") {
            try {
              await releaseEndpointAuthority();
              return { status: "preserved" as const };
            } catch (error) {
              return {
                status: "unsafe" as const,
                reason: `Exact Chrome endpoint release failed: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
          }
          await kill();
          if (!(await cleanupStaleProfileState())) {
            return {
              status: "unsafe" as const,
              reason: "Manual-login profile cleanup was not confirmed",
            };
          }
          try {
            await releaseEndpointAuthority();
            return { status: "terminated" as const };
          } catch (error) {
            return {
              status: "unsafe" as const,
              reason: `Exact Chrome endpoint release failed: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }),
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
