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
};
const logger = (_message: string) => {};

// Dynamic imports are required because each case installs isolated module mocks after resetModules.

describe("recoverConversationTab flow", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("opens the saved URL in an existing Chrome endpoint before launching another profile", async () => {
    const openChatGptTarget = vi.fn(async () => "target-1");
    const harvestChatGptTab = vi.fn(async () => readyHarvest);
    const acquireManualChromeOwner = vi.fn();

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget,
      harvestChatGptTab,
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({ acquireManualChromeOwner }));
    vi.doMock("../../src/browser/index.js", () => ({
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
    });
    expect(acquireManualChromeOwner).not.toHaveBeenCalled();
    expect(recovered.ref).toBe("target-1");
    expect(recovered.chrome).toBeNull();
  });

  test("launches the stored manual-login profile when the existing endpoint is gone", async () => {
    const openChatGptTarget = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce("target-2");
    const harvestChatGptTab = vi.fn(async () => readyHarvest);
    const chrome = {
      port: 53999,
      kill: vi.fn(async () => undefined),
      process: { unref: vi.fn() },
    };
    const acquireManualChromeOwner = vi.fn(async () => ({
      chrome,
      source: "launched" as const,
    }));

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget,
      harvestChatGptTab,
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({ acquireManualChromeOwner }));
    vi.doMock("../../src/browser/index.js", () => ({
      isImageOnlyUiChromeText: () => false,
    }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    const recovered = await recoverConversationTab(meta, logger, {
      existingEndpoint: { host: "127.0.0.1", port: 9222 },
      readyTimeoutMs: 1,
    });

    expect(acquireManualChromeOwner).toHaveBeenCalledWith(
      "/tmp/recover-profile",
      expect.objectContaining({ manualLogin: true }),
      logger,
      "sess-recover",
    );
    expect(harvestChatGptTab).toHaveBeenLastCalledWith({
      host: "127.0.0.1",
      port: 53999,
      ref: "target-2",
    });
    expect(recovered.ref).toBe("target-2");
    expect(recovered.chrome).toBe(chrome);
  });

  test("does not require a local profile when reopening through a recorded endpoint", async () => {
    const openChatGptTarget = vi.fn(async () => "target-1");
    const harvestChatGptTab = vi.fn(async () => readyHarvest);
    const acquireManualChromeOwner = vi.fn();
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
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({ acquireManualChromeOwner }));
    vi.doMock("../../src/browser/index.js", () => ({
      isImageOnlyUiChromeText: () => false,
    }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    const recovered = await recoverConversationTab(remoteMeta, logger, {
      existingEndpoint: { host: "127.0.0.1", port: 9222 },
      readyTimeoutMs: 1,
    });

    expect(recovered.chrome).toBeNull();
    expect(acquireManualChromeOwner).not.toHaveBeenCalled();
  });

  test("kills launched Chrome when recovered content never becomes ready", async () => {
    const openChatGptTarget = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce("target-2");
    const harvestChatGptTab = vi.fn();
    const chrome = {
      port: 53999,
      kill: vi.fn(async () => undefined),
      process: { unref: vi.fn() },
    };
    const acquireManualChromeOwner = vi.fn(async () => ({
      chrome,
      source: "launched" as const,
    }));

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget,
      harvestChatGptTab,
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({ acquireManualChromeOwner }));
    vi.doMock("../../src/browser/index.js", () => ({
      isImageOnlyUiChromeText: () => false,
    }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    await expect(
      recoverConversationTab(meta, logger, {
        existingEndpoint: { host: "127.0.0.1", port: 9222 },
        readyTimeoutMs: 0,
      }),
    ).rejects.toThrow(/did not become ready/);

    expect(chrome.kill).toHaveBeenCalledTimes(1);
  });

  test("kills launched Chrome when opening the recovery target fails", async () => {
    const openChatGptTarget = vi.fn(async () => {
      throw new Error("CDP.New failed");
    });
    const chrome = {
      port: 53999,
      kill: vi.fn(async () => undefined),
      process: { unref: vi.fn() },
    };
    const acquireManualChromeOwner = vi.fn(async () => ({
      chrome,
      source: "launched" as const,
    }));

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget,
      harvestChatGptTab: vi.fn(),
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({ acquireManualChromeOwner }));
    vi.doMock("../../src/browser/index.js", () => ({
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

  test("does not terminate a reused Chrome owner when recovery target opening fails", async () => {
    const openChatGptTarget = vi.fn(async () => {
      throw new Error("CDP.New failed");
    });
    const chrome = {
      port: 53999,
      kill: vi.fn(async () => undefined),
      process: undefined,
    };
    const acquireManualChromeOwner = vi.fn(async () => ({
      chrome,
      source: "active-port" as const,
    }));

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget,
      harvestChatGptTab: vi.fn(),
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({ acquireManualChromeOwner }));
    vi.doMock("../../src/browser/index.js", () => ({
      isImageOnlyUiChromeText: () => false,
    }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    await expect(recoverConversationTab(meta, logger, { readyTimeoutMs: 1 })).rejects.toThrow(
      /CDP.New failed/,
    );

    expect(chrome.kill).not.toHaveBeenCalled();
  });
});
