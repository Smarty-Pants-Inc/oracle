import { describe, expect, it, vi } from "vitest";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";
import {
  OwnedBrowserResourceTransaction,
  completedBrowserCaptureCleanup,
  pendingBrowserCaptureCleanup,
  projectBrowserCaptureFinalization,
} from "../../src/browser/ownedBrowserResources.js";

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
});
