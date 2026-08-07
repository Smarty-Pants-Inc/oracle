import { resolveWindowsPowerShellExecutable } from "../../windowsSystemExecutable.js";

const WINDOWS_BRIDGE_CHILD_LAUNCH_CONFIG = "ORACLE_BRIDGE_CHILD_LAUNCH_CONFIG";
export const WINDOWS_BRIDGE_CHILD_READINESS_STDOUT = "ORACLE_BRIDGE_CHILD_READINESS_STDOUT";

const WINDOWS_BRIDGE_JOB_SUPERVISOR_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class OracleBridgeJob {
  private const uint KillOnClose = 0x00002000;
  [StructLayout(LayoutKind.Sequential)] private struct BasicLimits { public long A; public long B; public uint Flags; public UIntPtr C; public UIntPtr D; public uint E; public UIntPtr F; public uint G; public uint H; }
  [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong A; public ulong B; public ulong C; public ulong D; public ulong E; public ulong F; }
  [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr A; public UIntPtr B; public UIntPtr C; public UIntPtr D; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
  public static IntPtr Create() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var limits = new ExtendedLimits(); limits.Basic.Flags = KillOnClose;
    int size = Marshal.SizeOf(typeof(ExtendedLimits)); IntPtr pointer = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(limits, pointer, false);
      if (!SetInformationJobObject(job, 9, pointer, (uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return job;
    } catch { CloseHandle(job); throw; } finally { Marshal.FreeHGlobal(pointer); }
  }
  public static void Assign(IntPtr job, IntPtr process) { if (!AssignProcessToJobObject(job, process)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Terminate(IntPtr job) { if (!TerminateJobObject(job, 1)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Close(IntPtr job) { if (job != IntPtr.Zero) CloseHandle(job); }
}
'@
$job = [IntPtr]::Zero
$child = $null
$assigned = $false
$exitCode = 1
try {
  $encodedConfig = [Environment]::GetEnvironmentVariable('${WINDOWS_BRIDGE_CHILD_LAUNCH_CONFIG}', 'Process')
  [Environment]::SetEnvironmentVariable('${WINDOWS_BRIDGE_CHILD_LAUNCH_CONFIG}', $null, 'Process')
  if ([String]::IsNullOrWhiteSpace($encodedConfig)) { throw 'missing launch configuration' }
  $config = ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedConfig)) | ConvertFrom-Json)
  if ([String]::IsNullOrWhiteSpace([string]$config.file)) { throw 'missing child executable' }
  $job = [OracleBridgeJob]::Create()
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = [string]$config.file
  $start.Arguments = [string]$config.arguments
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $child = New-Object Diagnostics.Process
  $child.StartInfo = $start
  if (!$child.Start()) { throw 'child process did not start' }
  [OracleBridgeJob]::Assign($job, $child.Handle)
  $assigned = $true
  $stdoutCopy = $child.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $stderrCopy = $child.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  [Console]::OpenStandardInput().CopyTo($child.StandardInput.BaseStream)
  $child.StandardInput.Close()
  $child.WaitForExit()
  $stdoutCopy.GetAwaiter().GetResult()
  $stderrCopy.GetAwaiter().GetResult()
  $exitCode = $child.ExitCode
} catch {
  [Console]::Error.WriteLine('Bridge host Windows supervisor failed.')
} finally {
  if ($assigned -and $job -ne [IntPtr]::Zero) { try { [OracleBridgeJob]::Terminate($job) } catch {} }
  if (!$assigned -and $null -ne $child -and !$child.HasExited) { try { $child.Kill() } catch {} }
  if ($null -ne $child) { try { $child.WaitForExit(5000) | Out-Null } catch {} }
  if ($job -ne [IntPtr]::Zero) { [OracleBridgeJob]::Close($job) }
}
exit $exitCode`;
const WINDOWS_BRIDGE_JOB_SUPERVISOR_ENCODED = Buffer.from(
  WINDOWS_BRIDGE_JOB_SUPERVISOR_SCRIPT,
  "utf16le",
).toString("base64");

function quoteWindowsCommandLineArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") backslashes += 1;
    else if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      result += "\\".repeat(backslashes) + character;
      backslashes = 0;
    }
  }
  return `${result}${"\\".repeat(backslashes * 2)}"`;
}

export function buildWindowsBridgeSupervisorLaunch(
  childArgs: readonly string[],
  parentEnv: NodeJS.ProcessEnv,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const config = Buffer.from(
    JSON.stringify({
      file: process.execPath,
      arguments: childArgs.map(quoteWindowsCommandLineArgument).join(" "),
    }),
    "utf8",
  ).toString("base64");
  return {
    command: resolveWindowsPowerShellExecutable(),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      WINDOWS_BRIDGE_JOB_SUPERVISOR_ENCODED,
    ],
    env: {
      ...parentEnv,
      [WINDOWS_BRIDGE_CHILD_LAUNCH_CONFIG]: config,
      [WINDOWS_BRIDGE_CHILD_READINESS_STDOUT]: "1",
    },
  };
}
