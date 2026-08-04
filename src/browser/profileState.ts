import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  acquireCrashRecoverableFilesystemLock,
  type CrashRecoverableFilesystemLock,
  FilesystemLockBusyError,
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

const CHROME_PID_FILENAME = "chrome.pid";
const CHROME_PROCESS_IDENTITY_FILENAME = "chrome-process-identity.json";
const ORACLE_PROFILE_LOCK_FILENAME = "oracle-automation.lock";

const execFileAsync = promisify(execFile);

type ProcessCommandExecutor = (file: string, args: string[]) => Promise<{ stdout: string }>;

const executeProcessCommand: ProcessCommandExecutor = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
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

interface ChromeProcessSnapshot {
  pid: number;
  processStartTime: string;
  executablePath: string;
  commandLine: string;
}

interface ChromeProcessIdentityDeps {
  platform?: NodeJS.Platform;
  execute?: ProcessCommandExecutor;
  readIdentity?: (userDataDir: string) => Promise<ChromeProcessIdentity | null>;
  readProcessSnapshot?: (pid: number) => Promise<ChromeProcessSnapshot | null>;
  captureProfileIdentity?: (userDataDir: string) => Promise<ProfileDirectoryIdentity>;
  verifyProfileIdentity?: (
    userDataDir: string,
    identity: ProfileDirectoryIdentity,
  ) => Promise<boolean>;
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

export async function removeProfileDirectoryIfIdentityMatches(
  userDataDir: string,
  expected: ProfileDirectoryIdentity,
): Promise<boolean> {
  if (!(await verifyProfileDirectoryIdentity(userDataDir, expected))) return false;
  if (await isChromeUsingUserDataDir(expected.canonicalPath)) return false;
  if (!(await verifyProfileDirectoryIdentity(userDataDir, expected))) return false;
  await rm(expected.canonicalPath, { recursive: true, force: true });
  return !(await pathExists(expected.canonicalPath));
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
      const raw = await readFile(candidate, "utf8");
      await assertProfileDirectoryIdentity(userDataDir, profile, "DevTools authority read");
      const firstLine = raw.split(/\r?\n/u)[0]?.trim();
      const port = Number.parseInt(firstLine ?? "", 10);
      if (Number.isFinite(port)) {
        return port;
      }
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") throw error;
      await assertProfileDirectoryIdentity(userDataDir, profile, "DevTools authority read");
    }
  }
  await assertProfileDirectoryIdentity(userDataDir, profile, "DevTools authority read");
  return null;
}

export async function writeDevToolsActivePort(userDataDir: string, port: number): Promise<void> {
  const profile = await captureProfileDirectoryIdentity(userDataDir, { create: true });
  const contents = `${port}\n/devtools/browser`;
  for (const candidate of getDevToolsActivePortPaths(profile.canonicalPath)) {
    await assertProfileDirectoryIdentity(userDataDir, profile, "DevTools authority persistence");
    await mkdir(path.dirname(candidate), { recursive: true });
    await writeFile(candidate, contents, "utf8");
  }
  await assertProfileDirectoryIdentity(userDataDir, profile, "DevTools authority persistence");
}

export async function readChromePid(userDataDir: string): Promise<number | null> {
  let profile: ProfileDirectoryIdentity;
  try {
    profile = await captureProfileDirectoryIdentity(userDataDir);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  const pidPath = path.join(profile.canonicalPath, CHROME_PID_FILENAME);
  try {
    const raw = (await readFile(pidPath, "utf8")).trim();
    await assertProfileDirectoryIdentity(userDataDir, profile, "Chrome pid authority read");
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
    await assertProfileDirectoryIdentity(userDataDir, profile, "Chrome pid authority read");
    return null;
  }
}

export async function writeChromePid(userDataDir: string, pid: number): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) return;
  const profile = await captureProfileDirectoryIdentity(userDataDir, { create: true });
  await writeFile(
    path.join(profile.canonicalPath, CHROME_PID_FILENAME),
    `${Math.trunc(pid)}\n`,
    "utf8",
  );
  await assertProfileDirectoryIdentity(userDataDir, profile, "Chrome pid persistence");
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
    !isChromeCommandForUserDataDir(snapshot.commandLine, profileDirectory.canonicalPath, platform)
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

