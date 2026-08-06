import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import { createLocalBrowserRunState } from "../../src/browser/localRunState.js";
import {
  captureProfileDirectoryIdentity,
  createChromeProcessLaunchClaim,
  type ChromeOwnerDisposition,
  type ChromeProcessIdentity,
  type ProfileDirectoryIdentity,
} from "../../src/browser/profileState.js";
import type {
  ChromeLaunchResult,
  RetainedChromeEndpointAuthority,
} from "../../src/browser/chromeLifecycle.js";
import type { LocalBrowserAcquisition } from "../../src/browser/localAcquisition.js";
import type { ManualChromeOwner } from "../../src/browser/manualChromeOwner.js";
import type * as ManualLoginProfileModule from "../../src/browser/manualLoginProfile.js";
import type {
  BrowserTabLease,
  BrowserTabLeaseTeardownAuthority,
} from "../../src/browser/tabLeaseRegistry.js";
import type * as TabLeaseRegistryModule from "../../src/browser/tabLeaseRegistry.js";
import { promptIdentitySha256 } from "../../src/browser/actions/committedPrompt.js";
import { __test__ as targetCloseAuthorityTest } from "../../src/browser/targetCloseAuthority.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionManager.js";

const logger = vi.fn<(message: string) => void>();

function manualOwner(
  profileDirectory: ProfileDirectoryIdentity,
  disposition: ChromeOwnerDisposition,
  pid = 54_321,
  port = 45_678,
): { owner: ManualChromeOwner; authority: RetainedChromeEndpointAuthority } {
  const identity: ChromeProcessIdentity = {
    pid,
    processStartTime: "2026-08-05T00:00:00.000Z",
    executablePath:
      process.platform === "win32"
        ? String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`.toLowerCase()
        : process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : "/usr/bin/google-chrome",
    normalizedUserDataDir:
      process.platform === "win32"
        ? profileDirectory.canonicalPath.toLowerCase()
        : profileDirectory.canonicalPath,
    launchNonce: `mixed-owner-${pid}`,
    profileDirectory,
  };
  const authority: RetainedChromeEndpointAuthority = {
    browserWSEndpoint: `ws://127.0.0.1:${port}/devtools/browser/mixed-${identity.pid}`,
    kill: vi.fn(async () => ({ status: "already-stopped" as const, pid: identity.pid })),
    release: vi.fn(async () => undefined),
  };
  const chrome = {
    pid,
    port,
    process: undefined,
    processIdentity: identity,
    endpointAuthority: authority,
    kill: authority.kill,
  } as unknown as ChromeLaunchResult;
  return {
    owner: {
      chrome,
      processIdentity: identity,
      source: "recorded",
      disposition,
      endpointAuthority: authority,
    },
    authority,
  };
}

function lastLeaseTeardownAuthority(lease: BrowserTabLease): BrowserTabLeaseTeardownAuthority {
  let leaseReleased = false;
  return {
    get leaseReleased() {
      return leaseReleased;
    },
    settle: async (teardown) => {
      if (!leaseReleased) {
        await lease.release();
        leaseReleased = true;
      }
      return (await teardown())
        ? { status: "completed", disposition: "teardown-completed" }
        : { status: "preserved", reason: "teardown-unsafe" };
    },
  };
}

function manualOwnerSettlementMocks() {
  const releaseManualChromeOwnerEndpointAuthority = vi.fn(async (owner: ManualChromeOwner) => {
    await owner.endpointAuthority?.release();
  });
  const settleManualChromeOwner = vi.fn(async (_profileDir: string, owner: ManualChromeOwner) => {
    if (owner.disposition === "preserve") {
      await owner.endpointAuthority?.release();
      return { status: "preserved" as const };
    }
    const outcome = await owner.endpointAuthority?.kill();
    return outcome?.status === "already-stopped" || outcome?.status === "stopped"
      ? { status: "terminated" as const }
      : { status: "unsafe" as const, reason: "termination failed" };
  });
  return { releaseManualChromeOwnerEndpointAuthority, settleManualChromeOwner };
}

afterEach(() => {
  vi.doUnmock("../../src/browser/manualChromeOwner.js");
  vi.doUnmock("../../src/browser/manualLoginProfile.js");
  vi.doUnmock("../../src/browser/tabLeaseRegistry.js");
  vi.resetModules();
  logger.mockClear();
  targetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
});

