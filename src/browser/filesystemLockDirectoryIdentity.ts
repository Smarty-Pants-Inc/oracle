import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";

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
  return physicalDirectoryIdentityFromStats(entry);
}

export function parsePhysicalDirectoryIdentity(value: unknown): PhysicalDirectoryIdentity | null {
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
  return { device: value.device, inode: value.inode, birthtimeNs: value.birthtimeNs };
}

export function samePhysicalDirectoryIdentity(
  left: PhysicalDirectoryIdentity,
  right: PhysicalDirectoryIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
