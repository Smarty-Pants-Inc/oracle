import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createPlatformProcessGenerationProvider } from "./platformProcessGeneration.js";
import { delay } from "./utils.js";
import {
  retainFilesystemLockRelease,
  retryPendingFilesystemLockReleases,
} from "./filesystemLockReleaseJournal.js";
import {
  captureFilesystemLockDirectoryGeneration,
  encodeFilesystemLockOwner,
  inspectExistingLock,
  writeLockOwner,
  LOCK_OWNER_FILENAME,
  type FilesystemLockGeneration,
  type FilesystemLockOwnerRecord,
  type ProcessLiveness,
} from "./filesystemLockModel.js";
import {
  acquireFilesystemLockMutationLease,
  hasFilesystemLockMutationRequests,
  type FilesystemLockMutationLease,
  type FilesystemLockMutationOptions,
} from "./filesystemLockMutationLease.js";
import {
  quarantineStaleLock,
  releaseCrashRecoverableFilesystemLock,
  type FilesystemLockReleaseState,
} from "./filesystemLockGenerationRelease.js";
import {
  capturePhysicalDirectoryIdentity,
  lockPathExists,
  readErrorCode,
  removePreparedLockDirectory,
  renameLockPath,
  syncDirectory,
  syncDirectoryIfPresent,
  type PhysicalDirectoryIdentity,
} from "./filesystemLockIo.js";
export { FilesystemLockReleasePendingError } from "./filesystemLockGenerationRelease.js";
export {
  isolateDirectoryGenerationForRemoval,
  removeIsolatedDirectoryGeneration,
} from "./filesystemLockDirectoryRemoval.js";
export type {
  FilesystemLockGeneration,
  FilesystemLockInspection,
  FilesystemLockOwnerRecord,
  ProcessLiveness,
} from "./filesystemLockModel.js";
export type {
  FilesystemLockMutationLease,
  FilesystemLockMutationOptions,
  FilesystemLockMutationRequestRemovalState,
} from "./filesystemLockMutationLease.js";
export type { FilesystemLockReleaseState } from "./filesystemLockGenerationRelease.js";

const DEFAULT_POLL_MS = 50;
const DEFAULT_INCOMPLETE_STALE_MS = 5_000;
const WINDOWS_PROCESS_IDENTITY_MAX_ATTEMPTS = 3;
const WINDOWS_PROCESS_IDENTITY_RETRY_MS = 50;
const WINDOWS_PROCESS_IDENTITY_ACQUISITION_TIMEOUT_MS = 12_000;
const platformProcessGenerationProvider = createPlatformProcessGenerationProvider();
let currentProcessStartIdentity: string | undefined;
let currentProcessStartIdentityPromise: Promise<string | null> | undefined;
export interface FilesystemLockProcessIdentityProvider {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly readProcessLiveness: (pid: number) => ProcessLiveness;
  readonly readProcessStartIdentity: (pid: number, timeoutMs?: number) => Promise<string | null>;
}

export interface CrashRecoverableFilesystemLock {
  path: string;
  owner: FilesystemLockOwnerRecord;
  release: (finalize?: () => Promise<void>) => Promise<void>;
}

export interface CrashRecoverableFilesystemLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  incompleteLockStaleMs?: number;
  createParent?: boolean;
  sessionId?: string;
  adoptCurrentProcessGeneration?: boolean;
  /** Tab-lease registry only: a live or unknown current Windows PID remains unreclaimable. */
  processGenerationPolicy?: "strict" | "allow-unstable-current-win32";
}

export interface CrashRecoverableFilesystemLockDeps {
  processIdentityProvider?: FilesystemLockProcessIdentityProvider;
  now?: () => number;
  randomUUID?: () => string;
  beforeLockPublication?: (preparedLockPath: string) => Promise<void>;
  beforeStaleLockQuarantine?: () => Promise<void>;
  afterStaleLockQuarantine?: (quarantinedLockPath: string) => Promise<void>;
  beforeMutationRequestOwnerWrite?: (preparedPath: string, requestPath: string) => Promise<void>;
  beforeMutationRequestTicketPublication?: (requestPath: string, ticket: number) => Promise<void>;
  beforeMutationRequestRemoval?: (requestPath: string) => Promise<void>;
  beforeReleasedLockRemoval?: (isolatedRootPath: string) => Promise<void>;
}

export class FilesystemLockBusyError extends Error {
  readonly lockPath: string;
  readonly owner?: FilesystemLockOwnerRecord;

  constructor(lockPath: string, owner?: FilesystemLockOwnerRecord) {
    super(
      owner
        ? `Filesystem lock at ${lockPath} is held by pid ${owner.pid}`
        : `Filesystem lock at ${lockPath} is incomplete and not yet stale`,
    );
    this.name = "FilesystemLockBusyError";
    this.lockPath = lockPath;
    this.owner = owner;
  }
}

