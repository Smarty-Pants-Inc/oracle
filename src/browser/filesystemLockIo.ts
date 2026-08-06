import path from "node:path";
import { lstat, readdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import {
  physicalDirectoryIdentityFromStats,
  samePhysicalDirectoryIdentity,
} from "./filesystemLockDirectoryIdentity.js";
import type { PhysicalDirectoryIdentity } from "./filesystemLockDirectoryIdentity.js";
import { delay } from "./utils.js";
export { syncDirectory, syncDirectoryIfPresent } from "../fsDurability.js";

export { capturePhysicalDirectoryIdentity } from "./filesystemLockDirectoryIdentity.js";
export type { PhysicalDirectoryIdentity };

export const WINDOWS_LOCK_MUTATION_RETRY_MS = 10;
export const WINDOWS_LOCK_MUTATION_TIMEOUT_MS = 1_000;

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

export async function removePreparedLockDirectory(
  directoryPath: string,
  expectedIdentity: PhysicalDirectoryIdentity,
  allowedFileNames: readonly string[],
): Promise<void> {
  let directoryEntry: BigIntStats;
  try {
    directoryEntry = await lstat(directoryPath, { bigint: true });
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return;
    throw error;
  }
  if (
    !directoryEntry.isDirectory() ||
    directoryEntry.isSymbolicLink() ||
    !samePhysicalDirectoryIdentity(
      physicalDirectoryIdentityFromStats(directoryEntry),
      expectedIdentity,
    )
  ) {
    throw new Error(`Prepared filesystem lock directory changed at ${directoryPath}`);
  }

  const allowed = new Set(allowedFileNames);
  for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
    if (!allowed.has(entry.name)) {
      throw new Error(
        `Prepared filesystem lock directory contains an unexpected entry: ${entry.name}`,
      );
    }
    const entryPath = path.join(directoryPath, entry.name);
    const before = await lstat(entryPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error(`Prepared filesystem lock entry is not a physical file: ${entryPath}`);
    }
    const currentDirectory = await lstat(directoryPath, { bigint: true });
    const current = await lstat(entryPath, { bigint: true });
    if (
      !samePhysicalDirectoryIdentity(
        physicalDirectoryIdentityFromStats(currentDirectory),
        expectedIdentity,
      ) ||
      !samePhysicalDirectoryIdentity(
        physicalDirectoryIdentityFromStats(before),
        physicalDirectoryIdentityFromStats(current),
      )
    ) {
      throw new Error(`Prepared filesystem lock generation changed at ${directoryPath}`);
    }
    await unlink(entryPath);
  }

  const after = await lstat(directoryPath, { bigint: true });
  if (
    !samePhysicalDirectoryIdentity(physicalDirectoryIdentityFromStats(after), expectedIdentity) ||
    (await readdir(directoryPath)).length !== 0
  ) {
    throw new Error(
      `Prepared filesystem lock generation changed before removal at ${directoryPath}`,
    );
  }
  await rmdir(directoryPath);
}

export function isRetryableWindowsLockMutationError(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = readErrorCode(error);
  return code === "EACCES" || code === "EBUSY" || code === "EPERM";
}

export async function lockPathExists(lockPath: string): Promise<boolean> {
  try {
    await stat(lockPath);
    return true;
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export function readErrorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}
