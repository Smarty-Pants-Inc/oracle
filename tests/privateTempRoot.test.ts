import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import {
  createPrivateTempGeneration,
  createTemporaryProfileAuthority,
  establishPrivateRuntimeAuthority,
  privateRuntimeRootPathCandidates,
  removePrivateTempGeneration,
  removeTemporaryProfileAuthority,
  type PrivateTempRootOptions,
} from "../src/privateTempRoot.js";
import { resolveWindowsPowerShellExecutable } from "../src/windowsSystemExecutable.js";

const execFileAsync = promisify(execFile);

describe("private temporary root authority", () => {
  test.skipIf(process.platform === "win32")(
    "prefers only a validated XDG runtime directory and otherwise uses private Oracle state",
    async () => {
      const ambient = await mkdtemp(path.join(os.tmpdir(), "oracle-private-root-selection-"));
      const xdg = path.join(ambient, "xdg");
      const state = path.join(ambient, "state");
      await mkdir(xdg, { mode: 0o700 });
      try {
        const xdgRoot = await establishPrivateRuntimeAuthority({
          runtimeDirectory: xdg,
          oracleStateDirectory: state,
        });
        expect(xdgRoot.path).toBe(path.join(await realpath(xdg), "oracle-private"));

        await rm(xdgRoot.path, { recursive: true, force: true });
        await chmod(xdg, 0o777);
        const stateRoot = await establishPrivateRuntimeAuthority({
          runtimeDirectory: xdg,
          oracleStateDirectory: state,
        });
        expect(stateRoot.path).toBe(path.join(await realpath(state), "oracle-private"));
        expect((await lstat(stateRoot.path)).mode & 0o777).toBe(0o700);
      } finally {
        await rm(ambient, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
    "a different POSIX account cannot reserve the fixed shared-temp name",
    async () => {
      const ambient = await mkdtemp(path.join(os.tmpdir(), "oracle-private-cross-user-"));
      await chmod(ambient, 0o777);
      const shared = path.join(ambient, "shared");
      const state = path.join(ambient, "state");
      const hostileRoot = path.join(shared, "oracle-private");
      await mkdir(shared, { mode: 0o777 });
      await chmod(shared, 0o777);
      const { stdout } = await execFileAsync("id", ["-u", "nobody"], { encoding: "utf8" });
      const nobodyUid = Number.parseInt(stdout.trim(), 10);
      try {
        await execFileAsync(
          process.execPath,
          ["-e", "require('node:fs').mkdirSync(process.argv[1])", hostileRoot],
          { uid: nobodyUid },
        );
        const root = await establishPrivateRuntimeAuthority({
          runtimeDirectory: shared,
          oracleStateDirectory: state,
        });
        expect(root.path).toBe(path.join(state, "oracle-private"));
        expect((await stat(hostileRoot)).uid).toBe(nobodyUid);
      } finally {
        await rm(ambient, { recursive: true, force: true });
      }
    },
  );

  test("WSL rejects private runtime paths without backing Windows ACL authority", async () => {
    const aclAuthorityError =
      "WSL private runtime authority is unavailable: Oracle cannot prove backing Windows ACL privacy";
    const wsl = { platform: "linux" as const, isWsl: true };
    const expectRejected = async (options: PrivateTempRootOptions): Promise<void> => {
      expect(privateRuntimeRootPathCandidates(options)).toEqual([]);
      await expect(establishPrivateRuntimeAuthority(options)).rejects.toMatchObject({
        message: aclAuthorityError,
      });
    };

    for (const options of [
      {
        ...wsl,
        oracleStateDirectory: String.raw`C:\Users\Alice\AppData\Local\Oracle`,
        environment: { ORACLE_HOME_DIR: String.raw`C:\Users\Alice\AppData\Local\Oracle` },
      },
      {
        ...wsl,
        oracleStateDirectory: "/home/alice/.oracle",
        environment: { LOCALAPPDATA: String.raw`C:\Users\Alice\AppData\Local` },
      },
      {
        ...wsl,
        oracleStateDirectory: "/home/alice/.oracle",
        environment: { USERPROFILE: String.raw`C:\Users\Alice` },
      },
    ]) {
      await expectRejected(options);
    }

    await expectRejected({
      ...wsl,
      oracleStateDirectory: "/home/alice/.oracle",
      environment: {},
    });

    const injectedParent = await mkdtemp(path.join(os.tmpdir(), "oracle-private-wsl-injected-"));
    try {
      await expectRejected({
        ...wsl,
        tempDirectory: `${path.join(injectedParent, "nested")}${path.sep}..${path.sep}private`,
      });
    } finally {
      await rm(injectedParent, { recursive: true, force: true });
    }
  });

  test("proves the Windows parent before creating a per-run generation", async () => {
    const ambient = await mkdtemp(path.join(os.tmpdir(), "oracle-private-temp-order-"));
    const rootPath = path.join(await realpath(ambient), "oracle-private");
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
      expect(calls).toEqual([
        { path: rootPath, existed: false },
        { path: rootPath, existed: true },
        { path: generation.path, existed: false },
      ]);
      expect(await readdir(generation.path)).toEqual([]);
    } finally {
      await rm(ambient, { recursive: true, force: true });
    }
  });

  test("uses an explicitly injected filesystem-only authority for simulated Windows", async () => {
    const ambient = await mkdtemp(path.join(os.tmpdir(), "oracle-private-temp-local-authority-"));
    const windowsPrivateDirectoryAuthority = async (directoryPath: string): Promise<void> => {
      await mkdir(directoryPath, { recursive: true });
      const entry = await lstat(directoryPath);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Test private directory is not physical: ${directoryPath}`);
      }
    };
    try {
      const generation = await createPrivateTempGeneration("ordinary-", {
        platform: "win32",
        tempDirectory: ambient,
        randomId: () => "fixed-generation",
        windowsPrivateDirectoryAuthority,
      });

      expect(generation.path).toBe(
        path.join(await realpath(ambient), "oracle-private", "ordinary-fixed-generation"),
      );
      expect((await lstat(generation.path)).isDirectory()).toBe(true);
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

  test.skipIf(process.platform === "win32")(
    "removes only the persisted profile authority after ambient roots change",
    async () => {
      const ambient = await mkdtemp(path.join(os.tmpdir(), "oracle-temp-authority-roots-"));
      const acquiredRoot = path.join(ambient, "acquired");
      const replacementRoot = path.join(ambient, "replacement");
      const environment: NodeJS.ProcessEnv = { XDG_RUNTIME_DIR: acquiredRoot };
      try {
        await mkdir(acquiredRoot, { mode: 0o700 });
        const authority = await createTemporaryProfileAuthority("oracle-browser-", {
          environment,
          oracleStateDirectory: path.join(ambient, "fallback-state"),
        });
        await writeFile(path.join(authority.profileDirectory.canonicalPath, "secret"), "owned");
        await mkdir(replacementRoot, { mode: 0o700 });
        environment.XDG_RUNTIME_DIR = replacementRoot;

        await expect(removeTemporaryProfileAuthority(authority)).resolves.toBe(true);
        await expect(lstat(authority.profileDirectory.canonicalPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect((await lstat(replacementRoot)).isDirectory()).toBe(true);
      } finally {
        await rm(ambient, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "win32")(
    "uses the default production Windows ACL authority and blocks hostile TEMP inheritance",
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
$FullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
$AmbientAcl = [System.IO.DirectoryInfo]::new($Paths[0]).GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
if (-not (@($AmbientAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq 'S-1-1-0' }).Count)) { throw 'Ambient TEMP fixture is not hostile.' }
foreach ($Index in 1..5) {
  $Item = if ([System.IO.Directory]::Exists($Paths[$Index])) { [System.IO.DirectoryInfo]::new($Paths[$Index]) } else { [System.IO.FileInfo]::new($Paths[$Index]) }
  $Acl = $Item.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access)
  $Owner = $Acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($Index -le 2 -and $Owner -ne $CurrentSid.Value) { throw "Private authority owner mismatch: $($Paths[$Index]); actual=$Owner" }
  if ($Index -gt 2 -and $Allowed -notcontains $Owner) { throw "Private descendant has an unauthorized owner: $($Paths[$Index]); actual=$Owner" }
  $Rules = @($Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($Rules.Count -ne $Allowed.Count) { throw "Private item has a non-canonical rule count: $($Paths[$Index]); actual=$($Rules.Count)" }
  foreach ($Sid in $Allowed) {
    $Matches = @($Rules | Where-Object { $_.IdentityReference.Value -eq $Sid })
    if ($Matches.Count -ne 1) { throw "Private item does not grant one exact rule to $($Sid): $($Paths[$Index])" }
    $Rule = $Matches[0]
    if ($Rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or [int64]$Rule.FileSystemRights -ne [int64]$FullControl) { throw "Private item has a non-canonical rule for $($Sid): $($Paths[$Index])" }
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
