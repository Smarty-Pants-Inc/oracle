import { beforeEach, describe, expect, test, vi } from "vitest";
import type { BrowserRuntimeMetadata, SessionMetadata } from "../../src/sessionStore.js";

const baseMeta = {
  id: "sess-recover",
  createdAt: "2026-05-26T00:00:00.000Z",
  status: "completed",
  options: {},
  mode: "browser",
  cwd: "/tmp/recover-cwd",
  browser: {
    config: {
      manualLogin: true,
      manualLoginProfileDir: "/tmp/recover-profile",
    },
    runtime: {
      chromeHost: "127.0.0.1",
      chromePort: 9223,
      tabUrl: "https://chatgpt.com/c/saved-conversation",
      conversationId: "saved-conversation",
      promptEpoch: {
        status: "committed",
        epochId: "epoch-saved-conversation",
        promptSha256: "a".repeat(64),
        baselineTurns: 0,
        followUpOrdinal: 0,
        remainingFollowUps: 0,
        verifiedUserTurnIndex: 0,
        conversationId: "saved-conversation",
        verifiedUserTurnId: "turn-0",
        verifiedUserMessageId: "message-0",
      },
    },
  },
} as unknown as SessionMetadata;

const completedHarvest = {
  targetId: "target-x",
  url: "https://chatgpt.com/c/saved-conversation",
  conversationId: "saved-conversation",
  state: "completed",
  authenticated: true,
  stopExists: false,
  sendExists: true,
  assistantCount: 1,
  currentModelLabel: "GPT-5.5 Pro",
  assistantFollowsLatestUser: true,
  lastAssistantTurnIndex: 1,
  lastUserTurnIndex: 0,
  lastUserText: "original prompt",
  lastUserTurnId: "turn-0",
  lastUserMessageId: "message-0",
  lastAssistantMarkdown: "## Recovered answer\n\nFull response captured.",
  lastAssistantText: "Recovered answer. Full response captured.",
  lastAssistantSnippet: "Recovered answer.",
  lastUserSnippet: "original prompt",
} as const;

const recoveredCleanupResource = {
  chromeHost: "127.0.0.1",
  chromePort: 53999,
  userDataDir: "/tmp/recover-profile",
  chromeTargetId: "recovered-target",
  tabLease: {
    id: "lease-recovered",
    profileDirectory: {
      version: 2 as const,
      platform: process.platform,
      canonicalPath: "/tmp/recover-profile",
      device: "1",
      inode: "2",
      birthtimeNs: "3",
    },
  },
  recoveryCleanup: {
    ownsTarget: true,
    profileKind: "none" as const,
    keepBrowser: true,
    closeOwnedTargetOnComplete: true,
  },
};

const recoveredRuntime: BrowserRuntimeMetadata = {
  ...(baseMeta.browser?.runtime ?? {}),
  chromeHost: "127.0.0.1",
  chromePort: 53999,
  chromeTargetId: "recovered-target",
  recoveryCleanupResources: [recoveredCleanupResource],
  recoveryCleanupResult: { status: "pending" },
};

const recoveredEndpointAuthority = {
  browserWSEndpoint: "ws://127.0.0.1:53999/devtools/browser/generation-a",
  kill: vi.fn(),
  runExactOperation: vi.fn(),
  release: vi.fn(),
};

function completedCleanupRuntime(runtime: BrowserRuntimeMetadata): BrowserRuntimeMetadata {
  const completed = { ...runtime };
  delete completed.recoveryCleanupResources;
  delete completed.chromeTargetId;
  delete completed.recoveryCleanupResult;
  return completed;
}

function createSessionStoreFixture() {
  let current = baseMeta;
  const readSession = vi.fn(async () => current);
  const updateSession = vi.fn(async (_sessionId: string, patch: Partial<SessionMetadata>) => {
    current = { ...current, ...patch } as SessionMetadata;
  });
  return { readSession, updateSession };
}

