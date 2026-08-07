import type { BigIntStats } from "node:fs";

export interface PhysicalFileGeneration {
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
}

export interface PhysicalFileSnapshot extends PhysicalFileGeneration {
  readonly ctimeNs: string;
}

export function physicalFileGenerationFromStats(
  entry: Pick<BigIntStats, "dev" | "ino" | "birthtimeNs">,
): PhysicalFileGeneration {
  return {
    device: entry.dev.toString(),
    inode: entry.ino.toString(),
    birthtimeNs: entry.birthtimeNs.toString(),
  };
}

export function physicalFileSnapshotFromStats(
  entry: Pick<BigIntStats, "dev" | "ino" | "birthtimeNs" | "ctimeNs">,
): PhysicalFileSnapshot {
  return {
    ...physicalFileGenerationFromStats(entry),
    ctimeNs: entry.ctimeNs.toString(),
  };
}

const CANONICAL_BIGINT_DECIMAL = /^(?:0|-?[1-9][0-9]*)$/u;

export function parsePhysicalFileGeneration(value: unknown): PhysicalFileGeneration | null {
  const record = physicalIdentityRecord(value, "birthtimeNs,device,inode");
  return record ? parsePhysicalFileGenerationFields(record) : null;
}

export function parsePhysicalFileSnapshot(value: unknown): PhysicalFileSnapshot | null {
  const record = physicalIdentityRecord(value, "birthtimeNs,ctimeNs,device,inode");
  if (!record) return null;
  const generation = parsePhysicalFileGenerationFields(record);
  if (!generation || !isCanonicalBigIntDecimal(record.ctimeNs)) return null;
  return { ...generation, ctimeNs: record.ctimeNs };
}

export function samePhysicalFileGeneration(
  left: PhysicalFileGeneration,
  right: PhysicalFileGeneration,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

export function samePhysicalFileSnapshot(
  left: PhysicalFileSnapshot,
  right: PhysicalFileSnapshot,
): boolean {
  return samePhysicalFileGeneration(left, right) && left.ctimeNs === right.ctimeNs;
}

function physicalIdentityRecord(
  value: unknown,
  expectedKeys: string,
): Record<string, unknown> | null {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === expectedKeys
    ? (value as Record<string, unknown>)
    : null;
}

function parsePhysicalFileGenerationFields(
  record: Record<string, unknown>,
): PhysicalFileGeneration | null {
  const { device, inode, birthtimeNs } = record;
  return isCanonicalBigIntDecimal(device) &&
    isCanonicalBigIntDecimal(inode) &&
    isCanonicalBigIntDecimal(birthtimeNs)
    ? { device, inode, birthtimeNs }
    : null;
}

function isCanonicalBigIntDecimal(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_BIGINT_DECIMAL.test(value);
}
