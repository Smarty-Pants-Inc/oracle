import { describe, expect, test, vi } from "vitest";
import {
  retryBrowserRecoveryCleanup,
  settleBrowserRecoveryCleanup,
  type ReattachResult,
} from "../../src/browser/reattach.js";
import { createReattachSettlement } from "../../src/browser/reattachSettlement.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";
import type { BrowserCaptureFinalizationResult } from "../../src/browser/types.js";
import type { RemoteRecoverySettlementOptions } from "../../src/remote/types.js";
import {
  __test__ as targetCloseAuthorityTest,
  acknowledgeChromeTargetCloseCapability,
  closeChromeTargetWithRetainedCapability,
  retainChromeTargetCloseCapability,
} from "../../src/browser/targetCloseAuthority.js";
import {
  completedBrowserCaptureCleanup,
  pendingBrowserCaptureCleanup,
  projectBrowserRetryableCleanupRuntime,
} from "../../src/browser/ownedBrowserResources.js";
import {
  createBrowserLogger,
  withCommittedPromptEpoch,
  withRecoveryCleanup,
} from "./reattachTestHelpers.js";

describe("recovery settlement", { timeout: 15_000 }, () => {
  test("serializes cleanup finalization and durable result persistence without terminal resurrection", async () => {
    const remoteRecovery = {
      protocolVersion: 3,
      host: "remote.example.test:9443",
      transactionToken: "d".repeat(64),
      state: "pending" as const,
    };
    const runtime = {
      ...withCommittedPromptEpoch(
        withRecoveryCleanup(
          { chromeTargetId: "overlapping-remote-target" },
          {
            ownsTarget: true,
            profileKind: "none",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
          remoteRecovery,
        ),
      ),
      recoveryCleanupResult: {
        status: "failed" as const,
        error: "retry remote cleanup",
        settlementMode: "finalize" as const,
      },
    };
    let settlementAttempt = 0;
    const settleRemoteBrowserRecovery = vi.fn(
      async ({ runtime: settlementRuntime }: RemoteRecoverySettlementOptions) => {
        settlementAttempt += 1;
        return settlementAttempt === 1
          ? {
              status: "pending" as const,
              runtime: {
                ...settlementRuntime,
                recoveryCleanupResult: {
                  status: "failed" as const,
                  error: "first cleanup still pending",
                  settlementMode: "finalize" as const,
                },
              },
              error: "first cleanup still pending",
            }
          : { status: "completed" as const, runtime: {} };
      },
    );
    let precedingRelease = Promise.resolve();
    const releaseLocks: Array<() => void> = [];
    const acquireRecoveryLock = vi.fn(async () => {
      const predecessor = precedingRelease;
      const { promise, resolve } = Promise.withResolvers<void>();
      precedingRelease = promise;
      await predecessor;
      releaseLocks.push(resolve);
      return { release: async () => resolve() };
    });
    const { promise: firstPersistenceStarted, resolve: markFirstPersistenceStarted } =
      Promise.withResolvers<void>();
    const { promise: allowFirstPersistence, resolve: resumeFirstPersistence } =
      Promise.withResolvers<void>();
    let persistenceAttempt = 0;
    let persistedResult: BrowserCaptureFinalizationResult | undefined;
    const persistFinalizationResult = async (
      result: BrowserCaptureFinalizationResult,
    ): Promise<BrowserCaptureFinalizationResult> => {
      persistenceAttempt += 1;
      if (persistenceAttempt === 1) {
        markFirstPersistenceStarted();
        await allowFirstPersistence;
      }
      persistedResult = result;
      return result;
    };
    const deps = {
      acquireRecoveryLock,
      recoveryCleanup: {
        settleRemoteBrowserRecovery,
        resolveRemoteRecoveryConfig: vi.fn(async () => ({
          host: remoteRecovery.host,
          token: "configured-auth-secret",
        })),
      },
      isRemotePublicationAcknowledged: () => true,
      persistFinalizationResult,
    };

    const firstRetry = retryBrowserRecoveryCleanup(
      runtime,
      createBrowserLogger(),
      deps,
      "finalize",
    );
    await firstPersistenceStarted;
    const secondRetry = retryBrowserRecoveryCleanup(
      runtime,
      createBrowserLogger(),
      deps,
      "finalize",
    );
    await Promise.resolve();
    expect(settleRemoteBrowserRecovery).toHaveBeenCalledOnce();

    resumeFirstPersistence();
    const [first, second] = await Promise.all([firstRetry, secondRetry]);

    expect(first).toMatchObject({ status: "pending" });
    expect(second).toMatchObject({ status: "completed" });
    expect(persistedResult).toMatchObject({ status: "completed", runtime: {} });
    expect(settleRemoteBrowserRecovery).toHaveBeenCalledTimes(2);
    expect(persistenceAttempt).toBe(3);
    expect(releaseLocks).toHaveLength(2);
  });

  test("keeps live reattach finalization persistence inside the existing recovery lock", async () => {
    const authoritativeRuntime = withCommittedPromptEpoch({
      chromeTargetId: "live-reattach-target",
    });
    const runtime = withRecoveryCleanup(authoritativeRuntime, {
      ownsTarget: false,
      profileKind: "none",
      keepBrowser: true,
    });
    let liveLockHeld = true;
    const { promise: liveReleased, resolve: markLiveReleased } = Promise.withResolvers<void>();
    const { promise: livePersistenceStarted, resolve: markLivePersistenceStarted } =
      Promise.withResolvers<void>();
    const { promise: allowLivePersistence, resolve: resumeLivePersistence } =
      Promise.withResolvers<void>();
    const releaseLiveLock = vi.fn(async () => {
      expect(liveLockHeld).toBe(true);
      liveLockHeld = false;
      markLiveReleased();
    });
    const acquireRecoveryLock = vi.fn(async () => {
      await liveReleased;
      liveLockHeld = true;
      return {
        release: async () => {
          liveLockHeld = false;
        },
      };
    });
    const persistenceOrder: string[] = [];
    let persistedResult: BrowserCaptureFinalizationResult | undefined;
    const runtimeHintCb = vi.fn(async () => undefined);
    let liveSettlement: ReattachResult;
    liveSettlement = createReattachSettlement(
      {
        answerText: "Recovered answer",
        answerMarkdown: "Recovered answer",
        finalizeResources: async () => ({
          status: "pending" as const,
          runtime: {
            ...liveSettlement.runtime,
            recoveryCleanupResult: {
              status: "failed" as const,
              error: "live cleanup still pending",
              settlementMode: "finalize" as const,
            },
          },
          error: "live cleanup still pending",
        }),
      },
      runtime,
      null,
      createBrowserLogger(),
      {
        runtimeHintCb,
        persistFinalizationResult: async (result) => {
          expect(liveLockHeld).toBe(true);
          markLivePersistenceStarted();
          await allowLivePersistence;
          persistenceOrder.push(`live:${result.status}`);
          persistedResult = result;
          return result;
        },
      },
      {
        ensure: async () => {
          expect(liveLockHeld).toBe(true);
        },
        release: releaseLiveLock,
      },
    );
    await liveSettlement.bindSettlement("finalize");

    const liveFinalization = liveSettlement.finalize();
    await livePersistenceStarted;
    const recoveryFinalization = retryBrowserRecoveryCleanup(
      liveSettlement.runtime,
      createBrowserLogger(),
      {
        acquireRecoveryLock,
        persistFinalizationResult: async (result) => {
          expect(liveLockHeld).toBe(true);
          persistenceOrder.push(`recovery:${result.status}`);
          persistedResult = result;
          return result;
        },
        completeFinalizationAfterLockRelease: async (result) => {
          expect(liveLockHeld).toBe(false);
          persistenceOrder.push(`recovery:${result.status}`);
          persistedResult = result;
          return result;
        },
      },
      "finalize",
    );
    await Promise.resolve();
    expect(persistenceOrder).toEqual([]);
    expect(releaseLiveLock).not.toHaveBeenCalled();

    resumeLivePersistence();
    const [liveResult, recoveryResult] = await Promise.all([
      liveFinalization,
      recoveryFinalization,
    ]);

    expect(liveResult.status).toBe("pending");
    expect(recoveryResult).toEqual({
      status: "completed",
      runtime: expect.objectContaining({ conversationId: authoritativeRuntime.conversationId }),
    });
    expect(persistenceOrder).toEqual(["live:pending", "recovery:pending", "recovery:completed"]);
    expect(persistedResult).toMatchObject({ status: "completed" });
    expect(releaseLiveLock).toHaveBeenCalledOnce();
    expect(runtimeHintCb).toHaveBeenCalledOnce();
  });

  test("does not resurrect pending authority when queued recovery B binds after A clears", async () => {
    const staleRuntime = withRecoveryCleanup(
      withCommittedPromptEpoch({ chromeTargetId: "queued-recovery-target" }),
      { ownsTarget: false, profileKind: "none", keepBrowser: true },
    );
    let durableRuntime = staleRuntime;
    const { promise: firstReleased, resolve: releaseFirst } = Promise.withResolvers<void>();
    const persistRuntime = async (runtime: BrowserRuntimeMetadata): Promise<void> => {
      durableRuntime = runtime;
    };
    let firstSettlement!: ReattachResult;
    firstSettlement = createReattachSettlement(
      {
        answerText: "answer A",
        answerMarkdown: "answer A",
        finalizeResources: async () => completedBrowserCaptureCleanup(firstSettlement.runtime),
      },
      staleRuntime,
      null,
      createBrowserLogger(),
      {
        runtimeHintCb: persistRuntime,
        loadRuntimeUnderLock: async () => durableRuntime,
      },
      {
        ensure: async () => undefined,
        release: async (finalize) => {
          await finalize?.();
          releaseFirst();
        },
      },
    );
    const secondRuntimeHint = vi.fn(persistRuntime);
    const secondSettlement = createReattachSettlement(
      { answerText: "answer B", answerMarkdown: "answer B" },
      staleRuntime,
      null,
      createBrowserLogger(),
      {
        runtimeHintCb: secondRuntimeHint,
        loadRuntimeUnderLock: async () => durableRuntime,
      },
      {
        ensure: async () => firstReleased,
        release: async (finalize) => finalize?.(),
      },
    );

    await firstSettlement.bindSettlement("finalize");
    const secondBind = secondSettlement.bindSettlement("finalize");
    await Promise.resolve();
    expect(secondRuntimeHint).not.toHaveBeenCalled();

    await expect(firstSettlement.finalize()).resolves.toMatchObject({ status: "completed" });
    const terminalRuntime = durableRuntime;
    expect(terminalRuntime.recoveryCleanupResources).toBeUndefined();
    expect(terminalRuntime.recoveryCleanupResult).toBeUndefined();
    await expect(secondBind).resolves.toBe(terminalRuntime);
    expect(secondSettlement.runtime).toBe(terminalRuntime);
    expect(secondSettlement.runtime.recoveryCleanupResult).toBeUndefined();
  });

  test("rejects a queued stale settlement mode at the locked binding boundary", async () => {
    const authoritativeRuntime = withCommittedPromptEpoch({
      chromeTargetId: "binding-mode-target",
    });
    const staleRuntime = withRecoveryCleanup(authoritativeRuntime, {
      ownsTarget: false,
      profileKind: "none",
      keepBrowser: true,
    });
    const currentRuntime: BrowserRuntimeMetadata = {
      ...staleRuntime,
      recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
    };
    const runtimeHintCb = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const settlement = createReattachSettlement(
      { answerText: "answer", answerMarkdown: "answer" },
      staleRuntime,
      null,
      createBrowserLogger(),
      {
        runtimeHintCb,
        loadRuntimeUnderLock: async () => currentRuntime,
      },
      {
        ensure: async () => undefined,
        release,
      },
    );

    await expect(settlement.bindSettlement("abort")).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: { code: "browser-run-lifecycle-settlement-conflict" },
    });
    expect(runtimeHintCb).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  test("rejects settlement binding when committed prompt authority disappears under lock", async () => {
    const staleRuntime = withRecoveryCleanup(
      withCommittedPromptEpoch({ chromeTargetId: "stale-prompt-target" }),
      { ownsTarget: false, profileKind: "none", keepBrowser: true },
    );
    const currentRuntime: BrowserRuntimeMetadata = {
      ...staleRuntime,
      promptEpoch: undefined,
      recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
    };
    const runtimeHintCb = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const settlement = createReattachSettlement(
      { answerText: "answer", answerMarkdown: "answer", runtime: staleRuntime },
      staleRuntime,
      null,
      createBrowserLogger(),
      { runtimeHintCb, loadRuntimeUnderLock: async () => currentRuntime },
      { ensure: async () => undefined, release },
    );

    await expect(settlement.bindSettlement("finalize")).rejects.toMatchObject({
      details: { code: "browser-settlement-binding-persistence-failed" },
      cause: { details: { code: "committed-prompt-identity-mismatch" } },
    });
    expect(runtimeHintCb).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  test("does not execute a stale capture cleanup closure after locked authority reload", async () => {
    const authoritativeRuntime = withCommittedPromptEpoch({
      chromeTargetId: "stale-capture-target",
    });
    const staleRuntime = withRecoveryCleanup(authoritativeRuntime, {
      ownsTarget: false,
      profileKind: "none",
      keepBrowser: true,
    });
    const currentRuntime: BrowserRuntimeMetadata = {
      conversationId: authoritativeRuntime.conversationId,
      promptEpoch: authoritativeRuntime.promptEpoch,
      recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
    };
    const staleFinalize = vi.fn(async () => {
      throw new Error("stale cleanup must not run");
    });
    const settlement = createReattachSettlement(
      {
        answerText: "answer",
        answerMarkdown: "answer",
        runtime: staleRuntime,
        finalizeResources: staleFinalize,
      },
      staleRuntime,
      null,
      createBrowserLogger(),
      {
        loadRuntimeUnderLock: async () => currentRuntime,
        runtimeHintCb: async () => undefined,
      },
      {
        ensure: async () => undefined,
        release: async (complete) => complete?.(),
      },
    );

    await settlement.bindSettlement("finalize");
    await expect(settlement.finalize()).resolves.toMatchObject({ status: "completed" });
    expect(staleFinalize).not.toHaveBeenCalled();
  });

  test("reloads partial authority after tombstone churn instead of resurrecting stale target cleanup", async () => {
    targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
    const logger = createBrowserLogger();
    const targetId = "stale-r0-target";
    const generationId = "c0000000-0000-4000-8000-00000000000c";
    const targetCloseCapability = retainChromeTargetCloseCapability({
      generationId,
      targetId,
      close: async () => ({ status: "completed" as const }),
    });
    await closeChromeTargetWithRetainedCapability({
      capability: targetCloseCapability,
      targetId,
      logger,
    });
    acknowledgeChromeTargetCloseCapability({ capability: targetCloseCapability, targetId });
    for (
      let index = 0;
      index < targetCloseAuthorityTest.retainedTerminalTargetCloseCapabilityLimit + 1;
      index += 1
    ) {
      const churnTargetId = `reload-churn-${index}`;
      const churnCapability = retainChromeTargetCloseCapability({
        generationId: `reload-churn-generation-${index}`,
        targetId: churnTargetId,
        close: async () => ({ status: "completed" as const }),
      });
      await closeChromeTargetWithRetainedCapability({
        capability: churnCapability,
        targetId: churnTargetId,
        logger,
      });
      acknowledgeChromeTargetCloseCapability({
        capability: churnCapability,
        targetId: churnTargetId,
      });
    }
    await expect(
      closeChromeTargetWithRetainedCapability({
        capability: targetCloseCapability,
        targetId,
        logger,
      }),
    ).resolves.toMatchObject({ status: "unavailable" });

    const staleRuntime: BrowserRuntimeMetadata = {
      recoveryCleanupResources: [
        {
          chromeTargetId: targetId,
          targetCloseCapability,
          acquisition: { generationId },
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "manual-login",
            keepBrowser: false,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
    };
    const partialRuntime: BrowserRuntimeMetadata = {
      recoveryCleanupResult: {
        status: "failed",
        error: "process cleanup remains",
        settlementMode: "finalize",
      },
    };
    let durableRuntime = partialRuntime;
    const finalizeRuntime = vi.fn(async (currentRuntime: BrowserRuntimeMetadata) => {
      expect(currentRuntime).toEqual(partialRuntime);
      return { status: "completed" as const, runtime: {} };
    });
    const persist = vi.fn(async (result: BrowserCaptureFinalizationResult) => {
      durableRuntime = result.runtime;
      return result;
    });

    const outcome = await settleBrowserRecoveryCleanup(
      staleRuntime,
      logger,
      {
        acquireRecoveryLock: async () => ({
          release: async (complete?: () => Promise<void>) => {
            await complete?.();
          },
        }),
        loadRuntimeUnderLock: async () => partialRuntime,
        persistFinalizationResult: persist,
        completeFinalizationAfterLockRelease: persist,
        finalizeRuntime,
      },
      "finalize",
    );

    expect(outcome).toMatchObject({
      finalization: { status: "completed", runtime: {} },
      persistence: { status: "persisted" },
    });
    expect(finalizeRuntime).toHaveBeenCalledOnce();
    expect(durableRuntime.recoveryCleanupResources).toBeUndefined();
    expect(durableRuntime.recoveryCleanupResult).toBeUndefined();
    targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
  });

  test("acknowledges target cleanup after partial runtime persistence leaves lease cleanup pending", async () => {
    targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
    const logger = createBrowserLogger();
    const targetId = "partial-persistence-target";
    const generationId = "e0000000-0000-4000-8000-00000000000e";
    const closeTarget = vi.fn(async () => ({ status: "completed" as const }));
    const targetCloseCapability = retainChromeTargetCloseCapability({
      generationId,
      targetId,
      close: closeTarget,
    });
    const profileDirectory = {
      version: 1 as const,
      platform: process.platform,
      canonicalPath: "/tmp/partial-persistence-profile",
      device: "1",
      inode: "2",
    };
    const runtime: BrowserRuntimeMetadata = {
      chromeTargetId: targetId,
      recoveryCleanupResources: [
        {
          chromeTargetId: targetId,
          targetCloseCapability,
          tabLease: { id: "partial-persistence-lease", profileDirectory },
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

    const outcome = await settleBrowserRecoveryCleanup(
      runtime,
      logger,
      {
        acquireRecoveryLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
        loadRuntimeUnderLock: async () => durableRuntime,
        finalizeRuntime: async (currentRuntime, mode) => {
          await closeChromeTargetWithRetainedCapability({
            capability: targetCloseCapability,
            targetId,
            logger,
          });
          return pendingBrowserCaptureCleanup(
            projectBrowserRetryableCleanupRuntime(currentRuntime, {
              targetId,
              targetCloseCapability,
            }),
            "Browser lease release failed",
            mode,
          );
        },
        persistFinalizationResult: async (result) => {
          durableRuntime = result.runtime;
          return result;
        },
      },
      "finalize",
    );

    expect(outcome).toMatchObject({
      finalization: { status: "pending", error: "Browser lease release failed" },
      persistence: { status: "persisted" },
    });
    expect(durableRuntime.recoveryCleanupResources).toEqual([
      expect.objectContaining({
        chromeTargetId: undefined,
        targetCloseCapability: undefined,
        tabLease: expect.objectContaining({ id: "partial-persistence-lease" }),
      }),
    ]);
    expect(closeTarget).toHaveBeenCalledOnce();
    expect(targetCloseAuthorityTest.retainedAcknowledgedTerminalTargetCloseAuthorityCount()).toBe(
      1,
    );
  });
});
