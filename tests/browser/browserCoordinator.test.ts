import { beforeEach, describe, expect, test, vi } from "vitest";
import type { BrowserRunResult, BrowserRunTransaction } from "../../src/browser/types.js";
import {
  __test__ as targetCloseAuthorityTest,
  closeChromeTargetWithRetainedCapability,
  retainChromeTargetCloseCapability,
} from "../../src/browser/targetCloseAuthority.js";

const { runLocalBrowserMode, runRemoteBrowserMode, acknowledgeSettledTargetCloseCapabilities } =
  vi.hoisted(() => ({
    runLocalBrowserMode: vi.fn(),
    runRemoteBrowserMode: vi.fn(),
    acknowledgeSettledTargetCloseCapabilities: vi.fn(),
  }));

vi.mock("../../src/browser/localBrowserCoordinator.js", () => ({ runLocalBrowserMode }));
vi.mock("../../src/browser/remoteBrowserCoordinator.js", () => ({ runRemoteBrowserMode }));
vi.mock("../../src/browser/ownedBrowserResources.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/browser/ownedBrowserResources.js")>();
  acknowledgeSettledTargetCloseCapabilities.mockImplementation(
    actual.acknowledgeSettledTargetCloseCapabilities,
  );
  return { ...actual, acknowledgeSettledTargetCloseCapabilities };
});

import { runBrowserMode, runBrowserModeTransaction } from "../../src/browser/browserCoordinator.js";

const capture: BrowserRunResult = {
  answerText: "settled answer",
  answerMarkdown: "settled answer",
  tookMs: 250,
  answerTokens: 2,
  answerChars: 14,
  browserTransport: "cdp",
  chromeHost: "remote.example",
  chromePort: 9333,
  chromeTargetId: "owned-target",
};

function browserTransaction(
  finalize: BrowserRunTransaction["finalize"],
  abort: BrowserRunTransaction["abort"] = vi.fn(async () => ({
    status: "completed" as const,
    runtime: {},
  })),
  runtime: BrowserRunTransaction["runtime"] = {},
): BrowserRunTransaction {
  return {
    ...capture,
    runtime,
    bindSettlement: vi.fn(async () => runtime),
    finalize,
    abort,
  };
}

