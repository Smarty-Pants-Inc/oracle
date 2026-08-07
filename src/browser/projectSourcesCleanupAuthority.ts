import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { link, lstat, open, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "../fsDurability.js";
import type { BrowserRuntimeMetadata } from "../sessionManager.js";
import {
  assertPrivateDirectoryAuthority,
  assertTemporaryProfileAuthority,
  parseTemporaryProfileAuthority,
  type PrivateDirectoryAuthority,
  type TemporaryProfileAuthority,
} from "../privateTempRoot.js";
import { sameChromeProcessIdentity } from "./chromeProcessIdentity.js";
import {
  parseChromeProcessLaunchClaim,
  sameChromeProcessLaunchClaim,
} from "./chromeProcessLaunchClaim.js";
import {
  captureProfileDirectoryIdentity,
  parseOracleChromeOwnerRecord,
  parseProfileDirectoryIdentity,
  readOracleChromeOwner,
  sameProfileDirectoryIdentity,
  type OracleChromeOwnerRecord,
  type ProfileDirectoryIdentity,
} from "./profileState.js";
import { hasExactBrowserTabLease, type BrowserTabLeaseIdentity } from "./tabLeaseRegistry.js";

const PROJECT_SOURCES_PROFILE_MARKER = ".oracle-project-sources-authority.json";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

let beforeManualAdmissionPublicationForTest:
  | ((preparationPath: string) => void | Promise<void>)
  | undefined;
let beforeManualAdmissionPreparationCleanupForTest:
  | ((preparationPath: string) => void | Promise<void>)
  | undefined;

export interface ProjectSourcesMarkerFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
  readonly ctimeNs: string;
  readonly mode: string;
  readonly size: string;
}

interface ProjectSourcesTemporaryMarkerProof {
  readonly path: string;
  readonly token: string;
  readonly identity: ProjectSourcesMarkerFileIdentity;
}

export interface ProjectSourcesCleanupStorage {
  readonly requestedRoot: string;
  readonly root: ProfileDirectoryIdentity;
  readonly journalPath: string;
  readonly lockPath: string;
  readonly runtimeRoot: PrivateDirectoryAuthority;
}

export interface ProjectSourcesTemporaryCleanupProof {
  readonly version: 1;
  readonly kind: "temporary";
  readonly storageOwnerId: string;
  readonly generationId: string;
  readonly userDataDir: string;
  readonly approvedBase: ProfileDirectoryIdentity;
  readonly temporaryProfileAuthority: TemporaryProfileAuthority;
  readonly profileDirectory: ProfileDirectoryIdentity;
  readonly marker: ProjectSourcesTemporaryMarkerProof;
}

export interface ProjectSourcesManualCleanupProof {
  readonly version: 1;
  readonly kind: "manual-login";
  readonly storageOwnerId: string;
  readonly generationId: string;
  readonly userDataDir: string;
  readonly profileDirectory: ProfileDirectoryIdentity;
  readonly lease: {
    readonly id: string;
    readonly generationId: string;
    readonly state: "pending" | "active" | "released";
  };
  readonly admission: {
    readonly path: string;
    readonly token: string;
    readonly identity?: ProjectSourcesMarkerFileIdentity;
  };
  readonly owner?: OracleChromeOwnerRecord;
  readonly authenticated?: true;
}

export type ProjectSourcesCleanupProof =
  | ProjectSourcesTemporaryCleanupProof
  | ProjectSourcesManualCleanupProof;

export interface ProjectSourcesProfileCreateIntent {
  readonly generationId: string;
  readonly storageOwnerId: string;
  readonly markerToken: string;
  readonly parent: ProfileDirectoryIdentity;
  readonly temporaryProfileAuthority?: TemporaryProfileAuthority;
  readonly userDataDir: string;
  readonly proof?: ProjectSourcesTemporaryCleanupProof;
}

export interface ProjectSourcesAuthorityDeps {
  hasExactBrowserTabLease?: typeof hasExactBrowserTabLease;
  readOracleChromeOwner?: typeof readOracleChromeOwner;
}

