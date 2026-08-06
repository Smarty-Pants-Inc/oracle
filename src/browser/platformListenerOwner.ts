import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import { resolveWindowsPowerShellExecutable } from "../windowsSystemExecutable.js";
import { createPlatformProcessGenerationProvider } from "./platformProcessGeneration.js";

const execFileAsync = promisify(execFile);
const LISTENER_OWNER_COMMAND_TIMEOUT_MS = 12_000;

export interface PlatformListeningPortOwner {
  readonly pid: number;
  readonly processGeneration?: string;
}

export interface ListenerOwnerCommandOptions {
  readonly timeoutMs?: number;
}

export type ListenerOwnerCommandExecutor = (
  file: string,
  args: string[],
  options?: ListenerOwnerCommandOptions,
) => Promise<{ stdout: string }>;

type ListenerOwnerFileReader = (path: string, encoding: "utf8") => Promise<string>;
type ListenerOwnerDirectoryReader = (path: string) => Promise<readonly string[]>;
type ListenerOwnerLinkReader = (path: string) => Promise<string>;

export interface PlatformListenerOwnerDeps {
  readonly platform?: NodeJS.Platform;
  readonly execute?: ListenerOwnerCommandExecutor;
  readonly readFile?: ListenerOwnerFileReader;
  readonly readDirectory?: ListenerOwnerDirectoryReader;
  readonly readLink?: ListenerOwnerLinkReader;
  readonly readProcessGeneration?: (pid: number) => Promise<string | null>;
}

const executeListenerOwnerCommand: ListenerOwnerCommandExecutor = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    timeout: options?.timeoutMs ?? LISTENER_OWNER_COMMAND_TIMEOUT_MS,
  });
  return { stdout: String(stdout ?? "") };
};

