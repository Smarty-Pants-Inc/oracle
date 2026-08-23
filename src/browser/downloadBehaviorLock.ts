import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserLogger } from "./types.js";
import { isProcessAlive } from "./profileState.js";
import { delay } from "./utils.js";

const LOCK_FILENAME = "oracle-download-behavior.lock";
const RECOVERY_SUFFIX = ".recovery";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_MS = 100;
export interface BrowserDownloadBehaviorLockScope {
  /** Persistent profile directory for local manual-login Chrome. */
  profileDir?: string;
  /** Exact DevTools browser endpoint for attached/shared Chrome. */
  browserWSEndpoint?: string;
}

export interface BrowserDownloadBehaviorLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  logger?: BrowserLogger;
  isProcessAlive?: (pid: number) => boolean;
}

interface BrowserDownloadBehaviorLockRecord {
  pid: number;
  lockId: string;
  createdAt: string;
}

export interface BrowserDownloadBehaviorLock {
  path: string;
  lockId: string;
  release: () => Promise<void>;
}

export function resolveBrowserDownloadBehaviorLockPath(
  scope: BrowserDownloadBehaviorLockScope | undefined,
): string {
  const browserWSEndpoint = scope?.browserWSEndpoint?.trim();
  if (browserWSEndpoint) {
    return hashedBrowserLockPath(browserWSEndpoint);
  }

  const profileDir = scope?.profileDir?.trim();
  if (profileDir) {
    return path.join(path.resolve(profileDir), LOCK_FILENAME);
  }

  return hashedBrowserLockPath("unscoped");
}

function hashedBrowserLockPath(identity: string): string {
  const digest = createHash("sha256").update(identity, "utf8").digest("hex");
  return path.join(os.tmpdir(), "oracle-browser-download-locks", `${digest}.lock`);
}

export async function acquireBrowserDownloadBehaviorLock(
  scope: BrowserDownloadBehaviorLockScope | undefined,
  options: BrowserDownloadBehaviorLockOptions = {},
): Promise<BrowserDownloadBehaviorLock> {
  const timeoutMs =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const pollMs =
    typeof options.pollMs === "number" && Number.isFinite(options.pollMs) && options.pollMs > 0
      ? options.pollMs
      : DEFAULT_POLL_MS;
  const isOwnerAlive = options.isProcessAlive ?? isProcessAlive;
  const lockPath = resolveBrowserDownloadBehaviorLockPath(scope);
  const lockId = randomUUID();
  const candidatePath = `${lockPath}.${process.pid}.${lockId}.candidate`;
  const payload = JSON.stringify(createLockRecord(lockId));
  const startedAt = Date.now();
  let warned = false;

  const waitForNextAttempt = async (reason: string) => {
    const elapsed = Date.now() - startedAt;
    if (!warned) {
      options.logger?.(`[browser] Waiting for browser-wide download capture lock ${reason}.`);
      warned = true;
    }
    if (elapsed >= timeoutMs) {
      throw new Error(
        `Browser-wide download capture lock ${reason} after ${Math.round(elapsed / 1000)}s`,
      );
    }
    await delay(Math.min(pollMs, timeoutMs - elapsed));
  };

  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(candidatePath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    for (;;) {
      if (await hasLiveRecoveryMarker(lockPath, isOwnerAlive)) {
        await waitForNextAttempt("recovery to finish");
        continue;
      }

      try {
        // A hard link installs a complete candidate atomically without replacing an owner.
        await fs.link(candidatePath, lockPath);
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") {
          throw error;
        }

        const existing = await readLockRecord(lockPath);
        if (existing === undefined) {
          continue;
        }
        if (!existing) {
          throw new Error(`Browser download behavior lock is unreadable: ${lockPath}`);
        }
        if (!isOwnerAlive(existing.pid)) {
          await reclaimDeadBrowserDownloadBehaviorLock(lockPath, existing, isOwnerAlive);
          continue;
        }
        await waitForNextAttempt(`held by pid ${existing.pid}`);
        continue;
      }

      const installed = await readLockRecord(lockPath);
      if (!installed || installed.lockId !== lockId) {
        continue;
      }
      // A recovery started immediately before or during installation owns the transition.
      // Relinquish and retry rather than entering Browser.setDownloadBehavior beside it.
      if (await hasLiveRecoveryMarker(lockPath, isOwnerAlive)) {
        await releaseBrowserDownloadBehaviorLock(lockPath, lockId);
        await waitForNextAttempt("recovery to finish");
        continue;
      }
      return {
        path: lockPath,
        lockId,
        release: async () => releaseBrowserDownloadBehaviorLock(lockPath, lockId, options.logger),
      };
    }
  } finally {
    await fs.unlink(candidatePath).catch(() => undefined);
  }
}

