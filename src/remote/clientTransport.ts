import http from "node:http";
import {
  REMOTE_REQUEST_PROOF_HEADER,
  assertRemoteCredential,
  createRemoteAuthenticatedRequest,
  verifyRemoteRequestProof,
  type RemoteAuthenticatedRequest,
} from "./auth.js";
import { checkRemoteHealth } from "./health.js";
import type { BrowserRunOptions } from "../browserMode.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  DEFAULT_REMOTE_ARTIFACT_OVERALL_TIMEOUT_MS,
  DEFAULT_REMOTE_CONTROL_OVERALL_TIMEOUT_MS,
  DEFAULT_REMOTE_RUN_OVERALL_TIMEOUT_MS,
  DEFAULT_REMOTE_SOCKET_IDLE_TIMEOUT_MS,
  MAX_REMOTE_EVENT_BYTES,
  MAX_REMOTE_REQUEST_BYTES,
  RemoteRunEventSchema,
  RemoteRunPayloadSchema,
  type RemoteBrowserAutomationErrorPayload,
  type RemoteRunEvent,
  type RemoteRunPayload,
  type RemoteRunTransactionPayload,
  type RemoteTransportDeadlines,
} from "./types.js";
import {
  RemoteLegacyRunEventSchema,
  RemoteLegacyRunPayloadSchema,
  type RemoteLegacyRunPayload,
  type RemoteLegacyTextResult,
} from "./legacyProtocol.js";
import { parsePlaintextRemoteEndpoint } from "./remoteServiceConfig.js";

export interface ResolvedRemoteTransportDeadlines {
  runOverallTimeoutMs: number;
  controlOverallTimeoutMs: number;
  artifactOverallTimeoutMs: number;
  socketIdleTimeoutMs: number;
  recoveryWindowMs: number;
}

interface RequestDeadlineGuard {
  clear: () => void;
  resetIdle: () => void;
  watchResponse: (res: http.IncomingMessage) => void;
}

export class RemoteTransportInterruption extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RemoteTransportInterruption";
  }
}

export interface RemoteJsonResponse {
  statusCode: number;
  json: unknown;
  errorMessage: string;
}

export function resolveRemoteTransportDeadlines(
  configured: RemoteTransportDeadlines | undefined,
  browserTimeoutMs?: number,
): ResolvedRemoteTransportDeadlines {
  const readDeadline = (value: number | undefined, fallback: number, label: string): number => {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
      throw new BrowserAutomationError(`${label} must be a positive integer.`, {
        stage: "remote-connection",
      });
    }
    return resolved;
  };
  return {
    runOverallTimeoutMs: readDeadline(
      configured?.runOverallTimeoutMs,
      Math.max(DEFAULT_REMOTE_RUN_OVERALL_TIMEOUT_MS, (browserTimeoutMs ?? 0) + 120_000),
      "Remote run overall timeout",
    ),
    controlOverallTimeoutMs: readDeadline(
      configured?.controlOverallTimeoutMs,
      DEFAULT_REMOTE_CONTROL_OVERALL_TIMEOUT_MS,
      "Remote control overall timeout",
    ),
    artifactOverallTimeoutMs: readDeadline(
      configured?.artifactOverallTimeoutMs,
      DEFAULT_REMOTE_ARTIFACT_OVERALL_TIMEOUT_MS,
      "Remote artifact overall timeout",
    ),
    socketIdleTimeoutMs: readDeadline(
      configured?.socketIdleTimeoutMs,
      DEFAULT_REMOTE_SOCKET_IDLE_TIMEOUT_MS,
      "Remote socket idle timeout",
    ),
    recoveryWindowMs: readDeadline(configured?.recoveryWindowMs, 30_000, "Remote recovery window"),
  };
}

