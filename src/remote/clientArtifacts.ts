import { createHash, randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { link, lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import type { BrowserRunOptions, BrowserRunResult } from "../browserMode.js";
import type { SavedBrowserFile } from "../browser/types.js";
import {
  appendArtifacts,
  resolveSessionArtifactsDir,
  sanitizeArtifactFilename,
  sanitizeArtifactMimeType,
  validateArtifactFile,
} from "../browser/artifacts.js";
import { readErrorCode, syncDirectory } from "../fsDurability.js";
import {
  MAX_REMOTE_ARTIFACT_BYTES,
  RemoteArtifactDeliveryReceiptRequestSchema,
  RemoteArtifactManualCopyWaiverRequestSchema,
  RemoteArtifactDescriptorSchema,
  type RemoteArtifactDescriptor,
} from "./types.js";
import {
  consumeRemoteGet,
  postRemoteJson,
  type ResolvedRemoteTransportDeadlines,
} from "./clientTransport.js";
import { assertRemoteTransactionToken } from "./transactionToken.js";
import {
  establishWindowsPrivateDirectories,
  initializeWindowsPrivateFile,
  verifyWindowsPrivateFile,
  type WindowsPrivateDirectoriesAuthority,
  type WindowsPrivateFileInitializationAuthority,
  type WindowsPrivateFileVerificationAuthority,
} from "../windowsPrivateFileAcl.js";
import {
  physicalFileSnapshotFromStats,
  samePhysicalFileGeneration,
  samePhysicalFileSnapshot,
  type PhysicalFileSnapshot,
} from "../physicalFileIdentity.js";

type ArtifactFileIdentity = PhysicalFileSnapshot;

export interface TransferRemoteArtifactDeps {
  readonly afterHashVerification?: (finalPath: string) => Promise<void>;
  readonly windowsPrivateDirectoriesAuthority?: WindowsPrivateDirectoriesAuthority;
  readonly windowsPrivateFileInitializationAuthority?: WindowsPrivateFileInitializationAuthority;
  readonly windowsPrivateFileVerificationAuthority?: WindowsPrivateFileVerificationAuthority;
}

interface ArtifactFileAuthorities {
  readonly directories: WindowsPrivateDirectoriesAuthority;
  readonly initialize: WindowsPrivateFileInitializationAuthority;
  readonly verify: WindowsPrivateFileVerificationAuthority;
}

function resolveArtifactFileAuthorities(deps: TransferRemoteArtifactDeps): ArtifactFileAuthorities {
  return {
    directories: deps.windowsPrivateDirectoriesAuthority ?? establishWindowsPrivateDirectories,
    initialize: deps.windowsPrivateFileInitializationAuthority ?? initializeWindowsPrivateFile,
    verify: deps.windowsPrivateFileVerificationAuthority ?? verifyWindowsPrivateFile,
  };
}

function isSinglyLinkedRegularFile(entry: BigIntStats): boolean {
  return !entry.isSymbolicLink() && entry.isFile() && entry.nlink === 1n;
}

class ArtifactDescriptorMismatchError extends Error {
  constructor(
    message: string,
    readonly identity: ArtifactFileIdentity,
  ) {
    super(message);
    this.name = "ArtifactDescriptorMismatchError";
  }
}

export async function transferRemoteArtifact(
  params: {
    hostname: string;
    port: number;
    token?: string;
    descriptor: RemoteArtifactDescriptor;
    transactionToken: string;
    sessionId: string;
    log?: BrowserRunOptions["log"];
    deadlines: ResolvedRemoteTransportDeadlines;
  },
  deps: TransferRemoteArtifactDeps = {},
): Promise<SavedBrowserFile> {
  RemoteArtifactDescriptorSchema.parse(params.descriptor);
  assertRemoteTransactionToken(params.transactionToken);
  const artifactsDir = resolveSessionArtifactsDir(params.sessionId);
  const authorities = resolveArtifactFileAuthorities(deps);
  await establishArtifactDestinationDirectories(artifactsDir, authorities);
  await syncDirectory(path.dirname(artifactsDir));
  const sourceFilename = sanitizeArtifactFilename(
    params.descriptor.filename,
    `artifact-${params.descriptor.artifactId}.bin`,
  );
  const extension = path.extname(sourceFilename).slice(0, 16);
  const publishedFilename = `artifact-${params.descriptor.artifactId}${extension}`;
  const finalPath = path.join(artifactsDir, publishedFilename);
  const partPath = `${finalPath}.part`;
  const artifactPath = `/transactions/${encodeURIComponent(params.transactionToken)}/artifacts/${encodeURIComponent(
    params.descriptor.artifactId,
  )}`;

  let verified: { size: number; sha256: string; identity: ArtifactFileIdentity } | null;
  try {
    verified = await verifyAndSyncArtifactFile(finalPath, params.descriptor, authorities);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      verified = null;
    } else if (error instanceof ArtifactDescriptorMismatchError) {
      await quarantineStaleArtifactFile(finalPath, error.identity, authorities);
      verified = null;
    } else {
      throw error;
    }
  }
  if (verified) {
    await syncDirectory(artifactsDir);
    params.log?.(`[browser] Reusing verified artifact ${sourceFilename}.`);
  } else {
    params.log?.(`[browser] Transferring artifact ${sourceFilename} from bridge host...`);
    const downloadedIdentity = await downloadArtifactToFile({
      hostname: params.hostname,
      port: params.port,
      path: artifactPath,
      token: params.token,
      targetPath: partPath,
      descriptor: params.descriptor,
      deadlines: params.deadlines,
      authorities,
    });
    try {
      const partVerified = await verifyAndSyncArtifactFile(
        partPath,
        params.descriptor,
        authorities,
        downloadedIdentity,
      );
      await link(partPath, finalPath);
      await unlink(partPath);
      await syncDirectory(artifactsDir);
      verified = await verifyAndSyncArtifactFile(
        finalPath,
        params.descriptor,
        authorities,
        partVerified.identity,
      );
    } catch (error) {
      await removeArtifactPathIfIdentity(partPath, downloadedIdentity, authorities);
      throw error;
    }
    params.log?.(`[browser] Transferred artifact to ${finalPath}`);
  }
  if (!verified) throw new Error("artifact durability verification did not complete");

  await deps.afterHashVerification?.(finalPath);
  const validation = await validateArtifactFile({
    path: finalPath,
    filename: sourceFilename,
    mimeType: sanitizeArtifactMimeType(params.descriptor.mimeType),
  });
  if (!validation.ok) {
    throw new Error(`${validation.type} validation failed: ${validation.error ?? "invalid"}`);
  }
  await assertArtifactPathSnapshot(
    finalPath,
    verified.identity,
    "local artifact cache generation changed after validation",
    authorities,
  );
  const receipt = await postRemoteJson({
    hostname: params.hostname,
    port: params.port,
    path: `/transactions/${encodeURIComponent(params.transactionToken)}/artifacts/${encodeURIComponent(
      params.descriptor.artifactId,
    )}/receipt`,
    token: params.token,
    body: RemoteArtifactDeliveryReceiptRequestSchema.parse({
      sha256: verified.sha256,
      byteSize: verified.size,
    }),
    overallTimeoutMs: params.deadlines.controlOverallTimeoutMs,
    idleTimeoutMs: params.deadlines.socketIdleTimeoutMs,
    operation: "Remote artifact receipt request",
  });
  if (receipt.statusCode < 200 || receipt.statusCode >= 300) {
    throw new Error(receipt.errorMessage);
  }

  return {
    kind: "file",
    path: finalPath,
    label: sourceFilename,
    mimeType: sanitizeArtifactMimeType(params.descriptor.mimeType),
    sizeBytes: verified.size,
    sourceUrl: "bridge-artifact",
    sha256: verified.sha256,
    fileIdentity: verified.identity,
    validation,
    transfer: { status: "completed", bytes: verified.size },
    origin: { mode: "bridge" },
    url: "bridge-artifact",
    finalUrl: "bridge-artifact",
    filename: publishedFilename,
  };
}

export async function waiveRemoteArtifactDelivery(params: {
  hostname: string;
  port: number;
  token?: string;
  descriptor: RemoteArtifactDescriptor;
  transactionToken: string;
  deadlines: ResolvedRemoteTransportDeadlines;
}): Promise<void> {
  RemoteArtifactDescriptorSchema.parse(params.descriptor);
  assertRemoteTransactionToken(params.transactionToken);
  const response = await postRemoteJson({
    hostname: params.hostname,
    port: params.port,
    path: `/transactions/${encodeURIComponent(params.transactionToken)}/artifacts/${encodeURIComponent(
      params.descriptor.artifactId,
    )}/manual-copy-waiver`,
    token: params.token,
    body: RemoteArtifactManualCopyWaiverRequestSchema.parse({
      sha256: params.descriptor.sha256,
      byteSize: params.descriptor.byteSize,
    }),
    overallTimeoutMs: params.deadlines.controlOverallTimeoutMs,
    idleTimeoutMs: params.deadlines.socketIdleTimeoutMs,
    operation: "Remote artifact manual-copy waiver request",
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(response.errorMessage);
  }
}

async function downloadArtifactToFile(params: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  targetPath: string;
  descriptor: RemoteArtifactDescriptor;
  deadlines: ResolvedRemoteTransportDeadlines;
  authorities: ArtifactFileAuthorities;
}): Promise<ArtifactFileIdentity> {
  let downloadedIdentity: ArtifactFileIdentity | undefined;
  await consumeRemoteGet(
    {
      hostname: params.hostname,
      port: params.port,
      path: params.path,
      token: params.token,
      overallTimeoutMs: params.deadlines.artifactOverallTimeoutMs,
      idleTimeoutMs: params.deadlines.socketIdleTimeoutMs,
      operation: "Remote artifact download",
    },
    async (res) => {
      const headerSha = String(res.headers["x-oracle-artifact-sha256"] ?? "");
      if (headerSha && headerSha !== params.descriptor.sha256) {
        res.resume();
        throw new Error("artifact sha256 header mismatch");
      }
      const contentLengthHeader = res.headers["content-length"];
      const contentLength =
        typeof contentLengthHeader === "string" ? Number(contentLengthHeader) : undefined;
      if (
        contentLength !== undefined &&
        (!Number.isSafeInteger(contentLength) ||
          contentLength <= 0 ||
          contentLength > MAX_REMOTE_ARTIFACT_BYTES ||
          contentLength !== params.descriptor.byteSize)
      ) {
        res.resume();
        throw new Error("artifact content-length mismatch");
      }
      const opened = await openArtifactDownloadTarget(params.targetPath, params.authorities);
      const { handle, identity } = opened;
      try {
        let receivedBytes = 0;
        for await (const value of res) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          receivedBytes += chunk.length;
          if (
            receivedBytes > params.descriptor.byteSize ||
            receivedBytes > MAX_REMOTE_ARTIFACT_BYTES
          ) {
            throw new Error("artifact exceeded declared size");
          }
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
            if (bytesWritten <= 0) throw new Error("artifact write made no progress");
            offset += bytesWritten;
          }
        }
        if (receivedBytes !== params.descriptor.byteSize) {
          throw new Error("artifact size did not match the durable descriptor");
        }
        await handle.sync();
        const completedStat = await handle.stat({ bigint: true });
        const completedIdentity = physicalFileSnapshotFromStats(completedStat);
        if (
          !isSinglyLinkedRegularFile(completedStat) ||
          completedStat.size !== BigInt(receivedBytes) ||
          !samePhysicalFileGeneration(completedIdentity, identity)
        ) {
          throw new Error("artifact download target changed before publication");
        }
        await assertOpenArtifactFileSnapshot(
          handle,
          params.targetPath,
          completedIdentity,
          "artifact download target changed before publication",
        );
        if (process.platform === "win32") {
          await params.authorities.verify(params.targetPath);
          await assertOpenArtifactFileSnapshot(
            handle,
            params.targetPath,
            completedIdentity,
            "artifact download target changed during Windows ACL verification",
          );
        }
        downloadedIdentity = completedIdentity;
      } finally {
        await handle.close();
        if (!downloadedIdentity) {
          await removeArtifactPathIfIdentity(params.targetPath, identity, params.authorities);
        }
      }
    },
  );
  if (!downloadedIdentity) throw new Error("artifact download identity was not established");
  return downloadedIdentity;
}

