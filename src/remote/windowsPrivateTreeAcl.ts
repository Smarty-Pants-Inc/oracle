import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { resolveWindowsPowerShellExecutable } from "../windowsSystemExecutable.js";

const WINDOWS_PRIVATE_TREE_ACL_TIMEOUT_MS = 12_000;
const WINDOWS_PRIVATE_TREE_ACL_MARKER = "oracle.remote-transaction.private-tree.v1";
const WINDOWS_PRIVATE_TREE_ACL_NOT_REPAIRED_MARKER = `${WINDOWS_PRIVATE_TREE_ACL_MARKER}:integrity-key-acl-repaired=false`;
const WINDOWS_PRIVATE_TREE_ACL_REPAIRED_MARKER = `${WINDOWS_PRIVATE_TREE_ACL_MARKER}:integrity-key-acl-repaired=true`;
const WINDOWS_PRIVATE_TREE_MAX_ENTRIES = 4_096;

export interface WindowsPrivateTreeScope {
  readonly storeDirectory: string;
  readonly integrityKeyDirectory: string;
  readonly integrityKeyPath: string;
}

export interface WindowsPrivateTreeAuthorityResult {
  readonly integrityKeyAclRepaired: boolean;
}

export interface WindowsAclCommandOptions {
  readonly timeoutMs: number;
}

export type WindowsAclCommandExecutor = (
  file: string,
  args: string[],
  options: WindowsAclCommandOptions,
) => Promise<{ stdout: string }>;

export type WindowsPrivateTreeAuthority = (
  scope: WindowsPrivateTreeScope,
) => Promise<WindowsPrivateTreeAuthorityResult>;

const WINDOWS_PRIVATE_TREE_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$Comparer = [System.StringComparer]::OrdinalIgnoreCase
if (-not $Comparer.Equals([System.IO.Path]::GetDirectoryName($KeyPath), $KeyDirectoryPath)) {
  throw 'Integrity-key path is outside its declared directory.'
}
foreach ($ProtectedRoot in @($StorePath, $KeyDirectoryPath)) {
  if ($Comparer.Equals([System.IO.Path]::GetPathRoot($ProtectedRoot), $ProtectedRoot)) {
    throw 'Refusing to change a filesystem root ACL.'
  }
}

$CurrentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($null -eq $CurrentSid) { throw 'Current Windows identity has no user SID.' }
$AllowedSidsByValue = @{}
foreach ($CandidateSid in @(
  $CurrentSid,
  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
)) {
  $AllowedSidsByValue[$CandidateSid.Value] = $CandidateSid
}
$AllowedSids = @($AllowedSidsByValue.Values)
$FullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
$Allow = [System.Security.AccessControl.AccessControlType]::Allow
$NoPropagation = [System.Security.AccessControl.PropagationFlags]::None
$DirectoryInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$NoInheritance = [System.Security.AccessControl.InheritanceFlags]::None
$ReparsePoint = [System.IO.FileAttributes]::ReparsePoint
$DirectoryAttribute = [System.IO.FileAttributes]::Directory

function Get-PhysicalItem([string]$ItemPath, [bool]$Directory) {
  $Item = if ($Directory) { [System.IO.DirectoryInfo]::new($ItemPath) } else { [System.IO.FileInfo]::new($ItemPath) }
  $Item.Refresh()
  if (-not $Item.Exists) { throw "Protected filesystem item is missing: $ItemPath" }
  if (($Item.Attributes -band $ReparsePoint) -ne 0) { throw "Protected filesystem item is a reparse point: $ItemPath" }
  return $Item
}

function New-PrivateAcl([bool]$Directory) {
  $Acl = if ($Directory) {
    [System.Security.AccessControl.DirectorySecurity]::new()
  } else {
    [System.Security.AccessControl.FileSecurity]::new()
  }
  $Acl.SetOwner($CurrentSid)
  $Acl.SetAccessRuleProtection($true, $false)
  $Inheritance = if ($Directory) { $DirectoryInheritance } else { $NoInheritance }
  foreach ($Sid in $AllowedSids) {
    $Acl.SetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
      $Sid,
      $FullControl,
      $Inheritance,
      $NoPropagation,
      $Allow
    ))
  }
  return $Acl
}

function Get-PrivateAclRuleSignature([System.Security.AccessControl.FileSystemAccessRule]$Rule) {
  return "$($Rule.IdentityReference.Value)|$([int64]$Rule.FileSystemRights)|$([int]$Rule.AccessControlType)|$([int]$Rule.InheritanceFlags)|$([int]$Rule.PropagationFlags)|$($Rule.IsInherited)"
}