function attachRequestDeadlines(
  req: http.ClientRequest,
  params: { overallTimeoutMs: number; idleTimeoutMs: number; operation: string },
): RequestDeadlineGuard {
  let response: http.IncomingMessage | undefined;
  const idleTimeout = () => {
    req.destroy(
      new Error(`${params.operation} exceeded its ${params.idleTimeoutMs}ms idle timeout`),
    );
  };
  const resetIdle = () => {
    response?.setTimeout(params.idleTimeoutMs);
  };
  const overallTimer = setTimeout(() => {
    req.destroy(
      new Error(`${params.operation} exceeded its ${params.overallTimeoutMs}ms overall timeout`),
    );
  }, params.overallTimeoutMs);
  overallTimer.unref();
  return {
    clear: () => clearTimeout(overallTimer),
    resetIdle,
    watchResponse: (res) => {
      response = res;
      res.setTimeout(params.idleTimeoutMs, idleTimeout);
    },
  };
}

export function parseRemoteHost(input: string): { hostname: string; port: number } {
  try {
    return parsePlaintextRemoteEndpoint(input);
  } catch (error) {
    throw new BrowserAutomationError(
      `Invalid remote host: ${input} (${error instanceof Error ? error.message : String(error)})`,
      { stage: "remote-connection" },
      error,
    );
  }
}

async function prepareAuthenticatedRequest(params: {
  hostname: string;
  port: number;
  token?: string;
  method: string;
  path: string;
  body: Buffer;
  overallTimeoutMs: number;
  idleTimeoutMs: number;
}): Promise<{ rootKey: string; authentication: RemoteAuthenticatedRequest }> {
  const rootKey = params.token;
  if (!rootKey) {
    throw new BrowserAutomationError("Remote transaction HMAC root key is missing.", {
      stage: "remote-authentication",
    });
  }
  assertRemoteCredential(rootKey, "Remote v3 HMAC root key");
  const host = params.hostname.includes(":")
    ? `[${params.hostname}]:${params.port}`
    : `${params.hostname}:${params.port}`;
  const health = await checkRemoteHealth({
    host,
    token: rootKey,
    timeoutMs: params.overallTimeoutMs,
    idleTimeoutMs: params.idleTimeoutMs,
  });
  if (!health.ok || health.protocol !== "transaction-v3" || !health.serverGeneration) {
    throw new BrowserAutomationError(
      `Remote generation proof failed: ${health.error ?? "current protocol unavailable"}`,
      {
        stage: "remote-authentication",
        statusCode: health.statusCode,
        ...(!health.statusCode ? { code: "remote-authentication-transport-failed" } : {}),
      },
    );
  }
  return {
    rootKey,
    authentication: createRemoteAuthenticatedRequest({
      rootKey,
      serverGeneration: health.serverGeneration,
      method: params.method,
      path: params.path,
      body: params.body,
    }),
  };
}

function sendBodyAfterServerProof(params: {
  req: http.ClientRequest;
  rootKey: string;
  authentication: RemoteAuthenticatedRequest;
  method: string;
  path: string;
  body: Buffer;
}): void {
  let requestProofVerified = false;
  let continueReceived = false;
  let bodySent = false;
  const send = () => {
    if (bodySent || !requestProofVerified || !continueReceived) return;
    bodySent = true;
    params.req.end(params.body);
  };
  params.req.on("information", (information) => {
    if (information.statusCode !== 103) return;
    const proof = String(information.headers[REMOTE_REQUEST_PROOF_HEADER] ?? "");
    if (
      !verifyRemoteRequestProof({
        rootKey: params.rootKey,
        method: params.method,
        path: params.path,
        authentication: params.authentication,
        proof,
      })
    ) {
      params.req.destroy(
        new BrowserAutomationError("Remote host returned an invalid authenticated request proof", {
          stage: "remote-authentication",
          code: "remote-request-proof-invalid",
        }),
      );
      return;
    }
    requestProofVerified = true;
    send();
  });
  params.req.on("continue", () => {
    continueReceived = true;
    send();
  });
  params.req.flushHeaders();
}

