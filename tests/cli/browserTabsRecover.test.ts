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

describe("harvestSessionBrowserOutput recovery fallback", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("does not inspect the raw default endpoint when session storage fails", async () => {
    const collectChatGptTabs = vi.fn();
    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs,
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "detached",
      harvestChatGptTab: vi.fn(),
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        listSessions: vi.fn().mockRejectedValue(new Error("session store unavailable")),
      },
    }));

    // vi.doMock needs a fresh import so this test observes its isolated module graph.
    const { showBrowserTabsStatus } = await import("../../src/cli/browserTabs.js");
    await expect(showBrowserTabsStatus()).rejects.toThrow(/session store unavailable/);
    expect(collectChatGptTabs).not.toHaveBeenCalled();
  });

  test("recovers directly when a named session has no recorded endpoint", async () => {
    const metaWithoutRuntime = {
      ...baseMeta,
      browser: {
        config: {
          manualLogin: true,
          manualLoginProfileDir: "/tmp/recover-profile",
          url: "https://chatgpt.com/c/saved-conversation",
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
    vi.doMock("../../src/browser/recoverConversation.js", () => ({ recoverConversationTab }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: vi.fn(async () => metaWithoutRuntime),
        updateSession: vi.fn(async () => {}),
      },
    }));

    // vi.doMock needs a fresh import so this test observes its isolated module graph.
    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await harvestSessionBrowserOutput("sess-recover", { quietOutput: true });

    expect(recoverConversationTab).toHaveBeenCalledWith(metaWithoutRuntime, expect.any(Function), {
      existingEndpoint: undefined,
    });
    expect(harvestChatGptTab).toHaveBeenCalledTimes(1);
    expect(harvestChatGptTab).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 53997, ref: "saved-conversation" }),
    );
  });

  test("retries via recoverConversationTab when initial harvest finds no live tab", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('No ChatGPT tab matched "https://chatgpt.com/c/saved-conversation".'),
      )
      .mockResolvedValueOnce(completedHarvest);

    const fakeChrome = { kill: vi.fn(), process: { unref: vi.fn() } };
    const recoverConversationTab = vi.fn(async (meta: SessionMetadata) => ({
      host: "127.0.0.1",
      port: 53999,
      url: meta.browser?.runtime?.tabUrl ?? "",
      ref: "saved-conversation",
      chrome: fakeChrome,
    }));

    const updateSession = vi.fn(async () => {});
    const readSession = vi.fn(async () => baseMeta);

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
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession, updateSession },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const result = await harvestSessionBrowserOutput("sess-recover", { quietOutput: true });

    expect(harvestChatGptTab).toHaveBeenCalledTimes(2);
    expect(recoverConversationTab).toHaveBeenCalledTimes(1);
    expect(recoverConversationTab).toHaveBeenCalledWith(baseMeta, expect.any(Function), {
      existingEndpoint: { host: "127.0.0.1", port: 9223 },
    });
    // After recovery, harvest is retried against the recovered endpoint/url.
    expect(harvestChatGptTab).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 53999,
        ref: "saved-conversation",
      }),
    );
    expect(result.lastAssistantMarkdown).toBe(completedHarvest.lastAssistantMarkdown);
    expect(updateSession).toHaveBeenCalled();
    // Default closeAfterRecover is false — Chrome stays alive for the user.
    expect(fakeChrome.kill).not.toHaveBeenCalled();
    expect(fakeChrome.process.unref).toHaveBeenCalledTimes(1);
  });

  test("does not recover when recoverIfMissing is false; surfaces the original error", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched stuff"));
    const recoverConversationTab = vi.fn();

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
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession: async () => baseMeta, updateSession: async () => {} },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover", { recoverIfMissing: false, quietOutput: true }),
    ).rejects.toThrow(/No ChatGPT tab matched/);
    expect(recoverConversationTab).not.toHaveBeenCalled();
  });

  test("threads bound identity through harvest and live paths without recovery", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    const boundMeta = {
      ...baseMeta,
      browser: {
        config: {
          ...baseMeta.browser!.config,
          remoteChrome: { host: "127.0.0.1", port: 9223 },
          remoteChromeBrowserId: "browser-a",
          remoteChromeBrowserWSEndpoint: browserWSEndpoint,
          remoteChromeAccountDigest: accountDigest,
        },
        runtime: {
          ...baseMeta.browser!.runtime,
          chromeBrowserWSEndpoint: browserWSEndpoint,
          chatGptAccountDigest: accountDigest,
        },
      },
    } as unknown as SessionMetadata;
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValue(
        new Error("Remote Chrome account identity changed before live tab inspection."),
      );
    const recoverConversationTab = vi.fn();
    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => "saved-conversation",
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({ recoverConversationTab }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: vi.fn(async () => boundMeta),
        updateSession: vi.fn(async () => {}),
      },
    }));

    // vi.doMock requires a fresh import so this test observes its isolated module graph.
    const { harvestSessionBrowserOutput, liveTailSessionBrowserOutput } =
      await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover", { quietOutput: true }),
    ).rejects.toThrow(/account identity changed/i);
    await expect(liveTailSessionBrowserOutput("sess-recover")).rejects.toThrow(
      /account identity changed/i,
    );

    expect(recoverConversationTab).not.toHaveBeenCalled();
    expect(harvestChatGptTab).toHaveBeenCalledTimes(2);
    for (const [options] of harvestChatGptTab.mock.calls) {
      expect(options).toMatchObject({
        host: "127.0.0.1",
        port: 9223,
        browserId: "browser-a",
        accountDigest,
        ref: "https://chatgpt.com/c/saved-conversation",
      });
    }
  });

  test.each(["harvest", "live"] as const)(
    "recovers a missing bound tab for the %s path without dropping affinity",
    async (mode) => {
      const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
      const accountDigest = "a".repeat(64);
      const boundMeta = {
        ...baseMeta,
        browser: {
          config: {
            ...baseMeta.browser!.config,
            remoteChrome: { host: "127.0.0.1", port: 9223 },
            remoteChromeBrowserId: "browser-a",
            remoteChromeBrowserWSEndpoint: browserWSEndpoint,
            remoteChromeAccountDigest: accountDigest,
          },
          runtime: {
            ...baseMeta.browser!.runtime,
            chromeBrowserWSEndpoint: browserWSEndpoint,
            chatGptAccountDigest: accountDigest,
          },
        },
      } as unknown as SessionMetadata;
      const harvestChatGptTab = vi
        .fn()
        .mockRejectedValueOnce(
          new Error('No ChatGPT tab matched "https://chatgpt.com/c/saved-conversation".'),
        )
        .mockResolvedValueOnce(completedHarvest);
      const recoverConversationTab = vi.fn(async () => ({
        host: "127.0.0.1",
        port: 9223,
        url: "https://chatgpt.com/c/saved-conversation",
        ref: "recovered-target",
        browserId: "browser-a",
        accountDigest,
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
        recoverConversationTab,
        isRecoveredConversationHarvestReady: () => true,
      }));
      vi.doMock("../../src/sessionStore.js", () => ({
        sessionStore: {
          readSession: vi.fn(async () => boundMeta),
          updateSession: vi.fn(async () => {}),
        },
      }));

      // vi.doMock requires a fresh import so this test observes its isolated module graph.
      const { harvestSessionBrowserOutput, liveTailSessionBrowserOutput } =
        await import("../../src/cli/browserTabs.js");
      const result =
        mode === "harvest"
          ? await harvestSessionBrowserOutput("sess-recover", { quietOutput: true })
          : await liveTailSessionBrowserOutput("sess-recover");

      expect(result.lastAssistantMarkdown).toBe(completedHarvest.lastAssistantMarkdown);
      expect(recoverConversationTab).toHaveBeenCalledWith(
        boundMeta,
        expect.any(Function),
        expect.objectContaining({
          existingEndpoint: {
            host: "127.0.0.1",
            port: 9223,
            browserId: "browser-a",
            accountDigest,
          },
        }),
      );
      expect(harvestChatGptTab).toHaveBeenLastCalledWith(
        expect.objectContaining({
          host: "127.0.0.1",
          port: 9223,
          browserId: "browser-a",
          accountDigest,
          ref: "recovered-target",
        }),
      );
    },
  );

  test("recovers when the endpoint has no live ChatGPT tabs", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("No live ChatGPT tabs found on the configured Chrome DevTools endpoint."),
      )
      .mockResolvedValueOnce(completedHarvest);

    const recoverConversationTab = vi.fn(async () => ({
      host: "127.0.0.1",
      port: 53998,
      url: "https://chatgpt.com/c/saved-conversation",
      ref: "saved-conversation",
      chrome: { kill: vi.fn() },
    }));

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
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession: async () => baseMeta, updateSession: async () => {} },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await harvestSessionBrowserOutput("sess-recover", { quietOutput: true });

    expect(recoverConversationTab).toHaveBeenCalledTimes(1);
    expect(harvestChatGptTab).toHaveBeenCalledTimes(2);
  });

  test("closes the recovered Chrome when closeAfterRecover is true", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched"))
      .mockResolvedValueOnce(completedHarvest);
    const fakeChrome = { kill: vi.fn(), process: { unref: vi.fn() } };
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
      recoverConversationTab: vi.fn(async () => ({
        host: "127.0.0.1",
        port: 53777,
        url: "https://chatgpt.com/c/saved-conversation",
        ref: "saved-conversation",
        chrome: fakeChrome,
      })),
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession: async () => baseMeta, updateSession: async () => {} },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await harvestSessionBrowserOutput("sess-recover", {
      closeAfterRecover: true,
      quietOutput: true,
    });
    expect(fakeChrome.kill).toHaveBeenCalledTimes(1);
    expect(fakeChrome.process.unref).not.toHaveBeenCalled();
  });

  test("does not recover an explicit browser tab override", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched explicit-ref"));
    const recoverConversationTab = vi.fn();

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
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession: async () => baseMeta, updateSession: async () => {} },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover", {
        browserTabRef: "explicit-ref",
        quietOutput: true,
      }),
    ).rejects.toThrow(/explicit-ref/);
    expect(recoverConversationTab).not.toHaveBeenCalled();
  });
});
