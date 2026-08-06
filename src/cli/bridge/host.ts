import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import chalk from "chalk";
import { getOracleHomeDir } from "../../oracleHome.js";
import {
  parseHostPort,
  normalizeHostPort,
  formatBridgeConnectionString,
} from "../../bridge/connection.js";
import type { BridgeConnectionArtifact } from "../../bridge/connection.js";
import { serveRemote } from "../../remote/server.js";
import { assertLoopbackRemoteBind } from "../../remote/remoteServiceConfig.js";
import { assertRemoteCredential, generateRemoteCredential } from "../../remote/auth.js";

export const BRIDGE_HOST_CREDENTIAL_PAYLOAD_MAX_BYTES = 512;
export const BRIDGE_HOST_READINESS_PAYLOAD_MAX_BYTES = 256;
export const BRIDGE_HOST_READINESS_TIMEOUT_MS = 30_000;
const BRIDGE_HOST_IPC_VERSION = 1;
const BRIDGE_HOST_READINESS_NONCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface BridgeHostCredentials {
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

interface BridgeHostSpawnResult {
  artifact: BridgeConnectionArtifact;
  logPath: string;
  pidPath: string;
  pid: number;
}

type BridgeHostSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

type UnrefWritable = NonNullable<ChildProcess["stdin"]> & {
  unref?: () => void;
};

type UnrefReadable = NodeJS.ReadableStream & {
  destroy?: () => void;
  unref?: () => void;
};

export interface BridgeHostCliOptions {
  bind?: string;
  token?: string;
  legacyToken?: string;
  writeConnection?: string;
  ssh?: string;
  sshRemotePort?: number;
  sshIdentity?: string;
  sshExtraArgs?: string;
  background?: boolean;
  backgroundChild?: boolean;
  foreground?: boolean;
  print?: boolean;
  printToken?: boolean;
}

interface ReverseTunnelHandle {
  ready: Promise<void>;
  stop: () => void | Promise<void>;
}

type StartReverseTunnel = (
  options: Parameters<typeof startReverseTunnel>[0],
) => ReverseTunnelHandle | Promise<ReverseTunnelHandle>;

export interface BridgeHostDeps {
  serveRemote?: typeof serveRemote;
  startReverseTunnel?: StartReverseTunnel;
  spawn?: BridgeHostSpawn;
  stdin?: NodeJS.ReadableStream;
  readinessOutput?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  generateReadinessNonce?: () => string;
  readinessTimeoutMs?: number;
}

export async function runBridgeHost(
  options: BridgeHostCliOptions,
  deps: BridgeHostDeps = {},
): Promise<void> {
  const bindRaw = options.bind?.trim() || "127.0.0.1:9473";
  const { hostname: bindHost, port: bindPort } = parseHostPort(bindRaw);
  assertLoopbackRemoteBind(bindHost);

  if (
    options.backgroundChild &&
    (options.background ||
      options.foreground ||
      options.token !== undefined ||
      options.legacyToken !== undefined ||
      options.writeConnection !== undefined ||
      options.print ||
      options.printToken)
  ) {
    throw new Error("Bridge host background child mode received conflicting CLI options.");
  }

  let credentials: BridgeHostCredentials;
  let childReadinessNonce: string | undefined;
  if (options.backgroundChild) {
    const payload = await readBridgeHostCredentialPayload(deps.stdin ?? process.stdin);
    credentials = payload;
    childReadinessNonce = payload.readinessNonce;
  } else {
    const tokenRaw = options.token ?? "auto";
    credentials = {
      token:
        tokenRaw === "auto"
          ? generateRemoteCredential()
          : assertRemoteCredential(tokenRaw, "Bridge host --token"),
      legacyToken:
        options.legacyToken === undefined
          ? undefined
          : assertRemoteCredential(options.legacyToken, "Bridge host --legacy-token"),
    };
  }
  if (credentials.legacyToken && credentials.legacyToken === credentials.token) {
    throw new Error(
      "Legacy text clients require a bearer credential distinct from the modern v3 HMAC root key.",
    );
  }

  const writeConnectionPath =
    options.writeConnection?.trim() || path.join(getOracleHomeDir(), "bridge-connection.json");
  const sshTarget = options.ssh?.trim();
  const sshRemotePort =
    typeof options.sshRemotePort === "number" ? options.sshRemotePort : bindPort;
  if (sshRemotePort <= 0 || sshRemotePort > 65_535) {
    throw new Error(`Invalid --ssh-remote-port: ${sshRemotePort}. Expected 1-65535.`);
  }

  const connectionInput: Pick<BridgeConnectionArtifact, "remoteHost" | "remoteToken" | "tunnel"> = {
    remoteHost: sshTarget
      ? normalizeHostPort("127.0.0.1", sshRemotePort)
      : normalizeHostPort(bindHost, bindPort),
    remoteToken: credentials.token,
    tunnel: sshTarget
      ? {
          ssh: sshTarget,
          remotePort: sshRemotePort,
          localPort: bindPort,
          identity: options.sshIdentity?.trim() || undefined,
          extraArgs: options.sshExtraArgs?.trim() || undefined,
        }
      : undefined,
  };

  if (options.background) {
    const spawnChild: BridgeHostSpawn =
      deps.spawn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    const result = await spawnBridgeHostInBackground(
      {
        bind: bindRaw,
        credentials,
        connectionInput,
        writeConnectionPath,
        sshTarget,
        sshRemotePort,
        sshIdentity: options.sshIdentity?.trim(),
        sshExtraArgs: options.sshExtraArgs?.trim(),
      },
      {
        spawnChild,
        parentEnv: deps.env ?? process.env,
        readinessNonce: (deps.generateReadinessNonce ?? randomUUID)(),
        readinessTimeoutMs: deps.readinessTimeoutMs ?? BRIDGE_HOST_READINESS_TIMEOUT_MS,
      },
    );
    console.log(chalk.green(`Bridge host running in background (pid ${result.pid})`));
    console.log(chalk.dim(`- Log: ${result.logPath}`));
    console.log(chalk.dim(`- PID: ${result.pidPath}`));
    printRequestedConnection(options, result.artifact, credentials.token);
    return;
  }

  const startTunnel = deps.startReverseTunnel ?? startReverseTunnel;
  const runRemoteService = deps.serveRemote ?? serveRemote;
  const readinessOutput = options.backgroundChild
    ? (deps.readinessOutput ?? createWriteStream("", { fd: 3, autoClose: true }))
    : undefined;
  const tunnelHandle: { current: ReverseTunnelHandle | null } = { current: null };
  let ready = false;
  try {
    await runRemoteService(
      {
        host: bindHost,
        port: bindPort,
        token: credentials.token,
        legacyToken: credentials.legacyToken,
        logger: console.log,
      },
      {
        onReady: async (server) => {
          if (server.port !== bindPort || server.token !== credentials.token) {
            throw new Error(
              "Bridge host remote service readiness did not match the requested bind.",
            );
          }
          if (sshTarget) {
            tunnelHandle.current = await startTunnel({
              sshTarget,
              remotePort: sshRemotePort,
              localPort: bindPort,
              identity: options.sshIdentity?.trim() || undefined,
              extraArgs: options.sshExtraArgs?.trim() || undefined,
              log: (message) => console.log(chalk.dim(message)),
            });
            await tunnelHandle.current.ready;
          }

          if (options.backgroundChild) {
            await writeBridgeHostReadinessPayload(readinessOutput!, {
              readinessNonce: childReadinessNonce!,
              status: "ready",
            });
          } else {
            const artifactSnapshot = await captureFileSnapshot(writeConnectionPath);
            let artifactPublished = false;
            try {
              const artifact = await upsertConnectionArtifact(writeConnectionPath, connectionInput);
              artifactPublished = true;
              printForegroundReady({
                options,
                artifact,
                writeConnectionPath,
                bindHost,
                bindPort,
                sshTarget,
                sshRemotePort,
                legacyToken: credentials.legacyToken,
                token: credentials.token,
              });
            } catch (error) {
              if (!artifactPublished) throw error;
              await rethrowAfterRestoring(error, [
                { filePath: writeConnectionPath, snapshot: artifactSnapshot },
              ]);
            }
          }
          ready = true;
        },
      },
    );
    if (!ready) {
      throw new Error("Bridge host did not start: remote service exited before readiness.");
    }
  } catch (error) {
    if (options.backgroundChild && !ready && childReadinessNonce && readinessOutput) {
      await writeBridgeHostReadinessPayload(readinessOutput, {
        readinessNonce: childReadinessNonce,
        status: "failed",
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    await tunnelHandle.current?.stop();
  }
}

function printRequestedConnection(
  options: BridgeHostCliOptions,
  artifact: BridgeConnectionArtifact,
  token: string,
): void {
  if (options.printToken) console.log(token);
  if (options.print) {
    console.log(
      formatBridgeConnectionString(
        { remoteHost: artifact.remoteHost, remoteToken: token },
        { includeToken: true },
      ),
    );
  }
}

function printForegroundReady(params: {
  options: BridgeHostCliOptions;
  artifact: BridgeConnectionArtifact;
  writeConnectionPath: string;
  bindHost: string;
  bindPort: number;
  sshTarget?: string;
  sshRemotePort: number;
  legacyToken?: string;
  token: string;
}): void {
  console.log(chalk.cyanBright("Bridge host started."));
  console.log(chalk.dim(`- Local bind: ${normalizeHostPort(params.bindHost, params.bindPort)}`));
  console.log(chalk.dim(`- Connection artifact: ${params.writeConnectionPath}`));
  console.log(chalk.dim(`- Client remoteHost: ${params.artifact.remoteHost}`));
  console.log(
    chalk.dim(
      "Token stored in connection artifact (not printed). Use --print or --print-token if needed.",
    ),
  );
  if (params.legacyToken) {
    console.log(chalk.dim("- Predecessor text compatibility: enabled with a distinct bearer"));
  }
  if (params.sshTarget) {
    console.log(
      chalk.dim(
        `Reverse SSH tunnel active (remote 127.0.0.1:${params.sshRemotePort} -> local 127.0.0.1:${params.bindPort})`,
      ),
    );
  }
  printRequestedConnection(params.options, params.artifact, params.token);
}

async function upsertConnectionArtifact(
  filePath: string,
  input: Pick<BridgeConnectionArtifact, "remoteHost" | "remoteToken" | "tunnel">,
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
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(artifact, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  }
  return artifact;
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

async function readBridgeHostCredentialPayload(
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

async function writeBridgeHostReadinessPayload(
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

interface FileSnapshot {
  contents: Buffer | null;
}

async function captureFileSnapshot(filePath: string): Promise<FileSnapshot> {
  try {
    return { contents: await fs.readFile(filePath) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { contents: null };
    throw error;
  }
}

async function writePrivateFileAtomic(filePath: string, contents: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(tempPath, contents, { mode: 0o600 });
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  }
}

async function restoreFileSnapshot(filePath: string, snapshot: FileSnapshot): Promise<void> {
  if (snapshot.contents === null) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await writePrivateFileAtomic(filePath, snapshot.contents);
}

async function rethrowAfterRestoring(
  error: unknown,
  entries: Array<{ filePath: string; snapshot: FileSnapshot }>,
): Promise<never> {
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
      [error, ...restorationErrors],
      "Bridge host startup failed and prior published state could not be fully restored.",
    );
  }
  throw error;
}

function startReverseTunnel({
  sshTarget,
  remotePort,
  localPort,
  identity,
  extraArgs,
  log,
}: {
  sshTarget: string;
  remotePort: number;
  localPort: number;
  identity?: string;
  extraArgs?: string;
  log: (message: string) => void;
}): ReverseTunnelHandle {
  const initialReady = Promise.withResolvers<void>();
  let stopped = false;
  let becameReady = false;
  let master: ChildProcess | null = null;
  let controlChild: ChildProcess | null = null;
  let controlDir: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let attempt = 0;

  const cleanupControlDir = async (): Promise<void> => {
    const current = controlDir;
    controlDir = null;
    if (current) await fs.rm(current, { recursive: true, force: true }).catch(() => undefined);
  };
  const stopProcesses = (): void => {
    controlChild?.kill();
    controlChild = null;
    master?.kill();
    master = null;
  };
  const scheduleRestart = (): void => {
    if (stopped) return;
    const delayMs = Math.min(30_000, 1_000 * 2 ** attempt);
    attempt += 1;
    log(`[bridge host] ssh tunnel exited; restarting in ${delayMs}ms`);
    timer = setTimeout(() => void spawnOnce(), delayMs);
    timer.unref?.();
  };
  const runControlCommand = (args: string[]): Promise<number> => {
    const result = Promise.withResolvers<number>();
    let settled = false;
    let timeout: NodeJS.Timeout;
    const child = spawn("ssh", args, { stdio: "ignore", windowsHide: true });
    controlChild = child;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      if (controlChild === child) controlChild = null;
      clearTimeout(timeout);
      result.resolve(code);
    };
    timeout = setTimeout(() => {
      child.kill();
      settle(255);
    }, 2_000);
    child.once("error", () => settle(255));
    child.once("exit", (code) => settle(code ?? 255));
    return result.promise;
  };

  const spawnOnce = async (): Promise<void> => {
    if (stopped) return;
    try {
      controlDir = await fs.mkdtemp(path.join(os.tmpdir(), "o-ssh-"));
      if (process.platform !== "win32") await fs.chmod(controlDir, 0o700);
      if (stopped) {
        await cleanupControlDir();
        return;
      }
      const controlPath = path.join(controlDir, "ctl");
      const masterArgs = [
        "-M",
        "-S",
        controlPath,
        "-N",
        "-o",
        "ControlMaster=yes",
        "-o",
        "ControlPersist=no",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
      ];
      if (identity) masterArgs.push("-i", identity);
      if (extraArgs) masterArgs.push(...splitArgs(extraArgs));
      masterArgs.push(sshTarget);

      master = spawn("ssh", masterArgs, { stdio: "ignore", windowsHide: true });
      const currentMaster = master;
      const masterClosed = Promise.withResolvers<void>();
      currentMaster.once("error", () => masterClosed.resolve());
      currentMaster.once("exit", () => masterClosed.resolve());

      const deadline = Date.now() + BRIDGE_HOST_READINESS_TIMEOUT_MS;
      let controlReady = false;
      while (!stopped && Date.now() < deadline) {
        const result = await Promise.race([
          runControlCommand(["-S", controlPath, "-O", "check", sshTarget]).then((code) => ({
            type: "control" as const,
            code,
          })),
          masterClosed.promise.then(() => ({ type: "master-closed" as const })),
        ]);
        if (result.type === "master-closed") {
          throw new Error("Reverse SSH tunnel master exited before readiness.");
        }
        if (result.code === 0) {
          controlReady = true;
          break;
        }
        const delayed = Promise.withResolvers<void>();
        setTimeout(delayed.resolve, 100);
        await delayed.promise;
      }
      if (!controlReady || stopped) {
        throw new Error("Reverse SSH tunnel control socket did not become ready.");
      }

      const forwardResult = await Promise.race([
        runControlCommand([
          "-S",
          controlPath,
          "-o",
          "ExitOnForwardFailure=yes",
          "-O",
          "forward",
          "-R",
          `${remotePort}:127.0.0.1:${localPort}`,
          sshTarget,
        ]).then((code) => ({ type: "forward" as const, code })),
        masterClosed.promise.then(() => ({ type: "master-closed" as const })),
      ]);
      if (
        forwardResult.type !== "forward" ||
        forwardResult.code !== 0 ||
        stopped ||
        currentMaster.exitCode !== null ||
        currentMaster.signalCode !== null
      ) {
        throw new Error("Reverse SSH tunnel forwarding request failed.");
      }

      attempt = 0;
      log(
        `[bridge host] ssh reverse tunnel ready${currentMaster.pid ? ` (pid ${currentMaster.pid})` : ""}: ${sshTarget}`,
      );
      if (!becameReady) {
        becameReady = true;
        initialReady.resolve();
      }
      await masterClosed.promise;
      if (master === currentMaster) master = null;
      await cleanupControlDir();
      scheduleRestart();
    } catch {
      stopProcesses();
      await cleanupControlDir();
      if (!becameReady) {
        initialReady.reject(
          new Error("Reverse SSH tunnel failed before the remote forward was ready."),
        );
        return;
      }
      if (!stopped) scheduleRestart();
    }
  };

  void spawnOnce();
  return {
    ready: initialReady.promise,
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!becameReady) {
        initialReady.reject(new Error("Reverse SSH tunnel stopped before readiness."));
      }
      stopProcesses();
      await cleanupControlDir();
    },
  };
}

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  const push = () => {
    const trimmed = current.trim();
    if (trimmed.length) args.push(trimmed);
    current = "";
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] ?? "";
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return args;
}

async function spawnBridgeHostInBackground(
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
    connectionInput: Pick<BridgeConnectionArtifact, "remoteHost" | "remoteToken" | "tunnel">;
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
  },
): Promise<BridgeHostSpawnResult> {
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
  if (
    [process.execPath, ...args].some((value) =>
      protectedValues.some((protectedValue) => value.includes(protectedValue)),
    )
  ) {
    throw new Error("Bridge host background options contain protected IPC material.");
  }

  const logHandle = await fs.open(logPath, "a");
  let child: ChildProcess | undefined;
  try {
    child = deps.spawnChild(process.execPath, args, {
      detached: true,
      stdio: ["pipe", logHandle.fd, logHandle.fd, "pipe"],
      env: buildBridgeHostBackgroundEnvironment(deps.parentEnv, payload),
      windowsHide: true,
    });
    const readinessInput = child.stdio[3] as UnrefReadable | null | undefined;
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
    let childExited = false;
    const markChildExited = () => {
      childExited = true;
    };
    const assertChildRunning = () => {
      if (childExited || child!.exitCode !== null || child!.signalCode !== null) {
        throw new Error("Bridge host background child exited during state publication.");
      }
    };
    child.once("error", markChildExited);
    child.once("exit", markChildExited);
    try {
      assertChildRunning();
      await writePrivateFileAtomic(pidPath, `${childPid}\n`);
      assertChildRunning();
      const artifact = await upsertConnectionArtifact(writeConnectionPath, connectionInput);
      assertChildRunning();
      return { artifact, logPath, pidPath, pid: childPid };
    } catch (error) {
      return rethrowAfterRestoring(error, [
        { filePath: writeConnectionPath, snapshot: artifactSnapshot },
        { filePath: pidPath, snapshot: pidSnapshot },
      ]);
    } finally {
      child.off("error", markChildExited);
      child.off("exit", markChildExited);
    }
  } catch (error) {
    child?.kill();
    throw error;
  } finally {
    await logHandle.close().catch(() => undefined);
  }
}