export function projectSourcesCleanupOwnerId(storage: ProjectSourcesCleanupStorage): string {
  const root = storage.root;
  const storageAuthority = JSON.stringify([
    root.version,
    root.platform,
    root.canonicalPath,
    root.device,
    root.inode,
    root.birthtimeNs,
  ]);
  return `project-sources:${createHash("sha256").update(storageAuthority).digest("hex")}`;
}

export function createProjectSourcesProfileCreateIntent(
  storage: ProjectSourcesCleanupStorage,
  parent: ProfileDirectoryIdentity,
  generationId: string,
): ProjectSourcesProfileCreateIntent {
  if (!UUID_PATTERN.test(generationId)) {
    throw new Error("Project Sources profile creation requires a UUID generation.");
  }
  if (
    parent.platform !== storage.runtimeRoot.platform ||
    parent.canonicalPath !== storage.runtimeRoot.path ||
    parent.device !== storage.runtimeRoot.identity.device ||
    parent.inode !== storage.runtimeRoot.identity.inode ||
    parent.birthtimeNs !== storage.runtimeRoot.identity.birthtimeNs
  ) {
    throw new Error("Project Sources profile parent is not the private runtime authority.");
  }
  return {
    generationId,
    storageOwnerId: projectSourcesCleanupOwnerId(storage),
    markerToken: randomUUID(),
    parent,
    userDataDir: path.join(parent.canonicalPath, `oracle-browser-${generationId}`),
  };
}

export function createProjectSourcesManualCleanupProof(
  storage: ProjectSourcesCleanupStorage,
  generationId: string,
  userDataDir: string,
  profileDirectory: ProfileDirectoryIdentity,
  leaseId: string,
): ProjectSourcesManualCleanupProof {
  return {
    version: 1,
    kind: "manual-login",
    storageOwnerId: projectSourcesCleanupOwnerId(storage),
    generationId,
    userDataDir: path.resolve(userDataDir),
    profileDirectory,
    lease: { id: leaseId, generationId, state: "pending" },
    admission: {
      path: path.join(storage.root.canonicalPath, `project-sources-admission-${generationId}.json`),
      token: randomUUID(),
    },
  };
}

function markerPath(userDataDir: string): string {
  return path.join(userDataDir, PROJECT_SOURCES_PROFILE_MARKER);
}

function markerContent(intent: ProjectSourcesProfileCreateIntent): string {
  return `${JSON.stringify({
    version: 1,
    purpose: "project-sources-cleanup",
    storageOwnerId: intent.storageOwnerId,
    generationId: intent.generationId,
    userDataDir: intent.userDataDir,
    token: intent.markerToken,
  })}\n`;
}

function captureMarkerFileIdentity(stats: BigIntStats): ProjectSourcesMarkerFileIdentity {
  if (!stats.isFile()) throw new Error("Project Sources profile authority marker is not a file.");
  return {
    device: String(stats.dev),
    inode: String(stats.ino),
    birthtimeNs: String(stats.birthtimeNs),
    ctimeNs: String(stats.ctimeNs),
    mode: String(stats.mode),
    size: String(stats.size),
  };
}

function sameMarkerFileIdentity(
  left: ProjectSourcesMarkerFileIdentity,
  right: ProjectSourcesMarkerFileIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.size === right.size
  );
}

function markerContentMatches(value: unknown, intent: ProjectSourcesProfileCreateIntent): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    candidate.purpose === "project-sources-cleanup" &&
    candidate.storageOwnerId === intent.storageOwnerId &&
    candidate.generationId === intent.generationId &&
    candidate.userDataDir === intent.userDataDir &&
    candidate.token === intent.markerToken
  );
}

export async function authenticateProjectSourcesTemporaryMarker(
  intent: ProjectSourcesProfileCreateIntent,
): Promise<ProjectSourcesTemporaryCleanupProof> {
  if (!intent.temporaryProfileAuthority) {
    throw new Error("Project Sources temporary profile has no exact profile authority.");
  }
  await assertTemporaryProfileAuthority(intent.temporaryProfileAuthority);
  const authorityPath = markerPath(intent.userDataDir);
  const before = captureMarkerFileIdentity(await lstat(authorityPath, { bigint: true }));
  const parsed: unknown = JSON.parse(await readFile(authorityPath, "utf8"));
  const after = captureMarkerFileIdentity(await lstat(authorityPath, { bigint: true }));
  if (!sameMarkerFileIdentity(before, after) || !markerContentMatches(parsed, intent)) {
    throw new Error("Project Sources temporary profile authority marker changed or mismatched.");
  }
  await assertTemporaryProfileAuthority(intent.temporaryProfileAuthority);
  return {
    version: 1,
    kind: "temporary",
    storageOwnerId: intent.storageOwnerId,
    generationId: intent.generationId,
    userDataDir: intent.userDataDir,
    approvedBase: intent.parent,
    temporaryProfileAuthority: intent.temporaryProfileAuthority,
    profileDirectory: intent.temporaryProfileAuthority.profileDirectory,
    marker: { path: authorityPath, token: intent.markerToken, identity: before },
  };
}

