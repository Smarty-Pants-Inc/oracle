import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  acquireCrashRecoverableFilesystemLock,
  type CrashRecoverableFilesystemLock,
  FilesystemLockBusyError,
  isolateDirectoryGenerationForRemoval,
  removeIsolatedDirectoryGeneration,
} from "./filesystemLock.js";

export type ProfileStateLogger = (message: string) => void;

interface PlatformPath {
  isAbsolute(candidate: string): boolean;
  resolve(...pathSegments: string[]): string;
}

const DEVTOOLS_ACTIVE_PORT_FILENAME = "DevToolsActivePort";
const DEVTOOLS_ACTIVE_PORT_RELATIVE_PATHS = [
  DEVTOOLS_ACTIVE_PORT_FILENAME,
  path.join("Default", DEVTOOLS_ACTIVE_PORT_FILENAME),
] as const;

const ORACLE_CHROME_OWNER_FILENAME = "oracle-chrome-owner.json";
const ORACLE_PROFILE_LOCK_FILENAME = "oracle-automation.lock";

const execFileAsync = promisify(execFile);
// Process identity gates destructive cleanup, so an unavailable probe must fail closed rather than
// permit an unbounded subprocess to stall recovery.
const PROCESS_IDENTITY_COMMAND_TIMEOUT_MS = 12_000;

type ProcessCommandExecutor = (file: string, args: string[]) => Promise<{ stdout: string }>;

const executeProcessCommand: ProcessCommandExecutor = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    timeout: PROCESS_IDENTITY_COMMAND_TIMEOUT_MS,
  });
  return { stdout: String(stdout ?? "") };
};
const PHYSICAL_PROFILE_IDENTITY_VERSION = 1 as const;

export interface ProfileDirectoryIdentity {
  readonly version: typeof PHYSICAL_PROFILE_IDENTITY_VERSION;
  readonly platform: NodeJS.Platform;
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
}

export interface ChromeProcessIdentity {
  readonly pid: number;
  readonly processStartTime: string;
  readonly executablePath: string;
  readonly normalizedUserDataDir: string;
  readonly launchNonce: string;
  readonly profileDirectory: ProfileDirectoryIdentity;
}

export interface OracleChromeOwnerRecord {
  readonly port: number;
  readonly processIdentity: ChromeProcessIdentity;
}

interface ChromeProcessSnapshot {
  pid: number;
  processStartTime: string;
  executablePath: string;
  commandLine: string;
  commandTokens?: readonly string[];
}

interface ChromeProcessIdentityDeps {
  platform?: NodeJS.Platform;
  execute?: ProcessCommandExecutor;
  readOwner?: (userDataDir: string) => Promise<OracleChromeOwnerRecord | null>;
  readProcessSnapshot?: (pid: number) => Promise<ChromeProcessSnapshot | null>;
  captureProfileIdentity?: (userDataDir: string) => Promise<ProfileDirectoryIdentity>;
  verifyProfileIdentity?: (
    userDataDir: string,
    identity: ProfileDirectoryIdentity,
  ) => Promise<boolean>;
  isProcessAlive?: (pid: number) => boolean;
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

interface RemoveProfileDirectoryDeps {
  isChromeUsingUserDataDir?: (userDataDir: string) => Promise<boolean>;
  beforeQuarantineRename?: () => void | Promise<void>;
  beforeQuarantineDelete?: (quarantinePath: string) => void | Promise<void>;
  afterQuarantineIdentityVerification?: (quarantinePath: string) => void | Promise<void>;
}

export async function removeProfileDirectoryIfIdentityMatches(
  userDataDir: string,
  expected: ProfileDirectoryIdentity,
): Promise<boolean> {
  return removeProfileDirectoryIfIdentityMatchesWithDeps(userDataDir, expected, {});
}

export async function removeProfileDirectoryIfIdentityMatchesForTest(
  userDataDir: string,
  expected: ProfileDirectoryIdentity,
  deps: RemoveProfileDirectoryDeps,
): Promise<boolean> {
  return removeProfileDirectoryIfIdentityMatchesWithDeps(userDataDir, expected, deps);
}

async function removeProfileDirectoryIfIdentityMatchesWithDeps(
  userDataDir: string,
  expected: ProfileDirectoryIdentity,
  deps: RemoveProfileDirectoryDeps,
): Promise<boolean> {
  if (!(await verifyProfileDirectoryIdentity(userDataDir, expected))) return false;
  const profileInUse = deps.isChromeUsingUserDataDir ?? isChromeUsingUserDataDir;
  if (await profileInUse(expected.canonicalPath)) return false;
  if (!(await verifyProfileDirectoryIdentity(userDataDir, expected))) return false;
  await deps.beforeQuarantineRename?.();

  const quarantinePath = path.join(
    path.dirname(expected.canonicalPath),
    `.${path.basename(expected.canonicalPath)}.oracle-delete-${process.pid}-${randomUUID()}`,
  );
  try {
    await rename(expected.canonicalPath, quarantinePath);
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(String(readErrorCode(error)))) return false;
    throw error;
  }