async function settleLocalOwnedTarget(options: {
  mode: "finalize" | "abort";
  keepBrowser: boolean;
  preserveBrowserOnError?: boolean;
  usingCopiedProfile?: boolean;
  unpublished?: boolean;
  loseTargetCapabilityBeforeSettlement?: boolean;
}) {
  const [
    { createLocalRunSettlementCoordinator },
    { LocalOwnedBrowserResourceAuthority },
    { retainChromeTargetCloseCapability, __test__: localTargetCloseAuthorityTest },
  ] = await Promise.all([
    import("../../src/browser/localRunSettlement.js"),
    import("../../src/browser/ownedBrowserResources.js"),
    import("../../src/browser/targetCloseAuthority.js"),
  ]);
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-local-target-disposition-"));
  const profileDirectory = await captureProfileDirectoryIdentity(profileDir);
  const { owner, authority } = manualOwner(profileDirectory, "close-on-last-lease");
  const generationId = "70000000-0000-4000-8000-000000000007" as const;
  const targetId = `local-${options.mode}-${options.keepBrowser ? "preserve" : "close"}`;
  const closeTarget = vi.fn(async () => ({ status: "completed" as const }));
  const targetCloseCapability = retainChromeTargetCloseCapability({
    ownerId: "test-owner",
    generationId,
    targetId,
    close: closeTarget,
  });
  const state = createLocalBrowserRunState(null);
  state.ownsTarget = true;
  state.isolatedTargetId = targetId;
  state.lastTargetId = targetId;
  state.targetCloseCapability = targetCloseCapability;
  state.runStatus = "complete";
  state.preserveBrowserOnError = options.preserveBrowserOnError ?? false;
  const config = resolveBrowserConfig({ keepBrowser: options.keepBrowser, headless: false });
  let latestRuntime: BrowserRuntimeMetadata | null = null;
  const resourceAuthority = new LocalOwnedBrowserResourceAuthority({
    ownerId: "test-owner",
    purpose: "Local ChatGPT test",
    targetLabel: "Owned Chrome",
    userDataDir: profileDir,
    profileDirectoryIdentity: profileDirectory,
    profileKind: options.usingCopiedProfile ? "copied" : "temporary",
    keepBrowser: options.keepBrowser,
    closeOwnedTargetOnComplete: !options.keepBrowser,
    generationId,
    processOwnerProvenance: "temporary-launch",
    processLaunchClaim: createChromeProcessLaunchClaim(generationId),
    processOwnerDisposition: options.keepBrowser ? "preserve" : "close-on-last-lease",
    targetMarkerUrl: `about:blank#oracle-acquisition=${generationId}`,
    logger,
    persistRuntime: async (runtime) => {
      latestRuntime = structuredClone(runtime);
      return runtime;
    },
    settleTemporaryProcess: async (chrome) => {
      const keepBrowser = latestRuntime?.recoveryCleanupResources?.find(
        (resource) => resource.acquisition?.generationId === generationId,
      )?.recoveryCleanup.keepBrowser;
      if (keepBrowser) {
        await chrome.endpointAuthority?.release();
        return { status: "completed", disposition: "preserved" };
      }
      await chrome.kill();
      await rm(profileDir, { recursive: true, force: true });
      return { status: "completed", disposition: "terminated" };
    },
  });
  await resourceAuthority.journalAcquisition({
    resource: "chrome-process",
    acquire: async () => owner.chrome,
    authority: (chrome) => ({ kind: "temporary", chrome }),
  });
  await resourceAuthority.journalAcquisition({
    resource: "chrome-target",
    acquire: async () => ({ targetId }),
    authority: () => ({ targetId, capability: targetCloseCapability }),
  });
  const acquisition: LocalBrowserAcquisition = {
    config,
    manualLogin: false,
    profileIsPreSigned: options.usingCopiedProfile ?? false,
    userDataDir: profileDir,
    effectiveKeepBrowser: options.keepBrowser,
    resourceAuthority,
    chrome: owner.chrome,
    chromeOwnerDisposition: "close-on-last-lease",
    chromeHost: "127.0.0.1",
    tabLease: null,
  };
  const coordinator = createLocalRunSettlementCoordinator({
    acquisition,
    state,
    options: {
      prompt: "review",
      runtimeHintCb: async (runtime) => {
        latestRuntime = structuredClone(runtime);
      },
    },
    logger,
    usingCopiedProfile: options.usingCopiedProfile ?? false,
    timing: { startedAt: Date.now() },
  });
  coordinator.lifecycle.markAcquired();
  const identity = await coordinator.lifecycle.beginPromptDispatch("review", 0, 0, 0);
  await coordinator.lifecycle.recordPromptCommitVerification(
    {
      committedTurns: 1,
      promptSha256: promptIdentitySha256("review"),
      verifiedUserTurnIndex: 0,
      verifiedUserTurnId: "turn-0",
      verifiedUserMessageId: "message-0",
      conversationId: "local-disposition",
    },
    identity,
  );
  const projectedRuntime = coordinator.buildRuntimeMetadata();
  const cleanup = projectedRuntime.recoveryCleanupResources?.[0]?.recoveryCleanup;
  const disposition = cleanup?.closeOwnedTargetOnComplete;
  if (options.loseTargetCapabilityBeforeSettlement) {
    localTargetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
  }
  try {
    const result = await (async () => {
      if (options.unpublished) return await coordinator.lifecycle.settleIfUnpublished();
      const transaction = coordinator.lifecycle.issueCapture({
        answerText: "answer",
        answerMarkdown: "answer",
        tookMs: 1,
        answerTokens: 1,
        answerChars: 6,
      });
      return await transaction[options.mode]();
    })();
    if (!result) throw new Error("Expected local browser resource settlement");
    const profileExists = await stat(profileDir).then(
      () => true,
      () => false,
    );
    return {
      authority,
      closeTarget,
      disposition,
      profileExists,
      projectedRuntime,
      result,
      targetId,
    };
  } finally {
    localTargetCloseAuthorityTest.clearRetainedTargetCloseAuthorities();
    await rm(profileDir, { recursive: true, force: true });
  }
}

