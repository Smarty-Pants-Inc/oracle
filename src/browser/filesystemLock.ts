import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { mkdir, mkdtemp, open, readFile, readdir, stat } from "node:fs/promises";
import { delay } from "./utils.js";
import { retainFilesystemLockRelease } from "./filesystemLockReleaseJournal.js";
import {
  inspectExistingLock,
  isolateDirectoryGenerationForRemoval,
  lockGenerationMatches,
  quarantineStaleLock,
  readErrorCode,
  releaseCrashRecoverableFilesystemLock,
  removeIsolatedDirectoryGeneration,
  removeLockPath,
  renameLockPath,
  syncDirectory,
  syncDirectoryIfPresent,
  writeLockOwner,
} from "./filesystemLockPrimitives.js";
export {
  FilesystemLockReleasePendingError,
  isolateDirectoryGenerationForRemoval,
  removeIsolatedDirectoryGeneration,
} from "./filesystemLockPrimitives.js";

const LOCK_OWNER_FILENAME = "owner.json";
const LOCK_MUTATION_DIRECTORY_SUFFIX = ".mutations";
const LOCK_MUTATION_REQUEST_PREFIX = "request-";
const LOCK_MUTATION_PREPARATION_PREFIX = ".preparing-";
const LOCK_MUTATION_TICKET_FILENAME = "ticket";
const DEFAULT_POLL_MS = 50;
const DEFAULT_INCOMPLETE_STALE_MS = 5_000;
const LOCK_MUTATION_REQUEST_CLEANUP_TIMEOUT_MS = 1_000;
const WINDOWS_PROCESS_IDENTITY_TIMEOUT_MS = 2_000;
const WINDOWS_PROCESS_IDENTITY_MAX_ATTEMPTS = 3;
const WINDOWS_PROCESS_IDENTITY_RETRY_MS = 50;
const execFileAsync = promisify(execFile);
let currentProcessStartIdentity: string | undefined;
let currentProcessStartIdentityPromise: Promise<string | null> | undefined;
export type ProcessLiveness = "alive" | "dead" | "unknown";
export interface FilesystemLockProcessIdentityProvider {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly readProcessLiveness: (pid: number) => ProcessLiveness;
  readonly readProcessStartIdentity: (pid: number) => Promise<string | null>;
}

export interface FilesystemLockOwnerRecord {
  version: 1;
  pid: number;
  processStartIdentity: string | null;
  ownerNonce: string;
  createdAt: string;
  sessionId?: string;
}

export interface CrashRecoverableFilesystemLock {
  path: string;
  owner: FilesystemLockOwnerRecord;
  release: () => Promise<void>;
}

export interface CrashRecoverableFilesystemLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  incompleteLockStaleMs?: number;
  createParent?: boolean;
  sessionId?: string;
  adoptCurrentProcessGeneration?: boolean;
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
export interface FilesystemLockGeneration {
  ownerRaw: string | null;
  lastMutationMs?: number;
}

export interface FilesystemLockMutationOptions {
  owner: FilesystemLockOwnerRecord;
  now: () => number;
  pollMs: number;
  incompleteLockStaleMs: number;
  readLiveness: (pid: number) => ProcessLiveness;
  readProcessIdentity: (pid: number) => Promise<string | null>;
  createNonce: () => string;
  beforeRequestOwnerWrite?: (preparedPath: string, requestPath: string) => Promise<void>;
  beforeTicketPublication?: (requestPath: string, ticket: number) => Promise<void>;
  beforeRequestRemoval?: (requestPath: string) => Promise<void>;
}

export interface FilesystemLockMutationLease {
  release: () => Promise<void>;
}
export interface FilesystemLockMutationRequestRemovalState {
  requestPath: string;
  expectedGeneration: FilesystemLockGeneration;
  quarantinedPath?: string;
  isolatedRemovalRootPath?: string;
}

export interface FilesystemLockReleaseState {
  mutationLease?: FilesystemLockMutationLease;
  detachedPath?: string;
  isolatedRemovalRootPath?: string;
  canonicalReleased: boolean;
}