  const quarantinedIdentity = Object.freeze({
    ...expected,
    canonicalPath: path.resolve(quarantinePath),
  });
  const restore = async (): Promise<void> => {
    if (await pathExists(expected.canonicalPath)) return;
    await rename(quarantinePath, expected.canonicalPath).catch(() => undefined);
  };
  if (!(await verifyProfileDirectoryIdentity(quarantinePath, quarantinedIdentity))) {
    await restore();
    return false;
  }
  if (await profileInUse(expected.canonicalPath)) {
    await restore();
    return false;
  }

  await deps.beforeQuarantineDelete?.(quarantinePath);
  if (!(await verifyProfileDirectoryIdentity(quarantinePath, quarantinedIdentity))) return false;
  await deps.afterQuarantineIdentityVerification?.(quarantinePath);
  const isolation = await isolateDirectoryGenerationForRemoval(
    quarantinePath,
    async (generationPath) =>
      verifyProfileDirectoryIdentity(
        generationPath,
        Object.freeze({ ...expected, canonicalPath: path.resolve(generationPath) }),
      ),
  );
  if (isolation.status !== "isolated") return false;
  await removeIsolatedDirectoryGeneration(isolation.rootPath);
  return true;
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
      if (options.allowMissing && readErrorCode(error) === "ENOENT") return;
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

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export function getDevToolsActivePortPaths(userDataDir: string): string[] {
  return DEVTOOLS_ACTIVE_PORT_RELATIVE_PATHS.map((relative) => path.join(userDataDir, relative));
}

export async function readDevToolsPort(userDataDir: string): Promise<number | null> {
  let profile: ProfileDirectoryIdentity;
  try {
    profile = await captureProfileDirectoryIdentity(userDataDir);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  for (const candidate of getDevToolsActivePortPaths(profile.canonicalPath)) {
    try {
      const before = await lstat(candidate);
      if (before.isSymbolicLink() || !before.isFile()) {
        throw new Error(`Unsafe DevToolsActivePort entry: ${candidate}`);
      }
      const raw = await readFile(candidate, "utf8");
      await assertProfileDirectoryIdentity(userDataDir, profile, "DevTools authority read");
      const after = await lstat(candidate);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        throw new Error(`DevToolsActivePort changed while reading: ${candidate}`);
      }
      const firstLine = raw.split(/\r?\n/u)[0]?.trim() ?? "";
      if (!/^\d+$/u.test(firstLine)) continue;
      const port = Number.parseInt(firstLine, 10);
      if (port > 0 && port <= 65_535) return port;
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") throw error;
      await assertProfileDirectoryIdentity(userDataDir, profile, "DevTools authority read");
    }
  }
  await assertProfileDirectoryIdentity(userDataDir, profile, "DevTools authority read");
  return null;
}

export async function captureChromeProcessIdentity(
  userDataDir: string,
  pid: number,
): Promise<ChromeProcessIdentity> {
  return captureChromeProcessIdentityWithDeps(userDataDir, pid, {});
}

export async function captureChromeProcessIdentityForTest(
  userDataDir: string,
  pid: number,
  deps: ChromeProcessIdentityDeps,
): Promise<ChromeProcessIdentity> {
  return captureChromeProcessIdentityWithDeps(userDataDir, pid, deps);
}

async function captureChromeProcessIdentityWithDeps(
  userDataDir: string,
  pid: number,
  deps: ChromeProcessIdentityDeps,
): Promise<ChromeProcessIdentity> {
  const platform = deps.platform ?? process.platform;
  const profileDirectory = await (deps.captureProfileIdentity
    ? deps.captureProfileIdentity(userDataDir)
    : captureProfileDirectoryIdentity(userDataDir));
  const normalizedUserDataDir = normalizeProfileArgument(profileDirectory.canonicalPath, platform);
  if (!Number.isInteger(pid) || pid <= 0 || !normalizedUserDataDir) {
    throw new Error(`Cannot capture Chrome process identity for ${userDataDir}`);
  }
  const snapshot = await (deps.readProcessSnapshot
    ? deps.readProcessSnapshot(pid)
    : readChromeProcessSnapshot(pid, platform, deps.execute ?? executeProcessCommand));
  const executablePath = snapshot
    ? normalizeExecutablePath(snapshot.executablePath, platform)
    : null;
  if (
    !snapshot ||
    snapshot.pid !== pid ||
    !snapshot.processStartTime.trim() ||
    !executablePath ||
    !isChromeExecutablePath(executablePath, platform) ||
    !isChromeSnapshotForUserDataDir(snapshot, profileDirectory.canonicalPath, platform)
  ) {
    throw new Error(`Chrome pid ${pid} does not have a stable identity for ${userDataDir}`);
  }
  return Object.freeze({
    pid,
    processStartTime: snapshot.processStartTime.trim(),
    executablePath,
    normalizedUserDataDir,
    launchNonce: randomUUID(),
    profileDirectory,
  });
}

export async function readOracleChromeOwner(
  userDataDir: string,
): Promise<OracleChromeOwnerRecord | null> {
  let profile: ProfileDirectoryIdentity;
  try {
    profile = await captureProfileDirectoryIdentity(userDataDir);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  const ownerPath = path.join(profile.canonicalPath, ORACLE_CHROME_OWNER_FILENAME);
  let raw: string;
  try {
    raw = await readFile(ownerPath, "utf8");
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
    await assertProfileDirectoryIdentity(userDataDir, profile, "Chrome owner authority read");
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Chrome owner authority is malformed: ${ownerPath}`);
  }
  const owner = parseOracleChromeOwnerRecord(value, process.platform);
  if (!owner || !sameProfileDirectoryIdentity(owner.processIdentity.profileDirectory, profile)) {
    throw new Error(`Chrome owner authority is invalid or stale: ${ownerPath}`);
  }
  await assertProfileDirectoryIdentity(userDataDir, profile, "Chrome owner authority read");
  return owner;
}

export async function writeOracleChromeOwner(
  userDataDir: string,
  owner: OracleChromeOwnerRecord,
): Promise<void> {
  const validated = parseOracleChromeOwnerRecord(owner, process.platform);
  if (
    !validated ||
    !(await verifyProfileDirectoryIdentity(userDataDir, validated.processIdentity.profileDirectory))
  ) {
    throw new Error(`Chrome owner authority does not belong to ${userDataDir}`);
  }
  const profile = validated.processIdentity.profileDirectory;
  const ownerPath = path.join(profile.canonicalPath, ORACLE_CHROME_OWNER_FILENAME);
  const temporaryPath = path.join(
    profile.canonicalPath,
    `.${ORACLE_CHROME_OWNER_FILENAME}.tmp-${process.pid}-${randomUUID()}`,
  );
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertProfileDirectoryIdentity(userDataDir, profile, "Chrome owner persistence");
    await rename(temporaryPath, ownerPath);
    await syncProfileDirectory(profile.canonicalPath);
    await assertProfileDirectoryIdentity(userDataDir, profile, "Chrome owner persistence");
  } finally {
    if (await verifyProfileDirectoryIdentity(userDataDir, profile)) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

export type ChromeProcessIdentityInspection = "current" | "exited" | "unavailable";

export async function verifyChromeProcessIdentity(
  userDataDir: string,
  identity: ChromeProcessIdentity,
): Promise<boolean> {
  return verifyChromeProcessIdentityWithDeps(userDataDir, identity, {});
}

export async function verifyChromeProcessIdentityForTest(
  userDataDir: string,
  identity: ChromeProcessIdentity,
  deps: ChromeProcessIdentityDeps,
): Promise<boolean> {
  return verifyChromeProcessIdentityWithDeps(userDataDir, identity, deps);
}

async function verifyChromeProcessIdentityWithDeps(
  userDataDir: string,
  identity: ChromeProcessIdentity,
  deps: ChromeProcessIdentityDeps,
): Promise<boolean> {
  let persistedOwner: OracleChromeOwnerRecord | null;
  try {
    persistedOwner = await (deps.readOwner
      ? deps.readOwner(userDataDir)
      : readOracleChromeOwner(userDataDir));
  } catch {
    return false;
  }
  if (!persistedOwner || !sameChromeProcessIdentity(persistedOwner.processIdentity, identity)) {
    return false;
  }
  return (await inspectChromeProcessIdentityWithDeps(userDataDir, identity, deps)) === "current";
}

export async function inspectChromeProcessIdentity(
  userDataDir: string,
  identity: ChromeProcessIdentity,
): Promise<ChromeProcessIdentityInspection> {
  return inspectChromeProcessIdentityWithDeps(userDataDir, identity, {});
}

export async function inspectChromeProcessIdentityForTest(
  userDataDir: string,
  identity: ChromeProcessIdentity,
  deps: ChromeProcessIdentityDeps,
): Promise<ChromeProcessIdentityInspection> {
  return inspectChromeProcessIdentityWithDeps(userDataDir, identity, deps);
}

async function inspectChromeProcessIdentityWithDeps(
  userDataDir: string,
  identity: ChromeProcessIdentity,
  deps: ChromeProcessIdentityDeps,
): Promise<ChromeProcessIdentityInspection> {
  const platform = deps.platform ?? process.platform;
  const validated = parseChromeProcessIdentity(identity, platform);
  if (!validated || !sameChromeProcessIdentity(validated, identity)) return "unavailable";
  const physicalProfileMatches = await (deps.verifyProfileIdentity
    ? deps.verifyProfileIdentity(userDataDir, identity.profileDirectory)
    : verifyProfileDirectoryIdentity(userDataDir, identity.profileDirectory));
  if (!physicalProfileMatches) return "unavailable";
  const normalizedUserDataDir = normalizeProfileArgument(
    identity.profileDirectory.canonicalPath,
    platform,
  );
  if (!normalizedUserDataDir || identity.normalizedUserDataDir !== normalizedUserDataDir) {
    return "unavailable";
  }

  const processAlive = deps.isProcessAlive ?? isProcessAlive;
  if (!processAlive(identity.pid)) return "exited";
  const snapshot = await (deps.readProcessSnapshot
    ? deps.readProcessSnapshot(identity.pid)
    : readChromeProcessSnapshot(identity.pid, platform, deps.execute ?? executeProcessCommand));
  if (!snapshot) return processAlive(identity.pid) ? "unavailable" : "exited";
  if (snapshot.pid !== identity.pid) return "unavailable";
  if (snapshot.processStartTime.trim() !== identity.processStartTime) return "exited";
  const executablePath = normalizeExecutablePath(snapshot.executablePath, platform);
  if (
    executablePath !== identity.executablePath ||
    !isChromeSnapshotForUserDataDir(snapshot, identity.profileDirectory.canonicalPath, platform)
  ) {
    return "unavailable";
  }
  return "current";
}

export function sameChromeProcessIdentity(
  left: ChromeProcessIdentity,
  right: ChromeProcessIdentity,
): boolean {
  return (
    left.pid === right.pid &&
    left.processStartTime === right.processStartTime &&
    left.executablePath === right.executablePath &&
    left.normalizedUserDataDir === right.normalizedUserDataDir &&
    left.launchNonce === right.launchNonce &&
    sameProfileDirectoryIdentity(left.profileDirectory, right.profileDirectory)
  );
}

function parseChromeProcessIdentity(
  value: unknown,
  platform: NodeJS.Platform,
): ChromeProcessIdentity | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    !Number.isInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    typeof record.processStartTime !== "string" ||
    !record.processStartTime.trim() ||
    typeof record.executablePath !== "string" ||
    typeof record.normalizedUserDataDir !== "string" ||
    typeof record.launchNonce !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      record.launchNonce,
    )
  ) {
    return null;
  }
  const executablePath = normalizeExecutablePath(record.executablePath, platform);
  const normalizedUserDataDir = normalizeProfileArgument(record.normalizedUserDataDir, platform);
  const profileDirectory = parseProfileDirectoryIdentity(record.profileDirectory, platform);
  if (
    !executablePath ||
    !normalizedUserDataDir ||
    normalizedUserDataDir !== record.normalizedUserDataDir ||
    executablePath !== record.executablePath ||
    !profileDirectory ||
    normalizedUserDataDir !== normalizeProfileArgument(profileDirectory.canonicalPath, platform)
  ) {
    return null;
  }
  return Object.freeze({
    pid: record.pid as number,
    processStartTime: record.processStartTime.trim(),
    executablePath,
    normalizedUserDataDir,
    launchNonce: record.launchNonce,
    profileDirectory,
  });
}

function parseOracleChromeOwnerRecord(
  value: unknown,
  platform: NodeJS.Platform,
): OracleChromeOwnerRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, "port") ||
    !Object.hasOwn(record, "processIdentity")
  ) {
    return null;
  }
  if (
    !Number.isInteger(record.port) ||
    (record.port as number) <= 0 ||
    (record.port as number) > 65_535
  ) {
    return null;
  }
  const processIdentity = parseChromeProcessIdentity(record.processIdentity, platform);
  if (!processIdentity) return null;
  return Object.freeze({
    port: record.port as number,
    processIdentity,
  });
}

function parseProfileDirectoryIdentity(
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

async function syncProfileDirectory(userDataDir: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(userDataDir, "r");
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

export interface RunningChromeDebugTarget {
  pid: number;
  port: number;
}

export async function findRunningChromeDebugTargetForProfile(
  userDataDir: string,
): Promise<RunningChromeDebugTarget | null> {
  if (process.platform === "win32") return null;
  try {
    const [activePort, { stdout }] = await Promise.all([
      readDevToolsPort(userDataDir),
      executeProcessCommand("ps", ["-ax", "-o", "pid=", "-o", "command="]),
    ]);
    return findChromeDebugTargetForProfileFromProcessList(
      String(stdout ?? ""),
      userDataDir,
      activePort,
    );
  } catch {
    return null;
  }
}

export async function findRunningChromeProcessForProfile(
  userDataDir: string,
  expectedDebugPortArgument: number,
  expectedPid?: number,
): Promise<{ pid: number } | null> {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await executeProcessCommand("ps", ["-ax", "-o", "pid=", "-o", "command="]);
    for (const line of String(stdout ?? "").split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/u);
      if (!match) continue;
      const pid = Number.parseInt(match[1] ?? "", 10);
      const command = match[2] ?? "";
      if (!Number.isFinite(pid) || pid <= 0 || (expectedPid && pid !== expectedPid)) continue;
      if (!isChromeCommandForUserDataDir(command, userDataDir)) continue;
      if (readRemoteDebuggingPortArgument(command) !== expectedDebugPortArgument) continue;
      return { pid };
    }
    return null;
  } catch {
    return null;
  }
}

function findChromeDebugTargetForProfileFromProcessList(
  processList: string,
  userDataDir: string,
  activePort: number | null = null,
): RunningChromeDebugTarget | null {
  for (const line of processList.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    const command = match[2] ?? "";
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!isChromeCommandForUserDataDir(command, userDataDir)) continue;
    const configuredPort = readRemoteDebuggingPortArgument(command);
    const port = configuredPort === 0 ? activePort : configuredPort;
    if (!port || port <= 0) continue;
    return { pid, port };
  }
  return null;
}

export function findChromeDebugTargetForProfileFromProcessListForTest(
  processList: string,
  userDataDir: string,
  activePort: number | null = null,
): RunningChromeDebugTarget | null {
  return findChromeDebugTargetForProfileFromProcessList(processList, userDataDir, activePort);
}
export type RecordedChromeTerminationOutcome =
  | {
      status: "stopped";
      pid?: number;
      signal: "SIGTERM" | "SIGKILL" | "CONTROL_CHANNEL";
    }
  | { status: "already-stopped"; pid?: number }
  | { status: "unsafe"; reason: string; pid?: number };

export function isSafeChromeTerminationOutcome(
  outcome: RecordedChromeTerminationOutcome,
): outcome is Exclude<RecordedChromeTerminationOutcome, { status: "unsafe" }> {
  return outcome.status === "stopped" || outcome.status === "already-stopped";
}

interface RecordedChromeTerminationDeps extends ChromeProcessIdentityDeps {
  isChromeUsingUserDataDir?: (userDataDir: string) => Promise<boolean>;
}

async function terminateRecordedChromeForProfileWithDeps(
  userDataDir: string,
  identity: ChromeProcessIdentity,
  logger: ProfileStateLogger | undefined,
  deps: RecordedChromeTerminationDeps,
): Promise<RecordedChromeTerminationOutcome> {
  const platform = deps.platform ?? process.platform;
  const validatedIdentity = parseChromeProcessIdentity(identity, platform);
  if (!validatedIdentity || !sameChromeProcessIdentity(validatedIdentity, identity)) {
    return { status: "unsafe", reason: `Chrome process identity is invalid for ${userDataDir}` };
  }
  const physicalProfileMatches = await (deps.verifyProfileIdentity
    ? deps.verifyProfileIdentity(userDataDir, identity.profileDirectory)
    : verifyProfileDirectoryIdentity(userDataDir, identity.profileDirectory));
  if (!physicalProfileMatches) {
    const reason = `Physical Chrome profile authority changed for ${userDataDir}`;
    logger?.(`${reason}; preserving cleanup state`);
    return { status: "unsafe", reason, pid: identity.pid };
  }
  let persistedOwner: OracleChromeOwnerRecord | null;
  try {
    persistedOwner = await (deps.readOwner
      ? deps.readOwner(userDataDir)
      : readOracleChromeOwner(userDataDir));
  } catch (error) {
    return {
      status: "unsafe",
      reason: error instanceof Error ? error.message : String(error),
      pid: identity.pid,
    };
  }
  if (!persistedOwner || !sameChromeProcessIdentity(persistedOwner.processIdentity, identity)) {
    const reason = `Chrome cleanup authority is stale for ${userDataDir}`;
    logger?.(`${reason}; preserving cleanup state`);
    return { status: "unsafe", reason, pid: identity.pid };
  }

  const pid = identity.pid;
  if (!(deps.isProcessAlive ?? isProcessAlive)(pid)) {
    if (await (deps.isChromeUsingUserDataDir ?? isChromeUsingUserDataDir)(userDataDir)) {
      return { status: "unsafe", reason: "another Chrome process is using the profile", pid };
    }
    return { status: "already-stopped", pid };
  }

  const reason =
    `Chrome pid ${pid} is still alive, but this recovered session has no retained stable process ` +
    "handle or authenticated exact Chrome control channel";
  logger?.(`${reason}; refusing PID-based termination and preserving cleanup state`);
  return { status: "unsafe", reason, pid };
}

export function terminateRecordedChromeForProfile(
  userDataDir: string,
  identity: ChromeProcessIdentity,
  logger?: ProfileStateLogger,
): Promise<RecordedChromeTerminationOutcome> {
  return terminateRecordedChromeForProfileWithDeps(userDataDir, identity, logger, {});
}

export function terminateRecordedChromeForProfileForTest(
  userDataDir: string,
  identity: ChromeProcessIdentity,
  logger: ProfileStateLogger | undefined,
  deps: RecordedChromeTerminationDeps,
): Promise<RecordedChromeTerminationOutcome> {
  return terminateRecordedChromeForProfileWithDeps(userDataDir, identity, logger, deps);
}

function tokenizeCommandLine(command: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      started = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += character;
    started = true;
  }
  if (quote) return null;
  if (started) tokens.push(token);
  return tokens;
}

function normalizeProfileArgument(value: string, platform: NodeJS.Platform): string | null {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(value)) return null;
  const normalized = pathApi.resolve(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeExecutablePath(value: string, platform: NodeJS.Platform): string | null {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const trimmed = value.trim();
  if (!pathApi.isAbsolute(trimmed)) return null;
  const normalized = pathApi.resolve(trimmed);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isChromeExecutablePath(value: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const basename = pathApi.basename(value).toLowerCase();
  return basename.includes("chrome") || basename.includes("chromium");
}

async function readChromeProcessSnapshot(
  pid: number,
  platform: NodeJS.Platform,
  execute: ProcessCommandExecutor,
): Promise<ChromeProcessSnapshot | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "linux") {
      const procRoot = `/proc/${Math.trunc(pid)}`;
      const initialStat = parseLinuxProcStat(await readFile(path.join(procRoot, "stat"), "utf8"));
      if (!initialStat || initialStat.pid !== pid) return null;
      const executablePath = await readlink(path.join(procRoot, "exe"));
      const rawCommandLine = await readFile(path.join(procRoot, "cmdline"));
      const confirmedStat = parseLinuxProcStat(await readFile(path.join(procRoot, "stat"), "utf8"));
      if (
        !confirmedStat ||
        confirmedStat.pid !== pid ||
        confirmedStat.startTicks !== initialStat.startTicks
      ) {
        return null;
      }
      const commandTokens = rawCommandLine.toString("utf8").split("\0");
      if (commandTokens.at(-1) === "") commandTokens.pop();
      if (commandTokens.length === 0) return null;
      return {
        pid,
        processStartTime: `linux-proc-start-ticks:${initialStat.startTicks}`,
        executablePath,
        commandLine: commandTokens.map((token) => JSON.stringify(token)).join(" "),
        commandTokens,
      };
    }

    if (platform === "win32") {
      const { stdout } = await execute("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference = 'Stop'; $process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${Math.trunc(pid)}'; if ($null -eq $process) { exit 3 }; [ordered]@{ pid = [int]$process.ProcessId; processStartTime = $process.CreationDate.ToUniversalTime().ToString('O'); executablePath = [string]$process.ExecutablePath; commandLine = [string]$process.CommandLine } | ConvertTo-Json -Compress`,
      ]);
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      if (
        parsed.pid !== pid ||
        typeof parsed.processStartTime !== "string" ||
        typeof parsed.executablePath !== "string" ||
        typeof parsed.commandLine !== "string"
      ) {
        return null;
      }
      return {
        pid,
        processStartTime: parsed.processStartTime.trim(),
        executablePath: parsed.executablePath.trim(),
        commandLine: parsed.commandLine.trim(),
      };
    }

