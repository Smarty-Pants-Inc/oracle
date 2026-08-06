import path from "node:path";
import {
  canonicalFilesystemLockPath,
  filesystemLockReleaseKey,
  LOCK_MUTATION_DIRECTORY_SUFFIX,
} from "./filesystemLockModel.js";
import { replayPendingIsolatedDirectoryRemovals } from "./filesystemLockDirectoryRemoval.js";

export {
  canonicalFilesystemLockPath,
  filesystemLockReleaseKey,
  replayPendingIsolatedDirectoryRemovals,
};
export interface FilesystemLockReleaseGeneration {
  pid: number;
  processStartIdentity: string | null;
  ownerNonce: string;
  createdAt?: string;
  sessionId?: string;
}

export interface RetainedFilesystemLockRelease {
  readonly key: string;
  readonly lockPath: string;
  readonly generation: FilesystemLockReleaseGeneration;
  release: (finalize?: () => Promise<void>) => Promise<void>;
}

type RetainedReleaseEntry = RetainedFilesystemLockRelease & {
  pending: boolean;
  released: boolean;
  attempt: () => Promise<void>;
  inFlight?: Promise<void>;
  finalize?: () => Promise<void>;
};

const retainedReleases = new Map<string, RetainedReleaseEntry>();

export function retainFilesystemLockRelease(
  lockPath: string,
  generation: FilesystemLockReleaseGeneration,
  attempt: () => Promise<void>,
): RetainedFilesystemLockRelease {
  const canonicalPath = canonicalFilesystemLockPath(lockPath);
  const key = filesystemLockReleaseKey(canonicalPath, generation);
  const existing = retainedReleases.get(key);
  if (existing) return existing;

  const entry: RetainedReleaseEntry = {
    key,
    lockPath: canonicalPath,
    generation,
    pending: false,
    released: false,
    attempt,
    release: async (finalize) => {
      if (finalize) entry.finalize ??= finalize;
      if (!retainedReleases.has(key)) return;
      if (entry.inFlight) return entry.inFlight;
      let currentAttempt!: Promise<void>;
      currentAttempt = (async () => {
        try {
          if (!entry.released) {
            await entry.attempt();
            entry.released = true;
          }
          await entry.finalize?.();
          retainedReleases.delete(key);
        } catch (error) {
          entry.pending = true;
          throw error;
        } finally {
          if (entry.inFlight === currentAttempt) entry.inFlight = undefined;
        }
      })();
      entry.inFlight = currentAttempt;
      return currentAttempt;
    },
  };
  retainedReleases.set(key, entry);
  return entry;
}

export async function retryPendingFilesystemLockReleases(lockPath: string): Promise<void> {
  const canonicalPath = canonicalFilesystemLockPath(lockPath);
  await replayPendingIsolatedDirectoryRemovals(path.dirname(canonicalPath), canonicalPath);
  await replayPendingIsolatedDirectoryRemovals(`${canonicalPath}${LOCK_MUTATION_DIRECTORY_SUFFIX}`);
  const pending = [...retainedReleases.values()].filter(
    (entry) => entry.lockPath === canonicalPath && entry.pending,
  );
  for (const entry of pending) await entry.release();
}

export function hasRetainedFilesystemLockRelease(lockPath: string): boolean {
  const canonicalPath = canonicalFilesystemLockPath(lockPath);
  return [...retainedReleases.values()].some((entry) => entry.lockPath === canonicalPath);
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suites
export const __test__ = {
  clearRetainedFilesystemLockReleases(): void {
    retainedReleases.clear();
  },
};