async function establishArtifactDestinationDirectories(
  artifactsDirectory: string,
  authorities: ArtifactFileAuthorities,
): Promise<void> {
  if (process.platform !== "win32") {
    await mkdir(artifactsDirectory, { recursive: true });
    return;
  }
  await mkdir(path.dirname(artifactsDirectory), { recursive: true });
  await authorities.directories([artifactsDirectory]);
}

async function openArtifactDownloadTarget(
  targetPath: string,
  authorities: ArtifactFileAuthorities,
): Promise<{
  handle: FileHandle;
  identity: ArtifactFileIdentity;
}> {
  if (process.platform === "win32" && !(await authorities.initialize(targetPath))) {
    throw new Error("Windows private artifact download target already exists");
  }
  const handle = await open(targetPath, process.platform === "win32" ? "r+" : "wx", 0o600);
  try {
    const fileStat = await handle.stat({ bigint: true });
    const identity = physicalFileSnapshotFromStats(fileStat);
    if (!isSinglyLinkedRegularFile(fileStat) || fileStat.size !== 0n) {
      throw new Error("artifact download target is not an empty unlinked regular file");
    }
    await assertOpenArtifactFileIdentity(handle, targetPath, identity);
    if (process.platform === "win32") {
      await authorities.verify(targetPath);
      await assertOpenArtifactFileIdentity(handle, targetPath, identity);
    }
    return { handle, identity };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertOpenArtifactFileIdentity(
  handle: FileHandle,
  targetPath: string,
  expectedIdentity: ArtifactFileIdentity,
): Promise<void> {
  const [openStat, pathStat] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(targetPath, { bigint: true }),
  ]);
  if (
    !isSinglyLinkedRegularFile(openStat) ||
    !isSinglyLinkedRegularFile(pathStat) ||
    !samePhysicalFileGeneration(physicalFileSnapshotFromStats(openStat), expectedIdentity) ||
    !samePhysicalFileGeneration(physicalFileSnapshotFromStats(pathStat), expectedIdentity)
  ) {
    throw new Error("local artifact cache path changed during private file verification");
  }
}

