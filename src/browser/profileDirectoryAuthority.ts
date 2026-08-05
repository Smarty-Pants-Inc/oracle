import path from "node:path";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";

export type ProfileStateLogger = (message: string) => void;
interface PlatformPath {
  isAbsolute(candidate: string): boolean;
  resolve(...pathSegments: string[]): string;
}
const PHYSICAL_PROFILE_IDENTITY_VERSION = 1 as const;

export interface ProfileDirectoryIdentity {
  readonly version: typeof PHYSICAL_PROFILE_IDENTITY_VERSION;
  readonly platform: NodeJS.Platform;
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
}
export async function captureProfileDirectoryIdentity(
  userDataDir: string,
  options: { create?: boolean } = {},
): Promise<ProfileDirectoryIdentity> {
  const resolvedPath = path.resolve(userDataDir);
  if (options.create) {
    await rejectProfileSymlinkTraversal(resolvedPath, { allowMissing: true });
    await mkdir(resolvedPath, { recursive: true });
  }
  await rejectProfileSymlinkTraversal(resolvedPath);
  const canonicalPath = await realpath(resolvedPath);
  const physical = await stat(canonicalPath, { bigint: true });
  if (!physical.isDirectory()) {
    throw new Error(`Profile path is not a directory: ${userDataDir}`);
  }
  return Object.freeze({
    version: PHYSICAL_PROFILE_IDENTITY_VERSION,
    platform: process.platform,
    canonicalPath,
    device: physical.dev.toString(),
    inode: physical.ino.toString(),
  });
}

export async function verifyProfileDirectoryIdentity(
  userDataDir: string,
  expected: ProfileDirectoryIdentity,
): Promise<boolean> {
  const parsed = parseProfileDirectoryIdentity(expected, expected.platform);
  if (!parsed || expected.platform !== process.platform) return false;
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

export function sameProfileDirectoryIdentity(
  left: ProfileDirectoryIdentity,
  right: ProfileDirectoryIdentity,
): boolean {
  return (
    left.version === right.version &&
    left.platform === right.platform &&
    samePlatformPath(left.canonicalPath, right.canonicalPath, left.platform) &&
    left.device === right.device &&
    left.inode === right.inode
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

function samePlatformPath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalizedLeft = pathApi.resolve(left);
  const normalizedRight = pathApi.resolve(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
export function parseProfileDirectoryIdentity(
  value: unknown,
  platform: NodeJS.Platform,
): ProfileDirectoryIdentity | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== PHYSICAL_PROFILE_IDENTITY_VERSION ||
    record.platform !== platform ||
    typeof record.canonicalPath !== "string" ||
    !pathForPlatform(platform).isAbsolute(record.canonicalPath) ||
    typeof record.device !== "string" ||
    !/^\d+$/u.test(record.device) ||
    typeof record.inode !== "string" ||
    !/^\d+$/u.test(record.inode)
  ) {
    return null;
  }
  return Object.freeze({
    version: PHYSICAL_PROFILE_IDENTITY_VERSION,
    platform,
    canonicalPath: pathForPlatform(platform).resolve(record.canonicalPath),
    device: record.device,
    inode: record.inode,
  });
}

function pathForPlatform(platform: NodeJS.Platform): PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}