    if (platform !== "darwin") return null;
    const readDarwinProcessGeneration = async (): Promise<string | null> => {
      const { stdout } = await execute("/usr/bin/lsappinfo", ["info", String(Math.trunc(pid))]);
      return parseDarwinAuditPidVersion(stdout, pid);
    };
    const processStartTime = await readDarwinProcessGeneration();
    const { stdout: executableFiles } = await execute("/usr/sbin/lsof", [
      "-nP",
      "-a",
      "-p",
      String(Math.trunc(pid)),
      "-d",
      "txt",
      "-Fn",
    ]);
    const executablePath = executableFiles
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("n"))
      .map((line) => line.slice(1).trim())
      .find((candidate) =>
        Boolean(
          normalizeExecutablePath(candidate, platform) &&
          isChromeExecutablePath(candidate, platform),
        ),
      );
    const { stdout: commandOutput } = await execute("ps", [
      "-p",
      String(Math.trunc(pid)),
      "-o",
      "command=",
    ]);
    const commandLine = commandOutput.trim();
    const confirmedStartTime = await readDarwinProcessGeneration();
    if (
      !processStartTime ||
      processStartTime !== confirmedStartTime ||
      !executablePath ||
      !commandLine
    ) {
      return null;
    }
    return { pid, processStartTime, executablePath, commandLine };
  } catch {
    return null;
  }
}