async function reclaimDeadBrowserDownloadBehaviorLock(
  lockPath: string,
  observed: BrowserDownloadBehaviorLockRecord,
  isOwnerAlive: (pid: number) => boolean,
): Promise<void> {
  // Every contender waits for this immutable marker before it can enter the critical section.
  // That makes it safe to remove only the exact dead record below, even with several reclaimers.
  const recoveryPath = await createRecoveryMarker(lockPath);
  try {
    const current = await readLockRecord(lockPath);
    if (current === undefined) return;
    if (!current) {
      throw new Error(`Browser download behavior lock is unreadable: ${lockPath}`);
    }
    if (current.lockId !== observed.lockId || isOwnerAlive(current.pid)) return;
    await fs.unlink(lockPath).catch((error) => {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    });
  } finally {
    await fs.unlink(recoveryPath).catch(() => undefined);
  }
}

async function createRecoveryMarker(lockPath: string): Promise<string> {
  const markerPath = `${lockPath}.${process.pid}.${randomUUID()}${RECOVERY_SUFFIX}`;
  const candidatePath = `${markerPath}.candidate`;
  await fs.writeFile(candidatePath, JSON.stringify(createLockRecord(randomUUID())), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await fs.link(candidatePath, markerPath);
    return markerPath;
  } finally {
    await fs.unlink(candidatePath).catch(() => undefined);
  }
}

async function hasLiveRecoveryMarker(
  lockPath: string,
  isOwnerAlive: (pid: number) => boolean,
): Promise<boolean> {
  const lockDir = path.dirname(lockPath);
  const markerPrefix = `${path.basename(lockPath)}.`;
  let entries: string[];
  try {
    entries = await fs.readdir(lockDir);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.startsWith(markerPrefix) || !entry.endsWith(RECOVERY_SUFFIX)) continue;
    const markerPath = path.join(lockDir, entry);
    const marker = await readLockRecord(markerPath);
    if (marker === undefined) continue;
    if (!marker) {
      throw new Error(`Browser download behavior recovery marker is unreadable: ${markerPath}`);
    }
    if (isOwnerAlive(marker.pid)) return true;
    // This marker is unique to a dead reclaimer, so removing it cannot affect a live recovery.
    await fs.unlink(markerPath).catch(() => undefined);
  }
  return false;
}

async function releaseBrowserDownloadBehaviorLock(
  lockPath: string,
  lockId: string,
  logger?: BrowserLogger,
): Promise<void> {
  const releasePath = `${lockPath}.${process.pid}.${randomUUID()}.release`;
  try {
    await fs.link(lockPath, releasePath);
    const [owned, current] = await Promise.all([fs.stat(releasePath), fs.stat(lockPath)]);
    const record = await readLockRecord(releasePath);
    if (record?.lockId === lockId && owned.dev === current.dev && owned.ino === current.ino) {
      await fs.unlink(lockPath);
      logger?.("[browser] Released browser-wide download capture lock.");
    }
  } catch {
    // Best effort, and never remove a path that may now belong to another owner.
  } finally {
    await fs.unlink(releasePath).catch(() => undefined);
  }
}

function createLockRecord(lockId: string): BrowserDownloadBehaviorLockRecord {
  return {
    pid: process.pid,
    lockId,
    createdAt: new Date().toISOString(),
  };
}

async function readLockRecord(
  lockPath: string,
): Promise<BrowserDownloadBehaviorLockRecord | null | undefined> {
  try {
    return parseLockRecord(await fs.readFile(lockPath, "utf8"));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    return null;
  }
}

function parseLockRecord(payload: string): BrowserDownloadBehaviorLockRecord | null {
  try {
    const record = JSON.parse(payload) as BrowserDownloadBehaviorLockRecord;
    if (
      !Number.isFinite(record.pid) ||
      record.pid <= 0 ||
      typeof record.lockId !== "string" ||
      !record.lockId ||
      typeof record.createdAt !== "string"
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}
