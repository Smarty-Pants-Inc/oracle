import path from "node:path";
import { lstat, open, readFile, stat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { readErrorCode, syncDirectory } from "./filesystemLockIo.js";
import { arePlatformProcessGenerationsDefinitelyDifferent } from "./platformProcessGeneration.js";
import {
  capturePhysicalDirectoryIdentity,
  physicalDirectoryIdentityFromStats,
  samePhysicalDirectoryIdentity,
} from "./filesystemLockDirectoryIdentity.js";
import type { PhysicalDirectoryIdentity } from "./filesystemLockDirectoryIdentity.js";

export const LOCK_OWNER_FILENAME = "owner.json";
export const LOCK_MUTATION_DIRECTORY_SUFFIX = ".mutations";

export type ProcessLiveness = "alive" | "dead" | "unknown";

export interface FilesystemLockOwnerRecord {
  version: 1;
  pid: number;
  processStartIdentity: string | null;
  ownerNonce: string;
  createdAt: string;
  sessionId?: string;
}

export type FilesystemLockDirectoryIdentity = PhysicalDirectoryIdentity;

export interface FilesystemLockGeneration {
  ownerRaw: string | null;
  directoryIdentity?: FilesystemLockDirectoryIdentity;
  lastMutationMs?: number;
  legacyFile?: {
    raw: string;
    device: string;
    inode: string;
    birthtimeNs: string;
    size: string;
  };
}

export type FilesystemLockInspection =
  | { status: "active"; owner?: FilesystemLockOwnerRecord }
  | { status: "stale"; generation: FilesystemLockGeneration };

export function canonicalFilesystemLockPath(lockPath: string): string {
  return path.resolve(lockPath);
}

export function filesystemLockReleaseKey(
  lockPath: string,
  generation: {
    pid: number;
    processStartIdentity: string | null;
    ownerNonce: string;
    createdAt?: string;
    sessionId?: string;
  },
): string {
  return JSON.stringify([
    canonicalFilesystemLockPath(lockPath),
    generation.pid,
    generation.processStartIdentity,
    generation.ownerNonce,
    generation.createdAt ?? null,
    generation.sessionId ?? null,
  ]);
}

export async function inspectExistingLock(
  lockPath: string,
  options: {
    nowMs: number;
    incompleteLockStaleMs: number;
    readLiveness: (pid: number) => ProcessLiveness;
    readProcessIdentity: (pid: number) => Promise<string | null>;
  },
): Promise<FilesystemLockInspection> {
  let lockEntry: BigIntStats;
  try {
    lockEntry = await lstat(lockPath, { bigint: true });
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      return { status: "stale", generation: { ownerRaw: null, lastMutationMs: 0 } };
    }
    throw error;
  }
  if (!lockEntry.isDirectory()) {
    if (!lockEntry.isFile() || lockEntry.isSymbolicLink()) return { status: "active" };
    return inspectLegacyFilesystemLockFile(lockPath, lockEntry, options.readLiveness);
  }

  const directoryIdentity = physicalDirectoryIdentityFromStats(lockEntry);
  const verifiedStaleGeneration = async (
    ownerRaw: string | null,
    lastMutationMs?: number,
  ): Promise<FilesystemLockInspection> => {
    let currentIdentity: FilesystemLockDirectoryIdentity;
    try {
      currentIdentity = await capturePhysicalDirectoryIdentity(lockPath);
    } catch {
      return { status: "active" };
    }
    return samePhysicalDirectoryIdentity(currentIdentity, directoryIdentity)
      ? {
          status: "stale",
          generation: {
            ownerRaw,
            directoryIdentity,
            ...(lastMutationMs === undefined ? {} : { lastMutationMs }),
          },
        }
      : { status: "active" };
  };

  let raw: string | null = null;
  try {
    raw = await readFile(path.join(lockPath, LOCK_OWNER_FILENAME), "utf8");
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") return { status: "active" };
  }

  if (raw !== null) {
    const owner = parseLockOwner(raw);
    if (owner) {
      const liveness = options.readLiveness(owner.pid);
      if (liveness === "dead") return verifiedStaleGeneration(raw);
      if (liveness === "unknown") return { status: "active", owner };
      if (owner.processStartIdentity !== null) {
        const observedIdentity = await options.readProcessIdentity(owner.pid);
        if (
          observedIdentity !== null &&
          arePlatformProcessGenerationsDefinitelyDifferent(
            owner.processStartIdentity,
            observedIdentity,
          )
        ) {
          return verifiedStaleGeneration(raw);
        }
      }
      return { status: "active", owner };
    }

    const partialOwner = parsePartialLockOwner(raw);
    if (partialOwner) {
      const liveness = options.readLiveness(partialOwner.pid);
      if (liveness === "unknown") return { status: "active" };
      if (liveness === "alive") {
        const observedIdentity = await options.readProcessIdentity(partialOwner.pid);
        if (
          partialOwner.processStartIdentity === undefined ||
          partialOwner.processStartIdentity === null ||
          observedIdentity === null ||
          !arePlatformProcessGenerationsDefinitelyDifferent(
            partialOwner.processStartIdentity,
            observedIdentity,
          )
        ) {
          return { status: "active" };
        }
      }
    }
  }

  const lastMutationMs = await readLockLastMutationMs(lockPath);
  return options.nowMs - lastMutationMs >= options.incompleteLockStaleMs
    ? verifiedStaleGeneration(raw, lastMutationMs)
    : { status: "active" };
}
interface LegacyFilesystemLockRecord {
  readonly pid: number;
  readonly lockId: string;
  readonly createdAt: string;
  readonly sessionId?: string;
}

