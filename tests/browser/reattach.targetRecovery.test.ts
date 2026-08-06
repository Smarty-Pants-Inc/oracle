import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { __test__ } from "../../src/browser/reattach.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";
import type { BrowserRecoveryCleanupResourceMetadata } from "../../src/sessionManager.js";
import {
  captureProfileDirectoryIdentity,
  type ChromeProcessIdentity,
} from "../../src/browser/profileState.js";
import {
  closeChromeTargetWithRetainedCapability,
  retainChromeTargetCloseCapability,
} from "../../src/browser/targetCloseAuthority.js";
import {
  authenticatedLocalTargetCleanupDeps,
  createBrowserLogger,
  physicalChromeProcessIdentity,
  syntheticChromeProcessIdentity,
  withCommittedPromptEpoch,
  withRecoveryCleanup,
} from "./reattachTestHelpers.js";

describe("recovery target authority", { timeout: 15_000 }, () => {
  const { finalizeRecoveredRuntime } = __test__;
  const stopped = { status: "stopped", pid: 1234, signal: "SIGTERM" } as const;
  test("derives the recovery lock from prompt identity and ordered cleanup authority", () => {
    const profileDir = path.join(os.tmpdir(), "oracle-browser-lock-identity");
    const runtime = withCommittedPromptEpoch(
      withRecoveryCleanup(
        {
          chromeProcessIdentity: syntheticChromeProcessIdentity(profileDir),
          chromeProfileRoot: profileDir,
          userDataDir: profileDir,
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/old",
          chromeTargetId: "old-target",
        },
        {
          ownsTarget: true,
          profileKind: "temporary",
          keepBrowser: false,
          closeOwnedTargetOnComplete: true,
        },
      ),
    );

    expect(
      __test__.defaultRecoveryLockPath({
        ...runtime,
        chromeHost: "localhost",
        chromePort: 9333,
        chromeBrowserWSEndpoint: "ws://localhost:9333/devtools/browser/new",
        chromeTargetId: "new-target",
      }),
    ).toBe(__test__.defaultRecoveryLockPath(runtime));
  });

  test("does not promote endpoint metadata after the recorded Chrome generation exits", async () => {
    const profileDir = path.join(os.tmpdir(), "oracle-reattach-exited-generation");
    const processIdentity = syntheticChromeProcessIdentity(profileDir, 9_101);
    const readActivePort = vi.fn(async () => ({
      port: 63332,
      browserWSEndpoint: "ws://127.0.0.1:63332/devtools/browser/replacement",
      path: path.join(profileDir, "DevToolsActivePort"),
    }));
    const retainEndpointAuthority = vi.fn();

    await expect(
      __test__.refreshAttachRuntime(
        {
          chromeProcessIdentity: processIdentity,
          chromeProfileRoot: profileDir,
          chromePort: 41111,
          chromeBrowserWSEndpoint: "ws://127.0.0.1:41111/devtools/browser/recorded",
        },
        {
          inspectProcessIdentity: vi.fn(async () => "exited" as const),
          readActivePort,
          retainEndpointAuthority,
        },
      ),
    ).resolves.toBeNull();
    expect(readActivePort).not.toHaveBeenCalled();
    expect(retainEndpointAuthority).not.toHaveBeenCalled();
  });

  test("refreshes endpoint metadata only through exact retained process authority", async () => {
    const profileDir = path.join(os.tmpdir(), "oracle-reattach-current-generation");
    const processIdentity = syntheticChromeProcessIdentity(profileDir, 9_102);
    const release = vi.fn(async () => undefined);
    const exactEndpoint = "ws://127.0.0.1:63333/devtools/browser/exact-generation";
    const retainEndpointAuthority = vi.fn(async () => ({
      browserWSEndpoint: exactEndpoint,
      kill: vi.fn(async () => ({
        status: "unsafe" as const,
        reason: "Test refresh authority is release-only",
      })),
      release,
    }));
    const runtime = withRecoveryCleanup(
      {
        chromeProcessIdentity: processIdentity,
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        chromePort: 41112,
        chromeBrowserWSEndpoint: "ws://127.0.0.1:41112/devtools/browser/recorded",
        chromeTargetId: "recorded-target",
      },
      {
        ownsTarget: true,
        profileKind: "none",
        keepBrowser: true,
        closeOwnedTargetOnComplete: true,
      },
    );
    const ownedResource = runtime.recoveryCleanupResources?.[0];
    if (!ownedResource) throw new Error("owned refresh fixture is missing");
    const exactRuntime: BrowserRuntimeMetadata = {
      ...runtime,
      recoveryCleanupResources: [
        {
          ...ownedResource,
          targetCloseCapability: {
            version: 1,
            generationId: "refresh-generation",
            capabilityId: "refresh-capability",
          },
          acquisition: {
            generationId: "refresh-generation",
            targetMarkerUrl: "about:blank#oracle-acquisition=refresh-generation",
          },
        },
      ],
    };

    const refreshed = await __test__.refreshAttachRuntime(exactRuntime, {
      inspectProcessIdentity: vi.fn(async () => "current" as const),
      readActivePort: vi.fn(async () => ({
        port: 63333,
        browserWSEndpoint: exactEndpoint,
        path: path.join(profileDir, "DevToolsActivePort"),
      })),
      retainEndpointAuthority,
    });

    expect(refreshed).toMatchObject({
      chromePort: 63333,
      chromeBrowserWSEndpoint: exactEndpoint,
      recoveryCleanupResources: [
        expect.objectContaining({
          chromePort: 63333,
          chromeBrowserWSEndpoint: exactEndpoint,
          chromeTargetId: "recorded-target",
        }),
      ],
    });
    expect(retainEndpointAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 63333,
        userDataDir: profileDir,
        processIdentity,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  test.each(["finalize", "abort"] as const)(
    "%s preserves a target after current-process close capability loss",
    async (mode) => {
      const profileDir = path.join(os.tmpdir(), "oracle-browser-rebound-process");
      const processIdentity = syntheticChromeProcessIdentity(profileDir, 9_103);
      const browserWSEndpoint = "ws://127.0.0.1:63334/devtools/browser/rebound";
      const retainChromeEndpointAuthority = vi.fn();
      const retainChromeBrowserWebSocketAuthority = vi.fn();
      const closeChromeTargetWithExactAuthority = vi.fn();
      const result = await finalizeRecoveredRuntime(
        withRecoveryCleanup(
          {
            chromeProcessIdentity: processIdentity,
            chromeProfileRoot: profileDir,
            userDataDir: profileDir,
            chromePort: 63334,
            chromeBrowserWSEndpoint: browserWSEndpoint,
            chromeTargetId: "rebound-target",
          },
          {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: true,
            closeOwnedTargetOnComplete: true,
          },
          undefined,
          {
            targetCloseCapability: {
              version: 1,
              generationId: "generation-a",
              capabilityId: "lost-after-server-restart",
              targetId: "rebound-target",
              browserWSEndpoint,
            },
            acquisition: {
              generationId: "generation-a",
              targetMarkerUrl: "about:blank#oracle-acquisition=generation-a",
            },
          },
        ),
        createBrowserLogger(),
        {
          retainChromeEndpointAuthority,
          retainChromeBrowserWebSocketAuthority,
          closeChromeTargetWithExactAuthority,
        },
        mode,
      );

      expect(result).toMatchObject({
        status: "pending",
        error: expect.stringContaining("no longer live"),
      });
      expect(retainChromeEndpointAuthority).not.toHaveBeenCalled();
      expect(retainChromeBrowserWebSocketAuthority).not.toHaveBeenCalled();
      expect(closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
    },
  );

  test.each(["finalize", "abort"] as const)(
    "%s preserves a processless target after close capability loss",
    async (mode) => {
      const browserWSEndpoint = "ws://service.example:63335/devtools/browser/service-generation";
      const retainChromeEndpointAuthority = vi.fn();
      const retainChromeBrowserWebSocketAuthority = vi.fn();
      const closeChromeTargetWithExactAuthority = vi.fn();
      const result = await finalizeRecoveredRuntime(
        withRecoveryCleanup(
          {
            chromeHost: "service.example",
            chromePort: 63335,
            chromeBrowserWSEndpoint: browserWSEndpoint,
            chromeTargetId: "service-target",
          },
          {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: true,
            closeOwnedTargetOnComplete: true,
          },
          undefined,
          {
            targetCloseCapability: {
              version: 1,
              generationId: "service-acquisition",
              capabilityId: "service-capability",
              targetId: "service-target",
              browserWSEndpoint,
            },
            acquisition: {
              generationId: "service-acquisition",
              targetMarkerUrl: "about:blank#oracle-acquisition=service-acquisition",
            },
          },
        ),
        createBrowserLogger(),
        {
          retainChromeEndpointAuthority,
          retainChromeBrowserWebSocketAuthority,
          closeChromeTargetWithExactAuthority,
        },
        mode,
      );

      expect(result).toMatchObject({
        status: "pending",
        error: expect.stringContaining("no longer live"),
      });
      expect(retainChromeEndpointAuthority).not.toHaveBeenCalled();
      expect(retainChromeBrowserWebSocketAuthority).not.toHaveBeenCalled();
      expect(closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
    },
  );

  test("does not mutate a replacement process, endpoint, or profile during deferred teardown", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-replacement-owner-"));
    const recordedIdentity = await physicalChromeProcessIdentity(profileDir, 9_107);
    const replacementIdentity = {
      ...recordedIdentity,
      pid: 9_108,
      processStartTime: "replacement",
    };
    const retainChromeEndpointAuthority = vi.fn();
    const closeChromeTargetWithExactAuthority = vi.fn();
    const removeProfile = vi.fn(async () => true);
    try {
      const result = await finalizeRecoveredRuntime(
        withRecoveryCleanup(
          {
            chromePort: 63336,
            chromeProcessIdentity: recordedIdentity,
            chromeProfileRoot: profileDir,
            userDataDir: profileDir,
          },
          {
            ownsTarget: false,
            profileKind: "temporary",
            keepBrowser: false,
          },
        ),
        createBrowserLogger(),
        {
          verifyProfileDirectoryIdentity: vi.fn(async () => true),
          inspectChromeProcessIdentity: vi.fn(async (_profileDir, identity) =>
            identity.pid === recordedIdentity.pid ? "exited" : "current",
          ),
          readOracleChromeOwner: vi.fn(async () => ({
            port: 63337,
            processIdentity: replacementIdentity,
            disposition: "preserve" as const,
          })),
          retainChromeEndpointAuthority,
          closeChromeTargetWithExactAuthority,
          removeProfile,
        },
      );

      expect(result).toMatchObject({
        status: "pending",
        error: expect.stringContaining("replacement process generation"),
      });
      expect(retainChromeEndpointAuthority).not.toHaveBeenCalled();
      expect(closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
      expect(removeProfile).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });
  test("preserves pre-upgrade target authority without endpoint reconstruction", async () => {
    const profileDir = path.join(os.tmpdir(), "oracle-browser-legacy-target-authority");
    const processIdentity = syntheticChromeProcessIdentity(profileDir, 9_104);
    const retainChromeEndpointAuthority = vi.fn();
    const result = await finalizeRecoveredRuntime(
      withRecoveryCleanup(
        {
          chromeProcessIdentity: processIdentity,
          chromeProfileRoot: profileDir,
          userDataDir: profileDir,
          chromePort: 63335,
          chromeTargetId: "persisted-target",
        },
        {
          ownsTarget: true,
          profileKind: "none",
          keepBrowser: true,
          closeOwnedTargetOnComplete: true,
        },
        undefined,
        { acquisition: { generationId: "legacy-generation" } },
      ),
      createBrowserLogger(),
      {
        retainChromeEndpointAuthority,
      },
    );

    expect(result).toMatchObject({
      status: "pending",
      error: expect.stringContaining("Pre-upgrade browser session"),
      runtime: {
        recoveryCleanupResult: {
          status: "failed",
          error: expect.stringContaining("Pre-upgrade browser session"),
          settlementMode: "finalize",
        },
        recoveryCleanupResources: [expect.objectContaining({ chromeTargetId: "persisted-target" })],
      },
    });
    expect(retainChromeEndpointAuthority).not.toHaveBeenCalled();
  });

  test("closes through the retained in-process opaque target capability", async () => {
    const close = vi.fn(async () => ({ status: "completed" as const }));
    const release = vi.fn(async () => undefined);
    const capability = retainChromeTargetCloseCapability({
      generationId: "live-generation",
      targetId: "valid-target",
      close: async () => close(),
      release,
    });
    const runtime = withRecoveryCleanup(
      {
        chromeTargetId: "valid-target",
      },
      {
        ownsTarget: true,
        profileKind: "none",
        keepBrowser: true,
        closeOwnedTargetOnComplete: true,
      },
      undefined,
      {
        targetCloseCapability: capability,
        acquisition: { generationId: "live-generation" },
      },
    );
    const result = await finalizeRecoveredRuntime(runtime, createBrowserLogger(), {});
    const replay = await finalizeRecoveredRuntime(runtime, createBrowserLogger(), {});

    expect(result.status).toBe("completed");
    expect(replay.status).toBe("completed");
    expect(close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  test("settles interrupted temporary target acquisition through exact process teardown", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-interrupted-target-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir, 9_112);
    const events: string[] = [];
    const closeRetainedTarget = vi.fn();
    const cleanupDeps = authenticatedLocalTargetCleanupDeps({
      kill: (_userDataDir, pid) => {
        events.push("process-kill");
        return { ...stopped, pid };
      },
      onRelease: () => events.push("endpoint-release"),
    });
    const removeProfile = vi.fn(async () => {
      events.push("profile-remove");
      return true;
    });
    const runtime = withRecoveryCleanup(
      {
        chromeHost: "127.0.0.1",
        chromePort: 63341,
        chromeProcessIdentity: processIdentity,
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
      },
      {
        ownsTarget: true,
        profileKind: "temporary",
        keepBrowser: false,
        closeOwnedTargetOnComplete: true,
      },
      undefined,
      {
        acquisition: {
          generationId: "interrupted-project-sources",
          pendingResource: "chrome-target",
          targetMarkerUrl: "about:blank#oracle-project-sources=interrupted-project-sources",
        },
      },
    );

    try {
      const result = await finalizeRecoveredRuntime(runtime, createBrowserLogger(), {
        ...cleanupDeps,
        closeChromeTargetWithRetainedCapability: closeRetainedTarget,
        removeProfile,
      });

      expect(result.status).toBe("completed");
      expect(result.runtime.recoveryCleanupResources).toBeUndefined();
      expect(closeRetainedTarget).not.toHaveBeenCalled();
      expect(cleanupDeps.closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
      expect(events).toEqual(["process-kill", "profile-remove", "endpoint-release"]);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("settles stale target capability through exact temporary Chrome teardown after restart", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-restart-settlement-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir, 9_110);
    const events: string[] = [];
    const closeRetainedTarget = vi.fn(
      async (options: Parameters<typeof closeChromeTargetWithRetainedCapability>[0]) => {
        events.push("target-close");
        return closeChromeTargetWithRetainedCapability(options);
      },
    );
    const cleanupDeps = authenticatedLocalTargetCleanupDeps({
      mockRetainedTargetClose: false,
      kill: (_userDataDir, pid) => {
        events.push("process-kill");
        return { ...stopped, pid };
      },
      onRelease: () => events.push("endpoint-release"),
    });
    const removeProfile = vi.fn(async () => {
      events.push("profile-remove");
      return true;
    });
    const runtime = withRecoveryCleanup(
      {
        chromeHost: "127.0.0.1",
        chromePort: 63339,
        chromeProcessIdentity: processIdentity,
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        chromeTargetId: "restart-owned-target",
      },
      {
        ownsTarget: true,
        profileKind: "temporary",
        keepBrowser: false,
        closeOwnedTargetOnComplete: true,
      },
    );

    try {
      const result = await finalizeRecoveredRuntime(runtime, createBrowserLogger(), {
        ...cleanupDeps,
        closeChromeTargetWithRetainedCapability: closeRetainedTarget,
        removeProfile,
      });

      expect(result.status).toBe("completed");
      expect(result.runtime.recoveryCleanupResources).toBeUndefined();
      expect(closeRetainedTarget).toHaveBeenCalledOnce();
      expect(cleanupDeps.closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
      expect(events).toEqual([
        "target-close",
        "process-kill",
        "profile-remove",
        "endpoint-release",
      ]);

      await expect(
        finalizeRecoveredRuntime(result.runtime, createBrowserLogger(), {
          ...cleanupDeps,
          closeChromeTargetWithRetainedCapability: closeRetainedTarget,
          removeProfile,
        }),
      ).resolves.toMatchObject({ status: "completed" });
      expect(events).toHaveLength(4);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test.each([
    { name: "manual-login", profileKind: "manual-login", keepBrowser: false },
    { name: "kept temporary", profileKind: "temporary", keepBrowser: true },
    { name: "borrowed profile", profileKind: "none", keepBrowser: false },
  ] as const)(
    "does not subsume unavailable target cleanup by tearing down $name Chrome",
    async ({ profileKind, keepBrowser }) => {
      const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-preserved-restart-"));
      const processIdentity = await physicalChromeProcessIdentity(profileDir, 9_111);
      const terminateExactChromeForProfile = vi.fn(async () => stopped);
      try {
        const result = await finalizeRecoveredRuntime(
          withRecoveryCleanup(
            {
              chromeHost: "127.0.0.1",
              chromePort: 63340,
              chromeProcessIdentity: processIdentity,
              chromeProfileRoot: profileDir,
              userDataDir: profileDir,
              chromeTargetId: `preserved-${profileKind}`,
            },
            {
              ownsTarget: true,
              profileKind,
              keepBrowser,
              closeOwnedTargetOnComplete: true,
            },
          ),
          createBrowserLogger(),
          {
            terminateExactChromeForProfile,
          },
        );

        expect(result).toMatchObject({
          status: "pending",
          error: expect.stringContaining("no longer live"),
        });
        expect(terminateExactChromeForProfile).not.toHaveBeenCalled();
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
  );

  test("treats an already-absent contained temporary profile as complete", async () => {
    const profileDir = path.join(os.tmpdir(), "oracle-browser-already-absent-cleanup");
    await rm(profileDir, { recursive: true, force: true });
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const removeProfile = vi.fn(async () => true);

    const result = await finalizeRecoveredRuntime(
      withRecoveryCleanup(
        { userDataDir: profileDir },
        {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
        },
      ),
      createBrowserLogger(),
      { terminateRecordedChromeForProfile, removeProfile },
    );

    expect(result.status).toBe("completed");
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    expect(removeProfile).not.toHaveBeenCalled();
  });

  test("does not treat an absent profile as proof that an exact Chrome generation stopped", async () => {
    const profileDir = path.join(os.tmpdir(), "oracle-browser-absent-live-generation");
    await rm(profileDir, { recursive: true, force: true });
    const processIdentity = syntheticChromeProcessIdentity(profileDir, 9_109);
    const retainChromeEndpointAuthority = vi.fn();
    const removeProfile = vi.fn(async () => true);

    const result = await finalizeRecoveredRuntime(
      withRecoveryCleanup(
        { chromePort: 63338, userDataDir: profileDir, chromeProcessIdentity: processIdentity },
        {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
        },
      ),
      createBrowserLogger(),
      {
        verifyProfileDirectoryIdentity: vi.fn(async () => false),
        retainChromeEndpointAuthority,
        removeProfile,
      },
    );

    expect(result).toMatchObject({
      status: "pending",
      error: expect.stringContaining("physical profile generation could not be verified"),
    });
    expect(retainChromeEndpointAuthority).not.toHaveBeenCalled();
    expect(removeProfile).not.toHaveBeenCalled();
  });

  test("removes an exact temporary profile even when no process was launched", async () => {
    const profileDir = await mkdtemp(
      path.join(os.tmpdir(), "oracle-browser-missing-process-identity-"),
    );
    const profileDirectoryIdentity = (await physicalChromeProcessIdentity(profileDir))
      .profileDirectory;
    const removeProfile = vi.fn(async () => true);
    try {
      const result = await finalizeRecoveredRuntime(
        {
          userDataDir: profileDir,
          recoveryCleanupResources: [
            {
              userDataDir: profileDir,
              profileDirectoryIdentity,
              recoveryCleanup: {
                ownsTarget: false,
                profileKind: "temporary",
                keepBrowser: false,
              },
            },
          ],
        },
        createBrowserLogger(),
        { removeProfile },
      );

      expect(result.status).toBe("completed");
      expect(removeProfile).toHaveBeenCalledWith(profileDir, profileDirectoryIdentity);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("preserves cleanup when persisted process identity lacks physical profile authority", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-legacy-identity-"));
    const legacyIdentity = {
      pid: 1234,
      processStartTime: "legacy-process-generation",
      executablePath: "/usr/bin/google-chrome",
      normalizedUserDataDir: profileDir,
      launchNonce: "22222222-2222-4222-8222-222222222222",
    } as unknown as ChromeProcessIdentity;
    const runtime = withRecoveryCleanup(
      {
        chromeProcessIdentity: legacyIdentity,
        userDataDir: profileDir,
      },
      {
        ownsTarget: false,
        profileKind: "temporary",
        keepBrowser: false,
      },
    );
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    try {
      expect(() => __test__.defaultRecoveryLockPath(runtime)).not.toThrow();
      const resource = runtime.recoveryCleanupResources?.[0];
      expect(resource).toBeDefined();
      expect(() =>
        __test__.recoveryCleanupGroupKey(resource as BrowserRecoveryCleanupResourceMetadata),
      ).not.toThrow();

      const result = await finalizeRecoveredRuntime(runtime, createBrowserLogger(), {
        terminateRecordedChromeForProfile,
      });

      expect(result).toMatchObject({
        status: "pending",
        error: expect.stringContaining("no exact process/profile identity"),
      });
      expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("preserves destructive cleanup for a legacy profile identity version", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-legacy-profile-v1-"));
    const current = await captureProfileDirectoryIdentity(profileDir);
    const legacyProfile = { ...current, version: 1 } as unknown as typeof current;
    const removeProfile = vi.fn(async () => true);
    try {
      const result = await finalizeRecoveredRuntime(
        {
          userDataDir: profileDir,
          recoveryCleanupResources: [
            {
              userDataDir: profileDir,
              profileDirectoryIdentity: legacyProfile,
              recoveryCleanup: {
                ownsTarget: false,
                profileKind: "temporary",
                keepBrowser: false,
              },
            },
          ],
        },
        createBrowserLogger(),
        { removeProfile },
      );

      expect(result).toMatchObject({
        status: "pending",
        error: expect.stringContaining(
          "Chrome physical profile identity cleanup metadata is missing",
        ),
      });
      expect(removeProfile).not.toHaveBeenCalled();
      await expect(captureProfileDirectoryIdentity(profileDir)).resolves.toEqual(current);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("does not enter manual lease teardown without physical profile authority", async () => {
    const profileDir = await mkdtemp(
      path.join(os.tmpdir(), "oracle-browser-legacy-manual-profile-"),
    );
    const profileDirectory = await captureProfileDirectoryIdentity(profileDir);
    const legacyIdentity = {
      pid: 1234,
      processStartTime: "legacy-process-generation",
      executablePath:
        profileDirectory.platform === "win32"
          ? String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`
          : profileDirectory.platform === "darwin"
            ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            : "/usr/bin/google-chrome",
      normalizedUserDataDir:
        profileDirectory.platform === "win32"
          ? profileDirectory.canonicalPath.toLowerCase()
          : profileDirectory.canonicalPath,
      launchNonce: "33333333-3333-4333-8333-333333333333",
    } as unknown as ChromeProcessIdentity;
    const teardownBrowserResourcesIfNoActiveLeases = vi.fn(async () => ({
      status: "completed" as const,
    }));

    try {
      const result = await finalizeRecoveredRuntime(
        withRecoveryCleanup(
          { chromeProcessIdentity: legacyIdentity, userDataDir: profileDir },
          {
            ownsTarget: false,
            profileKind: "manual-login",
            keepBrowser: false,
          },
        ),
        createBrowserLogger(),
        { teardownBrowserResourcesIfNoActiveLeases },
      );

      expect(result).toMatchObject({
        status: "pending",
        error: expect.stringContaining("no exact process/profile identity"),
      });
      expect(teardownBrowserResourcesIfNoActiveLeases).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });
});
