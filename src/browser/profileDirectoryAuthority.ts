import { randomBytes } from "node:crypto";
import path from "node:path";
import { constants } from "node:fs";
import type { BigIntStats, Stats } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import {
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
const BIRTHTIME_PROFILE_IDENTITY_VERSION = 2 as const;
const MARKER_PROFILE_IDENTITY_VERSION = 3 as const;
const PROFILE_GENERATION_MARKER_FILENAME = ".oracle-profile-generation";
const PROFILE_GENERATION_MARKER_PREFIX = "oracle-profile-generation-v1:";
const PROFILE_GENERATION_MARKER_PATTERN = /^oracle-profile-generation-v1:([0-9a-f]{64})\n$/u;
const PROFILE_GENERATION_MARKER_SIZE = PROFILE_GENERATION_MARKER_PREFIX.length + 65;
const hasDirectoryCapabilityFlags =
  Number.isInteger(constants.O_RDONLY) &&
  Number.isInteger(constants.O_DIRECTORY) &&
  Number.isInteger(constants.O_NOFOLLOW);
const directoryOpenFlags = hasDirectoryCapabilityFlags
  ? constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  : 0;

export interface ProfileDirectoryGenerationMarker {
  readonly device: string;
  readonly inode: string;
  readonly ctimeNs: string;
  readonly token: string;
}

export interface ProfileDirectoryIdentity extends PhysicalDirectoryIdentity {
  readonly version:
    | typeof BIRTHTIME_PROFILE_IDENTITY_VERSION
    | typeof MARKER_PROFILE_IDENTITY_VERSION;
  readonly platform: NodeJS.Platform;
  readonly canonicalPath: string;
  readonly generationMarker?: ProfileDirectoryGenerationMarker;
}

interface AuthenticatedProfileDirectory {
  readonly stats: BigIntStats;
  readonly generationMarker?: ProfileDirectoryGenerationMarker;
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
  const authenticated = await captureAuthenticatedProfileDirectory(canonicalPath);
  const physicalIdentity = physicalDirectoryIdentityFromStats(authenticated.stats);
  if (physicalIdentity.birthtimeNs === "0") {
    if (
      process.platform !== "linux" ||
      physicalIdentity.inode === "0" ||
      !authenticated.generationMarker ||
      authenticated.generationMarker.device !== physicalIdentity.device
    ) {
      throw profileGenerationPrerequisiteError(canonicalPath);
    }
    return Object.freeze({
      version: MARKER_PROFILE_IDENTITY_VERSION,
      platform: process.platform,
      canonicalPath,
      ...physicalIdentity,
      generationMarker: authenticated.generationMarker,
    });
  }
  return Object.freeze({
    version: BIRTHTIME_PROFILE_IDENTITY_VERSION,
    platform: process.platform,
    canonicalPath,
    ...physicalIdentity,
  });
}

async function captureAuthenticatedProfileDirectory(
  canonicalPath: string,
): Promise<AuthenticatedProfileDirectory> {
  const before = await lstat(canonicalPath, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`Profile path is not a physical directory: ${canonicalPath}`);
  }
  if (process.platform === "win32") {
    const after = await lstat(canonicalPath, { bigint: true });
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
    return { stats: after };
  }

  const handle = await open(canonicalPath, directoryOpenFlags);
  try {
    const authenticated = await handle.stat({ bigint: true });
    const after = await lstat(canonicalPath, { bigint: true });
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
    if (authenticated.birthtimeNs === 0n && authenticated.ino <= 0n) {
      throw profileGenerationPrerequisiteError(canonicalPath);
    }
    const generationMarker =
      authenticated.birthtimeNs === 0n
        ? await captureLinuxProfileGenerationMarker(handle, authenticated, canonicalPath)
        : undefined;
    const finalEntry = await lstat(canonicalPath, { bigint: true });
    if (
      !finalEntry.isDirectory() ||
      finalEntry.isSymbolicLink() ||
      !samePhysicalDirectoryIdentity(
        physicalDirectoryIdentityFromStats(authenticated),
        physicalDirectoryIdentityFromStats(finalEntry),
      )
    ) {
      throw new Error(
        `Profile directory generation changed while authenticating: ${canonicalPath}`,
      );
    }
    return { stats: authenticated, generationMarker };
  } finally {
    await handle.close();
  }
}

