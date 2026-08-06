import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import {
  MAX_REMOTE_AUTHENTICATED_NONCES,
  REMOTE_REQUEST_FRESHNESS_WINDOW_MS,
  REMOTE_REQUEST_FUTURE_CLOCK_SKEW_MS,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
} from "./types.js";

export const REMOTE_AUTH_SCHEME = "oracle-hmac-sha256-v2";
export const REMOTE_PROTOCOL_HEADER = "x-oracle-transaction-protocol";
export const REMOTE_HEALTH_CLIENT_NONCE_HEADER = "x-oracle-client-nonce";
export const REMOTE_AUTH_SCHEME_HEADER = "x-oracle-auth-scheme";
export const REMOTE_SERVER_GENERATION_HEADER = "x-oracle-server-generation";
export const REMOTE_REQUEST_NONCE_HEADER = "x-oracle-request-nonce";
export const REMOTE_REQUEST_ISSUED_AT_HEADER = "x-oracle-request-issued-at";
export const REMOTE_BODY_SHA256_HEADER = "x-oracle-body-sha256";
export const REMOTE_REQUEST_MAC_HEADER = "x-oracle-request-mac";
export const REMOTE_REQUEST_PROOF_HEADER = "x-oracle-request-proof";

const HEX_256_PATTERN = /^[a-f0-9]{64}$/u;
const DECIMAL_MILLISECONDS_PATTERN = /^(?:0|[1-9][0-9]{0,15})$/u;
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
  issuedAt: string;
  bodySha256: string;
  headers: Record<string, string>;
}

export interface VerifiedRemoteRequestAuth {
  serverGeneration: string;
  requestNonce: string;
  issuedAt: string;
  bodySha256: string;
  requestProof: string;
}

export type RemoteRequestAuthFailure = {
  statusCode: 401 | 409 | 429;
  code:
    | "authentication_required"
    | "invalid_request_authentication"
    | "server_generation_changed"
    | "request_replayed"
    | "authentication_capacity_exhausted";
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

function parseIssuedAt(value: string): number | null {
  if (!DECIMAL_MILLISECONDS_PATTERN.test(value)) return null;
  const issuedAt = Number(value);
  return Number.isSafeInteger(issuedAt) ? issuedAt : null;
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
  issuedAt: number;
}): RemoteAuthenticatedRequest {
  const requestNonce = randomBytes(32).toString("hex");
  const bodySha256 = remoteBodySha256(params.body);
  const issuedAt = String(params.issuedAt);
  if (parseIssuedAt(issuedAt) === null) {
    throw new Error("Remote request issued-at must be a non-negative safe integer timestamp.");
  }
  const requestMac = keyedDigest(params.rootKey, "request", [
    params.serverGeneration,
    params.method.toUpperCase(),
    params.path,
    requestNonce,
    issuedAt,
    bodySha256,
  ]);
  return {
    serverGeneration: params.serverGeneration,
    requestNonce,
    issuedAt,
    bodySha256,
    headers: {
      [REMOTE_AUTH_SCHEME_HEADER]: REMOTE_AUTH_SCHEME,
      [REMOTE_SERVER_GENERATION_HEADER]: params.serverGeneration,
      [REMOTE_REQUEST_NONCE_HEADER]: requestNonce,
      [REMOTE_REQUEST_ISSUED_AT_HEADER]: issuedAt,
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
    params.authentication.issuedAt,
    params.authentication.bodySha256,
  ]);
  return safeDigestEqual(expected, params.proof);
}

export class RemoteRequestAuthenticator {
  readonly #rootKey: string;
  readonly #serverGeneration: string;
  readonly #now: () => number;
  readonly #maximumNonces: number;
  readonly #seenNonces = new Map<string, number>();
  readonly #verifiedRequests = new WeakMap<http.IncomingMessage, VerifiedRemoteRequestAuth>();

