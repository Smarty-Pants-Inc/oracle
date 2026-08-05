import path from "node:path";
import { chmod, mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
import { delay } from "./utils.js";
import {
  canonicalFilesystemLockPath,
  filesystemLockReleaseKey,
} from "./filesystemLockReleaseJournal.js";
import type {
  FilesystemLockGeneration,
  FilesystemLockInspection,
  FilesystemLockMutationLease,
  FilesystemLockMutationOptions,
  FilesystemLockOwnerRecord,
  FilesystemLockReleaseState,
  ProcessLiveness,
} from "./filesystemLock.js";

const LOCK_OWNER_FILENAME = "owner.json";
const LOCK_RELEASE_MUTATION_TIMEOUT_MS = 1_000;
const WINDOWS_LOCK_MUTATION_RETRY_MS = 10;
const WINDOWS_LOCK_MUTATION_TIMEOUT_MS = 1_000;

type AcquireFilesystemLockMutationLease = (
  lockPath: string,
  options: FilesystemLockMutationOptions,
  deadlineMs?: number,
  whileWaiting?: () => Promise<void>,
  deadlineNow?: () => number,
) => Promise<FilesystemLockMutationLease | null>;

export class FilesystemLockReleasePendingError extends Error {
  readonly lockPath: string;
  readonly generationKey?: string;
  readonly retryable = true;

  constructor(lockPath: string, generation?: FilesystemLockOwnerRecord) {
    const canonicalPath = canonicalFilesystemLockPath(lockPath);
    super(`Filesystem lock release at ${canonicalPath} is pending mutation authority`);
    this.name = "FilesystemLockReleasePendingError";
    this.lockPath = canonicalPath;
    this.generationKey = generation
      ? filesystemLockReleaseKey(canonicalPath, generation)
      : undefined;
  }
}
export async function releaseCrashRecoverableFilesystemLock(
  lockPath: string,
  expectedOwner: FilesystemLockOwnerRecord,
  mutationOptions: FilesystemLockMutationOptions,
  state: FilesystemLockReleaseState,
  acquireMutationLease: AcquireFilesystemLockMutationLease,
  beforeReleasedLockRemoval?: (isolatedRootPath: string) => Promise<void>,
): Promise<void> {
  // A post-isolation retry owns only its journaled private root. It must not publish another
  // request doorway or inspect a successor that may already own the canonical lock path.
  if (state.mutationLease === undefined && state.isolatedRemovalRootPath !== undefined) {
    const isolatedRemovalRootPath = state.isolatedRemovalRootPath;
    await beforeReleasedLockRemoval?.(isolatedRemovalRootPath);
    await removeIsolatedDirectoryGeneration(isolatedRemovalRootPath);
    state.isolatedRemovalRootPath = undefined;
    return;
  }

  if (state.mutationLease === undefined) {
    const rejectChangedOwner = async (): Promise<void> => {
      const owner = await readLockOwnerForRelease(lockPath);
      if (owner !== null && !sameLockOwner(owner, expectedOwner)) {
        throw new Error(`Filesystem lock ownership changed at ${lockPath}`);
      }
    };
    // A live but stalled queue head must project retryable release authority instead of pinning
    // controller shutdown forever. The lock object retains all state for a later release retry.
    const mutationDeadlineMs = Date.now() + LOCK_RELEASE_MUTATION_TIMEOUT_MS;
    const mutationLease = await acquireMutationLease(
      lockPath,
      mutationOptions,
      mutationDeadlineMs,
      rejectChangedOwner,
      Date.now,
    );
    if (mutationLease === null) {
      throw new FilesystemLockReleasePendingError(lockPath, expectedOwner);
    }
    state.mutationLease = mutationLease;
  }

  if (!state.canonicalReleased) {
    try {
      const owner = await readLockOwnerForRelease(lockPath);
      if (owner === null) {
        state.canonicalReleased = true;
      } else {
        if (!sameLockOwner(owner, expectedOwner)) {
          throw new Error(`Filesystem lock ownership changed at ${lockPath}`);
        }

        const releasedPath = `${lockPath}.released-${expectedOwner.ownerNonce}`;
        try {
          await renameLockPath(lockPath, releasedPath);
          state.canonicalReleased = true;
          state.detachedPath = releasedPath;
        } catch (error) {
          if (readErrorCode(error) !== "ENOENT") throw error;
          state.canonicalReleased = true;
        }
      }
    } catch (error) {
      const mutationLease = state.mutationLease;
      try {
        await mutationLease.release();
        state.mutationLease = undefined;
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Filesystem lock release failed before canonical removal at ${lockPath}`,
        );
      }
      throw error;
    }
  }

  if (state.isolatedRemovalRootPath === undefined && state.detachedPath !== undefined) {
    const detachedPath = state.detachedPath;
    const releasedGeneration: FilesystemLockGeneration = {
      ownerRaw: `${JSON.stringify(expectedOwner)}\n`,
    };
    const isolation = await isolateDirectoryGenerationForRemoval(detachedPath, (generationPath) =>
      lockGenerationMatches(generationPath, releasedGeneration),
    );
    if (isolation.status === "missing") {
      state.detachedPath = undefined;
    } else if (isolation.status === "changed") {
      try {
        await renameLockPath(detachedPath, lockPath);
        await syncDirectory(path.dirname(lockPath));
      } catch (restoreError) {
        throw new Error(
          `Filesystem lock ownership changed at ${lockPath}; unexpected lock preserved at ${detachedPath}`,
          { cause: restoreError },
        );
      }
      state.detachedPath = undefined;
      state.canonicalReleased = false;
      const error = new Error(`Filesystem lock ownership changed at ${lockPath}`);
      const mutationLease = state.mutationLease;
      try {
        await mutationLease.release();
        state.mutationLease = undefined;
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Filesystem lock ownership changed and mutation cleanup failed at ${lockPath}`,
        );
      }
      throw error;
    } else {
      state.detachedPath = undefined;
      state.isolatedRemovalRootPath = isolation.rootPath;
    }
  }

  // Isolation is the authority cutover: hide the public mutation request before fallible garbage
  // collection, leaving only the recorded private root for an idempotent retry.
  const mutationLease = state.mutationLease;
  if (mutationLease !== undefined) {
    await mutationLease.release();
    state.mutationLease = undefined;
  }

  if (state.isolatedRemovalRootPath !== undefined) {
    const isolatedRemovalRootPath = state.isolatedRemovalRootPath;
    await beforeReleasedLockRemoval?.(isolatedRemovalRootPath);
    await removeIsolatedDirectoryGeneration(isolatedRemovalRootPath);
    state.isolatedRemovalRootPath = undefined;
  }
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
  // A file-shaped legacy/corrupt lock has no generation nonce to verify after a move.
  // Preserve it instead of deleting an unreadable or replacement generation by pathname.
  try {
    if (!(await stat(lockPath)).isDirectory()) return { status: "active" };
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      return { status: "stale", generation: { ownerRaw: null, lastMutationMs: 0 } };
    }
    throw error;
  }
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
      if (liveness === "dead") return { status: "stale", generation: { ownerRaw: raw } };
      if (liveness === "unknown") return { status: "active", owner };
      if (owner.processStartIdentity !== null) {
        const observedIdentity = await options.readProcessIdentity(owner.pid);
        if (observedIdentity !== null && owner.processStartIdentity !== observedIdentity) {
          return { status: "stale", generation: { ownerRaw: raw } };
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
          partialOwner.processStartIdentity === observedIdentity
        ) {
          return { status: "active" };
        }
      }
    }
  }

  const lastMutationMs = await readLockLastMutationMs(lockPath);
  return options.nowMs - lastMutationMs >= options.incompleteLockStaleMs
    ? { status: "stale", generation: { ownerRaw: raw, lastMutationMs } }
    : { status: "active" };
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