async function captureLinuxProfileGenerationMarker(
  directoryHandle: FileHandle,
  directoryStats: BigIntStats,
  canonicalPath: string,
): Promise<ProfileDirectoryGenerationMarker> {
  if (process.platform !== "linux" || !hasDirectoryCapabilityFlags) {
    throw profileGenerationPrerequisiteError(canonicalPath);
  }
  const markerPath = path.join(
    "/proc/self/fd",
    directoryHandle.fd.toString(),
    PROFILE_GENERATION_MARKER_FILENAME,
  );
  try {
    try {
      return await readLinuxProfileGenerationMarker(markerPath, directoryStats);
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") throw error;
    }

    const token = randomBytes(32).toString("hex");
    let markerHandle: FileHandle | undefined;
    try {
      markerHandle = await open(
        markerPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await markerHandle.writeFile(`${PROFILE_GENERATION_MARKER_PREFIX}${token}\n`, "utf8");
      await markerHandle.sync();
    } catch (error) {
      if (readErrorCode(error) !== "EEXIST") throw error;
    } finally {
      await markerHandle?.close();
    }
    await directoryHandle.sync();
    return await readLinuxProfileGenerationMarker(markerPath, directoryStats);
  } catch (error) {
    throw profileGenerationPrerequisiteError(canonicalPath, error);
  }
}

async function readLinuxProfileGenerationMarker(
  markerPath: string,
  directoryStats: BigIntStats,
): Promise<ProfileDirectoryGenerationMarker> {
  const markerHandle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await markerHandle.stat({ bigint: true });
    assertTrustworthyProfileGenerationMarker(before, directoryStats, markerPath);
    const markerBuffer = Buffer.alloc(PROFILE_GENERATION_MARKER_SIZE + 1);
    const { bytesRead } = await markerHandle.read(markerBuffer, 0, markerBuffer.length, 0);
    const raw = markerBuffer.subarray(0, bytesRead).toString("utf8");
    const after = await markerHandle.stat({ bigint: true });
    const linked = await lstat(markerPath, { bigint: true });
    if (
      !sameProfileGenerationMarkerStats(before, after) ||
      !sameProfileGenerationMarkerStats(after, linked)
    ) {
      throw new Error(`Profile generation marker changed while reading: ${markerPath}`);
    }
    const match = PROFILE_GENERATION_MARKER_PATTERN.exec(raw);
    if (!match) throw new Error(`Profile generation marker is invalid: ${markerPath}`);
    return Object.freeze({
      device: after.dev.toString(),
      inode: after.ino.toString(),
      ctimeNs: after.ctimeNs.toString(),
      token: match[1],
    });
  } finally {
    await markerHandle.close();
  }
}

function assertTrustworthyProfileGenerationMarker(
  marker: BigIntStats,
  directory: BigIntStats,
  markerPath: string,
): void {
  const permissions = marker.mode & 0o777n;
  if (
    !marker.isFile() ||
    marker.isSymbolicLink() ||
    marker.nlink !== 1n ||
    marker.dev !== directory.dev ||
    marker.uid !== directory.uid ||
    (permissions & 0o077n) !== 0n ||
    (permissions & 0o400n) !== 0o400n ||
    marker.ino <= 0n ||
    marker.ctimeNs <= 0n ||
    marker.size !== BigInt(PROFILE_GENERATION_MARKER_SIZE)
  ) {
    throw new Error(`Profile generation marker is not owner-private and stable: ${markerPath}`);
  }
}

function sameProfileGenerationMarkerStats(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.ctimeNs === right.ctimeNs &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink
  );
}

