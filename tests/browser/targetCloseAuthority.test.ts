import { afterEach, describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  __test__,
  acknowledgeChromeTargetCloseCapability,
  closeChromeTargetWithRetainedCapability,
  discardChromeTargetCloseCapability,
  hasRestartDurableChromeTargetCleanupAuthority,
  retainChromeTargetCloseCapability,
} from "../../src/browser/targetCloseAuthority.js";
import { __test__ as reattachTest } from "../../src/browser/reattach.js";
import type { BrowserLogger } from "../../src/browser/types.js";
import { processIdentity } from "./chromeLifecycleTestHelpers.js";
import {
  authenticatedLocalTargetCleanupDeps,
  createBrowserLogger,
  restartBoundProcessIdentity,
  withRecoveryCleanup,
} from "./reattachTestHelpers.js";

describe("retained Chrome target close capabilities", () => {
  const { finalizeRecoveredRuntime } = reattachTest;
  const stopped = { status: "stopped", pid: 1234, signal: "SIGTERM" } as const;
  afterEach(() => {
    __test__.clearRetainedTargetCloseAuthorities();
  });

  test("pins unacknowledged terminal capabilities while bounding acknowledged tombstones", async () => {
    const close = vi.fn(async () => ({ status: "completed" as const }));
    const logger = vi.fn<(message: string) => void>() as BrowserLogger;
    const pending = retainChromeTargetCloseCapability({
      ownerId: "test-owner",
      generationId: "pending-generation",
      targetId: "pending-target",
      close,
    });
    await expect(
      closeChromeTargetWithRetainedCapability({
        ownerId: "test-owner",
        capability: pending,
        targetId: "pending-target",
        logger,
      }),
    ).resolves.toEqual({ status: "completed" });

    const count = __test__.retainedTerminalTargetCloseCapabilityLimit * 4;
    const acknowledged: (typeof pending)[] = [];
    for (let index = 0; index < count; index += 1) {
      const capability = retainChromeTargetCloseCapability({
        ownerId: "test-owner",
        generationId: `generation-${index}`,
        targetId: `target-${index}`,
        close,
      });
      await closeChromeTargetWithRetainedCapability({
        ownerId: "test-owner",
        capability,
        targetId: `target-${index}`,
        logger,
      });
      acknowledgeChromeTargetCloseCapability({
        ownerId: "test-owner",
        capability,
        targetId: `target-${index}`,
      });
      acknowledged.push(capability);
    }

    expect(__test__.retainedTargetCloseAuthorityCount()).toBe(
      __test__.retainedTerminalTargetCloseCapabilityLimit + 1,
    );
    expect(__test__.retainedAcknowledgedTerminalTargetCloseAuthorityCount()).toBe(
      __test__.retainedTerminalTargetCloseCapabilityLimit,
    );
    await expect(
      closeChromeTargetWithRetainedCapability({
        ownerId: "test-owner",
        capability: pending,
        targetId: "pending-target",
        logger,
      }),
    ).resolves.toEqual({ status: "completed" });
    expect(close).toHaveBeenCalledTimes(count + 1);

    acknowledgeChromeTargetCloseCapability({
      ownerId: "test-owner",
      capability: pending,
      targetId: "pending-target",
    });
    expect(__test__.retainedTargetCloseAuthorityCount()).toBe(
      __test__.retainedTerminalTargetCloseCapabilityLimit,
    );
    await expect(
      closeChromeTargetWithRetainedCapability({
        ownerId: "test-owner",
        capability: acknowledged[0]!,
        targetId: "target-0",
        logger,
      }),
    ).resolves.toMatchObject({ status: "unavailable" });
    await expect(
      closeChromeTargetWithRetainedCapability({
        ownerId: "test-owner",
        capability: pending,
        targetId: "pending-target",
        logger,
      }),
    ).resolves.toEqual({ status: "completed" });
    await expect(
      closeChromeTargetWithRetainedCapability({
        ownerId: "test-owner",
        capability: {
          version: 1,
          generationId: "unknown-generation",
          capabilityId: "unknown-capability",
        },
        targetId: "unknown-target",
        logger,
      }),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(close).toHaveBeenCalledTimes(count + 1);
  });

  test("discards intentional preservation without closing the target", async () => {
    const close = vi.fn(async () => ({ status: "completed" as const }));
    const release = vi.fn(async () => undefined);
    const capability = retainChromeTargetCloseCapability({
      ownerId: "test-owner",
      generationId: "preserved-generation",
      targetId: "preserved-target",
      close,
      release,
    });

    await discardChromeTargetCloseCapability({
      ownerId: "test-owner",
      capability,
      targetId: "preserved-target",
    });

    expect(close).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(__test__.retainedTargetCloseAuthorityCount()).toBe(0);
  });

  test("retains a preserved capability when its release fails", async () => {
    const release = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("endpoint release deferred"))
      .mockResolvedValueOnce(undefined);
    const capability = retainChromeTargetCloseCapability({
      ownerId: "test-owner",
      generationId: "release-retry-generation",
      targetId: "release-retry-target",
      close: vi.fn(async () => ({ status: "completed" as const })),
      release,
    });

    await expect(
      discardChromeTargetCloseCapability({
        ownerId: "test-owner",
        capability,
        targetId: "release-retry-target",
      }),
    ).rejects.toThrow(/release deferred/i);
    expect(__test__.retainedTargetCloseAuthorityCount()).toBe(1);
    await discardChromeTargetCloseCapability({
      ownerId: "test-owner",
      capability,
      targetId: "release-retry-target",
    });
    expect(release).toHaveBeenCalledTimes(2);
    expect(__test__.retainedTargetCloseAuthorityCount()).toBe(0);
  });

  test("does not transfer a retained close capability to a different owner", async () => {
    const close = vi.fn(async () => ({ status: "completed" as const }));
    const release = vi.fn(async () => undefined);
    const logger = vi.fn<(message: string) => void>() as BrowserLogger;
    const capability = retainChromeTargetCloseCapability({
      ownerId: "owner-a",
      generationId: "shared-generation",
      targetId: "shared-target",
      close,
      release,
    });

    await expect(
      closeChromeTargetWithRetainedCapability({
        ownerId: "owner-b",
        capability: { ...capability },
        targetId: "shared-target",
        logger,
      }),
    ).resolves.toMatchObject({ status: "unavailable" });
    await discardChromeTargetCloseCapability({
      ownerId: "owner-b",
      capability: { ...capability },
      targetId: "shared-target",
    });
    expect(close).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(__test__.retainedTargetCloseAuthorityCount()).toBe(1);

    await expect(
      closeChromeTargetWithRetainedCapability({
        ownerId: "owner-a",
        capability,
        targetId: "shared-target",
        logger,
      }),
    ).resolves.toEqual({ status: "completed" });
    acknowledgeChromeTargetCloseCapability({
      ownerId: "owner-b",
      capability: { ...capability },
      targetId: "shared-target",
    });
    expect(__test__.retainedAcknowledgedTerminalTargetCloseAuthorityCount()).toBe(0);
    acknowledgeChromeTargetCloseCapability({
      ownerId: "owner-a",
      capability,
      targetId: "shared-target",
    });
    expect(__test__.retainedAcknowledgedTerminalTargetCloseAuthorityCount()).toBe(1);
    expect(close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  test("treats cleanup-free captures as restart durable", () => {
    expect(hasRestartDurableChromeTargetCleanupAuthority({})).toBe(true);
    expect(
      hasRestartDurableChromeTargetCleanupAuthority({ chromeTargetId: "orphaned-target" }),
    ).toBe(false);
  });

  test("keeps manual kept and borrowed targets non-restart-durable with live capabilities", async () => {
    const browserWSEndpoint = "ws://service.example:9222/devtools/browser/live-generation";
    const close = vi.fn(async () => ({ status: "completed" as const }));
    const capability = retainChromeTargetCloseCapability({
      ownerId: "test-owner",
      generationId: "live-generation",
      targetId: "owned-target",
      browserWSEndpoint,
      close,
    });
    const chromeProcessIdentity = processIdentity(
      "/tmp/oracle-live-target-authority",
      4321,
      "10000000-0000-4000-8000-000000000001",
    );
    const resource = {
      chromeHost: "service.example",
      chromePort: 9222,
      chromeBrowserWSEndpoint: browserWSEndpoint,
      chromeTargetId: "owned-target",
      chromeProcessIdentity,
      targetCloseCapability: capability,
      acquisition: { generationId: "live-generation" },
      recoveryCleanup: {
        ownsTarget: true,
        profileKind: "manual-login" as const,
        keepBrowser: true,
        closeOwnedTargetOnComplete: true,
      },
    };
    const temporaryResource = {
      ...resource,
      recoveryCleanup: {
        ...resource.recoveryCleanup,
        profileKind: "temporary" as const,
        keepBrowser: false,
      },
    };
    const borrowedResource = {
      ...resource,
      chromeProcessIdentity: undefined,
      recoveryCleanup: {
        ...resource.recoveryCleanup,
        profileKind: "none" as const,
        keepBrowser: false,
      },
    };

    expect(capability).toMatchObject({
      targetId: "owned-target",
      browserWSEndpoint,
      ownerIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(
      [resource, temporaryResource, borrowedResource].map((candidate) =>
        hasRestartDurableChromeTargetCleanupAuthority({
          recoveryCleanupResources: [candidate],
        }),
      ),
    ).toEqual([false, true, false]);

    __test__.clearRetainedTargetCloseAuthorities();
    expect(
      [resource, temporaryResource, borrowedResource].map((candidate) =>
        hasRestartDurableChromeTargetCleanupAuthority({
          recoveryCleanupResources: [candidate],
        }),
      ),
    ).toEqual([false, true, false]);

    const listWithExactAuthority = vi
      .fn()
      .mockResolvedValueOnce({ status: "completed" as const, value: [] })
      .mockResolvedValueOnce({
        status: "completed" as const,
        value: [{ targetId: "owned-target" }],
      })
      .mockResolvedValueOnce({ status: "completed" as const, value: [{ type: "page" }] })
      .mockResolvedValueOnce({ status: "unsafe" as const, reason: "process identity changed" })
      .mockResolvedValueOnce({ status: "gone" as const });
    const reconstructedAuthority = {
      browserWSEndpoint,
      runExactOperation: vi.fn(),
    };
    await expect(
      closeChromeTargetWithRetainedCapability({
        ownerId: "test-owner",
        capability,
        targetId: "owned-target",
        logger: vi.fn<(message: string) => void>() as BrowserLogger,
        reconstructedAuthority,
        listWithExactAuthority,
      }),
    ).resolves.toEqual({ status: "completed" });
    await expect(
      closeChromeTargetWithRetainedCapability({
        ownerId: "test-owner",
        capability,
        targetId: "owned-target",
        logger: vi.fn<(message: string) => void>() as BrowserLogger,
        reconstructedAuthority,
        listWithExactAuthority,
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("target remains present"),
    });
    await expect(
      closeChromeTargetWithRetainedCapability({
        ownerId: "test-owner",
        capability,
        targetId: "owned-target",
        logger: vi.fn<(message: string) => void>() as BrowserLogger,
        reconstructedAuthority,
        listWithExactAuthority,
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("listing is ambiguous"),
    });
    await expect(
      closeChromeTargetWithRetainedCapability({
        ownerId: "test-owner",
        capability,
        targetId: "owned-target",
        logger: vi.fn<(message: string) => void>() as BrowserLogger,
        reconstructedAuthority,
        listWithExactAuthority,
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("process identity changed"),
    });
    await expect(
      closeChromeTargetWithRetainedCapability({
        ownerId: "test-owner",
        capability,
        targetId: "owned-target",
        logger: vi.fn<(message: string) => void>() as BrowserLogger,
        reconstructedAuthority,
        listWithExactAuthority,
      }),
    ).resolves.toEqual({ status: "gone" });
    expect(listWithExactAuthority).toHaveBeenCalledTimes(5);
    expect(close).not.toHaveBeenCalled();
  });

  test("settles a target proven absent after restart loses its unpersisted terminal capability", async () => {
    __test__.clearRetainedTargetCloseAuthorities();
    const profileDir = path.join(os.tmpdir(), "oracle-browser-target-close-crash");
    const generationId = "10000000-0000-4000-8000-000000000002";
    const processIdentity = restartBoundProcessIdentity(profileDir, 9_121, generationId);
    const browserWSEndpoint = "ws://127.0.0.1:63341/devtools/browser/crash-generation";
    const liveClose = vi.fn(async () => ({ status: "completed" as const }));
    const capability = retainChromeTargetCloseCapability({
      ownerId: "test-owner",
      generationId,
      targetId: "crash-target",
      browserWSEndpoint,
      close: liveClose,
    });
    const runtime = withRecoveryCleanup(
      {
        chromeProcessIdentity: processIdentity,
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        chromeHost: "127.0.0.1",
        chromePort: 63341,
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chromeTargetId: "crash-target",
      },
      {
        ownsTarget: true,
        profileKind: "manual-login",
        keepBrowser: true,
        closeOwnedTargetOnComplete: true,
      },
      undefined,
      {
        targetCloseCapability: capability,
        acquisition: {
          generationId,
          processLaunchClaim: processIdentity.launchClaim,
        },
      },
    );

    await expect(
      finalizeRecoveredRuntime(runtime, createBrowserLogger(), { ownerId: "test-owner" }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(liveClose).toHaveBeenCalledOnce();

    __test__.clearRetainedTargetCloseAuthorities();
    const recoveryCleanup = authenticatedLocalTargetCleanupDeps({
      mockRetainedTargetClose: false,
    });
    await expect(
      finalizeRecoveredRuntime(runtime, createBrowserLogger(), recoveryCleanup),
    ).resolves.toMatchObject({ status: "completed" });
    expect(recoveryCleanup.retainChromeEndpointAuthority).toHaveBeenCalledOnce();
    expect(recoveryCleanup.listChromeTargetsWithExactAuthority).toHaveBeenCalledOnce();
    expect(recoveryCleanup.closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
    expect(liveClose).toHaveBeenCalledOnce();
  });

  test("settles restart cleanup when the exact recorded Chrome process is gone", async () => {
    __test__.clearRetainedTargetCloseAuthorities();
    const profileDir = path.join(os.tmpdir(), "oracle-browser-target-process-gone");
    const generationId = "10000000-0000-4000-8000-000000000003";
    const processIdentity = restartBoundProcessIdentity(profileDir, 9_124, generationId);
    const browserWSEndpoint = "ws://127.0.0.1:63344/devtools/browser/gone-generation";
    const liveClose = vi.fn(async () => ({ status: "completed" as const }));
    const capability = retainChromeTargetCloseCapability({
      ownerId: "test-owner",
      generationId,
      targetId: "gone-target",
      browserWSEndpoint,
      close: liveClose,
    });
    __test__.clearRetainedTargetCloseAuthorities();
    const runtime = withRecoveryCleanup(
      {
        chromeProcessIdentity: processIdentity,
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        chromeHost: "127.0.0.1",
        chromePort: 63344,
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chromeTargetId: "gone-target",
      },
      {
        ownsTarget: true,
        profileKind: "manual-login",
        keepBrowser: true,
        closeOwnedTargetOnComplete: true,
      },
      undefined,
      {
        targetCloseCapability: capability,
        acquisition: {
          generationId,
          processLaunchClaim: processIdentity.launchClaim,
        },
      },
    );
    const recoveryCleanup = {
      ...authenticatedLocalTargetCleanupDeps({ mockRetainedTargetClose: false }),
      inspectChromeProcessIdentity: vi.fn(async () => "exited" as const),
      readOracleChromeOwner: vi.fn(async () => null),
    };

    await expect(
      finalizeRecoveredRuntime(runtime, createBrowserLogger(), recoveryCleanup),
    ).resolves.toMatchObject({ status: "completed" });
    expect(recoveryCleanup.inspectChromeProcessIdentity).toHaveBeenCalledOnce();
    expect(recoveryCleanup.readOracleChromeOwner).toHaveBeenCalledOnce();
    expect(recoveryCleanup.retainChromeEndpointAuthority).not.toHaveBeenCalled();
    expect(recoveryCleanup.listChromeTargetsWithExactAuthority).not.toHaveBeenCalled();
    expect(recoveryCleanup.closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
    expect(liveClose).not.toHaveBeenCalled();
  });

  test("preserves a target proven present after restart without live close capability", async () => {
    __test__.clearRetainedTargetCloseAuthorities();
    const profileDir = path.join(os.tmpdir(), "oracle-browser-target-present-after-restart");
    const generationId = "10000000-0000-4000-8000-000000000004";
    const processIdentity = restartBoundProcessIdentity(profileDir, 9_123, generationId);
    const browserWSEndpoint = "ws://127.0.0.1:63343/devtools/browser/present-after-restart";
    const liveClose = vi.fn(async () => ({ status: "completed" as const }));
    const capability = retainChromeTargetCloseCapability({
      ownerId: "test-owner",
      generationId,
      targetId: "present-target",
      browserWSEndpoint,
      close: liveClose,
    });
    __test__.clearRetainedTargetCloseAuthorities();
    const runtime = withRecoveryCleanup(
      {
        chromeProcessIdentity: processIdentity,
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        chromeHost: "127.0.0.1",
        chromePort: 63343,
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chromeTargetId: "present-target",
      },
      {
        ownsTarget: true,
        profileKind: "manual-login",
        keepBrowser: true,
        closeOwnedTargetOnComplete: true,
      },
      undefined,
      {
        targetCloseCapability: capability,
        acquisition: {
          generationId,
          processLaunchClaim: processIdentity.launchClaim,
        },
      },
    );
    const listChromeTargetsWithExactAuthority = vi.fn(async () => ({
      status: "completed" as const,
      value: [{ targetId: "present-target", type: "page" }],
    }));
    const recoveryCleanup = {
      ...authenticatedLocalTargetCleanupDeps({ mockRetainedTargetClose: false }),
      listChromeTargetsWithExactAuthority,
    };

    await expect(
      finalizeRecoveredRuntime(runtime, createBrowserLogger(), recoveryCleanup),
    ).resolves.toMatchObject({
      status: "pending",
      error: expect.stringContaining("target remains present"),
      runtime: {
        recoveryCleanupResources: [expect.objectContaining({ chromeTargetId: "present-target" })],
      },
    });
    expect(listChromeTargetsWithExactAuthority).toHaveBeenCalledOnce();
    expect(recoveryCleanup.closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
    expect(liveClose).not.toHaveBeenCalled();
  });

  test.each(["owner", "generation", "endpoint", "process", "target"] as const)(
    "preserves the target after %s authority substitution",
    async (substitution) => {
      __test__.clearRetainedTargetCloseAuthorities();
      const profileDir = path.join(os.tmpdir(), `oracle-browser-target-${substitution}-mismatch`);
      const authenticatedGenerationId = "10000000-0000-4000-8000-000000000005";
      const replacementGenerationId = "20000000-0000-4000-8000-000000000005";
      const processIdentity = restartBoundProcessIdentity(
        profileDir,
        9_122,
        authenticatedGenerationId,
      );
      const browserWSEndpoint = "ws://127.0.0.1:63342/devtools/browser/authenticated-generation";
      const capability = retainChromeTargetCloseCapability({
        ownerId: "test-owner",
        generationId: authenticatedGenerationId,
        targetId: "authenticated-target",
        browserWSEndpoint,
        close: vi.fn(async () => ({ status: "completed" as const })),
      });
      __test__.clearRetainedTargetCloseAuthorities();
      const runtime = withRecoveryCleanup(
        {
          chromeProcessIdentity: processIdentity,
          chromeProfileRoot: profileDir,
          userDataDir: profileDir,
          chromeHost: "127.0.0.1",
          chromePort: 63342,
          chromeBrowserWSEndpoint: browserWSEndpoint,
          chromeTargetId: substitution === "target" ? "replacement-target" : "authenticated-target",
        },
        {
          ownsTarget: true,
          profileKind: "manual-login",
          keepBrowser: true,
          closeOwnedTargetOnComplete: true,
        },
        undefined,
        {
          targetCloseCapability:
            substitution === "generation"
              ? { ...capability, generationId: replacementGenerationId }
              : capability,
          acquisition: {
            generationId:
              substitution === "generation" ? replacementGenerationId : authenticatedGenerationId,
            processLaunchClaim: processIdentity.launchClaim,
          },
        },
      );
      const closeExact = vi.fn(async () => ({ status: "completed" as const }));
      const authenticated = authenticatedLocalTargetCleanupDeps({
        mockRetainedTargetClose: false,
      });
      const retainReplacementEndpoint = vi.fn(async () => ({
        browserWSEndpoint: "ws://127.0.0.1:63342/devtools/browser/replacement-generation",
        kill: vi.fn(async () => stopped),
        runExactOperation: vi.fn(),
        release: vi.fn(async () => undefined),
      }));
      const result = await finalizeRecoveredRuntime(runtime, createBrowserLogger(), {
        ...authenticated,
        closeChromeTargetWithExactAuthority: closeExact,
        ...(substitution === "owner" ? { ownerId: "replacement-owner" } : {}),
        ...(substitution === "endpoint"
          ? { retainChromeEndpointAuthority: retainReplacementEndpoint }
          : {}),
        ...(substitution === "process"
          ? { inspectChromeProcessIdentity: vi.fn(async () => "unavailable" as const) }
          : {}),
      });

      expect(result.status).toBe("pending");
      expect(closeExact).not.toHaveBeenCalled();
      expect(authenticated.listChromeTargetsWithExactAuthority).not.toHaveBeenCalled();
      if (substitution === "endpoint") {
        expect(retainReplacementEndpoint).toHaveBeenCalledOnce();
      } else {
        expect(authenticated.retainChromeEndpointAuthority).not.toHaveBeenCalled();
      }
    },
  );

  test("does not let an exact sibling settle a substituted target sharing its capability id", async () => {
    __test__.clearRetainedTargetCloseAuthorities();
    const profileDir = path.join(os.tmpdir(), "oracle-browser-target-sibling-substitution");
    const generationId = "10000000-0000-4000-8000-000000000006";
    const processIdentity = restartBoundProcessIdentity(profileDir, 9_125, generationId);
    const browserWSEndpoint = "ws://127.0.0.1:63345/devtools/browser/sibling-generation";
    const liveClose = vi.fn(async () => ({ status: "completed" as const }));
    const capability = retainChromeTargetCloseCapability({
      ownerId: "test-owner",
      generationId,
      targetId: "authenticated-target",
      browserWSEndpoint,
      close: liveClose,
    });
    __test__.clearRetainedTargetCloseAuthorities();
    const runtime = withRecoveryCleanup(
      {
        chromeProcessIdentity: processIdentity,
        chromeProfileRoot: profileDir,
        userDataDir: profileDir,
        chromeHost: "127.0.0.1",
        chromePort: 63345,
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chromeTargetId: "authenticated-target",
      },
      {
        ownsTarget: true,
        profileKind: "manual-login",
        keepBrowser: true,
        closeOwnedTargetOnComplete: true,
      },
      undefined,
      {
        targetCloseCapability: capability,
        acquisition: {
          generationId,
          processLaunchClaim: processIdentity.launchClaim,
        },
      },
    );
    const authenticatedResource = runtime.recoveryCleanupResources?.[0];
    if (!authenticatedResource) throw new Error("Expected authenticated cleanup resource");
    const recoveryCleanup = authenticatedLocalTargetCleanupDeps({ mockRetainedTargetClose: false });

    await expect(
      finalizeRecoveredRuntime(
        {
          ...runtime,
          recoveryCleanupResources: [
            authenticatedResource,
            { ...authenticatedResource, chromeTargetId: "replacement-target" },
          ],
        },
        createBrowserLogger(),
        recoveryCleanup,
      ),
    ).resolves.toMatchObject({
      status: "pending",
      runtime: {
        recoveryCleanupResources: [
          expect.objectContaining({
            chromeTargetId: "replacement-target",
            targetCloseCapability: capability,
          }),
        ],
      },
    });
    expect(recoveryCleanup.listChromeTargetsWithExactAuthority).toHaveBeenCalledOnce();
    expect(recoveryCleanup.closeChromeTargetWithExactAuthority).not.toHaveBeenCalled();
    expect(liveClose).not.toHaveBeenCalled();
  });

  test("allows exact owned temporary-process teardown to subsume target close", () => {
    const chromeProcessIdentity = processIdentity(
      "/tmp/oracle-exact-temporary-target-authority",
      4322,
      "10000000-0000-4000-8000-000000000002",
    );

    expect(
      hasRestartDurableChromeTargetCleanupAuthority({
        recoveryCleanupResources: [
          {
            chromeProcessIdentity,
            chromeBrowserWSEndpoint:
              "ws://service.example:9222/devtools/browser/exact-temporary-generation",
            chromeTargetId: "temporary-target",
            targetCloseCapability: {
              version: 1,
              generationId: chromeProcessIdentity.launchClaim.generationId,
              capabilityId: "exact-temporary-capability",
              targetId: "temporary-target",
              browserWSEndpoint:
                "ws://service.example:9222/devtools/browser/exact-temporary-generation",
            },
            acquisition: {
              generationId: chromeProcessIdentity.launchClaim.generationId,
              processLaunchClaim: chromeProcessIdentity.launchClaim,
            },
            recoveryCleanup: {
              ownsTarget: true,
              profileKind: "temporary",
              keepBrowser: false,
              closeOwnedTargetOnComplete: true,
            },
          },
        ],
      }),
    ).toBe(true);
  });
});