export async function acquireCrashRecoverableFilesystemLock(
  lockPath: string,
  options: CrashRecoverableFilesystemLockOptions = {},
  deps: CrashRecoverableFilesystemLockDeps = {},
): Promise<CrashRecoverableFilesystemLock> {
  const processIdentityProvider = deps.processIdentityProvider ?? realProcessIdentityProvider;
  const now = deps.now ?? Date.now;
  const pid = processIdentityProvider.pid;
  const readLiveness = processIdentityProvider.readProcessLiveness;
  const readProcessIdentity = processIdentityProvider.readProcessStartIdentity;
  const createNonce = deps.randomUUID ?? randomUUID;
  const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
  const pollMs = Math.max(10, options.pollMs ?? DEFAULT_POLL_MS);
  const incompleteLockStaleMs = Math.max(
    100,
    options.incompleteLockStaleMs ?? DEFAULT_INCOMPLETE_STALE_MS,
  );
  const processStartIdentity =
    await readStableProcessStartIdentityForAcquisition(processIdentityProvider);
  const permitsUnstableCurrentWin32Generation =
    options.processGenerationPolicy === "allow-unstable-current-win32" &&
    processIdentityProvider.platform === "win32" &&
    pid === process.pid;
  if (!processStartIdentity && !permitsUnstableCurrentWin32Generation) {
    throw new Error(
      `Cannot acquire crash-recoverable filesystem lock at ${lockPath} without a stable process generation for pid ${pid}`,
    );
  }
  const owner: FilesystemLockOwnerRecord = {
    version: 1,
    pid,
    processStartIdentity,
    ownerNonce: createNonce(),
    sessionId: options.sessionId,
    createdAt: new Date(now()).toISOString(),
  };
  const mutationOwner: FilesystemLockOwnerRecord = {
    version: 1,
    pid,
    processStartIdentity,
    ownerNonce: createNonce(),
    createdAt: new Date(now()).toISOString(),
  };
  const startedAt = now();
  const mutationDeadlineMs = timeoutMs === 0 ? startedAt : startedAt + timeoutMs;
  const parentPath = path.dirname(lockPath);
  const mutationOptions: FilesystemLockMutationOptions = {
    owner: mutationOwner,
    now,
    pollMs,
    incompleteLockStaleMs,
    readLiveness,
    readProcessIdentity,
    createNonce,
    beforeRequestOwnerWrite: deps.beforeMutationRequestOwnerWrite,
    beforeTicketPublication: deps.beforeMutationRequestTicketPublication,
    beforeRequestRemoval: deps.beforeMutationRequestRemoval,
  };

  if (options.createParent !== false) {
    await mkdir(parentPath, { recursive: true });
  }
  await retryPendingFilesystemLockReleases(lockPath);

  const completeAcquisition = (
    acquiredOwner: FilesystemLockOwnerRecord,
    expectedGeneration: FilesystemLockGeneration,
    mutationLease?: FilesystemLockMutationLease,
  ): CrashRecoverableFilesystemLock => {
    const releaseState: FilesystemLockReleaseState = {
      mutationLease,
      expectedGeneration,
      canonicalReleased: false,
    };
    const retainedRelease = retainFilesystemLockRelease(lockPath, acquiredOwner, async () => {
      await releaseCrashRecoverableFilesystemLock(
        lockPath,
        acquiredOwner,
        mutationOptions,
        releaseState,
        deps.beforeReleasedLockRemoval,
      );
    });
    return {
      path: lockPath,
      owner: acquiredOwner,
      release: retainedRelease.release,
    };
  };

  let preparedLockPath: string | undefined;
  let preparedLockIdentity: PhysicalDirectoryIdentity | undefined;
  try {
    preparedLockPath = await mkdtemp(`${lockPath}.publishing-`);
    preparedLockIdentity = await capturePhysicalDirectoryIdentity(preparedLockPath);
    await writeLockOwner(preparedLockPath, owner);
    await deps.beforeLockPublication?.(preparedLockPath);
    const preparedGeneration = await captureFilesystemLockDirectoryGeneration(
      preparedLockPath,
      encodeFilesystemLockOwner(owner),
    );

    for (;;) {
      if (
        !(await hasFilesystemLockMutationRequests(lockPath)) &&
        (await publishPreparedLockGeneration(preparedLockPath, lockPath))
      ) {
        preparedLockPath = undefined;
        preparedLockIdentity = undefined;
        return completeAcquisition(owner, preparedGeneration);
      }

      let inspection = await inspectExistingLock(lockPath, {
        nowMs: now(),
        incompleteLockStaleMs,
        readLiveness,
        readProcessIdentity,
      });
      if (
        inspection.status === "active" &&
        options.adoptCurrentProcessGeneration === true &&
        Boolean(options.sessionId) &&
        processStartIdentity !== null &&
        inspection.owner?.pid === pid &&
        inspection.owner.processStartIdentity === processStartIdentity &&
        (inspection.owner.sessionId === undefined ||
          inspection.owner.sessionId === options.sessionId)
      ) {
        return completeAcquisition(
          inspection.owner,
          await captureFilesystemLockDirectoryGeneration(
            lockPath,
            encodeFilesystemLockOwner(inspection.owner),
          ),
        );
      }
      let attemptedReclamation = false;
      if (inspection.status === "stale") {
        const mutationLease = await acquireFilesystemLockMutationLease(
          lockPath,
          mutationOptions,
          mutationDeadlineMs,
        );
        if (mutationLease === null) throw new FilesystemLockBusyError(lockPath);
        let retainMutationLease = false;
        try {
          if (await publishPreparedLockGeneration(preparedLockPath, lockPath)) {
            retainMutationLease = true;
            preparedLockPath = undefined;
            preparedLockIdentity = undefined;
            return completeAcquisition(owner, preparedGeneration, mutationLease);
          }
          inspection = await inspectExistingLock(lockPath, {
            nowMs: now(),
            incompleteLockStaleMs,
            readLiveness,
            readProcessIdentity,
          });
          if (inspection.status === "stale") {
            await deps.beforeStaleLockQuarantine?.();
            await quarantineStaleLock(
              lockPath,
              createNonce(),
              inspection.generation,
              deps.afterStaleLockQuarantine,
            );
            attemptedReclamation = true;
            if (await publishPreparedLockGeneration(preparedLockPath, lockPath)) {
              retainMutationLease = true;
              preparedLockPath = undefined;
              preparedLockIdentity = undefined;
              return completeAcquisition(owner, preparedGeneration, mutationLease);
            }
          }
        } finally {
          if (!retainMutationLease) await mutationLease.release();
        }
      }

      if (attemptedReclamation) continue;
      const elapsed = now() - startedAt;
      if (timeoutMs === 0 || elapsed >= timeoutMs) {
        throw new FilesystemLockBusyError(
          lockPath,
          inspection.status === "active" ? inspection.owner : undefined,
        );
      }
      await delay(Math.min(pollMs, Math.max(1, timeoutMs - elapsed)));
    }
  } finally {
    if (preparedLockPath !== undefined && preparedLockIdentity !== undefined) {
      await removePreparedLockDirectory(preparedLockPath, preparedLockIdentity, [
        LOCK_OWNER_FILENAME,
      ]);
      await syncDirectoryIfPresent(parentPath);
    }
  }
}

