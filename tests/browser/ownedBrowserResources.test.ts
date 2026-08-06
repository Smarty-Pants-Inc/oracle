import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";
import {
  OwnedBrowserResourceTransaction,
  completedBrowserCaptureCleanup,
  pendingBrowserCaptureCleanup,
  projectBrowserCaptureFinalization,
  projectBrowserRetryableCleanupRuntime,
} from "../../src/browser/ownedBrowserResources.js";
import {
  __test__ as targetCloseAuthorityTest,
  closeChromeTargetWithRetainedCapability,
  retainChromeTargetCloseCapability,
} from "../../src/browser/targetCloseAuthority.js";
import type { BrowserLogger } from "../../src/browser/types.js";

const profileDirectory = {
  version: 1 as const,
  platform: process.platform,
  canonicalPath: "/tmp/owned-browser-resource",
  device: "1",
  inode: "2",
};

function acquisitionRuntime(
  pendingResource?: "tab-lease" | "chrome-process" | "chrome-target",
): BrowserRuntimeMetadata {
  return {
    browserTransport: "cdp",
    chromeHost: "127.0.0.1",
    chromePort: 9222,
    userDataDir: profileDirectory.canonicalPath,
    chromeTargetId: pendingResource === "chrome-target" ? undefined : "target-1",
    recoveryCleanupResources: [
      {
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        userDataDir: profileDirectory.canonicalPath,
        chromeTargetId: pendingResource === "chrome-target" ? undefined : "target-1",
        targetCloseCapability:
          pendingResource === "chrome-target"
            ? undefined
            : { version: 1, generationId: "generation-1", capabilityId: "capability-1" },
        tabLease: { id: "lease-1", profileDirectory },
        acquisition: {
          generationId: "generation-1",
          processOwnerProvenance: "manual-canonical-owner",
          ...(pendingResource ? { pendingResource } : {}),
          targetMarkerUrl: "about:blank#oracle-acquisition=generation-1",
        },
        recoveryCleanup: {
          ownsTarget: true,
          profileKind: "manual-login",
          keepBrowser: false,
          closeOwnedTargetOnComplete: true,
        },
      },
    ],
    recoveryCleanupResult: { status: "pending" },
  };
}

