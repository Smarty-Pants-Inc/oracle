import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { resolveWindowsPowerShellExecutable } from "../src/windowsSystemExecutable.js";

const execFileAsync = promisify(execFile);
const ATTACKER_SYSTEM_ROOT = String.raw`D:\Users\attacker\Windows`;
const TRUSTED_WINDOWS_POWERSHELL = String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;

describe("resolveWindowsPowerShellExecutable", () => {
  test("rejects an attacker-controlled inherited SystemRoot", () => {
    const originalSystemRoot = process.env.SystemRoot;
    process.env.SystemRoot = ATTACKER_SYSTEM_ROOT;
    try {
      const executable = resolveWindowsPowerShellExecutable();
      expect(executable).toBe(TRUSTED_WINDOWS_POWERSHELL);
      expect(executable).not.toContain(ATTACKER_SYSTEM_ROOT);
    } finally {
      if (originalSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = originalSystemRoot;
    }
  });

  test.runIf(process.platform === "win32")(
    "launches the exact OS-rooted PowerShell path through CreateProcess",
    async () => {
      const marker = "oracle-windows-system-powershell-v1";
      const { stdout } = await execFileAsync(
        resolveWindowsPowerShellExecutable(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[Console]::Out.Write('${marker}')`,
        ],
        { encoding: "utf8", timeout: 12_000, windowsHide: true },
      );
      expect(stdout).toBe(marker);
    },
  );
});