async function inspectLegacyFilesystemLockFile(
  lockPath: string,
  initialEntry: BigIntStats,
  readLiveness: (pid: number) => ProcessLiveness,
): Promise<FilesystemLockInspection> {
  let raw: string;
  let after: BigIntStats;
  try {
    raw = await readFile(lockPath, "utf8");
    after = await lstat(lockPath, { bigint: true });
  } catch {
    return { status: "active" };
  }
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    initialEntry.dev !== after.dev ||
    initialEntry.ino !== after.ino ||
    initialEntry.birthtimeNs !== after.birthtimeNs ||
    initialEntry.ctimeNs !== after.ctimeNs ||
    initialEntry.size !== after.size
  ) {
    return { status: "active" };
  }
  const legacy = parseLegacyFilesystemLockRecord(raw);
  if (legacy === null || readLiveness(legacy.pid) !== "dead") return { status: "active" };
  return {
    status: "stale",
    generation: {
      ownerRaw: null,
      legacyFile: {
        raw,
        device: after.dev.toString(),
        inode: after.ino.toString(),
        birthtimeNs: after.birthtimeNs.toString(),
        size: after.size.toString(),
      },
    },
  };
}

function parseLegacyFilesystemLockRecord(raw: string): LegacyFilesystemLockRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  if (
    (keys !== "createdAt,lockId,pid" && keys !== "createdAt,lockId,pid,sessionId") ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.lockId !== "string" ||
    value.lockId.length === 0 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    (value.sessionId !== undefined &&
      (typeof value.sessionId !== "string" || value.sessionId.length === 0))
  ) {
    return null;
  }
  return {
    pid: value.pid,
    lockId: value.lockId,
    createdAt: value.createdAt,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
  };
}

async function readLockLastMutationMs(lockPath: string): Promise<number> {
  try {
    const [lockStats, ownerStats] = await Promise.all([
      stat(lockPath),
      stat(path.join(lockPath, LOCK_OWNER_FILENAME)).catch(() => null),
    ]);
    return Math.max(lockStats.mtimeMs, ownerStats?.mtimeMs ?? 0);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return 0;
    throw error;
  }
}