function Format-PrivateAclRules($Rules) {
  return (@($Rules | ForEach-Object { Get-PrivateAclRuleSignature $_ } | Sort-Object) -join ', ')
}
$ExpectedPrivateAclRules = @{}
foreach ($ExpectedDirectory in @($false, $true)) {
  $ExpectedAcl = New-PrivateAcl $ExpectedDirectory
  $ExpectedRules = @($ExpectedAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  $ExpectedPrivateAclRules[$ExpectedDirectory] = Format-PrivateAclRules $ExpectedRules
}

function Assert-PrivateAcl([System.IO.FileSystemInfo]$Item, [bool]$Directory) {
  $Acl = $Item.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access)
  $Owner = $Acl.GetOwner([System.Security.Principal.SecurityIdentifier])
  if ($Owner.Value -ne $CurrentSid.Value) { throw "Protected filesystem item owner is not the controller user: $($Item.FullName); actual=$($Owner.Value); expected=$($CurrentSid.Value)" }
  if (-not $Acl.AreAccessRulesProtected) { throw "Protected filesystem item still inherits access rules: $($Item.FullName)" }
  $ActualRules = @($Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  $Expected = $ExpectedPrivateAclRules[$Directory]
  $Actual = Format-PrivateAclRules $ActualRules
  if ($Actual -ne $Expected) {
    throw "Protected filesystem item has non-canonical private access rules: $($Item.FullName); actual=[$Actual]; expected=[$Expected]"
  }
}

function Test-PrivateAcl([System.IO.FileSystemInfo]$Item, [bool]$Directory) {
  try {
    Assert-PrivateAcl $Item $Directory
    return $true
  } catch {
    return $false
  }
}

function Protect-Directory([string]$DirectoryPath) {
  $Item = Get-PhysicalItem $DirectoryPath $true
  if (-not (Test-PrivateAcl $Item $true)) {
    $Item.SetAccessControl((New-PrivateAcl $true))
    $Item = Get-PhysicalItem $DirectoryPath $true
    Assert-PrivateAcl $Item $true
  }
}

function Protect-File([string]$FilePath) {
  $Item = Get-PhysicalItem $FilePath $false
  $Repaired = $false
  if (-not (Test-PrivateAcl $Item $false)) {
    $Item.SetAccessControl((New-PrivateAcl $false))
    $Item = Get-PhysicalItem $FilePath $false
    Assert-PrivateAcl $Item $false
    $Repaired = $true
  }
  return $Repaired
}

Protect-Directory $KeyDirectoryPath
$PendingDirectories = [System.Collections.Generic.Queue[string]]::new()
$PendingDirectories.Enqueue($StorePath)
$EntryCount = 0
while ($PendingDirectories.Count -gt 0) {
  $DirectoryPath = $PendingDirectories.Dequeue()
  Protect-Directory $DirectoryPath
  foreach ($EntryPath in [System.IO.Directory]::EnumerateFileSystemEntries($DirectoryPath)) {
    $EntryCount += 1
    if ($EntryCount -gt ${WINDOWS_PRIVATE_TREE_MAX_ENTRIES}) { throw 'Remote transaction tree exceeds the ACL verification bound.' }
    $Attributes = [System.IO.File]::GetAttributes($EntryPath)
    if (($Attributes -band $ReparsePoint) -ne 0) { throw "Remote transaction tree contains a reparse point: $EntryPath" }
    if (($Attributes -band $DirectoryAttribute) -ne 0) {
      $PendingDirectories.Enqueue($EntryPath)
    } else {
      $null = Protect-File $EntryPath
    }
  }
}
if ([System.IO.Directory]::Exists($KeyPath)) { throw 'Remote transaction integrity-key path is a directory.' }
$IntegrityKeyAclRepaired = $false
if ([System.IO.File]::Exists($KeyPath)) { $IntegrityKeyAclRepaired = Protect-File $KeyPath }
if ($IntegrityKeyAclRepaired) {
  [Console]::Out.Write('${WINDOWS_PRIVATE_TREE_ACL_REPAIRED_MARKER}')
} else {
  [Console]::Out.Write('${WINDOWS_PRIVATE_TREE_ACL_NOT_REPAIRED_MARKER}')
}
`;

function encodeWindowsPrivateTreeAclCommand(scope: WindowsPrivateTreeScope): string {
  const encodedPaths = [
    scope.storeDirectory,
    scope.integrityKeyDirectory,
    scope.integrityKeyPath,
  ].map((protectedPath) => Buffer.from(protectedPath, "utf8").toString("base64"));
  const command = String.raw`
$StorePath = [System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPaths[0]}')))
$KeyDirectoryPath = [System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPaths[1]}')))
$KeyPath = [System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPaths[2]}')))
${WINDOWS_PRIVATE_TREE_ACL_SCRIPT}`;
  return Buffer.from(command, "utf16le").toString("base64");
}

const execFileAsync = promisify(execFile);

const executeWindowsAclCommand: WindowsAclCommandExecutor = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  return { stdout: String(stdout ?? "") };
};

export function buildWindowsPrivateTreeAclCommand(scope: WindowsPrivateTreeScope): {
  readonly file: string;
  readonly args: string[];
  readonly options: WindowsAclCommandOptions;
} {
  for (const protectedPath of [
    scope.storeDirectory,
    scope.integrityKeyDirectory,
    scope.integrityKeyPath,
  ]) {
    if (!path.win32.isAbsolute(protectedPath)) {
      throw new Error("Windows remote transaction protection requires absolute native paths");
    }
  }
  return {
    file: resolveWindowsPowerShellExecutable(),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodeWindowsPrivateTreeAclCommand(scope),
    ],
    options: { timeoutMs: WINDOWS_PRIVATE_TREE_ACL_TIMEOUT_MS },
  };
}

export async function protectWindowsPrivateTreeAcl(
  scope: WindowsPrivateTreeScope,
  execute: WindowsAclCommandExecutor = executeWindowsAclCommand,
): Promise<WindowsPrivateTreeAuthorityResult> {
  const command = buildWindowsPrivateTreeAclCommand(scope);
  let stdout: string;
  try {
    ({ stdout } = await execute(command.file, command.args, command.options));
  } catch (error) {
    throw new Error("Windows remote transaction private ACL protection failed", { cause: error });
  }
  if (stdout === WINDOWS_PRIVATE_TREE_ACL_NOT_REPAIRED_MARKER) {
    return { integrityKeyAclRepaired: false };
  }
  if (stdout === WINDOWS_PRIVATE_TREE_ACL_REPAIRED_MARKER) {
    return { integrityKeyAclRepaired: true };
  }
  throw new Error("Windows remote transaction private ACL verification did not complete");
}
