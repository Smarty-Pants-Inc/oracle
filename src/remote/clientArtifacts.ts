import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
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

interface ArtifactFileIdentity {
  dev: number;
  ino: number;
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

export async function transferRemoteArtifact(params: {
  hostname: string;
  port: number;
  token?: string;
  descriptor: RemoteArtifactDescriptor;
  transactionToken: string;
  sessionId: string;
  log?: BrowserRunOptions["log"];
  deadlines: ResolvedRemoteTransportDeadlines;
}): Promise<SavedBrowserFile> {
  RemoteArtifactDescriptorSchema.parse(params.descriptor);
  assertRemoteTransactionToken(params.transactionToken);
  const artifactsDir = resolveSessionArtifactsDir(params.sessionId);
  await mkdir(artifactsDir, { recursive: true });
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

  let verified: { size: number; sha256: string } | null;
  try {
    verified = await verifyAndSyncArtifactFile(finalPath, params.descriptor);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      verified = null;
    } else if (error instanceof ArtifactDescriptorMismatchError) {
      await quarantineStaleArtifactFile(finalPath, error.identity);
      verified = null;
    } else {
      throw error;
    }
  }
  if (verified) {
    await syncDirectory(artifactsDir);
    params.log?.(`[browser] Reusing verified artifact ${sourceFilename}.`);
  } else {
    await rm(partPath, { force: true }).catch(() => undefined);
    params.log?.(`[browser] Transferring artifact ${sourceFilename} from bridge host...`);
    await downloadArtifactToFile({
      hostname: params.hostname,
      port: params.port,
      path: artifactPath,
      token: params.token,
      targetPath: partPath,
      descriptor: params.descriptor,
      deadlines: params.deadlines,
    }).catch(async (error) => {
      await rm(partPath, { force: true }).catch(() => undefined);
      throw error;
    });
    try {
      await verifyAndSyncArtifactFile(partPath, params.descriptor);
      await rename(partPath, finalPath);
      await syncDirectory(artifactsDir);
      verified = await verifyAndSyncArtifactFile(finalPath, params.descriptor);
    } catch (error) {
      await rm(partPath, { force: true }).catch(() => undefined);
      throw error;
    }
    params.log?.(`[browser] Transferred artifact to ${finalPath}`);
  }
  if (!verified) throw new Error("artifact durability verification did not complete");

  const validation = await validateArtifactFile({
    path: finalPath,
    filename: sourceFilename,
    mimeType: sanitizeArtifactMimeType(params.descriptor.mimeType),
  });
  if (!validation.ok) {
    throw new Error(`${validation.type} validation failed: ${validation.error ?? "invalid"}`);
  }
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
}): Promise<void> {
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
      const handle = await open(params.targetPath, "wx", 0o600);
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
      } finally {
        await handle.close();
      }
    },
  );
}

async function verifyAndSyncArtifactFile(
  artifactPath: string,
  descriptor: RemoteArtifactDescriptor,
): Promise<{ size: number; sha256: string }> {
  const entry = await lstat(artifactPath);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
    throw new Error("local artifact cache path is not an unlinked regular file");
  }
  const identity = { dev: entry.dev, ino: entry.ino };
  const handle = await open(artifactPath, "r+");
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.dev !== identity.dev ||
      before.ino !== identity.ino
    ) {
      throw new Error("local artifact cache path changed before durability verification");
    }
    if (before.size !== descriptor.byteSize) {
      throw new ArtifactDescriptorMismatchError(
        "local artifact size does not match the durable descriptor",
        identity,
      );
    }
    const hash = createHash("sha256");
    const input = handle.createReadStream({ autoClose: false, start: 0 });
    for await (const chunk of input) hash.update(chunk);
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== before.nlink ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error("local artifact changed during durability verification");
    }
    const sha256 = hash.digest("hex");
    if (sha256 !== descriptor.sha256) {
      throw new ArtifactDescriptorMismatchError(
        "local artifact sha256 does not match the durable descriptor",
        identity,
      );
    }
    await handle.chmod(0o600);
    await handle.sync();
    return { size: after.size, sha256 };
  } finally {
    await handle.close();
  }
}

async function quarantineStaleArtifactFile(
  artifactPath: string,
  expectedIdentity: ArtifactFileIdentity,
): Promise<void> {
  const entry = await lstat(artifactPath).catch((error) => {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (entry === null) return;
  if (
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    entry.nlink !== 1 ||
    entry.dev !== expectedIdentity.dev ||
    entry.ino !== expectedIdentity.ino
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

  const quarantined = await lstat(quarantinePath);
  if (
    quarantined.isSymbolicLink() ||
    !quarantined.isFile() ||
    quarantined.nlink !== 1 ||
    quarantined.dev !== expectedIdentity.dev ||
    quarantined.ino !== expectedIdentity.ino
  ) {
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
