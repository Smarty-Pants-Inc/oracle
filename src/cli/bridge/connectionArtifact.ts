import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BridgeConnectionArtifact } from "../../bridge/connection.js";
import {
  capturePhysicalDirectoryIdentity,
  samePhysicalDirectoryIdentity,
  type PhysicalDirectoryIdentity,
} from "../../browser/filesystemLockDirectoryIdentity.js";
import { syncDirectoryIfPresent } from "../../fsDurability.js";
import { writeFileAtomicDurable } from "../../sessionManager.js";
import {
  applyWindowsPrivateFileAcl,
  type WindowsPrivateFileAuthority,
} from "../../windowsPrivateFileAcl.js";

export type ConnectionInput = Pick<
  BridgeConnectionArtifact,
  "remoteHost" | "remoteToken" | "tunnel"
>;

export interface PhysicalFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
}

export interface FileSnapshot {
  contents: Buffer | null;
  fileIdentity: PhysicalFileIdentity | null;
}

export interface PublishedFile {
  readonly directoryIdentity: PhysicalDirectoryIdentity;
  readonly fileIdentity: PhysicalFileIdentity;
}

export interface BridgeConnectionPrivacyOptions {
  readonly platform?: NodeJS.Platform;
  readonly windowsPrivateFileAuthority?: WindowsPrivateFileAuthority;
  readonly deferFailureCleanup?: boolean;
}

export interface BridgeConnectionPublication {
  readonly artifact: BridgeConnectionArtifact;
  readonly publishedFile: PublishedFile;
}

export class BridgeArtifactPublicationError extends Error {
  constructor(
    error: unknown,
    readonly publishedFile: PublishedFile,
  ) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = "BridgeArtifactPublicationError";
  }
}

class BridgePrivateFilePublicationError extends Error {
  constructor(
    readonly originalError: unknown,
    readonly publishedFile: PublishedFile,
  ) {
    super(originalError instanceof Error ? originalError.message : String(originalError), {
      cause: originalError,
    });
    this.name = "BridgePrivateFilePublicationError";
  }
}

function physicalFileIdentityFromStats(entry: BigIntStats): PhysicalFileIdentity {
  return {
    device: entry.dev.toString(),
    inode: entry.ino.toString(),
    birthtimeNs: entry.birthtimeNs.toString(),
  };
}

