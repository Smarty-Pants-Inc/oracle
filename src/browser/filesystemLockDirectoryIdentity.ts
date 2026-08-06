import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";

export class PhysicalDirectoryIdentityUnavailableError extends Error {
  readonly code = "ERR_ORACLE_PHYSICAL_DIRECTORY_IDENTITY_UNAVAILABLE";

  constructor(readonly directoryPath: string) {
    super(
      `Filesystem directory ${directoryPath} reports birthtimeNs=0. Durable replacement-safe directory authority requires storage with stable nonzero birth time; move ORACLE_HOME_DIR and related session, lock, or artifact storage to a compatible filesystem.`,
    );
    this.name = "PhysicalDirectoryIdentityUnavailableError";
  }
}

export interface PhysicalDirectoryIdentityOptions {
  readonly allowZeroBirthtime?: boolean;
}

export interface PhysicalDirectoryIdentity {
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
}

export function physicalDirectoryIdentityFromStats(entry: BigIntStats): PhysicalDirectoryIdentity {
  return {
    device: entry.dev.toString(),
    inode: entry.ino.toString(),
    birthtimeNs: entry.birthtimeNs.toString(),
  };
}

export async function capturePhysicalDirectoryIdentity(
  directoryPath: string,
): Promise<PhysicalDirectoryIdentity> {
  const entry = await lstat(directoryPath, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Filesystem path is not a physical directory: ${directoryPath}`);
  }
  if (entry.birthtimeNs === 0n) {
    throw new PhysicalDirectoryIdentityUnavailableError(directoryPath);
  }
  return physicalDirectoryIdentityFromStats(entry);
}

export function parsePhysicalDirectoryIdentity(
  value: unknown,
  options: PhysicalDirectoryIdentityOptions = {},
): PhysicalDirectoryIdentity | null {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !== "birthtimeNs,device,inode" ||
    typeof value.device !== "string" ||
    typeof value.inode !== "string" ||
    typeof value.birthtimeNs !== "string" ||
    !/^(?:0|[1-9]\d*)$/u.test(value.device) ||
    !/^(?:0|[1-9]\d*)$/u.test(value.inode) ||
    !/^(?:0|[1-9]\d*)$/u.test(value.birthtimeNs) ||
    (!options.allowZeroBirthtime && value.birthtimeNs === "0")
  ) {
    return null;
  }
  return { device: value.device, inode: value.inode, birthtimeNs: value.birthtimeNs };
}

export function samePhysicalDirectoryIdentity(
  left: PhysicalDirectoryIdentity,
  right: PhysicalDirectoryIdentity,
  options: PhysicalDirectoryIdentityOptions = {},
): boolean {
  return (
    (options.allowZeroBirthtime || (left.birthtimeNs !== "0" && right.birthtimeNs !== "0")) &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
