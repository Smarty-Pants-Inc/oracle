import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import type {
  BrowserRecoveryCleanupResourceMetadata,
  BrowserRuntimeMetadata,
} from "../../src/sessionManager.js";
import {
  captureProfileDirectoryIdentity,
  createChromeProcessLaunchClaim,
  type ChromeProcessIdentity,
  type ChromeProcessLaunchClaim,
  type OracleChromeOwnerRecord,
  type ProfileDirectoryIdentity,
} from "../../src/browser/profileState.js";
import {
  acquireBrowserTabLease,
  type BrowserTabLease,
} from "../../src/browser/tabLeaseRegistry.js";
import {
  retainChromeTargetCloseCapability,
  __test__ as targetCloseAuthority,
} from "../../src/browser/targetCloseAuthority.js";
import * as recovery from "../../src/browser/projectSourcesRecovery.js";

function processIdentity(
  profileDirectory: ProfileDirectoryIdentity,
  generationId: string,
  launchClaim: ChromeProcessLaunchClaim = createChromeProcessLaunchClaim(
    generationId as ReturnType<typeof randomUUID>,
  ),
): ChromeProcessIdentity {
  return {
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
  };
}

function cleanupRuntime(
  proof: recovery.ProjectSourcesCleanupProof,
  options: {
    owner?: OracleChromeOwnerRecord;
    targetId?: string;
    capabilityId?: string;
    pendingResource?: "tab-lease" | "chrome-process" | "chrome-target";
  } = {},
): BrowserRuntimeMetadata {
  const launchClaim = createChromeProcessLaunchClaim(
    proof.generationId as ReturnType<typeof randomUUID>,
  );
  const disposition = options.owner?.disposition ?? "close-on-last-lease";
  const identity =
    options.owner?.processIdentity ??
    processIdentity(proof.profileDirectory, proof.generationId, launchClaim);
  const ownsTarget = Boolean(options.targetId || options.pendingResource === "chrome-target");
  const resource: BrowserRecoveryCleanupResourceMetadata = {
    userDataDir: proof.userDataDir,
    chromeProfileRoot: proof.userDataDir,
    chromeHost: "127.0.0.1",
    chromePort: options.owner?.port ?? 9222,
    profileDirectoryIdentity: proof.profileDirectory,
    chromeProcessIdentity: options.pendingResource === "chrome-process" ? undefined : identity,
    chromeTargetId: options.targetId,
    targetCloseCapability:
      options.targetId && options.capabilityId
        ? {
            version: 1,
            generationId: proof.generationId,
            capabilityId: options.capabilityId,
            targetId: options.targetId,
          }
        : undefined,
    tabLease:
      proof.kind === "manual-login" && proof.lease.state !== "released"
        ? {
            id: proof.lease.id,
            generationId: proof.generationId,
            profileDirectory: proof.profileDirectory,
          }
        : undefined,
    acquisition: {
      generationId: proof.generationId,
      processLaunchClaim: launchClaim,
      processOwnerProvenance:
        proof.kind === "temporary" ? "temporary-launch" : "manual-canonical-owner",
      processOwnerDisposition: disposition,
      targetMarkerUrl: `about:blank#oracle-project-sources=${proof.generationId}`,
      ...(options.pendingResource ? { pendingResource: options.pendingResource } : {}),
    },
    recoveryCleanup: {
      ownsTarget,
      profileKind: proof.kind,
      keepBrowser: disposition === "preserve",
      ...(ownsTarget ? { closeOwnedTargetOnComplete: true } : {}),
    },
  };
  return {
    userDataDir: proof.userDataDir,
    chromeProfileRoot: proof.userDataDir,
    chromeProcessIdentity: resource.chromeProcessIdentity,
    chromeHost: resource.chromeHost,
    chromePort: resource.chromePort,
    chromeTargetId: resource.chromeTargetId,
    recoveryCleanupResult: { status: "failed", error: "interrupted" },
    recoveryCleanupResources: [resource],
  };
}