export async function streamRemoteRun(params: {
  hostname: string;
  port: number;
  token?: string;
  transactionToken: string;
  payload: RemoteRunPayload;
  options: Pick<BrowserRunOptions, "log" | "verbose">;
  deadlines: ResolvedRemoteTransportDeadlines;
  assertTransactionOwnership: (transaction: RemoteRunTransactionPayload) => void;
  rehydrateError: (error: RemoteBrowserAutomationErrorPayload) => BrowserAutomationError;
}): Promise<RemoteRunTransactionPayload> {
  const body = Buffer.from(JSON.stringify(RemoteRunPayloadSchema.parse(params.payload)));
  const requestPath = `/transactions/${encodeURIComponent(params.transactionToken)}/run`;
  if (body.byteLength > MAX_REMOTE_REQUEST_BYTES) {
    throw new BrowserAutomationError("Remote browser request exceeds the protocol size limit.", {
      stage: "remote-request",
      transactionToken: params.transactionToken,
    });
  }
  const { rootKey, authentication } = await prepareAuthenticatedRequest({
    hostname: params.hostname,
    port: params.port,
    token: params.token,
    method: "POST",
    path: requestPath,
    body,
    overallTimeoutMs: params.deadlines.runOverallTimeoutMs,
    idleTimeoutMs: params.deadlines.socketIdleTimeoutMs,
  });
  const deferred = Promise.withResolvers<RemoteRunTransactionPayload>();
  let settled = false;
  let receipt: RemoteRunTransactionPayload | null = null;
  let terminalError: BrowserAutomationError | null = null;
  let deadlineGuard: RequestDeadlineGuard | null = null;
  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true;
    deadlineGuard?.clear();
    if (receipt) {
      deferred.resolve(receipt);
      return;
    }
    deferred.reject(
      error instanceof BrowserAutomationError
        ? error
        : new RemoteTransportInterruption(
            error instanceof Error
              ? error.message
              : "Remote browser stream ended before the durable transaction receipt.",
            error,
          ),
    );
  };
  const req = http.request(
    {
      hostname: params.hostname,
      port: params.port,
      path: requestPath,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        Expect: "100-continue",
        ...authentication.headers,
      },
    },
    (res) => {
      deadlineGuard?.watchResponse(res);
      if (res.statusCode !== 200) {
        collectError(res)
          .then((message) =>
            finish(
              new BrowserAutomationError(message, {
                stage: "remote-http",
                statusCode: res.statusCode,
                transactionToken: params.transactionToken,
              }),
            ),
          )
          .catch(finish);
        return;
      }
      res.setEncoding("utf8");
      let buffer = "";
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (Buffer.byteLength(line, "utf8") > MAX_REMOTE_EVENT_BYTES) {
            res.destroy();
            finish(
              new BrowserAutomationError(
                "Remote transaction event exceeded the protocol size limit.",
                { stage: "remote-protocol" },
              ),
            );
            return;
          }
          if (line) {
            try {
              const event = RemoteRunEventSchema.parse(JSON.parse(line)) as RemoteRunEvent;
              if (event.type === "log") {
                params.options.log?.(event.message);
              } else if (event.type === "artifact-progress") {
                if (params.options.verbose) {
                  params.options.log?.(
                    `[browser] Artifact ${event.artifactId} ${event.phase}${
                      event.receivedBytes !== undefined && event.totalBytes !== undefined
                        ? ` ${event.receivedBytes}/${event.totalBytes} bytes`
                        : ""
                    }`,
                  );
                }
              } else if (event.type === "transaction") {
                params.assertTransactionOwnership(event.transaction);
                receipt = event.transaction;
              } else {
                terminalError = params.rehydrateError(event.error);
              }
            } catch (error) {
              finish(
                new BrowserAutomationError(
                  `Invalid remote transaction event: ${error instanceof Error ? error.message : String(error)}`,
                  { stage: "remote-protocol" },
                  error,
                ),
              );
              return;
            }
          }
          newlineIndex = buffer.indexOf("\n");
        }
        if (Buffer.byteLength(buffer, "utf8") > MAX_REMOTE_EVENT_BYTES) {
          res.destroy();
          finish(
            new BrowserAutomationError(
              "Remote transaction event exceeded the protocol size limit.",
              {
                stage: "remote-protocol",
              },
            ),
          );
        }
      });
      res.on("end", () => finish(terminalError ?? undefined));
      res.on("aborted", () => finish(terminalError ?? new Error("Remote response aborted")));
      res.on("error", (error) => finish(terminalError ?? error));
    },
  );
  deadlineGuard = attachRequestDeadlines(req, {
    overallTimeoutMs: params.deadlines.runOverallTimeoutMs,
    idleTimeoutMs: params.deadlines.socketIdleTimeoutMs,
    operation: "Remote run request",
  });
  req.on("error", finish);
  sendBodyAfterServerProof({
    req,
    rootKey,
    authentication,
    method: "POST",
    path: requestPath,
    body,
  });
  return await deferred.promise;
}