describe("local owned-target disposition", () => {
  test.each(["finalize", "abort"] as const)(
    "%s closes the default owned target and preserves a keep-browser target",
    async (mode) => {
      const closed = await settleLocalOwnedTarget({ mode, keepBrowser: false });
      expect(closed.disposition).toBe(true);
      expect(closed.closeTarget).toHaveBeenCalledOnce();
      expect(closed.result.runtime.chromeTargetId).toBeUndefined();

      const preserved = await settleLocalOwnedTarget({ mode, keepBrowser: true });
      expect(preserved.disposition).toBe(false);
      expect(preserved.closeTarget).not.toHaveBeenCalled();
      expect(preserved.result.runtime.chromeTargetId).toBe(`local-${mode}-preserve`);
      if (mode === "abort") {
        expect(preserved.authority.kill).toHaveBeenCalledOnce();
      } else {
        expect(preserved.authority.kill).not.toHaveBeenCalled();
      }
    },
  );

  test.each([
    { name: "temporary profile", usingCopiedProfile: false, preserved: true },
    { name: "copied profile", usingCopiedProfile: true, preserved: false },
  ])("unpublished abort settles a preserved $name safely", async (scenario) => {
    const settlement = await settleLocalOwnedTarget({
      mode: "abort",
      keepBrowser: false,
      preserveBrowserOnError: true,
      usingCopiedProfile: scenario.usingCopiedProfile,
      unpublished: true,
    });

    expect(settlement.result.status).toBe("completed");
    expect(
      settlement.projectedRuntime.recoveryCleanupResources?.[0]?.recoveryCleanup.keepBrowser,
    ).toBe(scenario.preserved);
    expect(settlement.disposition).toBe(!scenario.preserved);
    expect(settlement.closeTarget).toHaveBeenCalledTimes(scenario.preserved ? 0 : 1);
    expect(settlement.result.runtime.chromeTargetId).toBe(
      scenario.preserved ? settlement.targetId : undefined,
    );
    expect(settlement.result.runtime.recoveryCleanupResources).toBeUndefined();
    expect(settlement.result.runtime.recoveryCleanupResult).toBeUndefined();
    expect(settlement.authority.kill).toHaveBeenCalledTimes(scenario.preserved ? 0 : 1);
    expect(settlement.profileExists).toBe(scenario.preserved);
  });

  test.each(["finalize", "abort"] as const)(
    "%s lets exact temporary-process teardown settle a target capability lost on restart",
    async (mode) => {
      const settlement = await settleLocalOwnedTarget({
        mode,
        keepBrowser: false,
        loseTargetCapabilityBeforeSettlement: true,
      });

      expect(settlement.result.status).toBe("completed");
      expect(settlement.closeTarget).not.toHaveBeenCalled();
      expect(settlement.authority.kill).toHaveBeenCalledOnce();
    },
  );
});