export async function resolveListeningPortOwner(
  port: number,
  deps: PlatformListenerOwnerDeps = {},
): Promise<PlatformListeningPortOwner | null> {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === "darwin") {
      const pid = await resolveDarwinListeningPortOwnerPid(
        port,
        deps.execute ?? executeListenerOwnerCommand,
      );
      return pid === null ? null : { pid };
    }
    if (platform === "linux") {
      const readFileFromProc = deps.readFile ?? readFile;
      const readProcessGeneration =
        deps.readProcessGeneration ??
        createPlatformProcessGenerationProvider({
          platform: "linux",
          readFile: readFileFromProc,
        }).readProcessGeneration;
      return await resolveLinuxListeningPortOwner(
        port,
        readFileFromProc,
        deps.readDirectory ?? readdir,
        deps.readLink ?? readlink,
        readProcessGeneration,
      );
    }
    if (platform === "win32") {
      return await resolveWindowsListeningPortOwner(
        port,
        deps.execute ?? executeListenerOwnerCommand,
      );
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveListeningPortOwnerPid(
  port: number,
  deps: PlatformListenerOwnerDeps = {},
): Promise<number | null> {
  return (await resolveListeningPortOwner(port, deps))?.pid ?? null;
}

async function resolveDarwinListeningPortOwnerPid(
  port: number,
  execute: ListenerOwnerCommandExecutor,
): Promise<number | null> {
  const { stdout } = await execute("/usr/sbin/lsof", [
    "-nP",
    "-a",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-Fp",
  ]);
  return parseSinglePid(
    stdout
      .split(/\r?\n/u)
      .map((line) => line.match(/^p(\d+)$/u)?.[1] ?? "")
      .filter(Boolean),
  );
}

async function resolveLinuxListeningPortOwner(
  port: number,
  readFileFromProc: ListenerOwnerFileReader,
  readDirectory: ListenerOwnerDirectoryReader,
  readLink: ListenerOwnerLinkReader,
  readProcessGeneration: (pid: number) => Promise<string | null>,
): Promise<PlatformListeningPortOwner | null> {
  const firstPid = await resolveLinuxListeningPortOwnerPid(
    port,
    readFileFromProc,
    readDirectory,
    readLink,
  );
  if (firstPid === null) return null;
  const firstGeneration = await readProcessGeneration(firstPid);
  if (!firstGeneration) return null;

  const confirmedPid = await resolveLinuxListeningPortOwnerPid(
    port,
    readFileFromProc,
    readDirectory,
    readLink,
  );
  if (confirmedPid !== firstPid) return null;
  const confirmedGeneration = await readProcessGeneration(confirmedPid);
  if (confirmedGeneration !== firstGeneration) return null;
  return { pid: firstPid, processGeneration: firstGeneration };
}

async function resolveLinuxListeningPortOwnerPid(
  port: number,
  readFileFromProc: ListenerOwnerFileReader,
  readDirectory: ListenerOwnerDirectoryReader,
  readLink: ListenerOwnerLinkReader,
): Promise<number | null> {
  const socketInodes = await readLinuxListeningSocketInodes(port, readFileFromProc);
  if (!socketInodes || socketInodes.size === 0) return null;

  const owners = new Set<number>();
  for (const entry of await readDirectory("/proc")) {
    if (!/^[1-9]\d*$/u.test(entry)) continue;
    const pid = Number.parseInt(entry, 10);
    let descriptors: readonly string[];
    try {
      descriptors = await readDirectory(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const descriptor of descriptors) {
      let target: string;
      try {
        target = await readLink(`/proc/${pid}/fd/${descriptor}`);
      } catch {
        continue;
      }
      const inode = target.match(/^socket:\[(\d+)\]$/u)?.[1];
      if (inode && socketInodes.has(inode)) {
        owners.add(pid);
        break;
      }
    }
    if (owners.size > 1) return null;
  }
  return owners.size === 1 ? ([...owners][0] ?? null) : null;
}

async function readLinuxListeningSocketInodes(
  port: number,
  readFileFromProc: ListenerOwnerFileReader,
): Promise<Set<string> | null> {
  const [tcp, tcp6] = await Promise.all([
    readOptionalProcNetTable("/proc/net/tcp", readFileFromProc),
    readOptionalProcNetTable("/proc/net/tcp6", readFileFromProc),
  ]);
  const inodes = new Set<string>();
  for (const table of [tcp, tcp6]) {
    for (const line of table.split(/\r?\n/u).slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 4 || fields[3] !== "0A") continue;
      const localAddress = fields[1] ?? "";
      const separator = localAddress.lastIndexOf(":");
      if (separator < 0) continue;
      const localPort = Number.parseInt(localAddress.slice(separator + 1), 16);
      if (localPort !== port) continue;
      const inode = fields[9];
      if (!inode || !/^[1-9]\d*$/u.test(inode)) return null;
      inodes.add(inode);
    }
  }
  return inodes;
}

async function readOptionalProcNetTable(
  path: string,
  readFileFromProc: ListenerOwnerFileReader,
): Promise<string> {
  try {
    return await readFileFromProc(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function resolveWindowsListeningPortOwner(
  port: number,
  execute: ListenerOwnerCommandExecutor,
): Promise<PlatformListeningPortOwner | null> {
  const script = String.raw`$ErrorActionPreference = 'Stop'
$FirstOwners = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
if ($FirstOwners.Count -ne 1) { exit 3 }
$OwnerPid = [int64]$FirstOwners[0]
$Before = Get-CimInstance Win32_Process -Filter "ProcessId = $OwnerPid" -ErrorAction Stop
if ($null -eq $Before -or $null -eq $Before.CreationDate) { exit 4 }
$FirstGeneration = $Before.CreationDate.ToUniversalTime().ToString('O')
$ConfirmedOwners = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
if ($ConfirmedOwners.Count -ne 1 -or [int64]$ConfirmedOwners[0] -ne $OwnerPid) { exit 5 }
$After = Get-CimInstance Win32_Process -Filter "ProcessId = $OwnerPid" -ErrorAction Stop
if ($null -eq $After -or $null -eq $After.CreationDate) { exit 6 }
$ConfirmedGeneration = $After.CreationDate.ToUniversalTime().ToString('O')
if ($ConfirmedGeneration -ne $FirstGeneration) { exit 7 }
[Console]::Out.Write("$OwnerPid|$FirstGeneration")`;
  const { stdout } = await execute(
    resolveWindowsPowerShellExecutable(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { timeoutMs: LISTENER_OWNER_COMMAND_TIMEOUT_MS },
  );
  const match = stdout.trim().match(/^(\d+)\|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z)$/u);
  if (!match) return null;
  const pid = Number.parseInt(match[1] ?? "", 10);
  return pid > 0 ? { pid, processGeneration: `win32:${match[2]}` } : null;
}

function parseSinglePid(values: Iterable<string>): number | null {
  const pids = new Set<number>();
  for (const value of values) {
    const pid = Number.parseInt(value, 10);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return pids.size === 1 ? ([...pids][0] ?? null) : null;
}
