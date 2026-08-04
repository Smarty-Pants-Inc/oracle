import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { delay } from "./utils.js";

const LOCK_OWNER_FILENAME = "owner.json";
const DEFAULT_POLL_MS = 50;
const DEFAULT_INCOMPLETE_STALE_MS = 5_000;
const execFileAsync = promisify(execFile);
export type ProcessLiveness = "alive" | "dead" | "unknown";

export interface FilesystemLockOwnerRecord {
  version: 1;
  pid: number;
  processStartIdentity: string | null;
  ownerNonce: string;
  createdAt: string;
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
}

export interface CrashRecoverableFilesystemLockDeps {
  now?: () => number;
  pid?: number;
  readProcessLiveness?: (pid: number) => ProcessLiveness;
  readProcessStartIdentity?: (pid: number) => Promise<string | null>;
  randomUUID?: () => string;
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
  const owner: FilesystemLockOwnerRecord = {
    version: 1,
    pid,
    processStartIdentity: await readProcessIdentity(pid),
    ownerNonce: createNonce(),
    createdAt: new Date(now()).toISOString(),
  };
  const startedAt = now();

  await mkdir(path.dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      await mkdir(lockPath, { recursive: false });
      try {
        await writeLockOwner(lockPath, owner);
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        await syncDirectory(path.dirname(lockPath));
        throw error;
      }
      let releasePromise: Promise<void> | undefined;
      return {
        path: lockPath,
        owner,
        release: () => (releasePromise ??= releaseCrashRecoverableFilesystemLock(lockPath, owner)),
      };
    } catch (error) {
      if (readErrorCode(error) !== "EEXIST") throw error;
    }

    let inspection = await inspectExistingLock(lockPath, {
      nowMs: now(),
      incompleteLockStaleMs,
      readLiveness,
      readProcessIdentity,
    });
    if (inspection.status === "stale") {
      inspection = await inspectExistingLock(lockPath, {
        nowMs: now(),
        incompleteLockStaleMs,
        readLiveness,
        readProcessIdentity,
      });
      if (inspection.status === "stale") {
        await quarantineStaleLock(lockPath, createNonce());
        continue;
      }
    }

    const elapsed = now() - startedAt;
    if (timeoutMs === 0 || elapsed >= timeoutMs) {
      throw new FilesystemLockBusyError(
        lockPath,
        inspection.status === "active" ? inspection.owner : undefined,
      );
    }
    await delay(Math.min(pollMs, Math.max(1, timeoutMs - elapsed)));
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
        { encoding: "utf8" },
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

async function releaseCrashRecoverableFilesystemLock(
  lockPath: string,
  expectedOwner: FilesystemLockOwnerRecord,
): Promise<void> {
  const owner = await readLockOwnerForRelease(lockPath);
  if (owner === null) return;
  if (
    owner.pid !== expectedOwner.pid ||
    owner.processStartIdentity !== expectedOwner.processStartIdentity ||
    owner.ownerNonce !== expectedOwner.ownerNonce
  ) {
    throw new Error(`Filesystem lock ownership changed at ${lockPath}`);
  }

  const releasedPath = `${lockPath}.released-${expectedOwner.ownerNonce}`;
  try {
    await rename(lockPath, releasedPath);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return;
    throw error;
  }

  const releasedOwner = await readLockOwnerForRelease(releasedPath);
  if (releasedOwner === null) {
    await syncDirectoryIfPresent(path.dirname(lockPath));
    return;
  }
  if (
    releasedOwner.pid !== expectedOwner.pid ||
    releasedOwner.processStartIdentity !== expectedOwner.processStartIdentity ||
    releasedOwner.ownerNonce !== expectedOwner.ownerNonce
  ) {
    try {
      await rename(releasedPath, lockPath);
      await syncDirectory(path.dirname(lockPath));
    } catch (restoreError) {
      throw new Error(
        `Filesystem lock ownership changed at ${lockPath}; unexpected lock preserved at ${releasedPath}`,
        { cause: restoreError },
      );
    }
    throw new Error(`Filesystem lock ownership changed at ${lockPath}`);
  }

  await syncDirectoryIfPresent(path.dirname(lockPath));
  await rm(releasedPath, { recursive: true, force: true });
  await syncDirectoryIfPresent(path.dirname(lockPath));
}

async function inspectExistingLock(
  lockPath: string,
  options: {
    nowMs: number;
    incompleteLockStaleMs: number;
    readLiveness: (pid: number) => ProcessLiveness;
    readProcessIdentity: (pid: number) => Promise<string | null>;
  },
): Promise<{ status: "active"; owner?: FilesystemLockOwnerRecord } | { status: "stale" }> {
  let raw: string | null = null;
  try {
    raw = await readFile(path.join(lockPath, LOCK_OWNER_FILENAME), "utf8");
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") raw = null;
  }

  if (raw !== null) {
    const owner = parseLockOwner(raw);
    if (owner) {
      const liveness = options.readLiveness(owner.pid);
      if (liveness === "dead") return { status: "stale" };
      if (liveness === "unknown") return { status: "active", owner };
      const observedIdentity = await options.readProcessIdentity(owner.pid);
      if (
        owner.processStartIdentity !== null &&
        observedIdentity !== null &&
        owner.processStartIdentity !== observedIdentity
      ) {
        return { status: "stale" };
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
    ? { status: "stale" }
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

async function quarantineStaleLock(lockPath: string, nonce: string): Promise<boolean> {
  const stalePath = `${lockPath}.stale-${nonce}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return false;
    throw error;
  }
  await syncDirectory(path.dirname(lockPath));
  await rm(stalePath, { recursive: true, force: true });
  await syncDirectory(path.dirname(lockPath));
  return true;
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
      parsed.processStartIdentity !== null &&
      (typeof parsed.processStartIdentity !== "string" || parsed.processStartIdentity.length === 0)
    ) {
      return null;
    }
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

function readErrorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}
