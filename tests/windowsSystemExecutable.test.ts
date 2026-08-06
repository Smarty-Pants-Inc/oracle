import { describe, expect, test } from "vitest";
import { resolveWindowsPowerShellExecutable } from "../src/windowsSystemExecutable.js";

const POWERSHELL_SUFFIX = String.raw`\System32\WindowsPowerShell\v1.0\powershell.exe`;

describe("resolveWindowsPowerShellExecutable", () => {
  test("accepts a canonical SystemRoot on any drive", () => {
    expect(resolveWindowsPowerShellExecutable(String.raw`D:\Windows`)).toBe(
      String.raw`D:\Windows${POWERSHELL_SUFFIX}`,
    );
  });

  test("defaults to the inherited SystemRoot authority", () => {
    const originalSystemRoot = process.env.SystemRoot;
    process.env.SystemRoot = String.raw`E:\Windows`;
    try {
      expect(resolveWindowsPowerShellExecutable()).toBe(String.raw`E:\Windows${POWERSHELL_SUFFIX}`);
    } finally {
      if (originalSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = originalSystemRoot;
    }
  });

  test("fails closed when the inherited SystemRoot is absent", () => {
    const originalSystemRoot = process.env.SystemRoot;
    delete process.env.SystemRoot;
    try {
      expect(() => resolveWindowsPowerShellExecutable()).toThrow(/canonical drive-absolute/u);
    } finally {
      if (originalSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = originalSystemRoot;
    }
  });

  test.each([
    ["empty", ""],
    ["relative", String.raw`Windows`],
    ["drive-relative", String.raw`D:Windows`],
    ["UNC", String.raw`\\server\share\Windows`],
    ["device", String.raw`\\?\D:\Windows`],
    ["root-only", "D:\\"],
    ["parent traversal", String.raw`D:\Windows\..\Windows`],
    ["current-directory traversal", String.raw`D:\Windows\.`],
    ["noncanonical trailing separator", "D:\\Windows\\"],
    ["ambiguous short-name alias", String.raw`D:\WINDOW~1`],
  ])("rejects %s SystemRoot input", (_label, systemRoot) => {
    expect(() => resolveWindowsPowerShellExecutable(systemRoot)).toThrow(
      /canonical drive-absolute/u,
    );
  });
});