export async function createProjectSourcesTemporaryCleanupProof(
  intent: ProjectSourcesProfileCreateIntent,
  storage: ProjectSourcesCleanupStorage,
): Promise<ProjectSourcesTemporaryCleanupProof> {
  await assertProjectSourcesProfileParent(intent, storage);
  const handle = await open(markerPath(intent.userDataDir), "wx", 0o600);
  try {
    await handle.writeFile(markerContent(intent), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(intent.userDataDir);
  await assertProjectSourcesProfileParent(intent, storage);
  return await authenticateProjectSourcesTemporaryMarker(intent);
}

function parseMarkerFileIdentity(value: unknown): ProjectSourcesMarkerFileIdentity | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  return ["device", "inode", "birthtimeNs", "ctimeNs", "mode", "size"].every(
    (key) => typeof candidate[key] === "string" && candidate[key] !== "",
  )
    ? (candidate as unknown as ProjectSourcesMarkerFileIdentity)
    : null;
}

function parseManualOwner(value: unknown): OracleChromeOwnerRecord | null {
  return value && typeof value === "object" && Object.hasOwn(value, "disposition")
    ? parseOracleChromeOwnerRecord(value, process.platform)
    : null;
}

function parseTemporaryProof(value: unknown): ProjectSourcesTemporaryCleanupProof | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const approvedBase = parseProfileDirectoryIdentity(candidate.approvedBase, process.platform);
  const profileDirectory = parseProfileDirectoryIdentity(
    candidate.profileDirectory,
    process.platform,
  );
  const temporaryProfileAuthority = parseTemporaryProfileAuthority(
    candidate.temporaryProfileAuthority,
    process.platform,
  );
  const marker = candidate.marker as Record<string, unknown> | undefined;
  const markerIdentity = parseMarkerFileIdentity(marker?.identity);
  if (
    Object.keys(candidate).sort().join(",") !==
      "approvedBase,generationId,kind,marker,profileDirectory,storageOwnerId,temporaryProfileAuthority,userDataDir,version" ||
    candidate.version !== 1 ||
    candidate.kind !== "temporary" ||
    typeof candidate.storageOwnerId !== "string" ||
    typeof candidate.generationId !== "string" ||
    !UUID_PATTERN.test(candidate.generationId) ||
    typeof candidate.userDataDir !== "string" ||
    !approvedBase ||
    !temporaryProfileAuthority ||
    !profileDirectory ||
    path.resolve(candidate.userDataDir) !== candidate.userDataDir ||
    candidate.userDataDir !==
      path.join(approvedBase.canonicalPath, `oracle-browser-${candidate.generationId}`) ||
    profileDirectory.canonicalPath !== candidate.userDataDir ||
    temporaryProfileAuthority.generation.path !== candidate.userDataDir ||
    temporaryProfileAuthority.generation.parent.path !== approvedBase.canonicalPath ||
    temporaryProfileAuthority.generation.parent.platform !== approvedBase.platform ||
    temporaryProfileAuthority.generation.parent.identity.device !== approvedBase.device ||
    temporaryProfileAuthority.generation.parent.identity.inode !== approvedBase.inode ||
    temporaryProfileAuthority.generation.parent.identity.birthtimeNs !== approvedBase.birthtimeNs ||
    !sameProfileDirectoryIdentity(temporaryProfileAuthority.profileDirectory, profileDirectory) ||
    !marker ||
    marker.path !== markerPath(candidate.userDataDir) ||
    typeof marker.token !== "string" ||
    !UUID_PATTERN.test(marker.token) ||
    !markerIdentity
  ) {
    return null;
  }
  return Object.freeze({
    version: 1,
    kind: "temporary",
    storageOwnerId: candidate.storageOwnerId as string,
    generationId: candidate.generationId as string,
    userDataDir: candidate.userDataDir as string,
    approvedBase,
    temporaryProfileAuthority,
    profileDirectory,
    marker: Object.freeze({
      path: marker!.path as string,
      token: marker!.token as string,
      identity: markerIdentity,
    }),
  });
}

