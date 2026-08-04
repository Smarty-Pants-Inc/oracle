import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { openGeminiBrowserSession } from "../../src/gemini-web/browserSessionManager.js";

type LeaseReleaseOptions = {
  onRelease?: (context: { isLastLease: boolean }) => Promise<void>;
};

const {
  connectWithNewTab,
  closeTab,
  acquireManualChromeOwner,
  acquireBrowserTabLease,
  cleanupStaleProfileState,
  captureProfileDirectoryIdentity,
  verifyProfileDirectoryIdentity,
  isSafeChromeTerminationOutcome,
  ownerKill,
  leaseUpdate,
  leaseRelease,
  clientClose,
  DEFAULT_MAX_CONCURRENT_CHATGPT_TABS,
  normalizeMaxConcurrentTabs,
} = vi.hoisted(() => ({
  connectWithNewTab: vi.fn(),
  closeTab: vi.fn(async () => true),
  acquireManualChromeOwner: vi.fn(),
  acquireBrowserTabLease: vi.fn(),
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
  clientClose: vi.fn(),
}));

vi.mock("../../src/browser/chromeLifecycle.js", () => ({
  connectWithNewTab,
  closeTab,
}));

vi.mock("../../src/browser/manualChromeOwner.js", () => ({
  acquireManualChromeOwner,
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
    leaseRelease.mockImplementation(async (options: LeaseReleaseOptions = {}) => {
      await options.onRelease?.({ isLastLease: true });
    });
    clientClose.mockReset();
    clientClose.mockResolvedValue(undefined);

    connectWithNewTab.mockReset();
    closeTab.mockClear();
    acquireManualChromeOwner.mockReset();
    acquireBrowserTabLease.mockReset();
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
    });
    acquireBrowserTabLease.mockResolvedValue({
      id: "lease-1",
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

  it("returns the exact reused owner identity and never terminates it", async () => {
    const profileDir = path.join(tempRoot, "reused-profile");
    acquireManualChromeOwner.mockResolvedValueOnce({
      chrome: {
        port: 9333,
        pid: processIdentity.pid,
        host: "127.0.0.1",
        processIdentity,
        kill: ownerKill,
      },
      processIdentity,
      source: "active-port",
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
    expect(ownerKill).not.toHaveBeenCalled();
    expect(cleanupStaleProfileState).not.toHaveBeenCalled();
  });

  it("keeps a launched owner alive until its final tab lease releases", async () => {
    const profileDir = path.join(tempRoot, "shared-profile");
    leaseRelease.mockImplementationOnce(async (options: LeaseReleaseOptions = {}) => {
      await options.onRelease?.({ isLastLease: false });
    });

    const session = await openGeminiBrowserSession({
      browserConfig: { manualLoginProfileDir: profileDir },
      keepBrowserDefault: false,
      purpose: "Gemini Deep Think",
    });
    await Promise.all([session.close(), session.close()]);

    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(clientClose).toHaveBeenCalledTimes(1);
    expect(leaseRelease).toHaveBeenCalledTimes(1);
    expect(ownerKill).not.toHaveBeenCalled();
    expect(cleanupStaleProfileState).not.toHaveBeenCalled();
  });

  it("terminates only its launched canonical owner after the last lease releases", async () => {
    const profileDir = path.join(tempRoot, "last-lease-profile");
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

  it("rejects after attempting target, client, and lease cleanup failures", async () => {
    const profileDir = path.join(tempRoot, "close-failure-profile");
    closeTab.mockResolvedValueOnce(false);
    clientClose.mockRejectedValueOnce(new Error("CDP close failed"));
    leaseRelease.mockRejectedValueOnce(new Error("lease release failed"));
    const session = await openGeminiBrowserSession({
      browserConfig: { manualLoginProfileDir: profileDir },
      keepBrowserDefault: false,
      purpose: "Gemini Deep Think",
    });

    await expect(session.close()).rejects.toThrow("did not settle cleanly");
    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(clientClose).toHaveBeenCalledTimes(1);
    expect(leaseRelease).toHaveBeenCalledTimes(1);
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
