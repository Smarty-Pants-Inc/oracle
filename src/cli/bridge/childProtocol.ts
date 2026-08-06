import type { ChildProcess, SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { BridgeConnectionArtifact } from "../../bridge/connection.js";
import { syncDirectoryIfPresent } from "../../fsDurability.js";
import { getOracleHomeDir } from "../../oracleHome.js";
import { assertRemoteCredential } from "../../remote/auth.js";
import { writeFileAtomicDurable } from "../../sessionManager.js";
import { resolveWindowsPowerShellExecutable } from "../../windowsSystemExecutable.js";

export const BRIDGE_HOST_CREDENTIAL_PAYLOAD_MAX_BYTES = 512;
export const BRIDGE_HOST_READINESS_PAYLOAD_MAX_BYTES = 256;
export const BRIDGE_HOST_READINESS_TIMEOUT_MS = 30_000;
const BRIDGE_HOST_BACKGROUND_SHUTDOWN_TIMEOUT_MS = 5_000;
const BRIDGE_HOST_IPC_VERSION = 1;
const BRIDGE_HOST_READINESS_NONCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const WINDOWS_BRIDGE_CHILD_LAUNCH_CONFIG = "ORACLE_BRIDGE_CHILD_LAUNCH_CONFIG";
export const WINDOWS_BRIDGE_CHILD_READINESS_STDOUT = "ORACLE_BRIDGE_CHILD_READINESS_STDOUT";
const WINDOWS_BRIDGE_JOB_SUPERVISOR_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class OracleBridgeJob {
  private const uint KillOnClose = 0x00002000;
  [StructLayout(LayoutKind.Sequential)] private struct BasicLimits { public long A; public long B; public uint Flags; public UIntPtr C; public UIntPtr D; public uint E; public UIntPtr F; public uint G; public uint H; }
  [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong A; public ulong B; public ulong C; public ulong D; public ulong E; public ulong F; }
  [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr A; public UIntPtr B; public UIntPtr C; public UIntPtr D; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
  public static IntPtr Create() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var limits = new ExtendedLimits(); limits.Basic.Flags = KillOnClose;
    int size = Marshal.SizeOf(typeof(ExtendedLimits)); IntPtr pointer = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(limits, pointer, false);
      if (!SetInformationJobObject(job, 9, pointer, (uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return job;
    } catch { CloseHandle(job); throw; } finally { Marshal.FreeHGlobal(pointer); }
  }
  public static void Assign(IntPtr job, IntPtr process) { if (!AssignProcessToJobObject(job, process)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Terminate(IntPtr job) { if (!TerminateJobObject(job, 1)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Close(IntPtr job) { if (job != IntPtr.Zero) CloseHandle(job); }
}
'@
$job = [IntPtr]::Zero
$child = $null
$exitCode = 1
try {
  $encodedConfig = [Environment]::GetEnvironmentVariable('${WINDOWS_BRIDGE_CHILD_LAUNCH_CONFIG}', 'Process')
  [Environment]::SetEnvironmentVariable('${WINDOWS_BRIDGE_CHILD_LAUNCH_CONFIG}', $null, 'Process')
  if ([String]::IsNullOrWhiteSpace($encodedConfig)) { throw 'missing launch configuration' }
  $config = ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedConfig)) | ConvertFrom-Json)
  if ([String]::IsNullOrWhiteSpace([string]$config.file)) { throw 'missing child executable' }
  $job = [OracleBridgeJob]::Create()
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = [string]$config.file
  $start.Arguments = [string]$config.arguments
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $child = New-Object Diagnostics.Process
  $child.StartInfo = $start
  if (!$child.Start()) { throw 'child process did not start' }
  [OracleBridgeJob]::Assign($job, $child.Handle)
  $stdoutCopy = $child.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $stderrCopy = $child.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  [Console]::OpenStandardInput().CopyTo($child.StandardInput.BaseStream)
  $child.StandardInput.Close()
  $child.WaitForExit()
  $stdoutCopy.GetAwaiter().GetResult()
  $stderrCopy.GetAwaiter().GetResult()
  $exitCode = $child.ExitCode
} catch {
  [Console]::Error.WriteLine('Bridge host Windows supervisor failed.')
} finally {
  if ($job -ne [IntPtr]::Zero) { try { [OracleBridgeJob]::Terminate($job) } catch {} }
  elseif ($null -ne $child -and !$child.HasExited) { try { $child.Kill() } catch {} }
  if ($null -ne $child -and !$child.HasExited) { try { $child.WaitForExit(5000) | Out-Null } catch {} }
  if ($job -ne [IntPtr]::Zero) { [OracleBridgeJob]::Close($job) }
}
exit $exitCode`;
const WINDOWS_BRIDGE_JOB_SUPERVISOR_ENCODED = Buffer.from(
  WINDOWS_BRIDGE_JOB_SUPERVISOR_SCRIPT,
  "utf16le",
).toString("base64");

function quoteWindowsCommandLineArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") backslashes += 1;
    else if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      result += "\\".repeat(backslashes) + character;
      backslashes = 0;
    }
  }
  return `${result}${"\\".repeat(backslashes * 2)}"`;
}

function buildWindowsBridgeSupervisorLaunch(
  childArgs: readonly string[],
  parentEnv: NodeJS.ProcessEnv,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const config = Buffer.from(
    JSON.stringify({
      file: process.execPath,
      arguments: childArgs.map(quoteWindowsCommandLineArgument).join(" "),
    }),
    "utf8",
  ).toString("base64");
  return {
    command: resolveWindowsPowerShellExecutable(),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      WINDOWS_BRIDGE_JOB_SUPERVISOR_ENCODED,
    ],
    env: {
      ...parentEnv,
      [WINDOWS_BRIDGE_CHILD_LAUNCH_CONFIG]: config,
      [WINDOWS_BRIDGE_CHILD_READINESS_STDOUT]: "1",
    },
  };
}

export interface BridgeHostCredentials {
  token: string;
  legacyToken?: string;
}

interface BridgeHostCredentialPayload extends BridgeHostCredentials {
  readinessNonce: string;
}

interface BridgeHostReadinessPayload {
  readinessNonce: string;
  status: "ready" | "failed";
}

export interface BridgeHostSpawnResult {
  artifact: BridgeConnectionArtifact;
  logPath: string;
  pidPath: string;
  pid: number;
}

export type BridgeHostSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

type ConnectionInput = Pick<BridgeConnectionArtifact, "remoteHost" | "remoteToken" | "tunnel">;

type UnrefWritable = NonNullable<ChildProcess["stdin"]> & {
  unref?: () => void;
};

type UnrefReadable = NodeJS.ReadableStream & {
  destroy?: () => void;
  unref?: () => void;
};

interface FileSnapshot {
  contents: Buffer | null;
}

async function readOneShotBridgeHostLine(
  stream: NodeJS.ReadableStream,
  label: string,
  maxBytes: number,
): Promise<Buffer> {
  if ((stream as NodeJS.ReadStream).isTTY) {
    throw new Error(`${label} is missing.`);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as Uint8Array);
    totalBytes += bytes.byteLength;
    if (totalBytes > maxBytes) {
      (stream as UnrefReadable).destroy?.();
      throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
    }
    chunks.push(bytes);
  }

  if (totalBytes === 0) {
    throw new Error(`${label} is missing.`);
  }
  const payload = Buffer.concat(chunks, totalBytes);
  const newlineIndex = payload.indexOf(0x0a);
  if (newlineIndex < 0) {
    throw new Error(`${label} is malformed.`);
  }
  if (newlineIndex !== payload.byteLength - 1) {
    throw new Error(`${label} contains extra bytes.`);
  }
  return payload;
}

function decodeBridgeHostLine(payload: Buffer, label: string): unknown {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(0, -1));
  } catch {
    throw new Error(`${label} is malformed.`);
  }
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    throw new Error(`${label} is malformed.`);
  }
}