function parseManualProof(value: unknown): ProjectSourcesManualCleanupProof | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const profileDirectory = parseProfileDirectoryIdentity(
    candidate.profileDirectory,
    process.platform,
  );
  const lease = candidate.lease as Record<string, unknown> | undefined;
  const admission = candidate.admission as Record<string, unknown> | undefined;
  const admissionIdentity = parseMarkerFileIdentity(admission?.identity);
  const owner = candidate.owner === undefined ? undefined : parseManualOwner(candidate.owner);
  if (
    candidate.version !== 1 ||
    candidate.kind !== "manual-login" ||
    typeof candidate.storageOwnerId !== "string" ||
    !UUID_PATTERN.test(String(candidate.generationId)) ||
    typeof candidate.userDataDir !== "string" ||
    path.resolve(candidate.userDataDir) !== candidate.userDataDir ||
    !profileDirectory ||
    profileDirectory.canonicalPath !== candidate.userDataDir ||
    !lease ||
    typeof lease.id !== "string" ||
    lease.id === "" ||
    lease.generationId !== candidate.generationId ||
    !["pending", "active", "released"].includes(String(lease.state)) ||
    !admission ||
    typeof admission.path !== "string" ||
    path.isAbsolute(admission.path) === false ||
    path.basename(admission.path) !== `project-sources-admission-${candidate.generationId}.json` ||
    typeof admission.token !== "string" ||
    !UUID_PATTERN.test(admission.token) ||
    (admission.identity !== undefined && !admissionIdentity) ||
    (candidate.owner !== undefined && !owner) ||
    (candidate.authenticated === true && (!owner || !admissionIdentity)) ||
    (candidate.authenticated !== undefined && candidate.authenticated !== true) ||
    (admissionIdentity && (!owner || candidate.authenticated !== true))
  ) {
    return null;
  }
  return candidate as unknown as ProjectSourcesManualCleanupProof;
}

export function parseProjectSourcesCleanupProof(value: unknown): ProjectSourcesCleanupProof | null {
  return parseTemporaryProof(value) ?? parseManualProof(value);
}

export function isProjectSourcesProfileCreateIntent(
  value: unknown,
): value is ProjectSourcesProfileCreateIntent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const parent = parseProfileDirectoryIdentity(candidate.parent, process.platform);
  const temporaryProfileAuthority =
    candidate.temporaryProfileAuthority === undefined
      ? undefined
      : parseTemporaryProfileAuthority(candidate.temporaryProfileAuthority, process.platform);
  const proof = candidate.proof === undefined ? undefined : parseTemporaryProof(candidate.proof);
  return Boolean(
    parent &&
    UUID_PATTERN.test(String(candidate.generationId)) &&
    typeof candidate.storageOwnerId === "string" &&
    UUID_PATTERN.test(String(candidate.markerToken)) &&
    typeof candidate.userDataDir === "string" &&
    path.resolve(candidate.userDataDir) ===
      path.join(parent.canonicalPath, `oracle-browser-${candidate.generationId}`) &&
    (candidate.temporaryProfileAuthority === undefined ||
      (temporaryProfileAuthority &&
        temporaryProfileAuthority.generation.path === candidate.userDataDir &&
        temporaryProfileAuthority.generation.parent.path === parent.canonicalPath)) &&
    (!proof ||
      (temporaryProfileAuthority &&
        proof.generationId === candidate.generationId &&
        proof.storageOwnerId === candidate.storageOwnerId &&
        proof.marker.token === candidate.markerToken &&
        sameProfileDirectoryIdentity(proof.approvedBase, parent) &&
        sameProfileDirectoryIdentity(
          proof.temporaryProfileAuthority.profileDirectory,
          temporaryProfileAuthority.profileDirectory,
        ))),
  );
}

