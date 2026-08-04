import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delay } from "./utils.js";

export type ProfileStateLogger = (message: string) => void;

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
const CHROME_TERMINATION_TIMEOUT_MS = 5_000;
const CHROME_FORCE_TERMINATION_TIMEOUT_MS = 2_000;
const CHROME_TERMINATION_POLL_MS = 50;

export interface ChromeProcessIdentity {
  readonly pid: number;
  readonly processStartTime: string;
  readonly executablePath: string;
  readonly normalizedUserDataDir: string;
  readonly launchNonce: string;
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
}

export function getDevToolsActivePortPaths(userDataDir: string): string[] {
  return DEVTOOLS_ACTIVE_PORT_RELATIVE_PATHS.map((relative) => path.join(userDataDir, relative));
}

export async function readDevToolsPort(userDataDir: string): Promise<number | null> {
  for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
    try {
      const raw = await readFile(candidate, "utf8");
      const firstLine = raw.split(/\r?\n/u)[0]?.trim();
      const port = Number.parseInt(firstLine ?? "", 10);
      if (Number.isFinite(port)) {
        return port;
      }
    } catch {
      // ignore missing/unreadable candidates
    }
  }
  return null;
}

export async function writeDevToolsActivePort(userDataDir: string, port: number): Promise<void> {
  const contents = `${port}\n/devtools/browser`;
  for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
    try {
      await mkdir(path.dirname(candidate), { recursive: true });
      await writeFile(candidate, contents, "utf8");
    } catch {
      // best effort
    }
  }
}