export type FilesystemLockInspection =
  | { status: "active"; owner?: FilesystemLockOwnerRecord }
  | { status: "stale"; generation: FilesystemLockGeneration };

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
  if (!processStartIdentity) {
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

  const completeAcquisition = (
    acquiredOwner: FilesystemLockOwnerRecord,
    mutationLease?: FilesystemLockMutationLease,
  ): CrashRecoverableFilesystemLock => {
    const releaseState: FilesystemLockReleaseState = {
      mutationLease,
      canonicalReleased: false,
    };
    const retainedRelease = retainFilesystemLockRelease(lockPath, acquiredOwner, async () => {
      await releaseCrashRecoverableFilesystemLock(
        lockPath,
        acquiredOwner,
        mutationOptions,
        releaseState,
        acquireFilesystemLockMutationLease,
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
  try {
    preparedLockPath = await mkdtemp(`${lockPath}.publishing-`);
    await writeLockOwner(preparedLockPath, owner);
    await deps.beforeLockPublication?.(preparedLockPath);

    for (;;) {
      if (
        !(await hasFilesystemLockMutationRequests(lockPath)) &&
        (await publishPreparedLockGeneration(preparedLockPath, lockPath))
      ) {
        preparedLockPath = undefined;
        return completeAcquisition(owner);
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
        inspection.owner?.pid === pid &&
        inspection.owner.processStartIdentity === processStartIdentity &&
        (inspection.owner.sessionId === undefined ||
          inspection.owner.sessionId === options.sessionId)
      ) {
        return completeAcquisition(inspection.owner);
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
            return completeAcquisition(owner, mutationLease);
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
              return completeAcquisition(owner, mutationLease);
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
    if (preparedLockPath !== undefined) {
      await removeLockPath(preparedLockPath);
      await syncDirectoryIfPresent(parentPath);
    }
  }
}

async function readStableProcessStartIdentityForAcquisition(
  provider: FilesystemLockProcessIdentityProvider,
): Promise<string | null> {
  const maxAttempts = provider.platform === "win32" ? WINDOWS_PROCESS_IDENTITY_MAX_ATTEMPTS : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const identity = await provider.readProcessStartIdentity(provider.pid);
    if (identity) return identity;
    if (attempt + 1 < maxAttempts) await delay(WINDOWS_PROCESS_IDENTITY_RETRY_MS);
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

export async function readProcessStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // This process cannot be replaced while this module is running. Foreign PIDs stay uncached so
  // stale-owner checks still observe PID reuse; current-process successes alone are cached.
  if (pid !== process.pid) return readProcessStartIdentityUncached(pid);
  if (currentProcessStartIdentity !== undefined) return currentProcessStartIdentity;

  const inFlight = (currentProcessStartIdentityPromise ??= readProcessStartIdentityUncached(pid));
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

async function readProcessStartIdentityUncached(pid: number): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      const processStat = await readFile(`/proc/${pid}/stat`, "utf8");
      const commandEnd = processStat.lastIndexOf(")");
      if (commandEnd < 0) return null;
      const fields = processStat
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/u);
      const startTicks = fields[19];
      if (!startTicks) return null;
      const bootId = await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => "");
      return `linux:${bootId.trim() || "unknown-boot"}:${startTicks}`;
    }
    if (process.platform === "win32") {
      const command = `$process = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write($process.StartTime.ToUniversalTime().Ticks)`;
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { encoding: "utf8", windowsHide: true, timeout: WINDOWS_PROCESS_IDENTITY_TIMEOUT_MS },
      );
      const startTicks = String(stdout).trim();
      return startTicks ? `win32:${startTicks}` : null;
    }
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    });
    const startedAt = String(stdout).trim().replace(/\s+/gu, " ");
    return startedAt ? `${process.platform}:${startedAt}` : null;
  } catch {
    return null;
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

async function lockPathExists(lockPath: string): Promise<boolean> {
  try {
    await stat(lockPath);
    return true;
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

// A complete owner-bearing request is atomically published as a ticketless doorway before it
// chooses a ticket. Every later contender waits on that live doorway; published tickets then
// order requests, with the unique request name breaking concurrent ticket ties.
async function acquireFilesystemLockMutationLease(
  lockPath: string,
  options: FilesystemLockMutationOptions,
  deadlineMs?: number,
  whileWaiting?: () => Promise<void>,
  deadlineNow: () => number = options.now,
): Promise<FilesystemLockMutationLease | null> {
  const mutationRootPath = `${lockPath}${LOCK_MUTATION_DIRECTORY_SUFFIX}`;
  let preparedRequestPath: string | undefined;
  let removalState: FilesystemLockMutationRequestRemovalState | undefined;
  let acquired = false;
  try {
    const preparedRequest = await createPreparedFilesystemLockMutationRequest(
      mutationRootPath,
      options.owner,
    );
    preparedRequestPath = preparedRequest.preparedPath;
    await writeFilesystemLockMutationOwner(
      preparedRequest.preparedPath,
      preparedRequest.requestPath,
      options.owner,
      options.beforeRequestOwnerWrite,
    );
    await renameLockPath(preparedRequest.preparedPath, preparedRequest.requestPath);
    preparedRequestPath = undefined;
    removalState = {
      requestPath: preparedRequest.requestPath,
      expectedGeneration: { ownerRaw: `${JSON.stringify(options.owner)}\n` },
    };
    const ticket = await writeFilesystemLockMutationTicket(
      mutationRootPath,
      preparedRequest.requestPath,
      options.beforeTicketPublication,
    );
    const requestName = path.basename(preparedRequest.requestPath);

    for (;;) {
      if (
        !(await hasPrecedingFilesystemLockMutationRequest(
          mutationRootPath,
          preparedRequest.requestPath,
          requestName,
          ticket,
          options,
        ))
      ) {
        acquired = true;
        let released = false;
        let releaseInFlight: Promise<void> | undefined;
        return {
          release: () => {
            if (released) return Promise.resolve();
            if (releaseInFlight) return releaseInFlight;
            let attempt!: Promise<void>;
            attempt = (async () => {
              try {
                await removeFilesystemLockMutationRequest(removalState!, options);
                released = true;
              } finally {
                if (releaseInFlight === attempt) releaseInFlight = undefined;
              }
            })();
            releaseInFlight = attempt;
            return attempt;
          },
        };
      }
      await whileWaiting?.();

      if (deadlineMs !== undefined && deadlineNow() >= deadlineMs) return null;
      const waitMs =
        deadlineMs === undefined
          ? options.pollMs
          : Math.min(options.pollMs, Math.max(1, deadlineMs - deadlineNow()));
      await delay(waitMs);
    }
  } finally {
    if (!acquired && removalState !== undefined) {
      // Cancellation may overrun deadline: returning before this exact request is hidden would
      // orphan a live queue head until process exit.
      await removeFilesystemLockMutationRequestBeforeReturning(removalState, options);
    }
    if (preparedRequestPath !== undefined) {
      await removeLockPath(preparedRequestPath);
    }
  }
}

async function createPreparedFilesystemLockMutationRequest(
  mutationRootPath: string,
  owner: FilesystemLockOwnerRecord,
): Promise<{ preparedPath: string; requestPath: string }> {
  for (;;) {
    try {
      await mkdir(mutationRootPath);
    } catch (error) {
      if (readErrorCode(error) !== "EEXIST") throw error;
    }
    try {
      return {
        preparedPath: await mkdtemp(
          path.join(mutationRootPath, `${LOCK_MUTATION_PREPARATION_PREFIX}${owner.ownerNonce}-`),
        ),
        requestPath: path.join(
          mutationRootPath,
          `${LOCK_MUTATION_REQUEST_PREFIX}${owner.ownerNonce}`,
        ),
      };
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") throw error;
    }
  }
}

async function writeFilesystemLockMutationOwner(
  preparedPath: string,
  requestPath: string,
  owner: FilesystemLockOwnerRecord,
  beforeWrite?: (preparedPath: string, requestPath: string) => Promise<void>,
): Promise<void> {
  const handle = await open(path.join(preparedPath, LOCK_OWNER_FILENAME), "wx", 0o600);
  try {
    await beforeWrite?.(preparedPath, requestPath);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

async function writeFilesystemLockMutationTicket(
  mutationRootPath: string,
  requestPath: string,
  beforePublication?: (requestPath: string, ticket: number) => Promise<void>,
): Promise<number> {
  let maximumTicket = 0;
  for (const candidatePath of await listFilesystemLockMutationRequests(mutationRootPath)) {
    maximumTicket = Math.max(
      maximumTicket,
      (await readFilesystemLockMutationTicket(candidatePath)) ?? 0,
    );
  }
  if (maximumTicket >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`Filesystem lock mutation ticket space exhausted at ${mutationRootPath}`);
  }

  const ticket = maximumTicket + 1;
  const ticketPath = path.join(requestPath, LOCK_MUTATION_TICKET_FILENAME);
  const preparedTicketPath = `${ticketPath}.preparing`;
  let handle;
  try {
    handle = await open(preparedTicketPath, "wx", 0o600);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      throw new Error(`Filesystem lock mutation ownership changed at ${requestPath}`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    await handle.writeFile(`${ticket}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await beforePublication?.(requestPath, ticket);
  try {
    await renameLockPath(preparedTicketPath, ticketPath);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      throw new Error(`Filesystem lock mutation ownership changed at ${requestPath}`, {
        cause: error,
      });
    }
    throw error;
  }
  return ticket;
}

async function hasPrecedingFilesystemLockMutationRequest(
  mutationRootPath: string,
  ownRequestPath: string,
  ownRequestName: string,
  ownTicket: number,
  options: FilesystemLockMutationOptions,
): Promise<boolean> {
  for (const candidatePath of await listFilesystemLockMutationRequests(mutationRootPath)) {
    if (candidatePath === ownRequestPath) continue;
    const inspection = await inspectExistingLock(candidatePath, {
      nowMs: options.now(),
      incompleteLockStaleMs: options.incompleteLockStaleMs,
      readLiveness: options.readLiveness,
      readProcessIdentity: options.readProcessIdentity,
    });
    if (inspection.status === "stale") {
      const reclaimed = await quarantineFilesystemLockMutationRequest(
        candidatePath,
        options.createNonce(),
        inspection.generation,
      );
      if (!reclaimed && (await lockPathExists(candidatePath))) return true;
      continue;
    }

    const candidateTicket = await readFilesystemLockMutationTicket(candidatePath);
    if (candidateTicket === null) {
      if (await lockPathExists(candidatePath)) return true;
      continue;
    }
    const candidateName = path.basename(candidatePath);
    if (
      candidateTicket < ownTicket ||
      (candidateTicket === ownTicket && candidateName < ownRequestName)
    ) {
      return true;
    }
  }
  return false;
}

async function hasFilesystemLockMutationRequests(lockPath: string): Promise<boolean> {
  try {
    return (
      (await listFilesystemLockMutationRequests(`${lockPath}${LOCK_MUTATION_DIRECTORY_SUFFIX}`))
        .length > 0
    );
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function listFilesystemLockMutationRequests(mutationRootPath: string): Promise<string[]> {
  return (await readdir(mutationRootPath))
    .filter((entry) => entry.startsWith(LOCK_MUTATION_REQUEST_PREFIX) && !entry.includes(".stale-"))
    .map((entry) => path.join(mutationRootPath, entry));
}

async function readFilesystemLockMutationTicket(requestPath: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(requestPath, LOCK_MUTATION_TICKET_FILENAME), "utf8");
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  const normalized = raw.trim();
  if (!/^[1-9]\d*$/u.test(normalized)) return null;
  const ticket = Number(normalized);
  return Number.isSafeInteger(ticket) ? ticket : null;
}

async function removeFilesystemLockMutationRequestBeforeReturning(
  state: FilesystemLockMutationRequestRemovalState,
  options: FilesystemLockMutationOptions,
): Promise<void> {
  const deadline = Date.now() + LOCK_MUTATION_REQUEST_CLEANUP_TIMEOUT_MS;
  for (;;) {
    try {
      await removeFilesystemLockMutationRequest(state, options);
      return;
    } catch (error) {
      if (!isRetryableFilesystemLockMutationCleanupError(error) || Date.now() >= deadline) {
        throw error;
      }
    }
    await delay(Math.min(options.pollMs, Math.max(1, deadline - Date.now())));
  }
}

async function removeFilesystemLockMutationRequest(
  state: FilesystemLockMutationRequestRemovalState,
  options: FilesystemLockMutationOptions,
): Promise<void> {
  if (state.isolatedRemovalRootPath !== undefined) {
    await removeIsolatedDirectoryGeneration(state.isolatedRemovalRootPath);
    state.isolatedRemovalRootPath = undefined;
    return;
  }

  if (state.quarantinedPath === undefined) {
    const quarantinedPath = `${state.requestPath}.stale-${options.owner.ownerNonce}`;
    try {
      await renameLockPath(state.requestPath, quarantinedPath);
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") throw error;
      if (!(await lockPathExists(quarantinedPath))) return;
    }

    let generationMatches: boolean;
    try {
      generationMatches = await lockGenerationMatches(quarantinedPath, state.expectedGeneration);
    } catch (error) {
      await restoreFilesystemLockMutationRequest(state.requestPath, quarantinedPath);
      throw error;
    }
    if (!generationMatches) {
      await restoreFilesystemLockMutationRequest(state.requestPath, quarantinedPath);
      throw new Error(`Filesystem lock mutation ownership changed at ${state.requestPath}`);
    }
    // The verified rename is the queue-release point. Later cleanup failures retain only the
    // quarantined path or its private removal root, so a retry never republishes a live request.
    state.quarantinedPath = quarantinedPath;
  }

  await options.beforeRequestRemoval?.(state.requestPath);
  const quarantinedPath = state.quarantinedPath;
  if (quarantinedPath === undefined) return;
  const isolation = await isolateDirectoryGenerationForRemoval(quarantinedPath, (generationPath) =>
    lockGenerationMatches(generationPath, state.expectedGeneration),
  );
  if (isolation.status === "missing") {
    throw new Error(`Filesystem lock mutation ownership changed at ${state.requestPath}`);
  }
  if (isolation.status === "changed") {
    throw new Error(`Filesystem lock mutation ownership changed at ${state.requestPath}`);
  }
  state.quarantinedPath = undefined;
  state.isolatedRemovalRootPath = isolation.rootPath;
  await removeIsolatedDirectoryGeneration(isolation.rootPath);
  state.isolatedRemovalRootPath = undefined;
}

function isRetryableFilesystemLockMutationCleanupError(error: unknown): boolean {
  const code = readErrorCode(error);
  return (
    code === "EINTR" ||
    code === "EAGAIN" ||
    code === "EBUSY" ||
    code === "EMFILE" ||
    code === "ENFILE" ||
    code === "ENOTEMPTY"
  );
}

// Mutation requests coordinate only live processes. They need atomic visibility and exact-owner
// deletion, but not crash durability: after a machine crash no coordinating process survives.
async function quarantineFilesystemLockMutationRequest(
  requestPath: string,
  nonce: string,
  expectedGeneration: FilesystemLockGeneration,
): Promise<boolean> {
  const quarantinedPath = `${requestPath}.stale-${nonce}`;
  try {
    await renameLockPath(requestPath, quarantinedPath);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return false;
    throw error;
  }

  let generationMatches: boolean;
  try {
    generationMatches = await lockGenerationMatches(quarantinedPath, expectedGeneration);
  } catch (error) {
    await restoreFilesystemLockMutationRequest(requestPath, quarantinedPath);
    throw error;
  }
  if (!generationMatches) {
    await restoreFilesystemLockMutationRequest(requestPath, quarantinedPath);
    return false;
  }

  const isolation = await isolateDirectoryGenerationForRemoval(quarantinedPath, (generationPath) =>
    lockGenerationMatches(generationPath, expectedGeneration),
  );
  if (isolation.status === "missing") return false;
  if (isolation.status === "changed") {
    await restoreFilesystemLockMutationRequest(requestPath, quarantinedPath);
    return false;
  }
  await removeIsolatedDirectoryGeneration(isolation.rootPath);
  return true;
}

async function restoreFilesystemLockMutationRequest(
  requestPath: string,
  quarantinedPath: string,
): Promise<void> {
  try {
    await renameLockPath(quarantinedPath, requestPath);
  } catch (error) {
    throw new Error(
      `Filesystem lock mutation generation changed at ${requestPath}; unexpected request preserved at ${quarantinedPath}`,
      { cause: error },
    );
  }
}