export async function quarantineStaleLock(
  lockPath: string,
  nonce: string,
  expectedGeneration: FilesystemLockGeneration,
  afterQuarantine?: (quarantinedLockPath: string) => Promise<void>,
): Promise<boolean> {
  const stalePath = `${lockPath}.stale-${nonce}`;
  try {
    await renameLockPath(lockPath, stalePath);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return false;
    throw error;
  }
  await syncDirectory(path.dirname(lockPath));
  try {
    await afterQuarantine?.(stalePath);
  } catch (error) {
    await restoreUnexpectedLockGeneration(lockPath, stalePath);
    throw error;
  }

  let generationMatches: boolean;
  try {
    generationMatches = await lockGenerationMatches(stalePath, expectedGeneration);
  } catch (error) {
    await restoreUnexpectedLockGeneration(lockPath, stalePath);
    throw error;
  }
  if (!generationMatches) {
    await restoreUnexpectedLockGeneration(lockPath, stalePath);
    return false;
  }

  const isolation = await isolateDirectoryGenerationForRemoval(stalePath, (generationPath) =>
    lockGenerationMatches(generationPath, expectedGeneration),
  );
  if (isolation.status === "missing") return false;
  if (isolation.status === "changed") {
    await restoreUnexpectedLockGeneration(lockPath, stalePath);
    return false;
  }
  await removeIsolatedDirectoryGeneration(isolation.rootPath);
  return true;
}

