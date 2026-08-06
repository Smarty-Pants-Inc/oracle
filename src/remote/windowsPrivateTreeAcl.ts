import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { resolveWindowsPowerShellExecutable } from "../windowsSystemExecutable.js";

const WINDOWS_PRIVATE_TREE_ACL_TIMEOUT_MS = 12_000;
const WINDOWS_PRIVATE_TREE_ACL_COMPLETE_MARKER =
  "oracle.remote-transaction.private-tree.v1:complete";
const WINDOWS_PRIVATE_DIRECTORY_COMPLETE_MARKER = "oracle.windows-private-directory.v1:complete";
const WINDOWS_PRIVATE_TREE_MAX_ENTRIES = 4_096;

export interface WindowsPrivateTreeScope {
  readonly storeDirectory: string;
  readonly authorityDirectory?: string;
  readonly integrityKeyDirectory: string;
  readonly integrityKeyPath: string;
  readonly initializeRoots?: boolean;
  readonly initializeIntegrityKey?: boolean;
  readonly initializeFilePath?: string;
}

export interface WindowsAclCommandOptions {
  readonly timeoutMs: number;
}

export type WindowsAclCommandExecutor = (
  file: string,
  args: string[],
  options: WindowsAclCommandOptions,
) => Promise<{ stdout: string }>;

export type WindowsPrivateTreeAuthority = (scope: WindowsPrivateTreeScope) => Promise<void>;

const WINDOWS_PRIVATE_ACL_FUNCTIONS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$Comparer = [System.StringComparer]::OrdinalIgnoreCase
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

function Assert-SafePrivatePath([string]$ItemPath) {
  if ($Comparer.Equals([System.IO.Path]::GetPathRoot($ItemPath), $ItemPath)) {
    throw 'Refusing to establish private authority at a filesystem root.'
  }
}

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

function Establish-PrivateDirectory([string]$DirectoryPath) {
  Assert-SafePrivatePath $DirectoryPath
  if ([System.IO.File]::Exists($DirectoryPath)) { throw "Private directory path is an existing file: $DirectoryPath" }
  if ([System.IO.Directory]::Exists($DirectoryPath)) {
    Assert-PrivateAcl (Get-PhysicalItem $DirectoryPath $true) $true
    return
  }
  $ParentPath = [System.IO.Path]::GetDirectoryName($DirectoryPath)
  if ([string]::IsNullOrEmpty($ParentPath)) { throw "Private directory has no parent: $DirectoryPath" }
  [void](Get-PhysicalItem $ParentPath $true)
  [void][System.IO.Directory]::CreateDirectory($DirectoryPath, (New-PrivateAcl $true))
  Assert-PrivateAcl (Get-PhysicalItem $DirectoryPath $true) $true
}

function New-PrivateFile([string]$FilePath) {
  Assert-SafePrivatePath $FilePath
  if ([System.IO.Directory]::Exists($FilePath)) { throw "Private file path is an existing directory: $FilePath" }
  if ([System.IO.File]::Exists($FilePath)) { throw "Refusing to promote an existing file into private authority: $FilePath" }
  $ParentPath = [System.IO.Path]::GetDirectoryName($FilePath)
  Assert-PrivateAcl (Get-PhysicalItem $ParentPath $true) $true
  $Stream = [System.IO.FileStream]::new(
    $FilePath,
    [System.IO.FileMode]::CreateNew,
    $FullControl,
    [System.IO.FileShare]::None,
    4096,
    [System.IO.FileOptions]::None,
    (New-PrivateAcl $false)
  )
  $Stream.Dispose()
  Assert-PrivateAcl (Get-PhysicalItem $FilePath $false) $false
}
`;

const WINDOWS_PRIVATE_TREE_ACL_SCRIPT = String.raw`
if (-not $Comparer.Equals([System.IO.Path]::GetDirectoryName($KeyPath), $KeyDirectoryPath)) {
  throw 'Integrity-key path is outside its declared directory.'
}
foreach ($ProtectedRoot in @($StorePath, $AuthorityPath, $KeyDirectoryPath)) {
  Assert-SafePrivatePath $ProtectedRoot
}