async function assertOpenArtifactFileSnapshot(
  handle: FileHandle,
  targetPath: string,
  expectedIdentity: ArtifactFileIdentity,
  message: string,
): Promise<void> {
  const [openStat, pathStat] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(targetPath, { bigint: true }),
  ]);
  if (
    !isSinglyLinkedRegularFile(openStat) ||
    !isSinglyLinkedRegularFile(pathStat) ||
    !samePhysicalFileSnapshot(physicalFileSnapshotFromStats(openStat), expectedIdentity) ||
    !samePhysicalFileSnapshot(physicalFileSnapshotFromStats(pathStat), expectedIdentity)
  ) {
    throw new Error(message);
  }
}

async function assertArtifactPathSnapshot(
  targetPath: string,
  expectedIdentity: ArtifactFileIdentity,
  message: string,
  authorities: ArtifactFileAuthorities,
): Promise<void> {
  if (process.platform === "win32") await authorities.verify(targetPath);
  const entry = await lstat(targetPath, { bigint: true });
  if (
    !isSinglyLinkedRegularFile(entry) ||
    !samePhysicalFileSnapshot(physicalFileSnapshotFromStats(entry), expectedIdentity)
  ) {
    throw new Error(message);
  }
}

async function removeArtifactPathIfIdentity(
  targetPath: string,
  expectedIdentity: ArtifactFileIdentity,
  authorities: ArtifactFileAuthorities,
): Promise<void> {
  const entry = await lstat(targetPath, { bigint: true }).catch((error) => {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (
    !entry ||
    !isSinglyLinkedRegularFile(entry) ||
    !samePhysicalFileGeneration(physicalFileSnapshotFromStats(entry), expectedIdentity)
  ) {
    return;
  }

  const quarantinePath = `${targetPath}.cleanup-${randomBytes(12).toString("hex")}`;
  try {
    await rename(targetPath, quarantinePath);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return;
    throw error;
  }
  const quarantined = await lstat(quarantinePath, { bigint: true });
  if (
    !isSinglyLinkedRegularFile(quarantined) ||
    !samePhysicalFileGeneration(physicalFileSnapshotFromStats(quarantined), expectedIdentity)
  ) {
    await restoreUnexpectedQuarantinedArtifact(targetPath, quarantinePath, quarantined);
    return;
  }
  if (process.platform === "win32") await authorities.verify(quarantinePath);
  const authenticated = await lstat(quarantinePath, { bigint: true });
  if (
    !isSinglyLinkedRegularFile(authenticated) ||
    !samePhysicalFileGeneration(physicalFileSnapshotFromStats(authenticated), expectedIdentity)
  ) {
    await restoreUnexpectedQuarantinedArtifact(targetPath, quarantinePath, authenticated);
    return;
  }
  await unlink(quarantinePath);
}

async function restoreUnexpectedQuarantinedArtifact(
  targetPath: string,
  quarantinePath: string,
  unexpected: BigIntStats,
): Promise<void> {
  try {
    await link(quarantinePath, targetPath);
  } catch (error) {
    if (readErrorCode(error) === "EEXIST") {
      throw new Error(
        `Local artifact replacement preserved at ${quarantinePath}; its destination is occupied.`,
        { cause: error },
      );
    }
    throw error;
  }
  const restored = await lstat(targetPath, { bigint: true });
  if (
    !samePhysicalFileGeneration(
      physicalFileSnapshotFromStats(restored),
      physicalFileSnapshotFromStats(unexpected),
    )
  ) {
    throw new Error("local artifact replacement changed while being restored");
  }
  await unlink(quarantinePath);
  await syncDirectory(path.dirname(targetPath));
}

async function verifyAndSyncArtifactFile(
  artifactPath: string,
  descriptor: RemoteArtifactDescriptor,
  authorities: ArtifactFileAuthorities,
  expectedIdentity?: ArtifactFileIdentity,
): Promise<{ size: number; sha256: string; identity: ArtifactFileIdentity }> {
  if (process.platform === "win32") await authorities.verify(artifactPath);
  const entry = await lstat(artifactPath, { bigint: true });
  if (!isSinglyLinkedRegularFile(entry)) {
    throw new Error("local artifact cache path is not an unlinked regular file");
  }
  const namedIdentity = physicalFileSnapshotFromStats(entry);
  if (expectedIdentity && !samePhysicalFileGeneration(namedIdentity, expectedIdentity)) {
    throw new Error("local artifact cache physical identity changed during publication");
  }
  const handle = await open(artifactPath, "r+");
  try {
    let before = await handle.stat({ bigint: true });
    if (
      !isSinglyLinkedRegularFile(before) ||
      !samePhysicalFileSnapshot(physicalFileSnapshotFromStats(before), namedIdentity)
    ) {
      throw new Error("local artifact cache path changed before durability verification");
    }
    if (before.size !== BigInt(descriptor.byteSize)) {
      throw new ArtifactDescriptorMismatchError(
        "local artifact size does not match the durable descriptor",
        namedIdentity,
      );
    }
    if (process.platform !== "win32") {
      await handle.chmod(0o600);
      before = await handle.stat({ bigint: true });
      if (
        !isSinglyLinkedRegularFile(before) ||
        before.size !== BigInt(descriptor.byteSize) ||
        !samePhysicalFileGeneration(physicalFileSnapshotFromStats(before), namedIdentity)
      ) {
        throw new Error("local artifact cache changed during private permission enforcement");
      }
    }
    const verifiedIdentity = physicalFileSnapshotFromStats(before);
    await assertOpenArtifactFileSnapshot(
      handle,
      artifactPath,
      verifiedIdentity,
      "local artifact cache path changed before hash verification",
    );

    const hash = createHash("sha256");
    const input = handle.createReadStream({ autoClose: false, start: 0 });
    for await (const chunk of input) hash.update(chunk);
    const after = await handle.stat({ bigint: true });
    const afterIdentity = physicalFileSnapshotFromStats(after);
    if (
      !isSinglyLinkedRegularFile(after) ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      !samePhysicalFileSnapshot(afterIdentity, verifiedIdentity)
    ) {
      throw new Error("local artifact changed during durability verification");
    }
    const sha256 = hash.digest("hex");
    if (sha256 !== descriptor.sha256) {
      throw new ArtifactDescriptorMismatchError(
        "local artifact sha256 does not match the durable descriptor",
        afterIdentity,
      );
    }
    if (process.platform === "win32") await authorities.verify(artifactPath);
    await assertOpenArtifactFileSnapshot(
      handle,
      artifactPath,
      afterIdentity,
      process.platform === "win32"
        ? "local artifact cache path changed during Windows ACL verification"
        : "local artifact cache path changed after hash verification",
    );
    await handle.sync();
    const synced = await handle.stat({ bigint: true });
    const syncedIdentity = physicalFileSnapshotFromStats(synced);
    if (
      !isSinglyLinkedRegularFile(synced) ||
      synced.size !== after.size ||
      synced.mtimeNs !== after.mtimeNs ||
      !samePhysicalFileSnapshot(syncedIdentity, afterIdentity)
    ) {
      throw new Error("local artifact changed during durability synchronization");
    }
    await assertOpenArtifactFileSnapshot(
      handle,
      artifactPath,
      syncedIdentity,
      "local artifact cache path changed after durability synchronization",
    );
    return { size: Number(synced.size), sha256, identity: syncedIdentity };
  } finally {
    await handle.close();
  }
}

async function quarantineStaleArtifactFile(
  artifactPath: string,
  expectedIdentity: ArtifactFileIdentity,
  authorities: ArtifactFileAuthorities,
): Promise<void> {
  const entry = await lstat(artifactPath, { bigint: true }).catch((error) => {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (entry === null) return;
  if (
    !isSinglyLinkedRegularFile(entry) ||
    !samePhysicalFileSnapshot(physicalFileSnapshotFromStats(entry), expectedIdentity)
  ) {
    throw new Error("local artifact cache path changed before stale replacement");
  }

  const quarantinePath = `${artifactPath}.stale-${randomBytes(12).toString("hex")}`;
  try {
    await rename(artifactPath, quarantinePath);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return;
    throw error;
  }

  const quarantined = await lstat(quarantinePath, { bigint: true });
  if (
    !isSinglyLinkedRegularFile(quarantined) ||
    !samePhysicalFileGeneration(physicalFileSnapshotFromStats(quarantined), expectedIdentity)
  ) {
    await restoreUnexpectedQuarantinedArtifact(artifactPath, quarantinePath, quarantined);
    throw new Error("local artifact cache path changed during stale replacement");
  }
  if (process.platform === "win32") await authorities.verify(quarantinePath);
  const authenticated = await lstat(quarantinePath, { bigint: true });
  if (
    !isSinglyLinkedRegularFile(authenticated) ||
    !samePhysicalFileGeneration(physicalFileSnapshotFromStats(authenticated), expectedIdentity)
  ) {
    await restoreUnexpectedQuarantinedArtifact(artifactPath, quarantinePath, authenticated);
    throw new Error("local artifact cache path changed during stale replacement");
  }
  await unlink(quarantinePath);
  await syncDirectory(path.dirname(artifactPath));
}

export function mergeTransferredArtifacts(
  result: BrowserRunResult,
  transferredFiles: SavedBrowserFile[],
  transferFailures: string[],
  host: string,
): BrowserRunResult {
  const artifacts = appendArtifacts(result.artifacts, transferredFiles);
  const savedFiles = appendSavedFiles(result.savedFiles, transferredFiles);
  const warning =
    transferFailures.length > 0
      ? {
          code: "remote-artifact-manual-copy-required",
          severity: "warning" as const,
          message:
            `Oracle captured the browser text response, but automatic local artifact publication failed. Connect to remote browser host ${host}, open the ChatGPT conversation, and copy the generated file(s) manually. No local artifact delivery is claimed for: ${transferFailures.join("; ")}`.slice(
              0,
              32_768,
            ),
        }
      : undefined;
  const merged: BrowserRunResult = {
    ...result,
    warnings: [...(result.warnings ?? []), ...(warning ? [warning] : [])].slice(-64),
  };
  if (artifacts) merged.artifacts = artifacts;
  else delete merged.artifacts;
  if (savedFiles) merged.savedFiles = savedFiles;
  else delete merged.savedFiles;
  if (merged.warnings?.length === 0) delete merged.warnings;
  return merged;
}

function appendSavedFiles(
  existing: SavedBrowserFile[] | undefined,
  additions: SavedBrowserFile[],
): SavedBrowserFile[] | undefined {
  const merged = new Map<string, SavedBrowserFile>();
  for (const artifact of existing ?? []) {
    merged.set(artifact.path, artifact);
  }
  for (const artifact of additions) {
    merged.set(artifact.path, artifact);
  }
  const values = Array.from(merged.values());
  return values.length > 0 ? values : undefined;
}
