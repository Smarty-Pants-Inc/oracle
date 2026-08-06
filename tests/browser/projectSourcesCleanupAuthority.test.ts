import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  __test__,
  authenticateProjectSourcesManualAdmission,
  createProjectSourcesManualCleanupProof,
  parseProjectSourcesCleanupProof,
  type ProjectSourcesCleanupStorage,
  type ProjectSourcesManualCleanupProof,
} from "../../src/browser/projectSourcesCleanupAuthority.js";
import { establishProjectSourcesCleanupStorage } from "../../src/browser/projectSourcesRecovery.js";
import {
  captureProfileDirectoryIdentity,
  createChromeProcessLaunchClaim,
  parseOracleChromeOwnerRecord,
  type OracleChromeOwnerRecord,
} from "../../src/browser/profileState.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

interface ManualPublicationAuthority {
  readonly oracleHome: string;
  readonly storage: ProjectSourcesCleanupStorage;
  readonly owner: OracleChromeOwnerRecord;
  readonly proof: ProjectSourcesManualCleanupProof;
}

async function manualPublicationAuthority(): Promise<ManualPublicationAuthority> {
  const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-project-sources-publication-"));
  setOracleHomeDirOverrideForTest(oracleHome);
  const storage = await establishProjectSourcesCleanupStorage();
  const profilePath = path.join(oracleHome, "manual-profile");
  await mkdir(profilePath);
  const profileDirectory = await captureProfileDirectoryIdentity(profilePath);
  const generationId = randomUUID();
  const leaseId = randomUUID();
  const launchClaim = createChromeProcessLaunchClaim(generationId);
  const owner: OracleChromeOwnerRecord = {
    port: 9222,
    disposition: "preserve",
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
  const proof: ProjectSourcesManualCleanupProof = {
    ...createProjectSourcesManualCleanupProof(
      storage,
      generationId,
      profileDirectory.canonicalPath,
      profileDirectory,
      leaseId,
    ),
    lease: { id: leaseId, generationId, state: "active" },
  };
  return { oracleHome, storage, owner, proof };
}

async function fileIdentity(receiptPath: string) {
  const stats = await lstat(receiptPath, { bigint: true });
  return {
    device: String(stats.dev),
    inode: String(stats.ino),
    birthtimeNs: String(stats.birthtimeNs),
    ctimeNs: String(stats.ctimeNs),
    mode: String(stats.mode),
    size: String(stats.size),
  };
}

afterEach(() => {
  __test__.setBeforeManualAdmissionPublication(undefined);
  __test__.setBeforeManualAdmissionPreparationCleanup(undefined);
  setOracleHomeDirOverrideForTest(null);
});
test("requires persisted disposition while delegating owner validation to the canonical parser", async () => {
  const authority = await manualPublicationAuthority();
  const withoutDisposition: Record<string, unknown> = { ...authority.owner };
  delete withoutDisposition.disposition;
  const invalidOwners = [
    { ...authority.owner, extraAuthority: true },
    { ...authority.owner, port: 65_536 },
    { ...authority.owner, processIdentity: { ...authority.owner.processIdentity, pid: 0 } },
  ];
  try {
    expect(
      parseProjectSourcesCleanupProof({ ...authority.proof, owner: withoutDisposition }),
    ).toBeNull();
    for (const owner of invalidOwners) {
      expect(parseOracleChromeOwnerRecord(owner, process.platform)).toBeNull();
      expect(parseProjectSourcesCleanupProof({ ...authority.proof, owner })).toBeNull();
    }
  } finally {
    await rm(authority.oracleHome, { recursive: true, force: true });
  }
});

test("does not publish a manual admission until its synced preparation can be linked, then converges", async () => {
  const authority = await manualPublicationAuthority();
  let preparationPath = "";
  try {
    __test__.setBeforeManualAdmissionPublication((pathname) => {
      preparationPath = pathname;
      throw new Error("simulated hard interruption before receipt publication");
    });
    await expect(
      authenticateProjectSourcesManualAdmission(
        authority.proof,
        authority.storage,
        authority.owner,
        {
          create: true,
        },
      ),
    ).rejects.toThrow(/interruption/i);
    await expect(readFile(authority.proof.admission.path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(preparationPath, "utf8")).resolves.toContain(
      "project-sources-manual-cleanup-admission",
    );

    __test__.setBeforeManualAdmissionPublication(undefined);
    const authenticated = await authenticateProjectSourcesManualAdmission(
      authority.proof,
      authority.storage,
      authority.owner,
      { create: true },
    );
    const receipt = JSON.parse(await readFile(authority.proof.admission.path, "utf8"));
    expect(receipt).toEqual({
      version: 1,
      purpose: "project-sources-manual-cleanup-admission",
      storageOwnerId: authority.proof.storageOwnerId,
      generationId: authority.proof.generationId,
      userDataDir: authority.proof.userDataDir,
      profileDirectory: authority.proof.profileDirectory,
      lease: { id: authority.proof.lease.id, generationId: authority.proof.generationId },
      owner: authority.owner,
      token: authority.proof.admission.token,
    });
    expect(authenticated.admission.identity).toEqual(
      await fileIdentity(authority.proof.admission.path),
    );
    expect((await lstat(authority.proof.admission.path, { bigint: true })).nlink).toBe(1n);
    await expect(readFile(preparationPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(authority.oracleHome, { recursive: true, force: true });
  }
});

test("removes the staged hard-link alias when retrying an interrupted publication", async () => {
  const authority = await manualPublicationAuthority();
  let preparationPath = "";
  try {
    __test__.setBeforeManualAdmissionPreparationCleanup((pathname) => {
      preparationPath = pathname;
      throw new Error("simulated hard interruption after receipt publication");
    });
    await expect(
      authenticateProjectSourcesManualAdmission(
        authority.proof,
        authority.storage,
        authority.owner,
        {
          create: true,
        },
      ),
    ).rejects.toThrow(/interruption/i);
    expect((await lstat(authority.proof.admission.path, { bigint: true })).nlink).toBe(2n);
    expect((await lstat(preparationPath, { bigint: true })).nlink).toBe(2n);

    __test__.setBeforeManualAdmissionPreparationCleanup(undefined);
    await expect(
      authenticateProjectSourcesManualAdmission(
        authority.proof,
        authority.storage,
        authority.owner,
        {
          create: true,
        },
      ),
    ).resolves.toMatchObject({ authenticated: true });
    expect((await lstat(authority.proof.admission.path, { bigint: true })).nlink).toBe(1n);
    await expect(readFile(preparationPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(authority.oracleHome, { recursive: true, force: true });
  }
});

test("replaces an interrupted partial preparation without admitting a partial final receipt", async () => {
  const authority = await manualPublicationAuthority();
  const preparationPath = __test__.manualAdmissionPreparationPath(
    authority.proof.admission.path,
    authority.proof,
  );
  try {
    await writeFile(preparationPath, "{\n");
    const authenticated = await authenticateProjectSourcesManualAdmission(
      authority.proof,
      authority.storage,
      authority.owner,
      { create: true },
    );
    expect(authenticated.authenticated).toBe(true);
    await expect(readFile(preparationPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(authority.proof.admission.path, "utf8"))).toMatchObject({
      generationId: authority.proof.generationId,
      token: authority.proof.admission.token,
    });
  } finally {
    await rm(authority.oracleHome, { recursive: true, force: true });
  }
});

test.each(["foreign", "malformed"] as const)(
  "fails closed on a %s final receipt without replacing it",
  async (kind) => {
    const authority = await manualPublicationAuthority();
    const finalContent =
      kind === "foreign"
        ? `${JSON.stringify({
            version: 1,
            purpose: "project-sources-manual-cleanup-admission",
            storageOwnerId: authority.proof.storageOwnerId,
            generationId: authority.proof.generationId,
            userDataDir: authority.proof.userDataDir,
            profileDirectory: authority.proof.profileDirectory,
            lease: { id: authority.proof.lease.id, generationId: authority.proof.generationId },
            owner: authority.owner,
            token: randomUUID(),
          })}\n`
        : "{\n";
    try {
      await writeFile(authority.proof.admission.path, finalContent);
      await expect(
        authenticateProjectSourcesManualAdmission(
          authority.proof,
          authority.storage,
          authority.owner,
          {
            create: true,
          },
        ),
      ).rejects.toThrow();
      await expect(readFile(authority.proof.admission.path, "utf8")).resolves.toBe(finalContent);
    } finally {
      await rm(authority.oracleHome, { recursive: true, force: true });
    }
  },
);
