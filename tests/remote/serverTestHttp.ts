import http from "node:http";
import {
  REMOTE_REQUEST_PROOF_HEADER,
  createRemoteAuthenticatedRequest,
  verifyRemoteRequestProof,
  type RemoteAuthenticatedRequest,
} from "../../src/remote/auth.js";
import { checkRemoteHealth } from "../../src/remote/health.js";
export async function prepareTestAuthentication({
  hostname,
  port,
  path,
  token,
  method,
  body,
}: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  method: string;
  body: Buffer;
}): Promise<{ rootKey: string; authentication: RemoteAuthenticatedRequest } | null> {
  const rootKey = token?.trim();
  if (!rootKey) return null;
  const host = hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`;
  const health = await checkRemoteHealth({ host, token: rootKey });
  if (!health.ok || health.protocol !== "transaction-v3" || !health.serverGeneration) {
    throw new Error(`test remote generation proof failed: ${health.error ?? "unavailable"}`);
  }
  return {
    rootKey,
    authentication: createRemoteAuthenticatedRequest({
      rootKey,
      serverGeneration: health.serverGeneration,
      method,
      path,
      body,
      issuedAt: Date.now(),
    }),
  };
}

export function sendTestRequestBody({
  req,
  authentication,
  method,
  path,
  body,
}: {
  req: http.ClientRequest;
  authentication: { rootKey: string; authentication: RemoteAuthenticatedRequest } | null;
  method: string;
  path: string;
  body: Buffer;
}): void {
  if (!authentication) {
    req.end(body);
    return;
  }
  let proofVerified = false;
  let continueReceived = false;
  let bodySent = false;
  const send = () => {
    if (bodySent || !proofVerified || !continueReceived) return;
    bodySent = true;
    req.end(body);
  };
  req.on("information", (information) => {
    if (information.statusCode !== 103) return;
    const proof = String(information.headers[REMOTE_REQUEST_PROOF_HEADER] ?? "");
    if (
      !verifyRemoteRequestProof({
        rootKey: authentication.rootKey,
        method,
        path,
        authentication: authentication.authentication,
        proof,
      })
    ) {
      req.destroy(new Error("test remote returned an invalid request proof"));
      return;
    }
    proofVerified = true;
    send();
  });
  req.on("continue", () => {
    continueReceived = true;
    send();
  });
  req.flushHeaders();
}

export async function httpGetJson({
  hostname,
  port,
  path,
  token,
  headers,
}: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  headers?: Record<string, string>;
}): Promise<{ statusCode: number; json: Record<string, unknown> | null }> {
  if (path === "/health" && token?.trim()) {
    const host = hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`;
    const health = await checkRemoteHealth({ host, token });
    return {
      statusCode: health.statusCode ?? 0,
      json: {
        ok: health.ok,
        ...(health.version ? { version: health.version } : {}),
        ...(health.uptimeSeconds !== undefined ? { uptimeSeconds: health.uptimeSeconds } : {}),
        ...(health.capabilities ? { capabilities: health.capabilities } : {}),
        ...(health.error ? { error: health.error } : {}),
      },
    };
  }
  const authentication = await prepareTestAuthentication({
    hostname,
    port,
    path,
    token,
    method: "GET",
    body: Buffer.alloc(0),
  });
  const deferred = Promise.withResolvers<{
    statusCode: number;
    json: Record<string, unknown> | null;
  }>();
  const req = http.request(
    {
      hostname,
      port,
      path,
      method: "GET",
      headers: {
        ...(headers ?? {}),
        ...(authentication ? authentication.authentication.headers : {}),
      },
    },
    (res) => {
      readIncomingBody(res)
        .then((body) => {
          const statusCode = res.statusCode ?? 0;
          let json: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = body.length ? JSON.parse(body) : null;
            json =
              parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          deferred.resolve({ statusCode, json });
        })
        .catch(deferred.reject);
    },
  );
  req.on("error", deferred.reject);
  req.end();
  return await deferred.promise;
}

