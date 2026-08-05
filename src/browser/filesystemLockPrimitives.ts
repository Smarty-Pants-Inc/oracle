import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import type { BigIntStats, Dirent } from "node:fs";
import { createInterface } from "node:readline";
import { delay } from "./utils.js";
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
const ISOLATED_REMOVAL_ROOT_PREFIX = ".oracle-remove-";
const ISOLATED_REMOVAL_GENERATION_NAME = "generation";
const ISOLATED_REMOVAL_JOURNAL_SUFFIX = ".cleanup-journal.json";
const ISOLATED_REMOVAL_COMPLETION_SUFFIX = ".contents-deleted.json";
const REMOVAL_HELPER_ATTESTATION_TIMEOUT_MS = 10_000;

function isolatedDirectoryRemovalRootPrefix(replayKey: string): string {
  const digest = createHash("sha256").update(path.resolve(replayKey)).digest("hex");
  return `${ISOLATED_REMOVAL_ROOT_PREFIX}${digest}-`;
}

export function canonicalFilesystemLockPath(lockPath: string): string {
  return path.resolve(lockPath);
}

export function filesystemLockReleaseKey(
  lockPath: string,
  generation: {
    pid: number;
    processStartIdentity: string | null;
    ownerNonce: string;
    createdAt?: string;
    sessionId?: string;
  },
): string {
  return JSON.stringify([
    canonicalFilesystemLockPath(lockPath),
    generation.pid,
    generation.processStartIdentity,
    generation.ownerNonce,
    generation.createdAt ?? null,
    generation.sessionId ?? null,
  ]);
}

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
    const isolation = await isolateDirectoryGenerationForRemoval(
      detachedPath,
      (generationPath) => lockGenerationMatches(generationPath, releasedGeneration),
      lockPath,
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
  let lockEntry: BigIntStats;
  try {
    lockEntry = await lstat(lockPath, { bigint: true });
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      return { status: "stale", generation: { ownerRaw: null, lastMutationMs: 0 } };
    }
    throw error;
  }
  if (!lockEntry.isDirectory()) {
    if (!lockEntry.isFile() || lockEntry.isSymbolicLink()) return { status: "active" };
    return inspectLegacyFilesystemLockFile(lockPath, lockEntry, options.readLiveness);
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
interface LegacyFilesystemLockRecord {
  readonly pid: number;
  readonly lockId: string;
  readonly createdAt: string;
  readonly sessionId?: string;
}

async function inspectLegacyFilesystemLockFile(
  lockPath: string,
  initialEntry: BigIntStats,
  readLiveness: (pid: number) => ProcessLiveness,
): Promise<FilesystemLockInspection> {
  let raw: string;
  let after: BigIntStats;
  try {
    raw = await readFile(lockPath, "utf8");
    after = await lstat(lockPath, { bigint: true });
  } catch {
    return { status: "active" };
  }
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    initialEntry.dev !== after.dev ||
    initialEntry.ino !== after.ino ||
    initialEntry.birthtimeNs !== after.birthtimeNs ||
    initialEntry.ctimeNs !== after.ctimeNs ||
    initialEntry.size !== after.size
  ) {
    return { status: "active" };
  }
  const legacy = parseLegacyFilesystemLockRecord(raw);
  if (legacy === null || readLiveness(legacy.pid) !== "dead") return { status: "active" };
  return {
    status: "stale",
    generation: {
      ownerRaw: null,
      legacyFile: {
        raw,
        device: after.dev.toString(),
        inode: after.ino.toString(),
        birthtimeNs: after.birthtimeNs.toString(),
        size: after.size.toString(),
      },
    },
  };
}

function parseLegacyFilesystemLockRecord(raw: string): LegacyFilesystemLockRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  if (
    (keys !== "createdAt,lockId,pid" && keys !== "createdAt,lockId,pid,sessionId") ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.lockId !== "string" ||
    value.lockId.length === 0 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    (value.sessionId !== undefined &&
      (typeof value.sessionId !== "string" || value.sessionId.length === 0))
  ) {
    return null;
  }
  return {
    pid: value.pid,
    lockId: value.lockId,
    createdAt: value.createdAt,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
  };
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