export async function readChromePid(userDataDir: string): Promise<number | null> {
  const pidPath = path.join(userDataDir, CHROME_PID_FILENAME);
  try {
    const raw = (await readFile(pidPath, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

export async function writeChromePid(userDataDir: string, pid: number): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) return;
  const pidPath = path.join(userDataDir, CHROME_PID_FILENAME);
  try {
    await mkdir(path.dirname(pidPath), { recursive: true });
    await writeFile(pidPath, `${Math.trunc(pid)}\n`, "utf8");
  } catch {
    // best effort
  }
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
  const normalizedUserDataDir = normalizeProfileArgument(userDataDir, platform);
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
    !isChromeCommandForUserDataDir(snapshot.commandLine, userDataDir, platform)
  ) {
    throw new Error(`Chrome pid ${pid} does not have a stable identity for ${userDataDir}`);
  }
  return Object.freeze({
    pid,
    processStartTime: snapshot.processStartTime.trim(),
    executablePath,
    normalizedUserDataDir,
    launchNonce: randomUUID(),
  });
}

export async function readChromeProcessIdentity(
  userDataDir: string,
): Promise<ChromeProcessIdentity | null> {
  const identityPath = path.join(userDataDir, CHROME_PROCESS_IDENTITY_FILENAME);
  let raw: string;
  try {
    raw = await readFile(identityPath, "utf8");
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Chrome process identity is malformed: ${identityPath}`);
  }
  const identity = parseChromeProcessIdentity(parsed, process.platform);
  if (!identity) {
    throw new Error(`Chrome process identity is invalid: ${identityPath}`);
  }
  return identity;
}

export async function writeChromeProcessIdentity(
  userDataDir: string,
  identity: ChromeProcessIdentity,
): Promise<void> {
  const normalizedUserDataDir = normalizeProfileArgument(userDataDir, process.platform);
  const validated = parseChromeProcessIdentity(identity, process.platform);
  if (
    !normalizedUserDataDir ||
    !validated ||
    validated.normalizedUserDataDir !== normalizedUserDataDir
  ) {
    throw new Error(`Chrome process identity does not belong to ${userDataDir}`);
  }
  await mkdir(userDataDir, { recursive: true });
  const identityPath = path.join(userDataDir, CHROME_PROCESS_IDENTITY_FILENAME);
  const temporaryPath = path.join(
    userDataDir,
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
    await rename(temporaryPath, identityPath);
    await syncProfileDirectory(userDataDir);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
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
  if (!identityMatchesProfile(identity, userDataDir, platform)) return false;
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
    isChromeCommandForUserDataDir(snapshot.commandLine, userDataDir, platform)
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
    left.launchNonce === right.launchNonce
  );
}

function identityMatchesProfile(
  identity: ChromeProcessIdentity,
  userDataDir: string,
  platform: NodeJS.Platform,
): boolean {
  const normalizedUserDataDir = normalizeProfileArgument(userDataDir, platform);
  return normalizedUserDataDir !== null && identity.normalizedUserDataDir === normalizedUserDataDir;
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
  if (
    !executablePath ||
    !normalizedUserDataDir ||
    normalizedUserDataDir !== record.normalizedUserDataDir ||
    executablePath !== record.executablePath
  ) {
    return null;
  }
  return Object.freeze({
    pid: record.pid as number,
    processStartTime: record.processStartTime.trim(),
    executablePath,
    normalizedUserDataDir,
    launchNonce: record.launchNonce,
  });
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
  | { status: "stopped"; pid: number; signal: "SIGTERM" | "SIGKILL" }
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
  waitForChromeProfileProcessesToExit?: (
    userDataDir: string,
    timeoutMs: number,
    pid: number,
  ) => Promise<boolean>;
}

async function terminateRecordedChromeForProfileWithDeps(
  userDataDir: string,
  identity: ChromeProcessIdentity,
  logger: ProfileStateLogger | undefined,
  deps: RecordedChromeTerminationDeps,
): Promise<RecordedChromeTerminationOutcome> {
  const platform = deps.platform ?? process.platform;
  const execute = deps.execute ?? executeProcessCommand;
  const processAlive = deps.isProcessAlive ?? isProcessAlive;
  const profileInUse = deps.isChromeUsingUserDataDir ?? isChromeUsingUserDataDir;
  const waitForExit =
    deps.waitForChromeProfileProcessesToExit ?? waitForChromeProfileProcessesToExit;
  const validatedIdentity = parseChromeProcessIdentity(identity, platform);
  if (
    !validatedIdentity ||
    !sameChromeProcessIdentity(validatedIdentity, identity) ||
    !identityMatchesProfile(identity, userDataDir, platform)
  ) {
    return { status: "unsafe", reason: `Chrome process identity is invalid for ${userDataDir}` };
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
    logger?.(`${reason}; skipping termination`);
    return { status: "unsafe", reason, pid: identity.pid };
  }

  const pid = identity.pid;
  if (!processAlive(pid)) {
    if (await profileInUse(userDataDir)) {
      return { status: "unsafe", reason: "another Chrome process is using the profile", pid };
    }
    return { status: "already-stopped", pid };
  }
  if (!(await verifyChromeProcessIdentityWithDeps(userDataDir, identity, deps))) {
    const reason = `Recorded Chrome process identity does not match pid ${pid}`;
    logger?.(`${reason}; skipping termination`);
    return { status: "unsafe", reason, pid };
  }

  const gracefulError = await terminateChromeProcess(pid, false, platform, execute).then(
    () => null,
    (error: unknown) => error,
  );
  if (!gracefulError && (await waitForExit(userDataDir, CHROME_TERMINATION_TIMEOUT_MS, pid))) {
    logger?.(`Terminated shared manual-login Chrome pid ${pid}`);
    return { status: "stopped", pid, signal: "SIGTERM" };
  }
  if (!processAlive(pid) && !(await profileInUse(userDataDir))) {
    return { status: "already-stopped", pid };
  }

  if (!(await verifyChromeProcessIdentityWithDeps(userDataDir, identity, deps))) {
    const reason = `Chrome pid ${pid} changed before forced termination`;
    logger?.(`${reason}; skipping forced termination`);
    return { status: "unsafe", reason, pid };
  }
  const forceError = await terminateChromeProcess(pid, true, platform, execute).then(
    () => null,
    (error: unknown) => error,
  );
  if (!forceError && (await waitForExit(userDataDir, CHROME_FORCE_TERMINATION_TIMEOUT_MS, pid))) {
    logger?.(`Force-terminated shared manual-login Chrome pid ${pid}`);
    return { status: "stopped", pid, signal: "SIGKILL" };
  }
  if (!processAlive(pid) && !(await profileInUse(userDataDir))) {
    return { status: "already-stopped", pid };
  }
  const reason = forceError
    ? forceError instanceof Error
      ? forceError.message
      : String(forceError)
    : `Chrome processes for ${userDataDir} did not exit after forced termination`;
  logger?.(`Failed to terminate shared manual-login Chrome pid ${pid}: ${reason}`);
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

async function waitForChromeProfileProcessesToExit(
  userDataDir: string,
  timeoutMs: number,
  pid: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) || (await isChromeUsingUserDataDir(userDataDir))) {
    if (Date.now() >= deadline) return false;
    await delay(CHROME_TERMINATION_POLL_MS);
  }
  return true;
}

async function terminateChromeProcess(
  pid: number,
  force: boolean,
  platform: NodeJS.Platform = process.platform,
  execute: ProcessCommandExecutor = executeProcessCommand,
): Promise<void> {
  if (platform === "win32") {
    await execute("taskkill.exe", [
      "/PID",
      String(Math.trunc(pid)),
      "/T",
      ...(force ? ["/F"] : []),
    ]);
    return;
  }
  process.kill(pid, force ? "SIGKILL" : "SIGTERM");
}

export function terminateChromeProcessForTest(
  pid: number,
  force: boolean,
  platform: NodeJS.Platform,
  execute: ProcessCommandExecutor,
): Promise<void> {
  return terminateChromeProcess(pid, force, platform, execute);
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
  path: string;
  lockId: string;
  release: () => Promise<void>;
}

interface ProfileRunLockRecord {
  pid: number;
  lockId: string;
  createdAt: string;
  sessionId?: string;
}

function parseProfileRunLock(payload: string | null): ProfileRunLockRecord | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as ProfileRunLockRecord;
    if (!Number.isFinite(parsed.pid) || parsed.pid <= 0) return null;
    if (!parsed.lockId || typeof parsed.lockId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
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
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  const pollMs =
    typeof options.pollMs === "number" && Number.isFinite(options.pollMs) && options.pollMs > 0
      ? options.pollMs
      : 1000;
  const lockPath = path.join(userDataDir, ORACLE_PROFILE_LOCK_FILENAME);
  const lockId = randomUUID();
  const startedAt = Date.now();
  let warned = false;

  for (;;) {
    try {
      const payload: ProfileRunLockRecord = {
        pid: process.pid,
        lockId,
        createdAt: new Date().toISOString(),
        sessionId: options.sessionId,
      };
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(lockPath, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
      options.logger?.(`Acquired Oracle profile lock at ${lockPath}`);
      return {
        path: lockPath,
        lockId,
        release: async () => releaseProfileRunLock(lockPath, lockId, options.logger),
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "EEXIST") {
        throw error;
      }
      let existing = parseProfileRunLock(await readFile(lockPath, "utf8").catch(() => null));
      if (!existing) {
        // Likely partial write / corruption; re-read once, then delete (user preference: delete unreadable lockfiles).
        await delay(200);
        existing = parseProfileRunLock(await readFile(lockPath, "utf8").catch(() => null));
        if (!existing) {
          options.logger?.("Oracle profile lock unreadable; deleting lockfile.");
          await rm(lockPath, { force: true }).catch(() => undefined);
          continue;
        }
      }
      if (!existing || !isProcessAlive(existing.pid)) {
        await rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (!warned) {
        const waited = Math.round(timeoutMs / 1000);
        options.logger?.(
          `Oracle profile lock held by pid ${existing.pid}; waiting up to ${waited}s.`,
        );
        warned = true;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new Error(
          `Oracle profile lock still held by pid ${existing.pid} after ${Math.round(elapsed / 1000)}s`,
        );
      }
      await delay(Math.min(pollMs, timeoutMs - elapsed));
    }
  }
}

export async function releaseProfileRunLock(
  lockPath: string,
  lockId: string,
  logger?: ProfileStateLogger,
): Promise<void> {
  try {
    const existing = parseProfileRunLock(await readFile(lockPath, "utf8").catch(() => null));
    if (!existing || existing.lockId !== lockId) {
      return;
    }
    await rm(lockPath, { force: true });
    logger?.(`Released Oracle profile lock ${lockPath}`);
  } catch {
    // best effort
  }
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

export async function cleanupStaleProfileState(
  userDataDir: string,
  logger?: ProfileStateLogger,
  options: { lockRemovalMode?: "never" | "if_oracle_pid_dead" } = {},
): Promise<boolean> {
  let cleaned = true;
  for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
    try {
      await rm(candidate, { force: true });
      logger?.(`Removed stale DevToolsActivePort: ${candidate}`);
    } catch {
      cleaned = false;
    }
  }

  const lockRemovalMode = options.lockRemovalMode ?? "never";
  if (lockRemovalMode === "never") {
    return cleaned;
  }

  const pid = await readChromePid(userDataDir);
  if (pid && isProcessAlive(pid)) {
    logger?.(`Chrome pid ${pid} still alive; skipping profile lock cleanup`);
    return false;
  }

  // Extra safety: if Chrome is running with this profile (but with a different PID, e.g. user relaunched
  // without remote debugging), never delete lock files.
  if (await isChromeUsingUserDataDir(userDataDir)) {
    logger?.("Detected running Chrome using this profile; skipping profile lock cleanup");
    return false;
  }

  const lockFiles = [
    path.join(userDataDir, "lockfile"),
    path.join(userDataDir, "SingletonLock"),
    path.join(userDataDir, "SingletonSocket"),
    path.join(userDataDir, "SingletonCookie"),
  ];
  for (const lock of lockFiles) {
    try {
      await rm(lock, { force: true });
    } catch {
      cleaned = false;
    }
  }
  for (const authorityFile of [CHROME_PID_FILENAME, CHROME_PROCESS_IDENTITY_FILENAME]) {
    try {
      await rm(path.join(userDataDir, authorityFile), { force: true });
    } catch {
      cleaned = false;
    }
  }
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
