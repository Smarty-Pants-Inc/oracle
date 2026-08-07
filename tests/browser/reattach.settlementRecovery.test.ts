import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  resumeBrowserSession,
  retryBrowserRecoveryCleanup,
  settleBrowserRecoveryCleanup,
  __test__,
} from "../../src/browser/reattach.js";
import { acquireReattachRecoveryLock } from "../../src/browser/reattachLock.js";
import { establishPrivateRuntimeAuthority } from "../../src/privateTempRoot.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";
import type { BrowserCaptureFinalizationResult } from "../../src/browser/types.js";
import {
  __test__ as targetCloseAuthorityTest,
  closeChromeTargetWithRetainedCapability,
  retainChromeTargetCloseCapability,
} from "../../src/browser/targetCloseAuthority.js";
import { completedBrowserCaptureCleanup } from "../../src/browser/ownedBrowserResources.js";
import { createReattachSettlement } from "../../src/browser/reattachSettlement.js";
import {
  authenticatedLocalTargetCleanupDeps,
  createBrowserLogger,
  createTemporaryProfileFixture,
  syntheticChromeProcessIdentity,
  withCommittedPromptEpoch,
  withRecoveryCleanup,
  withRetainedTargetCapability,
} from "./reattachTestHelpers.js";

describe("recovery settlement retries", { timeout: 15_000 }, () => {
  const { finalizeRecoveredRuntime } = __test__;
  const stopped = { status: "stopped", pid: 1234, signal: "SIGTERM" } as const;
  test("retains release-pending authority until a later lock release completes", async () => {
    targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
    const logger = createBrowserLogger();
    const targetId = "release-pending-target";
    const generationId = "d0000000-0000-4000-8000-00000000000d";
    const closeTarget = vi.fn(async () => ({ status: "completed" as const }));
    const targetCloseCapability = retainChromeTargetCloseCapability({
      ownerId: "test-owner",
      generationId,
      targetId,
      close: closeTarget,
    });
    const runtime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          chromeTargetId: targetId,
          targetCloseCapability,
          acquisition: { generationId },
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "manual-login",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
    };
    let durableRuntime = runtime;
    let releaseAttempt = 0;
    const acquireRecoveryLock = vi.fn(async () => ({
      release: async (complete?: () => Promise<void>) => {
        releaseAttempt += 1;
        if (releaseAttempt === 1) throw new Error("directory sync failed");
        await complete?.();
      },
    }));
    const finalizeRuntime = vi.fn(async (currentRuntime: BrowserRuntimeMetadata) => {
      const resource = currentRuntime.recoveryCleanupResources?.[0];
      if (!resource?.targetCloseCapability || !resource.chromeTargetId) {
        throw new Error("Target close authority is missing");
      }
      await closeChromeTargetWithRetainedCapability({
        ownerId: "test-owner",
        capability: resource.targetCloseCapability,
        targetId: resource.chromeTargetId,
        logger,
      });
      return completedBrowserCaptureCleanup(currentRuntime);
    });
    const persist = vi.fn(async (result: BrowserCaptureFinalizationResult) => {
      durableRuntime = result.runtime;
      return result;
    });

    const first = await settleBrowserRecoveryCleanup(
      runtime,
      logger,
      {
        ownerId: "test-owner",
        acquireRecoveryLock,
        loadRuntimeUnderLock: async () => durableRuntime,
        persistFinalizationResult: persist,
        completeFinalizationAfterLockRelease: persist,
        finalizeRuntime,
      },
      "finalize",
    );

    expect(first.finalization).toEqual({ status: "completed", runtime: {} });
    expect(first.persistence).toMatchObject({ status: "pending" });
    expect(durableRuntime.recoveryCleanupResult).toMatchObject({
      settlementMode: "finalize",
      lockReleasePending: true,
    });
    expect(durableRuntime.recoveryCleanupResources).toHaveLength(1);
    expect(targetCloseAuthorityTest.retainedAcknowledgedTerminalTargetCloseAuthorityCount()).toBe(
      0,
    );

    const second = await settleBrowserRecoveryCleanup(
      runtime,
      logger,
      {
        ownerId: "test-owner",
        acquireRecoveryLock,
        loadRuntimeUnderLock: async () => durableRuntime,
        persistFinalizationResult: persist,
        completeFinalizationAfterLockRelease: persist,
        finalizeRuntime,
      },
      "finalize",
    );

    expect(second).toMatchObject({
      finalization: { status: "completed" },
      persistence: { status: "persisted" },
    });
    expect(finalizeRuntime).toHaveBeenCalledOnce();
    expect(closeTarget).toHaveBeenCalledOnce();
    expect(durableRuntime.recoveryCleanupResources).toBeUndefined();
    expect(durableRuntime.recoveryCleanupResult).toBeUndefined();
    expect(targetCloseAuthorityTest.retainedAcknowledgedTerminalTargetCloseAuthorityCount()).toBe(
      1,
    );
    targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
  });
  test.each([
    {
      authorityCase: "a reserialized exact",
      transactionToken: "c".repeat(64),
      expectedCaptureCalls: 1,
      expectedRecoveryCalls: 0,
    },
    {
      authorityCase: "a replacement",
      transactionToken: "d".repeat(64),
      expectedCaptureCalls: 0,
      expectedRecoveryCalls: 1,
    },
  ])(
    "uses captured cleanup only for $authorityCase authority",
    async ({ transactionToken, expectedCaptureCalls, expectedRecoveryCalls }) => {
      const remoteRecovery = {
        protocolVersion: 3,
        host: "remote.example.test:9443",
        transactionToken: "c".repeat(64),
        state: "pending" as const,
      };
      const captureRuntime = withCommittedPromptEpoch(
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
      const capturedResource = captureRuntime.recoveryCleanupResources?.[0];
      if (!capturedResource) throw new Error("Missing captured cleanup authority fixture");
      const { recoveryCleanup, ...resourceAuthority } = capturedResource;
      let durableRuntime: BrowserRuntimeMetadata = {
        ...captureRuntime,
        recoveryCleanupResources: [
          {
            recoveryCleanup,
            ...resourceAuthority,
            remoteRecovery: { ...remoteRecovery, transactionToken },
          },
        ],
      };
      const finalizeResources = vi.fn(async () => ({
        status: "completed" as const,
        runtime: {},
      }));
      const settleRemoteBrowserRecovery = vi.fn(async () => ({
        status: "completed" as const,
        runtime: {},
      }));
      const release = vi.fn(async (complete?: () => Promise<void>) => {
        await complete?.();
      });
      const result = createReattachSettlement(
        {
          answerText: "captured",
          answerMarkdown: "captured",
          runtime: captureRuntime,
          finalizeResources,
        },
        captureRuntime,
        null,
        createBrowserLogger(),
        {
          loadRuntimeUnderLock: async () => durableRuntime,
          runtimeHintCb: async (runtime) => {
            durableRuntime = runtime;
          },
          recoveryCleanup: {
            settleRemoteBrowserRecovery,
            resolveRemoteRecoveryConfig: async () => ({ host: remoteRecovery.host }),
          },
          isRemotePublicationAcknowledged: () => true,
        },
        { ensure: async () => undefined, release },
      );

      await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
      expect(finalizeResources).toHaveBeenCalledTimes(expectedCaptureCalls);
      expect(settleRemoteBrowserRecovery).toHaveBeenCalledTimes(expectedRecoveryCalls);
    },
  );

  test("requires durable remote publication before finalize but permits abort", async () => {
    const remoteRecovery = {
      protocolVersion: 3,
      host: "remote.example.test:9443",
      transactionToken: "c".repeat(64),
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
    const settleRemoteBrowserRecovery = vi.fn(async () => ({
      status: "completed" as const,
      runtime: {},
    }));
    const deps = {
      settleRemoteBrowserRecovery,
      resolveRemoteRecoveryConfig: vi.fn(async () => ({ host: remoteRecovery.host })),
      isRemotePublicationAcknowledged: () => false,
    };

    const blocked = await finalizeRecoveredRuntime(runtime, createBrowserLogger(), deps);
    expect(blocked).toMatchObject({
      status: "pending",
      error: expect.stringContaining("durable answer publication acknowledgment"),
    });
    expect(settleRemoteBrowserRecovery).not.toHaveBeenCalled();

    const aborted = await finalizeRecoveredRuntime(
      blocked.runtime,
      createBrowserLogger(),
      deps,
      "abort",
    );
    expect(aborted.status).toBe("completed");
    expect(settleRemoteBrowserRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "abort" }),
    );
  });

  test("rejects a conflicting explicit remote settlement mode under the lock", async () => {
    const remoteRecovery = {
      protocolVersion: 3,
      host: "remote.example.test:9443",
      transactionToken: "e".repeat(64),
      state: "pending" as const,
    };
    const runtime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          remoteRecovery,
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "none",
            keepBrowser: false,
          },
        },
      ],
      recoveryCleanupResult: {
        status: "failed",
        error: "retry finalize",
        settlementMode: "finalize",
      },
    };
    const release = vi.fn(async () => undefined);
    const acquireRecoveryLock = vi.fn(async () => ({ release }));

    await expect(
      retryBrowserRecoveryCleanup(runtime, createBrowserLogger(), { acquireRecoveryLock }, "abort"),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: { code: "settlement-mode-conflict", runtime },
    });
    expect(acquireRecoveryLock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  test.each(["finalize", "abort"] as const)(
    "retries local cleanup using its persisted %s settlement mode",
    async (settlementMode) => {
      const profileDir = path.join(
        os.tmpdir(),
        `oracle-browser-persisted-${settlementMode}-settlement`,
      );
      const processIdentity = syntheticChromeProcessIdentity(profileDir, 9_107);
      const runtime: BrowserRuntimeMetadata = {
        chromeProcessIdentity: processIdentity,
        userDataDir: profileDir,
        recoveryCleanupResult: {
          status: "failed",
          error: "interrupted settlement",
          settlementMode,
        },
        recoveryCleanupResources: [
          withRetainedTargetCapability({
            chromeHost: "127.0.0.1",
            chromePort: 9222,
            chromeProcessIdentity: processIdentity,
            profileDirectoryIdentity: processIdentity.profileDirectory,
            userDataDir: profileDir,
            chromeTargetId: "owned-local-target",
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "none",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          }),
        ],
      };
      const closeChromeTargetWithRetainedCapability = vi
        .fn()
        .mockResolvedValueOnce({ status: "unsafe", reason: "target close was not confirmed" })
        .mockResolvedValueOnce({ status: "completed" });

      const result = await retryBrowserRecoveryCleanup(runtime, createBrowserLogger(), {
        ownerId: "test-owner",
        acquireRecoveryLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
        recoveryCleanup: {
          ...authenticatedLocalTargetCleanupDeps(),
          closeChromeTargetWithRetainedCapability,
        },
      });

      expect(result).toMatchObject({
        status: "pending",
        runtime: {
          recoveryCleanupResult: {
            status: "failed",
            settlementMode,
          },
        },
      });
      expect(closeChromeTargetWithRetainedCapability).toHaveBeenCalledOnce();
      await expect(
        retryBrowserRecoveryCleanup(
          runtime,
          createBrowserLogger(),
          {
            acquireRecoveryLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
            loadRuntimeUnderLock: async () => result.runtime,
          },
          settlementMode === "finalize" ? "abort" : "finalize",
        ),
      ).rejects.toMatchObject({
        details: { code: "settlement-mode-conflict" },
      });
      await expect(
        retryBrowserRecoveryCleanup(result.runtime, createBrowserLogger(), {
          ownerId: "test-owner",
          acquireRecoveryLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
          recoveryCleanup: {
            ...authenticatedLocalTargetCleanupDeps(),
            closeChromeTargetWithRetainedCapability,
          },
        }),
      ).resolves.toMatchObject({ status: "completed" });
      expect(closeChromeTargetWithRetainedCapability).toHaveBeenCalledTimes(2);
    },
  );

  test("rejects cleanup authority without a persisted or explicit settlement mode", async () => {
    const runtime: BrowserRuntimeMetadata = {
      recoveryCleanupResult: { status: "failed", error: "controller crashed before binding" },
      recoveryCleanupResources: [
        {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeTargetId: "unbound-owned-target",
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: true,
            closeOwnedTargetOnComplete: false,
          },
        },
      ],
    };
    const acquireRecoveryLock = vi.fn(async () => ({ release: vi.fn(async () => undefined) }));

    await expect(
      retryBrowserRecoveryCleanup(runtime, createBrowserLogger(), { acquireRecoveryLock }),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: { code: "settlement-mode-missing", runtime },
    });
    expect(acquireRecoveryLock).toHaveBeenCalledOnce();
  });

  test("rejects serialized temporary profile paths outside their exact authority", async () => {
    const { temporaryProfileAuthority, cleanup } = await createTemporaryProfileFixture(
      "oracle-outside-runtime-authority-",
    );
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const result = await finalizeRecoveredRuntime(
      withRecoveryCleanup(
        {
          userDataDir: path.join(
            path.parse(os.tmpdir()).root,
            "oracle-outside-runtime",
            "oracle-browser-malicious",
          ),
        },
        {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
        },
        undefined,
        { temporaryProfileAuthority },
      ),
      createBrowserLogger(),
      { terminateRecordedChromeForProfile },
    );

    expect(result).toMatchObject({
      status: "pending",
      error: expect.stringMatching(/persisted authority/i),
    });
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    await cleanup();
  });

  test("rejects noncanonical temporary profile paths before termination", async () => {
    const { temporaryProfileAuthority, cleanup } = await createTemporaryProfileFixture(
      "oracle-noncanonical-runtime-authority-",
    );
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const profileDir = `${path.join(os.tmpdir(), "oracle-browser-parent")}${path.sep}..${path.sep}oracle-browser-traversal`;
    const result = await finalizeRecoveredRuntime(
      withRecoveryCleanup(
        { userDataDir: profileDir },
        {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
        },
        undefined,
        { temporaryProfileAuthority },
      ),
      createBrowserLogger(),
      { terminateRecordedChromeForProfile },
    );

    expect(result).toMatchObject({ status: "pending", error: expect.stringMatching(/canonical/) });
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    await cleanup();
  });

  test("serializes concurrent recovery for one session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-lock-test-"));
    const lockAuthority = await establishPrivateRuntimeAuthority({ tempDirectory: root });
    const recoveryLockPath = path.join(lockAuthority.path, "browser-recovery.lock");
    const logger = createBrowserLogger();
    const recoverSession = vi.fn(async () => ({ answerText: "ok", answerMarkdown: "ok" }));
    const runtime = withCommittedPromptEpoch();
    try {
      const first = await resumeBrowserSession(runtime, {}, logger, {
        recoverSession,
        recoveryLockPath,
        acquireRecoveryLock: (lockPath) => acquireReattachRecoveryLock(lockPath, lockAuthority),
      });
      await expect(
        resumeBrowserSession(runtime, {}, logger, {
          recoverSession,
          recoveryLockPath,
          acquireRecoveryLock: (lockPath) => acquireReattachRecoveryLock(lockPath, lockAuthority),
        }),
      ).rejects.toThrow(/already in progress/i);
      await first.abort();
      const next = await resumeBrowserSession(runtime, {}, logger, {
        recoverSession,
        recoveryLockPath,
        acquireRecoveryLock: (lockPath) => acquireReattachRecoveryLock(lockPath, lockAuthority),
      });
      await next.abort();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("releases the recovery lock after pending cleanup and reacquires it for retry", async () => {
    const runtime = withCommittedPromptEpoch();
    const lockReleases = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
    let nextLock = 0;
    const acquireRecoveryLock = vi.fn(async () => {
      const release = lockReleases[nextLock];
      nextLock += 1;
      if (!release) throw new Error("unexpected recovery lock acquisition");
      return { release };
    });
    let cleanupAttempt = 0;
    const finalizeResources = vi.fn(async () => {
      cleanupAttempt += 1;
      return cleanupAttempt === 1
        ? { status: "pending" as const, runtime, error: "cleanup remains pending" }
        : { status: "completed" as const, runtime };
    });
    const result = await resumeBrowserSession(runtime, {}, createBrowserLogger(), {
      acquireRecoveryLock,
      recoverSession: vi.fn(async () => ({
        answerText: "captured",
        answerMarkdown: "captured",
        finalizeResources,
      })),
    });

    await expect(result.finalize()).resolves.toMatchObject({ status: "pending" });
    expect(acquireRecoveryLock).toHaveBeenCalledOnce();
    expect(lockReleases[0]).toHaveBeenCalledOnce();

    await expect(result.finalize()).resolves.toMatchObject({ status: "completed" });
    expect(acquireRecoveryLock).toHaveBeenCalledTimes(2);
    expect(lockReleases[1]).toHaveBeenCalledOnce();
    expect(finalizeResources).toHaveBeenCalledTimes(2);
  });

  test("does not finalize resources after failed fallback recovery", async () => {
    const { profileDir, temporaryProfileAuthority, cleanup } = await createTemporaryProfileFixture(
      "oracle-browser-failed-recovery-",
    );
    const terminateRecordedChromeForProfile = vi.fn(async () => stopped);
    const removeProfile = vi.fn(async () => true);
    const runtime = withCommittedPromptEpoch(
      withRecoveryCleanup(
        { chromePort: 9222, userDataDir: profileDir },
        {
          ownsTarget: false,
          profileKind: "temporary",
          keepBrowser: false,
        },
        undefined,
        { temporaryProfileAuthority },
      ),
    );

    await expect(
      resumeBrowserSession(runtime, {}, createBrowserLogger(), {
        listTargets: vi.fn(async () => {
          throw new Error("live capture failed");
        }),
        recoverSession: vi.fn(async () => {
          throw new Error("fallback capture failed");
        }),
        recoveryCleanup: { terminateRecordedChromeForProfile, removeProfile },
      }),
    ).rejects.toThrow("fallback capture failed");
    expect(terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    expect(removeProfile).not.toHaveBeenCalled();
    await cleanup();
  });
});
