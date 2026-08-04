import http from "node:http";
import net from "node:net";
import {
  DEFAULT_REMOTE_SOCKET_IDLE_TIMEOUT_MS,
  MAX_REMOTE_ARTIFACT_BYTES,
  RemoteHealthResponseSchema,
  type RemoteArtifactCapabilities,
} from "./types.js";
import { parsePlaintextRemoteEndpoint } from "./remoteServiceConfig.js";

export interface RemoteHealthResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
  version?: string;
  uptimeSeconds?: number;
  capabilities?: RemoteArtifactCapabilities;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export async function checkTcpConnection(
  host: string,
  timeoutMs = 2000,
): Promise<{ ok: boolean; error?: string }> {
  let endpoint: { hostname: string; port: number };
  try {
    endpoint = parsePlaintextRemoteEndpoint(host);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const { promise, resolve } = createDeferred<{ ok: boolean; error?: string }>();
  const socket = net.createConnection({ host: endpoint.hostname, port: endpoint.port });
  const onError = (err: Error) => {
    cleanup();
    resolve({ ok: false, error: err.message });
  };
  const onConnect = () => {
    cleanup();
    resolve({ ok: true });
  };
  const onTimeout = () => {
    cleanup();
    resolve({ ok: false, error: `timeout after ${timeoutMs}ms` });
  };
  const cleanup = () => {
    socket.removeAllListeners();
    socket.end();
    socket.destroy();
    socket.unref();
  };
  socket.setTimeout(timeoutMs);
  socket.once("error", onError);
  socket.once("connect", onConnect);
  socket.once("timeout", onTimeout);
  return await promise;
}

export async function checkRemoteHealth({
  host,
  token,
  timeoutMs = 5000,
  idleTimeoutMs = Math.min(timeoutMs, DEFAULT_REMOTE_SOCKET_IDLE_TIMEOUT_MS),
}: {
  host: string;
  token?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
}): Promise<RemoteHealthResult> {
  let endpoint: { hostname: string; port: number };
  try {
    endpoint = parsePlaintextRemoteEndpoint(host);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const response = await requestJson({
      ...endpoint,
      path: "/health",
      headers,
      overallTimeoutMs: timeoutMs,
      idleTimeoutMs,
    });
    if (response.statusCode === 200) {
      const parsed = RemoteHealthResponseSchema.safeParse(response.json);
      if (!parsed.success) {
        return {
          ok: false,
          statusCode: response.statusCode,
          error: `invalid remote health protocol: ${parsed.error.issues[0]?.message ?? "unknown schema error"}`,
        };
      }
      return {
        ok: true,
        statusCode: response.statusCode,
        version: parsed.data.version,
        uptimeSeconds: parsed.data.uptimeSeconds,
        capabilities: {
          ...parsed.data.capabilities,
          maxArtifactBytes: Math.min(
            parsed.data.capabilities.maxArtifactBytes,
            MAX_REMOTE_ARTIFACT_BYTES,
          ),
        },
      };
    }
    if (response.statusCode === 404) {
      return {
        ok: false,
        statusCode: response.statusCode,
        error: "remote host does not expose /health (upgrade oracle on the host and retry)",
      };
    }
    const error =
      extractErrorMessage(response.json, response.bodyText) ?? `HTTP ${response.statusCode}`;
    return { ok: false, statusCode: response.statusCode, error };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function extractErrorMessage(json: unknown, bodyText: string): string | null {
  if (json && typeof json === "object" && "error" in json && typeof json.error === "string") {
    if (json.error.trim().length > 0) return json.error.trim();
  }
  const trimmed = bodyText.trim();
  return trimmed.length ? trimmed : null;
}

async function requestJson({
  hostname,
  port,
  path,
  headers,
  overallTimeoutMs,
  idleTimeoutMs,
}: {
  hostname: string;
  port: number;
  path: string;
  headers: Record<string, string>;
  overallTimeoutMs: number;
  idleTimeoutMs: number;
}): Promise<{ statusCode: number; json: unknown; bodyText: string }> {
  const { promise, resolve, reject } = createDeferred<{
    statusCode: number;
    json: unknown;
    bodyText: string;
  }>();
  let settled = false;
  let overallTimer: NodeJS.Timeout | null = null;
  const finish = (
    outcome:
      | { response: { statusCode: number; json: unknown; bodyText: string } }
      | { error: Error },
  ) => {
    if (settled) return;
    settled = true;
    if (overallTimer) clearTimeout(overallTimer);
    if ("error" in outcome) reject(outcome.error);
    else resolve(outcome.response);
  };
  const req = http.request({ hostname, port, path, method: "GET", headers }, (res) => {
    res.setTimeout(idleTimeoutMs, () => {
      res.destroy(new Error(`health request exceeded ${idleTimeoutMs}ms idle timeout`));
    });
    res.setEncoding("utf8");
    let body = "";
    res.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > 1024 * 1024) {
        res.destroy(new Error("health response exceeded size limit"));
      }
    });
    res.on("end", () => {
      let json: unknown = null;
      try {
        json = body.length ? JSON.parse(body) : null;
      } catch {
        json = null;
      }
      finish({ response: { statusCode: res.statusCode ?? 0, json, bodyText: body } });
    });
    res.on("error", (error) => finish({ error }));
  });
  overallTimer = setTimeout(() => {
    req.destroy(new Error(`health request exceeded ${overallTimeoutMs}ms overall timeout`));
  }, overallTimeoutMs);
  overallTimer.unref();
  req.setTimeout(idleTimeoutMs, () => {
    req.destroy(new Error(`health request exceeded ${idleTimeoutMs}ms idle timeout`));
  });
  req.on("error", (error) => finish({ error }));
  req.end();
  return await promise;
}
