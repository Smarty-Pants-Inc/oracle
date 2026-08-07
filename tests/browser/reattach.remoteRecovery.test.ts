import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { retryBrowserRecoveryCleanup, __test__ } from "../../src/browser/reattach.js";
import { acquireReattachRecoveryLock } from "../../src/browser/reattachLock.js";
import { establishPrivateRuntimeAuthority } from "../../src/privateTempRoot.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";
import type { RemoteRecoverySettlementOptions } from "../../src/remote/types.js";
import { acquireBrowserTabLease } from "../../src/browser/tabLeaseRegistry.js";
import {
  authenticatedLocalTargetCleanupDeps,
  createBrowserLogger,
  physicalChromeProcessIdentity,
  syntheticChromeProcessIdentity,
  withCommittedPromptEpoch,
  withRecoveryCleanup,
} from "./reattachTestHelpers.js";

describe("remote recovery cleanup", { timeout: 15_000 }, () => {
  const { finalizeRecoveredRuntime } = __test__;
  const stopped = { status: "stopped", pid: 1234, signal: "SIGTERM" } as const;
  test("preserves a direct remote-CDP target without retained transaction authority", async () => {
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const result = await finalizeRecoveredRuntime(
      withCommittedPromptEpoch(
        withRecoveryCleanup(
          {
            chromeHost: "remote.example.test",
            chromePort: 9222,
            chromeBrowserWSEndpoint: "wss://remote.example.test/devtools/browser/direct",
            chromeTargetId: "direct-owned-target",
          },
          {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        ),
      ),
      createBrowserLogger(),
      { terminateRecordedChromeForProfile },
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
        recoveryCleanupResources: [
          expect.objectContaining({ chromeTargetId: "direct-owned-target" }),
        ],
      },
    });
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });
  test.each(["finalize", "abort"] as const)(
    "%s preserves an explicitly retained owned target",
    async (mode) => {
      const profileDir = path.join(os.tmpdir(), "oracle-browser-reused-owner-target");
      const processIdentity = syntheticChromeProcessIdentity(profileDir, 9_105);
      const closeChromeTargetWithRetainedCapability = vi.fn(async () => ({
        status: "completed" as const,
      }));
      const runtime = withRecoveryCleanup(
        {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeProcessIdentity: processIdentity,
          userDataDir: profileDir,
          chromeTargetId: "reused-owner-target",
        },
        {
          ownsTarget: true,
          profileKind: "none",
          keepBrowser: true,
          closeOwnedTargetOnComplete: false,
        },
      );

      await expect(
        finalizeRecoveredRuntime(
          runtime,
          createBrowserLogger(),
          { ...authenticatedLocalTargetCleanupDeps(), closeChromeTargetWithRetainedCapability },
          mode,
        ),
      ).resolves.toMatchObject({ status: "completed" });
      expect(closeChromeTargetWithRetainedCapability).not.toHaveBeenCalled();
    },
  );

  test.each(["finalize", "abort"] as const)(
    "%s closes an explicitly disposable recovered owned target",
    async (mode) => {
      const profileDir = path.join(os.tmpdir(), "oracle-browser-disposable-owner-target");
      const processIdentity = syntheticChromeProcessIdentity(profileDir, 9_106);
      const closeChromeTargetWithRetainedCapability = vi.fn(async () => ({
        status: "completed" as const,
      }));
      const runtime = withRecoveryCleanup(
        {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeProcessIdentity: processIdentity,
          userDataDir: profileDir,
          chromeTargetId: "disposable-owner-target",
        },
        {
          ownsTarget: true,
          profileKind: "none",
          keepBrowser: false,
          closeOwnedTargetOnComplete: true,
        },
      );

      await expect(
        finalizeRecoveredRuntime(
          runtime,
          createBrowserLogger(),
          { ...authenticatedLocalTargetCleanupDeps(), closeChromeTargetWithRetainedCapability },
          mode,
        ),
      ).resolves.toMatchObject({ status: "completed" });
      expect(closeChromeTargetWithRetainedCapability).toHaveBeenCalledOnce();
    },
  );

  test.each(["finalize", "abort"] as const)(
    "%s fails closed when an owned target lacks its persisted close disposition",
    async (mode) => {
      const runtime = withRecoveryCleanup(
        {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeTargetId: "missing-close-disposition",
        },
        {
          ownsTarget: true,
          profileKind: "none",
          keepBrowser: true,
        },
      );

      await expect(
        finalizeRecoveredRuntime(runtime, createBrowserLogger(), {}, mode),
      ).resolves.toMatchObject({
        status: "pending",
        error: expect.stringContaining("close disposition is missing"),
      });
    },
  );

  test("settles remote cleanup once without direct host Chrome operations", async () => {
    const remoteRecovery = {
      protocolVersion: 3,
      host: "remote.example.test:9443",
      transactionToken: "a".repeat(64),
      state: "pending" as const,
    };
    const runtime = withCommittedPromptEpoch(
      withRecoveryCleanup(
        {
          chromeHost: "remote.example.test",
          chromePort: 9222,
          chromeTargetId: "remote-owned-target",
        },
        {
          ownsTarget: true,
          profileKind: "none",
          keepBrowser: false,
          closeOwnedTargetOnComplete: true,
        },
        remoteRecovery,
      ),
    );
    const currentResource = runtime.recoveryCleanupResources?.[0];
    if (!currentResource) throw new Error("test cleanup resource is missing");
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const settleRemoteBrowserRecovery = vi.fn(async () => ({
      status: "completed" as const,
      runtime: {},
    }));
    const resolveRemoteRecoveryConfig = vi.fn(async () => ({
      host: remoteRecovery.host,
      token: "configured-auth-secret",
    }));
    const result = await finalizeRecoveredRuntime(
      {
        ...runtime,
        recoveryCleanupResources: [
          {
            ...currentResource,
            chromeHost: "stale-remote.example.test",
            chromePort: 9111,
            chromeTargetId: "borrowed-target",
            recoveryCleanup: {
              ownsTarget: false,
              profileKind: "none",
              keepBrowser: false,
            },
          },
          currentResource,
        ],
      },
      createBrowserLogger(),
      {
        terminateRecordedChromeForProfile,
        settleRemoteBrowserRecovery,
        resolveRemoteRecoveryConfig,
        isRemotePublicationAcknowledged: () => true,
      },
    );

    expect(result.status).toBe("completed");
    expect(settleRemoteBrowserRecovery).toHaveBeenCalledOnce();
    expect(settleRemoteBrowserRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        configuredHost: remoteRecovery.host,
        authToken: "configured-auth-secret",
        runtime: expect.objectContaining({
          recoveryCleanupResources: expect.arrayContaining([
            expect.objectContaining({ remoteRecovery }),
          ]),
        }),
        mode: "finalize",
      }),
    );
    expect(resolveRemoteRecoveryConfig).toHaveBeenCalledOnce();
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });

  test("retries no-target cleanup through exact endpoint shutdown under the recovery lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-retry-test-"));
    const lockAuthority = await establishPrivateRuntimeAuthority({ tempDirectory: root });
    const profileDir = await mkdtemp(path.join(root, "oracle-browser-retry-cleanup-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir);
    const events: string[] = [];
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    try {
      const result = await retryBrowserRecoveryCleanup(
        withRecoveryCleanup(
          {
            chromePort: 9222,
            userDataDir: profileDir,
            chromeProcessIdentity: processIdentity,
            recoveryCleanupResult: {
              status: "failed",
              error: "previous termination failure",
              settlementMode: "finalize",
            },
          },
          {
            ownsTarget: false,
            profileKind: "temporary",
            keepBrowser: false,
          },
        ),
        createBrowserLogger(),
        {
          recoveryLockPath: path.join(lockAuthority.path, "browser-recovery.lock"),
          acquireRecoveryLock: (lockPath) => acquireReattachRecoveryLock(lockPath, lockAuthority),
          recoveryCleanup: {
            ...authenticatedLocalTargetCleanupDeps({
              kill: (_profileDir, pid) => {
                events.push("browser-close");
                return { ...stopped, pid };
              },
              onRelease: () => events.push("release-endpoint"),
            }),
            terminateRecordedChromeForProfile,
            removeProfile: vi.fn(async () => {
              events.push("remove-profile");
              return true;
            }),
          },
        },
      );

      expect(result).toEqual({
        status: "completed",
        runtime: {
          chromePort: 9222,
          userDataDir: profileDir,
          chromeProcessIdentity: processIdentity,
        },
      });
      expect(events).toEqual(["browser-close", "remove-profile", "release-endpoint"]);
      expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves a journaled target acquisition marker after restart", async () => {
    const markerUrl = "about:blank#oracle-acquisition=marker-generation";
    const profileDir = path.join(os.tmpdir(), "oracle-browser-marker-generation");
    const processIdentity = syntheticChromeProcessIdentity(profileDir, 9_106);
    const closeChromeTargetWithExactAuthority = vi.fn(async () => ({
      status: "completed" as const,
    }));
    const listChromeTargetsWithExactAuthority = vi.fn(async () => ({
      status: "completed" as const,
      value: [
        {
          targetId: "marker-target",
          type: "page",
          url: markerUrl,
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/marker-target",
        },
      ],
    }));
    const runtime: BrowserRuntimeMetadata = {
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeProcessIdentity: processIdentity,
      userDataDir: profileDir,
      recoveryCleanupResources: [
        {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeProcessIdentity: processIdentity,
          profileDirectoryIdentity: processIdentity.profileDirectory,
          userDataDir: profileDir,
          acquisition: {
            generationId: "marker-generation",
            pendingResource: "chrome-target",
            targetMarkerUrl: markerUrl,
          },
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: true,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
      recoveryCleanupResult: {
        status: "failed",
        error: "controller exited after target creation",
        settlementMode: "abort",
      },
    };

    await expect(
      retryBrowserRecoveryCleanup(runtime, createBrowserLogger(), {
        acquireRecoveryLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
        recoveryCleanup: {
          ...authenticatedLocalTargetCleanupDeps(),
          closeChromeTargetWithExactAuthority,
          listChromeTargetsWithExactAuthority,
        },
      }),
    ).resolves.toMatchObject({
      status: "pending",
      error: expect.stringContaining(
        "target acquisition ended before exact target close authority was published",
      ),
      runtime: {
        recoveryCleanupResources: [
          expect.objectContaining({
            acquisition: expect.objectContaining({ pendingResource: "chrome-target" }),
          }),
        ],
      },
    });
    expect(listChromeTargetsWithExactAuthority).not.toHaveBeenCalled();
    expect(closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
  });

  test("preserves manual-login resources while another lease is active", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-active-lease-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir);
    try {
      const kill = vi.fn();
      const cleanupStaleProfileState = vi.fn(async () => true);
      const result = await finalizeRecoveredRuntime(
        withRecoveryCleanup(
          {
            chromePort: 9222,
            userDataDir: profileDir,
            chromeProcessIdentity: processIdentity,
          },
          {
            ownsTarget: false,
            profileKind: "manual-login",
            keepBrowser: false,
          },
        ),
        createBrowserLogger(),
        {
          ...authenticatedLocalTargetCleanupDeps({
            kill: (_profileDir, pid) => {
              kill();
              return { ...stopped, pid };
            },
          }),
          teardownBrowserResourcesIfNoActiveLeases: vi.fn(async () => ({
            status: "preserved" as const,
            reason: "active-leases" as const,
          })),
          cleanupStaleProfileState,
        },
      );

      expect(result.status).toBe("pending");
      expect(kill).not.toHaveBeenCalled();
      expect(cleanupStaleProfileState).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("replays exact teardown when last lease cleanup completed before result persistence", async () => {
    const profileDir = await mkdtemp(
      path.join(os.tmpdir(), "oracle-browser-missing-lease-replay-"),
    );
    const processIdentity = await physicalChromeProcessIdentity(profileDir);
    try {
      const lease = await acquireBrowserTabLease(profileDir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "test-owner",
        generationId: "missing-lease-replay-generation",
      });
      const staleRuntime = withRecoveryCleanup(
        { chromePort: 9222, userDataDir: profileDir, chromeProcessIdentity: processIdentity },
        {
          ownsTarget: false,
          profileKind: "manual-login",
          keepBrowser: false,
        },
      );
      const staleResource = staleRuntime.recoveryCleanupResources?.[0];
      if (!staleResource) throw new Error("missing cleanup resource fixture");
      staleResource.tabLease = {
        id: lease.id,
        generationId: lease.generationId,
        profileDirectory: lease.profileDirectory,
      };
      const kill = vi.fn();
      const cleanupStaleProfileState = vi.fn(async () => true);
      const deps = {
        ...authenticatedLocalTargetCleanupDeps({
          kill: (_profileDir, pid) => {
            kill();
            return { ...stopped, pid };
          },
        }),
        cleanupStaleProfileState,
      };

      await expect(
        finalizeRecoveredRuntime(staleRuntime, createBrowserLogger(), deps),
      ).resolves.toMatchObject({ status: "completed" });
      await expect(
        finalizeRecoveredRuntime(staleRuntime, createBrowserLogger(), deps),
      ).resolves.toMatchObject({ status: "completed" });

      expect(kill).toHaveBeenCalledTimes(2);
      expect(cleanupStaleProfileState).toHaveBeenCalledTimes(2);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("terminates and clears manual-login state inside atomic teardown", async () => {
    const events: string[] = [];
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-manual-teardown-"));
    const processIdentity = await physicalChromeProcessIdentity(profileDir);
    try {
      const cleanupStaleProfileState = vi.fn(async () => {
        events.push("cleanup-profile-state");
        return true;
      });
      const teardownBrowserResourcesIfNoActiveLeases = vi.fn(
        async (_dir: string, teardown: () => Promise<boolean>) =>
          (await teardown())
            ? { status: "completed" as const }
            : { status: "preserved" as const, reason: "teardown-unsafe" as const },
      );
      const result = await finalizeRecoveredRuntime(
        withRecoveryCleanup(
          { chromePort: 9222, userDataDir: profileDir, chromeProcessIdentity: processIdentity },
          {
            ownsTarget: false,
            profileKind: "manual-login",
            keepBrowser: false,
          },
        ),
        createBrowserLogger(),
        {
          ...authenticatedLocalTargetCleanupDeps({
            kill: (_profileDir, pid) => {
              events.push("terminate");
              return { ...stopped, pid };
            },
          }),
          teardownBrowserResourcesIfNoActiveLeases,
          cleanupStaleProfileState,
        },
      );

      expect(result.status).toBe("completed");
      expect(events).toEqual(["terminate", "cleanup-profile-state"]);
      expect(cleanupStaleProfileState).toHaveBeenCalledWith(profileDir, expect.any(Function), {
        lockRemovalMode: "never",
        expectedProfileIdentity: processIdentity.profileDirectory,
      });
      expect(teardownBrowserResourcesIfNoActiveLeases).toHaveBeenCalledWith(
        profileDir,
        expect.any(Function),
        {
          logger: expect.any(Function),
          expectedProfileIdentity: processIdentity.profileDirectory,
        },
      );
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("keeps remote settlement retryable and idempotent without CDP fallback", async () => {
    const remoteRecovery = {
      protocolVersion: 3,
      host: "remote.example.test:9443",
      transactionToken: "b".repeat(64),
      state: "pending" as const,
    };
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    let attempts = 0;
    const settlementModes: Array<"finalize" | "abort"> = [];
    const settleRemoteBrowserRecovery = vi.fn(
      async ({ runtime, mode }: RemoteRecoverySettlementOptions) => {
        settlementModes.push(mode ?? "finalize");
        attempts += 1;
        if (attempts === 1) {
          return {
            status: "pending" as const,
            runtime: {
              ...runtime,
              recoveryCleanupResult: {
                status: "failed" as const,
                error: "remote finalize still pending",
              },
            },
            error: "remote finalize still pending",
          };
        }
        return { status: "completed" as const, runtime: {} };
      },
    );
    const resolveRemoteRecoveryConfig = vi.fn(async () => ({
      host: remoteRecovery.host,
      token: "configured-auth-secret",
    }));
    const deps = {
      terminateRecordedChromeForProfile,
      settleRemoteBrowserRecovery,
      resolveRemoteRecoveryConfig,
      isRemotePublicationAcknowledged: () => true,
    };
    const first = await finalizeRecoveredRuntime(
      withCommittedPromptEpoch(
        withRecoveryCleanup(
          {
            chromeHost: "remote.example.test",
            chromePort: 9222,
            chromeBrowserWSEndpoint: "wss://remote.example.test/devtools/browser/abc",
            chromeTargetId: "remote-owned-target",
          },
          {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
          remoteRecovery,
        ),
      ),
      createBrowserLogger(),
      deps,
    );

    expect(first).toMatchObject({
      status: "pending",
      runtime: {
        recoveryCleanupResources: [
          expect.objectContaining({
            chromeHost: "remote.example.test",
            chromePort: 9222,
            chromeBrowserWSEndpoint: "wss://remote.example.test/devtools/browser/abc",
            chromeTargetId: "remote-owned-target",
            remoteRecovery,
            conversationId: "test-conversation",
            promptEpoch: expect.objectContaining({
              status: "committed",
              verifiedUserTurnId: "turn-1",
              verifiedUserMessageId: "message-1",
            }),
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "none",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          }),
        ],
      },
    });
    expect(JSON.stringify(first.runtime)).not.toContain("configured-auth-secret");
    const second = await retryBrowserRecoveryCleanup(
      first.runtime,
      createBrowserLogger(),
      {
        recoveryCleanup: deps,
        acquireRecoveryLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
        isRemotePublicationAcknowledged: () => true,
      },
      "finalize",
    );
    expect(second.status).toBe("completed");
    expect(settleRemoteBrowserRecovery).toHaveBeenCalledTimes(2);
    expect(resolveRemoteRecoveryConfig).toHaveBeenCalledTimes(2);
    expect(settlementModes).toEqual(["finalize", "finalize"]);
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });
});
