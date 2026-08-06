import { realpathSync } from "node:fs";

const WINDOWS_POWERSHELL_GLOBALROOT = String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;
const WINDOWS_POWERSHELL_CANONICAL =
  /^[A-Za-z]:\\(?:(?!\.{1,2}\\)[^\\]+\\)*System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu;
let trustedWindowsPowerShellExecutable: string | undefined;

// GLOBALROOT enters the OS-owned SystemRoot link without consulting ambient environment state.
export function resolveWindowsPowerShellExecutable(): string {
  if (process.platform !== "win32") return WINDOWS_POWERSHELL_GLOBALROOT;
  if (trustedWindowsPowerShellExecutable) return trustedWindowsPowerShellExecutable;

  const resolved = realpathSync.native(WINDOWS_POWERSHELL_GLOBALROOT);
  const executable = resolved.startsWith("\\\\?\\") ? resolved.slice(4) : resolved;
  if (!WINDOWS_POWERSHELL_CANONICAL.test(executable)) {
    throw new Error(
      "Windows PowerShell resolution did not yield the canonical System32 executable",
    );
  }
  trustedWindowsPowerShellExecutable = executable;
  return executable;
}
