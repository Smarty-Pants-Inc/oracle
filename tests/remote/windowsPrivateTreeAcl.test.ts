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
  WINDOWS_POWERSHELL_EXECUTABLE,
} from "../../src/remote/windowsPrivateTreeAcl.js";

const execFileAsync = promisify(execFile);
const WINDOWS_PRIVATE_TREE_ACL_MARKER = "oracle.remote-transaction.private-tree.v1";

const commandScope = {
  storeDirectory: String.raw`C:\Users\Oracle\.oracle\remote-transactions`,
  integrityKeyDirectory: String.raw`C:\Users\Oracle\.oracle`,
  integrityKeyPath: String.raw`C:\Users\Oracle\.oracle\.remote-transaction-integrity.key`,
};

describe("Windows remote transaction private ACL authority", () => {
  test("uses one bounded fixed-path native command without PATH or shell resolution", async () => {
    const execute = vi.fn(async () => ({ stdout: WINDOWS_PRIVATE_TREE_ACL_MARKER }));

    await protectWindowsPrivateTreeAcl(commandScope, execute);

    const command = buildWindowsPrivateTreeAclCommand(commandScope);
    expect(command.file).toBe(
      String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
    expect(command.file).toBe(WINDOWS_POWERSHELL_EXECUTABLE);
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

  test("encodes configured paths instead of appending them as PowerShell source", () => {
    const hostileScope = {
      ...commandScope,
      storeDirectory: String.raw`C:\Users\Oracle\$(throw 'path injection')`,
    };
    const command = buildWindowsPrivateTreeAclCommand(hostileScope);
    const encodedCommand = command.args.at(-1);
    expect(encodedCommand).toBeDefined();
    const decodedCommand = Buffer.from(encodedCommand ?? "", "base64").toString("utf16le");
    const encodedScope = Buffer.from(
      JSON.stringify([
        hostileScope.storeDirectory,
        hostileScope.integrityKeyDirectory,
        hostileScope.integrityKeyPath,
      ]),
      "utf8",
    ).toString("base64");

    expect(command.args).not.toContain(hostileScope.storeDirectory);
    expect(decodedCommand).not.toContain(hostileScope.storeDirectory);
    expect(decodedCommand).toContain(`FromBase64String('${encodedScope}')`);
    expect(decodedCommand).toContain("$Scope = @($ScopeJson | ConvertFrom-Json)");
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

  test.runIf(process.platform === "win32")(
    "repairs an Everyone-readable key and transaction tree before record use",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-windows-private-acl-"));
      const directory = path.join(root, "remote-transactions");
      const integrityKeyPath = path.join(root, ".remote-transaction-integrity.key");
      const transactionToken = "a".repeat(64);
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
foreach ($ItemPath in $args) {
  $Item = Get-Item -LiteralPath $ItemPath -Force
  $Acl = $Item.GetAccessControl()
  [void]$Acl.AddAccessRule($Rule)
  $Item.SetAccessControl($Acl)
}`;
        await execFileAsync(
          WINDOWS_POWERSHELL_EXECUTABLE,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            broadenScript,
            ...protectedPaths,
          ],
          { timeout: 12_000, windowsHide: true },
        );

        const reopened = await RemoteTransactionStore.open({ directory, integrityKeyPath });
        await expect(reopened.read(transactionToken)).resolves.toMatchObject({ transactionToken });

        const verifyScript = String.raw`
$ErrorActionPreference = 'Stop'
$Everyone = 'S-1-1-0'
foreach ($ItemPath in $args) {
  $Item = Get-Item -LiteralPath $ItemPath -Force
  $Acl = $Item.GetAccessControl()
  if (-not $Acl.AreAccessRulesProtected) { exit 20 }
  $Rules = @($Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if (@($Rules | Where-Object { $_.IdentityReference.Value -eq $Everyone }).Count -ne 0) { exit 21 }
}
[Console]::Out.Write('private')`;
        const { stdout } = await execFileAsync(
          WINDOWS_POWERSHELL_EXECUTABLE,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", verifyScript, ...protectedPaths],
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
