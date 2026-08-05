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
import {
  arePlatformProcessGenerationsDefinitelyDifferent,
  createPlatformProcessGenerationProvider,
  type ProcessGenerationCommandExecutor,
} from "./platformProcessGeneration.js";

export interface ChromeProcessIdentityDeps {
  platform?: NodeJS.Platform;
  execute?: ProcessCommandExecutor;
  readOwner?: (userDataDir: string) => Promise<{ processIdentity: ChromeProcessIdentity } | null>;
  launchClaim?: ChromeProcessLaunchClaim;
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

type ProcessCommandExecutor = ProcessGenerationCommandExecutor;

const executeProcessCommand: ProcessCommandExecutor = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    timeout: PROCESS_IDENTITY_COMMAND_TIMEOUT_MS,
  });
  return { stdout: String(stdout ?? "") };
};
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CHROME_LAUNCH_CLAIM_FLAG = "--oracle-launch-claim";

export interface ChromeProcessLaunchClaim {
  readonly version: 1;
  readonly generationId: string;
  readonly nonce: string;
}

export function createChromeProcessLaunchClaim(
  generationId = randomUUID(),
): ChromeProcessLaunchClaim {
  const claim = parseChromeProcessLaunchClaim({ version: 1, generationId, nonce: randomUUID() });
  if (!claim) throw new Error("Chrome launch claim generation must be a UUID v4");
  return claim;
}

export function parseChromeProcessLaunchClaim(value: unknown): ChromeProcessLaunchClaim | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.generationId !== "string" ||
    !UUID_V4_PATTERN.test(record.generationId) ||
    typeof record.nonce !== "string" ||
    !UUID_V4_PATTERN.test(record.nonce)
  ) {
    return null;
  }
  return Object.freeze({ version: 1, generationId: record.generationId, nonce: record.nonce });
}

export function sameChromeProcessLaunchClaim(
  left: ChromeProcessLaunchClaim | undefined,
  right: ChromeProcessLaunchClaim | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.version === right.version &&
    left.generationId === right.generationId &&
    left.nonce === right.nonce
  );
}

export function buildChromeProcessLaunchClaimFlag(claim: ChromeProcessLaunchClaim): string {
  const validated = parseChromeProcessLaunchClaim(claim);
  if (!validated) throw new Error("Chrome launch claim is invalid");
  return `${CHROME_LAUNCH_CLAIM_FLAG}=${validated.generationId}:${validated.nonce}`;
}

export interface ChromeProcessIdentity {
  readonly pid: number;
  readonly processStartTime: string;
  readonly executablePath: string;
  readonly normalizedUserDataDir: string;
  readonly launchNonce: string;
  readonly launchClaim?: ChromeProcessLaunchClaim;
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
  launchClaim?: ChromeProcessLaunchClaim,
): Promise<ChromeProcessIdentity> {
  return captureChromeProcessIdentityWithDeps(userDataDir, pid, { launchClaim });
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
  const launchClaim =
    deps.launchClaim === undefined ? null : parseChromeProcessLaunchClaim(deps.launchClaim);
  if (deps.launchClaim !== undefined && !launchClaim) {
    throw new Error(`Cannot capture Chrome process identity with an invalid launch claim`);
  }
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
    !isChromeSnapshotForUserDataDir(snapshot, profileDirectory.canonicalPath, platform) ||
    (launchClaim && !isChromeSnapshotForLaunchClaim(snapshot, launchClaim))
  ) {
    throw new Error(`Chrome pid ${pid} does not have a stable identity for ${userDataDir}`);
  }
  return Object.freeze({
    pid,
    processStartTime: snapshot.processStartTime.trim(),
    executablePath,
    normalizedUserDataDir,
    launchNonce: launchClaim?.nonce ?? randomUUID(),
    ...(launchClaim ? { launchClaim } : {}),
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
  if (
    arePlatformProcessGenerationsDefinitelyDifferent(
      identity.processStartTime,
      snapshot.processStartTime.trim(),
    )
  ) {
    return "exited";
  }
  const executablePath = normalizeExecutablePath(snapshot.executablePath, platform);
  if (
    executablePath !== identity.executablePath ||
    !isChromeSnapshotForUserDataDir(snapshot, identity.profileDirectory.canonicalPath, platform) ||
    (identity.launchClaim && !isChromeSnapshotForLaunchClaim(snapshot, identity.launchClaim))
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
    sameChromeProcessLaunchClaim(left.launchClaim, right.launchClaim) &&
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
    !UUID_V4_PATTERN.test(record.launchNonce)
  ) {
    return null;
  }
  const launchClaim =
    record.launchClaim === undefined ? null : parseChromeProcessLaunchClaim(record.launchClaim);
  if (
    record.launchClaim !== undefined &&
    (!launchClaim || launchClaim.nonce !== record.launchNonce)
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
    ...(launchClaim ? { launchClaim } : {}),
    profileDirectory,
  });
}
export interface RunningChromeDebugTarget {
  pid: number;
  port: number;
}
export interface RunningClaimedChromeProcess {
  pid: number;
  port: number | null;
}
export interface ChromeLaunchClaimProcessDiscovery {
  exactMatches: readonly RunningClaimedChromeProcess[];
  conflictingProfilePids: readonly number[];
}

