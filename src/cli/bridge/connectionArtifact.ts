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
import {
  physicalFileGenerationFromStats,
  samePhysicalFileGeneration,
  type PhysicalFileGeneration,
} from "../../physicalFileIdentity.js";

export type ConnectionInput = Pick<
  BridgeConnectionArtifact,
  "remoteHost" | "remoteToken" | "tunnel"
>;

export type PhysicalFileIdentity = PhysicalFileGeneration;

export interface FileSnapshot {
  contents: Buffer | null;
  directoryIdentity: PhysicalDirectoryIdentity | null;
  fileIdentity: PhysicalFileIdentity | null;
}

export interface PublishedFile {
  readonly directoryIdentity: PhysicalDirectoryIdentity;
  readonly fileIdentity: PhysicalFileIdentity;
  readonly priorFileQuarantine?: {
    readonly filePath: string;
    readonly publishedFile: PublishedFile;
  };
}

export interface BridgeConnectionPrivacyOptions {
  readonly platform?: NodeJS.Platform;
  readonly windowsPrivateFileAuthority?: WindowsPrivateFileAuthority;
  readonly expectedDirectoryIdentity?: PhysicalDirectoryIdentity;
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

async function capturePhysicalFileIdentity(filePath: string): Promise<PhysicalFileIdentity | null> {
  try {
    const entry = await fs.lstat(filePath, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Bridge connection artifact is not a physical file: ${filePath}`);
    }
    return physicalFileGenerationFromStats(entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function samePublishedFile(left: PublishedFile, right: PublishedFile): boolean {
  return (
    samePhysicalDirectoryIdentity(left.directoryIdentity, right.directoryIdentity) &&
    samePhysicalFileGeneration(left.fileIdentity, right.fileIdentity)
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
      fileIdentity !== null && samePublishedFile({ directoryIdentity, fileIdentity }, expected)
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

export async function prepareBridgeConnectionArtifactParent(
  filePath: string,
  expectedDirectoryIdentity?: PhysicalDirectoryIdentity,
): Promise<PhysicalDirectoryIdentity> {
  await preflightBridgeConnectionArtifactPath(filePath);
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const before = await capturePhysicalDirectoryIdentity(directory);
  await preflightBridgeConnectionArtifactPath(filePath);
  const after = await capturePhysicalDirectoryIdentity(directory);
  if (
    !samePhysicalDirectoryIdentity(before, after) ||
    (expectedDirectoryIdentity !== undefined &&
      !samePhysicalDirectoryIdentity(after, expectedDirectoryIdentity))
  ) {
    throw new Error("Bridge connection artifact parent changed after preflight.");
  }
  return after;
}

async function assertOpenFileIdentity(
  handle: FileHandle,
  filePath: string,
  expected: PhysicalFileIdentity,
): Promise<void> {
  const [handleIdentity, pathIdentity] = await Promise.all([
    handle.stat({ bigint: true }).then(physicalFileGenerationFromStats),
    capturePhysicalFileIdentity(filePath),
  ]);
  if (
    pathIdentity === null ||
    !samePhysicalFileGeneration(handleIdentity, expected) ||
    !samePhysicalFileGeneration(pathIdentity, expected)
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
  replaceExisting = true,
): Promise<PublishedFile> {
  const directory = path.dirname(filePath);
  const directoryIdentity = await prepareBridgeConnectionArtifactParent(
    filePath,
    privacy.expectedDirectoryIdentity,
  );
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
  let temporaryIdentity: PhysicalFileIdentity | undefined;
  let temporaryContainsSecret = false;
  let publishedFile: PublishedFile | undefined;
  let result: PublishedFile | undefined;
  let failure: unknown;
  try {
    // PowerShell creates and closes the file with its final DACL before Node opens it.
    if (platform === "win32") {
      await windowsPrivateFileAuthority({
        filePath: temporaryPath,
        repair: false,
        createNew: true,
      });
      handle = await fs.open(temporaryPath, "r+");
    } else {
      handle = await fs.open(temporaryPath, "wx", 0o600);
    }
    temporaryIdentity = physicalFileGenerationFromStats(await handle.stat({ bigint: true }));
    await assertOpenFileIdentity(handle, temporaryPath, temporaryIdentity);
    if (platform === "win32") {
      await windowsPrivateFileAuthority({ filePath: temporaryPath, repair: false });
    } else {
      await handle.chmod(0o600);
      assertPrivatePosixFileMode(await handle.stat({ bigint: true }), temporaryPath);
    }
    await assertOpenFileIdentity(handle, temporaryPath, temporaryIdentity);
    temporaryContainsSecret = true;
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
      !samePhysicalFileGeneration(closedTemporaryIdentity, temporaryIdentity)
    ) {
      throw new Error("Bridge connection destination changed before atomic publication.");
    }

    if (replaceExisting) {
      await fs.rename(temporaryPath, filePath);
    } else {
      await fs.link(temporaryPath, filePath);
    }
    // A later path observation may see a replacement, so cleanup authority stays bound here.
    publishedFile = { directoryIdentity, fileIdentity: temporaryIdentity };
    const observedPublishedFile = await capturePublishedFile(filePath);
    if (!samePublishedFile(observedPublishedFile, publishedFile)) {
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
      !samePublishedFile(verifiedBeforeRead, publishedFile) ||
      !samePublishedFile(verifiedAfterRead, publishedFile) ||
      !actualContents.equals(expectedContents)
    ) {
      throw new Error("Bridge connection artifact failed final exact verification.");
    }
    result = verifiedAfterRead;
  } catch (error) {
    failure = publishedFile ? new BridgePrivateFilePublicationError(error, publishedFile) : error;
  }

  const cleanupErrors: unknown[] = [];
  try {
    await handle?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (temporaryIdentity !== undefined) {
    try {
      const [currentDirectoryIdentity, currentTemporaryIdentity] = await Promise.all([
        capturePhysicalDirectoryIdentity(directory),
        capturePhysicalFileIdentity(temporaryPath),
      ]);
      if (!samePhysicalDirectoryIdentity(currentDirectoryIdentity, directoryIdentity)) {
        if (temporaryContainsSecret) {
          throw new Error("Bridge connection parent changed before temporary secret cleanup.");
        }
      } else if (
        currentTemporaryIdentity !== null &&
        samePhysicalFileGeneration(currentTemporaryIdentity, temporaryIdentity)
      ) {
        await fs.rm(temporaryPath);
        await syncDirectoryIfPresent(directory);
      } else if (temporaryContainsSecret && publishedFile === undefined) {
        throw new Error("Bridge connection temporary secret cleanup could not be confirmed.");
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    const cleanupFailure = new AggregateError(
      failure === undefined ? cleanupErrors : [failure, ...cleanupErrors],
      "Bridge connection temporary secret cleanup failed.",
    );
    if (publishedFile) throw new BridgePrivateFilePublicationError(cleanupFailure, publishedFile);
    throw cleanupFailure;
  }
  if (failure !== undefined) throw failure;
  if (result === undefined)
    throw new Error("Bridge connection artifact publication had no result.");
  return result;
}

export async function captureFileSnapshot(filePath: string): Promise<FileSnapshot> {
  const directory = path.dirname(filePath);
  let directoryBefore: PhysicalDirectoryIdentity;
  try {
    directoryBefore = await capturePhysicalDirectoryIdentity(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const fileIdentity = await capturePhysicalFileIdentity(filePath);
      if (fileIdentity !== null) {
        throw new Error(`Bridge connection artifact parent disappeared: ${directory}`);
      }
      return { contents: null, directoryIdentity: null, fileIdentity: null };
    }
    throw error;
  }

  const fileBefore = await capturePhysicalFileIdentity(filePath);
  if (fileBefore === null) {
    const [directoryAfter, fileAfter] = await Promise.all([
      capturePhysicalDirectoryIdentity(directory),
      capturePhysicalFileIdentity(filePath),
    ]);
    if (fileAfter !== null || !samePhysicalDirectoryIdentity(directoryBefore, directoryAfter)) {
      throw new Error(
        `Bridge connection artifact changed while capturing prior state: ${filePath}`,
      );
    }
    return { contents: null, directoryIdentity: directoryAfter, fileIdentity: null };
  }

  const contents = await fs.readFile(filePath);
  const [directoryAfter, fileAfter] = await Promise.all([
    capturePhysicalDirectoryIdentity(directory),
    capturePhysicalFileIdentity(filePath),
  ]);
  if (
    fileAfter === null ||
    !samePhysicalDirectoryIdentity(directoryBefore, directoryAfter) ||
    !samePhysicalFileGeneration(fileBefore, fileAfter)
  ) {
    throw new Error(`Bridge connection artifact changed while capturing prior state: ${filePath}`);
  }
  return { contents, directoryIdentity: directoryAfter, fileIdentity: fileAfter };
}

async function restoreUnexpectedQuarantinedFile(
  filePath: string,
  quarantinedPath: string,
  unexpected: PublishedFile,
): Promise<void> {
  try {
    await fs.link(quarantinedPath, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Bridge connection replacement preserved at ${quarantinedPath}; its destination is occupied.`,
        { cause: error },
      );
    }
    throw error;
  }
  await syncDirectoryIfPresent(path.dirname(filePath));
  const restored = await capturePublishedFile(filePath);
  if (!samePublishedFile(restored, unexpected)) {
    throw new Error(`Bridge connection replacement changed while being restored: ${filePath}`);
  }
  await fs.unlink(quarantinedPath);
  await syncDirectoryIfPresent(path.dirname(filePath));
}