export function hasProjectSourcesCleanupAuthority(runtime: BrowserRuntimeMetadata): boolean {
  return Boolean(runtime.recoveryCleanupResources?.length && runtime.recoveryCleanupResult);
}

export function hasOwnedProjectSourcesProvenance(
  runtime: BrowserRuntimeMetadata,
  proof: ProjectSourcesCleanupProof,
): boolean {
  const resources = runtime.recoveryCleanupResources;
  if (!resources || resources.length !== 1) return false;
  if (runtime.userDataDir && path.resolve(runtime.userDataDir) !== proof.userDataDir) return false;
  return resources.every((resource) => {
    const acquisition = resource.acquisition;
    const launchClaim = parseChromeProcessLaunchClaim(acquisition?.processLaunchClaim);
    const profile = parseProfileDirectoryIdentity(
      resource.profileDirectoryIdentity,
      process.platform,
    );
    const temporaryProfileAuthority = parseTemporaryProfileAuthority(
      resource.temporaryProfileAuthority,
      process.platform,
    );
    const disposition = acquisition?.processOwnerDisposition;
    if (
      !acquisition ||
      acquisition.generationId !== proof.generationId ||
      !launchClaim ||
      launchClaim.generationId !== proof.generationId ||
      !disposition ||
      !profile ||
      !sameProfileDirectoryIdentity(profile, proof.profileDirectory) ||
      resource.userDataDir !== proof.userDataDir ||
      resource.chromeProfileRoot !== proof.userDataDir ||
      acquisition.targetMarkerUrl !== `about:blank#oracle-project-sources=${proof.generationId}` ||
      (proof.kind === "temporary" &&
        (resource.recoveryCleanup.profileKind !== "temporary" ||
          acquisition.processOwnerProvenance !== "temporary-launch" ||
          !temporaryProfileAuthority ||
          temporaryProfileAuthority.generation.platform !==
            proof.temporaryProfileAuthority.generation.platform ||
          temporaryProfileAuthority.generation.path !==
            proof.temporaryProfileAuthority.generation.path ||
          temporaryProfileAuthority.generation.identity.device !==
            proof.temporaryProfileAuthority.generation.identity.device ||
          temporaryProfileAuthority.generation.identity.inode !==
            proof.temporaryProfileAuthority.generation.identity.inode ||
          temporaryProfileAuthority.generation.identity.birthtimeNs !==
            proof.temporaryProfileAuthority.generation.identity.birthtimeNs ||
          temporaryProfileAuthority.generation.parent.path !==
            proof.temporaryProfileAuthority.generation.parent.path ||
          temporaryProfileAuthority.generation.parent.identity.device !==
            proof.temporaryProfileAuthority.generation.parent.identity.device ||
          temporaryProfileAuthority.generation.parent.identity.inode !==
            proof.temporaryProfileAuthority.generation.parent.identity.inode ||
          temporaryProfileAuthority.generation.parent.identity.birthtimeNs !==
            proof.temporaryProfileAuthority.generation.parent.identity.birthtimeNs ||
          !sameProfileDirectoryIdentity(
            temporaryProfileAuthority.profileDirectory,
            proof.profileDirectory,
          ))) ||
      (proof.kind === "manual-login" &&
        (resource.recoveryCleanup.profileKind !== "manual-login" ||
          acquisition.processOwnerProvenance !== "manual-canonical-owner" ||
          resource.temporaryProfileAuthority !== undefined))
    ) {
      return false;
    }
    if (
      resource.chromeProcessIdentity &&
      (!sameProfileDirectoryIdentity(resource.chromeProcessIdentity.profileDirectory, profile) ||
        (proof.kind === "temporary" &&
          !sameChromeProcessLaunchClaim(resource.chromeProcessIdentity.launchClaim, launchClaim)))
    ) {
      return false;
    }
    if (proof.kind === "manual-login") {
      const lease = resource.tabLease;
      if (proof.lease.state === "released") {
        if (lease) return false;
      } else if (
        !lease ||
        lease.id !== proof.lease.id ||
        lease.generationId !== proof.generationId ||
        !sameProfileDirectoryIdentity(lease.profileDirectory, proof.profileDirectory)
      ) {
        return false;
      }
      if (proof.lease.state === "pending" && acquisition.pendingResource !== "tab-lease")
        return false;
      if (
        resource.chromeProcessIdentity &&
        (!proof.authenticated ||
          !proof.owner ||
          !proof.admission.identity ||
          !sameChromeProcessIdentity(resource.chromeProcessIdentity, proof.owner.processIdentity) ||
          disposition !== proof.owner.disposition)
      ) {
        return false;
      }
    }
    if (acquisition.pendingResource || !resource.recoveryCleanup.ownsTarget) return true;
    return Boolean(
      typeof resource.recoveryCleanup.closeOwnedTargetOnComplete === "boolean" &&
      resource.chromeTargetId &&
      resource.targetCloseCapability?.generationId === proof.generationId &&
      resource.targetCloseCapability.capabilityId,
    );
  });
}