function parseDarwinAuditPidVersion(raw: string, expectedPid: number): string | null {
  const processPid = raw.match(/\bpid\s*=\s*(\d+)\b/u)?.[1];
  const auditToken = raw.match(
    /\btoken=\[[^\]\r\n]*\bpid=(\d+)\b[^\]\r\n]*\bpV:(\d+)\b[^\]\r\n]*\]/u,
  );
  if (
    processPid !== String(expectedPid) ||
    auditToken?.[1] !== String(expectedPid) ||
    !auditToken[2] ||
    !/^\d+$/u.test(auditToken[2])
  ) {
    return null;
  }
  return `darwin-audit-pidversion:${auditToken[2]}`;
}

function parseLinuxProcStat(raw: string): { pid: number; startTicks: string } | null {
  const openingParenthesis = raw.indexOf("(");
  const closingParenthesis = raw.lastIndexOf(")");
  if (openingParenthesis <= 0 || closingParenthesis <= openingParenthesis) return null;
  const pid = Number.parseInt(raw.slice(0, openingParenthesis).trim(), 10);
  const fieldsAfterCommand = raw
    .slice(closingParenthesis + 1)
    .trim()
    .split(/\s+/u);
  const startTicks = fieldsAfterCommand[19];
  if (!Number.isInteger(pid) || pid <= 0 || !startTicks || !/^\d+$/u.test(startTicks)) {
    return null;
  }
  return { pid, startTicks };
}

