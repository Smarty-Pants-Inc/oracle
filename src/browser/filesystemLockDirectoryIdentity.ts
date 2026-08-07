import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import {
  parsePhysicalFileGeneration,
  physicalFileGenerationFromStats,
  samePhysicalFileGeneration,
  type PhysicalFileGeneration,
} from "../physicalFileIdentity.js";

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

export type PhysicalDirectoryIdentity = PhysicalFileGeneration;

export function physicalDirectoryIdentityFromStats(entry: BigIntStats): PhysicalDirectoryIdentity {
  return physicalFileGenerationFromStats(entry);
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
  const identity = parsePhysicalFileGeneration(value);
  if (!identity || (!options.allowZeroBirthtime && identity.birthtimeNs === "0")) return null;
  return identity;
}

export function samePhysicalDirectoryIdentity(
  left: PhysicalDirectoryIdentity,
  right: PhysicalDirectoryIdentity,
  options: PhysicalDirectoryIdentityOptions = {},
): boolean {
  return (
    (options.allowZeroBirthtime || (left.birthtimeNs !== "0" && right.birthtimeNs !== "0")) &&
    samePhysicalFileGeneration(left, right)
  );
}
