import { link, lstat, open, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "../fsDurability.js";
import { sameChromeProcessIdentity } from "./chromeProcessIdentity.js";
import {
  PROJECT_SOURCES_UUID_PATTERN,
  parseProjectSourcesManualOwner,
  projectSourcesCleanupOwnerId,
  projectSourcesMarkerFileIdentityFromStats,
  sameProjectSourcesMarkerFileIdentity,
  type ProjectSourcesCleanupProof,
  type ProjectSourcesCleanupStorage,
  type ProjectSourcesManualCleanupProof,
  type ProjectSourcesMarkerFileIdentity,
} from "./projectSourcesCleanupProof.js";
import {
  parseProfileDirectoryIdentity,
  sameProfileDirectoryIdentity,
  type OracleChromeOwnerRecord,
} from "./profileState.js";

export interface ProjectSourcesManualAdmissionOptions {
  readonly create?: boolean;
  readonly beforePublication?: (preparationPath: string) => void | Promise<void>;
  readonly beforePreparationCleanup?: (preparationPath: string) => void | Promise<void>;
}

export function sameProjectSourcesManualOwner(
  left: OracleChromeOwnerRecord,
  right: OracleChromeOwnerRecord,
): boolean {
  return (
    left.port === right.port &&
    left.disposition === right.disposition &&
    left.preservationPolicy === right.preservationPolicy &&
    sameChromeProcessIdentity(left.processIdentity, right.processIdentity)
  );
}

function manualAdmissionContentMatches(
  value: unknown,
  proof: ProjectSourcesManualCleanupProof,
  owner: OracleChromeOwnerRecord,
): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const lease = candidate.lease as Record<string, unknown> | undefined;
  const admittedOwner = parseProjectSourcesManualOwner(candidate.owner);
  const profileDirectory = parseProfileDirectoryIdentity(
    candidate.profileDirectory,
    process.platform,
  );
  return Boolean(
    candidate.version === 1 &&
    candidate.purpose === "project-sources-manual-cleanup-admission" &&
    candidate.storageOwnerId === proof.storageOwnerId &&
    candidate.generationId === proof.generationId &&
    candidate.userDataDir === proof.userDataDir &&
    candidate.token === proof.admission.token &&
    lease?.id === proof.lease.id &&
    lease?.generationId === proof.generationId &&
    profileDirectory &&
    sameProfileDirectoryIdentity(profileDirectory, proof.profileDirectory) &&
    admittedOwner &&
    sameProjectSourcesManualOwner(admittedOwner, owner),
  );
}

function manualAdmissionContent(
  proof: ProjectSourcesManualCleanupProof,
  owner: OracleChromeOwnerRecord,
): string {
  return `${JSON.stringify({
    version: 1,
    purpose: "project-sources-manual-cleanup-admission",
    storageOwnerId: proof.storageOwnerId,
    generationId: proof.generationId,
    userDataDir: proof.userDataDir,
    profileDirectory: proof.profileDirectory,
    lease: { id: proof.lease.id, generationId: proof.generationId },
    owner,
    token: proof.admission.token,
  })}\n`;
}

export function manualAdmissionPreparationPath(
  expectedPath: string,
  proof: ProjectSourcesManualCleanupProof,
): string {
  if (!PROJECT_SOURCES_UUID_PATTERN.test(proof.admission.token)) {
    throw new Error("Project Sources manual admission has an invalid receipt token.");
  }
  return `${expectedPath}.${proof.admission.token}.preparing`;
}

async function authenticateManualAdmissionReceipt(
  receiptPath: string,
  proof: ProjectSourcesManualCleanupProof,
  owner: OracleChromeOwnerRecord,
  requireSingleLink: boolean,
): Promise<ProjectSourcesMarkerFileIdentity> {
  const beforeStats = await lstat(receiptPath, { bigint: true });
  if (requireSingleLink && beforeStats.nlink !== 1n) {
    throw new Error("Project Sources manual admission receipt has a writable hard-link alias.");
  }
  const before = projectSourcesMarkerFileIdentityFromStats(beforeStats);
  const parsed: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
  const afterStats = await lstat(receiptPath, { bigint: true });
  const after = projectSourcesMarkerFileIdentityFromStats(afterStats);
  if (
    (requireSingleLink && afterStats.nlink !== 1n) ||
    !sameProjectSourcesMarkerFileIdentity(before, after) ||
    !manualAdmissionContentMatches(parsed, proof, owner)
  ) {
    throw new Error("Project Sources manual admission receipt changed or mismatched.");
  }
  return before;
}