function isChromeExecutablePrefix(tokens: readonly string[]): boolean {
  const firstFlagIndex = tokens.findIndex((token) => token.startsWith("--"));
  if (firstFlagIndex <= 0) return false;
  const executable = tokens.slice(0, firstFlagIndex).join(" ").toLowerCase();
  return executable.includes("chrome") || executable.includes("chromium");
}

function isChromeCommandTokensForUserDataDir(
  tokens: readonly string[],
  userDataDir: string,
  platform: NodeJS.Platform,
): boolean {
  const profileArguments: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const lower = token.toLowerCase();
    if (lower === "--user-data-dir") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) return false;
      profileArguments.push(value);
      index += 1;
    } else if (lower.startsWith("--user-data-dir=")) {
      profileArguments.push(token.slice(token.indexOf("=") + 1));
    }
  }
  if (profileArguments.length !== 1 || !isChromeExecutablePrefix(tokens)) return false;
  const expected = normalizeProfileArgument(userDataDir, platform);
  const actual = normalizeProfileArgument(profileArguments[0] ?? "", platform);
  return expected !== null && actual === expected;
}

function isChromeCommandForUserDataDir(
  command: string | null,
  userDataDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!command) return false;
  const tokens = tokenizeCommandLine(command);
  return Boolean(tokens && isChromeCommandTokensForUserDataDir(tokens, userDataDir, platform));
}

