import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { REMOTE_TRANSACTION_PROTOCOL_VERSION } from "./types.js";

export const REMOTE_AUTH_SCHEME = "oracle-hmac-sha256-v1";
export const REMOTE_PROTOCOL_HEADER = "x-oracle-transaction-protocol";
export const REMOTE_HEALTH_CLIENT_NONCE_HEADER = "x-oracle-client-nonce";
export const REMOTE_AUTH_SCHEME_HEADER = "x-oracle-auth-scheme";
export const REMOTE_SERVER_GENERATION_HEADER = "x-oracle-server-generation";
export const REMOTE_REQUEST_NONCE_HEADER = "x-oracle-request-nonce";
export const REMOTE_BODY_SHA256_HEADER = "x-oracle-body-sha256";
export const REMOTE_REQUEST_MAC_HEADER = "x-oracle-request-mac";
export const REMOTE_REQUEST_PROOF_HEADER = "x-oracle-request-proof";

const HEX_256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_AUTHENTICATED_NONCES = 8_192;
const AUTHENTICATED_NONCE_TTL_MS = 30 * 60 * 1000;
export function assertRemoteCredential(value: string, label = "Remote credential"): string {
  if (!HEX_256_PATTERN.test(value)) {
    throw new Error(`${label} must be exactly 64 lowercase hexadecimal characters (32 bytes).`);
  }
  return value;
}

export function generateRemoteCredential(): string {
  return randomBytes(32).toString("hex");
}

export interface RemoteHealthAuthenticationProof {
  scheme: typeof REMOTE_AUTH_SCHEME;
  serverGeneration: string;
  clientNonce: string;
  serverNonce: string;
  proof: string;
}

export interface RemoteAuthenticatedRequest {
  serverGeneration: string;
  requestNonce: string;
  bodySha256: string;
  headers: Record<string, string>;
}

export interface VerifiedRemoteRequestAuth {
  serverGeneration: string;
  requestNonce: string;
  bodySha256: string;
  requestProof: string;
}

export type RemoteRequestAuthFailure = {
  statusCode: 401 | 409;
  code:
    | "authentication_required"
    | "invalid_request_authentication"
    | "server_generation_changed"
    | "request_replayed";
};

function keyedDigest(secret: string, domain: string, values: string[]): string {
  assertRemoteCredential(secret);
  return createHmac("sha256", secret)
    .update(JSON.stringify([domain, ...values]))
    .digest("hex");
}

