import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    const lower = command.toLowerCase();
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!lower.includes("chrome") && !lower.includes("chromium")) continue;
    if (!lower.includes("user-data-dir") || !command.includes(userDataDir)) continue;
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

export async function terminateRecordedChromeForProfile(
  userDataDir: string,
  logger?: ProfileStateLogger,
): Promise<RecordedChromeTerminationOutcome> {
  const pidPath = path.join(userDataDir, CHROME_PID_FILENAME);
  let pid: number;
  try {
    const raw = (await readFile(pidPath, "utf8")).trim();
    pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return { status: "unsafe", reason: "recorded Chrome pid is invalid" };
    }
  } catch (error) {
    const errorCode =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (errorCode !== "ENOENT") {
      return {
        status: "unsafe",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (await isChromeUsingUserDataDir(userDataDir)) {
      return { status: "unsafe", reason: "Chrome is using the profile without a recorded pid" };
    }
    return { status: "already-stopped" };
  }
  if (!isProcessAlive(pid)) {
    if (await isChromeUsingUserDataDir(userDataDir)) {
      return { status: "unsafe", reason: "another Chrome process is using the profile", pid };
    }
    return { status: "already-stopped", pid };
  }
  const command = await readProcessCommand(pid);
  if (!isChromeCommandForUserDataDir(command, userDataDir)) {
    const reason = `Recorded Chrome pid ${pid} does not match ${userDataDir}`;
    logger?.(`${reason}; skipping termination`);
    return { status: "unsafe", reason, pid };
  }

  const gracefulError = await terminateChromeProcess(pid, false).then(
    () => null,
    (error: unknown) => error,
  );
  if (
    !gracefulError &&
    (await waitForChromeProfileProcessesToExit(userDataDir, CHROME_TERMINATION_TIMEOUT_MS, pid))
  ) {
    logger?.(`Terminated shared manual-login Chrome pid ${pid}`);
    return { status: "stopped", pid, signal: "SIGTERM" };
  }
  if (!isProcessAlive(pid) && !(await isChromeUsingUserDataDir(userDataDir))) {
    return { status: "already-stopped", pid };
  }

  const currentCommand = await readProcessCommand(pid);
  if (!isChromeCommandForUserDataDir(currentCommand, userDataDir)) {
    const reason = `Chrome pid ${pid} changed before forced termination`;
    logger?.(`${reason}; skipping forced termination`);
    return { status: "unsafe", reason, pid };
  }
  const forceError = await terminateChromeProcess(pid, true).then(
    () => null,
    (error: unknown) => error,
  );
  if (
    !forceError &&
    (await waitForChromeProfileProcessesToExit(
      userDataDir,
      CHROME_FORCE_TERMINATION_TIMEOUT_MS,
      pid,
    ))
  ) {
    logger?.(`Force-terminated shared manual-login Chrome pid ${pid}`);
    return { status: "stopped", pid, signal: "SIGKILL" };
  }
  if (!isProcessAlive(pid) && !(await isChromeUsingUserDataDir(userDataDir))) {
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

function isChromeCommandForUserDataDir(command: string | null, userDataDir: string): boolean {
  if (!command) return false;
  const lower = command.toLowerCase();
  return (
    (lower.includes("chrome") || lower.includes("chromium")) &&
    lower.includes("user-data-dir") &&
    lower.includes(userDataDir.toLowerCase())
  );
}

export function isChromeCommandForUserDataDirForTest(
  command: string | null,
  userDataDir: string,
): boolean {
  return isChromeCommandForUserDataDir(command, userDataDir);
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
  if (!pid) {
    return cleaned;
  }
  if (isProcessAlive(pid)) {
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
  logger?.("Cleaned up stale Chrome profile locks");
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

async function readProcessCommand(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  execute: ProcessCommandExecutor = executeProcessCommand,
): Promise<string | null> {
  try {
    if (platform === "win32") {
      const { stdout } = await execute("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference = 'Stop'; $process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${Math.trunc(pid)}'; if ($null -ne $process.CommandLine) { [Console]::Out.Write($process.CommandLine) }`,
      ]);
      const command = stdout.trim();
      return command || null;
    }
    const { stdout } = await execute("ps", ["-p", String(Math.trunc(pid)), "-o", "command="]);
    const command = stdout.trim();
    return command || null;
  } catch {
    return null;
  }
}

export function readProcessCommandForTest(
  pid: number,
  platform: NodeJS.Platform,
  execute: ProcessCommandExecutor,
): Promise<string | null> {
  return readProcessCommand(pid, platform, execute);
}
