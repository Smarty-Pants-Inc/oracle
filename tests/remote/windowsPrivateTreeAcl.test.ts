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
const WINDOWS_PRIVATE_TREE_ACL_MARKER = "oracle.remote-transaction.private-tree.v1";
const TEST_WINDOWS_SYSTEM_ROOT = String.raw`D:\Windows`;

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

describe("Windows remote transaction private ACL authority", () => {
  test("uses one bounded native command resolved from an injected non-C SystemRoot", async () => {
    const execute = vi.fn(async () => ({ stdout: WINDOWS_PRIVATE_TREE_ACL_MARKER }));

    await protectWindowsPrivateTreeAcl(commandScope, execute, TEST_WINDOWS_SYSTEM_ROOT);

    const command = buildWindowsPrivateTreeAclCommand(commandScope, TEST_WINDOWS_SYSTEM_ROOT);
    expect(command.file).toBe(
      String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
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
    const command = buildWindowsPrivateTreeAclCommand(hostileScope, TEST_WINDOWS_SYSTEM_ROOT);
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
      protectWindowsPrivateTreeAcl(
        commandScope,
        async () => ({ stdout: "partial" }),
        TEST_WINDOWS_SYSTEM_ROOT,
      ),
    ).rejects.toThrow("private ACL verification did not complete");
    await expect(
      protectWindowsPrivateTreeAcl(
        commandScope,
        async () => {
          throw new Error("probe unavailable");
        },
        TEST_WINDOWS_SYSTEM_ROOT,
      ),
    ).rejects.toThrow("private ACL protection failed");
  });

  test.runIf(process.platform === "win32")(
    "repairs an Everyone-readable key and transaction tree before record use",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-windows-private-acl-"));
      const directory = path.join(root, "remote-transactions");
      const integrityKeyPath = path.join(root, ".remote-transaction-integrity.key");
      const transactionToken = "a".repeat(64);
      const powershellExecutable = resolveWindowsPowerShellExecutable();
      try {
        const store = await RemoteTransactionStore.open({ directory, integrityKeyPath });
        await store.begin({
          protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
          transactionToken,
          runId: "windows-acl-run",
          createdAt: new Date().toISOString(),
          requestIdentity: {
            acceptedPromptSha256: ["b".repeat(64)],
            followUpOrdinal: 0,
            remainingFollowUps: 0,
          },
          browserConfig: { chatgptUrl: "https://chatgpt.com/" },
        });
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

        const reopened = await RemoteTransactionStore.open({ directory, integrityKeyPath });
        await expect(reopened.read(transactionToken)).resolves.toMatchObject({ transactionToken });

        const verifyScript = String.raw`
$ErrorActionPreference = 'Stop'
$Everyone = 'S-1-1-0'
foreach ($ItemPath in $ItemPaths) {
  $Item = Get-Item -LiteralPath $ItemPath -Force
  $Acl = $Item.GetAccessControl()
  if (-not $Acl.AreAccessRulesProtected) { exit 20 }
  $Rules = @($Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if (@($Rules | Where-Object { $_.IdentityReference.Value -eq $Everyone }).Count -ne 0) { exit 21 }
}
[Console]::Out.Write('private')`;
        const { stdout } = await execFileAsync(
          powershellExecutable,
          buildWindowsTestPathCommandArgs(verifyScript, protectedPaths),
          { encoding: "utf8", timeout: 12_000, windowsHide: true },
        );
        expect(stdout).toBe("private");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
