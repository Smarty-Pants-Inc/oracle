import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import {
  REMOTE_HEALTH_CLIENT_NONCE_HEADER,
  REMOTE_PROTOCOL_HEADER,
  assertRemoteCredential,
  verifyRemoteHealthAuthenticationProof,
} from "./auth.js";
import { RemoteLegacyHealthResponseSchema } from "./legacyProtocol.js";
import {
  DEFAULT_REMOTE_SOCKET_IDLE_TIMEOUT_MS,
  MAX_REMOTE_ARTIFACT_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  RemoteHealthResponseSchema,
  type RemoteArtifactCapabilities,
} from "./types.js";
import { parsePlaintextRemoteEndpoint } from "./remoteServiceConfig.js";

export interface RemoteHealthResult {
  ok: boolean;
  protocol?: "transaction-v3" | "legacy-text-v1";
  statusCode?: number;
  error?: string;
  version?: string;
  uptimeSeconds?: number;
  serverGeneration?: string;
  capabilities?: RemoteArtifactCapabilities;
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
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; error?: string }>();
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
  legacyToken,
  allowLegacyTextProtocol = false,
  timeoutMs = 5000,
  idleTimeoutMs = Math.min(timeoutMs, DEFAULT_REMOTE_SOCKET_IDLE_TIMEOUT_MS),
}: {
  host: string;
  token?: string;
  legacyToken?: string;
  allowLegacyTextProtocol?: boolean;
  timeoutMs?: number;
  idleTimeoutMs?: number;
}): Promise<RemoteHealthResult> {
  let endpoint: { hostname: string; port: number };
  try {
    endpoint = parsePlaintextRemoteEndpoint(host);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    if (token !== undefined) assertRemoteCredential(token, "Remote v3 HMAC root key");
    if (legacyToken !== undefined) {
      assertRemoteCredential(legacyToken, "Remote legacy bearer credential");
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (allowLegacyTextProtocol && token && legacyToken && token === legacyToken) {
    return {
      ok: false,
      error:
        "Legacy text protocol requires a bearer credential distinct from the v3 HMAC root key.",
    };
  }

  try {
    if (token) {
      const clientNonce = randomBytes(32).toString("hex");
      const current = await requestJson({
        ...endpoint,
        path: "/health",
        headers: {
          accept: "application/json",
          [REMOTE_PROTOCOL_HEADER]: String(REMOTE_TRANSACTION_PROTOCOL_VERSION),
          [REMOTE_HEALTH_CLIENT_NONCE_HEADER]: clientNonce,
        },
        overallTimeoutMs: timeoutMs,
        idleTimeoutMs,
      });
      if (current.statusCode === 200) {
        const parsed = RemoteHealthResponseSchema.safeParse(current.json);
        if (!parsed.success) {
          return {
            ok: false,
            statusCode: current.statusCode,
            error: `invalid remote health protocol: ${parsed.error.issues[0]?.message ?? "unknown schema error"}`,
          };
        }
        if (
          !verifyRemoteHealthAuthenticationProof(token, clientNonce, parsed.data.authentication)
        ) {
          return {
            ok: false,
            statusCode: current.statusCode,
            error: "remote health generation proof was invalid",
          };
        }
        return {
          ok: true,
          protocol: "transaction-v3",
          statusCode: current.statusCode,
          version: parsed.data.version,
          uptimeSeconds: parsed.data.uptimeSeconds,
          serverGeneration: parsed.data.authentication.serverGeneration,
          capabilities: {
            ...parsed.data.capabilities,
            maxArtifactBytes: Math.min(
              parsed.data.capabilities.maxArtifactBytes,
              MAX_REMOTE_ARTIFACT_BYTES,
            ),
          },
        };
      }
      if (!allowLegacyTextProtocol) {
        const error =
          extractErrorMessage(current.json, current.bodyText) ?? `HTTP ${current.statusCode}`;
        return { ok: false, statusCode: current.statusCode, error };
      }
    } else if (!allowLegacyTextProtocol) {
      return { ok: false, error: "Remote transaction HMAC root key is missing." };
    }

    if (!allowLegacyTextProtocol) {
      return { ok: false, error: "Legacy text protocol is disabled." };
    }
    if (!legacyToken) {
      return {
        ok: false,
        error: "Legacy text protocol requires a distinct scoped legacy bearer credential.",
      };
    }
    const legacy = await requestJson({
      ...endpoint,
      path: "/health",
      headers: { accept: "application/json", authorization: `Bearer ${legacyToken}` },
      overallTimeoutMs: timeoutMs,
      idleTimeoutMs,
    });
    if (legacy.statusCode !== 200) {
      const error =
        extractErrorMessage(legacy.json, legacy.bodyText) ?? `HTTP ${legacy.statusCode}`;
      return { ok: false, statusCode: legacy.statusCode, error };
    }
    const parsed = RemoteLegacyHealthResponseSchema.safeParse(legacy.json);
    if (!parsed.success) {
      return {
        ok: false,
        statusCode: legacy.statusCode,
        error: `invalid legacy remote health protocol: ${parsed.error.issues[0]?.message ?? "unknown schema error"}`,
      };
    }
    return {
      ok: true,
      protocol: "legacy-text-v1",
      statusCode: legacy.statusCode,
      version: parsed.data.version,
      uptimeSeconds: parsed.data.uptimeSeconds,
    };
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
  const { promise, resolve, reject } = Promise.withResolvers<{
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
