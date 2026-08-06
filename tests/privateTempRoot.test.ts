import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import {
  createPrivateTempGeneration,
  removePrivateTempGeneration,
} from "../src/privateTempRoot.js";
import { resolveWindowsPowerShellExecutable } from "../src/windowsSystemExecutable.js";

const execFileAsync = promisify(execFile);

describe("private temporary root authority", () => {
  test("proves the Windows parent before creating a per-run generation", async () => {
    const ambient = await mkdtemp(path.join(os.tmpdir(), "oracle-private-temp-order-"));
    const rootPath = path.join(ambient, "oracle-private");
    const calls: { path: string; existed: boolean }[] = [];
    let rootProven = false;
    const windowsPrivateDirectoryAuthority = vi.fn(async (directoryPath: string) => {
      const existed = await lstat(directoryPath).then(
        () => true,
        () => false,
      );
      calls.push({ path: directoryPath, existed });
      if (directoryPath === rootPath) {
        if (!existed) {
          expect(await readdir(ambient)).toEqual([]);
          await mkdir(directoryPath, { mode: 0o700 });
        }
        rootProven = true;
        return;
      }
      expect(rootProven).toBe(true);
      expect(path.dirname(directoryPath)).toBe(rootPath);
      if (!existed) {
        expect(await readdir(rootPath)).toEqual([]);
        await mkdir(directoryPath, { mode: 0o700 });
      }
    });

    try {
      const generation = await createPrivateTempGeneration("remote-", {
        platform: "win32",
        tempDirectory: ambient,
        randomId: () => "fixed-generation",
        windowsPrivateDirectoryAuthority,
      });

      expect(generation.path).toBe(path.join(rootPath, "remote-fixed-generation"));
      expect(calls[0]).toEqual({ path: rootPath, existed: false });
      const childCreation = calls.find((call) => call.path === generation.path && !call.existed);
      expect(childCreation).toBeDefined();
      expect(await readdir(generation.path)).toEqual([]);
    } finally {
      await rm(ambient, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "keeps 0700 authority, removes the exact generation, and retains substitutions",
    async () => {
      const ambient = await mkdtemp(path.join(os.tmpdir(), "oracle-private-temp-cleanup-"));
      try {
        const exact = await createPrivateTempGeneration("exact-", { tempDirectory: ambient });
        await writeFile(path.join(exact.path, "secret"), "private", { mode: 0o600 });
        expect((await lstat(exact.parent.path)).mode & 0o777).toBe(0o700);
        expect((await lstat(exact.path)).mode & 0o777).toBe(0o700);
        expect((await lstat(path.join(exact.path, "secret"))).mode & 0o777).toBe(0o600);
        await expect(removePrivateTempGeneration(exact)).resolves.toBe(true);
        await expect(lstat(exact.path)).rejects.toMatchObject({ code: "ENOENT" });

        const substituted = await createPrivateTempGeneration("substituted-", {
          tempDirectory: ambient,
        });
        await writeFile(path.join(substituted.path, "secret"), "retained", { mode: 0o600 });
        const moved = `${substituted.path}-moved`;
        await rename(substituted.path, moved);
        await mkdir(substituted.path, { mode: 0o700 });

        await expect(removePrivateTempGeneration(substituted)).resolves.toBe(false);
        expect((await lstat(substituted.path)).isDirectory()).toBe(true);
        await expect(readFile(path.join(moved, "secret"), "utf8")).resolves.toBe("retained");
      } finally {
        await rm(ambient, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "win32")(
    "uses real Windows ACL wiring and blocks hostile TEMP inheritance from endpoint and cookie files",
    async () => {
      const ambient = await mkdtemp(path.join(os.tmpdir(), "oracle-private-temp-windows-"));
      const encodedAmbient = Buffer.from(ambient, "utf8").toString("base64");
      const hostileScript = String.raw`
$Ambient = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedAmbient}'))
$CurrentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$Acl = [System.Security.AccessControl.DirectorySecurity]::new()
$Acl.SetOwner($CurrentSid)
$Acl.SetAccessRuleProtection($true, $false)
$Inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$Acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($CurrentSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $Inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow))
$Acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'), [System.Security.AccessControl.FileSystemRights]::FullControl, $Inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow))
[System.IO.DirectoryInfo]::new($Ambient).SetAccessControl($Acl)
`;
      await execFileAsync(
        resolveWindowsPowerShellExecutable(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(hostileScript, "utf16le").toString("base64"),
        ],
        { encoding: "utf8", windowsHide: true },
      );

      try {
        const generation = await createPrivateTempGeneration("reattach-", {
          tempDirectory: ambient,
        });
        const defaultDirectory = path.join(generation.path, "Default");
        const activePortPath = path.join(generation.path, "DevToolsActivePort");
        const cookiesPath = path.join(defaultDirectory, "Cookies");
        await mkdir(defaultDirectory);
        await writeFile(activePortPath, "9222\n/devtools/browser/private\n");
        await writeFile(cookiesPath, "cookie-secret");

        const encodedPaths = [
          ambient,
          generation.parent.path,
          generation.path,
          defaultDirectory,
          activePortPath,
          cookiesPath,
        ].map((entry) => Buffer.from(entry, "utf8").toString("base64"));
        const verifyScript = String.raw`
$Paths = @(${encodedPaths.map((entry) => `'${entry}'`).join(",")}) | ForEach-Object { [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($_)) }
$CurrentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$Allowed = @($CurrentSid.Value, 'S-1-5-18', 'S-1-5-32-544')
$AmbientAcl = [System.IO.DirectoryInfo]::new($Paths[0]).GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
if (-not (@($AmbientAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq 'S-1-1-0' }).Count)) { throw 'Ambient TEMP fixture is not hostile.' }
foreach ($Index in 1..5) {
  $Item = if ([System.IO.Directory]::Exists($Paths[$Index])) { [System.IO.DirectoryInfo]::new($Paths[$Index]) } else { [System.IO.FileInfo]::new($Paths[$Index]) }
  $Acl = $Item.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access)
  if ($Acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $CurrentSid.Value) { throw "Private item owner mismatch: $($Paths[$Index])" }
  $Rules = @($Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if (-not $Rules.Count) { throw "Private item has no access rules: $($Paths[$Index])" }
  foreach ($Rule in $Rules) {
    if ($Rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $Allowed -notcontains $Rule.IdentityReference.Value) { throw "Private item inherited an unauthorized rule: $($Paths[$Index])" }
  }
}
[Console]::Out.Write('oracle.private-temp.inheritance:complete')
`;
        const { stdout } = await execFileAsync(
          resolveWindowsPowerShellExecutable(),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(verifyScript, "utf16le").toString("base64"),
          ],
          { encoding: "utf8", windowsHide: true },
        );
        expect(stdout).toBe("oracle.private-temp.inheritance:complete");
      } finally {
        await rm(ambient, { recursive: true, force: true });
      }
    },
  );
});
