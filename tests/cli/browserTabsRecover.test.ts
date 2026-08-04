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
    const cleanup = vi.fn(async () => undefined);
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
    const cleanup = vi.fn(async () => undefined);
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
    const cleanup = vi.fn(async () => undefined);
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
});
