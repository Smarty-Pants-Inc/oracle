import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionStore.js";

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

// Each case dynamically imports the subject after installing isolated module mocks.
describe("browser recovery cleanup", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("awaits recovered-tab cleanup after normal harvest completion", async () => {
    const cleanup = vi.fn(async () => ({ status: "completed" as const }));
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched saved conversation"))
      .mockResolvedValueOnce(completedHarvest);
    const recoverConversationTab = vi.fn(async () => ({
      host: "127.0.0.1",
      port: 53999,
      url: "https://chatgpt.com/c/saved-conversation",
      ref: "recovered-target",
      cleanup,
    }));

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
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: vi.fn(async () => baseMeta),
        updateSession: vi.fn(async () => undefined),
      },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover", { quietOutput: true }),
    ).resolves.toEqual(completedHarvest);

    expect(recoverConversationTab).toHaveBeenCalledWith(baseMeta, expect.any(Function), {
      existingEndpoint: { host: "127.0.0.1", port: 9223 },
    });
    expect(harvestChatGptTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 53999, ref: "recovered-target" }),
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test("awaits recovered-tab cleanup when capture fails after recovery", async () => {
    const cleanup = vi.fn(async () => ({ status: "completed" as const }));
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
      recoverConversationTab: vi.fn(async () => ({
        host: "127.0.0.1",
        port: 53999,
        url: "https://chatgpt.com/c/saved-conversation",
        ref: "recovered-target",
        cleanup,
      })),
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: vi.fn(async () => baseMeta),
        updateSession: vi.fn(async () => undefined),
      },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover", { quietOutput: true }),
    ).rejects.toThrow(/capture failed/);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test("awaits recovered-tab cleanup when live tail fails after recovery", async () => {
    const cleanup = vi.fn(async () => ({ status: "completed" as const }));
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
      recoverConversationTab: vi.fn(async () => ({
        host: "127.0.0.1",
        port: 53999,
        url: "https://chatgpt.com/c/saved-conversation",
        ref: "recovered-target",
        cleanup,
      })),
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: vi.fn(async () => baseMeta),
        updateSession: vi.fn(async () => undefined),
      },
    }));

    const { liveTailSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      liveTailSessionBrowserOutput("sess-recover", { stallThresholdMs: 0 }),
    ).rejects.toThrow(/Recovered ChatGPT conversation did not become ready/);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test("persists exact cleanup authority and fails publication when recovered cleanup is pending", async () => {
    const pendingResource = {
      chromeHost: "127.0.0.1",
      chromePort: 53999,
      userDataDir: "/tmp/recover-profile",
      chromeTargetId: "recovered-target",
      tabLease: {
        id: "lease-recovered",
        profileDirectory: {
          version: 1 as const,
          platform: process.platform,
          canonicalPath: "/tmp/recover-profile",
          device: "1",
          inode: "2",
        },
      },
      recoveryCleanup: {
        ownsTarget: true,
        profileKind: "none" as const,
        keepBrowser: true,
      },
    };
    const cleanup = vi.fn(async () => ({
      status: "pending" as const,
      resource: pendingResource,
      error: "target close was not confirmed",
    }));
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched saved conversation"))
      .mockResolvedValueOnce(completedHarvest);
    const updateSession = vi.fn(async () => undefined);

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
      recoverConversationTab: vi.fn(async () => ({
        host: "127.0.0.1",
        port: 53999,
        url: "https://chatgpt.com/c/saved-conversation",
        ref: "recovered-target",
        cleanup,
      })),
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: vi.fn(async () => baseMeta),
        updateSession,
      },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover", { quietOutput: true }),
    ).rejects.toMatchObject({
      details: {
        stage: "recovered-conversation-cleanup",
        runtime: {
          recoveryCleanupResources: [pendingResource],
          recoveryCleanupResult: {
            status: "failed",
            error: "target close was not confirmed",
          },
        },
      },
    });
    expect(updateSession).toHaveBeenLastCalledWith("sess-recover", {
      browser: expect.objectContaining({
        runtime: expect.objectContaining({
          recoveryCleanupResources: [pendingResource],
        }),
      }),
    });
  });
});