function assertReadinessNonce(value: unknown, label: string): string {
  if (typeof value !== "string" || !BRIDGE_HOST_READINESS_NONCE_PATTERN.test(value)) {
    throw new Error(`${label} is malformed.`);
  }
  return value;
}

function encodeBridgeHostCredentialPayload(payload: BridgeHostCredentialPayload): Buffer {
  const bytes = Buffer.from(
    `${JSON.stringify({
      version: BRIDGE_HOST_IPC_VERSION,
      readinessNonce: payload.readinessNonce,
      token: payload.token,
      ...(payload.legacyToken === undefined ? {} : { legacyToken: payload.legacyToken }),
    })}\n`,
    "utf8",
  );
  if (bytes.byteLength > BRIDGE_HOST_CREDENTIAL_PAYLOAD_MAX_BYTES) {
    throw new Error(
      `Bridge host background credential payload exceeds the ${BRIDGE_HOST_CREDENTIAL_PAYLOAD_MAX_BYTES}-byte limit.`,
    );
  }
  return bytes;
}

export async function readBridgeHostCredentialPayload(
  stream: NodeJS.ReadableStream,
): Promise<BridgeHostCredentialPayload> {
  const label = "Bridge host background credential payload";
  const bytes = await readOneShotBridgeHostLine(
    stream,
    label,
    BRIDGE_HOST_CREDENTIAL_PAYLOAD_MAX_BYTES,
  );
  const parsed = decodeBridgeHostLine(bytes, label);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} is malformed.`);
  }

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  const legacyTokenValue = record.legacyToken;
  if (
    record.version !== BRIDGE_HOST_IPC_VERSION ||
    typeof record.token !== "string" ||
    (legacyTokenValue !== undefined && typeof legacyTokenValue !== "string") ||
    keys.length !== (legacyTokenValue === undefined ? 3 : 4) ||
    keys.some(
      (key) =>
        key !== "version" && key !== "readinessNonce" && key !== "token" && key !== "legacyToken",
    )
  ) {
    throw new Error(`${label} is malformed.`);
  }

  const payload: BridgeHostCredentialPayload = {
    readinessNonce: assertReadinessNonce(record.readinessNonce, label),
    token: assertRemoteCredential(record.token, "Bridge host background credential"),
    legacyToken:
      legacyTokenValue === undefined
        ? undefined
        : assertRemoteCredential(legacyTokenValue, "Bridge host background legacy credential"),
  };
  if (!bytes.equals(encodeBridgeHostCredentialPayload(payload))) {
    throw new Error(`${label} is malformed.`);
  }
  return payload;
}

function encodeBridgeHostReadinessPayload(payload: BridgeHostReadinessPayload): Buffer {
  const bytes = Buffer.from(
    `${JSON.stringify({
      version: BRIDGE_HOST_IPC_VERSION,
      readinessNonce: payload.readinessNonce,
      status: payload.status,
    })}\n`,
    "utf8",
  );
  if (bytes.byteLength > BRIDGE_HOST_READINESS_PAYLOAD_MAX_BYTES) {
    throw new Error(
      `Bridge host readiness payload exceeds the ${BRIDGE_HOST_READINESS_PAYLOAD_MAX_BYTES}-byte limit.`,
    );
  }
  return bytes;
}

async function readBridgeHostReadinessPayload(
  stream: NodeJS.ReadableStream,
): Promise<BridgeHostReadinessPayload> {
  const label = "Bridge host readiness payload";
  const bytes = await readOneShotBridgeHostLine(
    stream,
    label,
    BRIDGE_HOST_READINESS_PAYLOAD_MAX_BYTES,
  );
  const parsed = decodeBridgeHostLine(bytes, label);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} is malformed.`);
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    record.version !== BRIDGE_HOST_IPC_VERSION ||
    (record.status !== "ready" && record.status !== "failed") ||
    keys.length !== 3 ||
    keys.some((key) => key !== "version" && key !== "readinessNonce" && key !== "status")
  ) {
    throw new Error(`${label} is malformed.`);
  }
  const payload: BridgeHostReadinessPayload = {
    readinessNonce: assertReadinessNonce(record.readinessNonce, label),
    status: record.status,
  };
  if (!bytes.equals(encodeBridgeHostReadinessPayload(payload))) {
    throw new Error(`${label} is malformed.`);
  }
  return payload;
}