async function assertApprovedTemporaryBase(
  expected: ProfileDirectoryIdentity,
  storage: ProjectSourcesCleanupStorage,
): Promise<void> {
  await assertPrivateDirectoryAuthority(storage.runtimeRoot);
  if (
    expected.platform !== storage.runtimeRoot.platform ||
    expected.canonicalPath !== storage.runtimeRoot.path ||
    expected.device !== storage.runtimeRoot.identity.device ||
    expected.inode !== storage.runtimeRoot.identity.inode ||
    expected.birthtimeNs !== storage.runtimeRoot.identity.birthtimeNs
  ) {
    throw new Error("Project Sources temporary profile parent is not the private runtime root.");
  }
}

export async function assertProjectSourcesProfileParent(
  intent: ProjectSourcesProfileCreateIntent,
  storage: ProjectSourcesCleanupStorage,
): Promise<void> {
  if (intent.storageOwnerId !== projectSourcesCleanupOwnerId(storage)) {
    throw new Error("Project Sources profile creation intent has different cleanup storage.");
  }
  await assertApprovedTemporaryBase(intent.parent, storage);
  const current = await captureProfileDirectoryIdentity(intent.parent.canonicalPath);
  if (!sameProfileDirectoryIdentity(current, intent.parent)) {
    throw new Error("Project Sources temporary profile parent authority changed before recovery.");
  }
  if (intent.temporaryProfileAuthority) {
    if (
      intent.temporaryProfileAuthority.generation.path !== intent.userDataDir ||
      intent.temporaryProfileAuthority.generation.parent.path !== intent.parent.canonicalPath
    ) {
      throw new Error("Project Sources private child does not match its creation intent.");
    }
    await assertTemporaryProfileAuthority(intent.temporaryProfileAuthority);
  }
}

export async function assertProjectSourcesTemporaryProof(
  proof: ProjectSourcesTemporaryCleanupProof,
  storage: ProjectSourcesCleanupStorage,
): Promise<void> {
  if (proof.storageOwnerId !== projectSourcesCleanupOwnerId(storage)) {
    throw new Error("Project Sources temporary proof has different cleanup storage.");
  }
  await assertApprovedTemporaryBase(proof.approvedBase, storage);
  await assertTemporaryProfileAuthority(proof.temporaryProfileAuthority);
  const currentProfile = await captureProfileDirectoryIdentity(proof.userDataDir);
  if (
    !sameProfileDirectoryIdentity(currentProfile, proof.temporaryProfileAuthority.profileDirectory)
  ) {
    throw new Error("Project Sources temporary profile physical authority changed.");
  }
  const currentMarker = await authenticateProjectSourcesTemporaryMarker({
    generationId: proof.generationId,
    storageOwnerId: proof.storageOwnerId,
    markerToken: proof.marker.token,
    parent: proof.approvedBase,
    temporaryProfileAuthority: proof.temporaryProfileAuthority,
    userDataDir: proof.userDataDir,
  });
  if (
    !sameProfileDirectoryIdentity(currentMarker.profileDirectory, proof.profileDirectory) ||
    !sameMarkerFileIdentity(currentMarker.marker.identity, proof.marker.identity)
  ) {
    throw new Error("Project Sources temporary profile marker physical authority changed.");
  }
}

