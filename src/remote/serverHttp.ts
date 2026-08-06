import type http from "node:http";
import {
  REMOTE_AUTH_SCHEME_HEADER,
  REMOTE_BODY_SHA256_HEADER,
  remoteBodySha256,
  type RemoteRequestAuthenticator,
} from "./auth.js";
import { REMOTE_TRANSACTION_TOKEN_PATTERN } from "./types.js";

export class RemoteRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RemoteRequestError";
  }
}

export function authenticateLegacyRemoteRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  legacyToken: string | undefined,
  logger: (message: string) => void,
  verbose: boolean,
  endpoint: string,
): boolean {
  if (legacyToken && (req.headers.authorization ?? "") === `Bearer ${legacyToken}`) return true;
  if (verbose) {
    logger(
      `[serve] Unauthorized legacy ${endpoint} attempt from ${formatSocket(req)} (missing/invalid scoped credential)`,
    );
  }
  sendJson(res, 401, { error: "unauthorized" });
  return false;
}

export function authenticateCurrentRemoteRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authenticator: RemoteRequestAuthenticator,
): boolean {
  const authentication = authenticator.verified(req) ?? authenticator.authenticate(req);
  if ("statusCode" in authentication) {
    sendJson(res, authentication.statusCode, { error: authentication.code });
    return false;
  }
  return true;
}

export function sendJson(res: http.ServerResponse, statusCode: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(statusCode, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
export function matchLegacyRunRequest(req: http.IncomingMessage): boolean {
  return req.method === "POST" && req.url === "/runs";
}

export function matchTransactionRequest(
  req: http.IncomingMessage,
): { transactionToken: string; action: "run" | "bind" | "finalize" | "abort" | "retry" } | null {
  if (req.method !== "POST" || !req.url) return null;
  let pathname: string;
  try {
    pathname = new URL(req.url, "http://oracle.local").pathname;
  } catch {
    return null;
  }
  const match = /^\/transactions\/([^/]+)\/(run|bind|finalize|abort|retry)$/.exec(pathname);
  if (!match) return null;
  let transactionToken: string;
  try {
    transactionToken = decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
  if (!REMOTE_TRANSACTION_TOKEN_PATTERN.test(transactionToken)) return null;
  return {
    transactionToken,
    action: match[2] as "run" | "bind" | "finalize" | "abort" | "retry",
  };
}

export function matchArtifactReceiptRequest(
  req: http.IncomingMessage,
): { transactionToken: string; artifactId: string } | null {
  if (req.method !== "POST" || !req.url) return null;
  let pathname: string;
  try {
    pathname = new URL(req.url, "http://oracle.local").pathname;
  } catch {
    return null;
  }
  const match = /^\/transactions\/([^/]+)\/artifacts\/([^/]+)\/receipt$/.exec(pathname);
  if (!match) return null;
  try {
    const transactionToken = decodeURIComponent(match[1] ?? "");
    const artifactId = decodeURIComponent(match[2] ?? "");
    if (
      !REMOTE_TRANSACTION_TOKEN_PATTERN.test(transactionToken) ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(artifactId)
    ) {
      return null;
    }
    return { transactionToken, artifactId };
  } catch {
    return null;
  }
}

export function matchArtifactManualCopyWaiverRequest(
  req: http.IncomingMessage,
): { transactionToken: string; artifactId: string } | null {
  if (req.method !== "POST" || !req.url) return null;
  let pathname: string;
  try {
    pathname = new URL(req.url, "http://oracle.local").pathname;
  } catch {
    return null;
  }
  const match = /^\/transactions\/([^/]+)\/artifacts\/([^/]+)\/manual-copy-waiver$/.exec(pathname);
  if (!match) return null;
  try {
    const transactionToken = decodeURIComponent(match[1] ?? "");
    const artifactId = decodeURIComponent(match[2] ?? "");
    if (
      !REMOTE_TRANSACTION_TOKEN_PATTERN.test(transactionToken) ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(artifactId)
    ) {
      return null;
    }
    return { transactionToken, artifactId };
  } catch {
    return null;
  }
}

export function matchArtifactRequest(
  req: http.IncomingMessage,
): { transactionToken: string; artifactId: string } | null {
  if (req.method !== "GET" || !req.url) return null;
  let pathname: string;
  try {
    pathname = new URL(req.url, "http://oracle.local").pathname;
  } catch {
    return null;
  }
  const match = /^\/transactions\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    const transactionToken = decodeURIComponent(match[1] ?? "");
    const artifactId = decodeURIComponent(match[2] ?? "");
    if (
      !REMOTE_TRANSACTION_TOKEN_PATTERN.test(transactionToken) ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(artifactId)
    ) {
      return null;
    }
    return { transactionToken, artifactId };
  } catch {
    return null;
  }
}

export async function readRequestBody(
  req: http.IncomingMessage,
  maximumBytes: number,
  expectedSha256?: string,
): Promise<string> {
  const contentLengthHeader = req.headers["content-length"];
  const contentLength =
    typeof contentLengthHeader === "string" ? Number(contentLengthHeader) : undefined;
  if (
    contentLength !== undefined &&
    (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maximumBytes)
  ) {
    throw new RemoteRequestError(
      413,
      "request_too_large",
      "Remote request body exceeds size limit",
    );
  }
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    receivedBytes += buffer.byteLength;
    if (receivedBytes > maximumBytes) {
      throw new RemoteRequestError(
        413,
        "request_too_large",
        "Remote request body exceeds size limit",
      );
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks, receivedBytes);
  const signedBodySha256 =
    expectedSha256 ??
    (req.headers[REMOTE_AUTH_SCHEME_HEADER]
      ? String(req.headers[REMOTE_BODY_SHA256_HEADER] ?? "")
      : undefined);
  if (signedBodySha256 && remoteBodySha256(body) !== signedBodySha256) {
    throw new RemoteRequestError(
      401,
      "request_body_authentication_failed",
      "Authenticated request body did not match its signed digest",
    );
  }
  return body.toString("utf8");
}

export function formatSocket(req: http.IncomingMessage): string {
  const socket = req.socket;
  const host = socket.remoteAddress ?? "unknown";
  const port = socket.remotePort ?? "0";
  return `${host}:${port}`;
}
