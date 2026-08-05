import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { openGeminiBrowserSession } from "../../src/gemini-web/browserSessionManager.js";
import type { ManualChromeOwner } from "../../src/browser/manualChromeOwner.js";

type Teardown = () => Promise<boolean>;

const {
  connectWithNewTab,
  closeTab,
  acquireManualChromeOwner,
  settleManualChromeOwner,
  acquireBrowserTabLease,
  retainBrowserTabLeaseTeardownAuthority,
  cleanupStaleProfileState,
  captureProfileDirectoryIdentity,
  verifyProfileDirectoryIdentity,
  isSafeChromeTerminationOutcome,
  ownerKill,
  leaseUpdate,
  leaseRelease,
  teardownSettle,
  teardownState,
  clientClose,
  DEFAULT_MAX_CONCURRENT_CHATGPT_TABS,
  normalizeMaxConcurrentTabs,
} = vi.hoisted(() => ({
  connectWithNewTab: vi.fn(),
  closeTab: vi.fn(async () => true),
  acquireManualChromeOwner: vi.fn(),
  settleManualChromeOwner: vi.fn(),
  acquireBrowserTabLease: vi.fn(),
  retainBrowserTabLeaseTeardownAuthority: vi.fn(),
  cleanupStaleProfileState: vi.fn(async () => true),
  captureProfileDirectoryIdentity: vi.fn(async (profileDir: string) => ({
    version: 1,
    platform: "darwin",
    canonicalPath: profileDir,
    device: "1",
    inode: "1",
  })),
  verifyProfileDirectoryIdentity: vi.fn(async () => true),
  DEFAULT_MAX_CONCURRENT_CHATGPT_TABS: 3,
  normalizeMaxConcurrentTabs: (value: unknown) => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 3;
  },
  isSafeChromeTerminationOutcome: vi.fn(
    (outcome: { status?: string }) =>
      outcome.status === "stopped" || outcome.status === "already-stopped",
  ),
  ownerKill: vi.fn(),
  leaseUpdate: vi.fn(),
  leaseRelease: vi.fn(),
  teardownSettle: vi.fn(),
  teardownState: { leaseReleased: false },
  clientClose: vi.fn(),
}));

vi.mock("../../src/browser/chromeLifecycle.js", () => ({
  connectWithNewTab,
  closeTab,
}));

vi.mock("../../src/browser/manualChromeOwner.js", () => ({
  acquireManualChromeOwner,
  settleManualChromeOwner,
}));

vi.mock("../../src/browser/profileState.js", () => ({
  cleanupStaleProfileState,
  captureProfileDirectoryIdentity,
  verifyProfileDirectoryIdentity,
  isSafeChromeTerminationOutcome,
}));

vi.mock("../../src/browser/tabLeaseRegistry.js", () => ({
  DEFAULT_MAX_CONCURRENT_CHATGPT_TABS,
  normalizeMaxConcurrentTabs,
  acquireBrowserTabLease,
  retainBrowserTabLeaseTeardownAuthority,
}));