  constructor(params: {
    rootKey: string;
    serverGeneration: string;
    now?: () => number;
    maximumNonces?: number;
  }) {
    assertRemoteCredential(params.rootKey, "Remote v3 HMAC root key");
    const maximumNonces = params.maximumNonces ?? MAX_REMOTE_AUTHENTICATED_NONCES;
    if (
      !Number.isSafeInteger(maximumNonces) ||
      maximumNonces <= 0 ||
      maximumNonces > MAX_REMOTE_AUTHENTICATED_NONCES
    ) {
      throw new Error("Remote authenticated nonce capacity is outside its safe bound.");
    }
    this.#rootKey = params.rootKey;
    this.#serverGeneration = params.serverGeneration;
    this.#now = params.now ?? Date.now;
    this.#maximumNonces = maximumNonces;
  }

  authenticate(req: http.IncomingMessage): VerifiedRemoteRequestAuth | RemoteRequestAuthFailure {
    const scheme = String(req.headers[REMOTE_AUTH_SCHEME_HEADER] ?? "");
    const serverGeneration = String(req.headers[REMOTE_SERVER_GENERATION_HEADER] ?? "");
    const requestNonce = String(req.headers[REMOTE_REQUEST_NONCE_HEADER] ?? "");
    const issuedAtHeader = String(req.headers[REMOTE_REQUEST_ISSUED_AT_HEADER] ?? "");
    const bodySha256 = String(req.headers[REMOTE_BODY_SHA256_HEADER] ?? "");
    const requestMac = String(req.headers[REMOTE_REQUEST_MAC_HEADER] ?? "");
    if (
      !scheme &&
      !serverGeneration &&
      !requestNonce &&
      !issuedAtHeader &&
      !bodySha256 &&
      !requestMac
    ) {
      return { statusCode: 401, code: "authentication_required" };
    }
    if (serverGeneration !== this.#serverGeneration) {
      return { statusCode: 409, code: "server_generation_changed" };
    }
    const issuedAt = parseIssuedAt(issuedAtHeader);
    if (
      scheme !== REMOTE_AUTH_SCHEME ||
      !HEX_256_PATTERN.test(requestNonce) ||
      issuedAt === null ||
      !HEX_256_PATTERN.test(bodySha256) ||
      !HEX_256_PATTERN.test(requestMac) ||
      !req.method ||
      !req.url
    ) {
      return { statusCode: 401, code: "invalid_request_authentication" };
    }

    const now = this.#now();
    if (
      issuedAt < now - REMOTE_REQUEST_FRESHNESS_WINDOW_MS ||
      issuedAt > now + REMOTE_REQUEST_FUTURE_CLOCK_SKEW_MS
    ) {
      return { statusCode: 401, code: "invalid_request_authentication" };
    }
    const expected = keyedDigest(this.#rootKey, "request", [
      serverGeneration,
      req.method.toUpperCase(),
      req.url,
      requestNonce,
      issuedAtHeader,
      bodySha256,
    ]);
    if (!safeDigestEqual(expected, requestMac)) {
      return { statusCode: 401, code: "invalid_request_authentication" };
    }
    for (const [nonce, expiresAt] of this.#seenNonces) {
      if (expiresAt < now) this.#seenNonces.delete(nonce);
    }
    if (this.#seenNonces.has(requestNonce)) {
      return { statusCode: 409, code: "request_replayed" };
    }
    if (this.#seenNonces.size >= this.#maximumNonces) {
      return { statusCode: 429, code: "authentication_capacity_exhausted" };
    }
    this.#seenNonces.set(requestNonce, issuedAt + REMOTE_REQUEST_FRESHNESS_WINDOW_MS);
    const verified = {
      serverGeneration,
      requestNonce,
      issuedAt: issuedAtHeader,
      bodySha256,
      requestProof: keyedDigest(this.#rootKey, "request-proof", [
        serverGeneration,
        req.method.toUpperCase(),
        req.url,
        requestNonce,
        issuedAtHeader,
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