export async function lockGenerationMatches(
  lockPath: string,
  expectedGeneration: FilesystemLockGeneration,
): Promise<boolean> {
  if (expectedGeneration.legacyFile !== undefined) {
    return legacyFilesystemLockGenerationMatches(lockPath, expectedGeneration.legacyFile);
  }
  if (expectedGeneration.directoryIdentity === undefined) return false;

  let before: FilesystemLockDirectoryIdentity;
  let ownerRaw: string | null = null;
  let after: FilesystemLockDirectoryIdentity;
  try {
    before = await capturePhysicalDirectoryIdentity(lockPath);
    try {
      ownerRaw = await readFile(path.join(lockPath, LOCK_OWNER_FILENAME), "utf8");
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") throw error;
    }
    after = await capturePhysicalDirectoryIdentity(lockPath);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return false;
    throw error;
  }
  if (
    !samePhysicalDirectoryIdentity(before, expectedGeneration.directoryIdentity) ||
    !samePhysicalDirectoryIdentity(after, expectedGeneration.directoryIdentity)
  ) {
    return false;
  }

  const expectedOwner =
    expectedGeneration.ownerRaw === null ? null : parseLockOwner(expectedGeneration.ownerRaw);
  const observedOwner = ownerRaw === null ? null : parseLockOwner(ownerRaw);
  if (expectedOwner || observedOwner) {
    return (
      expectedOwner !== null &&
      observedOwner !== null &&
      sameLockOwner(expectedOwner, observedOwner)
    );
  }
  if (ownerRaw !== expectedGeneration.ownerRaw) return false;
  if (expectedGeneration.lastMutationMs === undefined) return true;
  return (await readLockLastMutationMs(lockPath)) === expectedGeneration.lastMutationMs;
}
export async function legacyFilesystemLockGenerationMatches(
  lockPath: string,
  expected: NonNullable<FilesystemLockGeneration["legacyFile"]>,
): Promise<boolean> {
  let before: BigIntStats;
  let raw: string;
  let after: BigIntStats;
  try {
    before = await lstat(lockPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) return false;
    raw = await readFile(lockPath, "utf8");
    after = await lstat(lockPath, { bigint: true });
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return false;
    throw error;
  }
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.birthtimeNs === after.birthtimeNs &&
    before.ctimeNs === after.ctimeNs &&
    before.size === after.size &&
    raw === expected.raw &&
    after.dev.toString() === expected.device &&
    after.ino.toString() === expected.inode &&
    after.birthtimeNs.toString() === expected.birthtimeNs &&
    after.size.toString() === expected.size
  );
}
export function sameLockOwner(
  left: FilesystemLockOwnerRecord,
  right: FilesystemLockOwnerRecord,
): boolean {
  return (
    left.pid === right.pid &&
    left.processStartIdentity === right.processStartIdentity &&
    left.ownerNonce === right.ownerNonce &&
    left.createdAt === right.createdAt &&
    left.sessionId === right.sessionId
  );
}

export function encodeFilesystemLockOwner(owner: FilesystemLockOwnerRecord): string {
  return `${JSON.stringify(owner)}\n`;
}