export async function streamLegacyRemoteRun(params: {
  hostname: string;
  port: number;
  legacyToken: string;
  payload: RemoteLegacyRunPayload;
  options: Pick<BrowserRunOptions, "log" | "verbose">;
  deadlines: ResolvedRemoteTransportDeadlines;
}): Promise<RemoteLegacyTextResult> {
  assertRemoteCredential(params.legacyToken, "Remote legacy bearer credential");
  const body = Buffer.from(JSON.stringify(RemoteLegacyRunPayloadSchema.parse(params.payload)));
  if (body.byteLength > MAX_REMOTE_REQUEST_BYTES) {
    throw new BrowserAutomationError("Legacy remote browser request exceeds the size limit.", {
      stage: "remote-request",
    });
  }
  const deferred = Promise.withResolvers<RemoteLegacyTextResult>();
  let deadlineGuard: RequestDeadlineGuard | null = null;
  let result: RemoteLegacyTextResult | null = null;
  let terminalError: string | null = null;
  let hostOnlyArtifacts = false;
  const finish = (error?: unknown) => {
    deadlineGuard?.clear();
    if (result) {
      deferred.resolve(
        hostOnlyArtifacts
          ? {
              ...result,
              warnings: [
                ...(result.warnings ?? []),
                {
                  code: "legacy-remote-artifacts-host-only",
                  severity: "warning",
                  message:
                    "Generated files remain on the remote host and require explicit manual transfer; legacy compatibility does not claim artifact delivery.",
                },
              ],
            }
          : result,
      );
      return;
    }
    deferred.reject(
      error instanceof Error
        ? error
        : new BrowserAutomationError(terminalError ?? "Legacy remote run ended without a result.", {
            stage: "remote-protocol",
          }),
    );
  };
  const req = http.request(
    {
      hostname: params.hostname,
      port: params.port,
      path: "/runs",
      method: "POST",
      headers: {
        authorization: `Bearer ${params.legacyToken}`,
        "Content-Type": "application/json",
        "Content-Length": body.length,
      },
    },
    (res) => {
      deadlineGuard?.watchResponse(res);
      if (res.statusCode !== 200) {
        collectError(res).then(
          (message) => finish(new BrowserAutomationError(message, { stage: "remote-http" })),
          finish,
        );
        return;
      }
      res.setEncoding("utf8");
      let buffer = "";
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) {
            try {
              const event = RemoteLegacyRunEventSchema.parse(JSON.parse(line));
              deadlineGuard?.resetIdle();
              if (event.type === "result") result = event.result;
              else if (event.type === "error") terminalError = event.message;
              else if (event.type === "artifact-ready") hostOnlyArtifacts = true;
              else if (event.type === "log" && params.options.verbose) {
                params.options.log?.(event.message);
              }
            } catch (error) {
              res.destroy(error instanceof Error ? error : new Error(String(error)));
              return;
            }
          }
          newlineIndex = buffer.indexOf("\n");
        }
        if (Buffer.byteLength(buffer, "utf8") > MAX_REMOTE_EVENT_BYTES) {
          res.destroy(new Error("Legacy remote event exceeded the size limit"));
        }
      });
      res.on("end", () => finish());
      res.on("aborted", () => finish(new Error("Legacy remote response aborted")));
      res.on("error", finish);
    },
  );
  deadlineGuard = attachRequestDeadlines(req, {
    overallTimeoutMs: params.deadlines.runOverallTimeoutMs,
    idleTimeoutMs: params.deadlines.socketIdleTimeoutMs,
    operation: "Legacy remote run request",
  });
  req.on("error", finish);
  req.end(body);
  return await deferred.promise;
}

