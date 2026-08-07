import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import type * as PrivateTempRootModule from "../../src/privateTempRoot.js";
import { captureProfileDirectoryIdentity } from "../../src/browser/profileDirectoryAuthority.js";

const { generationBAttachTarget, generationBCloseTarget, generationBCreateTarget } = vi.hoisted(
  () => ({
    generationBAttachTarget: vi.fn(),
    generationBCloseTarget: vi.fn(),
    generationBCreateTarget: vi.fn(),
  }),
);

vi.mock("chrome-remote-interface", () => ({
  default: Object.assign(generationBAttachTarget, {
    New: generationBCreateTarget,
    Close: generationBCloseTarget,
    List: vi.fn(),
  }),
}));

import { connectOwnedProjectSourcesTargetForTest } from "../../src/browser/projectSourcesRunner.js";

test("Project Sources does not acquire a target from generation B after same-port rebinding", async () => {
  const endpointAuthority = {
    browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/generation-a",
    kill: vi.fn(),
    runExactOperation: vi.fn(async () => ({ status: "gone" as const })),
    release: vi.fn(),
  };

  await expect(
    connectOwnedProjectSourcesTargetForTest(
      endpointAuthority as never,
      vi.fn<(message: string) => void>(),
      0,
    ),
  ).rejects.toThrow(/generation exited/i);
  expect(generationBCreateTarget).not.toHaveBeenCalled();
  expect(generationBAttachTarget).not.toHaveBeenCalled();
  expect(generationBCloseTarget).not.toHaveBeenCalled();
});
test("persists and resolves Project Sources cleanup while discarding successful preserved targets", async () => {
  const temporaryBase = await mkdtemp(path.join(tmpdir(), "oracle-project-sources-runner-"));
  const mocks = {
    acquireLock: vi.fn(),
    afterPrivateGeneration: vi.fn(
      async (_generation: PrivateTempRootModule.PrivateTempGeneration) => undefined,
    ),
    closeTarget: vi.fn(),
    connectTarget: vi.fn(),
    launchChrome: vi.fn(),
    listTargets: vi.fn(),
    removeProfile: vi.fn(),
    resolveBrowserConfig: vi.fn(),
    retainEndpoint: vi.fn(),
    retryCleanup: vi.fn(),
  };
  // Module isolation is required so this focused runner test can replace browser process effects.
  vi.resetModules();
  vi.doMock("../../src/oracleHome.js", () => ({
    getOracleHomeDir: () => temporaryBase,
  }));
  vi.doMock("../../src/privateTempRoot.js", async () => {
    const actual = await vi.importActual<typeof PrivateTempRootModule>(
      "../../src/privateTempRoot.js",
    );
    mocks.removeProfile.mockImplementation((authority) =>
      actual.removeTemporaryProfileAuthority(authority),
    );
    return {
      ...actual,
      establishPrivateRuntimeAuthority: () =>
        actual.establishPrivateRuntimeAuthority({ tempDirectory: temporaryBase }),
      createTemporaryProfileChildAuthority: async (
        parent: PrivateTempRootModule.PrivateDirectoryAuthority,
        prefix: string,
        options?: PrivateTempRootModule.PrivateTempRootOptions,
      ) => {
        const authority = await actual.createTemporaryProfileChildAuthority(
          parent,
          prefix,
          options,
        );
        await mocks.afterPrivateGeneration(authority.generation);
        return authority;
      },
      removeTemporaryProfileAuthority: mocks.removeProfile,
    };
  });
  vi.doMock("../../src/browser/config.js", () => ({
    resolveBrowserConfig: mocks.resolveBrowserConfig,
  }));
  vi.doMock("../../src/browser/chromeLifecycle.js", async () => ({
    ...(await vi.importActual("../../src/browser/chromeLifecycle.js")),
    closeChromeTargetWithExactAuthority: mocks.closeTarget,
    connectWithNewTabWithExactAuthority: mocks.connectTarget,
    launchChrome: mocks.launchChrome,
    retainChromeEndpointAuthority: mocks.retainEndpoint,
    positionChromeWindowOffscreen: vi.fn(),
    registerTerminationHooks: vi.fn(() => () => undefined),
  }));
  vi.doMock("../../src/browser/reattach.js", () => ({
    retryBrowserRecoveryCleanup: mocks.retryCleanup,
  }));
  vi.doMock("../../src/browser/chromeTargetConnection.js", async () => ({
    ...(await vi.importActual("../../src/browser/chromeTargetConnection.js")),
    listChromeTargetsWithExactAuthority: mocks.listTargets,
  }));
  vi.doMock("../../src/browser/reattachLock.js", () => ({
    acquireReattachRecoveryLock: mocks.acquireLock,
  }));
  vi.doMock("../../src/browser/localExecutionContext.js", () => ({
    waitForLogin: vi.fn(async () => undefined),
  }));
  vi.doMock("../../src/browser/cookies.js", () => ({
    clearStaleChatGptConversationCookies: vi.fn(),
    syncCookies: vi.fn(async () => 0),
  }));
  vi.doMock("../../src/browser/pageActions.js", () => ({
    ensureLoggedIn: vi.fn(),
    installJavaScriptDialogAutoDismissal: vi.fn(() => () => undefined),
    navigateToChatGPT: vi.fn(),
  }));
  vi.doMock("../../src/browser/actions/projectSources.js", () => ({
    openProjectSourcesTab: vi.fn(),
    uploadProjectSources: vi.fn(),
    waitForProjectSourcesReady: vi.fn(),
    waitForProjectSourcesListSettled: vi.fn(async () => []),
  }));
  vi.doMock("../../src/browser/profileState.js", async () => {
    const actual = await vi.importActual<typeof import("../../src/browser/profileState.js")>(
      "../../src/browser/profileState.js",
    );
    return {
      ...actual,
      captureProfileDirectoryIdentity: actual.captureProfileDirectoryIdentity,
      isSafeChromeTerminationOutcome: vi.fn(() => true),
      removeProfileDirectoryIfIdentityMatches: actual.removeProfileDirectoryIfIdentityMatches,
    };
  });

  const { runBrowserProjectSources } = await import("../../src/browser/projectSourcesRunner.js");
  const projectSourcesRecovery = await import("../../src/browser/projectSourcesRecovery.js");
  const { __test__: targetCloseAuthority } =
    await import("../../src/browser/targetCloseAuthority.js");
  try {
    const profileState = await import("../../src/browser/profileState.js");
    const cleanupStorage = await projectSourcesRecovery.establishProjectSourcesCleanupStorage();
    const temporaryParent = await profileState.captureProfileDirectoryIdentity(
      cleanupStorage.runtimeRoot.path,
    );
    const profileCreateIntent = projectSourcesRecovery.createProjectSourcesProfileCreateIntent(
      cleanupStorage,
      temporaryParent,
      randomUUID(),
    );

    // Crash before mkdir: the exact absent path clears without blocking the next run.
    await projectSourcesRecovery.persistProjectSourcesCleanupRuntime({}, cleanupStorage, {
      profileCreate: profileCreateIntent,
    });
    await expect(
      readFile(projectSourcesRecovery.projectSourcesCleanupJournalPath(), "utf8"),
    ).resolves.toContain('"profileCreate"');
    await projectSourcesRecovery.retryPendingProjectSourcesCleanup(
      vi.fn<(message: string) => void>(),
      cleanupStorage,
    );
    expect(mocks.removeProfile).not.toHaveBeenCalled();
    await expect(
      readFile(projectSourcesRecovery.projectSourcesCleanupJournalPath(), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // Crash after mkdir but before marker creation: leave the unproven occupant in place.
    await mkdir(profileCreateIntent.userDataDir);
    const unknownOwner = path.join(profileCreateIntent.userDataDir, "unknown-owner.txt");
    await writeFile(unknownOwner, "preserve me");
    await projectSourcesRecovery.persistProjectSourcesCleanupRuntime({}, cleanupStorage, {
      profileCreate: profileCreateIntent,
    });
    await expect(
      projectSourcesRecovery.retryPendingProjectSourcesCleanup(
        vi.fn<(message: string) => void>(),
        cleanupStorage,
      ),
    ).rejects.toThrow(/preserved an unproven temporary-profile occupant/i);
    await expect(readFile(unknownOwner, "utf8")).resolves.toBe("preserve me");
    await rm(profileCreateIntent.userDataDir, { recursive: true, force: true });
    await projectSourcesRecovery.persistProjectSourcesCleanupRuntime({}, cleanupStorage);
    mocks.resolveBrowserConfig.mockReturnValue({
      remoteChrome: null,
      manualLogin: false,
      keepBrowser: false,
      headless: false,
      hideWindow: false,
      timeoutMs: 1_000,
      inputTimeoutMs: 1_000,
      cookieSync: false,
    });
    mocks.closeTarget.mockResolvedValue({ status: "completed" });
    mocks.acquireLock.mockResolvedValue({ release: vi.fn(async () => undefined) });
    mocks.connectTarget.mockImplementation(async () => ({
      client: {
        close: vi.fn(async () => undefined),
        on: vi.fn(),
        Network: { enable: vi.fn(), clearBrowserCookies: vi.fn() },
        Page: { enable: vi.fn() },
        Runtime: { enable: vi.fn(), evaluate: vi.fn() },
        Input: {},
        DOM: undefined,
      },
      browserClient: {
        Browser: {
          getWindowForTarget: vi.fn(),
          setWindowBounds: vi.fn(),
        },
        Target: {
          getTargets: vi.fn(async () => ({ targetInfos: [] })),
          getTargetInfo: vi.fn(async () => ({
            targetInfo: { targetId: "project-sources-target", url: "about:blank" },
          })),
        },
      },
      targetId: "project-sources-target",
    }));
    const killChrome = vi.fn(async (_profileDir: string) => ({
      status: "completed" as const,
      pid: 1,
    }));
    const releaseEndpoint = vi.fn(async () => undefined);
    mocks.launchChrome.mockImplementation(async (_config, profileDir, _logger, options) => ({
      host: "127.0.0.1",
      port: 9222,
      pid: 1,
      processIdentity: {
        profileDirectory: await captureProfileDirectoryIdentity(profileDir),
        launchClaim: options?.launchClaim,
      },
      endpointAuthority: {
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/project",
        release: releaseEndpoint,
      },
      kill: () => killChrome(profileDir),
    }));
    const request = {
      operation: "list" as const,
      chatgptUrl: "https://chatgpt.com/g/g-project/project",
    };
    const iterations = 1;
    for (let index = 0; index < iterations; index += 1) {
      await expect(runBrowserProjectSources(request)).resolves.toMatchObject({ status: "ok" });
    }
    expect(targetCloseAuthority.retainedTargetCloseAuthorityCount()).toBe(1);
    expect(targetCloseAuthority.retainedAcknowledgedTerminalTargetCloseAuthorityCount()).toBe(1);

    targetCloseAuthority.clearRetainedTargetCloseAuthorities();
    killChrome.mockClear();
    mocks.closeTarget.mockResolvedValueOnce({ status: "unsafe", reason: "target close deferred" });
    await expect(runBrowserProjectSources(request)).rejects.toThrow(/cleanup remains retryable/i);
    expect(killChrome).not.toHaveBeenCalled();
    const pendingJournal = JSON.parse(
      await readFile(projectSourcesRecovery.projectSourcesCleanupJournalPath(), "utf8"),
    );
    expect(pendingJournal.runtime.recoveryCleanupResources[0]).toMatchObject({
      chromeTargetId: "project-sources-target",
      targetCloseCapability: { generationId: expect.any(String), capabilityId: expect.any(String) },
      acquisition: {
        generationId: expect.any(String),
        processOwnerProvenance: "temporary-launch",
        targetMarkerUrl: expect.stringMatching(/^about:blank#oracle-project-sources=/u),
      },
      recoveryCleanup: { ownsTarget: true, closeOwnedTargetOnComplete: true },
    });
    mocks.listTargets.mockClear();
    mocks.retainEndpoint.mockClear();
    mocks.closeTarget.mockClear();
    expect(targetCloseAuthority.retainedTargetCloseAuthorityCount()).toBe(1);
    targetCloseAuthority.clearRetainedTargetCloseAuthorities();
    mocks.retryCleanup.mockImplementationOnce(async (runtime, logger, deps) => {
      const resource = runtime.recoveryCleanupResources[0];
      expect(resource.recoveryCleanup).toMatchObject({
        ownsTarget: true,
        profileKind: "temporary",
        keepBrowser: false,
      });
      await expect(
        deps.recoveryCleanup.closeChromeTargetWithRetainedCapability({
          ownerId: deps.ownerId,
          capability: resource.targetCloseCapability,
          targetId: resource.chromeTargetId,
          logger,
        }),
      ).resolves.toMatchObject({
        status: "unavailable",
        reason: expect.stringMatching(/read-only liveness proof.*target was preserved/iu),
      });
      expect(mocks.retainEndpoint).not.toHaveBeenCalled();
      expect(mocks.listTargets).not.toHaveBeenCalled();
      expect(mocks.closeTarget).not.toHaveBeenCalled();

      // The local finalizer may converge this exact temporary owner by tearing down its process.
      const completedRuntime = { ...runtime };
      delete completedRuntime.recoveryCleanupResources;
      delete completedRuntime.recoveryCleanupResult;
      await deps.persistFinalizationResult({ status: "completed", runtime: completedRuntime });
      return { status: "completed", runtime: completedRuntime };
    });
    mocks.closeTarget.mockResolvedValue({ status: "completed" });
    await expect(runBrowserProjectSources(request)).resolves.toMatchObject({ status: "ok" });
    expect(mocks.retryCleanup).toHaveBeenCalledOnce();
    expect(mocks.retainEndpoint).not.toHaveBeenCalled();
    expect(mocks.listTargets).not.toHaveBeenCalled();
    await expect(
      readFile(projectSourcesRecovery.projectSourcesCleanupJournalPath(), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(targetCloseAuthority.retainedAcknowledgedTerminalTargetCloseAuthorityCount()).toBe(1);

    const pendingTargetAcquisition = JSON.parse(JSON.stringify(pendingJournal.runtime));
    const pendingTargetResource = pendingTargetAcquisition.recoveryCleanupResources[0];
    pendingTargetResource.acquisition.pendingResource = "chrome-target";
    pendingTargetResource.recoveryCleanup.ownsTarget = true;
    pendingTargetResource.recoveryCleanup.closeOwnedTargetOnComplete = true;
    mocks.closeTarget.mockClear();
    mocks.listTargets.mockClear();
    mocks.retainEndpoint.mockClear();
    const reconciledTargetAcquisition =
      await projectSourcesRecovery.reconcilePendingProjectSourcesTarget(
        pendingTargetAcquisition,
        pendingJournal.proof,
        cleanupStorage,
        vi.fn<(message: string) => void>(),
      );
    expect(reconciledTargetAcquisition).toBe(pendingTargetAcquisition);
    expect(reconciledTargetAcquisition.recoveryCleanupResources?.[0]).toMatchObject({
      chromeTargetId: "project-sources-target",
      targetCloseCapability: {
        generationId: expect.any(String),
        capabilityId: expect.any(String),
      },
      acquisition: { pendingResource: "chrome-target" },
      recoveryCleanup: { ownsTarget: true, closeOwnedTargetOnComplete: true },
    });
    expect(mocks.retainEndpoint).not.toHaveBeenCalled();
    expect(mocks.listTargets).not.toHaveBeenCalled();
    expect(mocks.closeTarget).not.toHaveBeenCalled();

    await expect(
      projectSourcesRecovery.closeProjectSourcesTargetFromJournal({
        ownerId: pendingJournal.proof.storageOwnerId,
        runtime: pendingJournal.runtime,
        proof: pendingJournal.proof,
        storage: cleanupStorage,
        capability: pendingJournal.runtime.recoveryCleanupResources[0].targetCloseCapability,
        targetId: "project-sources-target",
        logger: vi.fn<(message: string) => void>(),
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: expect.stringMatching(/read-only liveness proof.*target was preserved/iu),
    });
    expect(mocks.retainEndpoint).not.toHaveBeenCalled();
    expect(mocks.listTargets).not.toHaveBeenCalled();
    expect(mocks.closeTarget).not.toHaveBeenCalled();

    targetCloseAuthority.clearRetainedTargetCloseAuthorities();
    mocks.removeProfile.mockResolvedValueOnce(false);
    await expect(runBrowserProjectSources(request)).rejects.toThrow(/cleanup remains retryable/i);
    const profilePendingJournal = JSON.parse(
      await readFile(projectSourcesRecovery.projectSourcesCleanupJournalPath(), "utf8"),
    );
    expect(profilePendingJournal.runtime.recoveryCleanupResources[0]).toMatchObject({
      recoveryCleanup: { ownsTarget: false, profileKind: "temporary" },
    });
    mocks.retryCleanup.mockImplementationOnce(async (runtime, _logger, deps) => {
      const completedRuntime = { ...runtime };
      delete completedRuntime.recoveryCleanupResources;
      delete completedRuntime.recoveryCleanupResult;
      await deps.persistFinalizationResult({ status: "completed", runtime: completedRuntime });
      return { status: "completed", runtime: completedRuntime };
    });
    await expect(runBrowserProjectSources(request)).resolves.toMatchObject({ status: "ok" });

    targetCloseAuthority.clearRetainedTargetCloseAuthorities();
    mocks.closeTarget.mockClear();
    killChrome.mockClear();
    releaseEndpoint.mockClear();
    mocks.resolveBrowserConfig.mockReturnValue({
      remoteChrome: null,
      manualLogin: false,
      keepBrowser: true,
      headless: false,
      hideWindow: false,
      timeoutMs: 1_000,
      inputTimeoutMs: 1_000,
      cookieSync: false,
    });
    for (let index = 0; index < iterations; index += 1) {
      await expect(runBrowserProjectSources(request)).resolves.toMatchObject({ status: "ok" });
    }
    expect(mocks.closeTarget).not.toHaveBeenCalled();
    expect(killChrome).not.toHaveBeenCalled();
    expect(targetCloseAuthority.retainedTargetCloseAuthorityCount()).toBe(0);
    expect(releaseEndpoint).toHaveBeenCalledTimes(iterations);

    targetCloseAuthority.clearRetainedTargetCloseAuthorities();
    mocks.resolveBrowserConfig.mockReturnValue({
      remoteChrome: null,
      manualLogin: false,
      keepBrowser: false,
      headless: false,
      hideWindow: false,
      timeoutMs: 1_000,
      inputTimeoutMs: 1_000,
      cookieSync: false,
    });
    mocks.removeProfile.mockClear();
    let removalSubstitution: { profileDir: string; moved: string } | undefined;
    killChrome.mockImplementationOnce(async (profileDir) => {
      const moved = `${profileDir}-before-removal`;
      await rename(profileDir, moved);
      await mkdir(profileDir, { mode: 0o700 });
      removalSubstitution = { profileDir, moved };
      return { status: "completed" as const, pid: 1 };
    });
    await expect(runBrowserProjectSources(request)).rejects.toThrow(/cleanup remains retryable/i);
    expect(mocks.removeProfile).not.toHaveBeenCalled();
    if (!removalSubstitution) throw new Error("expected a pre-removal profile substitution");
    await rm(removalSubstitution.profileDir, { recursive: true, force: true });
    await rm(removalSubstitution.moved, { recursive: true, force: true });
    await rm(projectSourcesRecovery.projectSourcesCleanupJournalPath(), { force: true });
    targetCloseAuthority.clearRetainedTargetCloseAuthorities();

    mocks.launchChrome.mockClear();
    mocks.afterPrivateGeneration.mockImplementationOnce(async (generation) => {
      await rename(generation.path, `${generation.path}-substituted`);
      await mkdir(generation.path, { mode: 0o700 });
    });
    await expect(runBrowserProjectSources(request)).rejects.toThrow(/authority changed/i);
    expect(mocks.launchChrome).not.toHaveBeenCalled();
  } finally {
    targetCloseAuthority.clearRetainedTargetCloseAuthorities();
    await rm(projectSourcesRecovery.projectSourcesCleanupJournalPath(), { force: true });
    await rm(temporaryBase, { recursive: true, force: true });
    vi.doUnmock("../../src/browser/config.js");
    vi.doUnmock("../../src/browser/chromeLifecycle.js");
    vi.doUnmock("../../src/browser/reattach.js");
    vi.doUnmock("../../src/browser/reattachLock.js");
    vi.doUnmock("../../src/browser/cookies.js");
    vi.doUnmock("../../src/browser/pageActions.js");
    vi.doUnmock("../../src/browser/localExecutionContext.js");
    vi.doUnmock("../../src/browser/actions/projectSources.js");
    vi.doUnmock("../../src/browser/chromeTargetConnection.js");
    vi.doUnmock("../../src/browser/profileState.js");
    vi.doUnmock("../../src/privateTempRoot.js");
    vi.doUnmock("../../src/oracleHome.js");
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  }
}, 60_000);