interface RunningChromeProcessCommand {
  pid: number;
  commandLine: string;
}

export async function inspectRunningChromeProcessesForLaunchClaim(
  userDataDir: string,
  claim: ChromeProcessLaunchClaim,
): Promise<ChromeLaunchClaimProcessDiscovery> {
  const validated = parseChromeProcessLaunchClaim(claim);
  if (!validated) throw new Error("Chrome launch claim is invalid");
  const platform = process.platform;
  const [activePort, processes] = await Promise.all([
    readDevToolsPort(userDataDir),
    listRunningChromeProcessCommands(platform, executeProcessCommand),
  ]);
  return inspectChromeProcessesForLaunchClaim(
    processes,
    userDataDir,
    validated,
    activePort,
    platform,
  );
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
  expectedLaunchClaim?: ChromeProcessLaunchClaim,
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
      const tokens = tokenizeCommandLine(command);
      if (!tokens || !isChromeCommandTokensForUserDataDir(tokens, userDataDir, process.platform)) {
        continue;
      }
      if (
        expectedLaunchClaim &&
        !sameChromeProcessLaunchClaim(
          readChromeProcessLaunchClaimArgument(tokens),
          expectedLaunchClaim,
        )
      ) {
        continue;
      }
      if (readRemoteDebuggingPortArgumentFromTokens(tokens) !== expectedDebugPortArgument) continue;
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

export function inspectChromeProcessesForLaunchClaimFromProcessListForTest(
  processList: string,
  userDataDir: string,
  claim: ChromeProcessLaunchClaim,
  activePort: number | null = null,
  platform: NodeJS.Platform = process.platform,
): ChromeLaunchClaimProcessDiscovery {
  const validated = parseChromeProcessLaunchClaim(claim);
  if (!validated) return { exactMatches: [], conflictingProfilePids: [] };
  return inspectChromeProcessesForLaunchClaim(
    parsePosixProcessCommands(processList),
    userDataDir,
    validated,
    activePort,
    platform,
  );
}

function inspectChromeProcessesForLaunchClaim(
  processes: readonly RunningChromeProcessCommand[],
  userDataDir: string,
  claim: ChromeProcessLaunchClaim,
  activePort: number | null,
  platform: NodeJS.Platform,
): ChromeLaunchClaimProcessDiscovery {
  const exactMatches = new Map<number, RunningClaimedChromeProcess>();
  const conflictingProfilePids = new Set<number>();
  for (const processCommand of processes) {
    const tokens = tokenizeCommandLine(processCommand.commandLine);
    if (
      !tokens ||
      !isChromeCommandTokensForUserDataDir(tokens, userDataDir, platform) ||
      !hasRemoteDebuggingPortArgument(tokens)
    ) {
      continue;
    }
    if (!sameChromeProcessLaunchClaim(readChromeProcessLaunchClaimArgument(tokens), claim)) {
      conflictingProfilePids.add(processCommand.pid);
      continue;
    }
    const configuredPort = readRemoteDebuggingPortArgumentFromTokens(tokens);
    const resolvedPort = configuredPort === 0 ? activePort : configuredPort;
    const port = resolvedPort && resolvedPort > 0 && resolvedPort <= 65_535 ? resolvedPort : null;
    exactMatches.set(processCommand.pid, { pid: processCommand.pid, port });
  }
  return {
    exactMatches: [...exactMatches.values()].sort((left, right) => left.pid - right.pid),
    conflictingProfilePids: [...conflictingProfilePids].sort((left, right) => left - right),
  };
}

async function listRunningChromeProcessCommands(
  platform: NodeJS.Platform,
  execute: ProcessCommandExecutor,
): Promise<readonly RunningChromeProcessCommand[]> {
  if (platform !== "win32") {
    const { stdout } = await execute("ps", ["-ax", "-o", "pid=", "-o", "command="]);
    return parsePosixProcessCommands(stdout);
  }
  const { stdout } = await execute("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|chromium)\\.exe$' } | ForEach-Object { $bytes = [Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine); '{0}:{1}' -f [int]$_.ProcessId, [Convert]::ToBase64String($bytes) }",
  ]);
  const processes: RunningChromeProcessCommand[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = line.match(/^(\d+):([A-Za-z0-9+/=]+)$/u);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const commandLine = Buffer.from(match[2] ?? "", "base64").toString("utf8");
    if (commandLine) processes.push({ pid, commandLine });
  }
  return processes;
}

