import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionStore.js";

const meta = {
  id: "sess-recover",
  mode: "browser",
  browser: {
    config: {
      manualLogin: true,
      manualLoginProfileDir: "/tmp/recover-profile",
    },
    runtime: {
      tabUrl: "https://chatgpt.com/c/saved-conversation",
    },
  },
} as unknown as SessionMetadata;

const readyHarvest = {
  authenticated: true,
  assistantCount: 1,
  assistantFollowsLatestUser: true,
  lastAssistantTurnIndex: 1,
  lastUserTurnIndex: 0,
  stopExists: false,
  lastAssistantText: "Recovered answer",
  lastAssistantMarkdown: "Recovered answer",
  lastAssistantSnippet: "Recovered answer",
  state: "completed",
  url: "https://chatgpt.com/c/saved-conversation",
  conversationId: "saved-conversation",
};
const logger = (_message: string) => {};

describe("recoverConversationTab flow", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("opens the saved URL in an existing Chrome endpoint before launching another profile", async () => {
    const openChatGptTarget = vi.fn(async () => "target-1");
    const harvestChatGptTab = vi.fn(async () => readyHarvest);
    const acquireManualLoginChromeForRun = vi.fn();

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget,
      harvestChatGptTab,
    }));
    vi.doMock("../../src/browser/index.js", () => ({
      acquireManualLoginChromeForRun,
      isImageOnlyUiChromeText: () => false,
    }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    const recovered = await recoverConversationTab(meta, logger, {
      existingEndpoint: { host: "127.0.0.1", port: 9222 },
      readyTimeoutMs: 1,
    });

    expect(openChatGptTarget).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      url: "https://chatgpt.com/c/saved-conversation",
    });
    expect(harvestChatGptTab).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      ref: "target-1",
      expectedConversationId: "saved-conversation",
    });
    expect(acquireManualLoginChromeForRun).not.toHaveBeenCalled();
    expect(recovered.ref).toBe("target-1");
    expect(recovered.chrome).toBeNull();
  });

  test("reopens a missing bound tab only after browser and account verification", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    const openChatGptTarget = vi.fn(async () => "target-bound");
    const harvestChatGptTab = vi.fn(async () => readyHarvest);
    const navigate = vi.fn(async () => ({}));
    const close = vi.fn(async () => undefined);
    const closeTab = vi.fn(async () => true);
    const acquireManualLoginChromeForRun = vi.fn();
    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget,
      harvestChatGptTab,
    }));
    vi.doMock("../../src/browser/index.js", () => ({
      acquireManualLoginChromeForRun,
      isImageOnlyUiChromeText: () => false,
    }));
    vi.doMock("../../src/browser/profileState.js", () => ({
      resolveRemoteChromeBrowserIdentity: vi.fn(async () => ({
        browserId: "browser-a",
        browserWSEndpoint,
      })),
    }));
    vi.doMock("../../src/browser/pageActions.js", () => ({
      readChatGptAccountDigest: vi.fn(async () => accountDigest),
    }));
    const connectToRemoteChromeTarget = vi.fn(async () => ({
      client: {
        Page: { enable: vi.fn(async () => ({})), navigate },
        Runtime: { enable: vi.fn(async () => ({})) },
      },
      close,
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      closeTab,
      connectToRemoteChromeTarget,
    }));

    // vi.doMock requires a fresh import so this test observes its isolated module graph.
    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    const recovered = await recoverConversationTab(meta, logger, {
      existingEndpoint: {
        host: "127.0.0.1",
        port: 9223,
        browserId: "browser-a",
        accountDigest,
      },
      readyTimeoutMs: 1,
    });

    expect(openChatGptTarget).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9223,
      browserWSEndpoint,
      url: "https://chatgpt.com/",
    });
    expect(connectToRemoteChromeTarget).toHaveBeenCalledWith(
      "127.0.0.1",
      9223,
      logger,
      expect.objectContaining({ browserWSEndpoint, targetId: "target-bound" }),
    );
    expect(navigate).toHaveBeenCalledWith({ url: "https://chatgpt.com/c/saved-conversation" });
    expect(harvestChatGptTab).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9223,
      browserId: "browser-a",
      accountDigest,
      ref: "target-bound",
      expectedConversationId: "saved-conversation",
    });
    expect(recovered).toMatchObject({ browserId: "browser-a", accountDigest });
    expect(acquireManualLoginChromeForRun).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(closeTab).not.toHaveBeenCalled();
  });

  test("does not fall back to another profile after a bound account mismatch", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    const acquireManualLoginChromeForRun = vi.fn();
    const closeTab = vi.fn(async () => true);
    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget: vi.fn(async () => "target-bound"),
      harvestChatGptTab: vi.fn(),
    }));
    vi.doMock("../../src/browser/index.js", () => ({
      acquireManualLoginChromeForRun,
      isImageOnlyUiChromeText: () => false,
    }));
    vi.doMock("../../src/browser/profileState.js", () => ({
      resolveRemoteChromeBrowserIdentity: vi.fn(async () => ({
        browserId: "browser-a",
        browserWSEndpoint,
      })),
    }));
    vi.doMock("../../src/browser/pageActions.js", () => ({
      readChatGptAccountDigest: vi.fn(async () => "b".repeat(64)),
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      closeTab,
      connectToRemoteChromeTarget: vi.fn(async () => ({
        client: {
          Page: { enable: vi.fn(async () => ({})), navigate: vi.fn() },
          Runtime: { enable: vi.fn(async () => ({})) },
        },
        close: vi.fn(async () => undefined),
      })),
    }));

    // vi.doMock requires a fresh import so this test observes its isolated module graph.
    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    await expect(
      recoverConversationTab(meta, logger, {
        existingEndpoint: {
          host: "127.0.0.1",
          port: 9223,
          browserId: "browser-a",
          accountDigest,
        },
        waitForReady: false,
      }),
    ).rejects.toThrow(/account identity changed before conversation recovery/i);
    expect(acquireManualLoginChromeForRun).not.toHaveBeenCalled();
    expect(closeTab).toHaveBeenCalledWith(9223, "target-bound", logger, "127.0.0.1");
  });

  test("closes a newly opened bound target when attachment setup fails", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    const acquireManualLoginChromeForRun = vi.fn();
    const closeTab = vi.fn(async () => true);
    const connectToRemoteChromeTarget = vi.fn(async () => {
      throw new Error("target attach failed");
    });
    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget: vi.fn(async () => "target-bound"),
      harvestChatGptTab: vi.fn(),
    }));
    vi.doMock("../../src/browser/index.js", () => ({
      acquireManualLoginChromeForRun,
      isImageOnlyUiChromeText: () => false,
    }));
    vi.doMock("../../src/browser/profileState.js", () => ({
      resolveRemoteChromeBrowserIdentity: vi.fn(async () => ({
        browserId: "browser-a",
        browserWSEndpoint,
      })),
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      closeTab,
      connectToRemoteChromeTarget,
    }));

    // vi.doMock requires a fresh import so this test observes its isolated module graph.
    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    await expect(
      recoverConversationTab(meta, logger, {
        existingEndpoint: {
          host: "127.0.0.1",
          port: 9223,
          browserId: "browser-a",
          accountDigest,
        },
        waitForReady: false,
      }),
    ).rejects.toThrow(/target attach failed/i);

    expect(closeTab).toHaveBeenCalledWith(9223, "target-bound", logger, "127.0.0.1");
    expect(acquireManualLoginChromeForRun).not.toHaveBeenCalled();
  });

  test("rejects a wrong final conversation and cleans the opened bound target", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9223/devtools/browser/browser-a";
    const accountDigest = "a".repeat(64);
    const close = vi.fn(async () => undefined);
    const closeTab = vi.fn(async () => true);
    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : undefined,
      openChatGptTarget: vi.fn(async () => "target-bound"),
      harvestChatGptTab: vi.fn(async () => ({
        ...readyHarvest,
        url: "https://chatgpt.com/c/different-conversation",
        conversationId: "different-conversation",
      })),
    }));
    vi.doMock("../../src/browser/index.js", () => ({
      acquireManualLoginChromeForRun: vi.fn(),
      isImageOnlyUiChromeText: () => false,
    }));
    vi.doMock("../../src/browser/profileState.js", () => ({
      resolveRemoteChromeBrowserIdentity: vi.fn(async () => ({
        browserId: "browser-a",
        browserWSEndpoint,
      })),
    }));
    vi.doMock("../../src/browser/pageActions.js", () => ({
      readChatGptAccountDigest: vi.fn(async () => accountDigest),
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      closeTab,
      connectToRemoteChromeTarget: vi.fn(async () => ({
        client: {
          Page: { enable: vi.fn(async () => ({})), navigate: vi.fn(async () => ({})) },
          Runtime: { enable: vi.fn(async () => ({})) },
        },
        close,
      })),
    }));

    // vi.doMock requires a fresh import so this test observes its isolated module graph.
    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    await expect(
      recoverConversationTab(meta, logger, {
        existingEndpoint: {
          host: "127.0.0.1",
          port: 9223,
          browserId: "browser-a",
          accountDigest,
        },
        readyTimeoutMs: 1,
      }),
    ).rejects.toThrow(/conversation changed before recovery completed/i);

    expect(close).toHaveBeenCalledOnce();
    expect(closeTab).toHaveBeenCalledWith(9223, "target-bound", logger, "127.0.0.1");
  });

  test("launches the stored manual-login profile when the existing endpoint is gone", async () => {
    const openChatGptTarget = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce("target-2");
    const harvestChatGptTab = vi.fn(async () => readyHarvest);
    const chrome = { port: 53999, kill: vi.fn(), process: { unref: vi.fn() } };
    const acquireManualLoginChromeForRun = vi.fn(async () => ({ chrome }));

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget,
      harvestChatGptTab,
    }));
    vi.doMock("../../src/browser/index.js", () => ({
      acquireManualLoginChromeForRun,
      isImageOnlyUiChromeText: () => false,
    }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    const recovered = await recoverConversationTab(meta, logger, {
      existingEndpoint: { host: "127.0.0.1", port: 9222 },
      readyTimeoutMs: 1,
    });

    expect(acquireManualLoginChromeForRun).toHaveBeenCalledWith(
      "/tmp/recover-profile",
      expect.objectContaining({ manualLogin: true }),
      logger,
      "sess-recover",
      {},
    );
    expect(harvestChatGptTab).toHaveBeenLastCalledWith({
      host: "127.0.0.1",
      port: 53999,
      ref: "target-2",
      expectedConversationId: "saved-conversation",
    });
    expect(recovered.ref).toBe("target-2");
    expect(recovered.chrome).toBe(chrome);
  });

  test("does not require a local profile when reopening through a recorded endpoint", async () => {
    const openChatGptTarget = vi.fn(async () => "target-1");
    const harvestChatGptTab = vi.fn(async () => readyHarvest);
    const acquireManualLoginChromeForRun = vi.fn();
    const remoteMeta = {
      ...meta,
      browser: {
        config: {},
        runtime: {
          tabUrl: "https://chatgpt.com/c/saved-conversation",
          chromeHost: "127.0.0.1",
          chromePort: 9222,
        },
      },
    } as unknown as SessionMetadata;

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget,
      harvestChatGptTab,
    }));
    vi.doMock("../../src/browser/index.js", () => ({
      acquireManualLoginChromeForRun,
      isImageOnlyUiChromeText: () => false,
    }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    const recovered = await recoverConversationTab(remoteMeta, logger, {
      existingEndpoint: { host: "127.0.0.1", port: 9222 },
      readyTimeoutMs: 1,
    });

    expect(recovered.chrome).toBeNull();
    expect(acquireManualLoginChromeForRun).not.toHaveBeenCalled();
  });

  test("closes the newly opened target and kills launched Chrome when recovery never becomes ready", async () => {
    const openChatGptTarget = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce("target-2");
    const harvestChatGptTab = vi.fn();
    const chrome = { port: 53999, kill: vi.fn(), process: { unref: vi.fn() } };
    const acquireManualLoginChromeForRun = vi.fn(async () => ({ chrome }));
    const closeTab = vi.fn(async () => true);

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget,
      harvestChatGptTab,
    }));
    vi.doMock("../../src/browser/index.js", () => ({
      acquireManualLoginChromeForRun,
      isImageOnlyUiChromeText: () => false,
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
      closeTab,
      connectToRemoteChromeTarget: vi.fn(),
    }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    await expect(
      recoverConversationTab(meta, logger, {
        existingEndpoint: { host: "127.0.0.1", port: 9222 },
        readyTimeoutMs: 0,
      }),
    ).rejects.toThrow(/did not become ready/);

    expect(chrome.kill).toHaveBeenCalledTimes(1);
    expect(closeTab).toHaveBeenCalledWith(53999, "target-2", logger, "127.0.0.1");
  });

  test("kills launched Chrome when opening the recovery target fails", async () => {
    const openChatGptTarget = vi.fn(async () => {
      throw new Error("CDP.New failed");
    });
    const chrome = { port: 53999, kill: vi.fn(), process: { unref: vi.fn() } };
    const acquireManualLoginChromeForRun = vi.fn(async () => ({ chrome }));

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget,
      harvestChatGptTab: vi.fn(),
    }));
    vi.doMock("../../src/browser/index.js", () => ({
      acquireManualLoginChromeForRun,
      isImageOnlyUiChromeText: () => false,
    }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    await expect(
      recoverConversationTab(meta, logger, {
        readyTimeoutMs: 1,
      }),
    ).rejects.toThrow(/CDP.New failed/);

    expect(chrome.kill).toHaveBeenCalledTimes(1);
  });
});
