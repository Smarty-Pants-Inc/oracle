import { realpathSync } from "node:fs";

const WINDOWS_POWERSHELL_GLOBALROOT = String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;
const WINDOWS_POWERSHELL_CANONICAL =
  /^[A-Za-z]:\\(?:(?!\.{1,2}\\)[^\\]+\\)*System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu;
const WINDOWS_OPENSSH_GLOBALROOT = String.raw`\\?\GLOBALROOT\SystemRoot\System32\OpenSSH\ssh.exe`;
const WINDOWS_OPENSSH_CANONICAL =
  /^[A-Za-z]:\\(?:(?!\.{1,2}\\)[^\\]+\\)*System32\\OpenSSH\\ssh\.exe$/iu;
let trustedWindowsPowerShellExecutable: string | undefined;
let trustedWindowsOpenSshExecutable: string | undefined;

// GLOBALROOT enters the OS-owned SystemRoot link without consulting ambient environment state.
function resolveWindowsSystemExecutableForPlatform(
  platform: NodeJS.Platform,
  nativeRealpath: (path: string) => string,
  globalRootPath: string,
  canonicalPattern: RegExp,
  name: string,
): string {
  if (platform !== "win32") return globalRootPath;

  const resolved = nativeRealpath(globalRootPath);
  const executable = resolved.startsWith("\\\\?\\") ? resolved.slice(4) : resolved;
  if (!canonicalPattern.test(executable)) {
    throw new Error(`Windows ${name} resolution did not yield the canonical System32 executable`);
  }
  return executable;
}

export function resolveWindowsPowerShellExecutableForPlatform(
  platform: NodeJS.Platform,
  nativeRealpath: (path: string) => string,
): string {
  return resolveWindowsSystemExecutableForPlatform(
    platform,
    nativeRealpath,
    WINDOWS_POWERSHELL_GLOBALROOT,
    WINDOWS_POWERSHELL_CANONICAL,
    "PowerShell",
  );
}

export function resolveWindowsPowerShellExecutable(): string {
  if (process.platform !== "win32") return WINDOWS_POWERSHELL_GLOBALROOT;
  if (trustedWindowsPowerShellExecutable) return trustedWindowsPowerShellExecutable;

  trustedWindowsPowerShellExecutable = resolveWindowsPowerShellExecutableForPlatform(
    process.platform,
    realpathSync.native,
  );
  return trustedWindowsPowerShellExecutable;
}

export function resolveWindowsOpenSshExecutableForPlatform(
  platform: NodeJS.Platform,
  nativeRealpath: (path: string) => string,
): string {
  return resolveWindowsSystemExecutableForPlatform(
    platform,
    nativeRealpath,
    WINDOWS_OPENSSH_GLOBALROOT,
    WINDOWS_OPENSSH_CANONICAL,
    "OpenSSH",
  );
}

export function resolveWindowsOpenSshExecutable(): string {
  if (process.platform !== "win32") return WINDOWS_OPENSSH_GLOBALROOT;
  if (trustedWindowsOpenSshExecutable) return trustedWindowsOpenSshExecutable;

  trustedWindowsOpenSshExecutable = resolveWindowsOpenSshExecutableForPlatform(
    process.platform,
    realpathSync.native,
  );
  return trustedWindowsOpenSshExecutable;
}