describe("openGeminiBrowserSession", () => {
  const originalProfileDir = process.env.ORACLE_BROWSER_PROFILE_DIR;
  let tempRoot: string;
  const processIdentity = {
    pid: 12345,
    processStartTime: "2026-08-04T00:00:00.000Z",
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    normalizedUserDataDir: "/tmp/gemini-profile",
    launchNonce: "canonical-owner",
    profileDirectory: {
      version: 1,
      platform: "darwin",
      canonicalPath: "/tmp/gemini-profile",
      device: "1",
      inode: "1",
    },
  };

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-profile-"));
    delete process.env.ORACLE_BROWSER_PROFILE_DIR;

    ownerKill.mockReset();
    ownerKill.mockResolvedValue({ status: "stopped", pid: processIdentity.pid });
    leaseUpdate.mockReset();
    leaseUpdate.mockResolvedValue(undefined);
    leaseRelease.mockReset();
    leaseRelease.mockResolvedValue(undefined);
    teardownState.leaseReleased = false;
    teardownSettle.mockReset();
    teardownSettle.mockImplementation(async (teardown: Teardown) => {
      teardownState.leaseReleased = true;
      return (await teardown())
        ? { status: "completed", disposition: "teardown-completed" }
        : { status: "preserved", reason: "teardown-unsafe" };
    });
    clientClose.mockReset();
    clientClose.mockResolvedValue(undefined);

    connectWithNewTab.mockReset();
    closeTab.mockClear();
    acquireManualChromeOwner.mockReset();
    settleManualChromeOwner.mockReset();
    settleManualChromeOwner.mockImplementation(
      async (_profileDir: string, owner: ManualChromeOwner) => {
        if (owner.disposition === "preserve") {
          await owner.endpointAuthority?.release();
          return { status: "preserved" as const };
        }
        return { status: "terminated" as const };
      },
    );
    acquireBrowserTabLease.mockReset();
    retainBrowserTabLeaseTeardownAuthority.mockReset();
    retainBrowserTabLeaseTeardownAuthority.mockImplementation(() => ({
      get leaseReleased() {
        return teardownState.leaseReleased;
      },
      settle: teardownSettle,
    }));
    cleanupStaleProfileState.mockClear();
    cleanupStaleProfileState.mockResolvedValue(true);

    acquireManualChromeOwner.mockResolvedValue({
      chrome: {
        port: 9222,
        pid: processIdentity.pid,
        host: "127.0.0.1",
        processIdentity,
        kill: ownerKill,
      },
      processIdentity,
      source: "launched",
      disposition: "close-on-last-lease",
    });
    acquireBrowserTabLease.mockResolvedValue({
      id: "lease-1",
      profileDirectory: processIdentity.profileDirectory,
      update: leaseUpdate,
      release: leaseRelease,
    });
    connectWithNewTab.mockResolvedValue({
      targetId: "target-1",
      client: { close: clientClose },
    });
  });

  afterEach(async () => {
    if (originalProfileDir === undefined) {
      delete process.env.ORACLE_BROWSER_PROFILE_DIR;
    } else {
      process.env.ORACLE_BROWSER_PROFILE_DIR = originalProfileDir;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("delegates persistent-profile ownership and records its isolated target lease", async () => {
    const explicitDir = path.join(tempRoot, "explicit-profile");
    process.env.ORACLE_BROWSER_PROFILE_DIR = path.join(tempRoot, "env-profile");

    const session = await openGeminiBrowserSession({
      browserConfig: { manualLoginProfileDir: explicitDir },
      keepBrowserDefault: false,
      purpose: "Gemini Deep Think",
    });

    expect(session.profileDir).toBe(explicitDir);
    expect(session.targetId).toBe("target-1");
    expect(session.processIdentity).toBe(processIdentity);
    expect(acquireBrowserTabLease).toHaveBeenCalledWith(
      explicitDir,
      expect.objectContaining({ sessionId: "Gemini Deep Think" }),
    );
    expect(acquireManualChromeOwner).toHaveBeenCalledWith(
      explicitDir,
      expect.objectContaining({
        manualLogin: true,
        manualLoginProfileDir: explicitDir,
      }),
      expect.any(Function),
      "Gemini Deep Think",
    );
    expect(leaseUpdate).toHaveBeenCalledWith({ chromeHost: "127.0.0.1", chromePort: 9222 });
    expect(connectWithNewTab).toHaveBeenCalledWith(
      9222,
      expect.any(Function),
      "about:blank",
      "127.0.0.1",
      { fallbackToDefault: false, retries: 6 },
    );
  });

  it("releases retained endpoint authority for a preserved exact owner", async () => {
    const profileDir = path.join(tempRoot, "reused-profile");
    const endpointRelease = vi.fn(async () => undefined);
    acquireManualChromeOwner.mockResolvedValueOnce({
      chrome: {
        port: 9333,
        pid: processIdentity.pid,
        host: "127.0.0.1",
        processIdentity,
        kill: ownerKill,
      },
      processIdentity,
      source: "recorded",
      disposition: "preserve",
      endpointAuthority: { release: endpointRelease },
    });

    const session = await openGeminiBrowserSession({
      browserConfig: { manualLoginProfileDir: profileDir },
      keepBrowserDefault: false,
      purpose: "Gemini cookie capture",
    });
    await session.close();

    expect(session.processIdentity).toBe(processIdentity);
    expect(closeTab).toHaveBeenCalledWith(9333, "target-1", expect.any(Function), "127.0.0.1");
    expect(leaseRelease).toHaveBeenCalledTimes(1);
    expect(settleManualChromeOwner).toHaveBeenCalledWith(
      profileDir,
      expect.objectContaining({ disposition: "preserve" }),
      expect.any(Function),
    );
    expect(endpointRelease).toHaveBeenCalledOnce();
    expect(ownerKill).not.toHaveBeenCalled();
    expect(cleanupStaleProfileState).not.toHaveBeenCalled();
    expect(retainBrowserTabLeaseTeardownAuthority).not.toHaveBeenCalled();
  });

  it("hands a launched owner off without killing it when another lease is already active", async () => {
    const profileDir = path.join(tempRoot, "shared-profile");
    teardownSettle.mockImplementationOnce(async () => {
      teardownState.leaseReleased = true;
      return { status: "completed", disposition: "active-lease-handoff" };
    });

    const session = await openGeminiBrowserSession({
      browserConfig: { manualLoginProfileDir: profileDir },
      keepBrowserDefault: false,
      purpose: "Gemini Deep Think",
    });
    await Promise.all([session.close(), session.close()]);

    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(clientClose).toHaveBeenCalledTimes(1);
    expect(teardownSettle).toHaveBeenCalledTimes(1);
    expect(ownerKill).not.toHaveBeenCalled();
    expect(cleanupStaleProfileState).not.toHaveBeenCalled();
  });

  it("retains teardown authority for a recorded close-on-last-lease owner", async () => {
    const profileDir = path.join(tempRoot, "last-lease-profile");
    acquireManualChromeOwner.mockResolvedValueOnce({
      chrome: {
        port: 9222,
        pid: processIdentity.pid,
        host: "127.0.0.1",
        processIdentity,
        kill: ownerKill,
      },
      processIdentity,
      source: "recorded",
      disposition: "close-on-last-lease",
    });
    const session = await openGeminiBrowserSession({
      browserConfig: { manualLoginProfileDir: profileDir },
      keepBrowserDefault: false,
      purpose: "Gemini Deep Think",
    });
    await session.close();

    expect(ownerKill).toHaveBeenCalledTimes(1);
    expect(cleanupStaleProfileState).toHaveBeenCalledWith(profileDir, undefined, {
      lockRemovalMode: "never",
      expectedProfileIdentity: processIdentity.profileDirectory,
    });
  });

  it("preserves profile state when its launched owner cannot be terminated safely", async () => {
    const profileDir = path.join(tempRoot, "termination-failure-profile");
    ownerKill.mockResolvedValueOnce({
      status: "unsafe",
      pid: processIdentity.pid,
      reason: "termination failed",
    });
    const session = await openGeminiBrowserSession({
      browserConfig: { manualLoginProfileDir: profileDir },
      keepBrowserDefault: false,
      purpose: "Gemini Deep Think",
    });
    await expect(session.close()).rejects.toThrow("did not settle cleanly");

    expect(cleanupStaleProfileState).not.toHaveBeenCalled();
  });

  it("rechecks the lease registry before retrying the exact launched-owner handle", async () => {
    const profileDir = path.join(tempRoot, "teardown-race-profile");
    ownerKill
      .mockResolvedValueOnce({
        status: "unsafe",
        pid: processIdentity.pid,
        reason: "termination failed",
      })
      .mockResolvedValueOnce({ status: "stopped", pid: processIdentity.pid });
    teardownSettle
      .mockImplementationOnce(async (teardown: Teardown) => {
        teardownState.leaseReleased = true;
        expect(await teardown()).toBe(false);
        return { status: "preserved", reason: "teardown-unsafe" };
      })
      .mockImplementationOnce(async () => ({ status: "preserved", reason: "active-leases" }))
      .mockImplementationOnce(async (teardown: Teardown) => {
        expect(await teardown()).toBe(true);
        return { status: "completed", disposition: "teardown-completed" };
      });
    const session = await openGeminiBrowserSession({
      browserConfig: { manualLoginProfileDir: profileDir },
      keepBrowserDefault: false,
      purpose: "Gemini Deep Think",
    });

    await expect(session.close()).rejects.toThrow("did not settle cleanly");
    expect(ownerKill).toHaveBeenCalledTimes(1);
    expect(session.runtime().recoveryCleanupResources?.[0]?.tabLease).toBeUndefined();

    await expect(session.close()).rejects.toThrow("active-leases");
    expect(ownerKill).toHaveBeenCalledTimes(1);

    await expect(session.close()).resolves.toBeUndefined();
    expect(ownerKill).toHaveBeenCalledTimes(2);
    expect(cleanupStaleProfileState).toHaveBeenCalledTimes(1);
    expect(session.runtime().recoveryCleanupResources).toBeUndefined();
  });

  it("attaches durable cleanup authority when session opening cannot settle", async () => {
    const profileDir = path.join(tempRoot, "open-failure-profile");
    connectWithNewTab.mockRejectedValueOnce(new Error("connection failed"));
    ownerKill.mockResolvedValueOnce({
      status: "unsafe",
      pid: processIdentity.pid,
      reason: "termination failed",
    });

    await expect(
      openGeminiBrowserSession({
        browserConfig: { manualLoginProfileDir: profileDir },
        keepBrowserDefault: false,
        purpose: "Gemini Deep Think",
      }),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: {
        stage: "gemini-browser-session-open",
        runtime: {
          recoveryCleanupResult: { status: "failed", settlementMode: "abort" },
          recoveryCleanupResources: [
            expect.objectContaining({
              userDataDir: profileDir,
              tabLease: undefined,
              recoveryCleanup: expect.objectContaining({ keepBrowser: false }),
            }),
          ],
        },
      },
    });
    expect(ownerKill).toHaveBeenCalledTimes(1);
    expect(cleanupStaleProfileState).not.toHaveBeenCalled();
  });

  it("retries target closure before releasing controller or lease authority", async () => {
    const profileDir = path.join(tempRoot, "close-retry-profile");
    closeTab.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const session = await openGeminiBrowserSession({
      browserConfig: { manualLoginProfileDir: profileDir },
      keepBrowserDefault: false,
      purpose: "Gemini Deep Think",
    });

    await expect(session.close()).rejects.toThrow("did not settle cleanly");
    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(clientClose).not.toHaveBeenCalled();
    expect(leaseRelease).not.toHaveBeenCalled();
    expect(ownerKill).not.toHaveBeenCalled();

    await expect(session.close()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();

    expect(closeTab).toHaveBeenCalledTimes(2);
    expect(clientClose).toHaveBeenCalledTimes(1);
    expect(teardownSettle).toHaveBeenCalledTimes(1);
    expect(ownerKill).toHaveBeenCalledTimes(1);
    expect(cleanupStaleProfileState).toHaveBeenCalledTimes(1);
  });

  it("rejects when launched-owner cleanup cannot confirm the exact profile", async () => {
    const profileDir = path.join(tempRoot, "profile-cleanup-failure");
    cleanupStaleProfileState.mockResolvedValueOnce(false);
    const session = await openGeminiBrowserSession({
      browserConfig: { manualLoginProfileDir: profileDir },
      keepBrowserDefault: false,
      purpose: "Gemini Deep Think",
    });

    await expect(session.close()).rejects.toThrow("did not settle cleanly");
    expect(ownerKill).toHaveBeenCalledTimes(1);
    expect(cleanupStaleProfileState).toHaveBeenCalledWith(profileDir, undefined, {
      lockRemovalMode: "never",
      expectedProfileIdentity: processIdentity.profileDirectory,
    });
  });
});