export async function lockGenerationMatches(
  lockPath: string,
  expectedGeneration: FilesystemLockGeneration,
): Promise<boolean> {
  let ownerRaw: string | null = null;
  try {
    ownerRaw = await readFile(path.join(lockPath, LOCK_OWNER_FILENAME), "utf8");
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
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

async function restoreUnexpectedLockGeneration(
  lockPath: string,
  quarantinedPath: string,
): Promise<void> {
  try {
    await renameLockPath(quarantinedPath, lockPath);
    await syncDirectory(path.dirname(lockPath));
  } catch (error) {
    throw new Error(
      `Filesystem lock generation changed at ${lockPath}; unexpected lock preserved at ${quarantinedPath}`,
      { cause: error },
    );
  }
}

function sameLockOwner(left: FilesystemLockOwnerRecord, right: FilesystemLockOwnerRecord): boolean {
  return (
    left.pid === right.pid &&
    left.processStartIdentity === right.processStartIdentity &&
    left.ownerNonce === right.ownerNonce &&
    left.createdAt === right.createdAt &&
    left.sessionId === right.sessionId
  );
}

export async function writeLockOwner(
  lockPath: string,
  owner: FilesystemLockOwnerRecord,
): Promise<void> {
  const ownerPath = path.join(lockPath, LOCK_OWNER_FILENAME);
  const handle = await open(ownerPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(lockPath);
  await syncDirectory(path.dirname(lockPath));
}

async function readLockOwnerForRelease(
  lockPath: string,
): Promise<FilesystemLockOwnerRecord | null> {
  try {
    return await readLockOwnerStrict(lockPath);
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
    try {
      await stat(lockPath);
    } catch (pathError) {
      if (readErrorCode(pathError) === "ENOENT") return null;
      throw pathError;
    }
    throw new Error(`Invalid filesystem lock owner at ${lockPath}`, { cause: error });
  }
}

async function readLockOwnerStrict(lockPath: string): Promise<FilesystemLockOwnerRecord> {
  const owner = parseLockOwner(await readFile(path.join(lockPath, LOCK_OWNER_FILENAME), "utf8"));
  if (!owner) throw new Error(`Invalid filesystem lock owner at ${lockPath}`);
  return owner;
}

function parseLockOwner(raw: string): FilesystemLockOwnerRecord | null {
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

// Public quarantine names are never recursively deleted. Move the candidate into a fresh,
// mode-restricted removal root, then verify the moved generation. After this handoff callers
// delete only the exclusively owned root, so replacement of the former quarantine name is inert.
export async function isolateDirectoryGenerationForRemoval(
  candidatePath: string,
  verifyGeneration: (generationPath: string) => Promise<boolean>,
): Promise<
  | { status: "isolated"; rootPath: string; generationPath: string }
  | { status: "missing" }
  | { status: "changed" }
> {
  const parentPath = path.dirname(candidatePath);
  const rootPath = await mkdtemp(path.join(parentPath, ".oracle-remove-"));
  try {
    await chmod(rootPath, 0o700);
  } catch (error) {
    await removeLockPath(rootPath);
    throw error;
  }
  const generationPath = path.join(rootPath, "generation");
  try {
    await renameLockPath(candidatePath, generationPath);
  } catch (error) {
    await removeLockPath(rootPath);
    if (readErrorCode(error) === "ENOENT") return { status: "missing" };
    throw error;
  }
  try {
    await syncDirectory(rootPath);
    await syncDirectory(parentPath);
  } catch (error) {
    await restoreIsolatedDirectoryGeneration(candidatePath, rootPath, generationPath);
    throw error;
  }

  let matches: boolean;
  try {
    matches = await verifyGeneration(generationPath);
  } catch (error) {
    await restoreIsolatedDirectoryGeneration(candidatePath, rootPath, generationPath);
    throw error;
  }
  if (!matches) {
    await restoreIsolatedDirectoryGeneration(candidatePath, rootPath, generationPath);
    return { status: "changed" };
  }
  return { status: "isolated", rootPath, generationPath };
}

export async function removeIsolatedDirectoryGeneration(rootPath: string): Promise<void> {
  await removeLockPath(rootPath);
  await syncDirectoryIfPresent(path.dirname(rootPath));
}

async function restoreIsolatedDirectoryGeneration(
  candidatePath: string,
  rootPath: string,
  generationPath: string,
): Promise<void> {
  try {
    await renameLockPath(generationPath, candidatePath);
    await syncDirectory(path.dirname(candidatePath));
  } catch (error) {
    throw new Error(
      `Filesystem generation changed at ${candidatePath}; unexpected directory preserved at ${generationPath}`,
      { cause: error },
    );
  }
  await removeLockPath(rootPath);
  await syncDirectoryIfPresent(path.dirname(rootPath));
}

export async function renameLockPath(sourcePath: string, destinationPath: string): Promise<void> {
  const deadline = Date.now() + WINDOWS_LOCK_MUTATION_TIMEOUT_MS;
  for (;;) {
    try {
      await rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (!isRetryableWindowsLockMutationError(error) || Date.now() >= deadline) throw error;
    }
    await delay(Math.min(WINDOWS_LOCK_MUTATION_RETRY_MS, Math.max(1, deadline - Date.now())));
  }
}

export async function removeLockPath(lockPath: string): Promise<void> {
  await rm(lockPath, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: WINDOWS_LOCK_MUTATION_RETRY_MS,
  });
}

function isRetryableWindowsLockMutationError(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = readErrorCode(error);
  return code === "EACCES" || code === "EBUSY" || code === "EPERM";
}

export async function syncDirectoryIfPresent(directory: string): Promise<void> {
  try {
    await syncDirectory(directory);
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function readErrorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}