async function writeOneShotBridgeHostLine(
  stream: UnrefWritable,
  payload: Buffer,
  label: string,
): Promise<void> {
  const transfer = Promise.withResolvers<void>();
  const ignoreLateError = () => undefined;
  const onError = () => transfer.reject(new Error(`${label} transfer failed.`));
  const onFinish = () => transfer.resolve();
  stream.on("error", ignoreLateError);
  stream.once("error", onError);
  stream.once("finish", onFinish);
  stream.end(payload);
  try {
    await transfer.promise;
  } finally {
    stream.off("error", onError);
    stream.off("finish", onFinish);
    stream.unref?.();
  }
}

export async function writeBridgeHostReadinessPayload(
  stream: NodeJS.WritableStream,
  payload: BridgeHostReadinessPayload,
): Promise<void> {
  await writeOneShotBridgeHostLine(
    stream as UnrefWritable,
    encodeBridgeHostReadinessPayload(payload),
    "Bridge host readiness",
  );
}

function buildBridgeHostBackgroundEnvironment(
  source: NodeJS.ProcessEnv,
  payload: BridgeHostCredentialPayload,
): NodeJS.ProcessEnv {
  const secrets = [payload.token, payload.legacyToken, payload.readinessNonce].filter(
    (value): value is string => value !== undefined,
  );
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = key.toUpperCase();
    if (
      value === undefined ||
      normalizedKey === "ORACLE_REMOTE_TOKEN" ||
      normalizedKey === "ORACLE_REMOTE_LEGACY_TOKEN" ||
      secrets.some((secret) => key.includes(secret) || value.includes(secret))
    ) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

async function waitForBridgeHostReadiness(params: {
  child: ChildProcess;
  stream: UnrefReadable;
  readinessNonce: string;
  timeoutMs: number;
}): Promise<void> {
  const failed = Promise.withResolvers<never>();
  const ignoreChildError = () => undefined;
  const onError = () =>
    failed.reject(new Error("Bridge host background child failed before readiness."));
  const onExit = () =>
    failed.reject(new Error("Bridge host background child exited before readiness."));
  params.child.on("error", ignoreChildError);
  params.child.once("error", onError);
  params.child.once("exit", onExit);

  const timedOut = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timedOut.reject(new Error("Bridge host background child readiness timed out.")),
    params.timeoutMs,
  );
  try {
    const payload = await Promise.race([
      readBridgeHostReadinessPayload(params.stream),
      failed.promise,
      timedOut.promise,
    ]);
    if (payload.readinessNonce !== params.readinessNonce) {
      throw new Error("Bridge host background child did not authenticate readiness.");
    }
    if (payload.status === "failed") {
      throw new Error("Bridge host background child reported that startup failed.");
    }
    if (params.child.exitCode !== null || params.child.signalCode !== null) {
      throw new Error("Bridge host background child exited before readiness publication.");
    }
  } finally {
    clearTimeout(timer);
    params.child.off("error", onError);
    params.child.off("exit", onExit);
    params.stream.destroy?.();
    params.stream.unref?.();
  }
}

function bridgeHostChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForBridgeHostChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (bridgeHostChildExited(child)) return;
  const exited = Promise.withResolvers<void>();
  const onExit = () => exited.resolve();
  const timer = setTimeout(
    () => exited.reject(new Error("Bridge host background child did not exit during shutdown.")),
    timeoutMs,
  );
  child.once("exit", onExit);
  try {
    await exited.promise;
  } finally {
    clearTimeout(timer);
    child.off("exit", onExit);
  }
}

function signalBridgeHostChildTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
): void {
  if (platform !== "win32" && child.pid && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  child.kill(signal);
}

async function terminateBridgeHostChildTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
): Promise<void> {
  // On Windows the retained direct child is the kill-on-close Job Object supervisor. Its exit
  // closes the only job handle, so an already-observed exit is tree authority, not a raw PID cue.
  if (bridgeHostChildExited(child)) return;
  signalBridgeHostChildTree(child, "SIGTERM", platform);
  try {
    await waitForBridgeHostChildExit(child, BRIDGE_HOST_BACKGROUND_SHUTDOWN_TIMEOUT_MS);
  } catch (shutdownError) {
    try {
      signalBridgeHostChildTree(child, "SIGKILL", platform);
      await waitForBridgeHostChildExit(child, BRIDGE_HOST_BACKGROUND_SHUTDOWN_TIMEOUT_MS);
    } catch (forceError) {
      throw new AggregateError(
        [shutdownError, forceError],
        "Bridge host background child tree could not be confirmed stopped.",
      );
    }
  }
}