function profileGenerationPrerequisiteError(canonicalPath: string, cause?: unknown): Error {
  return new Error(
    `Profile directory ${canonicalPath} has no filesystem birth time. Oracle requires stable nonzero inode/ctime metadata, atomic owner-private file creation, and /proc/self/fd access for its Linux generation marker. Relocate ORACLE_HOME_DIR and ORACLE_BROWSER_PROFILE_DIR to compatible storage or repair the marker after stopping Oracle and Chrome.`,
    cause === undefined ? undefined : { cause },
  );
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
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
  if (
    left.version !== right.version ||
    left.platform !== right.platform ||
    left.device !== right.device ||
    left.inode !== right.inode
  ) {
    return false;
  }
  if (left.version === BIRTHTIME_PROFILE_IDENTITY_VERSION) {
    return (
      left.birthtimeNs !== "0" &&
      right.birthtimeNs !== "0" &&
      left.birthtimeNs === right.birthtimeNs &&
      left.generationMarker === undefined &&
      right.generationMarker === undefined
    );
  }
  if (left.version !== MARKER_PROFILE_IDENTITY_VERSION) return false;
  const leftMarker = left.generationMarker;
  const rightMarker = right.generationMarker;
  return Boolean(
    left.platform === "linux" &&
    left.birthtimeNs === "0" &&
    right.birthtimeNs === "0" &&
    leftMarker &&
    rightMarker &&
    leftMarker.device === left.device &&
    rightMarker.device === right.device &&
    leftMarker.inode === rightMarker.inode &&
    leftMarker.ctimeNs === rightMarker.ctimeNs &&
    leftMarker.token === rightMarker.token,
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
    record.platform !== platform ||
    typeof record.canonicalPath !== "string" ||
    !pathForPlatform(platform).isAbsolute(record.canonicalPath)
  ) {
    return null;
  }
  const physical = parsePhysicalDirectoryIdentity({
    device: record.device,
    inode: record.inode,
    birthtimeNs: record.birthtimeNs,
  });
  if (!physical) return null;
  const canonicalPath = pathForPlatform(platform).resolve(record.canonicalPath);
  if (
    record.version === BIRTHTIME_PROFILE_IDENTITY_VERSION &&
    Object.keys(record).sort().join(",") ===
      "birthtimeNs,canonicalPath,device,inode,platform,version" &&
    physical.birthtimeNs !== "0"
  ) {
    return Object.freeze({
      version: BIRTHTIME_PROFILE_IDENTITY_VERSION,
      platform,
      canonicalPath,
      ...physical,
    });
  }
  if (
    record.version !== MARKER_PROFILE_IDENTITY_VERSION ||
    platform !== "linux" ||
    Object.keys(record).sort().join(",") !==
      "birthtimeNs,canonicalPath,device,generationMarker,inode,platform,version" ||
    physical.birthtimeNs !== "0" ||
    physical.inode === "0" ||
    !record.generationMarker ||
    typeof record.generationMarker !== "object" ||
    Array.isArray(record.generationMarker)
  ) {
    return null;
  }
  const marker = record.generationMarker as Record<string, unknown>;
  if (
    Object.keys(marker).sort().join(",") !== "ctimeNs,device,inode,token" ||
    typeof marker.device !== "string" ||
    typeof marker.inode !== "string" ||
    typeof marker.ctimeNs !== "string" ||
    typeof marker.token !== "string" ||
    !/^(?:0|[1-9]\d*)$/u.test(marker.device) ||
    !/^[1-9]\d*$/u.test(marker.inode) ||
    !/^[1-9]\d*$/u.test(marker.ctimeNs) ||
    !/^[0-9a-f]{64}$/u.test(marker.token) ||
    marker.device !== physical.device
  ) {
    return null;
  }
  return Object.freeze({
    version: MARKER_PROFILE_IDENTITY_VERSION,
    platform,
    canonicalPath,
    ...physical,
    generationMarker: Object.freeze({
      device: marker.device,
      inode: marker.inode,
      ctimeNs: marker.ctimeNs,
      token: marker.token,
    }),
  });
}

function pathForPlatform(platform: NodeJS.Platform): PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}