function isChromeSnapshotForUserDataDir(
  snapshot: ChromeProcessSnapshot,
  userDataDir: string,
  platform: NodeJS.Platform,
): boolean {
  return snapshot.commandTokens
    ? isChromeCommandTokensForUserDataDir(snapshot.commandTokens, userDataDir, platform)
    : isChromeCommandForUserDataDir(snapshot.commandLine, userDataDir, platform);
}

function readRemoteDebuggingPortArgument(command: string): number | null {
  const tokens = tokenizeCommandLine(command);
  if (!tokens) return null;
  const values: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const lower = token.toLowerCase();
    if (lower === "--remote-debugging-port") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) return null;
      values.push(value);
      index += 1;
    } else if (lower.startsWith("--remote-debugging-port=")) {
      values.push(token.slice(token.indexOf("=") + 1));
    }
  }
  if (values.length !== 1 || !/^\d+$/u.test(values[0] ?? "")) return null;
  const port = Number.parseInt(values[0] ?? "", 10);
  return port >= 0 && port <= 65_535 ? port : null;
}

export function isChromeCommandForUserDataDirForTest(
  command: string | null,
  userDataDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return isChromeCommandForUserDataDir(command, userDataDir, platform);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means "exists but no permission"; treat as alive.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "EPERM"
    ) {
      return true;
    }
    return false;
  }
}

