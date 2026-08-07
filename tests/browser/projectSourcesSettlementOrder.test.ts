import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { BrowserRuntimeMetadata } from "../../src/sessionManager.js";
import { createChromeProcessLaunchClaim } from "../../src/browser/chromeProcessLaunchClaim.js";
import {
  captureProfileDirectoryIdentity,
  writeOracleChromeOwner,
} from "../../src/browser/profileState.js";
import type { OracleChromeOwnerRecord } from "../../src/browser/profileState.js";
import type * as ProjectSourcesRecovery from "../../src/browser/projectSourcesRecovery.js";
import { __test__ as targetCloseAuthority } from "../../src/browser/targetCloseAuthority.js";
import type { BrowserTabLease } from "../../src/browser/tabLeaseRegistry.js";
import { testWindowsPrivateDirectoryAuthority } from "../privateAuthorityTestHelpers.js";

type Recovery = typeof ProjectSourcesRecovery;
type ManualProof = ProjectSourcesRecovery.ProjectSourcesManualCleanupProof;

function cleanupRuntime(
  proof: ManualProof,
  owner: OracleChromeOwnerRecord,
): BrowserRuntimeMetadata {
  const launchClaim = createChromeProcessLaunchClaim(proof.generationId);
  return {
    userDataDir: proof.userDataDir,
    chromeProfileRoot: proof.userDataDir,
    chromeProcessIdentity: owner.processIdentity,
    chromeHost: "127.0.0.1",
    chromePort: owner.port,
    recoveryCleanupResult: { status: "failed", error: "interrupted" },
    recoveryCleanupResources: [
      {
        userDataDir: proof.userDataDir,
        chromeProfileRoot: proof.userDataDir,
        chromeProcessIdentity: owner.processIdentity,
        chromeHost: "127.0.0.1",
        chromePort: owner.port,
        profileDirectoryIdentity: proof.profileDirectory,
        tabLease: {
          id: proof.lease.id,
          generationId: proof.generationId,
          profileDirectory: proof.profileDirectory,
        },
        acquisition: {
          generationId: proof.generationId,
          processLaunchClaim: launchClaim,
          processOwnerProvenance: "manual-canonical-owner",
          processOwnerDisposition: owner.disposition,
          targetMarkerUrl: `about:blank#oracle-project-sources=${proof.generationId}`,
        },
        recoveryCleanup: {
          ownsTarget: false,
          profileKind: "manual-login",
          keepBrowser: false,
        },
      },
    ],
  };
}

async function createManualAuthority(recovery: Recovery) {
  const oracleHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-project-sources-settlement-"));
  const profileDir = path.join(oracleHome, "manual-profile");
  await fs.mkdir(profileDir);
  const storage = await recovery.establishProjectSourcesCleanupStorage(oracleHome, {
    windowsPrivateDirectoryAuthority: testWindowsPrivateDirectoryAuthority,
  });
  const profileDirectory = await captureProfileDirectoryIdentity(profileDir);
  const generationId = randomUUID();
  const leaseId = randomUUID();
  const launchClaim = createChromeProcessLaunchClaim(generationId);
  const owner: OracleChromeOwnerRecord = {
    port: 9222,
    disposition: "close-on-last-lease",
    processIdentity: {
      pid: process.pid,
      executablePath:
        process.platform === "win32"
          ? String.raw`c:\program files\google\chrome\application\chrome.exe`
          : process.platform === "darwin"
            ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            : "/usr/bin/google-chrome",
      processStartTime: "1",
      launchNonce: launchClaim.nonce,
      normalizedUserDataDir:
        process.platform === "win32"
          ? profileDirectory.canonicalPath.toLowerCase()
          : profileDirectory.canonicalPath,
      launchClaim,
      profileDirectory,
    },
  };
  const initial = {
    ...recovery.createProjectSourcesManualCleanupProof(
      storage,
      generationId,
      profileDirectory.canonicalPath,
      profileDirectory,
      leaseId,
    ),
    lease: { id: leaseId, generationId, state: "active" as const },
  };
  const runtime = cleanupRuntime(initial, owner);
  const proof = await recovery.transitionProjectSourcesCleanupProof(
    initial,
    storage,
    { type: "persist", runtime },
    {
      hasExactBrowserTabLease: vi.fn(async () => true),
      readOracleChromeOwner: vi.fn(async () => owner),
    },
  );
  if (proof.kind !== "manual-login") throw new Error("expected a manual cleanup proof");
  await recovery.persistProjectSourcesCleanupRuntime(runtime, storage, { proof });
  return { oracleHome, storage, runtime, proof, owner };
}