function safeDigestEqual(expected: string, actual: string): boolean {
  if (!HEX_256_PATTERN.test(expected) || !HEX_256_PATTERN.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

export function remoteBodySha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

export function createRemoteHealthAuthenticationProof(params: {
  rootKey: string;
  serverGeneration: string;
  clientNonce: string;
}): RemoteHealthAuthenticationProof {
  const serverNonce = randomBytes(32).toString("hex");
  return {
    scheme: REMOTE_AUTH_SCHEME,
    serverGeneration: params.serverGeneration,
    clientNonce: params.clientNonce,
    serverNonce,
    proof: keyedDigest(params.rootKey, "health-proof", [
      String(REMOTE_TRANSACTION_PROTOCOL_VERSION),
      params.serverGeneration,
      params.clientNonce,
      serverNonce,
    ]),
  };
}

export function verifyRemoteHealthAuthenticationProof(
  rootKey: string,
  expectedClientNonce: string,
  proof: RemoteHealthAuthenticationProof,
): boolean {
  if (
    proof.scheme !== REMOTE_AUTH_SCHEME ||
    proof.clientNonce !== expectedClientNonce ||
    !HEX_256_PATTERN.test(proof.clientNonce) ||
    !HEX_256_PATTERN.test(proof.serverNonce) ||
    !proof.serverGeneration ||
    proof.serverGeneration.length > 128
  ) {
    return false;
  }
  const expected = keyedDigest(rootKey, "health-proof", [
    String(REMOTE_TRANSACTION_PROTOCOL_VERSION),
    proof.serverGeneration,
    proof.clientNonce,
    proof.serverNonce,
  ]);
  return safeDigestEqual(expected, proof.proof);
}

export function createRemoteAuthenticatedRequest(params: {
  rootKey: string;
  serverGeneration: string;
  method: string;
  path: string;
  body: Buffer;
}): RemoteAuthenticatedRequest {
  const requestNonce = randomBytes(32).toString("hex");
  const bodySha256 = remoteBodySha256(params.body);
  const requestMac = keyedDigest(params.rootKey, "request", [
    params.serverGeneration,
    params.method.toUpperCase(),
    params.path,
    requestNonce,
    bodySha256,
  ]);
  return {
    serverGeneration: params.serverGeneration,
    requestNonce,
    bodySha256,
    headers: {
      [REMOTE_AUTH_SCHEME_HEADER]: REMOTE_AUTH_SCHEME,
      [REMOTE_SERVER_GENERATION_HEADER]: params.serverGeneration,
      [REMOTE_REQUEST_NONCE_HEADER]: requestNonce,
      [REMOTE_BODY_SHA256_HEADER]: bodySha256,
      [REMOTE_REQUEST_MAC_HEADER]: requestMac,
    },
  };
}

export function verifyRemoteRequestProof(params: {
  rootKey: string;
  method: string;
  path: string;
  authentication: RemoteAuthenticatedRequest;
  proof: string;
}): boolean {
  const expected = keyedDigest(params.rootKey, "request-proof", [
    params.authentication.serverGeneration,
    params.method.toUpperCase(),
    params.path,
    params.authentication.requestNonce,
    params.authentication.bodySha256,
  ]);
  return safeDigestEqual(expected, params.proof);
}

export class RemoteRequestAuthenticator {
  readonly #rootKey: string;
  readonly #serverGeneration: string;
  readonly #now: () => number;
  readonly #seenNonces = new Map<string, number>();
  readonly #verifiedRequests = new WeakMap<http.IncomingMessage, VerifiedRemoteRequestAuth>();

  constructor(params: { rootKey: string; serverGeneration: string; now?: () => number }) {
    assertRemoteCredential(params.rootKey, "Remote v3 HMAC root key");
    this.#rootKey = params.rootKey;
    this.#serverGeneration = params.serverGeneration;
    this.#now = params.now ?? Date.now;
  }

  authenticate(req: http.IncomingMessage): VerifiedRemoteRequestAuth | RemoteRequestAuthFailure {
    const scheme = String(req.headers[REMOTE_AUTH_SCHEME_HEADER] ?? "");
    const serverGeneration = String(req.headers[REMOTE_SERVER_GENERATION_HEADER] ?? "");
    const requestNonce = String(req.headers[REMOTE_REQUEST_NONCE_HEADER] ?? "");
    const bodySha256 = String(req.headers[REMOTE_BODY_SHA256_HEADER] ?? "");
    const requestMac = String(req.headers[REMOTE_REQUEST_MAC_HEADER] ?? "");
    if (!scheme && !serverGeneration && !requestNonce && !bodySha256 && !requestMac) {
      return { statusCode: 401, code: "authentication_required" };
    }
    if (serverGeneration !== this.#serverGeneration) {
      return { statusCode: 409, code: "server_generation_changed" };
    }
    if (
      scheme !== REMOTE_AUTH_SCHEME ||
      !HEX_256_PATTERN.test(requestNonce) ||
      !HEX_256_PATTERN.test(bodySha256) ||
      !HEX_256_PATTERN.test(requestMac) ||
      !req.method ||
      !req.url
    ) {
      return { statusCode: 401, code: "invalid_request_authentication" };
    }

    const now = this.#now();
    for (const [nonce, seenAt] of this.#seenNonces) {
      if (now - seenAt > AUTHENTICATED_NONCE_TTL_MS) this.#seenNonces.delete(nonce);
    }
    if (this.#seenNonces.has(requestNonce)) {
      return { statusCode: 409, code: "request_replayed" };
    }
    const expected = keyedDigest(this.#rootKey, "request", [
      serverGeneration,
      req.method.toUpperCase(),
      req.url,
      requestNonce,
      bodySha256,
    ]);
    if (!safeDigestEqual(expected, requestMac)) {
      return { statusCode: 401, code: "invalid_request_authentication" };
    }
    if (this.#seenNonces.size >= MAX_AUTHENTICATED_NONCES) {
      const oldest = this.#seenNonces.keys().next().value as string | undefined;
      if (oldest) this.#seenNonces.delete(oldest);
    }
    this.#seenNonces.set(requestNonce, now);
    const verified = {
      serverGeneration,
      requestNonce,
      bodySha256,
      requestProof: keyedDigest(this.#rootKey, "request-proof", [
        serverGeneration,
        req.method.toUpperCase(),
        req.url,
        requestNonce,
        bodySha256,
      ]),
    };
    this.#verifiedRequests.set(req, verified);
    return verified;
  }

  verified(req: http.IncomingMessage): VerifiedRemoteRequestAuth | undefined {
    return this.#verifiedRequests.get(req);
  }
}
