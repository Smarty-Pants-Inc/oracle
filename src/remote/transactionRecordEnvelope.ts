import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { RemoteTransactionRecord } from "./transactionModel.js";
import { validateRemoteTransactionRecord } from "./transactionValidation.js";

const REMOTE_TRANSACTION_RECORD_ENVELOPE_VERSION = 2;
const REMOTE_TRANSACTION_RECORD_ALGORITHM = "hmac-sha256";
const REMOTE_TRANSACTION_KEY_ID_DOMAIN =
  "oracle.remote-controller.transaction-store.integrity-key-id.v1";
const REMOTE_TRANSACTION_RECORD_MAC_DOMAIN = "oracle.remote-controller.transaction-store.record.v1";
const REMOTE_TRANSACTION_RECORD_MAC_PATTERN = /^[a-f0-9]{64}$/u;
const REMOTE_TRANSACTION_RECORD_KEY_ID_PATTERN = /^[a-f0-9]{64}$/u;
const REMOTE_TRANSACTION_HEAD_ENVELOPE_VERSION = 1;
const REMOTE_TRANSACTION_HEAD_MAC_DOMAIN = "oracle.remote-controller.transaction-store.head.v1";
const REMOTE_TRANSACTION_HEAD_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

type RemoteTransactionRecordEnvelope = {
  version: number;
  algorithm: typeof REMOTE_TRANSACTION_RECORD_ALGORITHM;
  keyId: string;
  revision: number;
  payload: string;
  mac: string;
};

type RemoteTransactionHeadEnvelope = {
  version: number;
  algorithm: typeof REMOTE_TRANSACTION_RECORD_ALGORITHM;
  keyId: string;
  current: RemoteTransactionExpectedHead | null;
  pending: RemoteTransactionExpectedHead | null;
  retired: boolean;
  mac: string;
};

export type RemoteTransactionExpectedHead = { revision: number; digest: string };

export type SerializedRemoteTransactionRecord = {
  contents: Buffer;
  head: RemoteTransactionExpectedHead;
};

export type AuthenticatedRemoteTransactionRecordEnvelope = {
  record: RemoteTransactionRecord;
  head: RemoteTransactionExpectedHead;
};

export type RemoteTransactionHeadAuthority = {
  current: RemoteTransactionExpectedHead | null;
  pending: RemoteTransactionExpectedHead | null;
  retired: boolean;
};

export function remoteTransactionIntegrityKeyId(integrityKey: Buffer): string {
  return createHash("sha256")
    .update(REMOTE_TRANSACTION_KEY_ID_DOMAIN, "utf8")
    .update(Buffer.of(0))
    .update(integrityKey)
    .digest("hex");
}

export function serializeRemoteTransactionRecord(options: {
  record: RemoteTransactionRecord;
  revision: number;
  integrityKey: Buffer;
  integrityKeyId: string;
  directory: string;
}): SerializedRemoteTransactionRecord {
  if (!Number.isSafeInteger(options.revision) || options.revision < 1) {
    throw new Error("Remote transaction envelope revision must be a positive safe integer");
  }
  const payload = Buffer.from(`${JSON.stringify(options.record, null, 2)}\n`, "utf8");
  const envelope: RemoteTransactionRecordEnvelope = {
    version: REMOTE_TRANSACTION_RECORD_ENVELOPE_VERSION,
    algorithm: REMOTE_TRANSACTION_RECORD_ALGORITHM,
    keyId: options.integrityKeyId,
    revision: options.revision,
    payload: payload.toString("base64"),
    mac: recordMac({
      transactionToken: options.record.transactionToken,
      payload,
      version: REMOTE_TRANSACTION_RECORD_ENVELOPE_VERSION,
      revision: options.revision,
      integrityKey: options.integrityKey,
      integrityKeyId: options.integrityKeyId,
      directory: options.directory,
    }).toString("hex"),
  };
  const contents = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  return {
    contents,
    head: {
      revision: options.revision,
      digest: createHash("sha256").update(contents).digest("hex"),
    },
  };
}

