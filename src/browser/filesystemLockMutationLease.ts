import path from "node:path";
import { mkdir, mkdtemp, open, readFile, readdir } from "node:fs/promises";
import { delay } from "./utils.js";
import {
  isolateDirectoryGenerationForRemoval,
  removeIsolatedDirectoryGeneration,
} from "./filesystemLockDirectoryRemoval.js";
import {
  captureFilesystemLockDirectoryGeneration,
  encodeFilesystemLockOwner,
  inspectExistingLock,
  lockGenerationMatches,
  LOCK_OWNER_FILENAME,
  LOCK_MUTATION_DIRECTORY_SUFFIX,
  type FilesystemLockGeneration,
  type FilesystemLockOwnerRecord,
  type ProcessLiveness,
} from "./filesystemLockModel.js";
import {
  capturePhysicalDirectoryIdentity,
  isRetryableWindowsLockMutationError,
  lockPathExists,
  readErrorCode,
  removePreparedLockDirectory,
  renameLockPath,
  type PhysicalDirectoryIdentity,
} from "./filesystemLockIo.js";

const LOCK_MUTATION_REQUEST_PREFIX = "request-";
const LOCK_MUTATION_PREPARATION_PREFIX = ".preparing-";
const LOCK_MUTATION_TICKET_FILENAME = "ticket";
const LOCK_MUTATION_REQUEST_CLEANUP_TIMEOUT_MS = 1_000;

const retainedFilesystemLockMutationRequestRemovals = new Set<Promise<void>>();

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
export async function acquireFilesystemLockMutationLease(
  lockPath: string,
  options: FilesystemLockMutationOptions,
  deadlineMs?: number,
  whileWaiting?: () => Promise<void>,
  deadlineNow: () => number = options.now,
): Promise<FilesystemLockMutationLease | null> {
  const mutationRootPath = `${lockPath}${LOCK_MUTATION_DIRECTORY_SUFFIX}`;
  let preparedRequestPath: string | undefined;
  let preparedRequestIdentity: PhysicalDirectoryIdentity | undefined;
  let removalState: FilesystemLockMutationRequestRemovalState | undefined;
  let acquired = false;
  try {
    const preparedRequest = await createPreparedFilesystemLockMutationRequest(
      mutationRootPath,
      options.owner,
    );
    preparedRequestPath = preparedRequest.preparedPath;
    preparedRequestIdentity = await capturePhysicalDirectoryIdentity(preparedRequest.preparedPath);
    await writeFilesystemLockMutationOwner(
      preparedRequest.preparedPath,
      preparedRequest.requestPath,
      options.owner,
      options.beforeRequestOwnerWrite,
    );
    const expectedGeneration = await captureFilesystemLockDirectoryGeneration(
      preparedRequest.preparedPath,
      encodeFilesystemLockOwner(options.owner),
    );
    await renameLockPath(preparedRequest.preparedPath, preparedRequest.requestPath);
    preparedRequestPath = undefined;
    preparedRequestIdentity = undefined;
    removalState = {
      requestPath: preparedRequest.requestPath,
      expectedGeneration,
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
    if (preparedRequestPath !== undefined && preparedRequestIdentity !== undefined) {
      await removePreparedLockDirectory(preparedRequestPath, preparedRequestIdentity, [
        LOCK_OWNER_FILENAME,
      ]);
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
    await handle.writeFile(encodeFilesystemLockOwner(owner), "utf8");
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

export async function hasFilesystemLockMutationRequests(lockPath: string): Promise<boolean> {
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
      if (!isRetryableFilesystemLockMutationCleanupError(error, state)) throw error;
      if (Date.now() >= deadline) {
        if (!isFilesystemLockMutationRequestQueueVisible(state)) throw error;
        retainFilesystemLockMutationRequestRemoval(state, options);
        return;
      }
    }
    await delay(Math.min(options.pollMs, Math.max(1, deadline - Date.now())));
  }
}

function retainFilesystemLockMutationRequestRemoval(
  state: FilesystemLockMutationRequestRemovalState,
  options: FilesystemLockMutationOptions,
): void {
  const removal = retryRetainedFilesystemLockMutationRequestRemoval(state, options);
  retainedFilesystemLockMutationRequestRemovals.add(removal);
  void removal.finally(() => {
    retainedFilesystemLockMutationRequestRemovals.delete(removal);
  });
}

async function retryRetainedFilesystemLockMutationRequestRemoval(
  state: FilesystemLockMutationRequestRemovalState,
  options: FilesystemLockMutationOptions,
): Promise<void> {
  for (;;) {
    try {
      await removeFilesystemLockMutationRequest(state, options);
      return;
    } catch (error) {
      if (!isRetryableFilesystemLockMutationCleanupError(error, state)) return;
    }
    await delayWithoutKeepingProcessAlive(options.pollMs);
  }
}

function delayWithoutKeepingProcessAlive(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, Math.max(1, ms));
  timer.unref();
  return promise;
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

function isRetryableFilesystemLockMutationCleanupError(
  error: unknown,
  state: FilesystemLockMutationRequestRemovalState,
): boolean {
  const code = readErrorCode(error);
  return (
    code === "EINTR" ||
    code === "EAGAIN" ||
    code === "EBUSY" ||
    code === "EEXIST" ||
    code === "EMFILE" ||
    code === "ENFILE" ||
    code === "ENOTEMPTY" ||
    (isFilesystemLockMutationRequestQueueVisible(state) &&
      isRetryableWindowsLockMutationError(error))
  );
}

function isFilesystemLockMutationRequestQueueVisible(
  state: FilesystemLockMutationRequestRemovalState,
): boolean {
  return state.quarantinedPath === undefined && state.isolatedRemovalRootPath === undefined;
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