if ($InitializeRoots) {
  $PendingRoots = [System.Collections.Generic.List[string]]::new()
  foreach ($CandidateRoot in @($StorePath, $AuthorityPath, $KeyDirectoryPath)) {
    if (-not ($PendingRoots | Where-Object { $Comparer.Equals($_, $CandidateRoot) })) {
      $PendingRoots.Add($CandidateRoot)
    }
  }
  while ($PendingRoots.Count -gt 0) {
    $Progress = $false
    for ($Index = $PendingRoots.Count - 1; $Index -ge 0; $Index -= 1) {
      $CandidateRoot = $PendingRoots[$Index]
      $ParentPath = [System.IO.Path]::GetDirectoryName($CandidateRoot)
      if (-not [System.IO.Directory]::Exists($ParentPath)) { continue }
      Establish-PrivateDirectory $CandidateRoot
      $PendingRoots.RemoveAt($Index)
      $Progress = $true
    }
    if (-not $Progress) { throw 'A declared private directory parent is missing.' }
  }
} else {
  Assert-PrivateAcl (Get-PhysicalItem $StorePath $true) $true
  Assert-PrivateAcl (Get-PhysicalItem $AuthorityPath $true) $true
  Assert-PrivateAcl (Get-PhysicalItem $KeyDirectoryPath $true) $true
}

$PrivateRoots = @($StorePath)
if (-not $Comparer.Equals($AuthorityPath, $StorePath)) { $PrivateRoots += $AuthorityPath }
$PendingDirectories = [System.Collections.Generic.Queue[string]]::new()
foreach ($PrivateRoot in $PrivateRoots) { $PendingDirectories.Enqueue($PrivateRoot) }
$EntryCount = 0
while ($PendingDirectories.Count -gt 0) {
  $DirectoryPath = $PendingDirectories.Dequeue()
  Assert-PrivateAcl (Get-PhysicalItem $DirectoryPath $true) $true
  foreach ($EntryPath in [System.IO.Directory]::EnumerateFileSystemEntries($DirectoryPath)) {
    $EntryCount += 1
    if ($EntryCount -gt ${WINDOWS_PRIVATE_TREE_MAX_ENTRIES}) { throw 'Remote transaction private trees exceed the ACL verification bound.' }
    $Attributes = [System.IO.File]::GetAttributes($EntryPath)
    if (($Attributes -band $ReparsePoint) -ne 0) { throw "Remote transaction private tree contains a reparse point: $EntryPath" }
    if ($Comparer.Equals($EntryPath, $KeyPath)) { continue }
    $EntryName = [System.IO.Path]::GetFileName($EntryPath)
    $ControllerLockEntry = $Comparer.Equals($EntryName, '.controller.lock') -or
      $Comparer.Equals($EntryName, '.controller.lock.mutations') -or
      $EntryName.StartsWith('.controller.lock.publishing-', [System.StringComparison]::Ordinal) -or
      $EntryName.StartsWith('.controller.lock.released-', [System.StringComparison]::Ordinal) -or
      $EntryName.StartsWith('.controller.lock.stale-', [System.StringComparison]::Ordinal) -or
      $EntryName.StartsWith('.oracle-remove-', [System.StringComparison]::Ordinal)
    if ($Comparer.Equals($DirectoryPath, $StorePath) -and $ControllerLockEntry) { continue }
    if (($Attributes -band $DirectoryAttribute) -ne 0) {
      $PendingDirectories.Enqueue($EntryPath)
    } else {
      Assert-PrivateAcl (Get-PhysicalItem $EntryPath $false) $false
    }
  }
}
if ([System.IO.Directory]::Exists($KeyPath)) { throw 'Remote transaction integrity-key path is a directory.' }
if ([System.IO.File]::Exists($KeyPath)) {
  if ($InitializeIntegrityKey) { throw 'Refusing to promote an existing integrity key into private authority.' }
  Assert-PrivateAcl (Get-PhysicalItem $KeyPath $false) $false
} elseif ($InitializeIntegrityKey) {
  New-PrivateFile $KeyPath
}
if ($null -ne $InitializeFilePath) {
  $InitializeFileParent = [System.IO.Path]::GetDirectoryName($InitializeFilePath)
  if (-not $Comparer.Equals($InitializeFileParent, $StorePath) -and -not $Comparer.Equals($InitializeFileParent, $AuthorityPath)) {
    throw 'Private transaction publication file is outside the store and authority roots.'
  }
  New-PrivateFile $InitializeFilePath
}
[Console]::Out.Write('${WINDOWS_PRIVATE_TREE_ACL_COMPLETE_MARKER}')
`;

function encodeWindowsPrivateTreeAclCommand(scope: WindowsPrivateTreeScope): string {
  const encodedPaths = [
    scope.storeDirectory,
    scope.authorityDirectory ?? scope.storeDirectory,
    scope.integrityKeyDirectory,
    scope.integrityKeyPath,
    ...(scope.initializeFilePath ? [scope.initializeFilePath] : []),
  ].map((protectedPath) => Buffer.from(protectedPath, "utf8").toString("base64"));
  const initializeFileExpression = scope.initializeFilePath
    ? `[System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPaths[4]}')))`
    : "$null";
  const command = String.raw`
$StorePath = [System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPaths[0]}')))
$AuthorityPath = [System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPaths[1]}')))
$KeyDirectoryPath = [System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPaths[2]}')))
$KeyPath = [System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPaths[3]}')))
$InitializeRoots = ${scope.initializeRoots ? "$true" : "$false"}
$InitializeIntegrityKey = ${scope.initializeIntegrityKey ? "$true" : "$false"}
$InitializeFilePath = ${initializeFileExpression}
${WINDOWS_PRIVATE_ACL_FUNCTIONS_SCRIPT}
${WINDOWS_PRIVATE_TREE_ACL_SCRIPT}`;
  return Buffer.from(command, "utf16le").toString("base64");
}

