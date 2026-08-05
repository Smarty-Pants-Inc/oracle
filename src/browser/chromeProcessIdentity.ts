import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  captureProfileDirectoryIdentity,
  parseProfileDirectoryIdentity,
  sameProfileDirectoryIdentity,
  verifyProfileDirectoryIdentity,
  type ProfileDirectoryIdentity,
} from "./profileDirectoryAuthority.js";
import { readDevToolsPort } from "./profileDevToolsState.js";

export interface ChromeProcessIdentityDeps {
  platform?: NodeJS.Platform;
  execute?: ProcessCommandExecutor;
  readOwner?: (userDataDir: string) => Promise<{ processIdentity: ChromeProcessIdentity } | null>;
  readProcessSnapshot?: (pid: number) => Promise<ChromeProcessSnapshot | null>;
  captureProfileIdentity?: (userDataDir: string) => Promise<ProfileDirectoryIdentity>;
  verifyProfileIdentity?: (
    userDataDir: string,
    identity: ProfileDirectoryIdentity,
  ) => Promise<boolean>;
  isProcessAlive?: (pid: number) => boolean;
}
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
export interface ChromeProcessIdentity {
  readonly pid: number;
  readonly processStartTime: string;
  readonly executablePath: string;
  readonly normalizedUserDataDir: string;
  readonly launchNonce: string;
  readonly profileDirectory: ProfileDirectoryIdentity;
}

export type ChromeProcessIdentityInspection = "current" | "exited" | "unavailable";
interface ChromeProcessSnapshot {
  pid: number;
  processStartTime: string;
  executablePath: string;
  commandLine: string;
  commandTokens?: readonly string[];
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

export async function inspectChromeProcessIdentityWithDeps(
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

export function parseChromeProcessIdentity(
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
  const processStartTime = record.processStartTime.trim();
  if (
    platform === "linux" &&
    processStartTime.startsWith("linux:") &&
    !/^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/iu.test(
      processStartTime,
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
    processStartTime,
    executablePath,
    normalizedUserDataDir,
    launchNonce: record.launchNonce,
    profileDirectory,
  });
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
      const initialBootId = parseLinuxBootId(
        await readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      );
      if (!initialStat || initialStat.pid !== pid || !initialBootId) return null;
      const executablePath = await readlink(path.join(procRoot, "exe"));
      const rawCommandLine = await readFile(path.join(procRoot, "cmdline"));
      const confirmedStat = parseLinuxProcStat(await readFile(path.join(procRoot, "stat"), "utf8"));
      const confirmedBootId = parseLinuxBootId(
        await readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      );
      if (
        !confirmedStat ||
        confirmedStat.pid !== pid ||
        confirmedStat.startTicks !== initialStat.startTicks ||
        confirmedBootId !== initialBootId
      ) {
        return null;
      }
      const commandTokens = rawCommandLine.toString("utf8").split("\0");
      if (commandTokens.at(-1) === "") commandTokens.pop();
      if (commandTokens.length === 0) return null;
      return {
        pid,
        processStartTime: `linux:${initialBootId}:${initialStat.startTicks}`,
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

function parseLinuxBootId(raw: string): string | null {
  const bootId = raw.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(bootId)
    ? bootId
    : null;
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
    if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}
export async function isChromeUsingUserDataDir(userDataDir: string): Promise<boolean> {
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