describe("local manual Chrome owner settlement", () => {
  test.each([
    {
      name: "current preserve with recorded close-on-last-lease",
      keepBrowser: true,
      ownerDisposition: "close-on-last-lease",
      expectedDirectRelease: 1,
      expectedOwnerSettlement: 0,
      expectedEndpointRelease: 1,
      expectedEndpointKill: 0,
    },
    {
      name: "current close with recorded close-on-last-lease",
      keepBrowser: false,
      ownerDisposition: "close-on-last-lease",
      expectedDirectRelease: 0,
      expectedOwnerSettlement: 1,
      expectedEndpointRelease: 0,
      expectedEndpointKill: 1,
    },
    {
      name: "current preserve with recorded preserve",
      keepBrowser: true,
      ownerDisposition: "preserve",
      expectedDirectRelease: 0,
      expectedOwnerSettlement: 1,
      expectedEndpointRelease: 1,
      expectedEndpointKill: 0,
    },
    {
      name: "current close with recorded preserve",
      keepBrowser: false,
      ownerDisposition: "preserve",
      expectedDirectRelease: 0,
      expectedOwnerSettlement: 1,
      expectedEndpointRelease: 1,
      expectedEndpointKill: 0,
    },
  ] as const)("settles $name without leaking or closing the wrong owner", async (scenario) => {
    vi.resetModules();
    const ownerMocks = manualOwnerSettlementMocks();
    vi.doMock("../../src/browser/manualChromeOwner.js", () => ownerMocks);
    const profileDirectory: ProfileDirectoryIdentity = {
      version: 2,
      platform: process.platform,
      canonicalPath: path.join(os.tmpdir(), "oracle-mixed-owner-settlement"),
      device: "1",
      inode: "2",
      birthtimeNs: "3",
    };
    const { owner, authority } = manualOwner(profileDirectory, scenario.ownerDisposition);
    const releaseLease = vi.fn(async () => undefined);
    const lease: BrowserTabLease = {
      id: "mixed-owner-lease",
      sessionId: "test-owner",
      generationId: "10000000-0000-4000-8000-000000000001",
      profileDirectory,
      release: releaseLease,
      update: vi.fn(async () => undefined),
    };
    vi.doMock("../../src/browser/tabLeaseRegistry.js", async (importOriginal) => ({
      ...(await importOriginal<typeof TabLeaseRegistryModule>()),
      retainBrowserTabLeaseTeardownAuthority: vi.fn(() => lastLeaseTeardownAuthority(lease)),
    }));
    // The subjects must load after the manual-owner and lease settlement mocks are installed.
    const [{ createLocalRunSettlementCoordinator }, { LocalOwnedBrowserResourceAuthority }] =
      await Promise.all([
        import("../../src/browser/localRunSettlement.js"),
        import("../../src/browser/ownedBrowserResources.js"),
      ]);
    const generationId = "10000000-0000-4000-8000-000000000001";
    const resourceAuthority = new LocalOwnedBrowserResourceAuthority({
      ownerId: "test-owner",
      purpose: "Local ChatGPT test",
      targetLabel: "Owned Chrome",
      userDataDir: profileDirectory.canonicalPath,
      profileDirectoryIdentity: profileDirectory,
      profileKind: "manual-login",
      keepBrowser: scenario.keepBrowser,
      closeOwnedTargetOnComplete: false,
      generationId,
      processOwnerProvenance: "manual-canonical-owner",
      processLaunchClaim: createChromeProcessLaunchClaim(generationId),
      processOwnerDisposition: scenario.keepBrowser ? "preserve" : "close-on-last-lease",
      leaseId: lease.id,
      targetMarkerUrl: "about:blank#oracle-acquisition=mixed-owner",
      logger,
    });
    await resourceAuthority.journalAcquisition({
      resource: "tab-lease",
      acquire: async () => lease,
      authority: (acquiredLease) => acquiredLease,
    });
    await resourceAuthority.journalAcquisition({
      resource: "chrome-process",
      acquire: async () => owner,
      authority: (acquiredOwner) => ({ kind: "manual", owner: acquiredOwner }),
    });
    const state = createLocalBrowserRunState(lease);
    state.ownsTarget = false;
    state.runStatus = "complete";
    const config = resolveBrowserConfig({
      manualLogin: true,
      manualLoginProfileDir: profileDirectory.canonicalPath,
      keepBrowser: scenario.keepBrowser,
    });
    const acquisition: LocalBrowserAcquisition = {
      config,
      manualLogin: true,
      profileIsPreSigned: true,
      userDataDir: profileDirectory.canonicalPath,
      effectiveKeepBrowser: scenario.keepBrowser,
      resourceAuthority,
      chrome: owner.chrome,
      chromeOwnerDisposition: scenario.ownerDisposition,
      chromeHost: "127.0.0.1",
      tabLease: lease,
    };

    const coordinator = createLocalRunSettlementCoordinator({
      acquisition,
      state,
      options: { prompt: "test" },
      logger,
      usingCopiedProfile: false,
      timing: { startedAt: Date.now() },
    });

    await expect(coordinator.lifecycle.settleIfUnpublished()).resolves.toMatchObject({
      status: "completed",
    });
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(state.tabLease).toBeNull();
    expect(ownerMocks.releaseManualChromeOwnerEndpointAuthority).toHaveBeenCalledTimes(
      scenario.expectedDirectRelease,
    );
    expect(ownerMocks.settleManualChromeOwner).toHaveBeenCalledTimes(
      scenario.expectedOwnerSettlement,
    );
    expect(authority.release).toHaveBeenCalledTimes(scenario.expectedEndpointRelease);
    expect(authority.kill).toHaveBeenCalledTimes(scenario.expectedEndpointKill);
  });

  test("preserves a current keep-browser owner when process authority journaling fails", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-mixed-owner-acquisition-"));
    try {
      vi.resetModules();
      const profileDirectory = await captureProfileDirectoryIdentity(profileDir);
      const { owner, authority } = manualOwner(profileDirectory, "close-on-last-lease");
      const releaseLease = vi.fn(async () => undefined);
      const lease: BrowserTabLease = {
        id: "mixed-owner-lease",
        sessionId: "mixed-owner",
        generationId: "mixed-owner-generation",
        profileDirectory,
        release: releaseLease,
        update: vi.fn(async () => undefined),
      };
      const retainTeardownAuthority = vi.fn(() => lastLeaseTeardownAuthority(lease));
      const ownerMocks = manualOwnerSettlementMocks();
      const acquisitionFailure = new Error("process authority journal failed");
      let rejectedProcessJournal = false;

      vi.doMock("../../src/browser/manualChromeOwner.js", () => ({
        acquireManualChromeOwner: vi.fn(async () => owner),
        ...ownerMocks,
      }));
      vi.doMock("../../src/browser/manualLoginProfile.js", async (importOriginal) => ({
        ...(await importOriginal<typeof ManualLoginProfileModule>()),
        assertManualLoginProfileReadyForRun: vi.fn(async () => undefined),
      }));
      vi.doMock("../../src/browser/tabLeaseRegistry.js", async (importOriginal) => ({
        ...(await importOriginal<typeof TabLeaseRegistryModule>()),
        acquireBrowserTabLease: vi.fn(async () => lease),
        retainBrowserTabLeaseTeardownAuthority: retainTeardownAuthority,
      }));
      // The subject must load after acquisition collaborators are mocked.
      const { acquireLocalBrowserResources } =
        await import("../../src/browser/localAcquisition.js");
      const config = resolveBrowserConfig({
        manualLogin: true,
        manualLoginProfileDir: profileDir,
        keepBrowser: true,
      });

      await expect(
        acquireLocalBrowserResources({
          options: {
            prompt: "test",
            runtimeHintCb: async (runtime) => {
              const resource = runtime.recoveryCleanupResources?.[0];
              if (
                resource?.chromeProcessIdentity &&
                !resource.acquisition?.pendingResource &&
                !runtime.recoveryCleanupResult?.settlementMode &&
                !rejectedProcessJournal
              ) {
                rejectedProcessJournal = true;
                throw acquisitionFailure;
              }
            },
          },
          config,
          logger,
          usingCopiedProfile: false,
        }),
      ).rejects.toBe(acquisitionFailure);

      expect(releaseLease).toHaveBeenCalledOnce();
      expect(retainTeardownAuthority).toHaveBeenCalledOnce();
      expect(ownerMocks.releaseManualChromeOwnerEndpointAuthority).toHaveBeenCalledOnce();
      expect(ownerMocks.settleManualChromeOwner).not.toHaveBeenCalled();
      expect(authority.release).toHaveBeenCalledOnce();
      expect(authority.kill).not.toHaveBeenCalled();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test("preserves exact lease and process cleanup when endpoint update fails after its effect", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-endpoint-update-acquisition-"));
    try {
      vi.resetModules();
      const profileDirectory = await captureProfileDirectoryIdentity(profileDir);
      const { owner, authority } = manualOwner(profileDirectory, "close-on-last-lease");
      const endpointUpdateFailure = new Error("lease endpoint update failed after write");
      const terminalPersistenceFailure = new Error("terminal cleanup journal unavailable");
      let endpointUpdateApplied = false;
      let publishedEndpoint: { chromeHost: string; chromePort: number } | undefined;
      const releaseLease = vi.fn(async () => undefined);
      const updateLease = vi.fn(async (endpoint: Parameters<BrowserTabLease["update"]>[0]) => {
        publishedEndpoint = {
          chromeHost: endpoint.chromeHost ?? "",
          chromePort: endpoint.chromePort ?? -1,
        };
        endpointUpdateApplied = true;
        throw endpointUpdateFailure;
      });
      const lease: BrowserTabLease = {
        id: "endpoint-update-lease",
        sessionId: "endpoint-update-owner",
        generationId: "endpoint-update-generation",
        profileDirectory,
        release: releaseLease,
        update: updateLease,
      };
      const retainTeardownAuthority = vi.fn(() => lastLeaseTeardownAuthority(lease));
      const ownerMocks = manualOwnerSettlementMocks();
      const acquireOwner = vi.fn(async () => owner);
      const runtimeHints: BrowserRuntimeMetadata[] = [];

      vi.doMock("../../src/browser/manualChromeOwner.js", () => ({
        acquireManualChromeOwner: acquireOwner,
        ...ownerMocks,
      }));
      vi.doMock("../../src/browser/manualLoginProfile.js", async (importOriginal) => ({
        ...(await importOriginal<typeof ManualLoginProfileModule>()),
        assertManualLoginProfileReadyForRun: vi.fn(async () => undefined),
      }));
      vi.doMock("../../src/browser/tabLeaseRegistry.js", async (importOriginal) => ({
        ...(await importOriginal<typeof TabLeaseRegistryModule>()),
        acquireBrowserTabLease: vi.fn(async () => lease),
        retainBrowserTabLeaseTeardownAuthority: retainTeardownAuthority,
      }));
      // The subject must load after the acquisition collaborators are mocked.
      const { acquireLocalBrowserResources } =
        await import("../../src/browser/localAcquisition.js");
      const config = resolveBrowserConfig({
        manualLogin: true,
        manualLoginProfileDir: profileDir,
        keepBrowser: false,
      });

      let error: unknown;
      try {
        await acquireLocalBrowserResources({
          options: {
            prompt: "test",
            runtimeHintCb: async (runtime) => {
              if (endpointUpdateApplied && !runtime.recoveryCleanupResources?.length) {
                throw terminalPersistenceFailure;
              }
              runtimeHints.push(structuredClone(runtime));
            },
          },
          config,
          logger,
          usingCopiedProfile: false,
        });
      } catch (caught) {
        error = caught;
      }

      expect(publishedEndpoint).toEqual({ chromeHost: "127.0.0.1", chromePort: owner.chrome.port });
      expect(updateLease).toHaveBeenCalledOnce();
      expect(acquireOwner).toHaveBeenCalledOnce();
      expect(releaseLease).toHaveBeenCalledOnce();
      expect(retainTeardownAuthority).toHaveBeenCalledOnce();
      expect(ownerMocks.settleManualChromeOwner).toHaveBeenCalledOnce();
      expect(authority.kill).toHaveBeenCalledOnce();
      expect(error).toMatchObject({
        details: {
          code: "local-acquisition-cleanup-pending",
          runtime: {
            chromeProcessIdentity: owner.processIdentity,
            recoveryCleanupResult: {
              status: "failed",
              settlementMode: "abort",
            },
            recoveryCleanupResources: [
              expect.objectContaining({
                chromeProcessIdentity: owner.processIdentity,
                tabLease: {
                  id: lease.id,
                  generationId: lease.generationId,
                  profileDirectory,
                },
                acquisition: expect.not.objectContaining({
                  pendingResource: expect.anything(),
                }),
              }),
            ],
          },
        },
      });
      expect(runtimeHints.at(-1)).toMatchObject({
        recoveryCleanupResult: { status: "pending", settlementMode: "abort" },
        recoveryCleanupResources: [
          expect.objectContaining({
            chromeProcessIdentity: owner.processIdentity,
            tabLease: {
              id: lease.id,
              generationId: lease.generationId,
              profileDirectory,
            },
          }),
        ],
      });
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });
});