export async function readChromeProcessIdentity(
  userDataDir: string,
): Promise<ChromeProcessIdentity | null> {
  let profile: ProfileDirectoryIdentity;
  try {
    profile = await captureProfileDirectoryIdentity(userDataDir);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  const identityPath = path.join(profile.canonicalPath, CHROME_PROCESS_IDENTITY_FILENAME);
  let raw: string;
  try {
    raw = await readFile(identityPath, "utf8");
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
    await assertProfileDirectoryIdentity(userDataDir, profile, "Chrome process authority read");
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Chrome process identity is malformed: ${identityPath}`);
  }
  const identity = parseChromeProcessIdentity(parsed, process.platform);
  if (!identity || !sameProfileDirectoryIdentity(identity.profileDirectory, profile)) {
    throw new Error(`Chrome process identity is invalid or stale: ${identityPath}`);
  }
  await assertProfileDirectoryIdentity(userDataDir, profile, "Chrome process authority read");
  return identity;
}

export async function writeChromeProcessIdentity(
  userDataDir: string,
  identity: ChromeProcessIdentity,
): Promise<void> {
  const validated = parseChromeProcessIdentity(identity, process.platform);
  if (
    !validated ||
    !(await verifyProfileDirectoryIdentity(userDataDir, validated.profileDirectory)) ||
    validated.normalizedUserDataDir !==
      normalizeProfileArgument(validated.profileDirectory.canonicalPath, process.platform)
  ) {
    throw new Error(`Chrome process identity does not belong to ${userDataDir}`);
  }
  const identityPath = path.join(
    validated.profileDirectory.canonicalPath,
    CHROME_PROCESS_IDENTITY_FILENAME,
  );
  const temporaryPath = path.join(
    validated.profileDirectory.canonicalPath,
    `.${CHROME_PROCESS_IDENTITY_FILENAME}.tmp-${process.pid}-${randomUUID()}`,
  );
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertProfileDirectoryIdentity(
      userDataDir,
      validated.profileDirectory,
      "Chrome process authority persistence",
    );
    await rename(temporaryPath, identityPath);
    await syncProfileDirectory(validated.profileDirectory.canonicalPath);
    await assertProfileDirectoryIdentity(
      userDataDir,
      validated.profileDirectory,
      "Chrome process authority persistence",
    );
  } finally {
    if (await verifyProfileDirectoryIdentity(userDataDir, validated.profileDirectory)) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

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
  const platform = deps.platform ?? process.platform;
  const validated = parseChromeProcessIdentity(identity, platform);
  if (!validated || !sameChromeProcessIdentity(validated, identity)) return false;
  const physicalProfileMatches = await (deps.verifyProfileIdentity
    ? deps.verifyProfileIdentity(userDataDir, identity.profileDirectory)
    : verifyProfileDirectoryIdentity(userDataDir, identity.profileDirectory));
  if (!physicalProfileMatches) return false;
  const normalizedUserDataDir = normalizeProfileArgument(
    identity.profileDirectory.canonicalPath,
    platform,
  );
  if (!normalizedUserDataDir || identity.normalizedUserDataDir !== normalizedUserDataDir) {
    return false;
  }
  let persisted: ChromeProcessIdentity | null;
  try {
    persisted = await (deps.readIdentity
      ? deps.readIdentity(userDataDir)
      : readChromeProcessIdentity(userDataDir));
  } catch {
    return false;
  }
  if (!persisted || !sameChromeProcessIdentity(persisted, identity)) return false;
  const snapshot = await (deps.readProcessSnapshot
    ? deps.readProcessSnapshot(identity.pid)
    : readChromeProcessSnapshot(identity.pid, platform, deps.execute ?? executeProcessCommand));
  if (!snapshot) return false;
  const executablePath = normalizeExecutablePath(snapshot.executablePath, platform);
  return (
    snapshot.pid === identity.pid &&
    snapshot.processStartTime.trim() === identity.processStartTime &&
    executablePath === identity.executablePath &&
    isChromeCommandForUserDataDir(
      snapshot.commandLine,
      identity.profileDirectory.canonicalPath,
      platform,
    )
  );
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
  if (process.platform === "win32") {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pid=", "-o", "command="], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return findChromeDebugTargetForProfileFromProcessList(String(stdout ?? ""), userDataDir);
  } catch {
    return null;
  }
}

function findChromeDebugTargetForProfileFromProcessList(
  processList: string,
  userDataDir: string,
): RunningChromeDebugTarget | null {
  for (const line of processList.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    const command = match[2] ?? "";
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!isChromeCommandForUserDataDir(command, userDataDir)) continue;
    const portMatch = command.match(/--remote-debugging-port(?:=|\s+)(\d+)/);
    const port = Number.parseInt(portMatch?.[1] ?? "", 10);
    if (!Number.isFinite(port) || port <= 0) continue;
    return { pid, port };
  }
  return null;
}

export function findChromeDebugTargetForProfileFromProcessListForTest(
  processList: string,
  userDataDir: string,
): RunningChromeDebugTarget | null {
  return findChromeDebugTargetForProfileFromProcessList(processList, userDataDir);
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
  isProcessAlive?: (pid: number) => boolean;
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
  let persistedIdentity: ChromeProcessIdentity | null;
  try {
    persistedIdentity = await (deps.readIdentity
      ? deps.readIdentity(userDataDir)
      : readChromeProcessIdentity(userDataDir));
  } catch (error) {
    return {
      status: "unsafe",
      reason: error instanceof Error ? error.message : String(error),
      pid: identity.pid,
    };
  }
  if (!persistedIdentity || !sameChromeProcessIdentity(persistedIdentity, identity)) {
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

    const readPsField = async (field: "lstart" | "comm" | "command"): Promise<string> => {
      const { stdout } = await execute("ps", ["-p", String(Math.trunc(pid)), "-o", `${field}=`]);
      return stdout.trim();
    };
    const processStartTime = await readPsField("lstart");
    const executablePath = await readPsField("comm");
    const commandLine = await readPsField("command");
    const confirmedStartTime = await readPsField("lstart");
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

function isChromeExecutablePrefix(tokens: string[]): boolean {
  const firstFlagIndex = tokens.findIndex((token) => token.startsWith("--"));
  if (firstFlagIndex <= 0) return false;
  const executable = tokens.slice(0, firstFlagIndex).join(" ").toLowerCase();
  return executable.includes("chrome") || executable.includes("chromium");
}

function isChromeCommandForUserDataDir(
  command: string | null,
  userDataDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!command) return false;
  const tokens = tokenizeCommandLine(command);
  if (!tokens) return false;
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
  if (profileArguments.length !== 1) return false;
  const profileArgument = profileArguments[0];
  if (!profileArgument || !isChromeExecutablePrefix(tokens)) return false;
  const expected = normalizeProfileArgument(userDataDir, platform);
  const actual = normalizeProfileArgument(profileArgument, platform);
  return expected !== null && actual === expected;
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
    const pid = await readChromePid(profile.canonicalPath);
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
    CHROME_PID_FILENAME,
    CHROME_PROCESS_IDENTITY_FILENAME,
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
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "command="], {
      maxBuffer: 10 * 1024 * 1024,
    });
    const lines = String(stdout ?? "").split("\n");
    return lines.some((command) => isChromeCommandForUserDataDir(command, userDataDir));
  } catch {
    return true;
  }
}