async function readStableProcessStartIdentityForAcquisition(
  provider: FilesystemLockProcessIdentityProvider,
): Promise<string | null> {
  if (provider.platform !== "win32") return provider.readProcessStartIdentity(provider.pid);

  const deadlineMs = Date.now() + WINDOWS_PROCESS_IDENTITY_ACQUISITION_TIMEOUT_MS;
  for (let attempt = 0; attempt < WINDOWS_PROCESS_IDENTITY_MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) return null;
    const identity = await provider.readProcessStartIdentity(
      provider.pid,
      Math.max(1, remainingMs),
    );
    if (identity) return identity;
    if (attempt + 1 < WINDOWS_PROCESS_IDENTITY_MAX_ATTEMPTS) {
      const delayMs = Math.min(WINDOWS_PROCESS_IDENTITY_RETRY_MS, deadlineMs - Date.now());
      if (delayMs <= 0) return null;
      await delay(delayMs);
    }
  }
  return null;
}

const realProcessIdentityProvider: FilesystemLockProcessIdentityProvider = {
  platform: process.platform,
  pid: process.pid,
  readProcessLiveness,
  readProcessStartIdentity,
};

export function readProcessLiveness(pid: number): ProcessLiveness {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = readErrorCode(error);
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

export async function readProcessStartIdentity(
  pid: number,
  timeoutMs?: number,
): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // This process cannot be replaced while this module is running. Foreign PIDs stay uncached so
  // stale-owner checks still observe PID reuse; current-process successes alone are cached.
  if (pid !== process.pid) {
    return platformProcessGenerationProvider.readProcessGeneration(pid, timeoutMs);
  }
  if (currentProcessStartIdentity !== undefined) return currentProcessStartIdentity;

  const inFlight = (currentProcessStartIdentityPromise ??=
    platformProcessGenerationProvider.readProcessGeneration(pid, timeoutMs));
  try {
    const identity = await inFlight;
    if (identity !== null) currentProcessStartIdentity = identity;
    return identity;
  } finally {
    if (currentProcessStartIdentityPromise === inFlight) {
      currentProcessStartIdentityPromise = undefined;
    }
  }
}

async function publishPreparedLockGeneration(
  preparedLockPath: string,
  lockPath: string,
): Promise<boolean> {
  if (await lockPathExists(lockPath)) return false;
  try {
    await renameLockPath(preparedLockPath, lockPath);
  } catch (error) {
    if (await lockPathExists(lockPath)) return false;
    throw error;
  }
  await syncDirectory(path.dirname(lockPath));
  return true;
}