export interface ProfileRunLock {
  readonly path: string;
  readonly lockId: string;
  readonly profileDirectory: ProfileDirectoryIdentity;
  release: () => Promise<void>;
}

export async function acquireProfileRunLock(
  userDataDir: string,
  options: {
    timeoutMs: number;
    pollMs?: number;
    logger?: ProfileStateLogger;
    sessionId?: string;
  },
): Promise<ProfileRunLock | null> {
  const timeoutMs = options.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  const pollMs =
    typeof options.pollMs === "number" && Number.isFinite(options.pollMs) && options.pollMs > 0
      ? options.pollMs
      : 1000;
  const profileDirectory = await captureProfileDirectoryIdentity(userDataDir, { create: true });
  if (!(await verifyProfileDirectoryIdentity(userDataDir, profileDirectory))) {
    throw new Error(`Profile directory identity changed before acquiring its lock: ${userDataDir}`);
  }
  const lockPath = path.join(profileDirectory.canonicalPath, ORACLE_PROFILE_LOCK_FILENAME);

  let filesystemLock: CrashRecoverableFilesystemLock;
  try {
    filesystemLock = await acquireCrashRecoverableFilesystemLock(lockPath, {
      timeoutMs,
      pollMs,
      createParent: false,
      sessionId: options.sessionId,
    });
  } catch (error) {
    if (error instanceof FilesystemLockBusyError) {
      const owner = error.owner ? ` by pid ${error.owner.pid}` : "";
      throw new Error(
        `Oracle profile lock at ${lockPath} remained held${owner} after ${Math.round(timeoutMs / 1000)}s`,
        { cause: error },
      );
    }
    throw error;
  }

  if (!(await verifyProfileDirectoryIdentity(userDataDir, profileDirectory))) {
    await filesystemLock.release();
    throw new Error(`Profile directory identity changed while acquiring its lock: ${userDataDir}`);
  }

  options.logger?.(`Acquired Oracle profile lock at ${lockPath}`);
  let releasePromise: Promise<void> | undefined;
  return {
    path: lockPath,
    lockId: filesystemLock.owner.ownerNonce,
    profileDirectory,
    release: () =>
      (releasePromise ??= (async () => {
        if (!(await verifyProfileDirectoryIdentity(userDataDir, profileDirectory))) {
          throw new Error(
            `Profile directory identity changed before releasing Oracle profile lock at ${lockPath}`,
          );
        }
        await filesystemLock.release();
        options.logger?.(`Released Oracle profile lock ${lockPath}`);
      })()),
  };
}

