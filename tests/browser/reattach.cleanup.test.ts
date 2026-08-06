import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { resumeBrowserSession, __test__ } from "../../src/browser/reattach.js";
import type { BrowserRecoveryCleanupResourceMetadata } from "../../src/sessionManager.js";
import type { BrowserLogger } from "../../src/browser/types.js";
import type { ChromeProcessIdentity } from "../../src/browser/profileState.js";
import {
  authenticatedLocalTargetCleanupDeps,
  createBrowserLogger,
  physicalChromeProcessIdentity,
  withCommittedPromptEpoch,
  withRecoveryCleanup,
  withRetainedTargetCapability,
} from "./reattachTestHelpers.js";

describe("recovery cleanup", { timeout: 15_000 }, () => {
  const { finalizeRecoveredRuntime } = __test__;
  const stopped = { status: "stopped", pid: 1234, signal: "SIGTERM" } as const;
  test("defers cleanup until finalize and runs the finalizer once", async () => {
    const events: string[] = [];
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-fallback-profile-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir);
    const runtime = withCommittedPromptEpoch(
      withRecoveryCleanup(
        {
          chromePort: 9222,
          chromeTargetId: "original-target",
          chromeProcessIdentity: processIdentity,
          userDataDir: profileDir,
        },
        {
          ownsTarget: true,
          profileKind: "temporary",
          keepBrowser: false,
          closeOwnedTargetOnComplete: true,
        },
      ),
    );
    const logger = createBrowserLogger();
    const result = await resumeBrowserSession(runtime, {}, logger, {
      recoverSession: vi.fn(async () => {
        events.push("fallback-capture");
        return { answerText: "fallback", answerMarkdown: "fallback" };
      }),
      recoveryCleanup: {
        ...authenticatedLocalTargetCleanupDeps({
          closeTarget: (targetId) => {
            events.push(`close-${targetId}`);
            return { status: "completed" };
          },
          kill: (_profileDir, pid) => {
            events.push("terminate");
            return { ...stopped, pid };
          },
        }),
        removeProfile: vi.fn(async () => {
          events.push("remove-profile");
          await rm(profileDir, { recursive: true, force: true });
          return true;
        }),
      },
    });

    expect(events).toEqual(["fallback-capture"]);
    expect(result.runtime.recoveryCleanupResult).toEqual({ status: "pending" });
    const first = await result.finalize();
    const second = await result.finalize();
    expect(first.status).toBe("completed");
    expect(second).toBe(first);
    expect(events).toEqual([
      "fallback-capture",
      "close-original-target",
      "terminate",
      "remove-profile",
    ]);
  });

  test("abort settles abort resources without running finalize", async () => {
    const finalizeResources = vi.fn(async () => ({
      status: "completed" as const,
      runtime: {},
    }));
    const abortResources = vi.fn(async () => ({
      status: "completed" as const,
      runtime: {},
    }));
    const result = await resumeBrowserSession(
      withCommittedPromptEpoch(),
      {},
      createBrowserLogger(),
      {
        recoverSession: vi.fn(async () => ({
          answerText: "captured",
          answerMarkdown: "captured",
          finalizeResources,
          abortResources,
        })),
      },
    );

    await expect(result.abort()).resolves.toMatchObject({ status: "completed" });
    expect(abortResources).toHaveBeenCalledOnce();
    expect(finalizeResources).not.toHaveBeenCalled();
  });

  test("retains cleanup authority when Chrome termination is unsafe", async () => {
    const removeProfile = vi.fn(async () => true);
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-unsafe-cleanup-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir);
    try {
      const result = await finalizeRecoveredRuntime(
        withRecoveryCleanup(
          {
            chromePort: 9222,
            userDataDir: profileDir,
            chromeProcessIdentity: processIdentity,
          },
          {
            ownsTarget: false,
            profileKind: "copied",
            keepBrowser: false,
          },
        ),
        createBrowserLogger(),
        {
          ...authenticatedLocalTargetCleanupDeps({
            kill: () => ({ status: "unsafe", reason: "pid mismatch" }),
          }),
          removeProfile,
        },
      );

      expect(result).toMatchObject({
        status: "pending",
        runtime: {
          recoveryCleanupResources: [
            expect.objectContaining({
              userDataDir: profileDir,
              chromeProcessIdentity: processIdentity,
              profileDirectoryIdentity: processIdentity.profileDirectory,
              recoveryCleanup: {
                ownsTarget: false,
                profileKind: "copied",
                keepBrowser: false,
                closeOwnedTargetOnComplete: undefined,
              },
            }),
          ],
          recoveryCleanupResult: {
            status: "failed",
            error: expect.stringContaining("pid mismatch"),
          },
        },
      });
      expect(removeProfile).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("closes every shared-process target before one teardown", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-shared-group-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir);
    const events: string[] = [];
    const oldResource = withRetainedTargetCapability({
      chromeProcessIdentity: processIdentity,
      chromePort: 9111,
      userDataDir: profileDir,
      chromeTargetId: "old-target",
      recoveryCleanup: {
        ownsTarget: true,
        profileKind: "temporary" as const,
        keepBrowser: false,
        closeOwnedTargetOnComplete: true,
      },
    });
    const currentResource = withRetainedTargetCapability({
      ...oldResource,
      chromePort: 9222,
      chromeTargetId: "current-target",
    });
    try {
      const result = await finalizeRecoveredRuntime(
        {
          chromeProcessIdentity: processIdentity,
          chromePort: 9222,
          userDataDir: profileDir,
          chromeTargetId: "current-target",
          recoveryCleanupResources: [oldResource, { ...oldResource }, currentResource],
        },
        createBrowserLogger(),
        {
          ...authenticatedLocalTargetCleanupDeps({
            closeTarget: (targetId) => {
              events.push(`close:${targetId}`);
              return { status: "completed" };
            },
            kill: (_profileDir, pid) => {
              events.push("terminate");
              return { ...stopped, pid };
            },
          }),
          removeProfile: vi.fn(async () => {
            events.push("remove-profile");
            return true;
          }),
        },
      );

      expect(result.status).toBe("completed");
      expect(events).toEqual([
        "close:old-target",
        "close:current-target",
        "terminate",
        "remove-profile",
      ]);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });
  test("holds the current lease through shared target close and atomic manual teardown", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-manual-lease-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir, 5151);
    try {
      const events: string[] = [];
      const releaseBrowserTabLease = vi.fn(
        async (
          _profileDir: string,
          _leaseId: string,
          _logger: BrowserLogger | undefined,
          options?: {
            onRelease?: (context: { isLastLease: boolean }) => Promise<void>;
            expectedProfileIdentity?: ChromeProcessIdentity["profileDirectory"];
          },
        ) => {
          events.push("release-current-lease");
          await options?.onRelease?.({ isLastLease: true });
        },
      );
      const oldResource: BrowserRecoveryCleanupResourceMetadata = withRetainedTargetCapability({
        chromeProcessIdentity: processIdentity,
        profileDirectoryIdentity: processIdentity.profileDirectory,
        chromePort: 9222,
        userDataDir: profileDir,
        chromeTargetId: "old-target",
        recoveryCleanup: {
          ownsTarget: true,
          profileKind: "manual-login",
          keepBrowser: false,
          closeOwnedTargetOnComplete: true,
        },
      });
      const currentResource: BrowserRecoveryCleanupResourceMetadata = withRetainedTargetCapability({
        ...oldResource,
        chromeTargetId: "current-target",
        tabLease: {
          id: "current-lease",
          profileDirectory: processIdentity.profileDirectory,
        },
      });
      const result = await finalizeRecoveredRuntime(
        {
          chromeProcessIdentity: processIdentity,
          chromePort: 9222,
          userDataDir: profileDir,
          chromeTargetId: "current-target",
          recoveryCleanupResources: [oldResource, currentResource],
        },
        createBrowserLogger(),
        {
          ...authenticatedLocalTargetCleanupDeps({
            closeTarget: (targetId) => {
              events.push(`close:${targetId}`);
              return { status: "completed" };
            },
            kill: (_profileDir, pid) => {
              events.push("terminate");
              return { ...stopped, pid };
            },
          }),
          cleanupStaleProfileState: vi.fn(async () => {
            events.push("cleanup-profile-state");
            return true;
          }),
          releaseBrowserTabLease,
        },
      );

      expect(result.status).toBe("completed");
      expect(events).toEqual([
        "close:old-target",
        "close:current-target",
        "release-current-lease",
        "terminate",
        "cleanup-profile-state",
      ]);
      expect(releaseBrowserTabLease).toHaveBeenCalledOnce();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("lets exact old-process teardown settle target failure without blocking current cleanup", async () => {
    const oldProfile = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-old-group-"));
    const currentProfile = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-current-group-"));
    const events: string[] = [];
    const oldIdentity = await physicalChromeProcessIdentity(oldProfile, 1111);
    const currentIdentity = await physicalChromeProcessIdentity(currentProfile, 2222);
    const oldResource: BrowserRecoveryCleanupResourceMetadata = withRetainedTargetCapability({
      chromeProcessIdentity: oldIdentity,
      profileDirectoryIdentity: oldIdentity.profileDirectory,
      chromePort: 9222,
      userDataDir: oldProfile,
      chromeTargetId: "old-target",
      recoveryCleanup: {
        ownsTarget: true,
        profileKind: "temporary",
        keepBrowser: false,
        closeOwnedTargetOnComplete: true,
      },
    });
    const currentResource: BrowserRecoveryCleanupResourceMetadata = withRetainedTargetCapability({
      chromeProcessIdentity: currentIdentity,
      profileDirectoryIdentity: currentIdentity.profileDirectory,
      chromePort: 9333,
      userDataDir: currentProfile,
      chromeTargetId: "current-target",
      recoveryCleanup: {
        ownsTarget: true,
        profileKind: "temporary",
        keepBrowser: false,
        closeOwnedTargetOnComplete: true,
      },
    });
    try {
      const result = await finalizeRecoveredRuntime(
        {
          chromeProcessIdentity: currentIdentity,
          chromePort: 9333,
          userDataDir: currentProfile,
          chromeTargetId: "current-target",
          recoveryCleanupResources: [oldResource, currentResource],
        },
        createBrowserLogger(),
        {
          ...authenticatedLocalTargetCleanupDeps({
            closeTarget: (targetId) => {
              events.push(`close:${targetId}`);
              return targetId === "old-target"
                ? { status: "unsafe", reason: "old target close failed" }
                : { status: "completed" };
            },
            kill: (profileDir, pid) => {
              events.push(`terminate:${profileDir}`);
              return { ...stopped, pid };
            },
          }),
          removeProfile: vi.fn(async (profileDir) => {
            events.push(`remove:${profileDir}`);
            return true;
          }),
        },
      );

      expect(result.status).toBe("completed");
      expect(events).toEqual([
        "close:old-target",
        `terminate:${oldProfile}`,
        `remove:${oldProfile}`,
        "close:current-target",
        `terminate:${currentProfile}`,
        `remove:${currentProfile}`,
      ]);
      expect(result.runtime.recoveryCleanupResources).toBeUndefined();
    } finally {
      await rm(oldProfile, { recursive: true, force: true });
      await rm(currentProfile, { recursive: true, force: true });
    }
  }, 15_000);

  test("retries only resources that failed the previous cleanup pass", async () => {
    const oldProfile = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-retry-old-group-"));
    const currentProfile = await mkdtemp(
      path.join(os.tmpdir(), "oracle-browser-retry-current-group-"),
    );
    const events: string[] = [];
    let oldAttempts = 0;
    let oldTerminationAttempts = 0;
    const cleanupDeps = {
      ...authenticatedLocalTargetCleanupDeps({
        closeTarget: (targetId) => {
          events.push(`close:${targetId}`);
          if (targetId !== "old-target") return { status: "completed" };
          oldAttempts += 1;
          return oldAttempts > 1
            ? { status: "completed" }
            : { status: "unsafe", reason: "old target close failed" };
        },
        kill: (profileDir, pid) => {
          events.push(`terminate:${profileDir}`);
          if (profileDir === oldProfile) {
            oldTerminationAttempts += 1;
            if (oldTerminationAttempts === 1) {
              return { status: "unsafe", pid, reason: "old process teardown failed" };
            }
          }
          return { ...stopped, pid };
        },
      }),
      removeProfile: vi.fn(async (profileDir: string) => {
        events.push(`remove:${profileDir}`);
        return true;
      }),
    };
    const oldIdentity = await physicalChromeProcessIdentity(oldProfile, 3333);
    const currentIdentity = await physicalChromeProcessIdentity(currentProfile, 4444);
    const oldResource: BrowserRecoveryCleanupResourceMetadata = withRetainedTargetCapability({
      chromeProcessIdentity: oldIdentity,
      profileDirectoryIdentity: oldIdentity.profileDirectory,
      chromePort: 9333,
      userDataDir: oldProfile,
      chromeTargetId: "old-target",
      recoveryCleanup: {
        ownsTarget: true,
        profileKind: "temporary",
        keepBrowser: false,
        closeOwnedTargetOnComplete: true,
      },
    });
    const currentResource: BrowserRecoveryCleanupResourceMetadata = withRetainedTargetCapability({
      chromeProcessIdentity: currentIdentity,
      profileDirectoryIdentity: currentIdentity.profileDirectory,
      chromePort: 9444,
      userDataDir: currentProfile,
      chromeTargetId: "current-target",
      recoveryCleanup: {
        ownsTarget: true,
        profileKind: "temporary",
        keepBrowser: false,
        closeOwnedTargetOnComplete: true,
      },
    });
    try {
      const first = await finalizeRecoveredRuntime(
        {
          chromeProcessIdentity: currentIdentity,
          chromePort: 9444,
          userDataDir: currentProfile,
          chromeTargetId: "current-target",
          recoveryCleanupResources: [oldResource, currentResource],
        },
        createBrowserLogger(),
        cleanupDeps,
      );

      expect(first.status).toBe("pending");
      expect(first.runtime.recoveryCleanupResources).toHaveLength(2);
      expect(
        first.runtime.recoveryCleanupResources?.every(
          (resource) => resource.userDataDir === oldProfile,
        ),
      ).toBe(true);
      const second = await finalizeRecoveredRuntime(
        first.runtime,
        createBrowserLogger(),
        cleanupDeps,
      );

      expect(second.status).toBe("completed");
      expect(events).toEqual([
        "close:old-target",
        `terminate:${oldProfile}`,
        "close:current-target",
        `terminate:${currentProfile}`,
        `remove:${currentProfile}`,
        "close:old-target",
        `terminate:${oldProfile}`,
        `remove:${oldProfile}`,
      ]);
    } finally {
      await rm(oldProfile, { recursive: true, force: true });
      await rm(currentProfile, { recursive: true, force: true });
    }
  });
});
