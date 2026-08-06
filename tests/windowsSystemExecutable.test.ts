import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { createPlatformProcessGenerationProvider } from "../src/browser/platformProcessGeneration.js";
import {
  resolveWindowsOpenSshExecutable,
  resolveWindowsOpenSshExecutableForPlatform,
  resolveWindowsPowerShellExecutable,
  resolveWindowsPowerShellExecutableForPlatform,
} from "../src/windowsSystemExecutable.js";

const execFileAsync = promisify(execFile);
const ATTACKER_SYSTEM_ROOT = String.raw`D:\Users\attacker\Windows`;
const ATTACKER_WINDIR = String.raw`D:\Users\attacker\WinDir`;
const ATTACKER_PATH = String.raw`D:\Users\attacker\bin`;
const WINDOWS_POWERSHELL_GLOBALROOT = String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;
const WINDOWS_OPENSSH_GLOBALROOT = String.raw`\\?\GLOBALROOT\SystemRoot\System32\OpenSSH\ssh.exe`;
const WINDOWS_POWERSHELL_CANONICAL =
  /^[A-Za-z]:\\(?:(?!\.{1,2}\\)[^\\]+\\)*System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu;
const WINDOWS_OPENSSH_CANONICAL =
  /^[A-Za-z]:\\(?:(?!\.{1,2}\\)[^\\]+\\)*System32\\OpenSSH\\ssh\.exe$/iu;

const KERNEL_RESOLVED_POWERSHELL = String.raw`D:\ActiveWindows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const KERNEL_RESOLVED_OPENSSH = String.raw`D:\ActiveWindows\System32\OpenSSH\ssh.exe`;

test("uses the fixed GLOBALROOT source for a kernel-resolved active Windows root", () => {
  const inputs: string[] = [];
  const nativeRealpath = (input: string) => {
    inputs.push(input);
    return KERNEL_RESOLVED_POWERSHELL;
  };

  expect(resolveWindowsPowerShellExecutableForPlatform("win32", nativeRealpath)).toBe(
    KERNEL_RESOLVED_POWERSHELL,
  );
  expect(inputs).toEqual([WINDOWS_POWERSHELL_GLOBALROOT]);
});

test("uses the fixed GLOBALROOT source for kernel-resolved native Windows OpenSSH", () => {
  const inputs: string[] = [];
  const nativeRealpath = (input: string) => {
    inputs.push(input);
    return KERNEL_RESOLVED_OPENSSH;
  };

  expect(resolveWindowsOpenSshExecutableForPlatform("win32", nativeRealpath)).toBe(
    KERNEL_RESOLVED_OPENSSH,
  );
  expect(inputs).toEqual([WINDOWS_OPENSSH_GLOBALROOT]);
});

test.each([
  [String.raw`\\server\share\System32\WindowsPowerShell\v1.0\powershell.exe`, "UNC"],
  [String.raw`\\.\C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, "device"],
  [String.raw`C:System32\WindowsPowerShell\v1.0\powershell.exe`, "drive-relative"],
  [String.raw`C:\Windows\..\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, "traversal"],
  ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\\", "ambiguous"],
])("rejects a %s native realpath result", (resolved) => {
  expect(() => resolveWindowsPowerShellExecutableForPlatform("win32", () => resolved)).toThrow(
    "Windows PowerShell resolution did not yield the canonical System32 executable",
  );
});

test.each([
  [String.raw`\\server\share\System32\OpenSSH\ssh.exe`, "UNC"],
  [String.raw`\\.\C:\Windows\System32\OpenSSH\ssh.exe`, "device"],
  [String.raw`C:System32\OpenSSH\ssh.exe`, "drive-relative"],
  [String.raw`C:\Windows\..\Windows\System32\OpenSSH\ssh.exe`, "traversal"],
  ["C:\\Windows\\System32\\OpenSSH\\ssh.exe\\", "ambiguous"],
])("rejects a %s native OpenSSH realpath result", (resolved) => {
  expect(() => resolveWindowsOpenSshExecutableForPlatform("win32", () => resolved)).toThrow(
    "Windows OpenSSH resolution did not yield the canonical System32 executable",
  );
});

describe("trusted Windows system executables", () => {
  test("rejects attacker-controlled inherited Windows executable variables", () => {
    const originalSystemRoot = process.env.SystemRoot;
    const originalWindir = process.env.WINDIR;
    const originalPath = process.env.PATH;
    process.env.SystemRoot = ATTACKER_SYSTEM_ROOT;
    process.env.WINDIR = ATTACKER_WINDIR;
    process.env.PATH = ATTACKER_PATH;
    try {
      const powershellExecutable = resolveWindowsPowerShellExecutable();
      const sshExecutable = resolveWindowsOpenSshExecutable();
      if (process.platform === "win32") {
        expect(powershellExecutable).toMatch(WINDOWS_POWERSHELL_CANONICAL);
        expect(sshExecutable).toMatch(WINDOWS_OPENSSH_CANONICAL);
      } else {
        expect(powershellExecutable).toBe(WINDOWS_POWERSHELL_GLOBALROOT);
        expect(sshExecutable).toBe(WINDOWS_OPENSSH_GLOBALROOT);
      }
      for (const executable of [powershellExecutable, sshExecutable]) {
        expect(executable).not.toContain(ATTACKER_SYSTEM_ROOT);
        expect(executable).not.toContain(ATTACKER_WINDIR);
        expect(executable).not.toContain(ATTACKER_PATH);
      }
    } finally {
      if (originalSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = originalSystemRoot;
      if (originalWindir === undefined) delete process.env.WINDIR;
      else process.env.WINDIR = originalWindir;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  test.runIf(process.platform === "win32")(
    "runs kernel-resolved native executables with hostile PATH selection disabled",
    async () => {
      const originalSystemRoot = process.env.SystemRoot;
      const originalWindir = process.env.WINDIR;
      const originalPath = process.env.PATH;
      const marker = "oracle-windows-system-powershell-v1";
      process.env.SystemRoot = ATTACKER_SYSTEM_ROOT;
      process.env.WINDIR = ATTACKER_WINDIR;
      process.env.PATH = ATTACKER_PATH;
      try {
        const powershellExecutable = resolveWindowsPowerShellExecutable();
        const sshExecutable = resolveWindowsOpenSshExecutable();
        if (originalSystemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = originalSystemRoot;
        if (originalWindir === undefined) delete process.env.WINDIR;
        else process.env.WINDIR = originalWindir;

        const [{ stdout }, sshVersion] = await Promise.all([
          execFileAsync(
            powershellExecutable,
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `[Console]::Out.Write('${marker}')`,
            ],
            { encoding: "utf8", timeout: 12_000, windowsHide: true },
          ),
          execFileAsync(sshExecutable, ["-V"], {
            encoding: "utf8",
            timeout: 12_000,
            windowsHide: true,
          }),
        ]);
        const provider = createPlatformProcessGenerationProvider();
        const first = await provider.readProcessGeneration(process.pid);
        const second = await provider.readProcessGeneration(process.pid);

        expect(powershellExecutable).toMatch(WINDOWS_POWERSHELL_CANONICAL);
        expect(sshExecutable).toMatch(WINDOWS_OPENSSH_CANONICAL);
        expect(stdout).toBe(marker);
        expect(`${sshVersion.stdout}${sshVersion.stderr}`).toMatch(/OpenSSH/i);
        expect(first).not.toBeNull();
        expect(second).toBe(first);
      } finally {
        if (originalSystemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = originalSystemRoot;
        if (originalWindir === undefined) delete process.env.WINDIR;
        else process.env.WINDIR = originalWindir;
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    },
  );
});
