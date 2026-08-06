const WINDOWS_POWERSHELL_SUFFIX = String.raw`\System32\WindowsPowerShell\v1.0\powershell.exe`;
const WINDOWS_SYSTEM_ROOT_PATTERN =
  /^[A-Za-z]:\\[^\\/:*?"<>|\u0000-\u001f]+(?:\\[^\\/:*?"<>|\u0000-\u001f]+)*$/u;
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const WINDOWS_SHORT_NAME_PATTERN = /~\d+(?:\.[^.]*)?$/u;

export function resolveWindowsPowerShellExecutable(systemRoot = process.env.SystemRoot): string {
  const segments = systemRoot?.slice(3).split("\\");
  if (
    !systemRoot ||
    !WINDOWS_SYSTEM_ROOT_PATTERN.test(systemRoot) ||
    !segments ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        segment !== segment.trim() ||
        segment.endsWith(".") ||
        WINDOWS_RESERVED_NAME_PATTERN.test(segment) ||
        WINDOWS_SHORT_NAME_PATTERN.test(segment),
    )
  ) {
    throw new Error("Windows SystemRoot must be a canonical drive-absolute system directory");
  }
  return `${systemRoot}${WINDOWS_POWERSHELL_SUFFIX}`;
}