async function temporaryAuthority() {
  const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-project-sources-proof-home-"));
  setOracleHomeDirOverrideForTest(oracleHome);
  const storage = await recovery.establishProjectSourcesCleanupStorage();
  const parent = await captureProfileDirectoryIdentity(os.tmpdir(), { create: true });
  const intent = recovery.createProjectSourcesProfileCreateIntent(storage, parent, randomUUID());
  await recovery.persistProjectSourcesCleanupRuntime({}, storage, { profileCreate: intent });
  await mkdir(intent.userDataDir);
  const proof = await recovery.createProjectSourcesTemporaryCleanupProof(intent, storage);
  return { oracleHome, storage, intent, proof };
}

async function manualAuthority() {
  const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-project-sources-manual-home-"));
  const requestedProfileDir = path.join(oracleHome, "manual-profile");
  await mkdir(requestedProfileDir);
  setOracleHomeDirOverrideForTest(oracleHome);
  const storage = await recovery.establishProjectSourcesCleanupStorage();
  const profileDirectory = await captureProfileDirectoryIdentity(requestedProfileDir);
  const profileDir = profileDirectory.canonicalPath;
  const generationId = randomUUID();
  const leaseId = randomUUID();
  const owner: OracleChromeOwnerRecord = {
    port: 9222,
    processIdentity: processIdentity(profileDirectory, generationId),
    disposition: "preserve",
  };
  const initialProof: recovery.ProjectSourcesManualCleanupProof = {
    ...recovery.createProjectSourcesManualCleanupProof(
      storage,
      generationId,
      profileDir,
      profileDirectory,
      leaseId,
    ),
    lease: { id: leaseId, generationId, state: "active" },
  };
  const proof = await recovery.updateProjectSourcesCleanupProofForPersistence(
    cleanupRuntime(initialProof, { owner }),
    initialProof,
    storage,
    {
      hasExactBrowserTabLease: vi.fn(async () => true),
      readOracleChromeOwner: vi.fn(async () => owner),
    },
  );
  if (proof.kind !== "manual-login") throw new Error("expected manual cleanup proof");
  return { oracleHome, storage, profileDir, profileDirectory, generationId, leaseId, owner, proof };
}

async function removeAuthority(oracleHome: string, profileDir?: string) {
  setOracleHomeDirOverrideForTest(null);
  if (profileDir) await rm(profileDir, { recursive: true, force: true });
  await rm(oracleHome, { recursive: true, force: true });
}

test("rejects an exact generic sibling runtime with no Project Sources proof before cleanup", async () => {
  const authority = await temporaryAuthority();
  const retryCleanup = vi.fn();
  try {
    await writeFile(
      authority.storage.journalPath,
      `${JSON.stringify({
        version: 2,
        oracleHome: authority.storage.root,
        runtime: cleanupRuntime(authority.proof),
      })}\n`,
    );
    await expect(
      recovery.retryPendingProjectSourcesCleanup(() => undefined, authority.storage, {
        retryCleanup,
      }),
    ).rejects.toThrow(/journal is invalid/i);
    expect(retryCleanup).not.toHaveBeenCalled();
  } finally {
    await removeAuthority(authority.oracleHome, authority.intent.userDataDir);
  }
});