async function removePublishedManualAdmissionPreparation(
  preparationPath: string,
  proof: ProjectSourcesManualCleanupProof,
  storage: ProjectSourcesCleanupStorage,
  owner: OracleChromeOwnerRecord,
): Promise<void> {
  try {
    await authenticateManualAdmissionReceipt(preparationPath, proof, owner, false);
  } catch {
    return;
  }
  try {
    await unlink(preparationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await syncDirectory(storage.root.canonicalPath);
}

async function prepareManualAdmissionReceipt(
  preparationPath: string,
  proof: ProjectSourcesManualCleanupProof,
  owner: OracleChromeOwnerRecord,
): Promise<void> {
  const content = manualAdmissionContent(proof, owner);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(preparationPath, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        await authenticateManualAdmissionReceipt(preparationPath, proof, owner, true);
        return;
      } catch {
        await rm(preparationPath, { force: true });
      }
    }
  }
  throw new Error("Project Sources manual admission preparation remains unavailable.");
}

async function publishManualAdmissionReceipt(
  expectedPath: string,
  proof: ProjectSourcesManualCleanupProof,
  storage: ProjectSourcesCleanupStorage,
  owner: OracleChromeOwnerRecord,
  options: ProjectSourcesManualAdmissionOptions,
): Promise<ProjectSourcesMarkerFileIdentity> {
  const preparationPath = manualAdmissionPreparationPath(expectedPath, proof);
  try {
    await authenticateManualAdmissionReceipt(expectedPath, proof, owner, false);
    await removePublishedManualAdmissionPreparation(preparationPath, proof, storage, owner);
    return await authenticateManualAdmissionReceipt(expectedPath, proof, owner, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await prepareManualAdmissionReceipt(preparationPath, proof, owner);
  await options.beforePublication?.(preparationPath);
  try {
    await link(preparationPath, expectedPath);
    await syncDirectory(storage.root.canonicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await options.beforePreparationCleanup?.(preparationPath);
  await removePublishedManualAdmissionPreparation(preparationPath, proof, storage, owner);
  return await authenticateManualAdmissionReceipt(expectedPath, proof, owner, true);
}

export async function authenticateProjectSourcesManualAdmission(
  proof: ProjectSourcesManualCleanupProof,
  storage: ProjectSourcesCleanupStorage,
  owner: OracleChromeOwnerRecord,
  options: ProjectSourcesManualAdmissionOptions = {},
): Promise<ProjectSourcesManualCleanupProof> {
  if (proof.storageOwnerId !== projectSourcesCleanupOwnerId(storage)) {
    throw new Error("Project Sources manual admission has different cleanup storage.");
  }
  const expectedPath = path.join(
    storage.root.canonicalPath,
    `project-sources-admission-${proof.generationId}.json`,
  );
  if (proof.admission.path !== expectedPath) {
    throw new Error("Project Sources manual admission is outside its exact cleanup storage.");
  }
  if (
    !sameProfileDirectoryIdentity(owner.processIdentity.profileDirectory, proof.profileDirectory)
  ) {
    throw new Error("Project Sources manual admission owner has a different physical profile.");
  }
  const identity = options.create
    ? await publishManualAdmissionReceipt(expectedPath, proof, storage, owner, options)
    : await authenticateManualAdmissionReceipt(expectedPath, proof, owner, true);
  if (
    proof.admission.identity &&
    !sameProjectSourcesMarkerFileIdentity(identity, proof.admission.identity)
  ) {
    throw new Error("Project Sources manual admission receipt changed or mismatched.");
  }
  return {
    ...proof,
    admission: { ...proof.admission, identity },
    owner,
    authenticated: true,
  };
}

export async function removeProjectSourcesManualAdmission(
  proof: ProjectSourcesCleanupProof,
  storage: ProjectSourcesCleanupStorage,
): Promise<void> {
  if (
    proof.kind !== "manual-login" ||
    !proof.owner ||
    !proof.authenticated ||
    !proof.admission.identity
  ) {
    return;
  }
  await authenticateProjectSourcesManualAdmission(proof, storage, proof.owner);
  await rm(proof.admission.path);
  await syncDirectory(storage.root.canonicalPath);
}