describe("browser coordinator public settlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
  });

  test("finalizes a successful direct run before returning an audit-safe result", async () => {
    const runtime: BrowserRunTransaction["runtime"] = {
      recoveryCleanupResources: [
        {
          chromeTargetId: "owned-target",
          targetCloseCapability: {
            version: 1,
            generationId: "owned-target-generation",
            capabilityId: "owned-target-capability",
          },
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "temporary",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
    };
    const finalizedRuntime = {};
    const finalize = vi.fn(async () => ({
      status: "completed" as const,
      runtime: finalizedRuntime,
    }));
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime }));
    runRemoteBrowserMode.mockResolvedValueOnce(browserTransaction(finalize, abort, runtime));

    const result = await runBrowserMode({
      prompt: "review this",
      config: { remoteChrome: { host: "remote.example", port: 9333 } },
    });

    expect(finalize).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(acknowledgeSettledTargetCloseCapabilities).toHaveBeenCalledOnce();
    expect(acknowledgeSettledTargetCloseCapabilities).toHaveBeenCalledWith(
      runtime,
      finalizedRuntime,
    );
    expect(result).toEqual({
      answerText: "settled answer",
      answerMarkdown: "settled answer",
      tookMs: 250,
      answerTokens: 2,
      answerChars: 14,
      browserTransport: "cdp",
    });
    expect(result).not.toHaveProperty("runtime");
    expect(result).not.toHaveProperty("chromeHost");
    expect(result).not.toHaveProperty("chromePort");
    expect(result).not.toHaveProperty("chromeTargetId");
    expect(result).not.toHaveProperty("finalize");
    expect(result).not.toHaveProperty("bindSettlement");
    expect(result).not.toHaveProperty("abort");
  });

  test("does not acknowledge a completed direct finalize that retains target-close authority", async () => {
    const runtime: BrowserRunTransaction["runtime"] = {
      recoveryCleanupResources: [
        {
          chromeTargetId: "owned-target",
          targetCloseCapability: {
            version: 1,
            generationId: "owned-target-generation",
            capabilityId: "owned-target-capability",
          },
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "temporary",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
    };
    const finalize = vi.fn(async () => ({ status: "completed" as const, runtime }));
    runRemoteBrowserMode.mockResolvedValueOnce(browserTransaction(finalize, undefined, runtime));

    await runBrowserMode({
      prompt: "review this",
      config: { remoteChrome: { host: "remote.example", port: 9333 } },
    });

    expect(acknowledgeSettledTargetCloseCapabilities).not.toHaveBeenCalled();
  });

  test("discards preserved direct-run target capabilities without closing the target", async () => {
    for (let index = 0; index < 3; index += 1) {
      const targetId = `preserved-target-${index}`;
      const closeTarget = vi.fn(async () => ({ status: "completed" as const }));
      const capability = retainChromeTargetCloseCapability({
        generationId: `preserved-generation-${index}`,
        targetId,
        close: closeTarget,
      });
      const runtime: BrowserRunTransaction["runtime"] = {
        recoveryCleanupResources: [
          {
            chromeTargetId: targetId,
            targetCloseCapability: capability,
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: true,
              closeOwnedTargetOnComplete: false,
            },
          },
        ],
      };
      runLocalBrowserMode.mockResolvedValueOnce(
        browserTransaction(
          vi.fn(async () => ({ status: "completed" as const, runtime: {} })),
          undefined,
          runtime,
        ),
      );

      await runBrowserMode({
        prompt: `preserve ${index}`,
        config: { keepBrowser: true },
      });

      expect(closeTarget).not.toHaveBeenCalled();
      expect(targetCloseAuthorityTest.retainedTargetCloseAuthorityCount()).toBe(0);
    }
  });

  test("acknowledges a closed target when lease cleanup remains pending", async () => {
    const targetId = "partially-cleaned-target";
    const closeTarget = vi.fn(async () => ({ status: "completed" as const }));
    const capability = retainChromeTargetCloseCapability({
      generationId: "partially-cleaned-generation",
      targetId,
      close: closeTarget,
    });
    const runtime: BrowserRunTransaction["runtime"] = {
      recoveryCleanupResources: [
        {
          chromeTargetId: targetId,
          targetCloseCapability: capability,
          tabLease: {
            id: "remaining-lease",
            profileDirectory: {
              version: 1,
              platform: process.platform,
              canonicalPath: "/tmp/remaining-lease",
              device: "1",
              inode: "2",
            },
          },
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "temporary",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending", settlementMode: "finalize" },
    };
    const pendingRuntime: BrowserRunTransaction["runtime"] = {
      recoveryCleanupResources: [
        {
          tabLease: runtime.recoveryCleanupResources?.[0]?.tabLease,
          recoveryCleanup: {
            ownsTarget: false,
            profileKind: "temporary",
            keepBrowser: false,
          },
        },
      ],
      recoveryCleanupResult: {
        status: "failed",
        settlementMode: "finalize",
        error: "Browser lease release failed",
      },
    };
    const finalize = vi.fn(async () => {
      await closeChromeTargetWithRetainedCapability({
        capability,
        targetId,
        logger: vi.fn<(message: string) => void>(),
      });
      return {
        status: "pending" as const,
        runtime: pendingRuntime,
        error: "Browser lease release failed",
      };
    });
    runRemoteBrowserMode.mockResolvedValueOnce(browserTransaction(finalize, undefined, runtime));

    await runBrowserMode({
      prompt: "partial cleanup",
      config: { remoteChrome: { host: "remote.example", port: 9333 } },
    });

    expect(closeTarget).toHaveBeenCalledOnce();
    expect(targetCloseAuthorityTest.retainedAcknowledgedTerminalTargetCloseAuthorityCount()).toBe(
      1,
    );
  });

  test("keeps settlement under the explicit transaction entrypoint caller", async () => {
    const finalize = vi.fn(async () => ({ status: "completed" as const, runtime: {} }));
    const transaction = browserTransaction(finalize);
    runRemoteBrowserMode.mockResolvedValueOnce(transaction);

    await expect(
      runBrowserModeTransaction({
        prompt: "persist before cleanup",
        config: { remoteChrome: { host: "remote.example", port: 9333 } },
      }),
    ).resolves.toBe(transaction);
    expect(finalize).not.toHaveBeenCalled();
  });

  test("retains a non-durable same-process retry when public cleanup remains pending", async () => {
    const runtime: BrowserRunTransaction["runtime"] = {
      chromeHost: "remote.example",
      chromePort: 9333,
      chromeTargetId: "owned-target",
      recoveryCleanupResources: [
        {
          chromeHost: "remote.example",
          chromePort: 9333,
          chromeTargetId: "owned-target",
          targetCloseCapability: {
            version: 1,
            generationId: "owned-target-generation",
            capabilityId: "owned-target-capability",
          },
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "temporary",
            keepBrowser: false,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
      recoveryCleanupResult: {
        status: "failed",
        settlementMode: "finalize",
        error: "Remote Chrome target close was not confirmed",
      },
    };
    const pending = {
      status: "pending" as const,
      runtime,
      error: "Remote Chrome target close was not confirmed",
    };
    const finalize = vi
      .fn<BrowserRunTransaction["finalize"]>()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({ status: "completed", runtime: {} });
    const abort = vi.fn(async () => ({ status: "completed" as const, runtime }));
    runRemoteBrowserMode.mockResolvedValueOnce(browserTransaction(finalize, abort, runtime));

    const result = await runBrowserMode({
      prompt: "review this",
      config: { remoteChrome: { host: "remote.example", port: 9333 } },
    });

    expect(result).toMatchObject({
      answerText: "settled answer",
      answerMarkdown: "settled answer",
      warnings: [
        {
          code: "direct-finalize-cleanup-pending",
          severity: "warning",
          message:
            "The assistant answer is complete, but internal browser cleanup remains pending.",
          details: { stage: "browser-capture-finalization" },
        },
      ],
    });
    expect(result).not.toHaveProperty("runtime");
    expect(result).not.toHaveProperty("chromeHost");
    expect(result).not.toHaveProperty("chromePort");
    expect(result).not.toHaveProperty("chromeTargetId");
    expect(result).not.toHaveProperty("recoveryCleanupResources");
    expect(result.retryCleanup).toEqual(expect.any(Function));
    expect(acknowledgeSettledTargetCloseCapabilities).not.toHaveBeenCalled();
    expect(Object.keys(result)).not.toContain("retryCleanup");
    expect(JSON.stringify(result)).not.toContain("retryCleanup");
    await expect(result.retryCleanup!()).resolves.toBe("pending");
    expect(acknowledgeSettledTargetCloseCapabilities).not.toHaveBeenCalled();
    await expect(result.retryCleanup!()).resolves.toBe("completed");
    expect(acknowledgeSettledTargetCloseCapabilities).toHaveBeenCalledOnce();
    expect(acknowledgeSettledTargetCloseCapabilities).toHaveBeenCalledWith(runtime, {});
    expect(finalize).toHaveBeenCalledTimes(3);
    expect(abort).not.toHaveBeenCalled();
  });
});
