import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionStore.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionManager.js";

const meta = {
  id: "sess-recover",
  mode: "browser",
  browser: {
    config: {
      manualLogin: true,
      manualLoginProfileDir: "/tmp/recover-profile",
      maxConcurrentTabs: 1,
    },
    runtime: {
      tabUrl: "https://chatgpt.com/c/saved-conversation",
      conversationId: "saved-conversation",
      promptEpoch: {
        status: "committed",
        epochId: "epoch-saved-conversation",
        promptSha256: createHash("sha256").update("original prompt").digest("hex"),
        baselineTurns: 0,
        followUpOrdinal: 0,
        remainingFollowUps: 0,
        verifiedUserTurnIndex: 0,
        verifiedUserTurnId: "turn-0",
        verifiedUserMessageId: "message-0",
        conversationId: "saved-conversation",
      },
    },
  },
} as unknown as SessionMetadata;

const readyHarvest = {
  authenticated: true,
  assistantCount: 1,
  assistantFollowsLatestUser: true,
  lastAssistantTurnIndex: 1,
  lastUserTurnIndex: 0,
  lastUserTurnId: "turn-0",
  lastUserMessageId: "message-0",
  conversationId: "saved-conversation",
  lastUserText: "original prompt",
  stopExists: false,
  lastAssistantText: "Recovered answer",
  lastAssistantMarkdown: "Recovered answer",
  lastAssistantSnippet: "Recovered answer",
  state: "completed",
};

const profileDirectory = {
  version: 2 as const,
  platform: process.platform,
  canonicalPath: "/tmp/recover-profile",
  device: "1",
  inode: "2",
  birthtimeNs: "3",
};

function processIdentity(port: number) {
  return {
    pid: port,
    processStartTime: "2026-08-05T00:00:00.000Z",
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    normalizedUserDataDir: profileDirectory.canonicalPath,
    launchNonce: `recover-owner-${port}`,
    profileDirectory,
  };
}

function connectWithExactTarget(targetId: string, events?: string[]) {
  return vi.fn(async () => {
    events?.push("target");
    return {
      targetId,
      client: {
        Page: {
          enable: vi.fn(async () => undefined),
          navigate: vi.fn(async () => ({ frameId: "frame-1" })),
        },
        close: vi.fn(async () => undefined),
      },
    };
  });
}

function endpointAuthority(port: number) {
  return {
    browserWSEndpoint: `ws://127.0.0.1:${port}/devtools/browser/generation-a`,
    kill: vi.fn(),
    runExactOperation: vi.fn(),
    release: vi.fn(async () => undefined),
  };
}

async function releaseManualChromeOwnerEndpointAuthorityForTest(owner: {
  endpointAuthority?: { release: () => Promise<void> };
}) {
  await owner.endpointAuthority?.release();
}
// Each case dynamically imports the subject after installing isolated module mocks.
const logger = (_message: string) => {};

function retainBrowserTabLeaseTeardownAuthorityForTest(
  _profileDir: string,
  lease: {
    release: (options?: {
      onRelease?: (context: { isLastLease: boolean }) => Promise<void>;
    }) => Promise<void>;
  },
  options?: { onActiveLeaseHandoff?: () => Promise<void> },
) {
  let leaseReleased = false;
  let wasLastLease = false;
  return {
    get leaseReleased() {
      return leaseReleased;
    },
    async settle(teardown: () => Promise<boolean>) {
      let teardownSucceeded = false;
      if (!leaseReleased) {
        await lease.release({
          onRelease: async ({ isLastLease }) => {
            wasLastLease = isLastLease;
            if (isLastLease) teardownSucceeded = await teardown();
          },
        });
        leaseReleased = true;
        if (!wasLastLease) await options?.onActiveLeaseHandoff?.();
      } else if (wasLastLease) {
        teardownSucceeded = await teardown();
      }
      if (wasLastLease && !teardownSucceeded) {
        return { status: "preserved" as const, reason: "teardown-unsafe" as const };
      }
      return {
        status: "completed" as const,
        disposition: wasLastLease
          ? ("teardown-completed" as const)
          : ("active-lease-handoff" as const),
      };
    },
  };
}