export function projectSourcesManualLeaseIdentity(
  proof: ProjectSourcesManualCleanupProof,
): BrowserTabLeaseIdentity {
  return {
    id: proof.lease.id,
    sessionId: proof.storageOwnerId,
    generationId: proof.generationId,
    profileDirectory: proof.profileDirectory,
  };
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
  const admittedOwner = parseManualOwner(candidate.owner);
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

function manualAdmissionPreparationPath(
  expectedPath: string,
  proof: ProjectSourcesManualCleanupProof,
): string {
  if (!UUID_PATTERN.test(proof.admission.token)) {
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
  const before = captureMarkerFileIdentity(beforeStats);
  const parsed: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
  const afterStats = await lstat(receiptPath, { bigint: true });
  const after = captureMarkerFileIdentity(afterStats);
  if (
    (requireSingleLink && afterStats.nlink !== 1n) ||
    !sameMarkerFileIdentity(before, after) ||
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
  await beforeManualAdmissionPublicationForTest?.(preparationPath);
  try {
    await link(preparationPath, expectedPath);
    await syncDirectory(storage.root.canonicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await beforeManualAdmissionPreparationCleanupForTest?.(preparationPath);
  await removePublishedManualAdmissionPreparation(preparationPath, proof, storage, owner);
  return await authenticateManualAdmissionReceipt(expectedPath, proof, owner, true);
}

export const __test__ = {
  manualAdmissionPreparationPath,
  setBeforeManualAdmissionPublication(
    callback: ((preparationPath: string) => void | Promise<void>) | undefined,
  ): void {
    beforeManualAdmissionPublicationForTest = callback;
  },
  setBeforeManualAdmissionPreparationCleanup(
    callback: ((preparationPath: string) => void | Promise<void>) | undefined,
  ): void {
    beforeManualAdmissionPreparationCleanupForTest = callback;
  },
};

export async function authenticateProjectSourcesManualAdmission(
  proof: ProjectSourcesManualCleanupProof,
  storage: ProjectSourcesCleanupStorage,
  owner: OracleChromeOwnerRecord,
  options: { create?: boolean } = {},
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
    ? await publishManualAdmissionReceipt(expectedPath, proof, storage, owner)
    : await authenticateManualAdmissionReceipt(expectedPath, proof, owner, true);
  if (proof.admission.identity && !sameMarkerFileIdentity(identity, proof.admission.identity)) {
    throw new Error("Project Sources manual admission receipt changed or mismatched.");
  }
  return {
    ...proof,
    admission: { ...proof.admission, identity },
    owner,
    authenticated: true,
  };
}

export async function removeProjectSourcesCleanupProofArtifacts(
  proof: ProjectSourcesCleanupProof,
  storage: ProjectSourcesCleanupStorage,
): Promise<void> {
  if (
    proof.kind !== "manual-login" ||
    !proof.owner ||
    !proof.authenticated ||
    !proof.admission.identity
  )
    return;
  await authenticateProjectSourcesManualAdmission(proof, storage, proof.owner);
  await rm(proof.admission.path);
  await syncDirectory(storage.root.canonicalPath);
}

async function assertManualProof(
  runtime: BrowserRuntimeMetadata,
  proof: ProjectSourcesManualCleanupProof,
  storage: ProjectSourcesCleanupStorage,
  deps: ProjectSourcesAuthorityDeps,
): Promise<void> {
  if (proof.storageOwnerId !== projectSourcesCleanupOwnerId(storage)) {
    throw new Error("Project Sources manual proof has different cleanup storage.");
  }
  const currentProfile = await captureProfileDirectoryIdentity(proof.userDataDir);
  if (!sameProfileDirectoryIdentity(currentProfile, proof.profileDirectory)) {
    throw new Error("Project Sources manual profile physical authority changed.");
  }
  const requiresOwnedEffects = (runtime.recoveryCleanupResources ?? []).some(
    (resource) =>
      Boolean(resource.chromeProcessIdentity) ||
      resource.recoveryCleanup.ownsTarget ||
      resource.acquisition?.pendingResource === "chrome-target",
  );
  if (requiresOwnedEffects && (!proof.authenticated || !proof.owner || !proof.admission.identity)) {
    throw new Error(
      "Project Sources manual cleanup has no authenticated lease/owner admission receipt.",
    );
  }
  if (proof.authenticated && proof.owner && proof.admission.identity) {
    await authenticateProjectSourcesManualAdmission(proof, storage, proof.owner);
  }
  if (proof.lease.state === "pending") {
    throw new Error("Project Sources manual lease acquisition is still unresolved.");
  }
  if (proof.lease.state === "active") {
    const hasLease = await (deps.hasExactBrowserTabLease ?? hasExactBrowserTabLease)(
      proof.userDataDir,
      projectSourcesManualLeaseIdentity(proof),
    );
    if (!hasLease)
      throw new Error("Project Sources manual cleanup exact lease evidence is unavailable.");
    if (proof.owner) {
      const owner = await (deps.readOracleChromeOwner ?? readOracleChromeOwner)(proof.userDataDir);
      if (!owner || !sameProjectSourcesManualOwner(owner, proof.owner)) {
        throw new Error("Project Sources manual cleanup owner-registry evidence changed.");
      }
    }
  }
}

export async function assertProjectSourcesCleanupProof(
  runtime: BrowserRuntimeMetadata,
  proof: ProjectSourcesCleanupProof,
  storage: ProjectSourcesCleanupStorage,
  deps: ProjectSourcesAuthorityDeps = {},
): Promise<void> {
  if (!hasOwnedProjectSourcesProvenance(runtime, proof)) {
    throw new Error("Project Sources cleanup runtime does not match its exact durable proof.");
  }
  if (proof.kind === "temporary") await assertProjectSourcesTemporaryProof(proof, storage);
  else await assertManualProof(runtime, proof, storage, deps);
}

export async function updateProjectSourcesCleanupProofForPersistence(
  runtime: BrowserRuntimeMetadata,
  proof: ProjectSourcesCleanupProof,
  storage: ProjectSourcesCleanupStorage,
  deps: ProjectSourcesAuthorityDeps = {},
): Promise<ProjectSourcesCleanupProof> {
  if (!hasProjectSourcesCleanupAuthority(runtime)) return proof;
  if (proof.kind === "temporary") {
    await assertProjectSourcesTemporaryProof(proof, storage);
    return proof;
  }
  const resource = runtime.recoveryCleanupResources?.[0];
  if (!resource) return proof;
  let next = proof;
  if (
    next.lease.state === "pending" &&
    resource.tabLease &&
    resource.acquisition?.pendingResource !== "tab-lease"
  ) {
    const active = await (deps.hasExactBrowserTabLease ?? hasExactBrowserTabLease)(
      next.userDataDir,
      projectSourcesManualLeaseIdentity(next),
    );
    if (!active) throw new Error("Project Sources manual lease acquisition was not recorded.");
    next = { ...next, lease: { ...next.lease, state: "active" } };
  }
  if (resource.chromeProcessIdentity) {
    const owner =
      next.owner ?? (await (deps.readOracleChromeOwner ?? readOracleChromeOwner)(next.userDataDir));
    if (
      !owner ||
      !sameChromeProcessIdentity(owner.processIdentity, resource.chromeProcessIdentity) ||
      !sameProfileDirectoryIdentity(
        owner.processIdentity.profileDirectory,
        next.profileDirectory,
      ) ||
      owner.disposition !== resource.acquisition?.processOwnerDisposition
    ) {
      throw new Error("Project Sources manual owner-registry evidence does not match acquisition.");
    }
    if (!next.authenticated) {
      if (next.lease.state !== "active") {
        throw new Error("Project Sources manual owner appeared without an active exact lease.");
      }
      const active = await (deps.hasExactBrowserTabLease ?? hasExactBrowserTabLease)(
        next.userDataDir,
        projectSourcesManualLeaseIdentity(next),
      );
      if (!active) throw new Error("Project Sources manual admission has no active exact lease.");
      next = await authenticateProjectSourcesManualAdmission({ ...next, owner }, storage, owner, {
        create: true,
      });
    } else {
      next = await authenticateProjectSourcesManualAdmission(next, storage, owner);
    }
  }
  if (next.lease.state === "active" && !resource.tabLease) {
    next = { ...next, lease: { ...next.lease, state: "released" } };
  }
  if (!hasOwnedProjectSourcesProvenance(runtime, next)) {
    throw new Error("Project Sources cleanup persistence would break its exact proof binding.");
  }
  return next;
}
