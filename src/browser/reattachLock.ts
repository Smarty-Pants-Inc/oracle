import { createHash } from "node:crypto";
import {
  acquireCrashRecoverableFilesystemLock,
  FilesystemLockBusyError,
} from "./filesystemLock.js";
import {
  canonicalFilesystemLockPath,
  hasRetainedFilesystemLockRelease,
  retryPendingFilesystemLockReleases,
} from "./filesystemLockReleaseJournal.js";

export interface ReattachRecoveryLock {
  release: (finalize?: () => Promise<void>) => Promise<void>;
}

const acquisitionGateTails = new Map<string, Promise<void>>();

async function withReattachRecoveryAcquisitionGate<T>(
  canonicalPath: string,
  acquire: () => Promise<T>,
): Promise<T> {
  const predecessor = acquisitionGateTails.get(canonicalPath) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = predecessor.catch(() => undefined).then(() => gate);
  acquisitionGateTails.set(canonicalPath, tail);
  await predecessor.catch(() => undefined);
  try {
    return await acquire();
  } finally {
    releaseGate();
    if (acquisitionGateTails.get(canonicalPath) === tail) {
      acquisitionGateTails.delete(canonicalPath);
    }
  }
}

export async function acquireReattachRecoveryLock(lockPath: string): Promise<ReattachRecoveryLock> {
  const canonicalPath = canonicalFilesystemLockPath(lockPath);
  return withReattachRecoveryAcquisitionGate(canonicalPath, async () => {
    await retryPendingFilesystemLockReleases(canonicalPath);
    if (hasRetainedFilesystemLockRelease(canonicalPath)) {
      throw new Error("Browser recovery is already in progress (current controller generation)");
    }

    const sessionId = `browser-recovery:${createHash("sha256").update(canonicalPath).digest("hex").slice(0, 24)}`;
    try {
      return await acquireCrashRecoverableFilesystemLock(canonicalPath, {
        sessionId,
        adoptCurrentProcessGeneration: true,
      });
    } catch (error) {
      if (error instanceof FilesystemLockBusyError) {
        const owner = error.owner ? ` (pid ${error.owner.pid})` : "";
        throw new Error(`Browser recovery is already in progress${owner}`);
      }
      throw error;
    }
  });
}