export function authenticateRemoteTransactionRecordEnvelope(options: {
  contents: Buffer;
  transactionToken: string;
  integrityKey: Buffer;
  integrityKeyId: string;
  directory: string;
  maximumDecodedRecordBytes: number;
  maximumLeaseDurationMs: number;
  expectedHead?: RemoteTransactionExpectedHead;
}): AuthenticatedRemoteTransactionRecordEnvelope {
  const candidate = JSON.parse(options.contents.toString("utf8")) as unknown;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("invalid envelope");
  }
  const envelope = candidate as Partial<RemoteTransactionRecordEnvelope>;
  const fields = Object.keys(candidate).sort().join(",");
  if (fields !== "algorithm,keyId,mac,payload,revision,version") {
    throw new Error("invalid envelope fields");
  }
  const revision = envelope.revision;
  if (
    envelope.version !== REMOTE_TRANSACTION_RECORD_ENVELOPE_VERSION ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    envelope.algorithm !== REMOTE_TRANSACTION_RECORD_ALGORITHM ||
    typeof envelope.keyId !== "string" ||
    !REMOTE_TRANSACTION_RECORD_KEY_ID_PATTERN.test(envelope.keyId) ||
    envelope.keyId !== options.integrityKeyId ||
    typeof envelope.payload !== "string" ||
    typeof envelope.mac !== "string" ||
    !REMOTE_TRANSACTION_RECORD_MAC_PATTERN.test(envelope.mac)
  ) {
    throw new Error("invalid envelope authentication");
  }
  const payloadPadding = envelope.payload.endsWith("==")
    ? 2
    : envelope.payload.endsWith("=")
      ? 1
      : 0;
  const maximumDecodedBytes = Math.ceil(envelope.payload.length / 4) * 3 - payloadPadding;
  if (maximumDecodedBytes > options.maximumDecodedRecordBytes) {
    throw new Error("decoded envelope payload exceeds size limit");
  }
  const payload = Buffer.from(envelope.payload, "base64");
  if (payload.byteLength > options.maximumDecodedRecordBytes) {
    throw new Error("decoded envelope payload exceeds size limit");
  }
  if (payload.toString("base64") !== envelope.payload) {
    throw new Error("invalid envelope payload encoding");
  }
  const expectedMac = recordMac({
    transactionToken: options.transactionToken,
    payload,
    version: envelope.version,
    revision,
    integrityKey: options.integrityKey,
    integrityKeyId: options.integrityKeyId,
    directory: options.directory,
  });
  const actualMac = Buffer.from(envelope.mac, "hex");
  if (actualMac.byteLength !== expectedMac.byteLength || !timingSafeEqual(expectedMac, actualMac)) {
    throw new Error("invalid envelope authentication");
  }
  const record = JSON.parse(payload.toString("utf8")) as RemoteTransactionRecord;
  validateRemoteTransactionRecord(record, {
    expectedTransactionToken: options.transactionToken,
    maximumLeaseDurationMs: options.maximumLeaseDurationMs,
  });
  const head = {
    revision,
    digest: createHash("sha256").update(options.contents).digest("hex"),
  };
  if (
    options.expectedHead &&
    (options.expectedHead.revision !== head.revision || options.expectedHead.digest !== head.digest)
  ) {
    throw new Error("stale remote transaction envelope");
  }
  return { record, head };
}

export function serializeRemoteTransactionHeadAuthority(options: {
  authority: RemoteTransactionHeadAuthority;
  transactionToken: string;
  integrityKey: Buffer;
  integrityKeyId: string;
  headDirectory: string;
}): Buffer {
  assertRemoteTransactionHeadAuthority(options.authority);
  const envelope: RemoteTransactionHeadEnvelope = {
    version: REMOTE_TRANSACTION_HEAD_ENVELOPE_VERSION,
    algorithm: REMOTE_TRANSACTION_RECORD_ALGORITHM,
    keyId: options.integrityKeyId,
    current: options.authority.current,
    pending: options.authority.pending,
    retired: options.authority.retired,
    mac: headMac({
      ...options,
      version: REMOTE_TRANSACTION_HEAD_ENVELOPE_VERSION,
    }).toString("hex"),
  };
  return Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
}

