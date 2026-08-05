import path from "node:path";
import { unlink } from "node:fs/promises";
import {
  isolateDirectoryGenerationForRemoval,
  removeIsolatedDirectoryGeneration,
} from "./filesystemLockDirectoryRemoval.js";
import {
  acquireFilesystemLockMutationLease,
  type FilesystemLockMutationLease,
  type FilesystemLockMutationOptions,
} from "./filesystemLockMutationLease.js";
import {
  canonicalFilesystemLockPath,
  filesystemLockReleaseKey,
  legacyFilesystemLockGenerationMatches,
  lockGenerationMatches,
  readLockOwnerForRelease,
  readLockOwnerGenerationForRelease,
  sameLockOwner,
  type FilesystemLockGeneration,
  type FilesystemLockOwnerRecord,
} from "./filesystemLockModel.js";
import { readErrorCode, renameLockPath, syncDirectory } from "./filesystemLockIo.js";

const LOCK_RELEASE_MUTATION_TIMEOUT_MS = 1_000;

export interface FilesystemLockReleaseState {
  mutationLease?: FilesystemLockMutationLease;
  expectedGeneration: FilesystemLockGeneration;
  detachedPath?: string;
  detachedGeneration?: FilesystemLockGeneration;
  isolatedRemovalRootPath?: string;
  canonicalReleased: boolean;
}

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
    const mutationLease = await acquireFilesystemLockMutationLease(
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
      const ownedGeneration = await readLockOwnerGenerationForRelease(lockPath);
      if (ownedGeneration === null) {
        state.canonicalReleased = true;
      } else {
        if (!sameLockOwner(ownedGeneration.owner, expectedOwner)) {
          throw new Error(`Filesystem lock ownership changed at ${lockPath}`);
        }
        if (!(await lockGenerationMatches(lockPath, state.expectedGeneration))) {
          throw new Error(`Filesystem lock generation changed at ${lockPath}`);
        }

        const releasedPath = `${lockPath}.released-${expectedOwner.ownerNonce}`;
        try {
          await renameLockPath(lockPath, releasedPath);
          state.canonicalReleased = true;
          state.detachedPath = releasedPath;
          state.detachedGeneration = state.expectedGeneration;
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
    const releasedGeneration = state.detachedGeneration;
    if (releasedGeneration === undefined) {
      throw new Error(`Filesystem lock release generation is missing at ${detachedPath}`);
    }
    const isolation = await isolateDirectoryGenerationForRemoval(
      detachedPath,
      (generationPath) => lockGenerationMatches(generationPath, releasedGeneration),
      lockPath,
    );
    if (isolation.status === "missing") {
      state.detachedPath = undefined;
      state.detachedGeneration = undefined;
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
      state.detachedGeneration = undefined;
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
      state.detachedGeneration = undefined;
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
  if (expectedGeneration.legacyFile !== undefined) {
    if (!(await legacyFilesystemLockGenerationMatches(stalePath, expectedGeneration.legacyFile))) {
      await restoreUnexpectedLockGeneration(lockPath, stalePath);
      return false;
    }
    try {
      await unlink(stalePath);
    } catch (error) {
      await restoreUnexpectedLockGeneration(lockPath, stalePath);
      throw error;
    }
    await syncDirectory(path.dirname(stalePath));
    return true;
  }

  const isolation = await isolateDirectoryGenerationForRemoval(
    stalePath,
    (generationPath) => lockGenerationMatches(generationPath, expectedGeneration),
    lockPath,
  );
  if (isolation.status === "missing") return false;
  if (isolation.status === "changed") {
    await restoreUnexpectedLockGeneration(lockPath, stalePath);
    return false;
  }
  await removeIsolatedDirectoryGeneration(isolation.rootPath);
  return true;
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