describe("OwnedBrowserResourceTransaction", () => {
  afterEach(() => {
    targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
  });
  it("persists acquisition intent before the effect and exact authority immediately after", async () => {
    const events: string[] = [];
    const persistRuntime = vi.fn(async (runtime: BrowserRuntimeMetadata) => {
      const pending = runtime.recoveryCleanupResources?.[0]?.acquisition?.pendingResource;
      events.push(pending ? `persist:${pending}` : "persist:exact");
    });
    const transaction = new OwnedBrowserResourceTransaction(
      {
        persistRuntime,
        settleResources: async (_mode, runtime) => completedBrowserCaptureCleanup(runtime),
      },
      acquisitionRuntime(),
    );

    const acquired = await transaction.journalAcquisition({
      intentRuntime: acquisitionRuntime("chrome-target"),
      acquire: async () => {
        events.push("acquire:chrome-target");
        return "target-1";
      },
      acquiredRuntime: () => acquisitionRuntime(),
    });

    expect(acquired).toBe("target-1");
    expect(events).toEqual(["persist:chrome-target", "acquire:chrome-target", "persist:exact"]);
  });

  it("does not start an acquisition effect when intent durability fails", async () => {
    const acquire = vi.fn(async () => "target-never-opened");
    const transaction = new OwnedBrowserResourceTransaction(
      {
        persistRuntime: async () => {
          throw new Error("intent store unavailable");
        },
        settleResources: async (_mode, runtime) => completedBrowserCaptureCleanup(runtime),
      },
      acquisitionRuntime(),
    );

    await expect(
      transaction.journalAcquisition({
        intentRuntime: acquisitionRuntime("chrome-target"),
        acquire,
        acquiredRuntime: () => acquisitionRuntime(),
      }),
    ).rejects.toThrow("intent store unavailable");
    expect(acquire).not.toHaveBeenCalled();
  });

  it("retains exact acquired authority in memory when the exact journal write fails", async () => {
    const persistRuntime = vi
      .fn(async (_runtime: BrowserRuntimeMetadata) => undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("exact store unavailable"));
    const transaction = new OwnedBrowserResourceTransaction(
      {
        persistRuntime,
        settleResources: async (_mode, runtime) => completedBrowserCaptureCleanup(runtime),
      },
      acquisitionRuntime(),
    );

    await expect(
      transaction.journalAcquisition({
        intentRuntime: acquisitionRuntime("chrome-target"),
        acquire: async () => "target-1",
        acquiredRuntime: () => acquisitionRuntime(),
      }),
    ).rejects.toThrow("exact store unavailable");
    expect(transaction.runtime()).toMatchObject({
      chromeTargetId: "target-1",
      recoveryCleanupResources: [
        expect.objectContaining({
          chromeTargetId: "target-1",
          acquisition: expect.not.objectContaining({ pendingResource: expect.anything() }),
        }),
      ],
    });
  });

  it("retains exact retry authority when completed settlement cannot be persisted", async () => {
    const persistSettlementResult = vi
      .fn(async (_runtime: BrowserRuntimeMetadata) => undefined)
      .mockRejectedValueOnce(new Error("completed runtime store unavailable"));
    const settleResources = vi.fn(
      async (_mode: "finalize" | "abort", runtime: BrowserRuntimeMetadata) =>
        completedBrowserCaptureCleanup(runtime),
    );
    const transaction = new OwnedBrowserResourceTransaction(
      {
        persistRuntime: async () => undefined,
        persistSettlementResult,
        settleResources,
      },
      acquisitionRuntime(),
    );

    await expect(transaction.settle("finalize")).resolves.toMatchObject({
      status: "pending",
      error: "Browser settlement result persistence failed: completed runtime store unavailable",
      runtime: {
        recoveryCleanupResources: expect.any(Array),
        recoveryCleanupResult: {
          status: "failed",
          settlementMode: "finalize",
        },
      },
    });
    expect(settleResources).toHaveBeenCalledTimes(1);

    await expect(transaction.settle("finalize")).resolves.toMatchObject({ status: "completed" });
    expect(settleResources).toHaveBeenCalledTimes(2);
    expect(persistSettlementResult).toHaveBeenCalledTimes(2);
  });

  it("acknowledges terminal target authority only after cleanup state persists", async () => {
    const closeTarget = vi.fn(async () => ({ status: "completed" as const }));
    const logger = vi.fn<(message: string) => void>() as BrowserLogger;
    const capability = retainChromeTargetCloseCapability({
      generationId: "generation-1",
      targetId: "target-1",
      close: closeTarget,
    });
    const runtime = acquisitionRuntime();
    const resource = runtime.recoveryCleanupResources?.[0];
    if (!resource) throw new Error("owned target fixture is missing");
    runtime.recoveryCleanupResources = [{ ...resource, targetCloseCapability: capability }];
    const persistSettlementResult = vi
      .fn(async (_runtime: BrowserRuntimeMetadata) => undefined)
      .mockRejectedValueOnce(new Error("completed runtime store unavailable"));
    const transaction = new OwnedBrowserResourceTransaction(
      {
        persistRuntime: async () => undefined,
        persistSettlementResult,
        settleResources: async (_mode, pendingRuntime) => {
          await closeChromeTargetWithRetainedCapability({
            capability,
            targetId: "target-1",
            logger,
          });
          return completedBrowserCaptureCleanup(pendingRuntime);
        },
      },
      runtime,
    );

    await expect(transaction.settle("finalize")).resolves.toMatchObject({ status: "pending" });
    expect(targetCloseAuthorityTest.retainedAcknowledgedTerminalTargetCloseAuthorityCount()).toBe(
      0,
    );
    await expect(
      closeChromeTargetWithRetainedCapability({ capability, targetId: "target-1", logger }),
    ).resolves.toEqual({ status: "completed" });

    await expect(transaction.settle("finalize")).resolves.toMatchObject({ status: "completed" });
    expect(targetCloseAuthorityTest.retainedAcknowledgedTerminalTargetCloseAuthorityCount()).toBe(
      1,
    );
    expect(closeTarget).toHaveBeenCalledOnce();
  });

  it("acknowledges a terminal target after durable partial cleanup persistence", async () => {
    const closeTarget = vi.fn(async () => ({ status: "completed" as const }));
    const logger = vi.fn<(message: string) => void>() as BrowserLogger;
    const capability = retainChromeTargetCloseCapability({
      generationId: "partial-generation",
      targetId: "target-1",
      close: closeTarget,
    });
    const runtime = acquisitionRuntime();
    const resource = runtime.recoveryCleanupResources?.[0];
    if (!resource) throw new Error("owned target fixture is missing");
    runtime.recoveryCleanupResources = [{ ...resource, targetCloseCapability: capability }];
    const persistSettlementResult = vi.fn(async (_runtime: BrowserRuntimeMetadata) => undefined);
    const transaction = new OwnedBrowserResourceTransaction(
      {
        persistRuntime: async () => undefined,
        persistSettlementResult,
        settleResources: async (_mode, pendingRuntime) => {
          await closeChromeTargetWithRetainedCapability({
            capability,
            targetId: "target-1",
            logger,
          });
          const partialRuntime = projectBrowserRetryableCleanupRuntime(pendingRuntime, {
            targetId: "target-1",
            targetCloseCapability: capability,
          });
          return pendingBrowserCaptureCleanup(
            partialRuntime,
            "Browser lease release failed",
            "finalize",
          );
        },
      },
      runtime,
    );

    await expect(transaction.settle("finalize")).resolves.toMatchObject({
      status: "pending",
      error: "Browser lease release failed",
    });

    expect(persistSettlementResult).toHaveBeenCalledOnce();
    expect(closeTarget).toHaveBeenCalledOnce();
    expect(targetCloseAuthorityTest.retainedAcknowledgedTerminalTargetCloseAuthorityCount()).toBe(
      1,
    );
  });

  it("discards intentionally preserved target capabilities after durable completion", async () => {
    for (let index = 0; index < 3; index += 1) {
      const closeTarget = vi.fn(async () => ({ status: "completed" as const }));
      const capability = retainChromeTargetCloseCapability({
        generationId: `preserved-generation-${index}`,
        targetId: "target-1",
        close: closeTarget,
      });
      const runtime = acquisitionRuntime();
      const resource = runtime.recoveryCleanupResources?.[0];
      if (!resource) throw new Error("owned target fixture is missing");
      runtime.recoveryCleanupResources = [
        {
          ...resource,
          targetCloseCapability: capability,
          recoveryCleanup: {
            ...resource.recoveryCleanup,
            keepBrowser: true,
            closeOwnedTargetOnComplete: false,
          },
        },
      ];
      const transaction = new OwnedBrowserResourceTransaction(
        {
          persistRuntime: async () => undefined,
          persistSettlementResult: async () => undefined,
          settleResources: async (_mode, pendingRuntime) =>
            completedBrowserCaptureCleanup(pendingRuntime),
        },
        runtime,
      );

      await expect(transaction.settle("finalize")).resolves.toMatchObject({
        status: "completed",
      });
      expect(closeTarget).not.toHaveBeenCalled();
      expect(targetCloseAuthorityTest.retainedTargetCloseAuthorityCount()).toBe(0);
    }
  });

  it("keeps terminal target authority unacknowledged without a durable settlement adapter", async () => {
    const closeTarget = vi.fn(async () => ({ status: "completed" as const }));
    const logger = vi.fn<(message: string) => void>() as BrowserLogger;
    const capability = retainChromeTargetCloseCapability({
      generationId: "generation-1",
      targetId: "target-1",
      close: closeTarget,
    });
    const runtime = acquisitionRuntime();
    const resource = runtime.recoveryCleanupResources?.[0];
    if (!resource) throw new Error("owned target fixture is missing");
    runtime.recoveryCleanupResources = [{ ...resource, targetCloseCapability: capability }];
    const transaction = new OwnedBrowserResourceTransaction(
      {
        persistRuntime: async () => undefined,
        settleResources: async (_mode, pendingRuntime) => {
          await closeChromeTargetWithRetainedCapability({
            capability,
            targetId: "target-1",
            logger,
          });
          return completedBrowserCaptureCleanup(pendingRuntime);
        },
      },
      runtime,
    );

    await expect(transaction.settle("finalize")).resolves.toMatchObject({ status: "completed" });

    expect(targetCloseAuthorityTest.retainedAcknowledgedTerminalTargetCloseAuthorityCount()).toBe(
      0,
    );
    await expect(
      closeChromeTargetWithRetainedCapability({ capability, targetId: "target-1", logger }),
    ).resolves.toEqual({ status: "completed" });
    expect(closeTarget).toHaveBeenCalledOnce();
  });

  it("preserves authoritative prompt epoch and conversation identity through resource settlement", () => {
    const authoritative: BrowserRuntimeMetadata = {
      ...acquisitionRuntime(),
      conversationId: "conversation-authoritative",
      promptEpoch: {
        status: "committed",
        epochId: "epoch-1",
        promptSha256: "a".repeat(64),
        baselineTurns: 0,
        followUpOrdinal: 0,
        remainingFollowUps: 0,
        verifiedUserTurnIndex: 0,
        conversationId: "conversation-authoritative",
        verifiedUserTurnId: "turn-1",
        verifiedUserMessageId: "message-1",
      },
      recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
    };
    const resourceResult = completedBrowserCaptureCleanup({
      browserTransport: "cdp",
      chromeHost: "127.0.0.1",
      chromePort: 9222,
    });

    expect(projectBrowserCaptureFinalization(authoritative, resourceResult, "finalize")).toEqual({
      status: "completed",
      runtime: expect.objectContaining({
        conversationId: "conversation-authoritative",
        promptEpoch: expect.objectContaining({
          status: "committed",
          conversationId: "conversation-authoritative",
          verifiedUserTurnId: "turn-1",
        }),
      }),
    });
  });

  it("does not retain a requested mode when durable authority rejects it", async () => {
    const persistRuntime = vi
      .fn(async (_runtime: BrowserRuntimeMetadata) => undefined)
      .mockRejectedValueOnce(
        new BrowserAutomationError("Durable authority is already abort-bound.", {
          stage: "browser-run-lifecycle",
          code: "browser-run-lifecycle-settlement-conflict",
          requestedMode: "finalize",
          boundMode: "abort",
        }),
      );
    const settleResources = vi.fn(
      async (_mode: "finalize" | "abort", runtime: BrowserRuntimeMetadata) =>
        completedBrowserCaptureCleanup(runtime),
    );
    const transaction = new OwnedBrowserResourceTransaction(
      { persistRuntime, settleResources },
      acquisitionRuntime(),
    );

    await expect(transaction.settle("finalize")).rejects.toMatchObject({
      details: { requestedMode: "finalize", boundMode: "abort" },
    });
    expect(transaction.runtime().recoveryCleanupResult).toEqual({ status: "pending" });
    expect(settleResources).not.toHaveBeenCalled();

    await expect(transaction.settle("abort")).resolves.toMatchObject({ status: "completed" });
    expect(settleResources).toHaveBeenCalledTimes(1);
  });

  it("rejects attempts to launder a bound settlement mode", () => {
    const authoritative = {
      ...acquisitionRuntime(),
      recoveryCleanupResult: { status: "pending" as const, settlementMode: "finalize" as const },
    };
    const abortResult = pendingBrowserCaptureCleanup(
      acquisitionRuntime(),
      "cleanup remains pending",
      "abort",
    );

    let thrown: unknown;
    try {
      projectBrowserCaptureFinalization(authoritative, abortResult, "finalize");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      details: {
        code: "browser-run-lifecycle-settlement-conflict",
        requestedMode: "finalize",
        boundMode: "abort",
      },
    });
  });

  it("redacts only the exact target generation that reached terminal cleanup", () => {
    const first = acquisitionRuntime().recoveryCleanupResources?.[0];
    if (!first) throw new Error("owned target fixture is missing");
    const second = {
      ...first,
      acquisition: { ...first.acquisition, generationId: "generation-2" },
      targetCloseCapability: {
        version: 1 as const,
        generationId: "generation-2",
        capabilityId: "capability-2",
      },
    };
    const runtime: BrowserRuntimeMetadata = {
      ...acquisitionRuntime(),
      recoveryCleanupResources: [first, second],
    };

    const projected = projectBrowserRetryableCleanupRuntime(runtime, {
      targetId: "target-1",
      targetCloseCapability: {
        generationId: "generation-1",
        capabilityId: "capability-1",
      },
    });

    expect(projected.chromeTargetId).toBeUndefined();
    expect(projected.recoveryCleanupResources?.[0]).toMatchObject({
      chromeTargetId: undefined,
      targetCloseCapability: undefined,
      recoveryCleanup: { ownsTarget: false },
    });
    expect(projected.recoveryCleanupResources?.[1]).toEqual(second);
  });

  it("preserves target authority when terminal generation proof does not match", () => {
    const runtime = acquisitionRuntime();
    expect(
      projectBrowserRetryableCleanupRuntime(runtime, {
        targetId: "target-1",
        targetCloseCapability: {
          generationId: "generation-other",
          capabilityId: "capability-other",
        },
      }),
    ).toEqual(runtime);
  });
});