async function settleManualChromeOwnerForTest(
  _profileDir: string,
  owner: {
    disposition: "preserve" | "close-on-last-lease";
    chrome: { kill: () => Promise<{ status: string; reason?: string }> };
    endpointAuthority?: { release: () => Promise<void> };
  },
) {
  if (owner.disposition === "preserve") {
    await owner.endpointAuthority?.release();
    return { status: "preserved" as const };
  }
  const outcome = await owner.chrome.kill();
  return outcome.status === "stopped" || outcome.status === "already-stopped"
    ? { status: "terminated" as const }
    : { status: "unsafe" as const, reason: outcome.reason ?? "termination failed" };
}

describe("recoverConversationTab lease ownership", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../../src/browser/profileState.js", () => ({
      captureProfileDirectoryIdentity: vi.fn(async () => profileDirectory),
      createChromeProcessLaunchClaim: (generationId: string) => ({
        version: 1 as const,
        generationId,
        nonce: "a0000000-0000-4000-8000-00000000000a",
      }),
    }));
  });

  test("releases the persisted exact lease when acquisition throws after installing it", async () => {
    const persisted: BrowserRuntimeMetadata[] = [];
    let installedLeaseId: string | undefined;
    const acquireBrowserTabLease = vi.fn(
      async (_profileDir: string, options: { leaseId?: string }) => {
        installedLeaseId = options.leaseId;
        throw new Error("post-effect lease fsync failed");
      },
    );
    const releaseBrowserTabLease = vi.fn(
      async (
        _profileDir: string,
        leaseId: string,
        _logger: typeof logger,
        options: { expectedProfileIdentity?: typeof profileDirectory },
      ) => {
        expect(leaseId).toBe(installedLeaseId);
        expect(options.expectedProfileIdentity).toEqual(profileDirectory);
        installedLeaseId = undefined;
      },
    );

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: vi.fn(),
      harvestChatGptTab: vi.fn(),
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({
      acquireManualChromeOwner: vi.fn(),
      settleManualChromeOwner: settleManualChromeOwnerForTest,
      releaseManualChromeOwnerEndpointAuthority: releaseManualChromeOwnerEndpointAuthorityForTest,
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      closeChromeTargetWithExactAuthority: vi.fn(),
      connectWithNewTabWithRetainedLiveAuthority: vi.fn(),
      connectWithNewTabWithExactAuthority: vi.fn(),
    }));
    vi.doMock("../../src/browser/tabLeaseRegistry.js", () => ({
      DEFAULT_MAX_CONCURRENT_CHATGPT_TABS: 3,
      normalizeMaxConcurrentTabs: (value: unknown) => Number(value ?? 3),
      acquireBrowserTabLease,
      releaseBrowserTabLease,
      retainBrowserTabLeaseTeardownAuthority: retainBrowserTabLeaseTeardownAuthorityForTest,
    }));
    vi.doMock("../../src/browser/index.js", () => ({ isImageOnlyUiChromeText: () => false }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    await expect(
      recoverConversationTab(meta, logger, {
        persistRuntime: async (runtime) => {
          persisted.push(runtime);
        },
      }),
    ).rejects.toThrow("post-effect lease fsync failed");

    expect(releaseBrowserTabLease).toHaveBeenCalledWith(
      "/tmp/recover-profile",
      expect.any(String),
      logger,
      { expectedProfileIdentity: profileDirectory },
    );
    expect(installedLeaseId).toBeUndefined();
    expect(persisted[0]).toMatchObject({
      recoveryCleanupResources: [
        {
          tabLease: { id: expect.any(String), profileDirectory },
          acquisition: { pendingResource: "tab-lease" },
        },
      ],
    });
    expect(persisted.at(-1)?.recoveryCleanupResources).toBeUndefined();
  });

  test("keeps the persisted lease intent pending when exact post-effect release fails", async () => {
    const persisted: BrowserRuntimeMetadata[] = [];
    let installedLeaseId: string | undefined;
    const acquireBrowserTabLease = vi.fn(
      async (_profileDir: string, options: { leaseId?: string }) => {
        installedLeaseId = options.leaseId;
        throw new Error("post-effect lease identity check failed");
      },
    );
    const releaseBrowserTabLease = vi.fn(async () => {
      throw new Error("registry release fsync failed");
    });

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: vi.fn(),
      harvestChatGptTab: vi.fn(),
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({
      acquireManualChromeOwner: vi.fn(),
      settleManualChromeOwner: settleManualChromeOwnerForTest,
      releaseManualChromeOwnerEndpointAuthority: releaseManualChromeOwnerEndpointAuthorityForTest,
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      closeChromeTargetWithExactAuthority: vi.fn(),
      connectWithNewTabWithRetainedLiveAuthority: vi.fn(),
      connectWithNewTabWithExactAuthority: vi.fn(),
    }));
    vi.doMock("../../src/browser/tabLeaseRegistry.js", () => ({
      DEFAULT_MAX_CONCURRENT_CHATGPT_TABS: 3,
      normalizeMaxConcurrentTabs: (value: unknown) => Number(value ?? 3),
      acquireBrowserTabLease,
      releaseBrowserTabLease,
      retainBrowserTabLeaseTeardownAuthority: retainBrowserTabLeaseTeardownAuthorityForTest,
    }));
    vi.doMock("../../src/browser/index.js", () => ({ isImageOnlyUiChromeText: () => false }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    await expect(
      recoverConversationTab(meta, logger, {
        persistRuntime: async (runtime) => {
          persisted.push(runtime);
        },
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("cleanup remains pending"),
      details: {
        stage: "recovered-conversation-cleanup",
        runtime: {
          recoveryCleanupResources: [
            {
              tabLease: { id: expect.any(String), profileDirectory },
              acquisition: { pendingResource: "tab-lease" },
            },
          ],
          recoveryCleanupResult: {
            status: "failed",
            settlementMode: "abort",
            error: expect.stringContaining("registry release fsync failed"),
          },
        },
      },
    });

    expect(releaseBrowserTabLease).toHaveBeenCalledWith(
      "/tmp/recover-profile",
      installedLeaseId,
      logger,
      { expectedProfileIdentity: profileDirectory },
    );
    expect(installedLeaseId).toEqual(expect.any(String));
    expect(persisted.at(-1)).toMatchObject({
      recoveryCleanupResources: [
        {
          tabLease: { id: installedLeaseId, profileDirectory },
          acquisition: { pendingResource: "tab-lease" },
        },
      ],
      recoveryCleanupResult: {
        status: "failed",
        settlementMode: "abort",
      },
    });
  });

  test("leases before reusing a process-less canonical Chrome owner and cleans the owned target once", async () => {
    const events: string[] = [];
    const acquireBrowserTabLease = vi.fn(async () => {
      events.push("lease");
      return {
        id: "lease-reused",
        profileDirectory,
        update: vi.fn(async () => events.push("update")),
        release: vi.fn(async () => events.push("release")),
      };
    });
    const closeChromeTargetWithExactAuthority = vi.fn(async () => {
      events.push("close");
      return { status: "completed" as const };
    });
    const ownerIdentity = processIdentity(53999);
    const exactAuthority = endpointAuthority(53999);
    const chrome = {
      host: "127.0.0.1",
      port: 53999,
      kill: vi.fn(),
      process: undefined,
      processIdentity: ownerIdentity,
      endpointAuthority: exactAuthority,
    };
    const acquireManualChromeOwner = vi.fn(async () => {
      events.push("owner");
      return {
        chrome,
        processIdentity: ownerIdentity,
        source: "recorded" as const,
        disposition: "preserve" as const,
        endpointAuthority: exactAuthority,
      };
    });

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      harvestChatGptTab: vi.fn(async () => readyHarvest),
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({
      acquireManualChromeOwner,
      settleManualChromeOwner: settleManualChromeOwnerForTest,
      releaseManualChromeOwnerEndpointAuthority: releaseManualChromeOwnerEndpointAuthorityForTest,
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectWithNewTab: vi.fn(),
      closeChromeTargetWithExactAuthority,
      connectWithNewTabWithExactAuthority: connectWithExactTarget("target-reused", events),
    }));
    vi.doMock("../../src/browser/tabLeaseRegistry.js", () => ({
      DEFAULT_MAX_CONCURRENT_CHATGPT_TABS: 3,
      normalizeMaxConcurrentTabs: (value: unknown) => Number(value ?? 3),
      acquireBrowserTabLease,
      retainBrowserTabLeaseTeardownAuthority: retainBrowserTabLeaseTeardownAuthorityForTest,
    }));
    vi.doMock("../../src/browser/index.js", () => ({ isImageOnlyUiChromeText: () => false }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    const recovered = await recoverConversationTab(meta, logger, {
      readyTimeoutMs: 1,
      persistRuntime: async (runtime) => {
        const resource = runtime.recoveryCleanupResources?.[0];
        const settlementMode = runtime.recoveryCleanupResult?.settlementMode;
        const pending = resource?.acquisition?.pendingResource;
        if (settlementMode) {
          events.push(`persist:settlement:${settlementMode}`);
        } else if (pending) {
          events.push(`persist:intent:${pending}`);
        } else if (resource?.chromeTargetId) {
          events.push("persist:exact:chrome-target");
        } else if (resource?.chromeProcessIdentity) {
          events.push("persist:exact:chrome-process");
        } else if (resource?.tabLease) {
          events.push("persist:exact:tab-lease");
        }
      },
    });

    expect(events).toEqual([
      "persist:intent:tab-lease",
      "lease",
      "persist:exact:tab-lease",
      "persist:intent:chrome-process",
      "owner",
      "persist:exact:chrome-process",
      "persist:intent:chrome-target",
      "target",
      "persist:exact:chrome-target",
      "persist:exact:chrome-target",
      "update",
    ]);
    expect(acquireBrowserTabLease).toHaveBeenCalledWith(
      "/tmp/recover-profile",
      expect.objectContaining({ maxConcurrentTabs: 1, sessionId: "sess-recover" }),
    );
    expect(recovered.ref).toBe("target-reused");
    const cleanupResults = await Promise.all([
      recovered.cleanup("finalize"),
      recovered.cleanup("finalize"),
    ]);
    expect(cleanupResults).toEqual([
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({ status: "completed" }),
    ]);
    await expect(recovered.cleanup("finalize", {})).resolves.toMatchObject({
      status: "completed",
    });
    expect(closeChromeTargetWithExactAuthority).toHaveBeenCalledTimes(1);
    expect(closeChromeTargetWithExactAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: exactAuthority,
        targetId: "target-reused",
      }),
    );
    expect(events.indexOf("persist:settlement:finalize")).toBeGreaterThan(events.indexOf("update"));
    expect(events.indexOf("close")).toBeGreaterThan(events.indexOf("persist:settlement:finalize"));
    expect(events.indexOf("release")).toBeGreaterThan(events.indexOf("close"));
    expect(chrome.kill).not.toHaveBeenCalled();
  });

  test("keeps target and lease authority pending until target cleanup is confirmed", async () => {
    const release = vi.fn(async () => undefined);
    const acquireBrowserTabLease = vi.fn(async () => ({
      id: "lease-retry",
      profileDirectory,
      update: vi.fn(async () => undefined),
      release,
    }));
    const closeChromeTargetWithExactAuthority = vi
      .fn()
      .mockResolvedValueOnce({ status: "unsafe", reason: "target close was not confirmed" })
      .mockResolvedValueOnce({ status: "completed" });

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      harvestChatGptTab: vi.fn(async () => readyHarvest),
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({
      acquireManualChromeOwner: vi.fn(async () => {
        const ownerIdentity = processIdentity(53994);
        const exactAuthority = endpointAuthority(53994);
        return {
          chrome: {
            host: "127.0.0.1",
            port: 53994,
            kill: vi.fn(),
            processIdentity: ownerIdentity,
            endpointAuthority: exactAuthority,
          },
          processIdentity: ownerIdentity,
          source: "recorded" as const,
          disposition: "preserve" as const,
          endpointAuthority: exactAuthority,
        };
      }),
      settleManualChromeOwner: settleManualChromeOwnerForTest,
      releaseManualChromeOwnerEndpointAuthority: releaseManualChromeOwnerEndpointAuthorityForTest,
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectWithNewTab: vi.fn(),
      closeChromeTargetWithExactAuthority,
      connectWithNewTabWithExactAuthority: connectWithExactTarget("target-retry"),
    }));
    vi.doMock("../../src/browser/tabLeaseRegistry.js", () => ({
      DEFAULT_MAX_CONCURRENT_CHATGPT_TABS: 3,
      normalizeMaxConcurrentTabs: (value: unknown) => Number(value ?? 3),
      acquireBrowserTabLease,
      retainBrowserTabLeaseTeardownAuthority: retainBrowserTabLeaseTeardownAuthorityForTest,
    }));
    vi.doMock("../../src/browser/index.js", () => ({ isImageOnlyUiChromeText: () => false }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    const recovered = await recoverConversationTab(meta, logger, { readyTimeoutMs: 1 });
    await expect(recovered.cleanup("finalize")).resolves.toMatchObject({
      status: "pending",
      runtime: {
        recoveryCleanupResult: { settlementMode: "finalize" },
        recoveryCleanupResources: [
          {
            chromeHost: "127.0.0.1",
            chromePort: 53994,
            chromeTargetId: "target-retry",
            targetCloseCapability: {
              version: 1,
              generationId: expect.any(String),
              capabilityId: expect.any(String),
            },
            acquisition: { generationId: expect.any(String) },
            tabLease: { id: "lease-retry", profileDirectory },
            recoveryCleanup: { ownsTarget: true },
          },
        ],
      },
    });
    expect(release).not.toHaveBeenCalled();

    await expect(recovered.cleanup("finalize")).resolves.toMatchObject({ status: "completed" });
    expect(closeChromeTargetWithExactAuthority).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("updates the lease with recovered target metadata and terminates only a last launched owner", async () => {
    const update = vi.fn(async () => undefined);
    const release = vi.fn(
      async (options?: { onRelease?: (context: { isLastLease: boolean }) => Promise<void> }) => {
        await options?.onRelease?.({ isLastLease: true });
      },
    );
    const closeChromeTargetWithExactAuthority = vi.fn(async () => ({
      status: "completed" as const,
    }));
    const acquireBrowserTabLease = vi.fn(async () => ({
      id: "lease-launched",
      profileDirectory,
      update,
      release,
    }));
    const ownerIdentity = processIdentity(53998);
    const exactAuthority = endpointAuthority(53998);
    const chrome = {
      host: "127.0.0.1",
      port: 53998,
      processIdentity: ownerIdentity,
      endpointAuthority: exactAuthority,
      kill: vi.fn(async () => ({
        status: "stopped" as const,
        pid: 53998,
        signal: "SIGTERM" as const,
      })),
    };
    const acquireManualChromeOwner = vi.fn(async () => ({
      chrome,
      processIdentity: ownerIdentity,
      source: "launched" as const,
      disposition: "close-on-last-lease" as const,
      endpointAuthority: exactAuthority,
    }));

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      harvestChatGptTab: vi.fn(async () => readyHarvest),
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({
      acquireManualChromeOwner,
      settleManualChromeOwner: settleManualChromeOwnerForTest,
      releaseManualChromeOwnerEndpointAuthority: releaseManualChromeOwnerEndpointAuthorityForTest,
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectWithNewTab: vi.fn(),
      closeChromeTargetWithExactAuthority,
      connectWithNewTabWithExactAuthority: connectWithExactTarget("target-launched"),
    }));
    vi.doMock("../../src/browser/tabLeaseRegistry.js", () => ({
      DEFAULT_MAX_CONCURRENT_CHATGPT_TABS: 3,
      normalizeMaxConcurrentTabs: (value: unknown) => Number(value ?? 3),
      acquireBrowserTabLease,
      retainBrowserTabLeaseTeardownAuthority: retainBrowserTabLeaseTeardownAuthorityForTest,
    }));
    vi.doMock("../../src/browser/index.js", () => ({ isImageOnlyUiChromeText: () => false }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    const recovered = await recoverConversationTab(meta, logger, { readyTimeoutMs: 1 });
    await recovered.cleanup("finalize");

    expect(update).toHaveBeenCalledWith({
      chromeHost: "127.0.0.1",
      chromePort: 53998,
      chromeTargetId: "target-launched",
      tabUrl: "https://chatgpt.com/c/saved-conversation",
    });
    expect(closeChromeTargetWithExactAuthority).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ onRelease: expect.any(Function) }),
    );
    expect(chrome.kill).toHaveBeenCalledTimes(1);
  });

  test("closes the owned target and releases its lease when readiness fails", async () => {
    const update = vi.fn(async () => undefined);
    const release = vi.fn(
      async (options?: { onRelease?: (context: { isLastLease: boolean }) => Promise<void> }) => {
        await options?.onRelease?.({ isLastLease: true });
      },
    );
    const closeChromeTargetWithExactAuthority = vi.fn(async () => ({
      status: "completed" as const,
    }));
    const acquireBrowserTabLease = vi.fn(async () => ({
      id: "lease-error",
      profileDirectory,
      update,
      release,
    }));
    const ownerIdentity = processIdentity(53997);
    const exactAuthority = endpointAuthority(53997);
    const chrome = {
      host: "127.0.0.1",
      port: 53997,
      processIdentity: ownerIdentity,
      endpointAuthority: exactAuthority,
      kill: vi.fn(async () => ({
        status: "stopped" as const,
        pid: 53997,
        signal: "SIGTERM" as const,
      })),
    };

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      harvestChatGptTab: vi.fn(async () => ({ ...readyHarvest, assistantCount: 0 })),
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({
      acquireManualChromeOwner: vi.fn(async () => ({
        chrome,
        processIdentity: ownerIdentity,
        source: "launched" as const,
        disposition: "close-on-last-lease" as const,
        endpointAuthority: exactAuthority,
      })),
      settleManualChromeOwner: settleManualChromeOwnerForTest,
      releaseManualChromeOwnerEndpointAuthority: releaseManualChromeOwnerEndpointAuthorityForTest,
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectWithNewTab: vi.fn(),
      closeChromeTargetWithExactAuthority,
      connectWithNewTabWithExactAuthority: connectWithExactTarget("target-error"),
    }));
    vi.doMock("../../src/browser/tabLeaseRegistry.js", () => ({
      DEFAULT_MAX_CONCURRENT_CHATGPT_TABS: 3,
      normalizeMaxConcurrentTabs: (value: unknown) => Number(value ?? 3),
      acquireBrowserTabLease,
      retainBrowserTabLeaseTeardownAuthority: retainBrowserTabLeaseTeardownAuthorityForTest,
    }));
    vi.doMock("../../src/browser/index.js", () => ({ isImageOnlyUiChromeText: () => false }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    await expect(recoverConversationTab(meta, logger, { readyTimeoutMs: 0 })).rejects.toThrow(
      /did not become ready/,
    );

    expect(closeChromeTargetWithExactAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "target-error", authority: exactAuthority }),
    );
    expect(closeChromeTargetWithExactAuthority).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("does not acquire or failure-close through generation B after same-port rebinding", async () => {
    const release = vi.fn(
      async (options?: { onRelease?: (context: { isLastLease: boolean }) => Promise<void> }) => {
        await options?.onRelease?.({ isLastLease: true });
      },
    );
    const ownerIdentity = processIdentity(53995);
    const generationBCreateTarget = vi.fn();
    const generationBAttachTarget = vi.fn();
    const exactAuthority = {
      ...endpointAuthority(53995),
      runExactOperation: vi.fn(async (_operation: () => Promise<unknown>) => ({
        status: "gone" as const,
      })),
    };
    const chrome = {
      host: "127.0.0.1",
      port: 53995,
      processIdentity: ownerIdentity,
      endpointAuthority: exactAuthority,
      kill: vi.fn(async () => ({
        status: "stopped" as const,
        pid: 53995,
        signal: "SIGTERM" as const,
      })),
    };
    const closeChromeTargetWithExactAuthority = vi.fn(async () => ({
      status: "completed" as const,
    }));

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      harvestChatGptTab: vi.fn(),
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({
      acquireManualChromeOwner: vi.fn(async () => ({
        chrome,
        processIdentity: ownerIdentity,
        source: "launched" as const,
        disposition: "close-on-last-lease" as const,
        endpointAuthority: exactAuthority,
      })),
      settleManualChromeOwner: settleManualChromeOwnerForTest,
      releaseManualChromeOwnerEndpointAuthority: releaseManualChromeOwnerEndpointAuthorityForTest,
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      closeChromeTargetWithExactAuthority,
      connectWithNewTab: generationBCreateTarget,
      connectWithNewTabWithExactAuthority: vi.fn(async (authority: typeof exactAuthority) => {
        const result = await authority.runExactOperation(async () => {
          generationBCreateTarget();
          generationBAttachTarget();
          return undefined;
        });
        if (result.status === "gone") throw new Error("Exact Chrome process generation exited");
        throw new Error("Unexpected exact authority result");
      }),
    }));
    vi.doMock("../../src/browser/tabLeaseRegistry.js", () => ({
      DEFAULT_MAX_CONCURRENT_CHATGPT_TABS: 3,
      normalizeMaxConcurrentTabs: (value: unknown) => Number(value ?? 3),
      acquireBrowserTabLease: vi.fn(async () => ({
        id: "lease-target-error",
        profileDirectory,
        update: vi.fn(async () => undefined),
        release,
      })),
      retainBrowserTabLeaseTeardownAuthority: retainBrowserTabLeaseTeardownAuthorityForTest,
    }));
    vi.doMock("../../src/browser/index.js", () => ({ isImageOnlyUiChromeText: () => false }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    await expect(recoverConversationTab(meta, logger, { readyTimeoutMs: 1 })).rejects.toThrow(
      /generation exited/,
    );

    expect(closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
    expect(generationBCreateTarget).not.toHaveBeenCalled();
    expect(generationBAttachTarget).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(chrome.kill).toHaveBeenCalledTimes(1);
  });

  test("cleans an explicitly non-owned endpoint only through its retained live authority", async () => {
    const closeConnection = vi.fn(async () => undefined);
    const releaseLease = vi.fn(async () => undefined);
    const liveTargetAuthority = {
      runExactOperation: vi.fn(),
      release: closeConnection,
    };
    const createRemoteTarget = connectWithExactTarget("remote-target");
    const liveConnectWithNewTab = vi.fn(async () => ({
      ...(await createRemoteTarget()),
      ownership: "created" as const,
      targetCloseAuthority: liveTargetAuthority,
      close: closeConnection,
    }));
    const closeChromeTargetWithExactAuthority = vi.fn(async () => ({
      status: "completed" as const,
    }));
    const connectWithNewTabWithExactAuthority = vi.fn();
    const acquireManualChromeOwner = vi.fn();

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      harvestChatGptTab: vi.fn(async () => readyHarvest),
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({
      acquireManualChromeOwner,
      settleManualChromeOwner: settleManualChromeOwnerForTest,
      releaseManualChromeOwnerEndpointAuthority: releaseManualChromeOwnerEndpointAuthorityForTest,
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      closeChromeTargetWithExactAuthority,
      connectWithNewTabWithRetainedLiveAuthority: liveConnectWithNewTab,
      connectWithNewTabWithExactAuthority,
    }));
    vi.doMock("../../src/browser/tabLeaseRegistry.js", () => ({
      DEFAULT_MAX_CONCURRENT_CHATGPT_TABS: 3,
      normalizeMaxConcurrentTabs: (value: unknown) => Number(value ?? 3),
      acquireBrowserTabLease: vi.fn(async () => ({
        id: "lease-remote",
        profileDirectory,
        update: vi.fn(async () => undefined),
        release: releaseLease,
      })),
      retainBrowserTabLeaseTeardownAuthority: retainBrowserTabLeaseTeardownAuthorityForTest,
    }));
    vi.doMock("../../src/browser/index.js", () => ({ isImageOnlyUiChromeText: () => false }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    const recovered = await recoverConversationTab(meta, logger, {
      existingEndpoint: { host: "remote.example", port: 9444, ownership: "non-owned" },
      readyTimeoutMs: 1,
    });

    expect(recovered).toMatchObject({ host: "remote.example", port: 9444, ref: "remote-target" });
    expect(liveConnectWithNewTab).toHaveBeenCalledWith(
      9444,
      logger,
      expect.stringMatching(/^about:blank#oracle-recovery=/),
      "remote.example",
      { retries: 6 },
    );
    expect(connectWithNewTabWithExactAuthority).not.toHaveBeenCalled();
    expect(acquireManualChromeOwner).not.toHaveBeenCalled();
    await expect(recovered.cleanup("finalize")).resolves.toMatchObject({ status: "completed" });
    expect(closeChromeTargetWithExactAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ authority: liveTargetAuthority, targetId: "remote-target" }),
    );
    expect(closeConnection).toHaveBeenCalledOnce();
    expect(releaseLease).toHaveBeenCalledOnce();
  });

  test("releases each recovery before another recovery can acquire the single available tab lease", async () => {
    let activeLeases = 0;
    const release = vi.fn(async () => {
      activeLeases -= 1;
    });
    const acquireBrowserTabLease = vi.fn(async () => {
      if (activeLeases > 0) throw new Error("maxConcurrentTabs exceeded");
      activeLeases += 1;
      return {
        id: `lease-${activeLeases}`,
        profileDirectory,
        update: vi.fn(async () => undefined),
        release,
      };
    });
    const closeChromeTargetWithExactAuthority = vi.fn(async () => ({
      status: "completed" as const,
    }));
    const targets = ["target-first", "target-second"];

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      harvestChatGptTab: vi.fn(async () => readyHarvest),
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({
      acquireManualChromeOwner: vi.fn(async () => {
        const ownerIdentity = processIdentity(53996);
        const exactAuthority = endpointAuthority(53996);
        return {
          chrome: {
            host: "127.0.0.1",
            port: 53996,
            kill: vi.fn(),
            processIdentity: ownerIdentity,
            endpointAuthority: exactAuthority,
          },
          processIdentity: ownerIdentity,
          source: "recorded" as const,
          disposition: "preserve" as const,
          endpointAuthority: exactAuthority,
        };
      }),
      settleManualChromeOwner: settleManualChromeOwnerForTest,
      releaseManualChromeOwnerEndpointAuthority: releaseManualChromeOwnerEndpointAuthorityForTest,
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      connectWithNewTab: vi.fn(),
      closeChromeTargetWithExactAuthority,
      connectWithNewTabWithExactAuthority: vi.fn(async () => {
        const targetId = targets.shift() ?? "unexpected-target";
        return {
          targetId,
          client: {
            Page: {
              enable: vi.fn(async () => undefined),
              navigate: vi.fn(async () => ({ frameId: "frame-1" })),
            },
            close: vi.fn(async () => undefined),
          },
        };
      }),
    }));
    vi.doMock("../../src/browser/tabLeaseRegistry.js", () => ({
      DEFAULT_MAX_CONCURRENT_CHATGPT_TABS: 3,
      normalizeMaxConcurrentTabs: (value: unknown) => Number(value ?? 3),
      acquireBrowserTabLease,
      retainBrowserTabLeaseTeardownAuthority: retainBrowserTabLeaseTeardownAuthorityForTest,
    }));
    vi.doMock("../../src/browser/index.js", () => ({ isImageOnlyUiChromeText: () => false }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    const first = await recoverConversationTab(meta, logger, { readyTimeoutMs: 1 });
    await first.cleanup("finalize");
    const second = await recoverConversationTab(meta, logger, { readyTimeoutMs: 1 });
    await second.cleanup("finalize");

    expect(activeLeases).toBe(0);
    expect(acquireBrowserTabLease).toHaveBeenCalledTimes(2);
    expect(closeChromeTargetWithExactAuthority).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });
});
