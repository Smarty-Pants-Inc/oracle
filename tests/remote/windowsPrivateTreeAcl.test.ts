import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test, vi } from "vitest";
import { RemoteTransactionStore } from "../../src/remote/transactionStore.js";
import { REMOTE_TRANSACTION_PROTOCOL_VERSION } from "../../src/remote/types.js";
import { remoteTransactionHeadDirectory } from "../../src/remote/transactionStoreRoot.js";
import {
  buildWindowsPrivateDirectoriesCommand,
  buildWindowsPrivateDirectoryCommand,
  buildWindowsPrivateFileInitializationCommand,
  buildWindowsPrivateFileProtectionCommand,
  buildWindowsPrivateFileVerificationCommand,
  buildWindowsPrivateTreeAclCommand,
  establishWindowsPrivateDirectories,
  establishWindowsPrivateDirectory,
  initializeWindowsPrivateFile,
  protectWindowsPrivateFile,
  protectWindowsPrivateTreeAcl,
  verifyWindowsPrivateFile,
  type WindowsPrivateTreeScope,
} from "../../src/windowsPrivateFileAcl.js";
import { resolveWindowsPowerShellExecutable } from "../../src/windowsSystemExecutable.js";
import { testWindowsPrivateTreeAuthority } from "./testTransactionStore.js";

const execFileAsync = promisify(execFile);
const WINDOWS_PRIVATE_TREE_ACL_COMPLETE_MARKER =
  "oracle.remote-transaction.private-tree.v1:complete";

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
  authorityDirectory: String.raw`C:\Users\Oracle\.oracle\.remote-transaction-authority`,
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

