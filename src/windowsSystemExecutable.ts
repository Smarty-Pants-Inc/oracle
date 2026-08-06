const WINDOWS_POWERSHELL_EXECUTABLE = String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;

// GLOBALROOT enters the true NT object-manager root. Its SystemRoot link is OS-owned boot
// authority, so neither an inherited environment variable nor a DOS drive mapping selects this file.
export function resolveWindowsPowerShellExecutable(): string {
  return WINDOWS_POWERSHELL_EXECUTABLE;
}