export async function verifyDevToolsReachable({
  port,
  host = "127.0.0.1",
  attempts = 3,
  timeoutMs = 3000,
}: {
  port: number;
  host?: string;
  attempts?: number;
  timeoutMs?: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const versionUrl = `http://${host}:${port}/json/version`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(versionUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return { ok: true };
    } catch (error) {
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }
  return { ok: false, error: "unreachable" };
}

export async function shouldCleanupManualLoginProfileState(
  userDataDir: string,
  logger?: ProfileStateLogger,
  options: {
    connectionClosedUnexpectedly?: boolean;
    host?: string;
    probe?: typeof verifyDevToolsReachable;
  } = {},
): Promise<boolean> {
  const port = await readDevToolsPort(userDataDir);
  if (!port) {
    return true;
  }
  const probe = await (options.probe ?? verifyDevToolsReachable)({ port, host: options.host });
  if (probe.ok) {
    logger?.(`DevTools port ${port} still reachable; preserving manual-login profile state`);
    return false;
  }
  logger?.(`DevTools port ${port} unreachable (${probe.error}); clearing stale profile state`);
  return true;
}

interface CleanupStaleProfileStateDeps {
  captureProfileIdentity?: typeof captureProfileDirectoryIdentity;
  verifyProfileIdentity?: typeof verifyProfileDirectoryIdentity;
  beforeDestructiveCleanup?: () => void | Promise<void>;
}

export async function cleanupStaleProfileState(
  userDataDir: string,
  logger?: ProfileStateLogger,
  options: {
    lockRemovalMode?: "never" | "if_oracle_pid_dead";
    expectedProfileIdentity?: ProfileDirectoryIdentity;
  } = {},
): Promise<boolean> {
  return cleanupStaleProfileStateWithDeps(userDataDir, logger, options, {});
}

export async function cleanupStaleProfileStateForTest(
  userDataDir: string,
  logger: ProfileStateLogger | undefined,
  options: {
    lockRemovalMode?: "never" | "if_oracle_pid_dead";
    expectedProfileIdentity?: ProfileDirectoryIdentity;
  },
  deps: CleanupStaleProfileStateDeps,
): Promise<boolean> {
  return cleanupStaleProfileStateWithDeps(userDataDir, logger, options, deps);
}

async function cleanupStaleProfileStateWithDeps(
  userDataDir: string,
  logger: ProfileStateLogger | undefined,
  options: {
    lockRemovalMode?: "never" | "if_oracle_pid_dead";
    expectedProfileIdentity?: ProfileDirectoryIdentity;
  },
  deps: CleanupStaleProfileStateDeps,
): Promise<boolean> {
  const captureProfile = deps.captureProfileIdentity ?? captureProfileDirectoryIdentity;
  const verifyProfile = deps.verifyProfileIdentity ?? verifyProfileDirectoryIdentity;
  let profile: ProfileDirectoryIdentity;
  try {
    profile = options.expectedProfileIdentity ?? (await captureProfile(userDataDir));
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return true;
    logger?.(`Refusing stale profile cleanup: ${error instanceof Error ? error.message : error}`);
    return false;
  }
  if (!(await verifyProfile(userDataDir, profile))) {
    logger?.(`Refusing stale profile cleanup because physical authority changed: ${userDataDir}`);
    return false;
  }
  const lockRemovalMode = options.lockRemovalMode ?? "never";
  if (lockRemovalMode === "if_oracle_pid_dead") {
    let owner: OracleChromeOwnerRecord | null;
    try {
      owner = await readOracleChromeOwner(profile.canonicalPath);
    } catch (error) {
      logger?.(
        `Refusing stale profile cleanup because Chrome owner authority is unreadable: ${error instanceof Error ? error.message : error}`,
      );
      return false;
    }
    const pid = owner?.processIdentity.pid;
    if (pid && isProcessAlive(pid)) {
      logger?.(`Chrome pid ${pid} still alive; preserving profile state`);
      return false;
    }
  }
  if (await isChromeUsingUserDataDir(profile.canonicalPath)) {
    logger?.("Detected running Chrome using this profile; preserving profile state");
    return false;
  }
  await deps.beforeDestructiveCleanup?.();

  let cleaned = true;
  for (const candidate of getDevToolsActivePortPaths(profile.canonicalPath)) {
    if (!(await verifyProfile(userDataDir, profile))) return false;
    try {
      await rm(candidate, { force: true });
      logger?.(`Removed stale DevToolsActivePort: ${candidate}`);
    } catch {
      cleaned = false;
    }
  }
  if (lockRemovalMode === "never") {
    return cleaned && (await verifyProfile(userDataDir, profile));
  }

  const staleFiles = [
    "lockfile",
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    ORACLE_CHROME_OWNER_FILENAME,
  ];
  for (const staleFile of staleFiles) {
    if (!(await verifyProfile(userDataDir, profile))) return false;
    try {
      await rm(path.join(profile.canonicalPath, staleFile), { force: true });
    } catch {
      cleaned = false;
    }
  }
  if (!(await verifyProfile(userDataDir, profile))) return false;
  logger?.("Cleaned up stale Chrome profile locks and owner authority");
  return cleaned;
}

async function isChromeUsingUserDataDir(userDataDir: string): Promise<boolean> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await executeProcessCommand("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|chromium)\\.exe$' } | ForEach-Object { $_.CommandLine }",
      ]);
      return stdout
        .split(/\r?\n/)
        .some((command) => isChromeCommandForUserDataDir(command, userDataDir));
    } catch {
      return true;
    }
  }

  try {
    const { stdout } = await executeProcessCommand("ps", ["-ax", "-o", "command="]);
    return stdout
      .split("\n")
      .some((command) => isChromeCommandForUserDataDir(command, userDataDir));
  } catch {
    return true;
  }
}
