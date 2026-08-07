import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { resolveWindowsPowerShellExecutable } from "./windowsSystemExecutable.js";

const WINDOWS_PRIVATE_FILE_ACL_TIMEOUT_MS = 12_000;
const WINDOWS_PRIVATE_FILE_ACL_COMPLETE_MARKER = "oracle.private-file.v1:complete";

export interface WindowsPrivateFileAclRequest {
  readonly filePath: string;
  readonly repair: boolean;
  /** Fail if the path exists and apply the exact private DACL in the create operation. */
  readonly createNew?: boolean;
}

export interface WindowsFileAclCommandOptions {
  readonly timeoutMs: number;
}

export type WindowsFileAclCommandExecutor = (
  file: string,
  args: string[],
  options: WindowsFileAclCommandOptions,
) => Promise<{ stdout: string }>;

export type WindowsPrivateFileAuthority = (request: WindowsPrivateFileAclRequest) => Promise<void>;

const WINDOWS_PRIVATE_FILE_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
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
$NoInheritance = [System.Security.AccessControl.InheritanceFlags]::None
$NoPropagation = [System.Security.AccessControl.PropagationFlags]::None

function New-PrivateFileAcl {
  $Acl = [System.Security.AccessControl.FileSecurity]::new()
  $Acl.SetOwner($CurrentSid)
  $Acl.SetAccessRuleProtection($true, $false)
  foreach ($Sid in $AllowedSids) {
    $Acl.SetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
      $Sid,
      $FullControl,
      $NoInheritance,
      $NoPropagation,
      $Allow
    ))
  }
  return $Acl
}

function Format-Rule([System.Security.AccessControl.FileSystemAccessRule]$Rule) {
  return "$($Rule.IdentityReference.Value)|$([int64]$Rule.FileSystemRights)|$([int]$Rule.AccessControlType)|$([int]$Rule.InheritanceFlags)|$([int]$Rule.PropagationFlags)|$($Rule.IsInherited)"
}

function Format-Rules($Rules) {
  return (@($Rules | ForEach-Object { Format-Rule $_ } | Sort-Object) -join ', ')
}

$ExpectedAcl = New-PrivateFileAcl
$ExpectedRules = Format-Rules @($ExpectedAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))

function Assert-PrivateFileAcl([System.IO.FileInfo]$File) {
  $Acl = $File.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access)
  $Owner = $Acl.GetOwner([System.Security.Principal.SecurityIdentifier])
  if ($Owner.Value -ne $CurrentSid.Value) { throw "Protected file owner is not the controller user: $($File.FullName)" }
  if (-not $Acl.AreAccessRulesProtected) { throw "Protected file still inherits access rules: $($File.FullName)" }
  $ActualRules = Format-Rules @($Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($ActualRules -ne $ExpectedRules) { throw "Protected file has non-canonical private access rules: $($File.FullName); actual=[$ActualRules]; expected=[$ExpectedRules]" }
}

if ($CreateNew) {
  $Stream = $null
  try {
    $Stream = [System.IO.FileStream]::new(
      $FilePath,
      [System.IO.FileMode]::CreateNew,
      $FullControl,
      [System.IO.FileShare]::None,
      4096,
      [System.IO.FileOptions]::None,
      $ExpectedAcl
    )
  } finally {
    if ($null -ne $Stream) { $Stream.Dispose() }
  }
}

$Item = [System.IO.FileInfo]::new($FilePath)
$Item.Refresh()
if (-not $Item.Exists) { throw "Protected file is missing: $FilePath" }
if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Protected file is a reparse point: $FilePath" }
try {
  Assert-PrivateFileAcl $Item
} catch {
  if (-not $Repair) { throw }
  $Item.SetAccessControl($ExpectedAcl)
  $Item = [System.IO.FileInfo]::new($FilePath)
  $Item.Refresh()
  if (-not $Item.Exists -or (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "Protected file changed during ACL repair: $FilePath" }
  Assert-PrivateFileAcl $Item
}
[Console]::Out.Write('${WINDOWS_PRIVATE_FILE_ACL_COMPLETE_MARKER}')
`;

function encodeWindowsPrivateFileAclCommand(request: WindowsPrivateFileAclRequest): string {
  const encodedPath = Buffer.from(request.filePath, "utf8").toString("base64");
  const command = String.raw`
$FilePath = [System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPath}')))
$Repair = ${request.repair ? "$true" : "$false"}
$CreateNew = ${request.createNew ? "$true" : "$false"}
${WINDOWS_PRIVATE_FILE_ACL_SCRIPT}`;
  return Buffer.from(command, "utf16le").toString("base64");
}

const execFileAsync = promisify(execFile);

const executeWindowsFileAclCommand: WindowsFileAclCommandExecutor = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  return { stdout: String(stdout ?? "") };
};

export function buildWindowsPrivateFileAclCommand(request: WindowsPrivateFileAclRequest): {
  readonly file: string;
  readonly args: string[];
  readonly options: WindowsFileAclCommandOptions;
} {
  if (request.createNew && request.repair) {
    throw new Error("Windows private file creation cannot also request ACL repair");
  }
  if (!path.win32.isAbsolute(request.filePath)) {
    throw new Error("Windows private file protection requires an absolute native path");
  }
  return {
    file: resolveWindowsPowerShellExecutable(),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodeWindowsPrivateFileAclCommand(request),
    ],
    options: { timeoutMs: WINDOWS_PRIVATE_FILE_ACL_TIMEOUT_MS },
  };
}

export async function applyWindowsPrivateFileAcl(
  request: WindowsPrivateFileAclRequest,
  execute: WindowsFileAclCommandExecutor = executeWindowsFileAclCommand,
): Promise<void> {
  const command = buildWindowsPrivateFileAclCommand(request);
  let stdout: string;
  try {
    ({ stdout } = await execute(command.file, command.args, command.options));
  } catch (error) {
    throw new Error(
      request.createNew
        ? "Windows private file creation failed"
        : request.repair
          ? "Windows private file ACL protection failed"
          : "Windows private file ACL verification failed",
      { cause: error },
    );
  }
  if (stdout !== WINDOWS_PRIVATE_FILE_ACL_COMPLETE_MARKER) {
    throw new Error("Windows private file ACL verification did not complete");
  }
}
