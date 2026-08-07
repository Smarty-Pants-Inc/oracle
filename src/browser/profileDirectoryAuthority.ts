import path from "node:path";
import { constants } from "node:fs";
import type { BigIntStats, Stats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import {
  PhysicalDirectoryIdentityUnavailableError,
  physicalDirectoryIdentityFromStats,
  parsePhysicalDirectoryIdentity,
  samePhysicalDirectoryIdentity,
  type PhysicalDirectoryIdentity,
} from "./filesystemLockDirectoryIdentity.js";

export type ProfileStateLogger = (message: string) => void;

interface PlatformPath {
  isAbsolute(candidate: string): boolean;
  resolve(...pathSegments: string[]): string;
}

const PROFILE_IDENTITY_VERSION = 2 as const;
const hasDirectoryCapabilityFlags =
  Number.isInteger(constants.O_RDONLY) &&
  Number.isInteger(constants.O_DIRECTORY) &&
  Number.isInteger(constants.O_NOFOLLOW);
const directoryOpenFlags = hasDirectoryCapabilityFlags
  ? constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  : 0;

export interface ProfileDirectoryIdentity extends PhysicalDirectoryIdentity {
  readonly version: typeof PROFILE_IDENTITY_VERSION;
  readonly platform: NodeJS.Platform;
  readonly canonicalPath: string;
}

export async function captureProfileDirectoryIdentity(
  userDataDir: string,
  options: { create?: boolean } = {},
): Promise<ProfileDirectoryIdentity> {
  const resolvedPath = path.resolve(userDataDir);
  if (options.create) {
    await rejectProfileSymlinkTraversal(resolvedPath, { allowMissing: true });
    await assertProfileCreationStorageBirthtime(resolvedPath);
    await mkdir(resolvedPath, { recursive: true });
  }
  await rejectProfileSymlinkTraversal(resolvedPath);
  const canonicalPath = await realpath(resolvedPath);
  const stats = await captureAuthenticatedProfileDirectory(canonicalPath);
  return Object.freeze({
    version: PROFILE_IDENTITY_VERSION,
    platform: process.platform,
    canonicalPath,
    ...physicalDirectoryIdentityFromStats(stats),
  });
}

async function captureAuthenticatedProfileDirectory(canonicalPath: string): Promise<BigIntStats> {
  const before = await lstat(canonicalPath, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`Profile path is not a physical directory: ${canonicalPath}`);
  }
  assertStableProfileDirectoryBirthtime(before, canonicalPath);

  if (process.platform === "win32") {
    const after = await lstat(canonicalPath, { bigint: true });
    assertStableProfileDirectoryBirthtime(after, canonicalPath);
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      !samePhysicalDirectoryIdentity(
        physicalDirectoryIdentityFromStats(before),
        physicalDirectoryIdentityFromStats(after),
      )
    ) {
      throw new Error(
        `Profile directory generation changed while authenticating: ${canonicalPath}`,
      );
    }
    return after;
  }

  const handle = await open(canonicalPath, directoryOpenFlags);
  try {
    const authenticated = await handle.stat({ bigint: true });
    const after = await lstat(canonicalPath, { bigint: true });
    assertStableProfileDirectoryBirthtime(authenticated, canonicalPath);
    assertStableProfileDirectoryBirthtime(after, canonicalPath);
    if (
      !authenticated.isDirectory() ||
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      !samePhysicalDirectoryIdentity(
        physicalDirectoryIdentityFromStats(before),
        physicalDirectoryIdentityFromStats(authenticated),
      ) ||
      !samePhysicalDirectoryIdentity(
        physicalDirectoryIdentityFromStats(authenticated),
        physicalDirectoryIdentityFromStats(after),
      )
    ) {
      throw new Error(
        `Profile directory generation changed while authenticating: ${canonicalPath}`,
      );
    }
    return authenticated;
  } finally {
    await handle.close();
  }
}

