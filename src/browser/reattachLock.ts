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
  release: () => Promise<void>;
}

export async function acquireReattachRecoveryLock(lockPath: string): Promise<ReattachRecoveryLock> {
  await retryPendingFilesystemLockReleases(lockPath);
  if (hasRetainedFilesystemLockRelease(lockPath)) {
    throw new Error("Browser recovery is already in progress (current controller generation)");
  }

  const canonicalPath = canonicalFilesystemLockPath(lockPath);
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
}
