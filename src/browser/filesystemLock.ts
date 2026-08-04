import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { delay } from "./utils.js";

const LOCK_OWNER_FILENAME = "owner.json";
const LOCK_MUTATION_DIRECTORY_SUFFIX = ".mutations";
const LOCK_MUTATION_REQUEST_PREFIX = "request-";
const LOCK_MUTATION_TICKET_FILENAME = "ticket";
const DEFAULT_POLL_MS = 50;
const DEFAULT_INCOMPLETE_STALE_MS = 5_000;
const WINDOWS_LOCK_MUTATION_RETRY_MS = 10;
const WINDOWS_LOCK_MUTATION_TIMEOUT_MS = 1_000;
const WINDOWS_PROCESS_IDENTITY_TIMEOUT_MS = 12_000;
const CURRENT_PROCESS_IDENTITY_RETRY_MS = 5_000;
const execFileAsync = promisify(execFile);
let currentProcessStartIdentity: string | undefined;
let currentProcessStartIdentityPromise: Promise<string | null> | undefined;
let currentProcessStartIdentityRetryAfterMs = 0;
export type ProcessLiveness = "alive" | "dead" | "unknown";

export interface FilesystemLockOwnerRecord {
  version: 1;
  pid: number;
  processStartIdentity: string;
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
}

export interface CrashRecoverableFilesystemLockDeps {
  now?: () => number;
  pid?: number;
  readProcessLiveness?: (pid: number) => ProcessLiveness;
  readProcessStartIdentity?: (pid: number) => Promise<string | null>;
  randomUUID?: () => string;
  beforeLockPublication?: (preparedLockPath: string) => Promise<void>;
  beforeStaleLockQuarantine?: () => Promise<void>;
  afterStaleLockQuarantine?: (quarantinedLockPath: string) => Promise<void>;
  beforeMutationRequestRemoval?: (requestPath: string) => Promise<void>;
}
interface FilesystemLockGeneration {
  ownerRaw: string | null;
  lastMutationMs?: number;
}

interface FilesystemLockMutationOptions {
  owner: FilesystemLockOwnerRecord;
  now: () => number;
  pollMs: number;
  incompleteLockStaleMs: number;
  readLiveness: (pid: number) => ProcessLiveness;
  readProcessIdentity: (pid: number) => Promise<string | null>;
  createNonce: () => string;
  beforeRequestRemoval?: (requestPath: string) => Promise<void>;
}

interface FilesystemLockMutationLease {
  release: () => Promise<void>;
}
interface FilesystemLockMutationRequestRemovalState {
  requestPath: string;
  expectedGeneration: FilesystemLockGeneration;
  quarantinedPath?: string;
}

interface FilesystemLockReleaseState {
  mutationLease?: FilesystemLockMutationLease;
  detachedPath?: string;
  canonicalReleased: boolean;
}

