import http from "node:http";
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
  const overallTimer = setTimeout(() => {
    req.destroy(
      new Error(`${params.operation} exceeded its ${params.overallTimeoutMs}ms overall timeout`),
    );
  }, params.overallTimeoutMs);
  overallTimer.unref();
  req.setTimeout(params.idleTimeoutMs, () => {
    req.destroy(
      new Error(`${params.operation} exceeded its ${params.idleTimeoutMs}ms idle timeout`),
    );
  });
  return {
    clear: () => clearTimeout(overallTimer),
    watchResponse: (res) => {
      res.setTimeout(params.idleTimeoutMs, () => {
        res.destroy(
          new Error(`${params.operation} exceeded its ${params.idleTimeoutMs}ms idle timeout`),
        );
      });
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
  if (body.byteLength > MAX_REMOTE_REQUEST_BYTES) {
    throw new BrowserAutomationError("Remote browser request exceeds the protocol size limit.", {
      stage: "remote-request",
      transactionToken: params.transactionToken,
    });
  }
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
      path: `/transactions/${encodeURIComponent(params.transactionToken)}/run`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
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
        ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
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
            json &&
            typeof json === "object" &&
            "message" in json &&
            typeof json.message === "string"
              ? json.message
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
  req.end(body);
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
      headers: params.token ? { authorization: `Bearer ${params.token}` } : undefined,
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
