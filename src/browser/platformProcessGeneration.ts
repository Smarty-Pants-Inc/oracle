import { execFile } from "node:child_process";
import { readFile as readFileFromDisk } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROCESS_GENERATION_COMMAND_TIMEOUT_MS = 12_000;
// proc_pidinfo(PROC_PIDTBSDINFO) returns the kernel's microsecond launch timestamp for ordinary
// processes. Keep this script self-contained because the Node runtime has no libproc binding.
const DARWIN_PROC_BSDINFO_SCRIPT = String.raw`import ctypes as c, sys
class ProcBsdInfo(c.Structure):
    _fields_ = [("pbi_flags", c.c_uint32), ("pbi_status", c.c_uint32), ("pbi_xstatus", c.c_uint32), ("pbi_pid", c.c_uint32), ("pbi_ppid", c.c_uint32), ("pbi_uid", c.c_uint32), ("pbi_gid", c.c_uint32), ("pbi_ruid", c.c_uint32), ("pbi_rgid", c.c_uint32), ("pbi_svuid", c.c_uint32), ("pbi_svgid", c.c_uint32), ("rfu_1", c.c_uint32), ("pbi_comm", c.c_char * 16), ("pbi_name", c.c_char * 32), ("pbi_nfiles", c.c_uint32), ("pbi_pgid", c.c_uint32), ("pbi_pjobc", c.c_uint32), ("e_tdev", c.c_uint32), ("e_tpgid", c.c_uint32), ("pbi_nice", c.c_int32), ("pbi_start_tvsec", c.c_uint64), ("pbi_start_tvusec", c.c_uint64)]
pid = int(sys.argv[1]); info = ProcBsdInfo()
read = c.CDLL("/usr/lib/libproc.dylib").proc_pidinfo(pid, 3, 0, c.byref(info), c.sizeof(info))
if read != c.sizeof(info) or info.pbi_pid != pid or info.pbi_start_tvusec >= 1000000: raise SystemExit(1)
print(f"{info.pbi_pid}:{info.pbi_start_tvsec}:{info.pbi_start_tvusec}")`;

export interface ProcessGenerationCommandOptions {
  timeoutMs?: number;
}

export type ProcessGenerationCommandExecutor = (
  file: string,
  args: string[],
  options?: ProcessGenerationCommandOptions,
) => Promise<{ stdout: string }>;
type ProcessGenerationFileReader = (path: string, encoding: "utf8") => Promise<string>;

export interface PlatformProcessGenerationProvider {
  readonly platform: NodeJS.Platform;
  readonly readProcessGeneration: (pid: number, timeoutMs?: number) => Promise<string | null>;
}

export interface PlatformProcessGenerationProviderDeps {
  platform?: NodeJS.Platform;
  execute?: ProcessGenerationCommandExecutor;
  readFile?: ProcessGenerationFileReader;
}

type DarwinProcessGenerationNamespace = "audit-pidversion" | "kernel-start" | "sample-launch";
export type PlatformProcessGenerationComparison = "same" | "different" | "incomparable";

// A namespace switch is not evidence of PID reuse or continuity. Chrome may bridge it only with
// an independent launch claim; filesystem locks continue treating it as not definitely different.
export function comparePlatformProcessGenerations(
  persistedIdentity: string,
  observedIdentity: string,
): PlatformProcessGenerationComparison {
  if (persistedIdentity === observedIdentity) return "same";
  const persistedDarwinNamespace = readDarwinProcessGenerationNamespace(persistedIdentity);
  const observedDarwinNamespace = readDarwinProcessGenerationNamespace(observedIdentity);
  return persistedDarwinNamespace !== null &&
    observedDarwinNamespace !== null &&
    persistedDarwinNamespace !== observedDarwinNamespace
    ? "incomparable"
    : "different";
}

export function arePlatformProcessGenerationsDefinitelyDifferent(
  persistedIdentity: string,
  observedIdentity: string,
): boolean {
  return comparePlatformProcessGenerations(persistedIdentity, observedIdentity) === "different";
}

function readDarwinProcessGenerationNamespace(
  identity: string,
): DarwinProcessGenerationNamespace | null {
  if (/^darwin-audit-pidversion:\d+$/u.test(identity)) return "audit-pidversion";
  if (/^darwin-kernel-start:\d+:\d{6}$/u.test(identity)) return "kernel-start";
  if (
    /^darwin-sample-launch:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,9}[+-]\d{4}$/u.test(identity)
  ) {
    return "sample-launch";
  }
  return null;
}

const executeProcessGenerationCommand: ProcessGenerationCommandExecutor = async (
  file,
  args,
  options,
) => {
  const { stdout } = await execFileAsync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    timeout: options?.timeoutMs ?? PROCESS_GENERATION_COMMAND_TIMEOUT_MS,
  });
  return { stdout: String(stdout ?? "") };
};

export function createPlatformProcessGenerationProvider(
  deps: PlatformProcessGenerationProviderDeps = {},
): PlatformProcessGenerationProvider {
  const platform = deps.platform ?? process.platform;
  const execute = deps.execute ?? executeProcessGenerationCommand;
  const readFile = deps.readFile ?? readFileFromDisk;
  return {
    platform,
    readProcessGeneration: (pid, timeoutMs) =>
      readPlatformProcessGeneration(pid, platform, execute, readFile, timeoutMs),
  };
}

