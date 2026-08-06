import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  capturePhysicalDirectoryIdentity,
  samePhysicalDirectoryIdentity,
  type PhysicalDirectoryIdentity,
} from "../browser/filesystemLockDirectoryIdentity.js";
import { syncDirectory } from "../fsDurability.js";
import type {
  WindowsPrivateTreeAuthority,
  WindowsPrivateTreeScope,
} from "./windowsPrivateTreeAcl.js";
import {
  remoteTransactionIntegrityKeyId,
  type RemoteTransactionExpectedHead,
  type SerializedRemoteTransactionRecord,
} from "./transactionRecordEnvelope.js";
import { MAX_REMOTE_TRANSACTION_STORE_BYTES } from "./types.js";

const REMOTE_TRANSACTION_INTEGRITY_KEY_BYTES = 32;

export type RemoteTransactionPublicationCheckpoint =
  | "namespace-publication"
  | "directory-sync"
  | "temp-cleanup";

export type RemoteTransactionPublicationOperation = "begin" | "mutation";

export type RemoteTransactionIntegrityKey = {
  bytes: Buffer;
  keyId: string;
  path: string;
  fileIdentity: BigIntStats;
  directory: string;
  directoryIdentity: PhysicalDirectoryIdentity;
};

export type RemoteTransactionQuarantineEvidence = {
  contents: Buffer | undefined;
  fileIdentity: BigIntStats;
};

export class RemoteTransactionRecordIntegrityError extends Error {
  readonly code = "remote_transaction_record_integrity_failed";

  constructor() {
    super(
      "Remote transaction record failed authenticated validation and cannot authorize recovery",
    );
    this.name = "RemoteTransactionRecordIntegrityError";
  }
}

export class QuarantinableRemoteTransactionRecordIntegrityError extends RemoteTransactionRecordIntegrityError {
  readonly #contents: Buffer | undefined;
  readonly #fileIdentity: BigIntStats;

  constructor(contents: Buffer | undefined, fileIdentity: BigIntStats) {
    super();
    this.#contents = contents;
    this.#fileIdentity = fileIdentity;
  }

