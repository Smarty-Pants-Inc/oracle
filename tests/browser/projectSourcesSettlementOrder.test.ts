import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionManager.js";
import { createChromeProcessLaunchClaim } from "../../src/browser/chromeProcessLaunchClaim.js";
import { captureProfileDirectoryIdentity } from "../../src/browser/profileState.js";
import type { OracleChromeOwnerRecord } from "../../src/browser/profileState.js";
import type * as ProjectSourcesRecovery from "../../src/browser/projectSourcesRecovery.js";

type Recovery = typeof ProjectSourcesRecovery;
type ManualProof = ProjectSourcesRecovery.ProjectSourcesManualCleanupProof;

function cleanupRuntime(
  proof: ManualProof,
  owner: OracleChromeOwnerRecord,
): BrowserRuntimeMetadata {
  const launchClaim = createChromeProcessLaunchClaim(
    proof.generationId as ReturnType<typeof randomUUID>,
  );
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
  setOracleHomeDirOverrideForTest(oracleHome);
  const storage = await recovery.establishProjectSourcesCleanupStorage();
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
  const proof = await recovery.updateProjectSourcesCleanupProofForPersistence(
    runtime,
    initial,
    storage,
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
  setOracleHomeDirOverrideForTest(null);
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