test("accepts the exact storage- and generation-bound temporary proof", async () => {
  const authority = await temporaryAuthority();
  const retryCleanup = vi.fn(async (runtime, _logger, deps) => {
    const completed = { ...runtime };
    delete completed.recoveryCleanupResources;
    delete completed.recoveryCleanupResult;
    const result = { status: "completed" as const, runtime: completed };
    await deps.persistFinalizationResult(result);
    return result;
  });
  try {
    await recovery.persistProjectSourcesCleanupRuntime(
      cleanupRuntime(authority.proof),
      authority.storage,
      { proof: authority.proof },
    );
    await expect(
      recovery.retryPendingProjectSourcesCleanup(() => undefined, authority.storage, {
        retryCleanup,
      }),
    ).resolves.toBeUndefined();
    expect(retryCleanup).toHaveBeenCalledOnce();
    await expect(readFile(authority.storage.journalPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await removeAuthority(authority.oracleHome, authority.intent.userDataDir);
  }
});

test("retains the proof across partial target settlement and later converges", async () => {
  const authority = await temporaryAuthority();
  const runtime = cleanupRuntime(authority.proof, {
    targetId: "project-sources-target",
    capabilityId: randomUUID(),
  });
  const retryCleanup = vi
    .fn()
    .mockImplementationOnce(async (current, _logger, deps) => {
      const resource = current.recoveryCleanupResources[0];
      const remaining = {
        ...current,
        chromeTargetId: undefined,
        recoveryCleanupResources: [
          {
            ...resource,
            chromeTargetId: undefined,
            targetCloseCapability: undefined,
            recoveryCleanup: {
              ...resource.recoveryCleanup,
              ownsTarget: false,
              closeOwnedTargetOnComplete: undefined,
            },
          },
        ],
        recoveryCleanupResult: {
          status: "failed" as const,
          error: "profile removal deferred",
          settlementMode: "abort" as const,
        },
      };
      const result = {
        status: "pending" as const,
        runtime: remaining,
        error: "profile removal deferred",
      };
      await deps.persistFinalizationResult(result);
      return result;
    })
    .mockImplementationOnce(async (current, _logger, deps) => {
      const completed = { ...current };
      delete completed.recoveryCleanupResources;
      delete completed.recoveryCleanupResult;
      const result = { status: "completed" as const, runtime: completed };
      await deps.persistFinalizationResult(result);
      return result;
    });
  try {
    await recovery.persistProjectSourcesCleanupRuntime(runtime, authority.storage, {
      proof: authority.proof,
    });
    await expect(
      recovery.retryPendingProjectSourcesCleanup(() => undefined, authority.storage, {
        retryCleanup,
      }),
    ).rejects.toThrow(/cleanup remains retryable/i);
    const persisted = JSON.parse(await readFile(authority.storage.journalPath, "utf8"));
    expect(persisted.proof).toEqual(authority.proof);
    expect(persisted.runtime.recoveryCleanupResources[0].recoveryCleanup.ownsTarget).toBe(false);
    await expect(
      recovery.retryPendingProjectSourcesCleanup(() => undefined, authority.storage, {
        retryCleanup,
      }),
    ).resolves.toBeUndefined();
  } finally {
    await removeAuthority(authority.oracleHome, authority.intent.userDataDir);
  }
});

test("never moves an occupied create intent without its exact marker", async () => {
  const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-project-sources-create-home-"));
  setOracleHomeDirOverrideForTest(oracleHome);
  try {
    const storage = await recovery.establishProjectSourcesCleanupStorage();
    const parent = await captureProfileDirectoryIdentity(os.tmpdir(), { create: true });
    const intent = recovery.createProjectSourcesProfileCreateIntent(storage, parent, randomUUID());
    await recovery.persistProjectSourcesCleanupRuntime({}, storage, { profileCreate: intent });
    await mkdir(intent.userDataDir);
    const occupantFile = path.join(intent.userDataDir, "sibling-owner.txt");
    await writeFile(occupantFile, "preserve me");
    await expect(
      recovery.retryPendingProjectSourcesCleanup(() => undefined, storage),
    ).rejects.toThrow(/preserved an unproven temporary-profile occupant/i);
    await expect(readFile(occupantFile, "utf8")).resolves.toBe("preserve me");
    await expect(readFile(storage.journalPath, "utf8")).resolves.toContain('"profileCreate"');
    await rm(intent.userDataDir, { recursive: true, force: true });
  } finally {
    await removeAuthority(oracleHome);
  }
});

test("clears an absent create intent and removes only a marker-proven occupant", async () => {
  const authority = await temporaryAuthority();
  try {
    await expect(
      recovery.retryPendingProjectSourcesCleanup(() => undefined, authority.storage, {
        removeProfileDirectoryIfIdentityMatches: vi.fn(async (profileDir: string) => {
          await rm(profileDir, { recursive: true, force: true });
          return true;
        }),
      }),
    ).resolves.toBeUndefined();
    await expect(readFile(authority.storage.journalPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(authority.intent.userDataDir, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const absent = recovery.createProjectSourcesProfileCreateIntent(
      authority.storage,
      authority.intent.parent,
      randomUUID(),
    );
    await recovery.persistProjectSourcesCleanupRuntime({}, authority.storage, {
      profileCreate: absent,
    });
    await expect(
      recovery.retryPendingProjectSourcesCleanup(() => undefined, authority.storage),
    ).resolves.toBeUndefined();
    await expect(readFile(authority.storage.journalPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await removeAuthority(authority.oracleHome, authority.intent.userDataDir);
  }
}, 15_000);

test("rejects manual cleanup without exact Project Sources lease evidence", async () => {
  const authority = await manualAuthority();
  const retryCleanup = vi.fn();
  try {
    await recovery.persistProjectSourcesCleanupRuntime(
      cleanupRuntime(authority.proof, { owner: authority.owner }),
      authority.storage,
      { proof: authority.proof },
    );
    await expect(
      recovery.retryPendingProjectSourcesCleanup(() => undefined, authority.storage, {
        hasExactBrowserTabLease: vi.fn(async () => false),
        readOracleChromeOwner: vi.fn(async () => authority.owner),
        retryCleanup,
      }),
    ).rejects.toThrow(/exact lease evidence is unavailable/i);
    expect(retryCleanup).not.toHaveBeenCalled();
  } finally {
    await removeAuthority(authority.oracleHome);
  }
});

test("same-controller retry closes and releases the exact manual resources", async () => {
  const authority = await manualAuthority();
  let lease: BrowserTabLease | undefined;
  try {
    lease = await acquireBrowserTabLease(authority.profileDir, {
      maxConcurrentTabs: 1,
      timeoutMs: 100,
      pollMs: 50,
      sessionId: authority.proof.storageOwnerId,
      generationId: authority.generationId,
      leaseId: authority.leaseId,
    });
    const closeTarget = vi.fn(async () => ({ status: "completed" as const }));
    const capability = retainChromeTargetCloseCapability({
      ownerId: authority.proof.storageOwnerId,
      generationId: authority.generationId,
      targetId: "project-sources-manual-target",
      close: closeTarget,
    });
    const runtime = cleanupRuntime(authority.proof, {
      owner: authority.owner,
      targetId: "project-sources-manual-target",
      capabilityId: capability.capabilityId,
    });
    runtime.recoveryCleanupResources![0]!.targetCloseCapability = capability;
    await recovery.persistProjectSourcesCleanupRuntime(runtime, authority.storage, {
      proof: authority.proof,
    });
    await expect(
      recovery.retryPendingProjectSourcesCleanup(() => undefined, authority.storage, {
        readOracleChromeOwner: vi.fn(async () => authority.owner),
      }),
    ).resolves.toBeUndefined();
    expect(closeTarget).toHaveBeenCalledOnce();
    await expect(readFile(authority.storage.journalPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await lease?.release().catch(() => undefined);
    targetCloseAuthority.clearRetainedTargetCloseAuthorities();
    await removeAuthority(authority.oracleHome);
  }
}, 10_000);

test("restart capability loss preserves the manual target and durable proof", async () => {
  const authority = await manualAuthority();
  let lease: BrowserTabLease | undefined;
  try {
    lease = await acquireBrowserTabLease(authority.profileDir, {
      maxConcurrentTabs: 1,
      timeoutMs: 100,
      pollMs: 50,
      sessionId: authority.proof.storageOwnerId,
      generationId: authority.generationId,
      leaseId: authority.leaseId,
    });
    const runtime = cleanupRuntime(authority.proof, {
      owner: authority.owner,
      targetId: "project-sources-restart-target",
      capabilityId: randomUUID(),
    });
    await recovery.persistProjectSourcesCleanupRuntime(runtime, authority.storage, {
      proof: authority.proof,
    });
    await expect(
      recovery.retryPendingProjectSourcesCleanup(() => undefined, authority.storage, {
        readOracleChromeOwner: vi.fn(async () => authority.owner),
      }),
    ).rejects.toThrow(/cleanup remains retryable/i);
    const persisted = JSON.parse(await readFile(authority.storage.journalPath, "utf8"));
    expect(persisted.proof).toEqual(authority.proof);
    expect(persisted.runtime.recoveryCleanupResources[0].chromeTargetId).toBe(
      "project-sources-restart-target",
    );
  } finally {
    await lease?.release().catch(() => undefined);
    targetCloseAuthority.clearRetainedTargetCloseAuthorities();
    await removeAuthority(authority.oracleHome);
  }
}, 10_000);

function exactEndpointAuthority() {
  return {
    browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/exact",
    kill: vi.fn(),
    runExactOperation: vi.fn(),
    release: vi.fn(async () => undefined),
  };
}

test("closes exactly one pending manual marker target before generic cleanup", async () => {
  const authority = await manualAuthority();
  const endpointAuthority = exactEndpointAuthority();
  const closeExact = vi.fn(async () => ({ status: "completed" as const }));
  const retryCleanup = vi.fn(async (runtime, _logger, deps) => {
    expect(runtime.recoveryCleanupResources[0].acquisition.pendingResource).toBeUndefined();
    expect(runtime.recoveryCleanupResources[0].recoveryCleanup.ownsTarget).toBe(false);
    const persisted = JSON.parse(await readFile(authority.storage.journalPath, "utf8"));
    expect(
      persisted.runtime.recoveryCleanupResources[0].acquisition.pendingResource,
    ).toBeUndefined();
    const completed = { ...runtime };
    delete completed.recoveryCleanupResources;
    delete completed.recoveryCleanupResult;
    const result = { status: "completed" as const, runtime: completed };
    await deps.persistFinalizationResult(result);
    return result;
  });
  try {
    const runtime = cleanupRuntime(authority.proof, {
      owner: authority.owner,
      pendingResource: "chrome-target",
    });
    await recovery.persistProjectSourcesCleanupRuntime(runtime, authority.storage, {
      proof: authority.proof,
    });
    await expect(
      recovery.retryPendingProjectSourcesCleanup(() => undefined, authority.storage, {
        hasExactBrowserTabLease: vi.fn(async () => true),
        readOracleChromeOwner: vi.fn(async () => authority.owner),
        bindPersistedLocalEndpoint: vi.fn(async () => ({
          status: "bound" as const,
          host: "127.0.0.1",
          port: 9222,
          browserWSEndpoint: endpointAuthority.browserWSEndpoint,
          authority: endpointAuthority,
        })),
        listChromeTargetsWithExactAuthority: vi.fn(async () => ({
          status: "completed" as const,
          value: [
            {
              targetId: "marker-target",
              type: "page",
              url: `about:blank#oracle-project-sources=${authority.generationId}`,
            },
          ],
        })),
        closeChromeTargetWithExactAuthority: closeExact,
        retryCleanup,
      }),
    ).resolves.toBeUndefined();
    expect(closeExact).toHaveBeenCalledOnce();
    expect(endpointAuthority.release).toHaveBeenCalledOnce();
  } finally {
    await removeAuthority(authority.oracleHome);
  }
});

test("preserves an ambiguous pending manual marker target", async () => {
  const authority = await manualAuthority();
  const endpointAuthority = exactEndpointAuthority();
  const marker = `about:blank#oracle-project-sources=${authority.generationId}`;
  const retryCleanup = vi.fn();
  try {
    const runtime = cleanupRuntime(authority.proof, {
      owner: authority.owner,
      pendingResource: "chrome-target",
    });
    await recovery.persistProjectSourcesCleanupRuntime(runtime, authority.storage, {
      proof: authority.proof,
    });
    await expect(
      recovery.retryPendingProjectSourcesCleanup(() => undefined, authority.storage, {
        hasExactBrowserTabLease: vi.fn(async () => true),
        readOracleChromeOwner: vi.fn(async () => authority.owner),
        bindPersistedLocalEndpoint: vi.fn(async () => ({
          status: "bound" as const,
          host: "127.0.0.1",
          port: 9222,
          browserWSEndpoint: endpointAuthority.browserWSEndpoint,
          authority: endpointAuthority,
        })),
        listChromeTargetsWithExactAuthority: vi.fn(async () => ({
          status: "completed" as const,
          value: [
            { targetId: "marker-a", type: "page", url: marker },
            { targetId: "marker-b", type: "page", url: marker },
          ],
        })),
        closeChromeTargetWithExactAuthority: vi.fn(),
        retryCleanup,
      }),
    ).rejects.toThrow(/ambiguous or mismatched/i);
    expect(retryCleanup).not.toHaveBeenCalled();
    const persisted = JSON.parse(await readFile(authority.storage.journalPath, "utf8"));
    expect(persisted.runtime.recoveryCleanupResources[0].acquisition.pendingResource).toBe(
      "chrome-target",
    );
  } finally {
    await removeAuthority(authority.oracleHome);
  }
});

test("rejects released manual cleanup when its physical Project Sources admission receipt is missing", async () => {
  const authority = await manualAuthority();
  const retryCleanup = vi.fn();
  try {
    const proof: recovery.ProjectSourcesManualCleanupProof = {
      ...authority.proof,
      lease: { ...authority.proof.lease, state: "released" },
    };
    await recovery.persistProjectSourcesCleanupRuntime(
      cleanupRuntime(proof, { owner: authority.owner }),
      authority.storage,
      { proof },
    );
    await rm(proof.admission.path);
    await expect(
      recovery.retryPendingProjectSourcesCleanup(() => undefined, authority.storage, {
        retryCleanup,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(retryCleanup).not.toHaveBeenCalled();
  } finally {
    await removeAuthority(authority.oracleHome);
  }
});

test("retains physical admission through partial lease settlement and later converges", async () => {
  const authority = await manualAuthority();
  try {
    const runtime = cleanupRuntime(authority.proof, { owner: authority.owner });
    await recovery.persistProjectSourcesCleanupRuntime(runtime, authority.storage, {
      proof: authority.proof,
    });
    const persistReleasedLease = vi.fn(async (current, _logger, deps) => {
      const remaining: BrowserRuntimeMetadata = structuredClone(current);
      delete remaining.recoveryCleanupResources![0]!.tabLease;
      remaining.recoveryCleanupResult = {
        status: "pending",
        error: "process settlement remains pending",
        settlementMode: "abort",
      };
      const result = {
        status: "pending" as const,
        runtime: remaining,
        error: "process settlement remains pending",
      };
      await deps.persistFinalizationResult(result);
      return result;
    });
    await expect(
      recovery.retryPendingProjectSourcesCleanup(() => undefined, authority.storage, {
        hasExactBrowserTabLease: vi.fn(async () => true),
        readOracleChromeOwner: vi.fn(async () => authority.owner),
        retryCleanup: persistReleasedLease,
      }),
    ).rejects.toThrow(/cleanup remains retryable/i);
    const partial = JSON.parse(await readFile(authority.storage.journalPath, "utf8"));
    expect(partial.proof.lease.state).toBe("released");
    expect(await readFile(authority.proof.admission.path, "utf8")).toContain(
      "project-sources-manual-cleanup-admission",
    );

    const completeCleanup = vi.fn(async (current, _logger, deps) => {
      const completed: BrowserRuntimeMetadata = { ...current };
      delete completed.recoveryCleanupResources;
      delete completed.recoveryCleanupResult;
      const result = { status: "completed" as const, runtime: completed };
      await deps.persistFinalizationResult(result);
      return result;
    });
    await expect(
      recovery.retryPendingProjectSourcesCleanup(() => undefined, authority.storage, {
        retryCleanup: completeCleanup,
      }),
    ).resolves.toBeUndefined();
    expect(completeCleanup).toHaveBeenCalledOnce();
    await expect(readFile(authority.storage.journalPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(authority.proof.admission.path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await removeAuthority(authority.oracleHome);
  }
});