export async function lockGenerationMatches(
  lockPath: string,
  expectedGeneration: FilesystemLockGeneration,
): Promise<boolean> {
  if (expectedGeneration.legacyFile !== undefined) {
    return legacyFilesystemLockGenerationMatches(lockPath, expectedGeneration.legacyFile);
  }
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
async function legacyFilesystemLockGenerationMatches(
  lockPath: string,
  expected: NonNullable<FilesystemLockGeneration["legacyFile"]>,
): Promise<boolean> {
  let before: BigIntStats;
  let raw: string;
  let after: BigIntStats;
  try {
    before = await lstat(lockPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) return false;
    raw = await readFile(lockPath, "utf8");
    after = await lstat(lockPath, { bigint: true });
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return false;
    throw error;
  }
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.birthtimeNs === after.birthtimeNs &&
    before.ctimeNs === after.ctimeNs &&
    before.size === after.size &&
    raw === expected.raw &&
    after.dev.toString() === expected.device &&
    after.ino.toString() === expected.inode &&
    after.birthtimeNs.toString() === expected.birthtimeNs &&
    after.size.toString() === expected.size
  );
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

interface IsolatedDirectoryIdentity {
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
}

interface IsolatedDirectoryCleanupJournal {
  readonly version: 1;
  readonly platform: NodeJS.Platform;
  readonly journalNonce: string;
  readonly rootPath: string;
  readonly rootIdentity: IsolatedDirectoryIdentity;
  readonly generationName: typeof ISOLATED_REMOVAL_GENERATION_NAME;
  readonly generationIdentity: IsolatedDirectoryIdentity;
}

interface IsolatedDirectoryCleanupCompletion extends IsolatedDirectoryCleanupJournal {
  readonly contentsDeleted: true;
}

interface IsolatedDirectoryRemovalDeps {
  afterChildAttestation?: (rootPath: string) => void | Promise<void>;
}

interface RemovalHelperAttestation {
  readonly type: "attested";
  readonly token: string;
  readonly rootIdentity: IsolatedDirectoryIdentity;
  readonly generationIdentity: IsolatedDirectoryIdentity;
}

const BOUND_DIRECTORY_REMOVAL_HELPER = String.raw`
const fs = require("node:fs/promises");

function identity(entry) {
  return {
    device: entry.dev.toString(),
    inode: entry.ino.toString(),
    birthtimeNs: entry.birthtimeNs.toString(),
  };
}

function sameIdentity(left, right) {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs;
}

function writeMessage(message) {
  const deferred = Promise.withResolvers();
  process.stdout.write(JSON.stringify(message) + "\n", (error) => {
    if (error) deferred.reject(error);
    else deferred.resolve();
  });
  return deferred.promise;
}

async function readGo(token) {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    const newline = input.indexOf("\n");
    if (newline < 0) continue;
    const message = JSON.parse(input.slice(0, newline));
    if (!message || message.type !== "go" || message.token !== token) {
      throw new Error("Bound removal helper received an invalid go signal");
    }
    process.stdin.destroy();
    return;
  }
  throw new Error("Bound removal helper exited without an explicit go signal");
}

(async () => {
  const token = process.argv[1];
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Bound removal helper token is missing");
  }
  const entries = await fs.readdir(".");
  if (entries.length !== 1 || entries[0] !== "generation") {
    throw new Error("Bound removal root does not contain exactly one generation");
  }
  const rootEntry = await fs.lstat(".", { bigint: true });
  const generationEntry = await fs.lstat("generation", { bigint: true });
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new Error("Bound removal cwd is not a physical directory");
  }
  if (!generationEntry.isDirectory() || generationEntry.isSymbolicLink()) {
    throw new Error("Bound removal generation is not a physical directory");
  }
  const rootIdentity = identity(rootEntry);
  const generationIdentity = identity(generationEntry);
  await writeMessage({
    type: "attested",
    token,
    rootIdentity,
    generationIdentity,
  });
  await readGo(token);

  const currentEntries = await fs.readdir(".");
  if (currentEntries.length !== 1 || currentEntries[0] !== "generation") {
    throw new Error("Bound removal root changed after attestation");
  }
  const currentRoot = await fs.lstat(".", { bigint: true });
  const currentGeneration = await fs.lstat("generation", { bigint: true });
  if (!sameIdentity(identity(currentRoot), rootIdentity) ||
      !sameIdentity(identity(currentGeneration), generationIdentity)) {
    throw new Error("Bound removal generation changed after attestation");
  }
  await fs.rm("generation", {
    recursive: true,
    force: false,
    maxRetries: 10,
    retryDelay: 10,
  });
  if ((await fs.readdir(".")).length !== 0) {
    throw new Error("Bound removal root was not empty after generation deletion");
  }
  await writeMessage({ type: "completed", token });
})().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write((error && error.stack) || String(error), () => process.exit(1));
  },
);
`;

// The journal is durable before the candidate rename. A crash can therefore leave either an
// empty prepared root or the exact moved generation, and restart can distinguish both without
// recursively following the pathname.
export async function isolateDirectoryGenerationForRemoval(
  candidatePath: string,
  verifyGeneration: (generationPath: string) => Promise<boolean>,
  replayKey = candidatePath,
): Promise<
  | { status: "isolated"; rootPath: string; generationPath: string }
  | { status: "missing" }
  | { status: "changed" }
> {
  const canonicalCandidatePath = path.resolve(candidatePath);
  const parentPath = path.dirname(canonicalCandidatePath);
  const canonicalReplayKey = path.resolve(replayKey);
  if (path.dirname(canonicalReplayKey) !== parentPath) {
    throw new Error(`Isolated cleanup replay key escapes its parent directory: ${replayKey}`);
  }
  const rootPath = await mkdtemp(
    path.join(parentPath, isolatedDirectoryRemovalRootPrefix(canonicalReplayKey)),
  );
  try {
    await chmod(rootPath, 0o700);
  } catch (error) {
    await removeFreshEmptyIsolationRoot(rootPath);
    throw error;
  }

  const rootIdentity = await captureIsolatedDirectoryIdentity(rootPath);
  let generationIdentity: IsolatedDirectoryIdentity;
  try {
    generationIdentity = await captureIsolatedDirectoryIdentity(canonicalCandidatePath);
  } catch (error) {
    await removeFreshEmptyIsolationRoot(rootPath);
    if (readErrorCode(error) === "ENOENT") return { status: "missing" };
    throw error;
  }

  let matches: boolean;
  try {
    matches = await verifyGeneration(canonicalCandidatePath);
  } catch (error) {
    await removeFreshEmptyIsolationRoot(rootPath);
    throw error;
  }
  const candidateAfterVerification = await inspectIsolatedDirectoryIdentity(
    canonicalCandidatePath,
    generationIdentity,
  );
  if (!matches || candidateAfterVerification !== "matches") {
    await removeFreshEmptyIsolationRoot(rootPath);
    return candidateAfterVerification === "missing" ? { status: "missing" } : { status: "changed" };
  }

  const journal: IsolatedDirectoryCleanupJournal = {
    version: 1,
    platform: process.platform,
    journalNonce: randomUUID(),
    rootPath,
    rootIdentity,
    generationName: ISOLATED_REMOVAL_GENERATION_NAME,
    generationIdentity,
  };
  await persistIsolatedDirectoryCleanupJournal(journal);
  if ((await inspectIsolatedDirectoryIdentity(rootPath, rootIdentity)) !== "matches") {
    throw new Error(`Isolated cleanup root changed before generation move: ${rootPath}`);
  }

  const generationPath = path.join(rootPath, ISOLATED_REMOVAL_GENERATION_NAME);
  try {
    await renameLockPath(canonicalCandidatePath, generationPath);
  } catch (error) {
    try {
      await removeIsolatedDirectoryGeneration(rootPath);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Filesystem generation isolation and prepared-journal cleanup both failed at ${canonicalCandidatePath}`,
      );
    }
    if (readErrorCode(error) === "ENOENT") return { status: "missing" };
    throw error;
  }

  try {
    await syncDirectory(rootPath);
    await syncDirectory(parentPath);
    if (
      (await inspectIsolatedDirectoryIdentity(rootPath, rootIdentity)) !== "matches" ||
      (await inspectIsolatedDirectoryIdentity(generationPath, generationIdentity)) !== "matches"
    ) {
      throw new Error(`Filesystem isolated generation changed at ${canonicalCandidatePath}`);
    }
    matches = await verifyGeneration(generationPath);
    if (
      (await inspectIsolatedDirectoryIdentity(generationPath, generationIdentity)) !== "matches"
    ) {
      throw new Error(`Filesystem isolated generation changed at ${canonicalCandidatePath}`);
    }
  } catch (error) {
    await restoreIsolatedDirectoryGeneration(
      canonicalCandidatePath,
      rootPath,
      generationPath,
      journal,
    );
    throw error;
  }
  if (!matches) {
    await restoreIsolatedDirectoryGeneration(
      canonicalCandidatePath,
      rootPath,
      generationPath,
      journal,
    );
    return { status: "changed" };
  }
  return { status: "isolated", rootPath, generationPath };
}

export async function removeIsolatedDirectoryGeneration(
  rootPath: string,
  deps: IsolatedDirectoryRemovalDeps = {},
): Promise<void> {
  const canonicalRootPath = path.resolve(rootPath);
  const journalPath = isolatedDirectoryCleanupJournalPath(canonicalRootPath);
  const completionPath = isolatedDirectoryCleanupCompletionPath(canonicalRootPath);
  let journal: IsolatedDirectoryCleanupJournal;
  try {
    journal = await readIsolatedDirectoryCleanupJournal(journalPath);
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
    try {
      journal = await readIsolatedDirectoryCleanupCompletion(completionPath);
    } catch (completionError) {
      if (readErrorCode(completionError) === "ENOENT") {
        try {
          await lstat(canonicalRootPath);
        } catch (rootError) {
          if (readErrorCode(rootError) === "ENOENT") return;
          throw rootError;
        }
      }
      throw completionError;
    }
  }
  if (journal.rootPath !== canonicalRootPath) {
    throw new Error(`Isolated cleanup journal does not authorize ${canonicalRootPath}`);
  }

  const completion = await readIsolatedDirectoryCleanupCompletion(completionPath, true);
  if (completion !== null) {
    assertCleanupCompletionMatchesJournal(completion, journal);
    await finalizeIsolatedDirectoryCleanup(journal, journalPath, completionPath);
    return;
  }

  const rootStatus = await inspectIsolatedDirectoryIdentity(
    canonicalRootPath,
    journal.rootIdentity,
  );
  if (rootStatus !== "matches") {
    throw new Error(
      `Isolated cleanup root identity changed at ${canonicalRootPath}; cleanup remains pending`,
    );
  }
  const entries = await readdir(canonicalRootPath);
  if (entries.length === 0) {
    await persistIsolatedDirectoryCleanupCompletion(journal, completionPath);
  } else {
    if (entries.length !== 1 || entries[0] !== journal.generationName) {
      throw new Error(
        `Isolated cleanup root contains unjournaled entries at ${canonicalRootPath}; cleanup remains pending`,
      );
    }
    const generationPath = path.join(canonicalRootPath, journal.generationName);
    if (
      (await inspectIsolatedDirectoryIdentity(generationPath, journal.generationIdentity)) !==
      "matches"
    ) {
      throw new Error(
        `Isolated cleanup generation identity changed at ${generationPath}; cleanup remains pending`,
      );
    }
    await deleteIsolatedGenerationWithBoundHelper(journal, deps);
    await persistIsolatedDirectoryCleanupCompletion(journal, completionPath);
  }
  await finalizeIsolatedDirectoryCleanup(journal, journalPath, completionPath);
}
export async function replayPendingIsolatedDirectoryRemovals(
  parentPath: string,
  replayKey?: string,
): Promise<void> {
  const canonicalParentPath = path.resolve(parentPath);
  const canonicalReplayKey = replayKey === undefined ? undefined : path.resolve(replayKey);
  if (
    canonicalReplayKey !== undefined &&
    path.dirname(canonicalReplayKey) !== canonicalParentPath
  ) {
    throw new Error(`Isolated cleanup replay key escapes its parent directory: ${replayKey}`);
  }
  const rootPrefix =
    canonicalReplayKey === undefined
      ? ISOLATED_REMOVAL_ROOT_PREFIX
      : isolatedDirectoryRemovalRootPrefix(canonicalReplayKey);
  let entries: Dirent[];
  try {
    entries = await readdir(canonicalParentPath, { withFileTypes: true });
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return;
    throw error;
  }
  const journalNames = entries
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(rootPrefix) && name.endsWith(ISOLATED_REMOVAL_JOURNAL_SUFFIX))
    .sort();
  for (const journalName of journalNames) {
    const journalPath = path.join(canonicalParentPath, journalName);
    const journal = await readIsolatedDirectoryCleanupJournal(journalPath);
    if (path.dirname(journal.rootPath) !== canonicalParentPath) {
      throw new Error(`Isolated cleanup journal escapes its parent directory: ${journalPath}`);
    }
    await removeIsolatedDirectoryGeneration(journal.rootPath);
  }
}

async function restoreIsolatedDirectoryGeneration(
  candidatePath: string,
  rootPath: string,
  generationPath: string,
  journal: IsolatedDirectoryCleanupJournal,
): Promise<void> {
  if (
    (await inspectIsolatedDirectoryIdentity(rootPath, journal.rootIdentity)) !== "matches" ||
    (await inspectIsolatedDirectoryIdentity(generationPath, journal.generationIdentity)) !==
      "matches"
  ) {
    throw new Error(
      `Filesystem generation changed at ${candidatePath}; unexpected directory preserved at ${generationPath}`,
    );
  }
  try {
    await renameLockPath(generationPath, candidatePath);
    await syncDirectory(path.dirname(candidatePath));
  } catch (error) {
    throw new Error(
      `Filesystem generation changed at ${candidatePath}; unexpected directory preserved at ${generationPath}`,
      { cause: error },
    );
  }
  await removeIsolatedDirectoryGeneration(rootPath);
}

async function deleteIsolatedGenerationWithBoundHelper(
  journal: IsolatedDirectoryCleanupJournal,
  deps: IsolatedDirectoryRemovalDeps,
): Promise<void> {
  const token = randomUUID();
  const child = spawn(process.execPath, ["-e", BOUND_DIRECTORY_REMOVAL_HELPER, token], {
    cwd: journal.rootPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "",
      NODE_PATH: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let childError: Error | undefined;
  let stderr = "";
  child.once("error", (error) => {
    childError = error;
  });
  child.stdin.on("error", () => undefined);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 16_384) stderr += chunk.slice(0, 16_384 - stderr.length);
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  try {
    const attestation = parseRemovalHelperAttestation(
      await readRemovalHelperLine(iterator, REMOVAL_HELPER_ATTESTATION_TIMEOUT_MS),
    );
    if (
      attestation.token !== token ||
      !sameIsolatedDirectoryIdentity(attestation.rootIdentity, journal.rootIdentity) ||
      !sameIsolatedDirectoryIdentity(attestation.generationIdentity, journal.generationIdentity)
    ) {
      throw new Error(`Bound removal helper attested the wrong generation at ${journal.rootPath}`);
    }
    await deps.afterChildAttestation?.(journal.rootPath);
    child.stdin.end(`${JSON.stringify({ type: "go", token })}\n`);

    const completion = JSON.parse(await readRemovalHelperLine(iterator)) as unknown;
    if (
      !isPlainRecord(completion) ||
      completion.type !== "completed" ||
      completion.token !== token ||
      Object.keys(completion).sort().join(",") !== "token,type"
    ) {
      throw new Error(`Bound removal helper returned an invalid completion at ${journal.rootPath}`);
    }
    const [code, signal] =
      child.exitCode === null && child.signalCode === null
        ? await once(child, "exit")
        : [child.exitCode, child.signalCode];
    if (childError || code !== 0) {
      const detail =
        childError?.message ?? (stderr.trim() || `exit ${String(code)} signal ${String(signal)}`);
      throw new Error(`Bound removal helper failed at ${journal.rootPath}: ${detail}`);
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([once(child, "close").catch(() => undefined), delay(1_000)]);
    }
    throw error;
  } finally {
    lines.close();
  }
}

async function readRemovalHelperLine(
  iterator: AsyncIterator<string>,
  timeoutMs?: number,
): Promise<string> {
  const nextLine = iterator.next().then((result) => {
    if (result.done) throw new Error("Bound removal helper exited before completing its protocol");
    return result.value;
  });
  if (timeoutMs === undefined) return nextLine;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      nextLine,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Bound removal helper attestation timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function parseRemovalHelperAttestation(raw: string): RemovalHelperAttestation {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("Bound removal helper returned malformed attestation", { cause: error });
  }
  if (
    !isPlainRecord(value) ||
    value.type !== "attested" ||
    typeof value.token !== "string" ||
    Object.keys(value).sort().join(",") !== "generationIdentity,rootIdentity,token,type"
  ) {
    throw new Error("Bound removal helper returned invalid attestation");
  }
  const rootIdentity = parseIsolatedDirectoryIdentity(value.rootIdentity);
  const generationIdentity = parseIsolatedDirectoryIdentity(value.generationIdentity);
  if (rootIdentity === null || generationIdentity === null) {
    throw new Error("Bound removal helper returned invalid generation identity");
  }
  return {
    type: "attested",
    token: value.token,
    rootIdentity,
    generationIdentity,
  };
}

async function persistIsolatedDirectoryCleanupJournal(
  journal: IsolatedDirectoryCleanupJournal,
): Promise<void> {
  if (
    (await inspectIsolatedDirectoryIdentity(journal.rootPath, journal.rootIdentity)) !== "matches"
  ) {
    throw new Error(`Isolated cleanup root changed before journaling: ${journal.rootPath}`);
  }
  await writeDurableExclusiveJson(isolatedDirectoryCleanupJournalPath(journal.rootPath), journal);
}

async function persistIsolatedDirectoryCleanupCompletion(
  journal: IsolatedDirectoryCleanupJournal,
  completionPath: string,
): Promise<void> {
  const completion: IsolatedDirectoryCleanupCompletion = {
    ...journal,
    contentsDeleted: true,
  };
  try {
    await writeDurableExclusiveJson(completionPath, completion);
  } catch (error) {
    if (readErrorCode(error) !== "EEXIST") throw error;
    assertCleanupCompletionMatchesJournal(
      await readIsolatedDirectoryCleanupCompletion(completionPath),
      journal,
    );
  }
}

async function writeDurableExclusiveJson(filePath: string, value: unknown): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
}

async function readIsolatedDirectoryCleanupJournal(
  journalPath: string,
): Promise<IsolatedDirectoryCleanupJournal> {
  const value = await readStableCleanupJson(journalPath);
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "generationIdentity,generationName,journalNonce,platform,rootIdentity,rootPath,version" ||
    value.version !== 1 ||
    value.platform !== process.platform ||
    typeof value.journalNonce !== "string" ||
    value.journalNonce.length === 0 ||
    typeof value.rootPath !== "string" ||
    path.resolve(value.rootPath) !== value.rootPath ||
    value.generationName !== ISOLATED_REMOVAL_GENERATION_NAME
  ) {
    throw new Error(`Malformed isolated cleanup journal: ${journalPath}`);
  }
  const rootIdentity = parseIsolatedDirectoryIdentity(value.rootIdentity);
  const generationIdentity = parseIsolatedDirectoryIdentity(value.generationIdentity);
  if (
    rootIdentity === null ||
    generationIdentity === null ||
    isolatedDirectoryCleanupJournalPath(value.rootPath) !== path.resolve(journalPath)
  ) {
    throw new Error(`Malformed isolated cleanup journal: ${journalPath}`);
  }
  return {
    version: 1,
    platform: process.platform,
    journalNonce: value.journalNonce,
    rootPath: value.rootPath,
    rootIdentity,
    generationName: ISOLATED_REMOVAL_GENERATION_NAME,
    generationIdentity,
  };
}

async function readIsolatedDirectoryCleanupCompletion(
  completionPath: string,
  missingAsNull: true,
): Promise<IsolatedDirectoryCleanupCompletion | null>;
async function readIsolatedDirectoryCleanupCompletion(
  completionPath: string,
  missingAsNull?: false,
): Promise<IsolatedDirectoryCleanupCompletion>;
async function readIsolatedDirectoryCleanupCompletion(
  completionPath: string,
  missingAsNull = false,
): Promise<IsolatedDirectoryCleanupCompletion | null> {
  let value: unknown;
  try {
    value = await readStableCleanupJson(completionPath);
  } catch (error) {
    if (missingAsNull && readErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "contentsDeleted,generationIdentity,generationName,journalNonce,platform,rootIdentity,rootPath,version" ||
    value.contentsDeleted !== true ||
    value.version !== 1 ||
    value.platform !== process.platform ||
    typeof value.journalNonce !== "string" ||
    value.journalNonce.length === 0 ||
    typeof value.rootPath !== "string" ||
    path.resolve(value.rootPath) !== value.rootPath ||
    value.generationName !== ISOLATED_REMOVAL_GENERATION_NAME ||
    isolatedDirectoryCleanupCompletionPath(value.rootPath) !== path.resolve(completionPath)
  ) {
    throw new Error(`Malformed isolated cleanup completion receipt: ${completionPath}`);
  }
  const rootIdentity = parseIsolatedDirectoryIdentity(value.rootIdentity);
  const generationIdentity = parseIsolatedDirectoryIdentity(value.generationIdentity);
  if (rootIdentity === null || generationIdentity === null) {
    throw new Error(`Malformed isolated cleanup completion receipt: ${completionPath}`);
  }
  return {
    version: 1,
    platform: process.platform,
    journalNonce: value.journalNonce,
    rootPath: value.rootPath,
    rootIdentity,
    generationName: ISOLATED_REMOVAL_GENERATION_NAME,
    generationIdentity,
    contentsDeleted: true,
  };
}

async function readStableCleanupJson(filePath: string): Promise<unknown> {
  const before = await lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Cleanup authority is not a physical file: ${filePath}`);
  }
  const raw = await readFile(filePath, "utf8");
  const after = await lstat(filePath, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.birthtimeNs !== after.birthtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    before.size !== after.size
  ) {
    throw new Error(`Cleanup authority changed while being read: ${filePath}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Malformed cleanup authority JSON: ${filePath}`, { cause: error });
  }
}

async function finalizeIsolatedDirectoryCleanup(
  journal: IsolatedDirectoryCleanupJournal,
  journalPath: string,
  completionPath: string,
): Promise<void> {
  const rootStatus = await inspectIsolatedDirectoryIdentity(journal.rootPath, journal.rootIdentity);
  if (rootStatus === "changed") {
    throw new Error(
      `Isolated cleanup root identity changed at ${journal.rootPath}; cleanup remains pending`,
    );
  }
  if (rootStatus === "matches") {
    if ((await readdir(journal.rootPath)).length !== 0) {
      throw new Error(`Isolated cleanup root is not empty at ${journal.rootPath}`);
    }
    const deadline = Date.now() + WINDOWS_LOCK_MUTATION_TIMEOUT_MS;
    for (;;) {
      if (
        (await inspectIsolatedDirectoryIdentity(journal.rootPath, journal.rootIdentity)) !==
        "matches"
      ) {
        throw new Error(
          `Isolated cleanup root identity changed at ${journal.rootPath}; cleanup remains pending`,
        );
      }
      try {
        await rmdir(journal.rootPath);
        break;
      } catch (error) {
        if (readErrorCode(error) === "ENOENT") break;
        if (!isRetryableWindowsLockMutationError(error) || Date.now() >= deadline) throw error;
      }
      await delay(Math.min(WINDOWS_LOCK_MUTATION_RETRY_MS, Math.max(1, deadline - Date.now())));
    }
  }
  const parentPath = path.dirname(journal.rootPath);
  await syncDirectory(parentPath);
  try {
    await unlink(journalPath);
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
  }
  await syncDirectory(parentPath);
  try {
    await unlink(completionPath);
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
  }
  await syncDirectory(parentPath);
}

async function removeFreshEmptyIsolationRoot(rootPath: string): Promise<void> {
  try {
    await rmdir(rootPath);
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
  }
  await syncDirectoryIfPresent(path.dirname(rootPath));
}

async function captureIsolatedDirectoryIdentity(
  directoryPath: string,
): Promise<IsolatedDirectoryIdentity> {
  const entry = await lstat(directoryPath, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Cleanup authority is not a physical directory: ${directoryPath}`);
  }
  return {
    device: entry.dev.toString(),
    inode: entry.ino.toString(),
    birthtimeNs: entry.birthtimeNs.toString(),
  };
}

async function inspectIsolatedDirectoryIdentity(
  directoryPath: string,
  expected: IsolatedDirectoryIdentity,
): Promise<"matches" | "missing" | "changed"> {
  let current: IsolatedDirectoryIdentity;
  try {
    current = await captureIsolatedDirectoryIdentity(directoryPath);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return "missing";
    return "changed";
  }
  return sameIsolatedDirectoryIdentity(current, expected) ? "matches" : "changed";
}

function sameIsolatedDirectoryIdentity(
  left: IsolatedDirectoryIdentity,
  right: IsolatedDirectoryIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function parseIsolatedDirectoryIdentity(value: unknown): IsolatedDirectoryIdentity | null {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !== "birthtimeNs,device,inode" ||
    typeof value.device !== "string" ||
    typeof value.inode !== "string" ||
    typeof value.birthtimeNs !== "string" ||
    !/^(?:0|[1-9]\d*)$/u.test(value.device) ||
    !/^(?:0|[1-9]\d*)$/u.test(value.inode) ||
    !/^(?:0|[1-9]\d*)$/u.test(value.birthtimeNs)
  ) {
    return null;
  }
  return {
    device: value.device,
    inode: value.inode,
    birthtimeNs: value.birthtimeNs,
  };
}

function assertCleanupCompletionMatchesJournal(
  completion: IsolatedDirectoryCleanupCompletion,
  journal: IsolatedDirectoryCleanupJournal,
): void {
  if (
    completion.journalNonce !== journal.journalNonce ||
    completion.rootPath !== journal.rootPath ||
    completion.platform !== journal.platform ||
    !sameIsolatedDirectoryIdentity(completion.rootIdentity, journal.rootIdentity) ||
    !sameIsolatedDirectoryIdentity(completion.generationIdentity, journal.generationIdentity)
  ) {
    throw new Error(
      `Isolated cleanup completion does not match its journal at ${journal.rootPath}`,
    );
  }
}

function isolatedDirectoryCleanupJournalPath(rootPath: string): string {
  return `${rootPath}${ISOLATED_REMOVAL_JOURNAL_SUFFIX}`;
}

function isolatedDirectoryCleanupCompletionPath(rootPath: string): string {
  return `${rootPath}${ISOLATED_REMOVAL_COMPLETION_SUFFIX}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