// Each case dynamically imports the subject after installing isolated module mocks.
describe("browser recovery cleanup", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test.each(["harvest", "live"] as const)(
    "rejects %s before probing local Chrome for a persisted remote transaction",
    async (mode) => {
      const collectChatGptTabs = vi.fn();
      const harvestChatGptTab = vi.fn();
      const recoverConversationTab = vi.fn();
      vi.doMock("../../src/browser/liveTabs.js", () => ({
        collectChatGptTabs,
        DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
        DEFAULT_REMOTE_CHROME_PORT: 9222,
        extractConversationIdFromUrl: vi.fn(),
        formatBrowserTabState: vi.fn(),
        harvestChatGptTab,
        sessionMatchesTab: vi.fn(),
      }));
      vi.doMock("../../src/browser/recoverConversation.js", () => ({
        isRecoveredConversationHarvestReady: vi.fn(),
        recoveredConversationHarvestMatchesPromptEpoch: vi.fn(),
        recoverConversationTab,
      }));
      const remoteMeta = {
        ...baseMeta,
        status: "error",
        browser: {
          config: {},
          runtime: {
            recoveryCleanupResources: [
              {
                remoteRecovery: {
                  protocolVersion: 3,
                  host: "127.0.0.1:9443",
                  transactionToken: "b".repeat(64),
                  state: "pre-receipt",
                  requestIdentity: {
                    acceptedPromptSha256: ["c".repeat(64)],
                    followUpOrdinal: 0,
                    remainingFollowUps: 0,
                  },
                },
                recoveryCleanup: { ownsTarget: false, profileKind: "none", keepBrowser: false },
              },
            ],
          },
        },
      } as unknown as SessionMetadata;
      vi.doMock("../../src/sessionStore.js", () => ({
        sessionStore: {
          readSession: vi.fn(async () => remoteMeta),
        },
      }));

      const browserTabs = await import("../../src/cli/browserTabs.js");
      const operation =
        mode === "harvest"
          ? browserTabs.harvestSessionBrowserOutput("sess-recover", { quietOutput: true })
          : browserTabs.liveTailSessionBrowserOutput("sess-recover", { stallThresholdMs: 0 });

      await expect(operation).rejects.toMatchObject({
        message: expect.stringContaining(
          'oracle session "sess-recover" --remote-host "127.0.0.1:9443" --remote-token <64-lowercase-hex>',
        ),
        details: {
          stage: "remote-session-recovery",
          code: "remote-browser-tab-probe-rejected",
          recoverableDisconnect: true,
        },
      });
      expect(collectChatGptTabs).not.toHaveBeenCalled();
      expect(harvestChatGptTab).not.toHaveBeenCalled();
      expect(recoverConversationTab).not.toHaveBeenCalled();
    },
  );

  test("recovers directly when a named session has no recorded endpoint", async () => {
    const metaWithoutRuntime = {
      ...baseMeta,
      browser: {
        config: {
          manualLogin: true,
          manualLoginProfileDir: "/tmp/recover-profile",
          url: "https://chatgpt.com/c/saved-conversation",
        },
        runtime: {
          promptEpoch: baseMeta.browser?.runtime?.promptEpoch,
        },
      },
    } as unknown as SessionMetadata;
    const harvestChatGptTab = vi.fn().mockResolvedValue(completedHarvest);
    const recoverConversationTab = vi.fn(async () => ({
      host: "127.0.0.1",
      port: 53997,
      url: "https://chatgpt.com/c/saved-conversation",
      ref: "saved-conversation",
      chrome: null,
    }));

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => "saved-conversation",
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      isRecoveredConversationHarvestReady: vi.fn(),
      recoveredConversationHarvestMatchesPromptEpoch: vi.fn(() => true),
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: vi.fn(async () => metaWithoutRuntime),
        updateSession: vi.fn(async () => {}),
      },
    }));

    // vi.doMock needs a fresh import so this test observes its isolated module graph.
    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await harvestSessionBrowserOutput("sess-recover", { quietOutput: true });

    expect(recoverConversationTab).toHaveBeenCalledWith(
      metaWithoutRuntime,
      expect.any(Function),
      expect.objectContaining({
        loadRuntimeUnderLock: expect.any(Function),
        persistRuntime: expect.any(Function),
      }),
    );
    expect(harvestChatGptTab).toHaveBeenCalledTimes(1);
    expect(harvestChatGptTab).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 53997, ref: "saved-conversation" }),
    );
  });

  test("retries via recoverConversationTab when initial harvest finds no live tab", async () => {
    const cleanup = vi.fn(async (mode: string, runtime: BrowserRuntimeMetadata) => {
      expect(mode).toBe("finalize");
      expect(runtime).toMatchObject({
        recoveryCleanupResources: [recoveredCleanupResource],
        recoveryCleanupResult: { status: "pending" },
      });
      return { status: "completed" as const, runtime: completedCleanupRuntime(runtime) };
    });
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched saved conversation"))
      .mockResolvedValueOnce(completedHarvest);
    const recoverConversationTab = vi.fn(
      async (
        _meta: SessionMetadata,
        _logger: unknown,
        options: { persistRuntime?: (runtime: BrowserRuntimeMetadata) => Promise<void> },
      ) => {
        await options.persistRuntime?.(recoveredRuntime);
        return {
          host: "127.0.0.1",
          port: 53999,
          url: "https://chatgpt.com/c/saved-conversation",
          ref: "recovered-target",
          endpointAuthority: recoveredEndpointAuthority,
          cleanup,
        };
      },
    );

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      isRecoveredConversationHarvestReady: vi.fn(() => true),
      recoveredConversationHarvestMatchesPromptEpoch: vi.fn(() => true),
      recoverConversationTab,
    }));
    const store = createSessionStoreFixture();
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: store,
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover", { quietOutput: true }),
    ).resolves.toEqual(completedHarvest);

    expect(recoverConversationTab).toHaveBeenCalledWith(baseMeta, expect.any(Function), {
      loadRuntimeUnderLock: expect.any(Function),
      persistRuntime: expect.any(Function),
    });
    expect(harvestChatGptTab).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 53999,
        ref: "recovered-target",
        endpointAuthority: recoveredEndpointAuthority,
      }),
    );
    expect(cleanup).toHaveBeenCalledWith(
      "finalize",
      expect.objectContaining({
        recoveryCleanupResources: [recoveredCleanupResource],
        recoveryCleanupResult: { status: "pending" },
      }),
    );
  });

  test("awaits recovered-tab cleanup when capture fails after recovery", async () => {
    const cleanup = vi.fn(async (mode: string, runtime: BrowserRuntimeMetadata) => {
      expect(mode).toBe("abort");
      expect(runtime).toMatchObject({
        recoveryCleanupResources: [recoveredCleanupResource],
        recoveryCleanupResult: { status: "pending" },
      });
      return { status: "completed" as const, runtime: completedCleanupRuntime(runtime) };
    });
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched saved conversation"))
      .mockRejectedValueOnce(new Error("capture failed"));

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      isRecoveredConversationHarvestReady: vi.fn(() => true),
      recoveredConversationHarvestMatchesPromptEpoch: vi.fn(() => true),
      recoverConversationTab: vi.fn(
        async (
          _meta: SessionMetadata,
          _logger: unknown,
          options: { persistRuntime?: (runtime: BrowserRuntimeMetadata) => Promise<void> },
        ) => {
          await options.persistRuntime?.(recoveredRuntime);
          return {
            host: "127.0.0.1",
            port: 53999,
            url: "https://chatgpt.com/c/saved-conversation",
            ref: "recovered-target",
            endpointAuthority: recoveredEndpointAuthority,
            cleanup,
          };
        },
      ),
    }));
    const store = createSessionStoreFixture();
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: store,
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover", { quietOutput: true }),
    ).rejects.toThrow(/capture failed/);
    expect(cleanup).toHaveBeenCalledWith("abort", expect.any(Object));
  });

  test("awaits recovered-tab cleanup when live tail fails after recovery", async () => {
    const cleanup = vi.fn(async (mode: string, runtime: BrowserRuntimeMetadata) => {
      expect(mode).toBe("abort");
      expect(runtime).toMatchObject({
        recoveryCleanupResources: [recoveredCleanupResource],
        recoveryCleanupResult: { status: "pending" },
      });
      return { status: "completed" as const, runtime: completedCleanupRuntime(runtime) };
    });
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched saved conversation"))
      .mockResolvedValueOnce({ ...completedHarvest, state: "running", stopExists: true });

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "running",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      isRecoveredConversationHarvestReady: vi.fn(() => false),
      recoveredConversationHarvestMatchesPromptEpoch: vi.fn(() => true),
      recoverConversationTab: vi.fn(
        async (
          _meta: SessionMetadata,
          _logger: unknown,
          options: { persistRuntime?: (runtime: BrowserRuntimeMetadata) => Promise<void> },
        ) => {
          await options.persistRuntime?.(recoveredRuntime);
          return {
            host: "127.0.0.1",
            port: 53999,
            url: "https://chatgpt.com/c/saved-conversation",
            ref: "recovered-target",
            endpointAuthority: recoveredEndpointAuthority,
            cleanup,
          };
        },
      ),
    }));
    const store = createSessionStoreFixture();
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: store,
    }));

    const { liveTailSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      liveTailSessionBrowserOutput("sess-recover", { stallThresholdMs: 0 }),
    ).rejects.toThrow(/Recovered ChatGPT conversation did not become ready/);
    expect(cleanup).toHaveBeenCalledWith("abort", expect.any(Object));
  });

  test("persists exact cleanup authority and fails publication when recovered cleanup is pending", async () => {
    const cleanup = vi.fn(async (_mode: string, pendingRuntime: BrowserRuntimeMetadata) => ({
      status: "pending" as const,
      runtime: {
        ...pendingRuntime,
        recoveryCleanupResources: [recoveredCleanupResource],
        recoveryCleanupResult: {
          status: "failed" as const,
          error: "target close was not confirmed",
          settlementMode: "finalize" as const,
        },
      },
      error: "target close was not confirmed",
    }));
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched saved conversation"))
      .mockResolvedValueOnce(completedHarvest);
    const store = createSessionStoreFixture();
    const { updateSession } = store;

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      isRecoveredConversationHarvestReady: vi.fn(() => true),
      recoveredConversationHarvestMatchesPromptEpoch: vi.fn(() => true),
      recoverConversationTab: vi.fn(
        async (
          _meta: SessionMetadata,
          _logger: unknown,
          options: { persistRuntime?: (runtime: BrowserRuntimeMetadata) => Promise<void> },
        ) => {
          await options.persistRuntime?.(recoveredRuntime);
          return {
            host: "127.0.0.1",
            port: 53999,
            url: "https://chatgpt.com/c/saved-conversation",
            ref: "recovered-target",
            endpointAuthority: recoveredEndpointAuthority,
            cleanup,
          };
        },
      ),
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: store,
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover", { quietOutput: true }),
    ).rejects.toMatchObject({
      details: {
        stage: "recovered-conversation-cleanup",
        runtime: {
          recoveryCleanupResources: [recoveredCleanupResource],
          recoveryCleanupResult: {
            status: "failed",
            error: "target close was not confirmed",
            settlementMode: "finalize",
          },
        },
      },
    });
    expect(updateSession).toHaveBeenLastCalledWith("sess-recover", {
      browser: expect.objectContaining({
        runtime: expect.objectContaining({
          recoveryCleanupResources: [recoveredCleanupResource],
        }),
      }),
    });
  });
});