describe.sequential("Windows private ACL authority (serialized native cohort)", () => {
  test("uses one bounded native command with one exact completion marker", async () => {
    const execute = vi.fn(async () => ({ stdout: WINDOWS_PRIVATE_TREE_ACL_COMPLETE_MARKER }));

    await expect(protectWindowsPrivateTreeAcl(commandScope, execute)).resolves.toBeUndefined();

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

  test("creates or verifies one private directory without in-place ACL repair", async () => {
    const directoryPath = String.raw`C:\Users\Oracle\.oracle\private-temp`;
    const execute = vi.fn(async () => ({
      stdout: "oracle.windows-private-directory.v1:complete",
    }));

    await expect(establishWindowsPrivateDirectory(directoryPath, execute)).resolves.toBeUndefined();

    const command = buildWindowsPrivateDirectoryCommand(directoryPath);
    const decodedCommand = Buffer.from(command.args.at(-1) ?? "", "base64").toString("utf16le");
    expect(execute).toHaveBeenCalledWith(command.file, command.args, command.options);
    expect(decodedCommand).toContain("[System.IO.Directory]::CreateDirectory(");
    expect(decodedCommand).toContain("Assert-PrivateAcl");
    expect(decodedCommand).toContain("Private directory path is an existing file");
    expect(decodedCommand).not.toContain(".SetAccessControl(");
    expect(command.args.join("\0")).not.toContain(directoryPath);
  });

  test("creates and re-verifies a private directory chain in one native command", async () => {
    const directoryPaths = [
      String.raw`C:\Users\Oracle\.oracle\oracle-private`,
      String.raw`C:\Users\Oracle\.oracle\oracle-private\generation`,
    ];
    const execute = vi.fn(async () => ({
      stdout: "oracle.windows-private-directory.v1:complete",
    }));

    await expect(
      establishWindowsPrivateDirectories(directoryPaths, execute),
    ).resolves.toBeUndefined();

    const command = buildWindowsPrivateDirectoriesCommand(directoryPaths);
    const decodedCommand = Buffer.from(command.args.at(-1) ?? "", "base64").toString("utf16le");
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(command.file, command.args, command.options);
    expect(decodedCommand).toContain(
      "foreach ($DirectoryPath in $DirectoryPaths) { Establish-PrivateDirectory $DirectoryPath }",
    );
    expect(decodedCommand).toContain(
      "foreach ($DirectoryPath in $DirectoryPaths) { Assert-PrivateAcl",
    );
    expect([
      ...decodedCommand.matchAll(/\[System\.Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)/g),
    ]).toHaveLength(2);
  });

  test("creates, protects, and verifies one private file through exact native completion markers", async () => {
    const filePath = String.raw`C:\Users\Oracle\.oracle\sessions\remote\artifacts\result.bin`;
    const create = vi.fn(async () => ({ stdout: "oracle.windows-private-file.v1:created" }));
    const exists = vi.fn(async () => ({ stdout: "oracle.windows-private-file.v1:exists" }));
    const protect = vi.fn(async () => ({ stdout: "oracle.windows-private-file.v1:protected" }));
    const verify = vi.fn(async () => ({ stdout: "oracle.windows-private-file.v1:verified" }));

    await expect(initializeWindowsPrivateFile(filePath, create)).resolves.toBe(true);
    await expect(initializeWindowsPrivateFile(filePath, exists)).resolves.toBe(false);
    await expect(protectWindowsPrivateFile(filePath, protect)).resolves.toBeUndefined();
    await expect(verifyWindowsPrivateFile(filePath, verify)).resolves.toBeUndefined();

    const createCommand = buildWindowsPrivateFileInitializationCommand(filePath);
    const protectCommand = buildWindowsPrivateFileProtectionCommand(filePath);
    const verifyCommand = buildWindowsPrivateFileVerificationCommand(filePath);
    const decodedCreate = Buffer.from(createCommand.args.at(-1) ?? "", "base64").toString(
      "utf16le",
    );
    const decodedProtect = Buffer.from(protectCommand.args.at(-1) ?? "", "base64").toString(
      "utf16le",
    );
    const decodedVerify = Buffer.from(verifyCommand.args.at(-1) ?? "", "base64").toString(
      "utf16le",
    );
    expect(create).toHaveBeenCalledWith(
      createCommand.file,
      createCommand.args,
      createCommand.options,
    );
    expect(protect).toHaveBeenCalledWith(
      protectCommand.file,
      protectCommand.args,
      protectCommand.options,
    );
    expect(decodedCreate).toContain("New-PrivateFile $FilePath");
    expect(decodedCreate).toContain("Assert-PrivateAcl (Get-PhysicalItem $ParentPath $true) $true");
    expect(decodedCreate).not.toContain(".SetAccessControl(");
    expect(decodedCreate).not.toContain("Set-CanonicalPrivateAcl");
    expect(decodedCreate).not.toContain("Establish-PrivateDirectory");
    expect(decodedProtect).toContain("try { Assert-PrivateAcl $Item $false } catch");
    expect(decodedProtect).toContain("Set-CanonicalPrivateAcl $Item $false");
    expect(decodedProtect).toContain("$Item.SetAccessControl((New-PrivateAcl $Directory))");
    expect(decodedProtect).not.toContain("New-PrivateFile");
    expect(decodedProtect).not.toContain("[System.IO.FileMode]::CreateNew");
    expect(decodedProtect).not.toContain("Establish-PrivateDirectory");
    expect(decodedVerify).toContain("Assert-PrivateAcl (Get-PhysicalItem $FilePath $false) $false");
    expect(decodedVerify).not.toContain("Set-CanonicalPrivateAcl");
    expect(decodedVerify).not.toContain(".SetAccessControl(");
    expect(decodedVerify).not.toContain("New-PrivateFile");
    expect(decodedVerify).not.toContain("Establish-PrivateDirectory");
    expect(createCommand.args.join("\0")).not.toContain(filePath);
    expect(protectCommand.args.join("\0")).not.toContain(filePath);
    expect(verifyCommand.args.join("\0")).not.toContain(filePath);
  });

  test("accepts an explicitly injected filesystem-only authority for simulated Windows", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-windows-local-authority-"));
    const transactionToken = "e".repeat(64);
    try {
      const store = await RemoteTransactionStore.open({
        directory: path.join(root, "remote-transactions"),
        integrityKeyPath: path.join(root, ".remote-transaction-integrity.key"),
        platform: "win32",
        windowsPrivateTreeAuthority: testWindowsPrivateTreeAuthority,
      });
      await beginAclTestRecord(store, transactionToken, "suite-authority-run");

      await expect(store.read(transactionToken)).resolves.toMatchObject({ transactionToken });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("precreates fresh transaction files with exact ACLs and only verifies existing tree entries", () => {
    const initializeFilePath = String.raw`C:\Users\Oracle\.oracle\remote-transactions\.record.tmp`;
    const command = buildWindowsPrivateTreeAclCommand({
      ...commandScope,
      initializeRoots: true,
      initializeIntegrityKey: true,
      initializeFilePath,
    });
    const decodedCommand = Buffer.from(command.args.at(-1) ?? "", "base64").toString("utf16le");

    expect(decodedCommand).toContain("$InitializeRoots = $true");
    expect(decodedCommand).toContain("$InitializeIntegrityKey = $true");
    expect(decodedCommand).toContain("[System.IO.FileStream]::new(");
    expect(decodedCommand).toContain("Refusing to promote an existing integrity key");
    expect(decodedCommand).not.toContain(".SetAccessControl(");
    expect([
      ...decodedCommand.matchAll(/\[System\.Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)/g),
    ]).toHaveLength(5);
  });

  test("encodes each configured path independently instead of appending hostile paths as PowerShell source", () => {
    const hostileScope = {
      storeDirectory: String.raw`C:\Users\Oracle\$(throw 'store path injection')`,
      integrityKeyDirectory: String.raw`C:\Users\Oracle\$(throw 'key directory injection')`,
      authorityDirectory: String.raw`C:\Users\Oracle\$(throw 'authority path injection')`,
      integrityKeyPath: String.raw`C:\Users\Oracle\$(throw 'key directory injection')\$(throw 'key path injection').key`,
    };
    const protectedPaths = [
      hostileScope.storeDirectory,
      hostileScope.authorityDirectory,
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

    expect(encodedPaths).toHaveLength(4);
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
    expect(decodedCommand).toContain("$AuthorityPath = [System.IO.Path]::GetFullPath(");
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

  test("uses the private key initializer only when creating a new Windows key", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-windows-key-initializer-"));
    const directory = path.join(root, "remote-transactions");
    const integrityKeyPath = path.join(root, ".remote-transaction-integrity.key");
    const freshAuthority = vi.fn(testWindowsPrivateTreeAuthority);
    const existingAuthority = vi.fn(testWindowsPrivateTreeAuthority);
    try {
      await RemoteTransactionStore.open({
        directory,
        integrityKeyPath,
        platform: "win32",
        windowsPrivateTreeAuthority: freshAuthority,
      });
      expect(
        freshAuthority.mock.calls.filter(([scope]) => scope.initializeIntegrityKey === true),
      ).toHaveLength(1);

      await RemoteTransactionStore.open({
        directory,
        integrityKeyPath,
        platform: "win32",
        windowsPrivateTreeAuthority: existingAuthority,
      });
      expect(
        existingAuthority.mock.calls.filter(([scope]) => scope.initializeIntegrityKey === true),
      ).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects pre-existing key ctime drift before Windows tree authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-windows-key-ctime-drift-"));
    const directory = path.join(root, "remote-transactions");
    const integrityKeyPath = path.join(root, ".remote-transaction-integrity.key");
    const transactionToken = "c".repeat(64);
    const windowsPrivateTreeAuthority = vi.fn(testWindowsPrivateTreeAuthority);
    try {
      const store = await RemoteTransactionStore.open({
        directory,
        integrityKeyPath,
        platform: "win32",
        windowsPrivateTreeAuthority,
      });
      await beginAclTestRecord(store, transactionToken, "windows-ctime-drift-run");
      const keyContents = await fs.readFile(integrityKeyPath);
      const originalRecord = await fs.readFile(store.recordPath(transactionToken));
      const keyBeforeDrift = await fs.lstat(integrityKeyPath, { bigint: true });
      await fs.writeFile(integrityKeyPath, keyContents);
      const keyAfterDrift = await fs.lstat(integrityKeyPath, { bigint: true });
      expect(keyAfterDrift.ctimeNs).not.toBe(keyBeforeDrift.ctimeNs);

      windowsPrivateTreeAuthority.mockClear();
      await expect(store.read(transactionToken)).rejects.toThrow(
        "Remote transaction integrity key metadata changed before Windows private ACL protection",
      );
      expect(windowsPrivateTreeAuthority).not.toHaveBeenCalled();
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
  test("rejects pre-existing same-byte key mtime drift before Windows tree authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-windows-key-mtime-drift-"));
    const directory = path.join(root, "remote-transactions");
    const integrityKeyPath = path.join(root, ".remote-transaction-integrity.key");
    const transactionToken = "1".repeat(64);
    const windowsPrivateTreeAuthority = vi.fn(testWindowsPrivateTreeAuthority);
    try {
      const store = await RemoteTransactionStore.open({
        directory,
        integrityKeyPath,
        platform: "win32",
        windowsPrivateTreeAuthority,
      });
      await beginAclTestRecord(store, transactionToken, "windows-mtime-drift-run");
      const keyContents = await fs.readFile(integrityKeyPath);
      const originalRecord = await fs.readFile(store.recordPath(transactionToken));
      const keyBeforeDrift = await fs.lstat(integrityKeyPath, { bigint: true });
      await fs.writeFile(integrityKeyPath, keyContents);
      const keyAfterDrift = await fs.lstat(integrityKeyPath, { bigint: true });
      expect(keyAfterDrift.mtimeNs).not.toBe(keyBeforeDrift.mtimeNs);

      windowsPrivateTreeAuthority.mockClear();
      await expect(store.read(transactionToken)).rejects.toThrow(
        "Remote transaction integrity key metadata changed before Windows private ACL protection",
      );
      expect(windowsPrivateTreeAuthority).not.toHaveBeenCalled();
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
  test("rejects same-size key-content replacement on pinned metadata before it can authorize a read", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-windows-key-content-swap-"));
    const directory = path.join(root, "remote-transactions");
    const integrityKeyPath = path.join(root, ".remote-transaction-integrity.key");
    const transactionToken = "d".repeat(64);
    let replaceKey: (() => Promise<void>) | undefined;
    const windowsPrivateTreeAuthority = vi.fn(async (scope: WindowsPrivateTreeScope) => {
      await testWindowsPrivateTreeAuthority(scope);
      const replacement = replaceKey;
      replaceKey = undefined;
      await replacement?.();
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
        "integrity key metadata changed during Windows private ACL protection",
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
    const windowsPrivateTreeAuthority = vi.fn(async (scope: WindowsPrivateTreeScope) => {
      await testWindowsPrivateTreeAuthority(scope);
      const replacement = replaceKey;
      replaceKey = undefined;
      await replacement?.();
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
    "uses the default production authority for fresh roots and publication entries with exact ACLs",
    async () => {
      const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-windows-fresh-private-acl-"));
      const privateRoot = path.join(sandbox, "generation");
      const directory = path.join(privateRoot, "remote-transactions");
      const integrityKeyPath = path.join(privateRoot, ".remote-transaction-integrity.key");
      const transactionToken = "a".repeat(64);
      const powershellExecutable = resolveWindowsPowerShellExecutable();
      try {
        await establishWindowsPrivateDirectory(privateRoot);
        const store = await RemoteTransactionStore.open({
          directory,
          integrityKeyPath,
        });
        await beginAclTestRecord(store, transactionToken, "windows-fresh-acl-run");
        const headDirectory = remoteTransactionHeadDirectory(integrityKeyPath);
        const protectedPaths = [
          privateRoot,
          directory,
          headDirectory,
          integrityKeyPath,
          store.recordPath(transactionToken),
          path.join(headDirectory, `${transactionToken}.head`),
        ];
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
  if ($Acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $CurrentSid.Value) { throw "Unexpected private ACL owner for $ItemPath" }
  if (-not $Acl.AreAccessRulesProtected) { throw "Inherited private ACL for $ItemPath" }
  if ($Rules.Count -ne $AllowedSids.Count) { throw "Unexpected private ACL rule count for $ItemPath" }
  $ExpectedInheritance = if ($Item.PSIsContainer) { $DirectoryInheritance } else { $NoInheritance }
  foreach ($Sid in $AllowedSids) {
    $Matches = @($Rules | Where-Object { $_.IdentityReference.Value -eq $Sid.Value })
    if ($Matches.Count -ne 1) { throw "Unexpected private ACL principal rules for $ItemPath" }
    $Rule = $Matches[0]
    if ($Rule.IsInherited -or $Rule.AccessControlType -ne $Allow -or [int64]$Rule.FileSystemRights -ne [int64]$FullControl -or $Rule.InheritanceFlags -ne $ExpectedInheritance -or $Rule.PropagationFlags -ne $NoPropagation) { throw "Unexpected private ACL rule for $ItemPath" }
  }
}
[Console]::Out.Write('private')`;
        const { stdout } = await execFileAsync(
          powershellExecutable,
          buildWindowsTestPathCommandArgs(verifyScript, protectedPaths),
          { encoding: "utf8", timeout: 12_000, windowsHide: true },
        );
        expect(stdout).toBe("private");
        await expect(store.read(transactionToken)).resolves.toMatchObject({ transactionToken });
      } finally {
        await fs.rm(sandbox, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.runIf(process.platform === "win32")(
    "rejects broadened existing entries so a retained old handle cannot alter accepted authority",
    async () => {
      const sandbox = await fs.mkdtemp(
        path.join(os.tmpdir(), "oracle-windows-rejected-generation-"),
      );
      const rejectedRoot = path.join(sandbox, "rejected-generation");
      const acceptedRoot = path.join(sandbox, "accepted-generation");
      const transactionToken = "f".repeat(64);
      const powershellExecutable = resolveWindowsPowerShellExecutable();
      let retainedHandle: FileHandle | undefined;
      try {
        await establishWindowsPrivateDirectory(rejectedRoot);
        const rejectedDirectory = path.join(rejectedRoot, "remote-transactions");
        const rejectedKeyPath = path.join(rejectedRoot, ".remote-transaction-integrity.key");
        const rejectedStore = await RemoteTransactionStore.open({
          directory: rejectedDirectory,
          integrityKeyPath: rejectedKeyPath,
          windowsPrivateTreeAuthority: protectWindowsPrivateTreeAcl,
        });
        await beginAclTestRecord(rejectedStore, transactionToken, "rejected-generation-run");
        const rejectedRecordPath = rejectedStore.recordPath(transactionToken);
        const rejectedHeadPath = path.join(
          remoteTransactionHeadDirectory(rejectedKeyPath),
          `${transactionToken}.head`,
        );
        retainedHandle = await fs.open(rejectedRecordPath, "r+");
        const broadenScript = String.raw`
$Everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$Rule = [System.Security.AccessControl.FileSystemAccessRule]::new($Everyone, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, [System.Security.AccessControl.AccessControlType]::Allow)
foreach ($ItemPath in $ItemPaths) {
  $Item = Get-Item -LiteralPath $ItemPath -Force
  $Acl = $Item.GetAccessControl()
  [void]$Acl.AddAccessRule($Rule)
  $Item.SetAccessControl($Acl)
}`;
        await execFileAsync(
          powershellExecutable,
          buildWindowsTestPathCommandArgs(broadenScript, [rejectedRecordPath, rejectedHeadPath]),
          { timeout: 12_000, windowsHide: true },
        );

        await expect(rejectedStore.read(transactionToken)).rejects.toThrow(
          "Windows remote transaction private ACL protection failed",
        );
        await expect(
          RemoteTransactionStore.open({
            directory: rejectedDirectory,
            integrityKeyPath: rejectedKeyPath,
            windowsPrivateTreeAuthority: protectWindowsPrivateTreeAcl,
          }),
        ).rejects.toThrow("Windows remote transaction private ACL protection failed");
        const { stdout: rejectedAclCount } = await execFileAsync(
          powershellExecutable,
          buildWindowsTestPathCommandArgs(
            "[Console]::Out.Write(@($ItemPaths | Where-Object { @((Get-Item -LiteralPath $_ -Force).GetAccessControl().GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq 'S-1-1-0' }).Count -eq 1 }).Count)",
            [rejectedRecordPath, rejectedHeadPath],
          ),
          { encoding: "utf8", timeout: 12_000, windowsHide: true },
        );
        expect(rejectedAclCount).toBe("2");

        await establishWindowsPrivateDirectory(acceptedRoot);
        const acceptedStore = await RemoteTransactionStore.open({
          directory: path.join(acceptedRoot, "remote-transactions"),
          integrityKeyPath: path.join(acceptedRoot, ".remote-transaction-integrity.key"),
          windowsPrivateTreeAuthority: protectWindowsPrivateTreeAcl,
        });
        await beginAclTestRecord(acceptedStore, transactionToken, "accepted-generation-run");
        const acceptedBytes = await fs.readFile(acceptedStore.recordPath(transactionToken));

        await retainedHandle.writeFile(Buffer.from("stale rejected generation write", "utf8"));
        await retainedHandle.sync();
        await expect(acceptedStore.read(transactionToken)).resolves.toMatchObject({
          runId: "accepted-generation-run",
        });
        await expect(fs.readFile(acceptedStore.recordPath(transactionToken))).resolves.toEqual(
          acceptedBytes,
        );
      } finally {
        await retainedHandle?.close();
        await fs.rm(sandbox, { recursive: true, force: true });
      }
    },
    30_000,
  );
  test.runIf(process.platform === "win32")(
    "fails closed without repairing a broadened integrity key nested beneath the store tree",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-windows-nested-key-acl-"));
      const storeDirectory = path.join(root, "remote-transactions");
      const integrityKeyDirectory = path.join(storeDirectory, "keys", "active");
      const integrityKeyPath = path.join(
        integrityKeyDirectory,
        ".remote-transaction-integrity.key",
      );
      const ordinaryFilePath = path.join(storeDirectory, "record.json");
      const powershellExecutable = resolveWindowsPowerShellExecutable();
      const scope = { storeDirectory, integrityKeyDirectory, integrityKeyPath };
      try {
        await establishWindowsPrivateDirectory(storeDirectory);
        await establishWindowsPrivateDirectory(path.join(storeDirectory, "keys"));
        await establishWindowsPrivateDirectory(integrityKeyDirectory);
        await protectWindowsPrivateTreeAcl({ ...scope, initializeIntegrityKey: true });
        await fs.writeFile(integrityKeyPath, Buffer.alloc(32));
        await protectWindowsPrivateTreeAcl({ ...scope, initializeFilePath: ordinaryFilePath });
        await fs.writeFile(ordinaryFilePath, "record");
        await expect(protectWindowsPrivateTreeAcl(scope)).resolves.toBeUndefined();

        await execFileAsync(
          powershellExecutable,
          buildWindowsTestPathCommandArgs(
            String.raw`
$Everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$Item = Get-Item -LiteralPath $ItemPaths[0] -Force
$Acl = $Item.GetAccessControl()
[void]$Acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($Everyone, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, [System.Security.AccessControl.AccessControlType]::Allow))
$Item.SetAccessControl($Acl)`,
            [integrityKeyPath],
          ),
          { timeout: 12_000, windowsHide: true },
        );

        await expect(protectWindowsPrivateTreeAcl(scope)).rejects.toThrow(
          "Windows remote transaction private ACL protection failed",
        );
        const { stdout } = await execFileAsync(
          powershellExecutable,
          buildWindowsTestPathCommandArgs(
            "if (@((Get-Item -LiteralPath $ItemPaths[0] -Force).GetAccessControl().GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq 'S-1-1-0' }).Count -eq 1) { [Console]::Out.Write('still-broadened') }",
            [integrityKeyPath],
          ),
          { encoding: "utf8", timeout: 12_000, windowsHide: true },
        );
        expect(stdout).toBe("still-broadened");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
