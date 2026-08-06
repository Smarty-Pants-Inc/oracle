import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { createPlatformProcessGenerationProvider } from "../src/browser/platformProcessGeneration.js";
import { resolveWindowsPowerShellExecutable } from "../src/windowsSystemExecutable.js";

const execFileAsync = promisify(execFile);
const ATTACKER_SYSTEM_ROOT = String.raw`D:\Users\attacker\Windows`;
const ATTACKER_WINDIR = String.raw`D:\Users\attacker\WinDir`;
const ATTACKER_PATH = String.raw`D:\Users\attacker\bin`;
const WINDOWS_POWERSHELL_GLOBALROOT = String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;
const WINDOWS_POWERSHELL_CANONICAL =
  /^[A-Za-z]:\\(?:(?!\.{1,2}\\)[^\\]+\\)*System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu;

describe("resolveWindowsPowerShellExecutable", () => {
  test("rejects attacker-controlled inherited Windows executable variables", () => {
    const originalSystemRoot = process.env.SystemRoot;
    const originalWindir = process.env.WINDIR;
    const originalPath = process.env.PATH;
    process.env.SystemRoot = ATTACKER_SYSTEM_ROOT;
    process.env.WINDIR = ATTACKER_WINDIR;
    process.env.PATH = ATTACKER_PATH;
    try {
      const executable = resolveWindowsPowerShellExecutable();
      if (process.platform === "win32") expect(executable).toMatch(WINDOWS_POWERSHELL_CANONICAL);
      else expect(executable).toBe(WINDOWS_POWERSHELL_GLOBALROOT);
      expect(executable).not.toContain(ATTACKER_SYSTEM_ROOT);
      expect(executable).not.toContain(ATTACKER_WINDIR);
      expect(executable).not.toContain(ATTACKER_PATH);
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
    "uses the kernel-resolved PowerShell for a marker and stable process generation",
    async () => {
      const originalSystemRoot = process.env.SystemRoot;
      const originalWindir = process.env.WINDIR;
      const originalPath = process.env.PATH;
      const marker = "oracle-windows-system-powershell-v1";
      process.env.SystemRoot = ATTACKER_SYSTEM_ROOT;
      process.env.WINDIR = ATTACKER_WINDIR;
      process.env.PATH = ATTACKER_PATH;
      try {
        const executable = resolveWindowsPowerShellExecutable();
        const { stdout } = await execFileAsync(
          executable,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `[Console]::Out.Write('${marker}')`,
          ],
          { encoding: "utf8", timeout: 12_000, windowsHide: true },
        );
        const provider = createPlatformProcessGenerationProvider();
        const first = await provider.readProcessGeneration(process.pid);
        const second = await provider.readProcessGeneration(process.pid);

        expect(executable).toMatch(WINDOWS_POWERSHELL_CANONICAL);
        expect(stdout).toBe(marker);
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
