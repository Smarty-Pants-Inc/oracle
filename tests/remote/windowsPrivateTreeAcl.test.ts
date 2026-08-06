import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test, vi } from "vitest";
import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import { REMOTE_TRANSACTION_PROTOCOL_VERSION } from "../../src/remote/types.js";
import {
  buildWindowsPrivateTreeAclCommand,
  protectWindowsPrivateTreeAcl,
} from "../../src/remote/windowsPrivateTreeAcl.js";
import { resolveWindowsPowerShellExecutable } from "../../src/windowsSystemExecutable.js";

const execFileAsync = promisify(execFile);
const WINDOWS_PRIVATE_TREE_ACL_NOT_REPAIRED_MARKER =
  "oracle.remote-transaction.private-tree.v1:integrity-key-acl-repaired=false";
const WINDOWS_PRIVATE_TREE_ACL_REPAIRED_MARKER =
  "oracle.remote-transaction.private-tree.v1:integrity-key-acl-repaired=true";

function buildWindowsTestPathCommandArgs(script: string, itemPaths: string[]): string[] {
  const pathExpressions = itemPaths
    .map((itemPath) => {
      const encodedPath = Buffer.from(itemPath, "utf8").toString("base64");
      return `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPath}'))`;
    })
    .join(",\n  ");
  const command = String.raw`
$ItemPaths = @(
  ${pathExpressions}
)
${script}`;
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(command, "utf16le").toString("base64"),
  ];
}

const commandScope = {
  storeDirectory: String.raw`C:\Users\Oracle\.oracle\remote-transactions`,
  integrityKeyDirectory: String.raw`C:\Users\Oracle\.oracle`,
  integrityKeyPath: String.raw`C:\Users\Oracle\.oracle\.remote-transaction-integrity.key`,
};

function beginAclTestRecord(
  store: RemoteTransactionStore,
  transactionToken: string,
  runId: string,
): Promise<void> {
  return store.begin({
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    transactionToken,
    runId,
    createdAt: new Date().toISOString(),
    requestIdentity: {
      acceptedPromptSha256: ["b".repeat(64)],
      followUpOrdinal: 0,
      remainingFollowUps: 0,
    },
    browserConfig: { chatgptUrl: "https://chatgpt.com/" },
  });
}