export function authenticateRemoteTransactionHeadAuthority(options: {
  contents: Buffer;
  transactionToken: string;
  integrityKey: Buffer;
  integrityKeyId: string;
  headDirectory: string;
}): RemoteTransactionHeadAuthority {
  const candidate = JSON.parse(options.contents.toString("utf8")) as unknown;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("invalid transaction head envelope");
  }
  const envelope = candidate as Partial<RemoteTransactionHeadEnvelope>;
  if (
    Object.keys(candidate).sort().join(",") !==
    "algorithm,current,keyId,mac,pending,retired,version"
  ) {
    throw new Error("invalid transaction head envelope fields");
  }
  if (
    envelope.version !== REMOTE_TRANSACTION_HEAD_ENVELOPE_VERSION ||
    envelope.algorithm !== REMOTE_TRANSACTION_RECORD_ALGORITHM ||
    typeof envelope.keyId !== "string" ||
    !REMOTE_TRANSACTION_RECORD_KEY_ID_PATTERN.test(envelope.keyId) ||
    envelope.keyId !== options.integrityKeyId ||
    typeof envelope.retired !== "boolean" ||
    typeof envelope.mac !== "string" ||
    !REMOTE_TRANSACTION_RECORD_MAC_PATTERN.test(envelope.mac)
  ) {
    throw new Error("invalid transaction head authentication");
  }
  const authority = {
    current: parseRemoteTransactionExpectedHead(envelope.current),
    pending: parseRemoteTransactionExpectedHead(envelope.pending),
    retired: envelope.retired,
  };
  assertRemoteTransactionHeadAuthority(authority);
  const expectedMac = headMac({
    authority,
    transactionToken: options.transactionToken,
    integrityKey: options.integrityKey,
    integrityKeyId: options.integrityKeyId,
    headDirectory: options.headDirectory,
    version: envelope.version,
  });
  const actualMac = Buffer.from(envelope.mac, "hex");
  if (actualMac.byteLength !== expectedMac.byteLength || !timingSafeEqual(expectedMac, actualMac)) {
    throw new Error("invalid transaction head authentication");
  }
  return authority;
}

function parseRemoteTransactionExpectedHead(value: unknown): RemoteTransactionExpectedHead | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid transaction head");
  }
  if (Object.keys(value).sort().join(",") !== "digest,revision") {
    throw new Error("invalid transaction head fields");
  }
  const candidate = value as Partial<RemoteTransactionExpectedHead>;
  if (
    typeof candidate.revision !== "number" ||
    !Number.isSafeInteger(candidate.revision) ||
    candidate.revision < 1 ||
    typeof candidate.digest !== "string" ||
    !REMOTE_TRANSACTION_HEAD_DIGEST_PATTERN.test(candidate.digest)
  ) {
    throw new Error("invalid transaction head");
  }
  return { revision: candidate.revision, digest: candidate.digest };
}

function assertRemoteTransactionHeadAuthority(authority: RemoteTransactionHeadAuthority): void {
  if (authority.current) parseRemoteTransactionExpectedHead(authority.current);
  if (authority.pending) parseRemoteTransactionExpectedHead(authority.pending);
  if (!authority.current && !authority.pending) {
    throw new Error("transaction head authority is empty");
  }
  if (authority.retired && (!authority.current || authority.pending)) {
    throw new Error("retired transaction head authority must have one current head");
  }
  if (authority.pending && authority.pending.revision !== (authority.current?.revision ?? 0) + 1) {
    throw new Error("pending transaction head revision is not the next maximum revision");
  }
}

function headMac(options: {
  authority: RemoteTransactionHeadAuthority;
  transactionToken: string;
  integrityKey: Buffer;
  integrityKeyId: string;
  headDirectory: string;
  version: number;
}): Buffer {
  return createHmac("sha256", options.integrityKey)
    .update(
      Buffer.from(
        JSON.stringify([
          REMOTE_TRANSACTION_HEAD_MAC_DOMAIN,
          options.version,
          REMOTE_TRANSACTION_RECORD_ALGORITHM,
          options.integrityKeyId,
          options.headDirectory,
          options.transactionToken,
          options.authority.current,
          options.authority.pending,
          options.authority.retired,
        ]),
        "utf8",
      ),
    )
    .digest();
}

function recordMac(options: {
  transactionToken: string;
  payload: Buffer;
  version: number;
  revision: number;
  integrityKey: Buffer;
  integrityKeyId: string;
  directory: string;
}): Buffer {
  const header = Buffer.from(
    JSON.stringify([
      REMOTE_TRANSACTION_RECORD_MAC_DOMAIN,
      options.version,
      REMOTE_TRANSACTION_RECORD_ALGORITHM,
      options.integrityKeyId,
      options.directory,
      options.transactionToken,
      options.revision,
      options.payload.byteLength,
    ]),
    "utf8",
  );
  return createHmac("sha256", options.integrityKey)
    .update(header)
    .update(Buffer.of(0))
    .update(options.payload)
    .digest();
}