async function quarantinePublishedFile(
  filePath: string,
  expected: PublishedFile,
): Promise<string | null> {
  let currentDirectoryIdentity: PhysicalDirectoryIdentity;
  try {
    currentDirectoryIdentity = await capturePhysicalDirectoryIdentity(path.dirname(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!samePhysicalDirectoryIdentity(currentDirectoryIdentity, expected.directoryIdentity)) {
    return null;
  }

  const quarantinedPath = path.join(
    path.dirname(filePath),
    `.oracle-bridge-rollback-${randomUUID()}.tmp`,
  );
  try {
    await fs.rename(filePath, quarantinedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  await syncDirectoryIfPresent(path.dirname(filePath));

  const quarantined = await capturePublishedFile(quarantinedPath);
  if (!samePublishedFile(quarantined, expected)) {
    await restoreUnexpectedQuarantinedFile(filePath, quarantinedPath, quarantined);
    return null;
  }
  return quarantinedPath;
}

async function removeQuarantinedPublishedFile(
  quarantinedPath: string,
  expected: PublishedFile,
): Promise<void> {
  let directoryIdentity: PhysicalDirectoryIdentity;
  try {
    directoryIdentity = await capturePhysicalDirectoryIdentity(path.dirname(quarantinedPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const fileIdentity = await capturePhysicalFileIdentity(quarantinedPath);
  if (fileIdentity === null || !samePublishedFile({ directoryIdentity, fileIdentity }, expected)) {
    return;
  }
  await fs.unlink(quarantinedPath);
  await syncDirectoryIfPresent(path.dirname(quarantinedPath));
}

async function restoreFileSnapshot(
  filePath: string,
  snapshot: FileSnapshot,
  expectedPublishedFile?: PublishedFile,
  privacy?: BridgeConnectionPrivacyOptions,
): Promise<void> {
  const restorationPrivacy =
    privacy !== undefined &&
    privacy.expectedDirectoryIdentity === undefined &&
    snapshot.directoryIdentity !== null
      ? { ...privacy, expectedDirectoryIdentity: snapshot.directoryIdentity }
      : privacy;
  if (!expectedPublishedFile) {
    if (snapshot.contents === null) {
      await fs.rm(filePath, { force: true });
      await syncDirectoryIfPresent(path.dirname(filePath));
    } else if (restorationPrivacy !== undefined) {
      await writePrivateConnectionFileAtomicDurable(
        filePath,
        snapshot.contents,
        restorationPrivacy,
      );
    } else {
      await writeFileAtomicDurable(filePath, snapshot.contents);
    }
    return;
  }

  const quarantinedPath = await quarantinePublishedFile(filePath, expectedPublishedFile);
  if (quarantinedPath === null) {
    if (expectedPublishedFile.priorFileQuarantine) {
      await removeQuarantinedPublishedFile(
        expectedPublishedFile.priorFileQuarantine.filePath,
        expectedPublishedFile.priorFileQuarantine.publishedFile,
      );
    }
    return;
  }
  let restorationCompleted = false;
  try {
    if (snapshot.contents === null) {
      restorationCompleted = true;
      return;
    }
    if (restorationPrivacy === undefined) {
      const preparedPath = `${filePath}.rollback-${randomUUID()}.tmp`;
      let preparedFile: PublishedFile | undefined;
      try {
        await writeFileAtomicDurable(preparedPath, snapshot.contents);
        preparedFile = await capturePublishedFile(preparedPath);
        try {
          await fs.link(preparedPath, filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            restorationCompleted = true;
            return;
          }
          throw error;
        }
        await syncDirectoryIfPresent(path.dirname(filePath));
        if (!(await matchesPublishedFile(filePath, preparedFile))) {
          throw new Error(`Restored file changed during exact publication: ${filePath}`);
        }
      } finally {
        if (preparedFile && (await matchesPublishedFile(preparedPath, preparedFile))) {
          await fs.unlink(preparedPath);
          await syncDirectoryIfPresent(path.dirname(preparedPath));
        }
      }
      restorationCompleted = true;
      return;
    }
    try {
      await writePrivateConnectionFileAtomicDurable(
        filePath,
        snapshot.contents,
        restorationPrivacy,
        false,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        restorationCompleted = true;
        return;
      }
      if (error instanceof BridgePrivateFilePublicationError) {
        const failedRestorationPath = await quarantinePublishedFile(filePath, error.publishedFile);
        if (failedRestorationPath !== null) {
          await removeQuarantinedPublishedFile(failedRestorationPath, error.publishedFile);
        }
        throw error.originalError;
      }
      throw error;
    }
    restorationCompleted = true;
  } finally {
    await removeQuarantinedPublishedFile(quarantinedPath, expectedPublishedFile);
    if (restorationCompleted && expectedPublishedFile.priorFileQuarantine) {
      await removeQuarantinedPublishedFile(
        expectedPublishedFile.priorFileQuarantine.filePath,
        expectedPublishedFile.priorFileQuarantine.publishedFile,
      );
    }
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
  const publicationPrivacy =
    privacy.expectedDirectoryIdentity !== undefined || snapshot.directoryIdentity === null
      ? privacy
      : { ...privacy, expectedDirectoryIdentity: snapshot.directoryIdentity };
  let publishedFile: PublishedFile | undefined;
  let priorFileQuarantine:
    | { readonly filePath: string; readonly publishedFile: PublishedFile }
    | undefined;
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
    if (snapshot.fileIdentity !== null) {
      if (snapshot.directoryIdentity === null) {
        throw new Error("Bridge connection predecessor has no parent generation authority.");
      }
      const predecessor: PublishedFile = {
        directoryIdentity: snapshot.directoryIdentity,
        fileIdentity: snapshot.fileIdentity,
      };
      const quarantinedPath = await quarantinePublishedFile(filePath, predecessor);
      if (quarantinedPath === null) {
        throw new Error("Bridge connection predecessor changed before atomic publication.");
      }
      priorFileQuarantine = { filePath: quarantinedPath, publishedFile: predecessor };
    }

    publishedFile = await writePrivateConnectionFileAtomicDurable(
      filePath,
      `${JSON.stringify(artifact, null, 2)}\n`,
      publicationPrivacy,
      false,
    );
    if (priorFileQuarantine) {
      await removeQuarantinedPublishedFile(
        priorFileQuarantine.filePath,
        priorFileQuarantine.publishedFile,
      );
      priorFileQuarantine = undefined;
    }
    return { artifact, publishedFile };
  } catch (error) {
    const failure =
      error instanceof BridgePrivateFilePublicationError ? error.originalError : error;
    if (error instanceof BridgePrivateFilePublicationError) {
      publishedFile = error.publishedFile;
    }
    if (publishedFile) {
      const rollbackPublishedFile = priorFileQuarantine
        ? { ...publishedFile, priorFileQuarantine }
        : publishedFile;
      if (privacy.deferFailureCleanup) {
        throw new BridgeArtifactPublicationError(failure, rollbackPublishedFile);
      }
      await restoreFileSnapshot(filePath, snapshot, rollbackPublishedFile, publicationPrivacy);
    } else if (priorFileQuarantine) {
      try {
        if ((failure as NodeJS.ErrnoException).code === "EEXIST") {
          await removeQuarantinedPublishedFile(
            priorFileQuarantine.filePath,
            priorFileQuarantine.publishedFile,
          );
        } else {
          await restoreUnexpectedQuarantinedFile(
            filePath,
            priorFileQuarantine.filePath,
            priorFileQuarantine.publishedFile,
          );
        }
      } catch (restoreError) {
        throw new AggregateError(
          [failure, restoreError],
          "Bridge connection publication failed and its predecessor could not be fully restored.",
        );
      }
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