async function captureFileSnapshot(filePath: string): Promise<FileSnapshot> {
  try {
    return { contents: await fs.readFile(filePath) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { contents: null };
    throw error;
  }
}

async function restoreFileSnapshot(filePath: string, snapshot: FileSnapshot): Promise<void> {
  if (snapshot.contents === null) {
    await fs.rm(filePath, { force: true });
    await syncDirectoryIfPresent(path.dirname(filePath));
    return;
  }
  await writeFileAtomicDurable(filePath, snapshot.contents);
}

async function restoreFileSnapshots(
  entries: Array<{ filePath: string; snapshot: FileSnapshot }>,
): Promise<void> {
  const restorationErrors: unknown[] = [];
  for (const entry of entries) {
    try {
      await restoreFileSnapshot(entry.filePath, entry.snapshot);
    } catch (restoreError) {
      restorationErrors.push(restoreError);
    }
  }
  if (restorationErrors.length > 0) {
    throw new AggregateError(
      restorationErrors,
      "Bridge host prior published state could not be restored.",
    );
  }
}

async function rethrowAfterRestoring(
  error: unknown,
  entries: Array<{ filePath: string; snapshot: FileSnapshot }>,
): Promise<never> {
  try {
    await restoreFileSnapshots(entries);
  } catch (restoreError) {
    throw new AggregateError(
      [error, restoreError],
      "Bridge host startup failed and prior published state could not be fully restored.",
    );
  }
  throw error;
}

async function upsertConnectionArtifact(
  filePath: string,
  input: ConnectionInput,
): Promise<BridgeConnectionArtifact> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const now = new Date().toISOString();
  const existing = await fs.readFile(filePath, "utf8").catch(() => null);
  let createdAt = now;
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as { createdAt?: unknown };
      if (typeof parsed.createdAt === "string" && parsed.createdAt.trim().length > 0) {
        createdAt = parsed.createdAt;
      }
    } catch {
      // Ignore invalid previous content; the replacement is written atomically below.
    }
  }

  const artifact: BridgeConnectionArtifact = {
    remoteHost: input.remoteHost,
    remoteToken: input.remoteToken,
    createdAt,
    updatedAt: now,
    tunnel: input.tunnel,
  };
  await writeFileAtomicDurable(filePath, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

export async function publishReadyBridgeConnection(
  filePath: string,
  input: ConnectionInput,
  afterPublication?: (artifact: BridgeConnectionArtifact) => void | Promise<void>,
): Promise<BridgeConnectionArtifact> {
  const snapshot = await captureFileSnapshot(filePath);
  let artifactPublished = false;
  try {
    const artifact = await upsertConnectionArtifact(filePath, input);
    artifactPublished = true;
    await afterPublication?.(artifact);
    return artifact;
  } catch (error) {
    if (!artifactPublished) throw error;
    return rethrowAfterRestoring(error, [{ filePath, snapshot }]);
  }
}

export async function spawnReadyBridgeHostChildAndPublish(
  {
    bind,
    credentials,
    connectionInput,
    writeConnectionPath,
    sshTarget,
    sshRemotePort,
    sshIdentity,
    sshExtraArgs,
  }: {
    bind: string;
    credentials: BridgeHostCredentials;
    connectionInput: ConnectionInput;
    writeConnectionPath: string;
    sshTarget?: string;
    sshRemotePort?: number;
    sshIdentity?: string;
    sshExtraArgs?: string;
  },
  deps: {
    spawnChild: BridgeHostSpawn;
    parentEnv: NodeJS.ProcessEnv;
    readinessNonce: string;
    readinessTimeoutMs: number;
    platform?: NodeJS.Platform;
  },
): Promise<BridgeHostSpawnResult> {
  const platform = deps.platform ?? process.platform;
  const oracleHome = getOracleHomeDir();
  await fs.mkdir(oracleHome, { recursive: true, mode: 0o700 });
  const logPath = path.join(oracleHome, "bridge-host.log");
  const pidPath = path.join(oracleHome, "bridge-host.pid");
  if (
    path.resolve(writeConnectionPath) === path.resolve(pidPath) ||
    path.resolve(writeConnectionPath) === path.resolve(logPath)
  ) {
    throw new Error("Bridge host connection artifact path conflicts with a background state file.");
  }

  const payload: BridgeHostCredentialPayload = {
    readinessNonce: assertReadinessNonce(
      deps.readinessNonce,
      "Bridge host background readiness nonce",
    ),
    ...credentials,
  };
  const encodedPayload = encodeBridgeHostCredentialPayload(payload);
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error("Unable to determine CLI entrypoint for background mode.");
  }
  const args: string[] = [scriptPath, "bridge", "host", "--background-child", "--bind", bind];
  if (sshTarget) {
    args.push("--ssh", sshTarget);
    if (typeof sshRemotePort === "number") {
      args.push("--ssh-remote-port", String(sshRemotePort));
    }
    if (sshIdentity) args.push("--ssh-identity", sshIdentity);
    if (sshExtraArgs) args.push("--ssh-extra-args", sshExtraArgs);
  }

  const protectedValues = [payload.token, payload.legacyToken, payload.readinessNonce].filter(
    (value): value is string => value !== undefined,
  );
  const parentEnv = buildBridgeHostBackgroundEnvironment(deps.parentEnv, payload);
  const launch =
    platform === "win32"
      ? buildWindowsBridgeSupervisorLaunch(args, parentEnv)
      : { command: process.execPath, args, env: parentEnv };
  if (
    [launch.command, ...launch.args, ...Object.values(launch.env)].some(
      (value) =>
        value !== undefined &&
        protectedValues.some((protectedValue) => value.includes(protectedValue)),
    )
  ) {
    throw new Error("Bridge host background options contain protected IPC material.");
  }

  const logHandle = await fs.open(logPath, "a");
  let child: ChildProcess | undefined;
  let publicationCleanupHandled = false;
  try {
    child = deps.spawnChild(launch.command, launch.args, {
      detached: true,
      stdio:
        platform === "win32"
          ? ["pipe", "pipe", logHandle.fd]
          : ["pipe", logHandle.fd, logHandle.fd, "pipe"],
      env: launch.env,
      windowsHide: true,
    });
    const readinessInput = (platform === "win32" ? child.stdout : child.stdio[3]) as
      | UnrefReadable
      | null
      | undefined;
    if (!child.stdin || !readinessInput || child.pid === undefined) {
      throw new Error(
        "Bridge host background child started without the required pipes or process ID.",
      );
    }
    const childPid = child.pid;
    child.unref();
    await Promise.all([
      writeOneShotBridgeHostLine(
        child.stdin as UnrefWritable,
        encodedPayload,
        "Bridge host credential",
      ),
      waitForBridgeHostReadiness({
        child,
        stream: readinessInput,
        readinessNonce: payload.readinessNonce,
        timeoutMs: deps.readinessTimeoutMs,
      }),
    ]);

    const [pidSnapshot, artifactSnapshot] = await Promise.all([
      captureFileSnapshot(pidPath),
      captureFileSnapshot(writeConnectionPath),
    ]);
    const rollbackEntries = [
      { filePath: writeConnectionPath, snapshot: artifactSnapshot },
      { filePath: pidPath, snapshot: pidSnapshot },
    ];
    let childExited = false;
    const markChildExited = () => {
      childExited = true;
    };
    const assertChildRunning = () => {
      if (childExited || bridgeHostChildExited(child!)) {
        throw new Error("Bridge host background child exited during state publication.");
      }
    };
    child.once("error", markChildExited);
    child.once("exit", markChildExited);
    try {
      assertChildRunning();
      await writeFileAtomicDurable(pidPath, `${childPid}\n`);
      assertChildRunning();
      const artifact = await upsertConnectionArtifact(writeConnectionPath, connectionInput);
      assertChildRunning();
      child.off("error", markChildExited);
      child.off("exit", markChildExited);
      return { artifact, logPath, pidPath, pid: childPid };
    } catch (error) {
      publicationCleanupHandled = true;
      try {
        // Drain the ready child tree before rolling published state back.
        await terminateBridgeHostChildTree(child, platform);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Bridge host background state publication failed before the child tree could be drained.",
        );
      }
      try {
        await restoreFileSnapshots(rollbackEntries);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Bridge host background state publication failed after the child tree was drained, but rollback failed.",
        );
      }
      throw error;
    } finally {
      child.off("error", markChildExited);
      child.off("exit", markChildExited);
    }
  } catch (error) {
    if (child && !publicationCleanupHandled) await terminateBridgeHostChildTree(child, platform);
    throw error;
  } finally {
    await logHandle.close().catch(() => undefined);
  }
}
