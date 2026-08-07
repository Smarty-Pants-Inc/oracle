import { createHash } from "node:crypto";
import path from "node:path";
import {
  assertPrivateDirectoryAuthority,
  establishPrivateRuntimeAuthority,
  type PrivateDirectoryAuthority,
} from "../privateTempRoot.js";
import {
  acquireCrashRecoverableFilesystemLock,
  FilesystemLockBusyError,
  type CrashRecoverableFilesystemLockDeps,
} from "./filesystemLock.js";
import { canonicalFilesystemLockPath } from "./filesystemLockModel.js";
import {
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

export async function acquireReattachRecoveryLock(
  lockPath: string,
  parentAuthority?: PrivateDirectoryAuthority,
  deps: CrashRecoverableFilesystemLockDeps = {},
): Promise<ReattachRecoveryLock> {
  const parent = parentAuthority ?? (await establishPrivateRuntimeAuthority());
  const canonicalPath = canonicalFilesystemLockPath(lockPath);
  if (path.dirname(canonicalPath) !== parent.path) {
    throw new Error("Browser recovery lock is outside the exact private runtime authority");
  }
  const assertParentAuthority = async (): Promise<void> =>
    await assertPrivateDirectoryAuthority(parent);

  return withReattachRecoveryAcquisitionGate(canonicalPath, async () => {
    await assertParentAuthority();
    await retryPendingFilesystemLockReleases(canonicalPath, { assertParentAuthority });
    await assertParentAuthority();
    if (hasRetainedFilesystemLockRelease(canonicalPath)) {
      throw new Error("Browser recovery is already in progress (current controller generation)");
    }

    const sessionId = `browser-recovery:${createHash("sha256").update(canonicalPath).digest("hex").slice(0, 24)}`;
    try {
      const acquired = await acquireCrashRecoverableFilesystemLock(
        canonicalPath,
        {
          sessionId,
          adoptCurrentProcessGeneration: true,
          createParent: false,
          expectedParentIdentity: parent.identity,
        },
        deps,
      );
      await assertParentAuthority();
      return {
        release: async (finalize) => {
          await assertParentAuthority();
          await acquired.release(
            finalize
              ? async () => {
                  await assertParentAuthority();
                  await finalize();
                  await assertParentAuthority();
                }
              : undefined,
          );
          await assertParentAuthority();
        },
      };
    } catch (error) {
      if (error instanceof FilesystemLockBusyError) {
        const owner = error.owner ? ` (pid ${error.owner.pid})` : "";
        throw new Error(`Browser recovery is already in progress${owner}`);
      }
      throw error;
    }
  });
}