type FilesystemLockInspection =
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
  const now = deps.now ?? Date.now;
  const pid = deps.pid ?? process.pid;
  const readLiveness = deps.readProcessLiveness ?? readProcessLiveness;
  const readProcessIdentity = deps.readProcessStartIdentity ?? readProcessStartIdentity;
  const createNonce = deps.randomUUID ?? randomUUID;
  const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
  const pollMs = Math.max(10, options.pollMs ?? DEFAULT_POLL_MS);
  const incompleteLockStaleMs = Math.max(
    100,
    options.incompleteLockStaleMs ?? DEFAULT_INCOMPLETE_STALE_MS,
  );
  const processStartIdentity = await readProcessIdentity(pid);
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
  const mutationProcessStartIdentity = await readProcessStartIdentity(process.pid);
  if (!mutationProcessStartIdentity) {
    throw new Error(
      `Cannot coordinate crash-recoverable filesystem lock mutations at ${lockPath} without a stable process generation for pid ${process.pid}`,
    );
  }
  const mutationOwner: FilesystemLockOwnerRecord = {
    version: 1,
    pid: process.pid,
    processStartIdentity: mutationProcessStartIdentity,
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
    readLiveness: readProcessLiveness,
    readProcessIdentity: readProcessStartIdentity,
    createNonce,
    beforeRequestRemoval: deps.beforeMutationRequestRemoval,
  };

  if (options.createParent !== false) {
    await mkdir(parentPath, { recursive: true });
  }

  const completeAcquisition = (
    mutationLease?: FilesystemLockMutationLease,
  ): CrashRecoverableFilesystemLock => {
    const releaseState: FilesystemLockReleaseState = {
      mutationLease,
      canonicalReleased: false,
    };
    let released = false;
    let releaseInFlight: Promise<void> | undefined;
    return {
      path: lockPath,
      owner,
      release: () => {
        if (released) return Promise.resolve();
        if (releaseInFlight) return releaseInFlight;
        let attempt!: Promise<void>;
        attempt = (async () => {
          try {
            await releaseCrashRecoverableFilesystemLock(
              lockPath,
              owner,
              mutationOptions,
              releaseState,
            );
            released = true;
          } finally {
            if (releaseInFlight === attempt) releaseInFlight = undefined;
          }
        })();
        releaseInFlight = attempt;
        return attempt;
      },
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
        return completeAcquisition();
      }

      let inspection = await inspectExistingLock(lockPath, {
        nowMs: now(),
        incompleteLockStaleMs,
        readLiveness,
        readProcessIdentity,
      });
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
            return completeAcquisition(mutationLease);
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
              return completeAcquisition(mutationLease);
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
  // stale-owner checks still observe PID reuse; only stable current-process absence is cached.
  if (pid !== process.pid) return readProcessStartIdentityUncached(pid);
  if (currentProcessStartIdentity !== undefined) return currentProcessStartIdentity;
  if (Date.now() < currentProcessStartIdentityRetryAfterMs) return null;

  const inFlight = (currentProcessStartIdentityPromise ??= readProcessStartIdentityUncached(pid));
  try {
    const identity = await inFlight;
    if (identity === null) {
      currentProcessStartIdentityRetryAfterMs = Date.now() + CURRENT_PROCESS_IDENTITY_RETRY_MS;
    } else {
      currentProcessStartIdentity = identity;
      currentProcessStartIdentityRetryAfterMs = 0;
    }
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
  } catch (error) {
    if (isProcessIdentityTimeoutError(error)) throw error;
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

// A stable sibling directory hosts unique mutation requests. Published tickets order requests;
// concurrent ticket ties use the unique request name, and an owner without a ticket is a doorway
// that every contender waits for. Stale requests are reclaimed only through their unique path.
async function acquireFilesystemLockMutationLease(
  lockPath: string,
  options: FilesystemLockMutationOptions,
  deadlineMs?: number,
  whileWaiting?: () => Promise<void>,
): Promise<FilesystemLockMutationLease | null> {
  const mutationRootPath = `${lockPath}${LOCK_MUTATION_DIRECTORY_SUFFIX}`;
  let removalState: FilesystemLockMutationRequestRemovalState | undefined;
  let acquired = false;
  try {
    const requestPath = await createFilesystemLockMutationRequest(mutationRootPath, options.owner);
    removalState = {
      requestPath,
      expectedGeneration: await snapshotFilesystemLockGeneration(requestPath),
    };
    try {
      await writeFilesystemLockMutationOwner(requestPath, options.owner);
    } catch (error) {
      removalState.expectedGeneration = await snapshotFilesystemLockGeneration(requestPath);
      throw error;
    }
    removalState.expectedGeneration = { ownerRaw: `${JSON.stringify(options.owner)}\n` };
    const ticket = await writeFilesystemLockMutationTicket(mutationRootPath, requestPath);
    const requestName = path.basename(requestPath);

    for (;;) {
      if (
        !(await hasPrecedingFilesystemLockMutationRequest(
          mutationRootPath,
          requestPath,
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

      if (deadlineMs !== undefined && options.now() >= deadlineMs) return null;
      const waitMs =
        deadlineMs === undefined
          ? options.pollMs
          : Math.min(options.pollMs, Math.max(1, deadlineMs - options.now()));
      await delay(waitMs);
    }
  } finally {
    if (!acquired && removalState !== undefined) {
      // Cancellation may overrun deadline: returning before this exact request is hidden would
      // orphan a live queue head until process exit.
      await removeFilesystemLockMutationRequestBeforeReturning(removalState, options);
    }
  }
}

async function createFilesystemLockMutationRequest(
  mutationRootPath: string,
  owner: FilesystemLockOwnerRecord,
): Promise<string> {
  for (;;) {
    try {
      await mkdir(mutationRootPath);
    } catch (error) {
      if (readErrorCode(error) !== "EEXIST") throw error;
    }
    try {
      return await mkdtemp(
        path.join(mutationRootPath, `${LOCK_MUTATION_REQUEST_PREFIX}${owner.ownerNonce}-`),
      );
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") throw error;
    }
  }
}

async function writeFilesystemLockMutationOwner(
  requestPath: string,
  owner: FilesystemLockOwnerRecord,
): Promise<void> {
  const handle = await open(path.join(requestPath, LOCK_OWNER_FILENAME), "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

async function writeFilesystemLockMutationTicket(
  mutationRootPath: string,
  requestPath: string,
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
  const handle = await open(ticketPath, "wx", 0o600);
  try {
    await handle.writeFile(`${ticket}\n`, "utf8");
  } finally {
    await handle.close();
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
    return (await readdir(`${lockPath}${LOCK_MUTATION_DIRECTORY_SUFFIX}`)).some(
      (entry) => entry.startsWith(LOCK_MUTATION_REQUEST_PREFIX) && !entry.includes(".stale-"),
    );
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function listFilesystemLockMutationRequests(mutationRootPath: string): Promise<string[]> {
  const entries = await readdir(mutationRootPath);
  return entries
    .filter((entry) => entry.startsWith(LOCK_MUTATION_REQUEST_PREFIX) && !entry.includes(".stale-"))
    .sort()
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
async function snapshotFilesystemLockGeneration(
  lockPath: string,
): Promise<FilesystemLockGeneration> {
  try {
    return { ownerRaw: await readFile(path.join(lockPath, LOCK_OWNER_FILENAME), "utf8") };
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
    return { ownerRaw: null, lastMutationMs: await readLockLastMutationMs(lockPath) };
  }
}

async function removeFilesystemLockMutationRequestBeforeReturning(
  state: FilesystemLockMutationRequestRemovalState,
  options: FilesystemLockMutationOptions,
): Promise<void> {
  for (;;) {
    try {
      await removeFilesystemLockMutationRequest(state, options);
      return;
    } catch {
      await delay(options.pollMs);
    }
  }
}

async function removeFilesystemLockMutationRequest(
  state: FilesystemLockMutationRequestRemovalState,
  options: FilesystemLockMutationOptions,
): Promise<void> {
  if (state.quarantinedPath === undefined) {
    await options.beforeRequestRemoval?.(state.requestPath);
    const quarantinedPath = `${state.requestPath}.stale-${options.owner.ownerNonce}`;
    try {
      await renameLockPath(state.requestPath, quarantinedPath);
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") throw error;
      if (!(await lockPathExists(quarantinedPath))) return;
    }
    state.quarantinedPath = quarantinedPath;
  }

  const quarantinedPath = state.quarantinedPath;
  let generationMatches: boolean;
  try {
    generationMatches = await lockGenerationMatches(quarantinedPath, state.expectedGeneration);
  } catch (error) {
    await restoreFilesystemLockMutationRequest(state.requestPath, quarantinedPath);
    state.quarantinedPath = undefined;
    throw error;
  }
  if (!generationMatches) {
    await restoreFilesystemLockMutationRequest(state.requestPath, quarantinedPath);
    state.quarantinedPath = undefined;
    throw new Error(`Filesystem lock mutation ownership changed at ${state.requestPath}`);
  }

  await removeLockPath(quarantinedPath);
  state.quarantinedPath = undefined;
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

  await removeLockPath(quarantinedPath);
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

async function releaseCrashRecoverableFilesystemLock(
  lockPath: string,
  expectedOwner: FilesystemLockOwnerRecord,
  mutationOptions: FilesystemLockMutationOptions,
  state: FilesystemLockReleaseState,
): Promise<void> {
  if (state.mutationLease === undefined) {
    const rejectChangedOwner = async (): Promise<void> => {
      const owner = await readLockOwnerForRelease(lockPath);
      if (owner !== null && !sameLockOwner(owner, expectedOwner)) {
        throw new Error(`Filesystem lock ownership changed at ${lockPath}`);
      }
    };
    await rejectChangedOwner();
    const mutationLease = await acquireFilesystemLockMutationLease(
      lockPath,
      mutationOptions,
      undefined,
      rejectChangedOwner,
    );
    if (mutationLease === null) {
      throw new Error(`Cannot serialize filesystem lock release at ${lockPath}`);
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

  if (state.detachedPath !== undefined) {
    const detachedPath = state.detachedPath;
    const releasedOwner = await readLockOwnerForRelease(detachedPath);
    if (releasedOwner === null) {
      state.detachedPath = undefined;
    } else if (!sameLockOwner(releasedOwner, expectedOwner)) {
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
      await syncDirectoryIfPresent(path.dirname(lockPath));
      await removeLockPath(detachedPath);
      await syncDirectoryIfPresent(path.dirname(lockPath));
      state.detachedPath = undefined;
    }
  }

  const mutationLease = state.mutationLease;
  if (mutationLease !== undefined) {
    await mutationLease.release();
    state.mutationLease = undefined;
  }
}

async function inspectExistingLock(
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
      const observedIdentity = await options.readProcessIdentity(owner.pid);
      if (observedIdentity !== null && owner.processStartIdentity !== observedIdentity) {
        return { status: "stale", generation: { ownerRaw: raw } };
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

async function quarantineStaleLock(
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

  await removeLockPath(stalePath);
  await syncDirectory(path.dirname(lockPath));
  return true;
}

async function lockGenerationMatches(
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

async function writeLockOwner(lockPath: string, owner: FilesystemLockOwnerRecord): Promise<void> {
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
      typeof parsed.processStartIdentity !== "string" ||
      parsed.processStartIdentity.length === 0
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

async function renameLockPath(sourcePath: string, destinationPath: string): Promise<void> {
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

async function removeLockPath(lockPath: string): Promise<void> {
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

async function syncDirectoryIfPresent(directory: string): Promise<void> {
  try {
    await syncDirectory(directory);
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isProcessIdentityTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return readErrorCode(error) === "ETIMEDOUT" || (error as { killed?: unknown }).killed === true;
}

function readErrorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}