export async function postRemoteJson(params: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  body: unknown;
  overallTimeoutMs: number;
  idleTimeoutMs: number;
  operation: string;
}): Promise<RemoteJsonResponse> {
  const body = Buffer.from(JSON.stringify(params.body));
  const { rootKey, authentication } = await prepareAuthenticatedRequest({
    hostname: params.hostname,
    port: params.port,
    token: params.token,
    method: "POST",
    path: params.path,
    body,
    overallTimeoutMs: params.overallTimeoutMs,
    idleTimeoutMs: params.idleTimeoutMs,
  });
  const deferred = Promise.withResolvers<RemoteJsonResponse>();
  let deadlineGuard: RequestDeadlineGuard | null = null;
  const resolve = (response: RemoteJsonResponse) => {
    deadlineGuard?.clear();
    deferred.resolve(response);
  };
  const reject = (error: unknown) => {
    deadlineGuard?.clear();
    deferred.reject(error);
  };
  const req = http.request(
    {
      hostname: params.hostname,
      port: params.port,
      path: params.path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        Expect: "100-continue",
        ...authentication.headers,
      },
    },
    (res) => {
      deadlineGuard?.watchResponse(res);
      collectResponseBody(res, 16 * 1024 * 1024)
        .then((raw) => {
          let json: unknown = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            // The status and raw body still produce a typed protocol error at the caller.
          }
          const errorMessage =
            json && typeof json === "object" && "error" in json && typeof json.error === "string"
              ? json.error
              : raw || `Remote host responded with status ${res.statusCode}`;
          resolve({ statusCode: res.statusCode ?? 0, json, errorMessage });
        })
        .catch(reject);
    },
  );
  deadlineGuard = attachRequestDeadlines(req, {
    overallTimeoutMs: params.overallTimeoutMs,
    idleTimeoutMs: params.idleTimeoutMs,
    operation: params.operation,
  });
  req.on("error", reject);
  sendBodyAfterServerProof({
    req,
    rootKey,
    authentication,
    method: "POST",
    path: params.path,
    body,
  });
  return await deferred.promise;
}

export async function consumeRemoteGet(
  params: {
    hostname: string;
    port: number;
    path: string;
    token?: string;
    overallTimeoutMs: number;
    idleTimeoutMs: number;
    operation: string;
  },
  consume: (res: http.IncomingMessage) => Promise<void>,
): Promise<void> {
  const emptyBody = Buffer.alloc(0);
  const { authentication } = await prepareAuthenticatedRequest({
    hostname: params.hostname,
    port: params.port,
    token: params.token,
    method: "GET",
    path: params.path,
    body: emptyBody,
    overallTimeoutMs: params.overallTimeoutMs,
    idleTimeoutMs: params.idleTimeoutMs,
  });
  const deferred = Promise.withResolvers<void>();
  let deadlineGuard: RequestDeadlineGuard | null = null;
  const resolve = () => {
    deadlineGuard?.clear();
    deferred.resolve();
  };
  const reject = (error: unknown) => {
    deadlineGuard?.clear();
    deferred.reject(error);
  };
  const req = http.request(
    {
      hostname: params.hostname,
      port: params.port,
      path: params.path,
      method: "GET",
      headers: authentication.headers,
    },
    (res) => {
      deadlineGuard?.watchResponse(res);
      if (res.statusCode !== 200) {
        collectError(res).then((message) => reject(new Error(message)), reject);
        return;
      }
      consume(res).then(resolve, reject);
    },
  );
  deadlineGuard = attachRequestDeadlines(req, {
    overallTimeoutMs: params.overallTimeoutMs,
    idleTimeoutMs: params.idleTimeoutMs,
    operation: params.operation,
  });
  req.on("error", reject);
  req.end();
  await deferred.promise;
}

async function collectResponseBody(
  res: http.IncomingMessage,
  maximumBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of res) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    receivedBytes += buffer.byteLength;
    if (receivedBytes > maximumBytes) throw new Error("Remote response exceeded size limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, receivedBytes).toString("utf8");
}

async function collectError(res: http.IncomingMessage): Promise<string> {
  const raw = await collectResponseBody(res, 1024 * 1024);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      if ("message" in parsed && typeof parsed.message === "string") return parsed.message;
      if ("error" in parsed && typeof parsed.error === "string") return parsed.error;
    }
  } catch {
    // Fall through to the bounded raw response.
  }
  return raw || `Remote host responded with status ${res.statusCode}`;
}