async function capturePhysicalFileIdentity(filePath: string): Promise<PhysicalFileIdentity | null> {
  try {
    const entry = await fs.lstat(filePath, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Bridge connection artifact is not a physical file: ${filePath}`);
    }
    return physicalFileIdentityFromStats(entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function samePhysicalFileIdentity(
  left: PhysicalFileIdentity,
  right: PhysicalFileIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

export async function capturePublishedFile(filePath: string): Promise<PublishedFile> {
  const [directoryIdentity, fileIdentity] = await Promise.all([
    capturePhysicalDirectoryIdentity(path.dirname(filePath)),
    capturePhysicalFileIdentity(filePath),
  ]);
  if (fileIdentity === null) throw new Error(`Bridge connection artifact disappeared: ${filePath}`);
  return { directoryIdentity, fileIdentity };
}

async function matchesPublishedFile(filePath: string, expected: PublishedFile): Promise<boolean> {
  try {
    const [directoryIdentity, fileIdentity] = await Promise.all([
      capturePhysicalDirectoryIdentity(path.dirname(filePath)),
      capturePhysicalFileIdentity(filePath),
    ]);
    return (
      fileIdentity !== null &&
      samePhysicalDirectoryIdentity(directoryIdentity, expected.directoryIdentity) &&
      samePhysicalFileIdentity(fileIdentity, expected.fileIdentity)
    );
  } catch {
    return false;
  }
}

export function resolveBridgeConnectionArtifactPath(
  requestedPath: string | undefined,
  defaultPath: string,
): string {
  const candidate = requestedPath === undefined ? defaultPath : requestedPath;
  if (candidate.length === 0 || candidate.includes("\0")) {
    throw new Error("Bridge connection artifact path is invalid.");
  }
  return path.resolve(candidate);
}

export async function preflightBridgeConnectionArtifactPath(filePath: string): Promise<void> {
  if (!path.isAbsolute(filePath)) {
    throw new Error("Bridge connection artifact path must be absolute.");
  }
  const directory = path.dirname(filePath);
  try {
    const directoryEntry = await fs.lstat(directory);
    if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
      throw new Error(
        `Bridge connection artifact parent is not a physical directory: ${directory}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await capturePhysicalFileIdentity(filePath);
}

async function prepareBridgeConnectionParent(filePath: string): Promise<PhysicalDirectoryIdentity> {
  await preflightBridgeConnectionArtifactPath(filePath);
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryIdentity = await capturePhysicalDirectoryIdentity(directory);
  await preflightBridgeConnectionArtifactPath(filePath);
  return directoryIdentity;
}

async function assertOpenFileIdentity(
  handle: FileHandle,
  filePath: string,
  expected: PhysicalFileIdentity,
): Promise<void> {
  const [handleIdentity, pathIdentity] = await Promise.all([
    handle.stat({ bigint: true }).then(physicalFileIdentityFromStats),
    capturePhysicalFileIdentity(filePath),
  ]);
  if (
    pathIdentity === null ||
    !samePhysicalFileIdentity(handleIdentity, expected) ||
    !samePhysicalFileIdentity(pathIdentity, expected)
  ) {
    throw new Error(`Bridge connection temporary file changed before publication: ${filePath}`);
  }
}

function assertPrivatePosixFileMode(entry: BigIntStats, filePath: string): void {
  if ((entry.mode & 0o777n) !== 0o600n) {
    throw new Error(`Bridge connection artifact is not mode 0600: ${filePath}`);
  }
}

async function writePrivateConnectionFileAtomicDurable(
  filePath: string,
  data: string | Buffer,
  privacy: BridgeConnectionPrivacyOptions,
): Promise<PublishedFile> {
  const directory = path.dirname(filePath);
  const directoryIdentity = await prepareBridgeConnectionParent(filePath);
  const temporaryPath = path.join(directory, `.oracle-bridge-${randomUUID()}.tmp`);
  const platform =
    privacy.platform === "win32" &&
    (process.platform === "win32" || privacy.windowsPrivateFileAuthority !== undefined)
      ? "win32"
      : process.platform;
  const windowsPrivateFileAuthority =
    privacy.windowsPrivateFileAuthority ?? applyWindowsPrivateFileAcl;
  const expectedContents = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  let handle: FileHandle | undefined;
  let publishedFile: PublishedFile | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    const temporaryIdentity = physicalFileIdentityFromStats(await handle.stat({ bigint: true }));
    await assertOpenFileIdentity(handle, temporaryPath, temporaryIdentity);
    if (platform === "win32") {
      await windowsPrivateFileAuthority({ filePath: temporaryPath, repair: true });
    } else {
      await handle.chmod(0o600);
      assertPrivatePosixFileMode(await handle.stat({ bigint: true }), temporaryPath);
    }
    await assertOpenFileIdentity(handle, temporaryPath, temporaryIdentity);
    await handle.writeFile(expectedContents);
    await handle.sync();
    await assertOpenFileIdentity(handle, temporaryPath, temporaryIdentity);
    await handle.close();
    handle = undefined;

    const [currentDirectoryIdentity, closedTemporaryIdentity] = await Promise.all([
      capturePhysicalDirectoryIdentity(directory),
      capturePhysicalFileIdentity(temporaryPath),
    ]);
    if (
      closedTemporaryIdentity === null ||
      !samePhysicalDirectoryIdentity(currentDirectoryIdentity, directoryIdentity) ||
      !samePhysicalFileIdentity(closedTemporaryIdentity, temporaryIdentity)
    ) {
      throw new Error("Bridge connection destination changed before atomic publication.");
    }

    await fs.rename(temporaryPath, filePath);
    publishedFile = await capturePublishedFile(filePath);
    if (
      !samePhysicalDirectoryIdentity(publishedFile.directoryIdentity, directoryIdentity) ||
      !samePhysicalFileIdentity(publishedFile.fileIdentity, temporaryIdentity)
    ) {
      throw new Error("Bridge connection artifact changed during atomic publication.");
    }
    await syncDirectoryIfPresent(directory);
    if (platform === "win32") {
      await windowsPrivateFileAuthority({ filePath, repair: false });
    } else {
      assertPrivatePosixFileMode(await fs.lstat(filePath, { bigint: true }), filePath);
    }
    const verifiedBeforeRead = await capturePublishedFile(filePath);
    const actualContents = await fs.readFile(filePath);
    const verifiedAfterRead = await capturePublishedFile(filePath);
    if (
      !samePhysicalDirectoryIdentity(verifiedBeforeRead.directoryIdentity, directoryIdentity) ||
      !samePhysicalFileIdentity(verifiedBeforeRead.fileIdentity, temporaryIdentity) ||
      !samePhysicalDirectoryIdentity(verifiedAfterRead.directoryIdentity, directoryIdentity) ||
      !samePhysicalFileIdentity(verifiedAfterRead.fileIdentity, temporaryIdentity) ||
      !actualContents.equals(expectedContents)
    ) {
      throw new Error("Bridge connection artifact failed final exact verification.");
    }
    return verifiedAfterRead;
  } catch (error) {
    if (publishedFile) throw new BridgePrivateFilePublicationError(error, publishedFile);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function captureFileSnapshot(filePath: string): Promise<FileSnapshot> {
  const before = await capturePhysicalFileIdentity(filePath);
  if (before === null) return { contents: null, fileIdentity: null };
  const contents = await fs.readFile(filePath);
  const after = await capturePhysicalFileIdentity(filePath);
  if (after === null || !samePhysicalFileIdentity(before, after)) {
    throw new Error(`Bridge connection artifact changed while capturing prior state: ${filePath}`);
  }
  return { contents, fileIdentity: after };
}

async function restoreFileSnapshot(
  filePath: string,
  snapshot: FileSnapshot,
  expectedPublishedFile?: PublishedFile,
  privacy?: BridgeConnectionPrivacyOptions,
): Promise<void> {
  if (expectedPublishedFile && !(await matchesPublishedFile(filePath, expectedPublishedFile))) {
    return;
  }
  if (snapshot.contents === null) {
    await fs.rm(filePath, { force: true });
    await syncDirectoryIfPresent(path.dirname(filePath));
    return;
  }
  if (privacy) {
    await writePrivateConnectionFileAtomicDurable(filePath, snapshot.contents, privacy);
  } else {
    await writeFileAtomicDurable(filePath, snapshot.contents);
  }
}

export interface FileSnapshotRestoration {
  filePath: string;
  snapshot: FileSnapshot;
  expectedPublishedFile?: PublishedFile;
  privacy?: BridgeConnectionPrivacyOptions;
}

export async function restoreFileSnapshots(entries: FileSnapshotRestoration[]): Promise<void> {
  const restorationErrors: unknown[] = [];
  for (const entry of entries) {
    try {
      await restoreFileSnapshot(
        entry.filePath,
        entry.snapshot,
        entry.expectedPublishedFile,
        entry.privacy,
      );
    } catch (restoreError) {
      restorationErrors.push(restoreError);
    }
  }
  if (restorationErrors.length > 0) {
    throw new AggregateError(
      restorationErrors,
      "Bridge host prior published state could not be restored.",
    );
  }
}

async function rethrowAfterRestoring(
  error: unknown,
  entries: FileSnapshotRestoration[],
): Promise<never> {
  try {
    await restoreFileSnapshots(entries);
  } catch (restoreError) {
    throw new AggregateError(
      [error, restoreError],
      "Bridge host startup failed and prior published state could not be fully restored.",
    );
  }
  throw error;
}

export async function upsertConnectionArtifact(
  filePath: string,
  input: ConnectionInput,
  privacy: BridgeConnectionPrivacyOptions = {},
  priorSnapshot?: FileSnapshot,
): Promise<BridgeConnectionPublication> {
  const snapshot = priorSnapshot ?? (await captureFileSnapshot(filePath));
  let publishedFile: PublishedFile | undefined;
  try {
    const now = new Date().toISOString();
    const existing = snapshot.contents?.toString("utf8") ?? null;
    let createdAt = now;
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as { createdAt?: unknown };
        if (typeof parsed.createdAt === "string" && parsed.createdAt.trim().length > 0) {
          createdAt = parsed.createdAt;
        }
      } catch {
        // Invalid predecessor content is migration input only; publication replaces it below.
      }
    }

    const artifact: BridgeConnectionArtifact = {
      remoteHost: input.remoteHost,
      remoteToken: input.remoteToken,
      createdAt,
      updatedAt: now,
      tunnel: input.tunnel,
    };
    publishedFile = await writePrivateConnectionFileAtomicDurable(
      filePath,
      `${JSON.stringify(artifact, null, 2)}\n`,
      privacy,
    );
    return { artifact, publishedFile };
  } catch (error) {
    const failure =
      error instanceof BridgePrivateFilePublicationError ? error.originalError : error;
    if (error instanceof BridgePrivateFilePublicationError) {
      publishedFile = error.publishedFile;
    } else if (!publishedFile) {
      const current = await capturePublishedFile(filePath).catch(() => undefined);
      if (
        current &&
        (snapshot.fileIdentity === null ||
          !samePhysicalFileIdentity(current.fileIdentity, snapshot.fileIdentity))
      ) {
        publishedFile = current;
      }
    }
    if (publishedFile) {
      if (privacy.deferFailureCleanup)
        throw new BridgeArtifactPublicationError(failure, publishedFile);
      await restoreFileSnapshot(filePath, snapshot, publishedFile, privacy);
    }
    throw failure;
  }
}

export async function publishReadyBridgeConnection(
  filePath: string,
  input: ConnectionInput,
  afterPublication?: (artifact: BridgeConnectionArtifact) => void | Promise<void>,
  privacy: BridgeConnectionPrivacyOptions = {},
): Promise<BridgeConnectionArtifact> {
  const snapshot = await captureFileSnapshot(filePath);
  let publication: BridgeConnectionPublication | undefined;
  try {
    publication = await upsertConnectionArtifact(filePath, input, privacy, snapshot);
    await afterPublication?.(publication.artifact);
    return publication.artifact;
  } catch (error) {
    if (!publication) throw error;
    return rethrowAfterRestoring(error, [
      {
        filePath,
        snapshot,
        expectedPublishedFile: publication.publishedFile,
        privacy,
      },
    ]);
  }
}