function encodeWindowsPrivateDirectoryCommand(directoryPath: string): string {
  const encodedPath = Buffer.from(directoryPath, "utf8").toString("base64");
  const command = String.raw`
$DirectoryPath = [System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPath}')))
${WINDOWS_PRIVATE_ACL_FUNCTIONS_SCRIPT}
Establish-PrivateDirectory $DirectoryPath
[Console]::Out.Write('${WINDOWS_PRIVATE_DIRECTORY_COMPLETE_MARKER}')`;
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

export interface WindowsAclCommand {
  readonly file: string;
  readonly args: string[];
  readonly options: WindowsAclCommandOptions;
}

function assertAbsoluteNonRootWindowsPath(protectedPath: string): void {
  if (!path.win32.isAbsolute(protectedPath)) {
    throw new Error("Windows private ACL protection requires an absolute native path");
  }
  const resolved = path.win32.resolve(protectedPath);
  if (resolved.toLowerCase() === path.win32.parse(resolved).root.toLowerCase()) {
    throw new Error("Windows private ACL protection refuses a filesystem root");
  }
}

export function buildWindowsPrivateDirectoryCommand(directoryPath: string): WindowsAclCommand {
  assertAbsoluteNonRootWindowsPath(directoryPath);
  return {
    file: resolveWindowsPowerShellExecutable(),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodeWindowsPrivateDirectoryCommand(directoryPath),
    ],
    options: { timeoutMs: WINDOWS_PRIVATE_TREE_ACL_TIMEOUT_MS },
  };
}

export function buildWindowsPrivateTreeAclCommand(
  scope: WindowsPrivateTreeScope,
): WindowsAclCommand {
  for (const protectedPath of [
    scope.storeDirectory,
    scope.authorityDirectory ?? scope.storeDirectory,
    scope.integrityKeyDirectory,
    scope.integrityKeyPath,
    ...(scope.initializeFilePath ? [scope.initializeFilePath] : []),
  ]) {
    assertAbsoluteNonRootWindowsPath(protectedPath);
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

async function runWindowsPrivateAclCommand(
  command: WindowsAclCommand,
  marker: string,
  failureMessage: string,
  execute: WindowsAclCommandExecutor,
): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execute(command.file, command.args, command.options));
  } catch (error) {
    throw new Error(failureMessage, { cause: error });
  }
  if (stdout !== marker) {
    throw new Error(
      `${failureMessage.replace(" protection failed", " verification")} did not complete`,
    );
  }
}

export async function establishWindowsPrivateDirectory(
  directoryPath: string,
  execute: WindowsAclCommandExecutor = executeWindowsAclCommand,
): Promise<void> {
  await runWindowsPrivateAclCommand(
    buildWindowsPrivateDirectoryCommand(directoryPath),
    WINDOWS_PRIVATE_DIRECTORY_COMPLETE_MARKER,
    "Windows private directory protection failed",
    execute,
  );
}

export async function protectWindowsPrivateTreeAcl(
  scope: WindowsPrivateTreeScope,
  execute: WindowsAclCommandExecutor = executeWindowsAclCommand,
): Promise<void> {
  await runWindowsPrivateAclCommand(
    buildWindowsPrivateTreeAclCommand(scope),
    WINDOWS_PRIVATE_TREE_ACL_COMPLETE_MARKER,
    "Windows remote transaction private ACL protection failed",
    execute,
  );
}