export async function writeLockOwner(
  lockPath: string,
  owner: FilesystemLockOwnerRecord,
): Promise<void> {
  const ownerPath = path.join(lockPath, LOCK_OWNER_FILENAME);
  const handle = await open(ownerPath, "wx", 0o600);
  try {
    await handle.writeFile(encodeFilesystemLockOwner(owner), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(lockPath);
  await syncDirectory(path.dirname(lockPath));
}

export async function readLockOwnerGenerationForRelease(
  lockPath: string,
): Promise<{ owner: FilesystemLockOwnerRecord; generation: FilesystemLockGeneration } | null> {
  let captured: { ownerRaw: string; directoryIdentity: FilesystemLockDirectoryIdentity };
  try {
    captured = await readStableFilesystemLockDirectoryOwner(lockPath);
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
    try {
      await lstat(lockPath);
    } catch (pathError) {
      if (readErrorCode(pathError) === "ENOENT") return null;
      throw pathError;
    }
    throw new Error(`Invalid filesystem lock owner at ${lockPath}`, { cause: error });
  }
  const owner = parseLockOwner(captured.ownerRaw);
  if (owner === null) throw new Error(`Invalid filesystem lock owner at ${lockPath}`);
  return {
    owner,
    generation: {
      ownerRaw: captured.ownerRaw,
      directoryIdentity: captured.directoryIdentity,
    },
  };
}

export async function readLockOwnerForRelease(
  lockPath: string,
): Promise<FilesystemLockOwnerRecord | null> {
  return (await readLockOwnerGenerationForRelease(lockPath))?.owner ?? null;
}

export function parseLockOwner(raw: string): FilesystemLockOwnerRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<FilesystemLockOwnerRecord>;
    if (parsed.version !== 1) return null;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    if (
      parsed.processStartIdentity !== null &&
      (typeof parsed.processStartIdentity !== "string" || parsed.processStartIdentity.length === 0)
    ) {
      return null;
    }
    if (parsed.sessionId !== undefined && typeof parsed.sessionId !== "string") return null;
    if (typeof parsed.ownerNonce !== "string" || parsed.ownerNonce.length === 0) return null;
    if (typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt))) {
      return null;
    }
    return parsed as FilesystemLockOwnerRecord;
  } catch {
    return null;
  }
}

function parsePartialLockOwner(
  raw: string,
): { pid: number; processStartIdentity?: string | null } | null {
  try {
    const parsed = JSON.parse(raw) as {
      pid?: unknown;
      processStartIdentity?: unknown;
    };
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    const pid = parsed.pid;
    if (
      parsed.processStartIdentity !== undefined &&
      parsed.processStartIdentity !== null &&
      (typeof parsed.processStartIdentity !== "string" || parsed.processStartIdentity.length === 0)
    ) {
      return { pid };
    }
    return {
      pid,
      processStartIdentity: parsed.processStartIdentity as string | null | undefined,
    };
  } catch {
    const pidMatch = raw.match(/"pid"\s*:\s*(\d+)/u);
    if (!pidMatch) return null;
    const pid = Number(pidMatch[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const identityMatch = raw.match(/"processStartIdentity"\s*:\s*(null|"(?:\\.|[^"\\])*")/u);
    if (!identityMatch) return { pid };
    try {
      const processStartIdentity = JSON.parse(identityMatch[1] ?? "null") as unknown;
      return processStartIdentity === null || typeof processStartIdentity === "string"
        ? { pid, processStartIdentity }
        : { pid };
    } catch {
      return { pid };
    }
  }
}

export async function captureFilesystemLockDirectoryGeneration(
  lockPath: string,
  ownerRaw: string,
): Promise<FilesystemLockGeneration> {
  const captured = await readStableFilesystemLockDirectoryOwner(lockPath);
  const expectedOwner = parseLockOwner(ownerRaw);
  const observedOwner = parseLockOwner(captured.ownerRaw);
  if (
    expectedOwner === null ||
    observedOwner === null ||
    !sameLockOwner(expectedOwner, observedOwner)
  ) {
    throw new Error(`Filesystem lock ownership changed at ${lockPath}`);
  }
  return {
    ownerRaw: captured.ownerRaw,
    directoryIdentity: captured.directoryIdentity,
  };
}

async function readStableFilesystemLockDirectoryOwner(
  lockPath: string,
): Promise<{ ownerRaw: string; directoryIdentity: FilesystemLockDirectoryIdentity }> {
  const before = await capturePhysicalDirectoryIdentity(lockPath);
  const ownerRaw = await readFile(path.join(lockPath, LOCK_OWNER_FILENAME), "utf8");
  const after = await capturePhysicalDirectoryIdentity(lockPath);
  if (!samePhysicalDirectoryIdentity(before, after)) {
    throw new Error(`Filesystem lock generation changed while reading its owner at ${lockPath}`);
  }
  return { ownerRaw, directoryIdentity: after };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
