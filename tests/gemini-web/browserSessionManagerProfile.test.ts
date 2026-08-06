import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  acquireBrowserTabLease,
  acquireManualChromeOwner,
  closeChromeTargetWithExactAuthority,
  connectWithNewTabWithExactAuthority,
  releaseManualChromeOwnerEndpointAuthority,
  settleManualChromeOwner,
} = vi.hoisted(() => ({
  acquireBrowserTabLease: vi.fn(),
  acquireManualChromeOwner: vi.fn(),
  closeChromeTargetWithExactAuthority: vi.fn(async () => ({ status: "completed" as const })),
  connectWithNewTabWithExactAuthority: vi.fn(),
  releaseManualChromeOwnerEndpointAuthority: vi.fn(async () => undefined),
  settleManualChromeOwner: vi.fn(async () => ({ status: "preserved" as const })),
}));

vi.mock("../../src/browser/chromeLifecycle.js", () => ({
  closeChromeTargetWithExactAuthority,
  connectWithNewTabWithExactAuthority,
}));
vi.mock("../../src/browser/manualChromeOwner.js", () => ({
  acquireManualChromeOwner,
  releaseManualChromeOwnerEndpointAuthority,
  settleManualChromeOwner,
}));
vi.mock("../../src/browser/tabLeaseRegistry.js", () => ({
  DEFAULT_MAX_CONCURRENT_CHATGPT_TABS: 3,
  normalizeMaxConcurrentTabs: (value: unknown) =>
    typeof value === "number" && value > 0 ? Math.trunc(value) : 3,
  acquireBrowserTabLease,
  releaseBrowserTabLease: vi.fn(async () => undefined),
  retainBrowserTabLeaseTeardownAuthority: vi.fn(),
}));

import { openGeminiBrowserSession } from "../../src/gemini-web/browserSessionManager.js";
import { captureProfileDirectoryIdentity } from "../../src/browser/profileState.js";

const tempRoots: string[] = [];

describe("openGeminiBrowserSession fresh profile", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("creates an absent configured profile before capturing its physical identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-fresh-profile-"));
    tempRoots.push(root);
    const profileDir = path.join(root, "not-created-yet");
    const endpointAuthority = {
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/fresh-profile",
      kill: vi.fn(async () => ({
        status: "stopped" as const,
        pid: 1234,
        signal: "SIGTERM" as const,
      })),
      release: vi.fn(async () => undefined),
    };
    acquireBrowserTabLease.mockImplementationOnce(
      async (_profileDir: string, options: { sessionId: string; generationId: string }) => ({
        id: "fresh-profile-lease",
        sessionId: options.sessionId,
        generationId: options.generationId,
        profileDirectory: await captureProfileDirectoryIdentity(profileDir),
        update: vi.fn(async () => undefined),
        release: vi.fn(async () => undefined),
      }),
    );
    acquireManualChromeOwner.mockImplementationOnce(async () => {
      const profileDirectory = await captureProfileDirectoryIdentity(profileDir);
      const processIdentity = {
        pid: 1234,
        processStartTime: "2026-08-05T00:00:00.000Z",
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        normalizedUserDataDir: profileDir,
        launchNonce: "fresh-profile-owner",
        profileDirectory,
      };
      return {
        chrome: {
          pid: 1234,
          port: 9222,
          host: "127.0.0.1",
          remoteDebuggingPipes: undefined,
          processIdentity,
          endpointAuthority,
          kill: endpointAuthority.kill,
        },
        processIdentity,
        source: "recorded" as const,
        disposition: "preserve" as const,
        endpointAuthority,
      };
    });
    connectWithNewTabWithExactAuthority.mockResolvedValueOnce({
      targetId: "fresh-profile-target",
      client: { close: vi.fn(async () => undefined) },
    });

    await expect(access(profileDir)).rejects.toMatchObject({ code: "ENOENT" });
    const session = await openGeminiBrowserSession({
      browserConfig: { manualLoginProfileDir: profileDir, keepBrowser: true },
      keepBrowserDefault: false,
      purpose: "Gemini fresh profile",
    });

    await expect(access(profileDir)).resolves.toBeUndefined();
    const profileIdentity = await captureProfileDirectoryIdentity(profileDir);
    expect(session.runtime().recoveryCleanupResources?.[0]?.profileDirectoryIdentity).toMatchObject(
      {
        canonicalPath: profileIdentity.canonicalPath,
      },
    );
    await session.close();
  });
});