describe("Windows remote transaction private ACL authority", () => {
  test("uses one bounded native command resolved from the OS-rooted namespace", async () => {
    const execute = vi.fn(async () => ({ stdout: WINDOWS_PRIVATE_TREE_ACL_NOT_REPAIRED_MARKER }));

    await expect(protectWindowsPrivateTreeAcl(commandScope, execute)).resolves.toEqual({
      integrityKeyAclRepaired: false,
    });

    const command = buildWindowsPrivateTreeAclCommand(commandScope);
    expect(command.file).toBe(resolveWindowsPowerShellExecutable());
    expect(command.args.slice(0, 4)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    expect(command.args).toHaveLength(5);
    expect(command.options).toEqual({ timeoutMs: 12_000 });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(command.file, command.args, command.options);
  });

  test("returns the exact integrity-key ACL repair attestation", async () => {
    await expect(
      protectWindowsPrivateTreeAcl(commandScope, async () => ({
        stdout: WINDOWS_PRIVATE_TREE_ACL_REPAIRED_MARKER,
      })),
    ).resolves.toEqual({ integrityKeyAclRepaired: true });
  });

  test("encodes each configured path independently instead of appending hostile paths as PowerShell source", () => {
    const hostileScope = {
      storeDirectory: String.raw`C:\Users\Oracle\$(throw 'store path injection')`,
      integrityKeyDirectory: String.raw`C:\Users\Oracle\$(throw 'key directory injection')`,
      integrityKeyPath: String.raw`C:\Users\Oracle\$(throw 'key directory injection')\$(throw 'key path injection').key`,
    };
    const protectedPaths = [
      hostileScope.storeDirectory,
      hostileScope.integrityKeyDirectory,
      hostileScope.integrityKeyPath,
    ];
    const command = buildWindowsPrivateTreeAclCommand(hostileScope);
    const encodedCommand = command.args.at(-1);
    expect(encodedCommand).toBeDefined();
    const decodedCommand = Buffer.from(encodedCommand ?? "", "base64").toString("utf16le");
    const encodedPaths = [
      ...decodedCommand.matchAll(/\[System\.Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)/g),
    ].map((match) => match[1] ?? "");

    expect(encodedPaths).toHaveLength(3);
    expect(
      encodedPaths.map((encodedPath) => Buffer.from(encodedPath, "base64").toString("utf8")),
    ).toEqual(protectedPaths);
    for (const protectedPath of protectedPaths) {
      expect(command.args.join("\0")).not.toContain(protectedPath);
      expect(decodedCommand).not.toContain(protectedPath);
    }
    expect(decodedCommand).not.toContain("ConvertFrom-Json");
    expect(decodedCommand).not.toContain("$Scope");
    expect(decodedCommand).toContain("$StorePath = [System.IO.Path]::GetFullPath(");
    expect(decodedCommand).toContain("$KeyDirectoryPath = [System.IO.Path]::GetFullPath(");
    expect(decodedCommand).toContain("$KeyPath = [System.IO.Path]::GetFullPath(");
  });

  test("encodes every native integration helper path instead of using trailing PowerShell arguments", () => {
    const hostilePaths = [
      String.raw`C:\$(throw 'first path injection')`,
      String.raw`C:\$(throw 'second path injection')`,
      String.raw`C:\$(throw 'third path injection')`,
      String.raw`C:\$(throw 'fourth path injection')`,
    ];
    const args = buildWindowsTestPathCommandArgs(
      "foreach ($ItemPath in $ItemPaths) { [Console]::Out.Write($ItemPath) }",
      hostilePaths,
    );
    const decodedCommand = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
    const decodedPaths = [
      ...decodedCommand.matchAll(/\[System\.Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)/g),
    ].map((match) => Buffer.from(match[1] ?? "", "base64").toString("utf8"));

    expect(args.slice(0, 4)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    expect(args).not.toContain("-Command");
    expect(decodedPaths).toEqual(hostilePaths);
    for (const hostilePath of hostilePaths) {
      expect(args.join("\0")).not.toContain(hostilePath);
      expect(decodedCommand).not.toContain(hostilePath);
    }
  });

  test("fails closed when the native ACL probe does not complete exactly", async () => {
    await expect(
      protectWindowsPrivateTreeAcl(commandScope, async () => ({ stdout: "partial" })),
    ).rejects.toThrow("private ACL verification did not complete");
    await expect(
      protectWindowsPrivateTreeAcl(commandScope, async () => {
        throw new Error("probe unavailable");
      }),
    ).rejects.toThrow("private ACL protection failed");
  });

  test("rejects pre-existing key ctime drift when Windows ACL authority reports no repair", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-windows-key-ctime-noop-"));
    const directory = path.join(root, "remote-transactions");
    const integrityKeyPath = path.join(root, ".remote-transaction-integrity.key");
    const transactionToken = "c".repeat(64);
    const windowsPrivateTreeAuthority = vi.fn(async () => ({
      integrityKeyAclRepaired: false,
    }));
    try {
      const store = await RemoteTransactionStore.open({
        directory,
        integrityKeyPath,
        platform: "win32",
        windowsPrivateTreeAuthority,
      });
      await beginAclTestRecord(store, transactionToken, "windows-ctime-noop-run");
      const keyContents = await fs.readFile(integrityKeyPath);
      const originalRecord = await fs.readFile(store.recordPath(transactionToken));
      const keyBeforeDrift = await fs.lstat(integrityKeyPath, { bigint: true });
      await fs.writeFile(integrityKeyPath, keyContents);
      const keyAfterDrift = await fs.lstat(integrityKeyPath, { bigint: true });
      expect(keyAfterDrift.ctimeNs).not.toBe(keyBeforeDrift.ctimeNs);

      windowsPrivateTreeAuthority.mockClear();
      await expect(store.read(transactionToken)).rejects.toThrow(
        "Remote transaction integrity key generation changed",
      );
      expect(windowsPrivateTreeAuthority).toHaveBeenCalledOnce();
      await expect(fs.readFile(store.recordPath(transactionToken))).resolves.toEqual(
        originalRecord,
      );
      expect((await fs.readdir(directory)).some((name) => name.endsWith(".quarantine"))).toBe(
        false,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("refreshes only key ctime after an attested Windows ACL repair", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-windows-key-ctime-repair-"));
    const directory = path.join(root, "remote-transactions");
    const integrityKeyPath = path.join(root, ".remote-transaction-integrity.key");
    const transactionToken = "f".repeat(64);
    let repairKey: (() => Promise<void>) | undefined;
    const windowsPrivateTreeAuthority = vi.fn(async () => {
      const repair = repairKey;
      repairKey = undefined;
      await repair?.();
      return { integrityKeyAclRepaired: repair !== undefined };
    });
    try {
      const store = await RemoteTransactionStore.open({
        directory,
        integrityKeyPath,
        platform: "win32",
        windowsPrivateTreeAuthority,
      });
      await beginAclTestRecord(store, transactionToken, "windows-ctime-repair-run");
      const keyContents = await fs.readFile(integrityKeyPath);
      const keyBeforeDrift = await fs.lstat(integrityKeyPath, { bigint: true });
      await fs.writeFile(integrityKeyPath, keyContents);
      const keyAfterDrift = await fs.lstat(integrityKeyPath, { bigint: true });
      expect(keyAfterDrift.ctimeNs).not.toBe(keyBeforeDrift.ctimeNs);
      repairKey = () => fs.writeFile(integrityKeyPath, keyContents);

      windowsPrivateTreeAuthority.mockClear();
      await expect(store.read(transactionToken)).resolves.toMatchObject({ transactionToken });
      expect(windowsPrivateTreeAuthority).toHaveBeenCalledOnce();
      const keyAfterRepair = await fs.lstat(integrityKeyPath, { bigint: true });
      expect(keyAfterRepair.ctimeNs).not.toBe(keyAfterDrift.ctimeNs);
      expect([
        keyAfterRepair.dev,
        keyAfterRepair.ino,
        keyAfterRepair.birthtimeNs,
        keyAfterRepair.size,
        keyAfterRepair.mode,
        keyAfterRepair.nlink,
      ]).toEqual([
        keyBeforeDrift.dev,
        keyBeforeDrift.ino,
        keyBeforeDrift.birthtimeNs,
        keyBeforeDrift.size,
        keyBeforeDrift.mode,
        keyBeforeDrift.nlink,
      ]);
      await expect(fs.readFile(integrityKeyPath)).resolves.toEqual(keyContents);

      windowsPrivateTreeAuthority.mockClear();
      await expect(store.read(transactionToken)).resolves.toMatchObject({ transactionToken });
      expect(windowsPrivateTreeAuthority).toHaveBeenCalledOnce();
      const keyAfterNoopPass = await fs.lstat(integrityKeyPath, { bigint: true });
      expect(keyAfterNoopPass.ctimeNs).toBe(keyAfterRepair.ctimeNs);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects same-size key-content replacement during Windows ACL repair", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-windows-key-content-swap-"));
    const directory = path.join(root, "remote-transactions");
    const integrityKeyPath = path.join(root, ".remote-transaction-integrity.key");
    const transactionToken = "d".repeat(64);
    let replaceKey: (() => Promise<void>) | undefined;
    const windowsPrivateTreeAuthority = vi.fn(async () => {
      const replacement = replaceKey;
      replaceKey = undefined;
      await replacement?.();
      return { integrityKeyAclRepaired: false };
    });
    try {
      const store = await RemoteTransactionStore.open({
        directory,
        integrityKeyPath,
        platform: "win32",
        windowsPrivateTreeAuthority,
      });
      await beginAclTestRecord(store, transactionToken, "windows-key-content-swap-run");
      const originalKey = await fs.readFile(integrityKeyPath);
      const originalRecord = await fs.readFile(store.recordPath(transactionToken));
      const replacementKey = Buffer.from(originalKey);
      replacementKey[0] = (replacementKey[0] ?? 0) ^ 0xff;
      replaceKey = () => fs.writeFile(integrityKeyPath, replacementKey);

      windowsPrivateTreeAuthority.mockClear();
      await expect(store.read(transactionToken)).rejects.toThrow(
        "integrity key contents changed during Windows private ACL protection",
      );
      expect(windowsPrivateTreeAuthority).toHaveBeenCalledOnce();
      await expect(fs.readFile(store.recordPath(transactionToken))).resolves.toEqual(
        originalRecord,
      );
      expect((await fs.readdir(directory)).some((name) => name.endsWith(".quarantine"))).toBe(
        false,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects key-generation substitution during Windows ACL repair", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-windows-key-generation-swap-"));
    const directory = path.join(root, "remote-transactions");
    const integrityKeyPath = path.join(root, ".remote-transaction-integrity.key");
    const displacedKeyPath = `${integrityKeyPath}.displaced`;
    const transactionToken = "e".repeat(64);
    let replaceKey: (() => Promise<void>) | undefined;
    const windowsPrivateTreeAuthority = vi.fn(async () => {
      const replacement = replaceKey;
      replaceKey = undefined;
      await replacement?.();
      return { integrityKeyAclRepaired: false };
    });
    try {
      const store = await RemoteTransactionStore.open({
        directory,
        integrityKeyPath,
        platform: "win32",
        windowsPrivateTreeAuthority,
      });
      await beginAclTestRecord(store, transactionToken, "windows-key-generation-swap-run");
      const originalKey = await fs.readFile(integrityKeyPath);
      const originalRecord = await fs.readFile(store.recordPath(transactionToken));
      replaceKey = async () => {
        await fs.rename(integrityKeyPath, displacedKeyPath);
        await fs.writeFile(integrityKeyPath, originalKey);
      };

      windowsPrivateTreeAuthority.mockClear();
      await expect(store.read(transactionToken)).rejects.toThrow(
        "integrity key generation changed during Windows private ACL protection",
      );
      expect(windowsPrivateTreeAuthority).toHaveBeenCalledOnce();
      await expect(fs.readFile(store.recordPath(transactionToken))).resolves.toEqual(
        originalRecord,
      );
      expect((await fs.readdir(directory)).some((name) => name.endsWith(".quarantine"))).toBe(
        false,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test.runIf(process.platform === "win32")(
    "repairs an ACL broadened after open on the next same-instance read without mutating the key identity",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-windows-private-acl-"));
      const directory = path.join(root, "remote-transactions");
      const integrityKeyPath = path.join(root, ".remote-transaction-integrity.key");
      const transactionToken = "a".repeat(64);
      const powershellExecutable = resolveWindowsPowerShellExecutable();
      try {
        const store = await RemoteTransactionStore.open({ directory, integrityKeyPath });
        await beginAclTestRecord(store, transactionToken, "windows-acl-run");
        const protectedPaths = [
          root,
          directory,
          integrityKeyPath,
          store.recordPath(transactionToken),
        ];
        const broadenScript = String.raw`
$ErrorActionPreference = 'Stop'
$Everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$Rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $Everyone,
  [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
  [System.Security.AccessControl.AccessControlType]::Allow
)
foreach ($ItemPath in $ItemPaths) {
  $Item = Get-Item -LiteralPath $ItemPath -Force
  $Acl = $Item.GetAccessControl()
  [void]$Acl.AddAccessRule($Rule)
  $Item.SetAccessControl($Acl)
}`;
        await execFileAsync(
          powershellExecutable,
          buildWindowsTestPathCommandArgs(broadenScript, protectedPaths),
          { timeout: 12_000, windowsHide: true },
        );

        await expect(store.read(transactionToken)).resolves.toMatchObject({ transactionToken });

        const verifyScript = String.raw`
$ErrorActionPreference = 'Stop'
$CurrentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$AllowedSids = @(
  $CurrentSid,
  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
)
$FullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
$Allow = [System.Security.AccessControl.AccessControlType]::Allow
$NoPropagation = [System.Security.AccessControl.PropagationFlags]::None
$DirectoryInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$NoInheritance = [System.Security.AccessControl.InheritanceFlags]::None
foreach ($ItemPath in $ItemPaths) {
  $Item = Get-Item -LiteralPath $ItemPath -Force
  $Acl = $Item.GetAccessControl()
  $Rules = @($Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  $DescribeRules = @($Rules | ForEach-Object { "$($_.IdentityReference.Value)|$([int64]$_.FileSystemRights)|$([int]$_.AccessControlType)|$([int]$_.InheritanceFlags)|$([int]$_.PropagationFlags)|$($_.IsInherited)" } | Sort-Object) -join ', '
  if ($Acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $CurrentSid.Value) { throw "Unexpected private ACL owner for $ItemPath; actual=$($Acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value); expected=$($CurrentSid.Value)" }
  if (-not $Acl.AreAccessRulesProtected) { throw "Inherited private ACL for $ItemPath; actual=[$DescribeRules]" }
  if ($Rules.Count -ne $AllowedSids.Count) { throw "Unexpected private ACL rule count for $ItemPath; actual=[$DescribeRules]" }
  $ExpectedInheritance = if ($Item.PSIsContainer) { $DirectoryInheritance } else { $NoInheritance }
  foreach ($Sid in $AllowedSids) {
    $Matches = @($Rules | Where-Object { $_.IdentityReference.Value -eq $Sid.Value })
    if ($Matches.Count -ne 1) { throw "Unexpected private ACL principal rules for $ItemPath; actual=[$DescribeRules]" }
    $Rule = $Matches[0]
    if ($Rule.IsInherited -or $Rule.AccessControlType -ne $Allow -or [int64]$Rule.FileSystemRights -ne [int64]$FullControl -or $Rule.InheritanceFlags -ne $ExpectedInheritance -or $Rule.PropagationFlags -ne $NoPropagation) { throw "Unexpected private ACL rule for $ItemPath; actual=[$DescribeRules]" }
  }
}
[Console]::Out.Write('private')`;
        const { stdout } = await execFileAsync(
          powershellExecutable,
          buildWindowsTestPathCommandArgs(verifyScript, protectedPaths),
          { encoding: "utf8", timeout: 12_000, windowsHide: true },
        );
        expect(stdout).toBe("private");

        const keyAfterRepair = await fs.lstat(integrityKeyPath, { bigint: true });

        const secondAuthorityPass = await RemoteTransactionStore.open({
          directory,
          integrityKeyPath,
        });
        await expect(secondAuthorityPass.read(transactionToken)).resolves.toMatchObject({
          transactionToken,
        });
        const keyAfterSecondAuthorityPass = await fs.lstat(integrityKeyPath, { bigint: true });
        expect([
          keyAfterSecondAuthorityPass.dev,
          keyAfterSecondAuthorityPass.ino,
          keyAfterSecondAuthorityPass.birthtimeNs,
          keyAfterSecondAuthorityPass.ctimeNs,
          keyAfterSecondAuthorityPass.size,
          keyAfterSecondAuthorityPass.mode,
          keyAfterSecondAuthorityPass.nlink,
        ]).toEqual([
          keyAfterRepair.dev,
          keyAfterRepair.ino,
          keyAfterRepair.birthtimeNs,
          keyAfterRepair.ctimeNs,
          keyAfterRepair.size,
          keyAfterRepair.mode,
          keyAfterRepair.nlink,
        ]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