async function assertProfileCreationStorageBirthtime(resolvedPath: string): Promise<void> {
  let ancestor = resolvedPath;
  while (true) {
    try {
      const entry = await lstat(ancestor, { bigint: true });
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Profile path is not a physical directory: ${ancestor}`);
      }
      assertStableProfileDirectoryBirthtime(entry, ancestor);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

function assertStableProfileDirectoryBirthtime(stats: BigIntStats, canonicalPath: string): void {
  if (stats.birthtimeNs === 0n) {
    throw new PhysicalDirectoryIdentityUnavailableError(canonicalPath);
  }
}

export async function verifyProfileDirectoryIdentity(
  userDataDir: string,
  expected: ProfileDirectoryIdentity,
): Promise<boolean> {
  const parsed = parseProfileDirectoryIdentity(expected, process.platform);
  if (!parsed) return false;
  try {
    const current = await captureProfileDirectoryIdentity(userDataDir);
    return sameProfileDirectoryIdentity(current, parsed);
  } catch {
    return false;
  }
}

export async function assertProfileDirectoryIdentity(
  userDataDir: string,
  expected: ProfileDirectoryIdentity,
  operation: string,
): Promise<void> {
  if (!(await verifyProfileDirectoryIdentity(userDataDir, expected))) {
    throw new Error(
      `${operation} refused because the physical profile directory changed: ${userDataDir}`,
    );
  }
}

export function samePhysicalProfileDirectoryIdentity(
  left: ProfileDirectoryIdentity,
  right: ProfileDirectoryIdentity,
): boolean {
  return (
    left.version === PROFILE_IDENTITY_VERSION &&
    right.version === PROFILE_IDENTITY_VERSION &&
    left.platform === right.platform &&
    samePhysicalDirectoryIdentity(left, right)
  );
}

export function sameProfileDirectoryIdentity(
  left: ProfileDirectoryIdentity,
  right: ProfileDirectoryIdentity,
): boolean {
  return (
    samePhysicalProfileDirectoryIdentity(left, right) &&
    sameProfileDirectoryPath(left.canonicalPath, right.canonicalPath, left.platform)
  );
}

async function rejectProfileSymlinkTraversal(
  resolvedPath: string,
  options: { allowMissing?: boolean } = {},
): Promise<void> {
  const root = path.parse(resolvedPath).root;
  const relative = path.relative(root, resolvedPath);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let entry: Stats;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (options.allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!entry.isSymbolicLink()) continue;
    const isDarwinSystemRootAlias =
      process.platform === "darwin" && ["/etc", "/tmp", "/var"].includes(current);
    if (!isDarwinSystemRootAlias) {
      throw new Error(`Profile directory traverses a symlink or reparse point: ${current}`);
    }
  }
}

function profileDirectoryPathComparisonKey(
  candidate: string,
  platform: NodeJS.Platform,
): string | null {
  const pathApi = pathForPlatform(platform);
  if (!pathApi.isAbsolute(candidate)) return null;
  const resolved = pathApi.resolve(candidate);
  const aliased =
    platform === "darwin" && /^\/(?:etc|tmp|var)(?:\/|$)/u.test(resolved)
      ? `/private${resolved}`
      : resolved;
  return platform === "win32" ? aliased.toLowerCase() : aliased;
}

export function sameProfileDirectoryPath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const normalizedLeft = profileDirectoryPathComparisonKey(left, platform);
  const normalizedRight = profileDirectoryPathComparisonKey(right, platform);
  return normalizedLeft !== null && normalizedRight !== null && normalizedLeft === normalizedRight;
}

export function parseProfileDirectoryIdentity(
  value: unknown,
  platform: NodeJS.Platform,
): ProfileDirectoryIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== PROFILE_IDENTITY_VERSION ||
    record.platform !== platform ||
    typeof record.canonicalPath !== "string" ||
    !pathForPlatform(platform).isAbsolute(record.canonicalPath) ||
    Object.keys(record).sort().join(",") !==
      "birthtimeNs,canonicalPath,device,inode,platform,version"
  ) {
    return null;
  }
  const physical = parsePhysicalDirectoryIdentity({
    device: record.device,
    inode: record.inode,
    birthtimeNs: record.birthtimeNs,
  });
  if (!physical) return null;
  return Object.freeze({
    version: PROFILE_IDENTITY_VERSION,
    platform,
    canonicalPath: pathForPlatform(platform).resolve(record.canonicalPath),
    ...physical,
  });
}

function pathForPlatform(platform: NodeJS.Platform): PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}
