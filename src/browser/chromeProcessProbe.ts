import path from "node:path";
import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import {
  parseDarwinChromeExecutablePath,
  parseLinuxBootId,
  parseLinuxProcStat,
  parsePosixProcessCommands,
  parseWindowsChromeProcessSnapshot,
  parseWindowsProcessCommands,
  type ChromeProcessSnapshot,
  type RunningChromeProcessCommand,
} from "./chromeProcessCommandParsing.js";
import {
  createPlatformProcessGenerationProvider,
  createTrustedProcessProbe,
  type ProcessGenerationCommandExecutor,
  type TrustedProcessProbe,
} from "./platformProcessGeneration.js";

const execFileAsync = promisify(execFile);
// Process evidence gates destructive cleanup, so unavailable probes fail closed instead of stalling
// recovery indefinitely.
const PROCESS_IDENTITY_COMMAND_TIMEOUT_MS = 12_000;

export type ProcessCommandExecutor = ProcessGenerationCommandExecutor;

export const executeProcessCommand: ProcessCommandExecutor = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    timeout: PROCESS_IDENTITY_COMMAND_TIMEOUT_MS,
  });
  return { stdout: String(stdout ?? "") };
};

export interface LinuxProcfs {
  readFile(filePath: string, encoding?: "utf8"): Promise<string | Buffer>;
  readlink(filePath: string): Promise<string>;
}

const linuxProcfsFromDisk: LinuxProcfs = { readFile, readlink };

export async function listRunningChromeProcessCommands(
  platform: NodeJS.Platform,
  trustedProcessProbe: TrustedProcessProbe | null,
): Promise<readonly RunningChromeProcessCommand[]> {
  if (!trustedProcessProbe) throw new Error("Trusted process probe is unavailable");
  if (platform !== "win32") {
    const { stdout } = await trustedProcessProbe(["-axww", "-o", "pid=", "-o", "command="]);
    return parsePosixProcessCommands(stdout);
  }
  const { stdout } = await trustedProcessProbe([
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|chromium|msedge|brave)\\.exe$' } | ForEach-Object { $bytes = [Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine); '{0}:{1}' -f [int]$_.ProcessId, [Convert]::ToBase64String($bytes) }",
  ]);
  return parseWindowsProcessCommands(stdout);
}

export interface ChromeProcessSnapshotDeps {
  readonly execute?: ProcessCommandExecutor;
  readonly trustedProcessProbe?: TrustedProcessProbe | null;
  readonly linuxProcfs?: LinuxProcfs;
}

export async function readChromeProcessSnapshot(
  pid: number,
  platform: NodeJS.Platform,
  deps: ChromeProcessSnapshotDeps = {},
): Promise<ChromeProcessSnapshot | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const execute = deps.execute ?? executeProcessCommand;
  const trustedProcessProbe =
    deps.trustedProcessProbe === undefined
      ? createTrustedProcessProbe(platform, execute)
      : deps.trustedProcessProbe;
  if ((platform === "win32" || platform === "darwin") && !trustedProcessProbe) return null;
  try {
    if (platform === "linux") {
      const procfs = deps.linuxProcfs ?? linuxProcfsFromDisk;
      const procRoot = `/proc/${Math.trunc(pid)}`;
      const initialStat = parseLinuxProcStat(
        (await procfs.readFile(path.posix.join(procRoot, "stat"), "utf8")).toString(),
      );
      const initialBootId = parseLinuxBootId(
        (await procfs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).toString(),
      );
      if (!initialStat || initialStat.pid !== pid || !initialBootId) return null;
      const executablePath = await procfs.readlink(path.posix.join(procRoot, "exe"));
      const rawCommandLine = (await procfs.readFile(path.posix.join(procRoot, "cmdline"))).toString(
        "utf8",
      );
      const confirmedExecutablePath = await procfs.readlink(path.posix.join(procRoot, "exe"));
      const confirmedCommandLine = (
        await procfs.readFile(path.posix.join(procRoot, "cmdline"))
      ).toString("utf8");
      const confirmedStat = parseLinuxProcStat(
        (await procfs.readFile(path.posix.join(procRoot, "stat"), "utf8")).toString(),
      );
      const confirmedBootId = parseLinuxBootId(
        (await procfs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).toString(),
      );
      if (
        !confirmedStat ||
        confirmedStat.pid !== pid ||
        confirmedStat.startTicks !== initialStat.startTicks ||
        confirmedBootId !== initialBootId ||
        confirmedExecutablePath !== executablePath ||
        confirmedCommandLine !== rawCommandLine
      ) {
        return null;
      }
      const commandTokens = rawCommandLine.split("\0");
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
      if (!trustedProcessProbe) return null;
      const { stdout } = await trustedProcessProbe([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference = 'Stop'; $process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${Math.trunc(pid)}'; if ($null -eq $process) { exit 3 }; [ordered]@{ pid = [int]$process.ProcessId; processStartTime = $process.CreationDate.ToUniversalTime().ToString('O'); executablePath = [string]$process.ExecutablePath; commandLine = [string]$process.CommandLine } | ConvertTo-Json -Compress`,
      ]);
      return parseWindowsChromeProcessSnapshot(stdout, pid);
    }

    if (platform !== "darwin") return null;
    const processGenerationProvider = createPlatformProcessGenerationProvider({
      platform,
      execute,
      trustedProcessProbe,
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
    const executablePath = parseDarwinChromeExecutablePath(executableFiles);
    if (!trustedProcessProbe) return null;
    const { stdout: commandOutput } = await trustedProcessProbe([
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
