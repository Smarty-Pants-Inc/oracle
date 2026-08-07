import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { BigIntStats } from "node:fs";
import {
  parsePhysicalFileSnapshot,
  physicalFileSnapshotFromStats,
  samePhysicalFileSnapshot,
  type PhysicalFileSnapshot,
} from "../physicalFileIdentity.js";
import type { WindowsPrivateDirectoryAuthority } from "../windowsPrivateFileAcl.js";
import type { PrivateDirectoryAuthority, TemporaryProfileAuthority } from "../privateTempRoot.js";
import { parseTemporaryProfileAuthority } from "../privateTempRoot.js";
import {
  parseOracleChromeOwnerRecord,
  parseProfileDirectoryIdentity,
  sameProfileDirectoryIdentity,
  sameProfileDirectoryPath,
  type OracleChromeOwnerRecord,
  type ProfileDirectoryIdentity,
} from "./profileState.js";
import type { BrowserTabLeaseIdentity } from "./tabLeaseRegistry.js";

export const PROJECT_SOURCES_PROFILE_MARKER = ".oracle-project-sources-authority.json";
export const PROJECT_SOURCES_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ProjectSourcesMarkerFileIdentity extends PhysicalFileSnapshot {
  readonly mode: string;
  readonly size: string;
}

export interface ProjectSourcesTemporaryMarkerProof {
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
  readonly windowsPrivateDirectoryAuthority?: WindowsPrivateDirectoryAuthority;
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

export function projectSourcesMarkerFileIdentityFromStats(
  entry: BigIntStats,
): ProjectSourcesMarkerFileIdentity {
  if (!entry.isFile()) throw new Error("Project Sources profile authority marker is not a file.");
  return {
    ...physicalFileSnapshotFromStats(entry),
    mode: entry.mode.toString(),
    size: entry.size.toString(),
  };
}

export function sameProjectSourcesMarkerFileIdentity(
  left: ProjectSourcesMarkerFileIdentity,
  right: ProjectSourcesMarkerFileIdentity,
): boolean {
  return (
    samePhysicalFileSnapshot(left, right) && left.mode === right.mode && left.size === right.size
  );
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
  if (!PROJECT_SOURCES_UUID_PATTERN.test(generationId)) {
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
  if (
    !sameProfileDirectoryPath(
      userDataDir,
      profileDirectory.canonicalPath,
      profileDirectory.platform,
    )
  ) {
    throw new Error("Project Sources manual profile path does not match its physical authority.");
  }
  return {
    version: 1,
    kind: "manual-login",
    storageOwnerId: projectSourcesCleanupOwnerId(storage),
    generationId,
    userDataDir: profileDirectory.canonicalPath,
    profileDirectory,
    lease: { id: leaseId, generationId, state: "pending" },
    admission: {
      path: path.join(storage.root.canonicalPath, `project-sources-admission-${generationId}.json`),
      token: randomUUID(),
    },
  };
}

export function projectSourcesTemporaryMarkerPath(userDataDir: string): string {
  return path.join(userDataDir, PROJECT_SOURCES_PROFILE_MARKER);
}

export function parseProjectSourcesMarkerFileIdentity(
  value: unknown,
): ProjectSourcesMarkerFileIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(",") !== "birthtimeNs,ctimeNs,device,inode,mode,size" ||
    typeof candidate.mode !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(candidate.mode) ||
    typeof candidate.size !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(candidate.size)
  ) {
    return null;
  }
  const snapshot = parsePhysicalFileSnapshot({
    device: candidate.device,
    inode: candidate.inode,
    birthtimeNs: candidate.birthtimeNs,
    ctimeNs: candidate.ctimeNs,
  });
  return snapshot ? { ...snapshot, mode: candidate.mode, size: candidate.size } : null;
}

export function parseProjectSourcesManualOwner(value: unknown): OracleChromeOwnerRecord | null {
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
  const markerIdentity = parseProjectSourcesMarkerFileIdentity(marker?.identity);
  if (
    Object.keys(candidate).sort().join(",") !==
      "approvedBase,generationId,kind,marker,profileDirectory,storageOwnerId,temporaryProfileAuthority,userDataDir,version" ||
    candidate.version !== 1 ||
    candidate.kind !== "temporary" ||
    typeof candidate.storageOwnerId !== "string" ||
    typeof candidate.generationId !== "string" ||
    !PROJECT_SOURCES_UUID_PATTERN.test(candidate.generationId) ||
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
    marker.path !== projectSourcesTemporaryMarkerPath(candidate.userDataDir) ||
    typeof marker.token !== "string" ||
    !PROJECT_SOURCES_UUID_PATTERN.test(marker.token) ||
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
      path: marker.path as string,
      token: marker.token as string,
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
  const admissionIdentity = parseProjectSourcesMarkerFileIdentity(admission?.identity);
  const owner =
    candidate.owner === undefined ? undefined : parseProjectSourcesManualOwner(candidate.owner);
  if (
    candidate.version !== 1 ||
    candidate.kind !== "manual-login" ||
    typeof candidate.storageOwnerId !== "string" ||
    !PROJECT_SOURCES_UUID_PATTERN.test(String(candidate.generationId)) ||
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
    !PROJECT_SOURCES_UUID_PATTERN.test(admission.token) ||
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
    PROJECT_SOURCES_UUID_PATTERN.test(String(candidate.generationId)) &&
    typeof candidate.storageOwnerId === "string" &&
    PROJECT_SOURCES_UUID_PATTERN.test(String(candidate.markerToken)) &&
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
