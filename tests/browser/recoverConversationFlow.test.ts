import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionStore.js";

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
// Each case dynamically imports the subject after installing isolated module mocks.
const logger = (_message: string) => {};

describe("recoverConversationTab lease ownership", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("leases before reusing a process-less canonical Chrome owner and cleans the owned target once", async () => {
    const events: string[] = [];
    const openChatGptTarget = vi.fn(async () => "target-reused");
    const acquireBrowserTabLease = vi.fn(async () => {
      events.push("lease");
      return {
        id: "lease-reused",
        update: vi.fn(async () => events.push("update")),
        release: vi.fn(async () => events.push("release")),
      };
    });
    const closeChromeTarget = vi.fn(async () => {
      events.push("close");
      return true;
    });
    const chrome = { host: "127.0.0.1", port: 53999, kill: vi.fn(), process: undefined };
    const acquireManualChromeOwner = vi.fn(async () => {
      events.push("owner");
      return { chrome, source: "active-port" as const };
    });

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget,
      harvestChatGptTab: vi.fn(async () => readyHarvest),
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({ acquireManualChromeOwner }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({ closeChromeTarget }));
    vi.doMock("../../src/browser/tabLeaseRegistry.js", () => ({
      DEFAULT_MAX_CONCURRENT_CHATGPT_TABS: 3,
      normalizeMaxConcurrentTabs: (value: unknown) => Number(value ?? 3),
      acquireBrowserTabLease,
    }));
    vi.doMock("../../src/browser/index.js", () => ({ isImageOnlyUiChromeText: () => false }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    const recovered = await recoverConversationTab(meta, logger, { readyTimeoutMs: 1 });

    expect(events).toEqual(["lease", "owner", "update"]);
    expect(acquireBrowserTabLease).toHaveBeenCalledWith(
      "/tmp/recover-profile",
      expect.objectContaining({ maxConcurrentTabs: 1, sessionId: "sess-recover" }),
    );
    expect(recovered.ref).toBe("target-reused");
    await Promise.all([recovered.cleanup(), recovered.cleanup()]);
    expect(closeChromeTarget).toHaveBeenCalledTimes(1);
    expect(closeChromeTarget).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 53999, targetId: "target-reused" }),
    );
    expect(events).toEqual(["lease", "owner", "update", "close", "release"]);
    expect(chrome.kill).not.toHaveBeenCalled();
  });

  test("updates the lease with recovered target metadata and terminates only a last launched owner", async () => {
    const update = vi.fn(async () => undefined);
    const release = vi.fn(
      async (options?: { onRelease?: (context: { isLastLease: boolean }) => Promise<void> }) => {
        await options?.onRelease?.({ isLastLease: true });
      },
    );
    const openChatGptTarget = vi.fn(async () => "target-launched");
    const closeChromeTarget = vi.fn(async () => true);
    const acquireBrowserTabLease = vi.fn(async () => ({ id: "lease-launched", update, release }));
    const chrome = {
      host: "127.0.0.1",
      port: 53998,
      kill: vi.fn(async () => ({
        status: "stopped" as const,
        pid: 53998,
        signal: "SIGTERM" as const,
      })),
    };
    const acquireManualChromeOwner = vi.fn(async () => ({ chrome, source: "launched" as const }));

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget,
      harvestChatGptTab: vi.fn(async () => readyHarvest),
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({ acquireManualChromeOwner }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({ closeChromeTarget }));
    vi.doMock("../../src/browser/tabLeaseRegistry.js", () => ({
      DEFAULT_MAX_CONCURRENT_CHATGPT_TABS: 3,
      normalizeMaxConcurrentTabs: (value: unknown) => Number(value ?? 3),
      acquireBrowserTabLease,
    }));
    vi.doMock("../../src/browser/index.js", () => ({ isImageOnlyUiChromeText: () => false }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    const recovered = await recoverConversationTab(meta, logger, { readyTimeoutMs: 1 });
    await recovered.cleanup();

    expect(update).toHaveBeenCalledWith({
      chromeHost: "127.0.0.1",
      chromePort: 53998,
      chromeTargetId: "target-launched",
      tabUrl: "https://chatgpt.com/c/saved-conversation",
    });
    expect(closeChromeTarget).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(chrome.kill).toHaveBeenCalledTimes(1);
  });

  test("closes the owned target and releases its lease when readiness fails", async () => {
    const update = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const closeChromeTarget = vi.fn(async () => true);
    const acquireBrowserTabLease = vi.fn(async () => ({ id: "lease-error", update, release }));
    const chrome = {
      host: "127.0.0.1",
      port: 53997,
      kill: vi.fn(async () => ({
        status: "stopped" as const,
        pid: 53997,
        signal: "SIGTERM" as const,
      })),
    };

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget: vi.fn(async () => "target-error"),
      harvestChatGptTab: vi.fn(async () => ({ ...readyHarvest, assistantCount: 0 })),
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({
      acquireManualChromeOwner: vi.fn(async () => ({ chrome, source: "launched" as const })),
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({ closeChromeTarget }));
    vi.doMock("../../src/browser/tabLeaseRegistry.js", () => ({
      DEFAULT_MAX_CONCURRENT_CHATGPT_TABS: 3,
      normalizeMaxConcurrentTabs: (value: unknown) => Number(value ?? 3),
      acquireBrowserTabLease,
    }));
    vi.doMock("../../src/browser/index.js", () => ({ isImageOnlyUiChromeText: () => false }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    await expect(recoverConversationTab(meta, logger, { readyTimeoutMs: 0 })).rejects.toThrow(
      /did not become ready/,
    );

    expect(closeChromeTarget).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "target-error" }),
    );
    expect(closeChromeTarget).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("releases a newly launched owner through last-lease cleanup when opening its target fails", async () => {
    const release = vi.fn(
      async (options?: { onRelease?: (context: { isLastLease: boolean }) => Promise<void> }) => {
        await options?.onRelease?.({ isLastLease: true });
      },
    );
    const chrome = {
      host: "127.0.0.1",
      port: 53995,
      kill: vi.fn(async () => ({
        status: "stopped" as const,
        pid: 53995,
        signal: "SIGTERM" as const,
      })),
    };
    const closeChromeTarget = vi.fn(async () => true);

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget: vi.fn(async () => {
        throw new Error("CDP.New failed");
      }),
      harvestChatGptTab: vi.fn(),
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({
      acquireManualChromeOwner: vi.fn(async () => ({ chrome, source: "launched" as const })),
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({ closeChromeTarget }));
    vi.doMock("../../src/browser/tabLeaseRegistry.js", () => ({
      DEFAULT_MAX_CONCURRENT_CHATGPT_TABS: 3,
      normalizeMaxConcurrentTabs: (value: unknown) => Number(value ?? 3),
      acquireBrowserTabLease: vi.fn(async () => ({
        id: "lease-target-error",
        update: vi.fn(async () => undefined),
        release,
      })),
    }));
    vi.doMock("../../src/browser/index.js", () => ({ isImageOnlyUiChromeText: () => false }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    await expect(recoverConversationTab(meta, logger, { readyTimeoutMs: 1 })).rejects.toThrow(
      /CDP.New failed/,
    );

    expect(closeChromeTarget).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(chrome.kill).toHaveBeenCalledTimes(1);
  });

  test("releases each recovery before another recovery can acquire the single available tab lease", async () => {
    let activeLeases = 0;
    const release = vi.fn(async () => {
      activeLeases -= 1;
    });
    const acquireBrowserTabLease = vi.fn(async () => {
      if (activeLeases > 0) throw new Error("maxConcurrentTabs exceeded");
      activeLeases += 1;
      return { id: `lease-${activeLeases}`, update: vi.fn(async () => undefined), release };
    });
    const closeChromeTarget = vi.fn(async () => true);
    const targets = ["target-first", "target-second"];

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget: vi.fn(async () => targets.shift() ?? "unexpected-target"),
      harvestChatGptTab: vi.fn(async () => readyHarvest),
    }));
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ({
      acquireManualChromeOwner: vi.fn(async () => ({
        chrome: { host: "127.0.0.1", port: 53996, kill: vi.fn() },
        source: "active-port" as const,
      })),
    }));
    vi.doMock("../../src/browser/chromeLifecycle.js", () => ({ closeChromeTarget }));
    vi.doMock("../../src/browser/tabLeaseRegistry.js", () => ({
      DEFAULT_MAX_CONCURRENT_CHATGPT_TABS: 3,
      normalizeMaxConcurrentTabs: (value: unknown) => Number(value ?? 3),
      acquireBrowserTabLease,
    }));
    vi.doMock("../../src/browser/index.js", () => ({ isImageOnlyUiChromeText: () => false }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    const first = await recoverConversationTab(meta, logger, { readyTimeoutMs: 1 });
    await first.cleanup();
    const second = await recoverConversationTab(meta, logger, { readyTimeoutMs: 1 });
    await second.cleanup();

    expect(activeLeases).toBe(0);
    expect(acquireBrowserTabLease).toHaveBeenCalledTimes(2);
    expect(closeChromeTarget).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });
});
