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

type RemoteTransactionRecordEnvelope = {
  version: number;
  algorithm: typeof REMOTE_TRANSACTION_RECORD_ALGORITHM;
  keyId: string;
  revision: number;
  payload: string;
  mac: string;
};

export type RemoteTransactionExpectedHead = { revision: number; digest: string };

export type SerializedRemoteTransactionRecord = {
  contents: Buffer;
  head: RemoteTransactionExpectedHead;
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
}): { record: RemoteTransactionRecord; head: RemoteTransactionExpectedHead } {
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