async function loadRecoveryWithOneJournalRemovalFailure() {
  let journalPath = "";
  let failed = false;
  vi.resetModules();
  vi.doMock("node:fs/promises", async () => {
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    return {
      ...actual,
      rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
        if (!failed && String(args[0]) === journalPath) {
          failed = true;
          await actual.rm(...args);
          throw new Error("injected journal retirement failure");
        }
        return await actual.rm(...args);
      }),
    };
  });
  // Module isolation intentionally loads the subject after the filesystem failure mock.
  const recovery = await import("../../src/browser/projectSourcesRecovery.js");
  return {
    recovery,
    failJournalRetirementAt(pathname: string) {
      journalPath = pathname;
    },
  };
}

async function removeAuthority(oracleHome: string): Promise<void> {
  await fs.rm(oracleHome, { recursive: true, force: true });
}

test("normal runner settlement retains its authenticated admission receipt when journal retirement fails", async () => {
  const { recovery, failJournalRetirementAt } = await loadRecoveryWithOneJournalRemovalFailure();
  const authority = await createManualAuthority(recovery);
  try {
    failJournalRetirementAt(authority.storage.journalPath);
    await expect(
      recovery.retireProjectSourcesCleanupJournal(
        authority.runtime,
        authority.proof,
        authority.storage,
        vi.fn<(message: string) => void>(),
      ),
    ).rejects.toThrow("injected journal retirement failure");

    const retained = JSON.parse(await fs.readFile(authority.storage.journalPath, "utf8"));
    expect(retained.proof).toEqual(authority.proof);
    await expect(fs.readFile(authority.proof.admission.path, "utf8")).resolves.toContain(
      "project-sources-manual-cleanup-admission",
    );

    await recovery.retireProjectSourcesCleanupJournal(
      authority.runtime,
      authority.proof,
      authority.storage,
      vi.fn<(message: string) => void>(),
    );
    await expect(fs.readFile(authority.storage.journalPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(authority.proof.admission.path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await removeAuthority(authority.oracleHome);
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  }
});

test("recovery retries a cleanup whose journal retirement failed without losing its admission receipt", async () => {
  const { recovery, failJournalRetirementAt } = await loadRecoveryWithOneJournalRemovalFailure();
  const authority = await createManualAuthority(recovery);
  const retryCleanup = vi.fn(async (runtime, _logger, deps) => {
    const completed = { ...runtime };
    delete completed.recoveryCleanupResources;
    delete completed.recoveryCleanupResult;
    const result = { status: "completed" as const, runtime: completed };
    await deps.persistFinalizationResult(result);
    return result;
  });
  try {
    failJournalRetirementAt(authority.storage.journalPath);
    await expect(
      recovery.retryPendingProjectSourcesCleanup(() => undefined, authority.storage, {
        hasExactBrowserTabLease: vi.fn(async () => true),
        readOracleChromeOwner: vi.fn(async () => authority.owner),
        retryCleanup,
      }),
    ).rejects.toThrow("injected journal retirement failure");
    expect(retryCleanup).toHaveBeenCalledOnce();

    const retained = JSON.parse(await fs.readFile(authority.storage.journalPath, "utf8"));
    expect(retained.proof).toEqual(authority.proof);
    await expect(fs.readFile(authority.proof.admission.path, "utf8")).resolves.toContain(
      "project-sources-manual-cleanup-admission",
    );

    await expect(
      recovery.retryPendingProjectSourcesCleanup(() => undefined, authority.storage, {
        hasExactBrowserTabLease: vi.fn(async () => true),
        readOracleChromeOwner: vi.fn(async () => authority.owner),
        retryCleanup,
      }),
    ).resolves.toBeUndefined();
    expect(retryCleanup).toHaveBeenCalledTimes(2);
    await expect(fs.readFile(authority.storage.journalPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(authority.proof.admission.path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await removeAuthority(authority.oracleHome);
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  }
});

test("runner completion preserves a manual receipt until failed journal retirement is restored", async () => {
  let journalPath = "";
  let manualProfileDir = "";
  let failJournalRetirement = true;
  vi.resetModules();
  vi.doMock("node:fs/promises", async () => {
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    return {
      ...actual,
      rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
        if (failJournalRetirement && String(args[0]) === journalPath) {
          failJournalRetirement = false;
          await actual.rm(...args);
          throw new Error("injected runner journal retirement failure");
        }
        return await actual.rm(...args);
      }),
    };
  });
  const retryCleanup = vi.fn(async (runtime, _logger, deps) => {
    const completed = { ...runtime };
    delete completed.recoveryCleanupResources;
    delete completed.recoveryCleanupResult;
    const result = { status: "completed" as const, runtime: completed };
    await deps.persistFinalizationResult(result);
    return result;
  });
  vi.doMock("../../src/browser/config.js", () => ({
    resolveBrowserConfig: vi.fn(() => ({
      remoteChrome: null,
      manualLogin: true,
      manualLoginProfileDir: manualProfileDir,
      keepBrowser: false,
      headless: false,
      hideWindow: false,
      timeoutMs: 1_000,
      inputTimeoutMs: 1_000,
      cookieSync: false,
      maxConcurrentTabs: 1,
    })),
  }));
  vi.doMock("../../src/browser/reattachLock.js", () => ({
    acquireReattachRecoveryLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
  }));
  vi.doMock("../../src/browser/reattach.js", () => ({ retryBrowserRecoveryCleanup: retryCleanup }));
  vi.doMock("../../src/browser/manualLoginProfile.js", () => ({
    assertManualLoginProfileReadyForRun: vi.fn(async () => undefined),
    defaultManualLoginProfileDir: vi.fn(),
  }));
  vi.doMock("../../src/browser/tabLeaseRegistry.js", () => ({
    acquireBrowserTabLease: vi.fn(async (profileDir, options) => ({
      id: options.leaseId,
      sessionId: options.sessionId,
      generationId: options.generationId,
      profileDirectory: await captureProfileDirectoryIdentity(profileDir),
      update: vi.fn(async () => undefined),
      release: vi.fn(async ({ onRelease } = {}) => await onRelease?.({ isLastLease: true })),
    })),
    retainBrowserTabLeaseTeardownAuthority: vi.fn((_profileDir: string, lease: BrowserTabLease) => {
      let leaseReleased = false;
      let lastLease = false;
      let completed = false;
      return {
        get leaseReleased() {
          return leaseReleased;
        },
        settle: vi.fn(async (teardown) => {
          if (completed) {
            return { status: "completed", disposition: "teardown-completed" };
          }
          if (!leaseReleased) {
            await lease.release({
              onRelease: async ({ isLastLease }) => {
                leaseReleased = true;
                lastLease = isLastLease;
              },
            });
          }
          if (!lastLease) {
            completed = true;
            return { status: "completed", disposition: "active-lease-handoff" };
          }
          if (!(await teardown())) {
            return { status: "preserved", reason: "teardown-unsafe" };
          }
          completed = true;
          return { status: "completed", disposition: "teardown-completed" };
        }),
      };
    }),
    hasExactBrowserTabLease: vi.fn(async () => true),
  }));
  vi.doMock("../../src/browser/manualChromeOwner.js", () => ({
    acquireManualChromeOwner: vi.fn(async (profileDir, _config, _logger, _sessionId, options) => {
      const profileDirectory = await captureProfileDirectoryIdentity(profileDir);
      const owner: OracleChromeOwnerRecord = {
        port: 9222,
        disposition: "close-on-last-lease",
        processIdentity: {
          pid: process.pid,
          executablePath:
            process.platform === "win32"
              ? String.raw`c:\program files\google\chrome\application\chrome.exe`
              : process.platform === "darwin"
                ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                : "/usr/bin/google-chrome",
          processStartTime: "1",
          launchNonce: options.launchClaim.nonce,
          normalizedUserDataDir:
            process.platform === "win32"
              ? profileDirectory.canonicalPath.toLowerCase()
              : profileDirectory.canonicalPath,
          launchClaim: options.launchClaim,
          profileDirectory,
        },
      };
      await writeOracleChromeOwner(profileDir, owner);
      const endpointAuthority = {
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/project-sources",
        release: vi.fn(async () => undefined),
      };
      return {
        chrome: {
          host: "127.0.0.1",
          port: owner.port,
          pid: process.pid,
          processIdentity: owner.processIdentity,
          endpointAuthority,
        },
        processIdentity: owner.processIdentity,
        source: "launched",
        disposition: owner.disposition,
        endpointAuthority,
      };
    }),
    settleManualChromeOwner: vi.fn(async () => ({ status: "terminated" })),
    releaseManualChromeOwnerEndpointAuthority: vi.fn(async () => undefined),
  }));
  vi.doMock("../../src/browser/chromeLifecycle.js", () => ({
    closeChromeTargetWithExactAuthority: vi.fn(async () => ({ status: "completed" })),
    connectWithNewTabWithExactAuthority: vi.fn(async () => ({
      client: {
        close: vi.fn(async () => undefined),
        on: vi.fn(),
        Network: { enable: vi.fn(), clearBrowserCookies: vi.fn() },
        Page: { enable: vi.fn() },
        Runtime: { enable: vi.fn(), evaluate: vi.fn() },
        Input: {},
        Target: {},
      },
      targetId: "project-sources-target",
      browserClient: { Target: {} },
    })),
    launchChrome: vi.fn(),
    positionChromeWindowOffscreen: vi.fn(),
    registerTerminationHooks: vi.fn(() => () => undefined),
  }));
  vi.doMock("../../src/browser/cookies.js", () => ({
    clearStaleChatGptConversationCookies: vi.fn(),
    syncCookies: vi.fn(async () => 0),
  }));
  vi.doMock("../../src/browser/pageActions.js", () => ({
    installJavaScriptDialogAutoDismissal: vi.fn(() => () => undefined),
    navigateToChatGPT: vi.fn(async () => undefined),
  }));
  vi.doMock("../../src/browser/localExecutionContext.js", () => ({
    waitForLogin: vi.fn(async () => undefined),
  }));
  vi.doMock("../../src/browser/actions/projectSources.js", () => ({
    openProjectSourcesTab: vi.fn(async () => undefined),
    uploadProjectSources: vi.fn(),
    waitForProjectSourcesReady: vi.fn(async () => undefined),
    waitForProjectSourcesListSettled: vi.fn(async () => []),
  }));
  // Module isolation intentionally loads the runner after its process and filesystem mocks.
  const { runBrowserProjectSources } = await import("../../src/browser/projectSourcesRunner.js");
  const { setOracleHomeDirOverrideForTest: setRunnerOracleHome } =
    await import("../../src/oracleHome.js");
  const oracleHome = await fs.mkdtemp(
    path.join(os.tmpdir(), "oracle-project-sources-runner-order-"),
  );
  const profileDir = path.join(oracleHome, "manual-profile");
  await fs.mkdir(profileDir);
  manualProfileDir = profileDir;
  journalPath = path.join(await fs.realpath(oracleHome), "project-sources-cleanup.json");
  setRunnerOracleHome(oracleHome);
  try {
    const request = {
      operation: "list" as const,
      chatgptUrl: "https://chatgpt.com/g/g-project/project",
      config: { manualLoginProfileDir: profileDir },
    };
    await expect(runBrowserProjectSources(request)).rejects.toThrow(/cleanup remains retryable/i);
    const pending = JSON.parse(await fs.readFile(journalPath, "utf8"));
    await expect(fs.readFile(pending.proof.admission.path, "utf8")).resolves.toContain(
      "project-sources-manual-cleanup-admission",
    );

    await expect(runBrowserProjectSources(request)).resolves.toMatchObject({ status: "ok" });
    expect(retryCleanup).toHaveBeenCalledOnce();
    await expect(fs.readFile(journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(pending.proof.admission.path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await fs.rm(oracleHome, { recursive: true, force: true });
    targetCloseAuthority.clearRetainedTargetCloseAuthorities();
    setRunnerOracleHome(null);
    vi.doUnmock("../../src/browser/config.js");
    vi.doUnmock("../../src/browser/reattachLock.js");
    vi.doUnmock("../../src/browser/reattach.js");
    vi.doUnmock("../../src/browser/manualLoginProfile.js");
    vi.doUnmock("../../src/browser/tabLeaseRegistry.js");
    vi.doUnmock("../../src/browser/manualChromeOwner.js");
    vi.doUnmock("../../src/browser/chromeLifecycle.js");
    vi.doUnmock("../../src/browser/cookies.js");
    vi.doUnmock("../../src/browser/pageActions.js");
    vi.doUnmock("../../src/browser/localExecutionContext.js");
    vi.doUnmock("../../src/browser/actions/projectSources.js");
    vi.resetModules();
  }
});
