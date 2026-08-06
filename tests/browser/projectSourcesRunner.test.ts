import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { expect, test, vi } from "vitest";

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
  const mocks = {
    acquireLock: vi.fn(),
    closeTarget: vi.fn(),
    connectTarget: vi.fn(),
    launchChrome: vi.fn(),
    listTargets: vi.fn(),
    profileExists: true,
    removeProfile: vi.fn(),
    resolveBrowserConfig: vi.fn(),
    retainEndpoint: vi.fn(),
    retryCleanup: vi.fn(),
  };
  // Module isolation is required so this focused runner test can replace browser process effects.
  vi.resetModules();
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
    resolveUserDataBaseDir: vi.fn(async () => "/tmp"),
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
      captureProfileDirectoryIdentity: vi.fn(
        async (directory: string, options?: { create?: boolean }) =>
          path.basename(directory).startsWith("oracle-browser-")
            ? (() => {
                if (!mocks.profileExists) {
                  const error = new Error("profile does not exist") as NodeJS.ErrnoException;
                  error.code = "ENOENT";
                  throw error;
                }
                return {
                  version: 1 as const,
                  platform: process.platform,
                  canonicalPath: path.resolve(directory),
                  device: "1",
                  inode: "1",
                };
              })()
            : actual.captureProfileDirectoryIdentity(directory, options),
      ),
      isSafeChromeTerminationOutcome: vi.fn(() => true),
      removeProfileDirectoryIfIdentityMatches: mocks.removeProfile,
    };
  });

  const { __test__: projectSourcesRunner, runBrowserProjectSources } =
    await import("../../src/browser/projectSourcesRunner.js");
  const { __test__: targetCloseAuthority } =
    await import("../../src/browser/targetCloseAuthority.js");
  try {
    const profileState = await import("../../src/browser/profileState.js");
    const temporaryParent = await profileState.captureProfileDirectoryIdentity("/tmp");
    const profileGeneration = "11111111-1111-4111-8111-111111111111";
    const interruptedProfile = path.join(
      temporaryParent.canonicalPath,
      `oracle-browser-${profileGeneration}`,
    );
    const profileCreateIntent = {
      generationId: profileGeneration,
      parent: temporaryParent,
      userDataDir: interruptedProfile,
    };

    // Crash before mkdir: the durable intent is enough to clear the absent exact generation.
    mocks.profileExists = false;
    await projectSourcesRunner.persistProjectSourcesCleanupRuntime(
      {},
      undefined,
      profileCreateIntent,
    );
    await expect(
      readFile(projectSourcesRunner.projectSourcesCleanupJournalPath(), "utf8"),
    ).resolves.toContain('"profileCreate"');
    await projectSourcesRunner.retryPendingProjectSourcesCleanup(
      vi.fn<(message: string) => void>(),
    );
    expect(mocks.removeProfile).not.toHaveBeenCalled();
    await expect(
      readFile(projectSourcesRunner.projectSourcesCleanupJournalPath(), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // Crash after mkdir before identity persistence: preserve the unknown occupant.
    mocks.profileExists = true;
    mocks.removeProfile.mockClear();
    await projectSourcesRunner.persistProjectSourcesCleanupRuntime(
      {},
      undefined,
      profileCreateIntent,
    );
    await expect(
      projectSourcesRunner.retryPendingProjectSourcesCleanup(vi.fn<(message: string) => void>()),
    ).rejects.toThrow(/without a durably recorded physical identity/i);
    expect(mocks.removeProfile).not.toHaveBeenCalled();

    // An attacker reusing the deterministic name is indistinguishable from the crash window and
    // is likewise preserved rather than freshly captured as deletion authority.
    await expect(
      projectSourcesRunner.retryPendingProjectSourcesCleanup(vi.fn<(message: string) => void>()),
    ).rejects.toThrow(/preserving it for manual recovery/i);
    expect(mocks.removeProfile).not.toHaveBeenCalled();

    // A changed physical parent fails closed before the child is inspected or removed.
    await projectSourcesRunner.persistProjectSourcesCleanupRuntime({}, undefined, {
      ...profileCreateIntent,
      parent: { ...temporaryParent, inode: "999999" },
    });
    await expect(
      projectSourcesRunner.retryPendingProjectSourcesCleanup(vi.fn<(message: string) => void>()),
    ).rejects.toThrow(/parent authority changed/i);
    expect(mocks.removeProfile).not.toHaveBeenCalled();
    await projectSourcesRunner.persistProjectSourcesCleanupRuntime({});
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
    mocks.removeProfile.mockResolvedValue(true);
    mocks.connectTarget.mockImplementation(async () => ({
      client: {
        close: vi.fn(async () => undefined),
        on: vi.fn(),
        Network: { enable: vi.fn(), clearBrowserCookies: vi.fn() },
        Page: { enable: vi.fn() },
        Runtime: { enable: vi.fn(), evaluate: vi.fn() },
        Input: {},
        DOM: undefined,
        Target: {},
      },
      targetId: "project-sources-target",
    }));
    const killChrome = vi.fn(async () => ({ status: "completed", pid: 1 }));
    const releaseEndpoint = vi.fn(async () => undefined);
    mocks.launchChrome.mockImplementation(async (_config, profileDir, _logger, options) => ({
      host: "127.0.0.1",
      port: 9222,
      pid: 1,
      processIdentity: {
        profileDirectory: {
          version: 1,
          platform: process.platform,
          canonicalPath: path.resolve(profileDir),
          device: "1",
          inode: "1",
        },
        launchClaim: options?.launchClaim,
      },
      endpointAuthority: {
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/project",
        release: releaseEndpoint,
      },
      kill: killChrome,
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
    mocks.closeTarget.mockResolvedValueOnce({ status: "unsafe", reason: "target close deferred" });
    await expect(runBrowserProjectSources(request)).rejects.toThrow(/cleanup remains retryable/i);
    const pendingJournal = JSON.parse(
      await readFile(projectSourcesRunner.projectSourcesCleanupJournalPath(), "utf8"),
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
    let observedTargetMarker =
      pendingJournal.runtime.recoveryCleanupResources[0].acquisition.targetMarkerUrl;
    mocks.listTargets.mockResolvedValue({
      status: "completed",
      value: [{ targetId: "project-sources-target" }],
    });
    expect(targetCloseAuthority.retainedTargetCloseAuthorityCount()).toBe(1);
    targetCloseAuthority.clearRetainedTargetCloseAuthorities();
    mocks.retainEndpoint.mockResolvedValue({
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/recovered-project",
      release: vi.fn(async () => undefined),
      runExactOperation: vi.fn(async (operation) => ({
        status: "completed",
        value: await operation({
          Target: {
            attachToTarget: vi.fn(async () => ({ sessionId: "project-sources-session" })),
            detachFromTarget: vi.fn(async () => undefined),
          },
          send: vi.fn(async () => ({ result: { value: observedTargetMarker } })),
        }),
      })),
    });
    mocks.retryCleanup.mockImplementationOnce(async (runtime, logger, deps) => {
      const resource = runtime.recoveryCleanupResources[0];
      await expect(
        deps.recoveryCleanup.closeChromeTargetWithRetainedCapability({
          capability: resource.targetCloseCapability,
          targetId: resource.chromeTargetId,
          logger,
        }),
      ).resolves.toMatchObject({ status: "completed" });
      const completedRuntime = { ...runtime };
      delete completedRuntime.recoveryCleanupResources;
      delete completedRuntime.recoveryCleanupResult;
      await deps.persistFinalizationResult({ status: "completed", runtime: completedRuntime });
      return { status: "completed", runtime: completedRuntime };
    });
    mocks.closeTarget.mockResolvedValue({ status: "completed" });
    await expect(runBrowserProjectSources(request)).resolves.toMatchObject({ status: "ok" });
    expect(mocks.retryCleanup).toHaveBeenCalledOnce();
    expect(mocks.retainEndpoint).toHaveBeenCalledOnce();
    await expect(
      readFile(projectSourcesRunner.projectSourcesCleanupJournalPath(), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(targetCloseAuthority.retainedAcknowledgedTerminalTargetCloseAuthorityCount()).toBe(1);
    const pendingTargetAcquisition = JSON.parse(JSON.stringify(pendingJournal.runtime));
    const pendingTargetResource = pendingTargetAcquisition.recoveryCleanupResources[0];
    delete pendingTargetResource.chromeTargetId;
    delete pendingTargetResource.targetCloseCapability;
    pendingTargetResource.acquisition.pendingResource = "chrome-target";
    pendingTargetResource.recoveryCleanup.ownsTarget = true;
    pendingTargetResource.recoveryCleanup.closeOwnedTargetOnComplete = true;
    mocks.closeTarget.mockClear();
    mocks.listTargets.mockResolvedValue({
      status: "completed",
      value: [
        { targetId: "interrupted-project-sources-target", type: "page", url: observedTargetMarker },
      ],
    });
    mocks.retainEndpoint.mockResolvedValue({
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/recovered-project",
      release: vi.fn(async () => undefined),
      runExactOperation: vi.fn(async () => ({ status: "completed", value: false })),
    });
    const reconciledTargetAcquisition =
      await projectSourcesRunner.reconcilePendingProjectSourcesTarget(
        pendingTargetAcquisition,
        vi.fn<(message: string) => void>(),
      );
    expect(reconciledTargetAcquisition).toMatchObject({
      chromeTargetId: undefined,
      recoveryCleanupResources: [
        {
          chromeTargetId: undefined,
          targetCloseCapability: undefined,
          recoveryCleanup: { ownsTarget: false, closeOwnedTargetOnComplete: undefined },
        },
      ],
    });
    expect(
      reconciledTargetAcquisition.recoveryCleanupResources?.[0]?.acquisition,
    ).not.toHaveProperty("pendingResource");
    expect(mocks.closeTarget).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "interrupted-project-sources-target" }),
    );

    // A marker collision in an intentionally preserved manual-browser target must converge the
    // journal without closing the live manual target or retaining a stale close closure.
    pendingTargetResource.recoveryCleanup.closeOwnedTargetOnComplete = false;
    mocks.closeTarget.mockClear();
    const reconciledPreservedTarget =
      await projectSourcesRunner.reconcilePendingProjectSourcesTarget(
        pendingTargetAcquisition,
        vi.fn<(message: string) => void>(),
      );
    expect(reconciledPreservedTarget).toMatchObject({
      chromeTargetId: undefined,
      recoveryCleanupResources: [
        {
          chromeTargetId: undefined,
          targetCloseCapability: undefined,
          recoveryCleanup: { ownsTarget: false, closeOwnedTargetOnComplete: undefined },
        },
      ],
    });
    expect(reconciledPreservedTarget.recoveryCleanupResources?.[0]?.acquisition).not.toHaveProperty(
      "pendingResource",
    );
    expect(mocks.closeTarget).not.toHaveBeenCalled();
    // A pre-existing manual target without this generation's URL or window marker is not an
    // acquired Project Sources target and must not be closed during recovery.
    pendingTargetResource.recoveryCleanup.closeOwnedTargetOnComplete = true;
    mocks.closeTarget.mockClear();
    mocks.listTargets.mockResolvedValue({
      status: "completed",
      value: [{ targetId: "pre-existing-manual-target", type: "page", url: "about:blank" }],
    });
    const reconciledAbsentTarget = await projectSourcesRunner.reconcilePendingProjectSourcesTarget(
      pendingTargetAcquisition,
      vi.fn<(message: string) => void>(),
    );
    expect(reconciledAbsentTarget.recoveryCleanupResources?.[0]?.acquisition).not.toHaveProperty(
      "pendingResource",
    );
    mocks.listTargets.mockResolvedValue({
      status: "completed",
      value: [
        { targetId: "ambiguous-project-sources-target-a", type: "page", url: observedTargetMarker },
        { targetId: "ambiguous-project-sources-target-b", type: "page", url: observedTargetMarker },
      ],
    });
    await expect(
      projectSourcesRunner.reconcilePendingProjectSourcesTarget(
        pendingTargetAcquisition,
        vi.fn<(message: string) => void>(),
      ),
    ).rejects.toThrow(/multiple generation markers/i);
    expect(mocks.closeTarget).not.toHaveBeenCalled();
    mocks.closeTarget.mockClear();
    observedTargetMarker = "about:blank#substituted-target";
    mocks.listTargets.mockResolvedValue({
      status: "completed",
      value: [{ targetId: "project-sources-target" }],
    });
    await expect(
      projectSourcesRunner.closeProjectSourcesTargetFromJournal({
        runtime: pendingJournal.runtime,
        capability: pendingJournal.runtime.recoveryCleanupResources[0].targetCloseCapability,
        targetId: "project-sources-target",
        logger: vi.fn<(message: string) => void>(),
      }),
    ).resolves.toMatchObject({ status: "unsafe", reason: expect.stringMatching(/marker/i) });
    expect(mocks.closeTarget).not.toHaveBeenCalled();

    targetCloseAuthority.clearRetainedTargetCloseAuthorities();
    mocks.removeProfile.mockResolvedValueOnce(false);
    await expect(runBrowserProjectSources(request)).rejects.toThrow(/cleanup remains retryable/i);
    const profilePendingJournal = JSON.parse(
      await readFile(projectSourcesRunner.projectSourcesCleanupJournalPath(), "utf8"),
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
  } finally {
    targetCloseAuthority.clearRetainedTargetCloseAuthorities();
    await rm(projectSourcesRunner.projectSourcesCleanupJournalPath(), { force: true });
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
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  }
}, 20_000);