export async function httpPostJson({
  hostname,
  port,
  path,
  token,
  body,
  headers,
}: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  body: unknown;
  headers?: Record<string, string>;
}): Promise<{ statusCode: number; json: Record<string, unknown> | null }> {
  const serialized = Buffer.from(JSON.stringify(body));
  const authentication = await prepareTestAuthentication({
    hostname,
    port,
    path,
    token,
    method: "POST",
    body: serialized,
  });
  const deferred = Promise.withResolvers<{
    statusCode: number;
    json: Record<string, unknown> | null;
  }>();
  const req = http.request(
    {
      hostname,
      port,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": serialized.byteLength,
        ...(headers ?? {}),
        ...(authentication
          ? { Expect: "100-continue", ...authentication.authentication.headers }
          : {}),
      },
    },
    (res) => {
      readIncomingBody(res)
        .then((responseBody) => {
          let json: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = responseBody ? JSON.parse(responseBody) : null;
            json =
              parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          deferred.resolve({ statusCode: res.statusCode ?? 0, json });
        })
        .catch(deferred.reject);
    },
  );
  req.on("error", deferred.reject);
  sendTestRequestBody({ req, authentication, method: "POST", path, body: serialized });
  return await deferred.promise;
}
export async function httpRaw({
  hostname,
  port,
  path,
  method,
  body,
  headers,
}: {
  hostname: string;
  port: number;
  path: string;
  method: "GET" | "POST";
  body: Buffer;
  headers: Record<string, string>;
}): Promise<{ statusCode: number; body: string }> {
  const deferred = Promise.withResolvers<{ statusCode: number; body: string }>();
  const req = http.request(
    {
      hostname,
      port,
      path,
      method,
      headers: { "Content-Length": body.byteLength, ...headers },
    },
    (res) => {
      readIncomingBody(res)
        .then((responseBody) =>
          deferred.resolve({ statusCode: res.statusCode ?? 0, body: responseBody }),
        )
        .catch(deferred.reject);
    },
  );
  req.on("error", deferred.reject);
  req.end(body);
  return await deferred.promise;
}

export async function httpPostNdjson({
  hostname,
  port,
  path,
  token,
  body,
}: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  body: unknown;
}): Promise<{ statusCode: number; events: Array<Record<string, unknown>> }> {
  const serialized = Buffer.from(JSON.stringify(body));
  const authentication = await prepareTestAuthentication({
    hostname,
    port,
    path,
    token,
    method: "POST",
    body: serialized,
  });
  const deferred = Promise.withResolvers<{
    statusCode: number;
    events: Array<Record<string, unknown>>;
  }>();
  const req = http.request(
    {
      hostname,
      port,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": serialized.byteLength,
        ...(authentication
          ? { Expect: "100-continue", ...authentication.authentication.headers }
          : {}),
      },
    },
    (res) => {
      readIncomingBody(res)
        .then((responseBody) => {
          const events = responseBody
            .split(/\r?\n/u)
            .filter(Boolean)
            .map((line) => {
              const parsed: unknown = JSON.parse(line);
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("Remote NDJSON event is not an object");
              }
              return parsed as Record<string, unknown>;
            });
          deferred.resolve({ statusCode: res.statusCode ?? 0, events });
        })
        .catch(deferred.reject);
    },
  );
  req.on("error", deferred.reject);
  sendTestRequestBody({ req, authentication, method: "POST", path, body: serialized });
  return await deferred.promise;
}

export async function postJsonAndDisconnect({
  hostname,
  port,
  path,
  token,
  body,
}: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  body: unknown;
}): Promise<void> {
  const serialized = Buffer.from(JSON.stringify(body));
  const authentication = await prepareTestAuthentication({
    hostname,
    port,
    path,
    token,
    method: "POST",
    body: serialized,
  });
  const deferred = Promise.withResolvers<void>();
  const req = http.request(
    {
      hostname,
      port,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": serialized.byteLength,
        ...(authentication
          ? { Expect: "100-continue", ...authentication.authentication.headers }
          : {}),
      },
    },
    (res) => {
      res.destroy();
      deferred.resolve();
    },
  );
  req.on("error", deferred.reject);
  sendTestRequestBody({ req, authentication, method: "POST", path, body: serialized });
  await deferred.promise;
}
export async function readIncomingBody(
  stream: NodeJS.ReadableStream & AsyncIterable<Buffer | string>,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
