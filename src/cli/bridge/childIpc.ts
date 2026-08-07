import type { ChildProcess } from "node:child_process";
import { TextDecoder } from "node:util";
import { assertRemoteCredential } from "../../remote/auth.js";

export const BRIDGE_HOST_CREDENTIAL_PAYLOAD_MAX_BYTES = 512;
export const BRIDGE_HOST_READINESS_PAYLOAD_MAX_BYTES = 256;
export const BRIDGE_HOST_READINESS_TIMEOUT_MS = 30_000;
const BRIDGE_HOST_BACKGROUND_SHUTDOWN_TIMEOUT_MS = 5_000;
const BRIDGE_HOST_IPC_VERSION = 1;
const BRIDGE_HOST_READINESS_NONCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface BridgeHostCredentials {
  token: string;
  legacyToken?: string;
}

export interface BridgeHostCredentialPayload extends BridgeHostCredentials {
  readinessNonce: string;
}

export interface BridgeHostReadinessPayload {
  readinessNonce: string;
  status: "ready" | "failed";
}

export type UnrefWritable = NonNullable<ChildProcess["stdin"]> & {
  unref?: () => void;
};

export type UnrefReadable = NodeJS.ReadableStream & {
  destroy?: () => void;
  unref?: () => void;
};

async function readOneShotBridgeHostLine(
  stream: NodeJS.ReadableStream,
  label: string,
  maxBytes: number,
  completeAtNewline = false,
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
    if (completeAtNewline) {
      const newlineIndex = bytes.indexOf(0x0a);
      if (newlineIndex < 0) continue;
      if (newlineIndex !== bytes.byteLength - 1) {
        throw new Error(`${label} contains extra bytes.`);
      }
      return Buffer.concat(chunks, totalBytes);
    }
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

export function assertReadinessNonce(value: unknown, label: string): string {
  if (typeof value !== "string" || !BRIDGE_HOST_READINESS_NONCE_PATTERN.test(value)) {
    throw new Error(`${label} is malformed.`);
  }
  return value;
}

export function encodeBridgeHostCredentialPayload(payload: BridgeHostCredentialPayload): Buffer {
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
    true,
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

export async function writeOneShotBridgeHostLine(
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

export function buildBridgeHostBackgroundEnvironment(
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

export async function waitForBridgeHostReadiness(params: {
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

export function bridgeHostChildExited(child: ChildProcess): boolean {
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

export async function terminateBridgeHostChildTree(
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