  quarantineEvidence(): RemoteTransactionQuarantineEvidence {
    return { contents: this.#contents, fileIdentity: this.#fileIdentity };
  }
}

export async function loadRemoteTransactionIntegrityKey(
  integrityKeyPath: string,
  hasPersistedRecords: boolean,
  options: {
    platform: NodeJS.Platform;
    windowsPrivateTreeAuthority: WindowsPrivateTreeAuthority | undefined;
    windowsPrivateTreeScope: WindowsPrivateTreeScope;
    expectedDirectoryIdentity?: PhysicalDirectoryIdentity;
  },
): Promise<RemoteTransactionIntegrityKey> {
  const directory = path.dirname(integrityKeyPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (options.platform !== "win32") await chmod(directory, 0o700);
  await syncDirectory(directory);
  const directoryIdentity = await capturePhysicalDirectoryIdentity(directory);
  if (
    options.expectedDirectoryIdentity &&
    !samePhysicalDirectoryIdentity(options.expectedDirectoryIdentity, directoryIdentity)
  ) {
    throw new Error("Remote transaction integrity key directory generation changed before key use");
  }
  try {
    return await readRemoteTransactionIntegrityKey(
      integrityKeyPath,
      directory,
      directoryIdentity,
      options.platform,
    );
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
  }
  if (hasPersistedRecords) {
    throw new Error(
      "Remote transaction integrity key is missing; persisted records were preserved and require manual recovery",
    );
  }

  const key = randomBytes(REMOTE_TRANSACTION_INTEGRITY_KEY_BYTES);
  const currentDirectory = await capturePhysicalDirectoryIdentity(directory);
  if (!samePhysicalDirectoryIdentity(currentDirectory, directoryIdentity)) {
    throw new Error(
      "Remote transaction integrity key directory generation changed before creation",
    );
  }
  let handle;
  try {
    handle = await open(integrityKeyPath, "wx", 0o600);
  } catch (error) {
    if (readErrorCode(error) !== "EEXIST") throw error;
    return await readRemoteTransactionIntegrityKey(
      integrityKeyPath,
      directory,
      directoryIdentity,
      options.platform,
    );
  }
  try {
    await handle.writeFile(key);
    if (options.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (options.platform === "win32") {
    await options.windowsPrivateTreeAuthority?.(options.windowsPrivateTreeScope);
  }
  const directoryAfterWrite = await capturePhysicalDirectoryIdentity(directory);
  if (!samePhysicalDirectoryIdentity(directoryAfterWrite, directoryIdentity)) {
    throw new Error(
      "Remote transaction integrity key directory generation changed during creation",
    );
  }
  await syncDirectory(directory);
  return await readRemoteTransactionIntegrityKey(
    integrityKeyPath,
    directory,
    directoryIdentity,
    options.platform,
  );
}

export async function readStableRemoteTransactionRecordBytes(options: {
  targetPath: string;
  platform: NodeJS.Platform;
  maximumEncodedBytes: number;
  assertIntegrityAuthority: () => Promise<void>;
}): Promise<{ contents: Buffer; fileIdentity: BigIntStats }> {
  await options.assertIntegrityAuthority();
  const before = await lstat(options.targetPath, { bigint: true });
  assertPhysicalTransactionRecordFile(before, options.platform);
  const flags =
    options.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(options.targetPath, flags);
  let contents: Buffer | undefined;
  let authenticated: BigIntStats;
  try {
    authenticated = await handle.stat({ bigint: true });
    assertPhysicalTransactionRecordFile(authenticated, options.platform);
    if (!samePhysicalFile(before, authenticated)) {
      throw new RemoteTransactionRecordIntegrityError();
    }
    const maximumEncodedBytes = Math.min(
      options.maximumEncodedBytes,
      MAX_REMOTE_TRANSACTION_STORE_BYTES,
    );
    if (authenticated.size <= BigInt(maximumEncodedBytes)) {
      contents = Buffer.allocUnsafe(Number(authenticated.size));
      let offset = 0;
      while (offset < contents.byteLength) {
        const { bytesRead } = await handle.read(
          contents,
          offset,
          contents.byteLength - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== contents.byteLength) {
        throw new RemoteTransactionRecordIntegrityError();
      }
    }
    const afterRead = await handle.stat({ bigint: true });
    assertPhysicalTransactionRecordFile(afterRead, options.platform);
    if (!samePhysicalFile(authenticated, afterRead)) {
      throw new RemoteTransactionRecordIntegrityError();
    }
    authenticated = afterRead;
  } finally {
    await handle.close();
  }
  const namedAfterRead = await lstat(options.targetPath, { bigint: true });
  assertPhysicalTransactionRecordFile(namedAfterRead, options.platform);
  if (!samePhysicalFile(authenticated, namedAfterRead)) {
    throw new RemoteTransactionRecordIntegrityError();
  }
  await options.assertIntegrityAuthority();
  if (contents === undefined) {
    throw new QuarantinableRemoteTransactionRecordIntegrityError(undefined, namedAfterRead);
  }
  return { contents, fileIdentity: namedAfterRead };
}

export async function publishSerializedRecord(options: {
  mode: "create" | "replace";
  directory: string;
  targetPath: string;
  transactionToken: string;
  serialized: SerializedRemoteTransactionRecord;
  platform: NodeJS.Platform;
  maximumEncodedBytes: number;
  expectedHeads: Map<string, RemoteTransactionExpectedHead>;
  assertIntegrityAuthority: () => Promise<void>;
  underMaintenance: (publish: () => Promise<void>) => Promise<void>;
  afterRecordPublication?: (
    operation: RemoteTransactionPublicationOperation,
    checkpoint: RemoteTransactionPublicationCheckpoint,
  ) => Promise<void>;
}): Promise<void> {
  const operation = options.mode === "create" ? "begin" : "mutation";
  const tempPath = path.join(
    options.directory,
    `.${options.transactionToken}.${process.pid}.${randomUUID()}.tmp`,
  );
  let published = false;
  if (options.mode === "create") {
    options.expectedHeads.set(options.transactionToken, { revision: 0, digest: "" });
  }
  try {
    await options.underMaintenance(async () => {
      try {
        await options.assertIntegrityAuthority();
        const handle = await open(tempPath, "wx", 0o600);
        try {
          await handle.writeFile(options.serialized.contents);
          if (options.platform !== "win32") await handle.chmod(0o600);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await options.assertIntegrityAuthority();
        if (options.mode === "create") {
          await link(tempPath, options.targetPath);
        } else {
          await rename(tempPath, options.targetPath);
        }
        published = true;
        options.expectedHeads.set(options.transactionToken, options.serialized.head);
        await options.afterRecordPublication?.(operation, "namespace-publication");
        await options.assertIntegrityAuthority();
        await options.afterRecordPublication?.(operation, "directory-sync");
        await syncDirectory(options.directory);
      } finally {
        await options.assertIntegrityAuthority();
        await options.afterRecordPublication?.(operation, "temp-cleanup");
        if (options.mode === "create") {
          await rm(tempPath, { force: true });
          await options.assertIntegrityAuthority();
          await syncDirectory(options.directory);
        } else {
          await rm(tempPath, { force: true }).catch(() => undefined);
        }
      }
    });
  } catch (error) {
    if (published) {
      if (options.mode === "create") {
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
      await reconcilePublishedHead(options);
    } else if (options.mode === "create") {
      options.expectedHeads.delete(options.transactionToken);
    }
    throw error;
  }
}

export function isPhysicalTransactionRecordFile(
  entry: BigIntStats,
  platform: NodeJS.Platform,
): boolean {
  return (
    entry.isFile() &&
    !entry.isSymbolicLink() &&
    entry.nlink === 1n &&
    (platform === "win32" || ((entry.mode & 0o777n) === 0o600n && isOwnedByControllerUser(entry)))
  );
}

export function assertPhysicalTransactionRecordFile(
  entry: BigIntStats,
  platform: NodeJS.Platform,
): void {
  if (!isPhysicalTransactionRecordFile(entry, platform)) {
    throw new RemoteTransactionRecordIntegrityError();
  }
}

export function assertProtectedIntegrityKeyFile(
  entry: BigIntStats,
  platform: NodeJS.Platform,
): void {
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n) {
    throw new Error("Remote transaction integrity key is not a singly linked physical file");
  }
  if (platform === "win32") return;
  if ((entry.mode & 0o777n) !== 0o600n) {
    throw new Error("Remote transaction integrity key permissions must be 0600");
  }
  if (!isOwnedByControllerUser(entry)) {
    throw new Error("Remote transaction integrity key must be owned by the controller user");
  }
}

function isOwnedByControllerUser(entry: BigIntStats): boolean {
  const currentUserId = process.geteuid?.() ?? process.getuid?.();
  return currentUserId === undefined || entry.uid === BigInt(currentUserId);
}

export function sameQuarantineEvidence(
  left: RemoteTransactionQuarantineEvidence,
  right: RemoteTransactionQuarantineEvidence,
): boolean {
  return (
    sameFileGeneration(left.fileIdentity, right.fileIdentity) &&
    left.fileIdentity.size === right.fileIdentity.size &&
    left.fileIdentity.mtimeNs === right.fileIdentity.mtimeNs &&
    left.fileIdentity.mode === right.fileIdentity.mode &&
    left.fileIdentity.nlink === right.fileIdentity.nlink &&
    (left.contents === undefined
      ? right.contents === undefined
      : right.contents !== undefined && left.contents.equals(right.contents))
  );
}

export function sameFileGeneration(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

export function samePhysicalFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink
  );
}

export function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function readRemoteTransactionIntegrityKey(
  integrityKeyPath: string,
  directory: string,
  directoryIdentity: PhysicalDirectoryIdentity,
  platform: NodeJS.Platform,
): Promise<RemoteTransactionIntegrityKey> {
  const before = await lstat(integrityKeyPath, { bigint: true });
  assertProtectedIntegrityKeyFile(before, platform);
  const flags =
    platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(integrityKeyPath, flags);
  let bytes: Buffer;
  let authenticated: BigIntStats;
  try {
    authenticated = await handle.stat({ bigint: true });
    assertProtectedIntegrityKeyFile(authenticated, platform);
    if (!samePhysicalFile(before, authenticated)) {
      throw new Error("Remote transaction integrity key changed before authenticated read");
    }
    bytes = await handle.readFile();
    const afterRead = await handle.stat({ bigint: true });
    assertProtectedIntegrityKeyFile(afterRead, platform);
    if (!samePhysicalFile(authenticated, afterRead)) {
      throw new Error("Remote transaction integrity key changed during authenticated read");
    }
    authenticated = afterRead;
  } finally {
    await handle.close();
  }
  const namedAfterRead = await lstat(integrityKeyPath, { bigint: true });
  assertProtectedIntegrityKeyFile(namedAfterRead, platform);
  if (!samePhysicalFile(authenticated, namedAfterRead)) {
    throw new Error("Remote transaction integrity key pathname changed during authenticated read");
  }
  const currentDirectory = await capturePhysicalDirectoryIdentity(directory);
  if (!samePhysicalDirectoryIdentity(currentDirectory, directoryIdentity)) {
    throw new Error("Remote transaction integrity key directory generation changed during read");
  }
  if (bytes.byteLength !== REMOTE_TRANSACTION_INTEGRITY_KEY_BYTES) {
    throw new Error("Remote transaction integrity key must contain exactly 32 bytes");
  }
  return {
    bytes,
    keyId: remoteTransactionIntegrityKeyId(bytes),
    path: integrityKeyPath,
    fileIdentity: namedAfterRead,
    directory,
    directoryIdentity,
  };
}

async function reconcilePublishedHead(options: {
  targetPath: string;
  transactionToken: string;
  serialized: SerializedRemoteTransactionRecord;
  platform: NodeJS.Platform;
  maximumEncodedBytes: number;
  expectedHeads: Map<string, RemoteTransactionExpectedHead>;
  assertIntegrityAuthority: () => Promise<void>;
}): Promise<void> {
  try {
    const authenticated = await readStableRemoteTransactionRecordBytes({
      targetPath: options.targetPath,
      platform: options.platform,
      maximumEncodedBytes: options.maximumEncodedBytes,
      assertIntegrityAuthority: options.assertIntegrityAuthority,
    });
    const digest = createHash("sha256").update(authenticated.contents).digest("hex");
    if (
      digest === options.serialized.head.digest &&
      authenticated.contents.equals(options.serialized.contents)
    ) {
      options.expectedHeads.set(options.transactionToken, options.serialized.head);
    }
  } catch {
    // Preserve the publication error. The committed head remains fail-closed until a later read
    // can re-authenticate the exact named bytes or reject a changed generation.
  }
}