async function readPlatformProcessGeneration(
  pid: number,
  platform: NodeJS.Platform,
  execute: ProcessGenerationCommandExecutor,
  readFile: ProcessGenerationFileReader,
  timeoutMs?: number,
): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "linux") return await readLinuxProcessGeneration(pid, readFile);
    if (platform === "win32") return await readWindowsProcessGeneration(pid, execute, timeoutMs);
    if (platform === "darwin") return await readDarwinProcessGeneration(pid, execute, timeoutMs);
    return null;
  } catch {
    return null;
  }
}

async function readLinuxProcessGeneration(
  pid: number,
  readFile: ProcessGenerationFileReader,
): Promise<string | null> {
  const initialStat = parseLinuxProcStat(await readFile(`/proc/${pid}/stat`, "utf8"));
  const initialBootId = parseLinuxBootId(await readFile("/proc/sys/kernel/random/boot_id", "utf8"));
  if (!initialStat || initialStat.pid !== pid || !initialBootId) return null;
  const confirmedStat = parseLinuxProcStat(await readFile(`/proc/${pid}/stat`, "utf8"));
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
  return `linux:${initialBootId}:${initialStat.startTicks}`;
}

async function readWindowsProcessGeneration(
  pid: number,
  execute: ProcessGenerationCommandExecutor,
  timeoutMs?: number,
): Promise<string | null> {
  // Get-Process.StartTime is unavailable for the Node process on hosted Windows runners.
  // Win32_Process.CreationDate is provider-backed creation metadata, and distinguishes a later
  // process that reuses the same numeric identifier.
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$ErrorActionPreference = 'Stop'; $process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; if ($null -eq $process -or $null -eq $process.CreationDate) { exit 3 }; [Console]::Out.Write($process.CreationDate.ToUniversalTime().ToString('O'))`,
  ];
  const { stdout } =
    timeoutMs === undefined
      ? await execute("powershell.exe", args)
      : await execute("powershell.exe", args, { timeoutMs });
  const startTime = stdout.trim();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u.test(startTime)
    ? `win32:${startTime}`
    : null;
}

async function readDarwinProcessGeneration(
  pid: number,
  execute: ProcessGenerationCommandExecutor,
  timeoutMs?: number,
): Promise<string | null> {
  const appInfoArgs = ["info", String(pid)];
  let appInfo: string;
  try {
    const { stdout } =
      timeoutMs === undefined
        ? await execute("/usr/bin/lsappinfo", appInfoArgs)
        : await execute("/usr/bin/lsappinfo", appInfoArgs, { timeoutMs });
    appInfo = stdout;
  } catch {
    appInfo = "";
  }
  const auditGeneration = parseDarwinAuditPidVersion(appInfo, pid);
  if (auditGeneration) return auditGeneration;
  // Ordinary CLI processes can produce nonempty LaunchServices diagnostics or other non-audit
  // output. Accept only the exact audit identity above; otherwise continue to kernel providers.

  const kernelGeneration = await readDarwinKernelProcessGeneration(pid, execute, timeoutMs);
  if (kernelGeneration) return kernelGeneration;

  // The diagnostic fallback is for hosts without /usr/bin/python3. It must be directed to stdout
  // because sample otherwise persists a diagnostic report in /tmp for every lock acquisition.
  const sampleArgs = [String(pid), "1", "1", "-file", "/dev/stdout"];
  const { stdout: sample } =
    timeoutMs === undefined
      ? await execute("/usr/bin/sample", sampleArgs)
      : await execute("/usr/bin/sample", sampleArgs, { timeoutMs });
  return parseDarwinSampleLaunchTime(sample, pid);
}

async function readDarwinKernelProcessGeneration(
  pid: number,
  execute: ProcessGenerationCommandExecutor,
  timeoutMs?: number,
): Promise<string | null> {
  try {
    const args = ["-I", "-S", "-c", DARWIN_PROC_BSDINFO_SCRIPT, String(pid)];
    const { stdout } =
      timeoutMs === undefined
        ? await execute("/usr/bin/python3", args)
        : await execute("/usr/bin/python3", args, { timeoutMs });
    return parseDarwinKernelProcessGeneration(stdout, pid);
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

function parseDarwinKernelProcessGeneration(raw: string, expectedPid: number): string | null {
  const match = raw.trim().match(/^(\d+):(\d+):(\d{1,6})$/u);
  if (
    match?.[1] !== String(expectedPid) ||
    !match[2] ||
    !match[3] ||
    Number.parseInt(match[3], 10) >= 1_000_000
  ) {
    return null;
  }
  return `darwin-kernel-start:${match[2]}:${match[3].padStart(6, "0")}`;
}

function parseDarwinSampleLaunchTime(raw: string, expectedPid: number): string | null {
  const sampledPid = raw.match(/^Process:\s+.+\[(\d+)\]\s*$/mu)?.[1];
  const launchTime = raw.match(
    /^Launch Time:\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3,9})\s+([+-]\d{4})\s*$/mu,
  );
  if (sampledPid !== String(expectedPid) || !launchTime?.[1] || !launchTime[2]) return null;
  return `darwin-sample-launch:${launchTime[1].replace(" ", "T")}${launchTime[2]}`;
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
  const parsedPid = Number.parseInt(raw.slice(0, openingParenthesis).trim(), 10);
  const fieldsAfterCommand = raw
    .slice(closingParenthesis + 1)
    .trim()
    .split(/\s+/u);
  const startTicks = fieldsAfterCommand[19];
  if (!Number.isInteger(parsedPid) || parsedPid <= 0 || !startTicks || !/^\d+$/u.test(startTicks)) {
    return null;
  }
  return { pid: parsedPid, startTicks };
}