function parsePosixProcessCommands(processList: string): readonly RunningChromeProcessCommand[] {
  const processes: RunningChromeProcessCommand[] = [];
  for (const line of processList.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    processes.push({ pid, commandLine: match[2] ?? "" });
  }
  return processes;
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
    const processGenerationProvider = createPlatformProcessGenerationProvider({
      platform,
      execute,
    });
    const processStartTime = await processGenerationProvider.readProcessGeneration(pid);
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
    const confirmedStartTime = await processGenerationProvider.readProcessGeneration(pid);
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

function isChromeSnapshotForLaunchClaim(
  snapshot: ChromeProcessSnapshot,
  claim: ChromeProcessLaunchClaim,
): boolean {
  const tokens = snapshot.commandTokens ?? tokenizeCommandLine(snapshot.commandLine);
  return Boolean(
    tokens && sameChromeProcessLaunchClaim(readChromeProcessLaunchClaimArgument(tokens), claim),
  );
}

function readChromeProcessLaunchClaimArgument(
  tokens: readonly string[],
): ChromeProcessLaunchClaim | undefined {
  const values: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const lower = token.toLowerCase();
    if (lower === CHROME_LAUNCH_CLAIM_FLAG) {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) return undefined;
      values.push(value);
      index += 1;
    } else if (lower.startsWith(`${CHROME_LAUNCH_CLAIM_FLAG}=`)) {
      values.push(token.slice(token.indexOf("=") + 1));
    }
  }
  if (values.length !== 1) return undefined;
  const parts = values[0]?.split(":") ?? [];
  if (parts.length !== 2) return undefined;
  return (
    parseChromeProcessLaunchClaim({ version: 1, generationId: parts[0], nonce: parts[1] }) ??
    undefined
  );
}

function hasRemoteDebuggingPortArgument(tokens: readonly string[]): boolean {
  return tokens.some((token) => {
    const lower = token.toLowerCase();
    return lower === "--remote-debugging-port" || lower.startsWith("--remote-debugging-port=");
  });
}

function readRemoteDebuggingPortArgument(command: string): number | null {
  const tokens = tokenizeCommandLine(command);
  return tokens ? readRemoteDebuggingPortArgumentFromTokens(tokens) : null;
}

function readRemoteDebuggingPortArgumentFromTokens(tokens: readonly string[]): number | null {
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

  const commands = await listPosixChromeProcessCommands(userDataDir);
  return (
    commands === null ||
    commands.some((command) => isChromeCommandForUserDataDir(command, userDataDir))
  );
}

const POSIX_PROCESS_QUERY_BATCH_SIZE = 64;

// Narrow by the exact profile argument before hydrating commands. pgrep is only a candidate
// filter; the tokenizer below remains the authority for executable and argument equality.

async function listPosixChromeProcessCommands(
  userDataDir: string,
): Promise<readonly string[] | null> {
  const searchPattern = buildPosixChromeProfileSearchPattern(userDataDir);
  if (searchPattern === null) return null;
  let pidOutput: string;
  try {
    ({ stdout: pidOutput } = await executeProcessCommand("/usr/bin/pgrep", [
      "-i",
      "-f",
      "--",
      searchPattern,
    ]));
  } catch (error) {
    return readProcessCommandExitCode(error) === 1 ? [] : null;
  }

  const pidLines = pidOutput.trim() ? pidOutput.trim().split(/\r?\n/u) : [];
  if (pidLines.length === 0 || pidLines.some((line) => !/^[1-9]\d*$/u.test(line))) return null;
  const pids = [...new Set(pidLines.map((line) => Number.parseInt(line, 10)))];
  if (pids.some((pid) => !Number.isSafeInteger(pid))) return null;

  const commands: string[] = [];
  for (let offset = 0; offset < pids.length; offset += POSIX_PROCESS_QUERY_BATCH_SIZE) {
    const batch = pids.slice(offset, offset + POSIX_PROCESS_QUERY_BATCH_SIZE);
    try {
      const { stdout } = await executeProcessCommand("/bin/ps", [
        "-ww",
        "-p",
        batch.join(","),
        "-o",
        "command=",
      ]);
      commands.push(...stdout.split(/\r?\n/u).filter(Boolean));
    } catch (error) {
      if (readProcessCommandExitCode(error) !== 1) return null;
    }
  }
  return commands;
}

function buildPosixChromeProfileSearchPattern(userDataDir: string): string | null {
  const normalized = normalizeProfileArgument(userDataDir, process.platform);
  if (normalized === null || /[\0\r\n]/u.test(normalized)) return null;
  const escaped = normalized.replace(/[\\.^$|?*+()[\]{}]/gu, "\\$&");
  return `--user-data-dir(=|[[:space:]]+)["']?${escaped}["']?([[:space:]]|$)`;
}

function readProcessCommandExitCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}
