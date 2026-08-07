import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBridgeHost } from "../../src/cli/bridge/host.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import {
  applyWindowsPrivateFileAcl,
  buildWindowsPrivateFileAclCommand,
  type WindowsPrivateFileAclRequest,
} from "../../src/windowsPrivateFileAcl.js";
import { resolveWindowsPowerShellExecutable } from "../../src/windowsSystemExecutable.js";

const execFileAsync = promisify(execFile);
const PREDECESSOR_TOKEN = "b".repeat(32);
const PREDECESSOR_CREATED_AT = "2025-01-02T03:04:05.000Z";
const FLEET_SIZE = 4_097;

interface SiblingFixture {
  readonly root: string;
  readonly artifactPath: string;
  readonly ordinaryPath: string;
  readonly reparsePath: string;
  readonly reparseTarget: string;
  readonly fleetSentinelPath: string;
  readonly namesBefore: string[];
}

interface EntryFingerprint {
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly birthtimeNs: string;
}

interface WindowsAclSnapshot {
  readonly path: string;
  readonly sddl: string;
  readonly protected: boolean;
  readonly everyoneRuleCount: number;
}

afterEach(() => {
  setOracleHomeDirOverrideForTest(null);
  vi.restoreAllMocks();
});

async function createSiblingFixture(
  artifactName = "bridge-connection.json",
): Promise<SiblingFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-artifact-privacy-"));
  const reparseTarget = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-reparse-target-"));
  const artifactPath = path.join(root, artifactName);
  const ordinaryPath = path.join(root, "unrelated.txt");
  const reparsePath = path.join(root, "unrelated-reparse");
  await fs.writeFile(ordinaryPath, "unrelated sibling\n", "utf8");
  await fs.symlink(reparseTarget, reparsePath, process.platform === "win32" ? "junction" : "dir");
  for (let offset = 0; offset < FLEET_SIZE; offset += 128) {
    await Promise.all(
      Array.from({ length: Math.min(128, FLEET_SIZE - offset) }, (_, index) =>
        fs.writeFile(path.join(root, `fleet-${String(offset + index).padStart(4, "0")}.txt`), ""),
      ),
    );
  }
  await fs.writeFile(
    artifactPath,
    `${JSON.stringify(
      {
        remoteHost: "127.0.0.1:9473",
        remoteToken: PREDECESSOR_TOKEN,
        createdAt: PREDECESSOR_CREATED_AT,
        updatedAt: PREDECESSOR_CREATED_AT,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return {
    root,
    artifactPath,
    ordinaryPath,
    reparsePath,
    reparseTarget,
    fleetSentinelPath: path.join(root, "fleet-4096.txt"),
    namesBefore: (await fs.readdir(root)).sort(),
  };
}

async function removeSiblingFixture(fixture: SiblingFixture): Promise<void> {
  await fs.rm(fixture.root, { recursive: true, force: true });
  await fs.rm(fixture.reparseTarget, { recursive: true, force: true });
}

async function captureEntryFingerprint(filePath: string): Promise<EntryFingerprint> {
  const entry = await fs.lstat(filePath, { bigint: true });
  return {
    device: entry.dev.toString(),
    inode: entry.ino.toString(),
    mode: Number(entry.mode & 0o777n),
    size: entry.size.toString(),
    mtimeNs: entry.mtimeNs.toString(),
    ctimeNs: entry.ctimeNs.toString(),
    birthtimeNs: entry.birthtimeNs.toString(),
  };
}

async function runReadyForegroundHost(
  artifactPath: string,
  deps: {
    windowsPrivateFileAuthority?: (request: WindowsPrivateFileAclRequest) => Promise<void>;
  } = {},
): Promise<void> {
  await runBridgeHost(
    { token: "auto", writeConnection: artifactPath },
    {
      backgroundPlatform: deps.windowsPrivateFileAuthority ? "win32" : undefined,
      windowsPrivateFileAuthority: deps.windowsPrivateFileAuthority,
      serveRemote: async (options, lifecycle) => {
        const token = options?.token;
        if (!token) throw new Error("missing generated bridge credential");
        await lifecycle?.onReady?.({ port: 9473, token });
      },
    },
  );
}

async function readWindowsAclSnapshots(paths: string[]): Promise<WindowsAclSnapshot[]> {
  const encodedPaths = Buffer.from(JSON.stringify(paths), "utf8").toString("base64");
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$Paths = @(([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPaths}')) | ConvertFrom-Json))
$Snapshots = @($Paths | ForEach-Object {
  $Item = Get-Item -LiteralPath ([string]$_) -Force
  $Acl = $Item.GetAccessControl()
  $Rules = @($Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  [pscustomobject]@{
    path = [string]$_
    sddl = $Acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All)
    protected = $Acl.AreAccessRulesProtected
    everyoneRuleCount = @($Rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-1-0' }).Count
  }
})
[Console]::Out.Write((ConvertTo-Json -Compress -InputObject $Snapshots))`;
  const { stdout } = await execFileAsync(
    resolveWindowsPowerShellExecutable(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 12_000, windowsHide: true },
  );
  const parsed = JSON.parse(String(stdout)) as WindowsAclSnapshot | WindowsAclSnapshot[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function addWindowsParentReadInheritance(directoryPath: string): Promise<void> {
  const encodedPath = Buffer.from(directoryPath, "utf8").toString("base64");
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$DirectoryPath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPath}'))
$Item = Get-Item -LiteralPath $DirectoryPath -Force
$Acl = $Item.GetAccessControl()
$Acl.SetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
  [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
  [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
  ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
))
$Item.SetAccessControl($Acl)
[Console]::Out.Write('oracle.bridge-parent-acl:complete')`;
  const { stdout } = await execFileAsync(
    resolveWindowsPowerShellExecutable(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 12_000, windowsHide: true },
  );
  expect(stdout).toBe("oracle.bridge-parent-acl:complete");
}
describe("bridge connection artifact privacy", () => {
  it("creates Windows files through the trusted exact-ACL FileStream constructor", async () => {
    const request: WindowsPrivateFileAclRequest = {
      filePath: String.raw`C:\Users\Oracle\bridge-connection.tmp`,
      repair: false,
      createNew: true,
    };
    const command = buildWindowsPrivateFileAclCommand(request);
    const script = Buffer.from(command.args.at(-1)!, "base64").toString("utf16le");
    expect(command.file).toBe(resolveWindowsPowerShellExecutable());
    expect(command.args.slice(0, -1)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    expect(script).toContain("New-PrivateFile $FilePath $false");
    expect(script).toContain("[System.IO.FileMode]::CreateNew");
    expect(script).toContain("[System.IO.FileShare]::None");
    expect(script).toMatch(
      /\[System\.IO\.FileStream\]::new\([\s\S]*?\(New-PrivateAcl \$false\)\s*\)/u,
    );
    expect(script).not.toContain("Set-CanonicalPrivateAcl");
    expect(script).not.toContain("Establish-PrivateDirectory");
    expect(script).not.toContain(".SetAccessControl(");

    const execute = vi.fn(async () => ({ stdout: "oracle.windows-private-file.v1:created" }));
    await expect(applyWindowsPrivateFileAcl(request, execute)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith(command.file, command.args, command.options);
  });

  it.runIf(process.platform !== "win32")(
    "replaces only the POSIX connection file beside a reparse point and more than 4096 siblings",
    async () => {
      const fixture = await createSiblingFixture(" bridge-connection.json ");
      await fs.chmod(fixture.root, 0o755);
      await fs.chmod(fixture.artifactPath, 0o644);
      await fs.chmod(fixture.ordinaryPath, 0o640);
      const parentModeBefore = Number(
        (await fs.lstat(fixture.root, { bigint: true })).mode & 0o777n,
      );
      const artifactBefore = await captureEntryFingerprint(fixture.artifactPath);
      const ordinaryBefore = await captureEntryFingerprint(fixture.ordinaryPath);
      const reparseBefore = await captureEntryFingerprint(fixture.reparsePath);
      const fleetBefore = await captureEntryFingerprint(fixture.fleetSentinelPath);
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      try {
        await runReadyForegroundHost(fixture.artifactPath);
        const artifact = JSON.parse(await fs.readFile(fixture.artifactPath, "utf8")) as {
          remoteToken: string;
          createdAt: string;
        };
        const artifactAfter = await captureEntryFingerprint(fixture.artifactPath);
        expect(artifact.remoteToken).toMatch(/^[0-9a-f]{64}$/u);
        expect(artifact.remoteToken).not.toBe(PREDECESSOR_TOKEN);
        expect(artifact.createdAt).toBe(PREDECESSOR_CREATED_AT);
        expect(artifactAfter.inode).not.toBe(artifactBefore.inode);
        expect(artifactAfter.mode).toBe(0o600);
        expect(Number((await fs.lstat(fixture.root, { bigint: true })).mode & 0o777n)).toBe(
          parentModeBefore,
        );
        expect(await captureEntryFingerprint(fixture.ordinaryPath)).toEqual(ordinaryBefore);
        expect(await captureEntryFingerprint(fixture.reparsePath)).toEqual(reparseBefore);
        expect(await captureEntryFingerprint(fixture.fleetSentinelPath)).toEqual(fleetBefore);
        expect(await fs.readlink(fixture.reparsePath)).toBe(fixture.reparseTarget);
        expect((await fs.readdir(fixture.root)).sort()).toEqual(fixture.namesBefore);
        expect(fixture.namesBefore).toHaveLength(FLEET_SIZE + 3);
      } finally {
        await removeSiblingFixture(fixture);
      }
    },
    60_000,
  );

  it("uses only the temporary and final file for simulated Windows privacy authority", async () => {
    const fixture = await createSiblingFixture();
    const parentBefore = await captureEntryFingerprint(fixture.root);
    const ordinaryBefore = await captureEntryFingerprint(fixture.ordinaryPath);
    const reparseBefore = await captureEntryFingerprint(fixture.reparsePath);
    const fleetBefore = await captureEntryFingerprint(fixture.fleetSentinelPath);
    const requests: WindowsPrivateFileAclRequest[] = [];
    const contentsAtAuthority: string[] = [];
    const windowsPrivateFileAuthority = vi.fn(async (request: WindowsPrivateFileAclRequest) => {
      requests.push(request);
      if (request.createNew) {
        const handle = await fs.open(request.filePath, "wx", 0o600);
        await handle.close();
      }
      const entry = await fs.lstat(request.filePath);
      expect(entry.isFile()).toBe(true);
      expect(entry.isSymbolicLink()).toBe(false);
      contentsAtAuthority.push(await fs.readFile(request.filePath, "utf8"));
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await runReadyForegroundHost(fixture.artifactPath, { windowsPrivateFileAuthority });
      const artifact = JSON.parse(await fs.readFile(fixture.artifactPath, "utf8")) as {
        remoteToken: string;
      };
      expect(artifact.remoteToken).toMatch(/^[0-9a-f]{64}$/u);
      expect(artifact.remoteToken).not.toBe(PREDECESSOR_TOKEN);
      expect(
        requests.map(({ createNew, repair }) => ({ createNew: createNew ?? false, repair })),
      ).toEqual([
        { createNew: true, repair: false },
        { createNew: false, repair: false },
        { createNew: false, repair: false },
      ]);
      expect(contentsAtAuthority.slice(0, 2)).toEqual(["", ""]);
      expect(contentsAtAuthority[2]).toContain(artifact.remoteToken);
      expect(path.dirname(requests[0]!.filePath)).toBe(fixture.root);
      expect(requests[0]!.filePath).toBe(requests[1]!.filePath);
      expect(requests[0]!.filePath).not.toBe(fixture.artifactPath);
      expect(requests[2]!.filePath).toBe(fixture.artifactPath);
      expect(await captureEntryFingerprint(fixture.root)).toMatchObject({
        device: parentBefore.device,
        inode: parentBefore.inode,
        mode: parentBefore.mode,
      });
      expect(await captureEntryFingerprint(fixture.ordinaryPath)).toEqual(ordinaryBefore);
      expect(await captureEntryFingerprint(fixture.reparsePath)).toEqual(reparseBefore);
      expect(await captureEntryFingerprint(fixture.fleetSentinelPath)).toEqual(fleetBefore);
      expect(await fs.readlink(fixture.reparsePath)).toBe(fixture.reparseTarget);
      expect((await fs.readdir(fixture.root)).sort()).toEqual(fixture.namesBefore);
      expect(fixture.namesBefore).toHaveLength(FLEET_SIZE + 3);
    } finally {
      await removeSiblingFixture(fixture);
    }
  }, 60_000);

  describe.sequential("Windows native bridge credential ACL cohort", () => {
    it.runIf(process.platform === "win32")(
      "creates the temporary Windows credential with its exact ACL and leaves the inherited parent unchanged",
      async () => {
        const fixture = await createSiblingFixture();
        await addWindowsParentReadInheritance(fixture.root);
        const [parentAclBefore, ordinaryAclBefore, predecessorAcl] = await readWindowsAclSnapshots([
          fixture.root,
          fixture.ordinaryPath,
          fixture.artifactPath,
        ]);
        expect(parentAclBefore?.everyoneRuleCount).toBeGreaterThan(0);
        expect(predecessorAcl?.protected).toBe(false);
        const ordinaryBefore = await captureEntryFingerprint(fixture.ordinaryPath);
        const reparseBefore = await captureEntryFingerprint(fixture.reparsePath);
        const fleetBefore = await captureEntryFingerprint(fixture.fleetSentinelPath);
        const requests: WindowsPrivateFileAclRequest[] = [];
        const contentsAtAuthority: string[] = [];
        let temporaryAclAtCreation: WindowsAclSnapshot | undefined;
        let parentAclAtCreation: WindowsAclSnapshot | undefined;
        const windowsPrivateFileAuthority = async (
          request: WindowsPrivateFileAclRequest,
        ): Promise<void> => {
          requests.push(request);
          await applyWindowsPrivateFileAcl(request);
          contentsAtAuthority.push(await fs.readFile(request.filePath, "utf8"));
          if (request.createNew) {
            [parentAclAtCreation, temporaryAclAtCreation] = await readWindowsAclSnapshots([
              fixture.root,
              request.filePath,
            ]);
          }
        };
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        try {
          await runReadyForegroundHost(fixture.artifactPath, { windowsPrivateFileAuthority });
          await applyWindowsPrivateFileAcl({ filePath: fixture.artifactPath, repair: false });
          const artifact = JSON.parse(await fs.readFile(fixture.artifactPath, "utf8")) as {
            remoteToken: string;
          };
          const [parentAclAfter, ordinaryAclAfter, artifactAclAfter] =
            await readWindowsAclSnapshots([
              fixture.root,
              fixture.ordinaryPath,
              fixture.artifactPath,
            ]);
          expect(
            requests.map(({ createNew, repair }) => ({ createNew: createNew ?? false, repair })),
          ).toEqual([
            { createNew: true, repair: false },
            { createNew: false, repair: false },
            { createNew: false, repair: false },
          ]);
          expect(requests[0]?.filePath).toBe(requests[1]?.filePath);
          expect(requests[0]?.filePath).not.toBe(fixture.artifactPath);
          expect(requests[2]?.filePath).toBe(fixture.artifactPath);
          expect(contentsAtAuthority.slice(0, 2)).toEqual(["", ""]);
          expect(contentsAtAuthority[2]).toContain(artifact.remoteToken);
          expect(artifact.remoteToken).toMatch(/^[0-9a-f]{64}$/u);
          expect(artifact.remoteToken).not.toBe(PREDECESSOR_TOKEN);
          expect(temporaryAclAtCreation?.protected).toBe(true);
          expect(temporaryAclAtCreation?.everyoneRuleCount).toBe(0);
          expect(artifactAclAfter?.sddl).toBe(temporaryAclAtCreation?.sddl);
          expect(parentAclAtCreation).toEqual(parentAclBefore);
          expect(parentAclAfter).toEqual(parentAclBefore);
          expect(ordinaryAclAfter).toEqual(ordinaryAclBefore);
          expect(await captureEntryFingerprint(fixture.ordinaryPath)).toEqual(ordinaryBefore);
          expect(await captureEntryFingerprint(fixture.reparsePath)).toEqual(reparseBefore);
          expect(await captureEntryFingerprint(fixture.fleetSentinelPath)).toEqual(fleetBefore);
          expect(await fs.readlink(fixture.reparsePath)).toBe(fixture.reparseTarget);
          expect((await fs.readdir(fixture.root)).sort()).toEqual(fixture.namesBefore);
          expect(fixture.namesBefore).toHaveLength(FLEET_SIZE + 3);
        } finally {
          await removeSiblingFixture(fixture);
        }
      },
      60_000,
    );
  });

  it("rejects a background state collision before creating the parent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-preflight-"));
    const oracleHome = path.join(root, "missing-oracle-home");
    const spawn = vi.fn();
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      await expect(
        runBridgeHost(
          {
            background: true,
            token: "a".repeat(64),
            writeConnection: path.join(oracleHome, "bridge-host.pid"),
          },
          { spawn },
        ),
      ).rejects.toThrow(/conflicts with a background state file/i);
      expect(spawn).not.toHaveBeenCalled();
      await expect(fs.access(oracleHome)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
