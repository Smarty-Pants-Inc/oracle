import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rename, rm, unlink } from "node:fs/promises";
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
const REMOTE_TRANSACTION_CREATE_TEMP_PATTERN =
  /^\.([a-f0-9]{64})\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;

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
  if (options.expectedDirectoryIdentity) {
    const initialDirectoryIdentity = await capturePhysicalDirectoryIdentity(directory);
    if (
      !samePhysicalDirectoryIdentity(options.expectedDirectoryIdentity, initialDirectoryIdentity)
    ) {
      throw new Error(
        "Remote transaction integrity key directory generation changed before key use",
      );
    }
  } else {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
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
    return await readStableRemoteTransactionIntegrityKey(
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
    return await readStableRemoteTransactionIntegrityKey(
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
  return await readStableRemoteTransactionIntegrityKey(
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
  expectedLinkCount?: bigint;
}): Promise<{ contents: Buffer; fileIdentity: BigIntStats }> {
  const expectedLinkCount = options.expectedLinkCount ?? 1n;
  await options.assertIntegrityAuthority();
  const before = await lstat(options.targetPath, { bigint: true });
  assertProtectedTransactionRecordFile(before, options.platform, expectedLinkCount);
  const flags =
    options.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(options.targetPath, flags);
  let contents: Buffer | undefined;
  let authenticated: BigIntStats;
  try {
    authenticated = await handle.stat({ bigint: true });
    assertProtectedTransactionRecordFile(authenticated, options.platform, expectedLinkCount);
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
    assertProtectedTransactionRecordFile(afterRead, options.platform, expectedLinkCount);
    if (!samePhysicalFile(authenticated, afterRead)) {
      throw new RemoteTransactionRecordIntegrityError();
    }
    authenticated = afterRead;
  } finally {
    await handle.close();
  }
  const namedAfterRead = await lstat(options.targetPath, { bigint: true });
  assertProtectedTransactionRecordFile(namedAfterRead, options.platform, expectedLinkCount);
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

export async function repairStaleCreatePublicationAliases(options: {
  directory: string;
  platform: NodeJS.Platform;
  assertIntegrityAuthority: () => Promise<void>;
  authenticateTarget: (
    targetPath: string,
    transactionToken: string,
    expectedLinkCount: bigint,
  ) => Promise<{ contents: Buffer; fileIdentity: BigIntStats }>;
}): Promise<void> {
  await options.assertIntegrityAuthority();
  const candidates = new Map<string, string>();
  for (const name of await readdir(options.directory)) {
    const transactionToken = REMOTE_TRANSACTION_CREATE_TEMP_PATTERN.exec(name)?.[1];
    if (!transactionToken) continue;
    if (candidates.has(transactionToken)) {
      throw new RemoteTransactionRecordIntegrityError();
    }
    candidates.set(transactionToken, name);
  }

  for (const [transactionToken, name] of [...candidates].sort()) {
    const tempPath = path.join(options.directory, name);
    const targetPath = path.join(options.directory, `${transactionToken}.json`);
    const tempBefore = await lstat(tempPath, { bigint: true });
    const targetBefore = await lstat(targetPath, { bigint: true });
    if (
      !isProtectedTransactionRecordFile(tempBefore, options.platform, 2n) ||
      !isProtectedTransactionRecordFile(targetBefore, options.platform, 2n) ||
      !samePhysicalFile(tempBefore, targetBefore)
    ) {
      throw new RemoteTransactionRecordIntegrityError();
    }

    const authenticatedBeforeUnlink = await options.authenticateTarget(
      targetPath,
      transactionToken,
      2n,
    );
    await options.assertIntegrityAuthority();
    const tempConfirmed = await lstat(tempPath, { bigint: true });
    const targetConfirmed = await lstat(targetPath, { bigint: true });
    if (
      !samePhysicalFile(tempBefore, tempConfirmed) ||
      !samePhysicalFile(targetBefore, targetConfirmed) ||
      !samePhysicalFile(tempConfirmed, targetConfirmed) ||
      !samePhysicalFile(authenticatedBeforeUnlink.fileIdentity, targetConfirmed)
    ) {
      throw new RemoteTransactionRecordIntegrityError();
    }

    await unlink(tempPath);
    await options.assertIntegrityAuthority();
    const targetAfterUnlink = await lstat(targetPath, { bigint: true });
    if (
      !isPhysicalTransactionRecordFile(targetAfterUnlink, options.platform) ||
      !sameFileGeneration(authenticatedBeforeUnlink.fileIdentity, targetAfterUnlink)
    ) {
      throw new RemoteTransactionRecordIntegrityError();
    }
    const authenticatedAfterUnlink = await options.authenticateTarget(
      targetPath,
      transactionToken,
      1n,
    );
    if (
      !samePhysicalFile(targetAfterUnlink, authenticatedAfterUnlink.fileIdentity) ||
      !sameFileGeneration(
        authenticatedBeforeUnlink.fileIdentity,
        authenticatedAfterUnlink.fileIdentity,
      ) ||
      !authenticatedBeforeUnlink.contents.equals(authenticatedAfterUnlink.contents)
    ) {
      throw new RemoteTransactionRecordIntegrityError();
    }
    await syncDirectory(options.directory);
  }
}

export function isPhysicalTransactionRecordFile(
  entry: BigIntStats,
  platform: NodeJS.Platform,
): boolean {
  return isProtectedTransactionRecordFile(entry, platform, 1n);
}

function isProtectedTransactionRecordFile(
  entry: BigIntStats,
  platform: NodeJS.Platform,
  linkCount: bigint,
): boolean {
  return (
    entry.isFile() &&
    !entry.isSymbolicLink() &&
    entry.nlink === linkCount &&
    (platform === "win32" || ((entry.mode & 0o777n) === 0o600n && isOwnedByControllerUser(entry)))
  );
}

export function assertPhysicalTransactionRecordFile(
  entry: BigIntStats,
  platform: NodeJS.Platform,
): void {
  assertProtectedTransactionRecordFile(entry, platform, 1n);
}

function assertProtectedTransactionRecordFile(
  entry: BigIntStats,
  platform: NodeJS.Platform,
  linkCount: bigint,
): void {
  if (!isProtectedTransactionRecordFile(entry, platform, linkCount)) {
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

export async function readStableRemoteTransactionIntegrityKey(
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
