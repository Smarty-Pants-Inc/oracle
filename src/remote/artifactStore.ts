import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, rmdir, type FileHandle } from "node:fs/promises";
import {
  sanitizeArtifactFilename,
  sanitizeArtifactMimeType,
  validateArtifactFile,
} from "../browser/artifacts.js";
import {
  capturePhysicalDirectoryIdentity,
  PhysicalDirectoryIdentityUnavailableError,
  samePhysicalDirectoryIdentity,
} from "../browser/filesystemLockDirectoryIdentity.js";
import {
  isolateDirectoryGenerationForRemoval,
  removeIsolatedDirectoryGeneration,
  replayPendingIsolatedDirectoryRemovals,
} from "../browser/filesystemLockDirectoryRemoval.js";
import type { BrowserArtifactWriteAuthority } from "../browser/types.js";
import type { SessionArtifact } from "../sessionManager.js";
import { MAX_REMOTE_ARTIFACT_BYTES, type RemoteArtifactDescriptor } from "./types.js";
import { deriveRemoteArtifactManualCopyWaiverId } from "./transactionModel.js";
import type {
  DurableRemoteArtifactDeliveryReceipt,
  DurableRemoteArtifactManualCopyWaiver,
  DurableRemoteArtifactNamespaceIdentity,
  DurableRemoteArtifactRegistration,
  DurableRemoteFileIdentity,
  RemoteTransactionRecord,
} from "./transactionModel.js";
import type { RemoteTransactionStore } from "./transactionStore.js";
import {
  establishWindowsPrivateDirectories,
  verifyWindowsPrivateFile,
  type WindowsPrivateDirectoriesAuthority,
} from "./windowsPrivateTreeAcl.js";

export interface RemoteArtifactStoreOptions {
  transactionStore: RemoteTransactionStore;
  sessionsRoot: string;
  maximumArtifactBytes?: number;
  now?: () => number;
  platform?: NodeJS.Platform;
  windowsPrivateDirectoriesAuthority?: WindowsPrivateDirectoriesAuthority;
}

export interface OpenRemoteArtifact {
  handle: FileHandle;
  registration: DurableRemoteArtifactRegistration;
}

export class RemoteArtifactStore {
  readonly #transactionStore: RemoteTransactionStore;
  readonly #sessionsRoot: string;
  readonly #maximumArtifactBytes: number;
  readonly #now: () => number;
  readonly #platform: NodeJS.Platform;
  readonly #windowsPrivateDirectoriesAuthority: WindowsPrivateDirectoriesAuthority;

  constructor(options: RemoteArtifactStoreOptions) {
    this.#transactionStore = options.transactionStore;
    this.#sessionsRoot = options.sessionsRoot;
    this.#maximumArtifactBytes = options.maximumArtifactBytes ?? MAX_REMOTE_ARTIFACT_BYTES;
    this.#now = options.now ?? Date.now;
    this.#platform = options.platform ?? process.platform;
    this.#windowsPrivateDirectoriesAuthority =
      options.windowsPrivateDirectoriesAuthority ?? establishWindowsPrivateDirectories;
    this.#transactionStore.registerArtifactNamespaceCleanup((record) =>
      this.cleanupArtifactNamespace(record),
    );
  }
  async createArtifactWriteAuthority(params: {
    transactionToken: string;
    runId: string;
  }): Promise<BrowserArtifactWriteAuthority> {
    const record = await this.#transactionStore.read(params.transactionToken);
    if (
      !record ||
      record.runId !== params.runId ||
      record.state !== "running" ||
      record.artifactNamespaceState !== "uninitialized"
    ) {
      throw new Error("Remote artifact namespace is not owned by the exact fresh transaction");
    }

    const namespaceDirectory = this.namespaceDirectory(record.artifactNamespace);
    let namespaceCreated = false;
    let namespaceIdentity: DurableRemoteArtifactNamespaceIdentity | undefined;
    try {
      await this.#transactionStore.beginArtifactNamespaceInitialization(params);
      const artifactsDirectory = path.join(namespaceDirectory, "artifacts");
      if (this.#platform === "win32") {
        const sessionsRoot = path.resolve(this.#sessionsRoot);
        await mkdir(sessionsRoot, { recursive: true });
        // The shared sessions root is only a container; private ACL authority starts at the exclusive namespace.
        const existingNamespace = await lstat(namespaceDirectory)
          .then(() => true)
          .catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
          });
        if (existingNamespace) {
          throw new Error("Remote artifact namespace was not created exclusively");
        }
        await this.#windowsPrivateDirectoriesAuthority([namespaceDirectory]);
        namespaceCreated = true;
        namespaceIdentity = await captureArtifactNamespaceIdentity(namespaceDirectory);
        await this.#transactionStore.bindArtifactNamespaceIdentity({
          ...params,
          identity: namespaceIdentity,
        });

        const protectedDirectories = [namespaceDirectory, artifactsDirectory];
        await this.#windowsPrivateDirectoriesAuthority(protectedDirectories);
        const initialIdentities = [
          namespaceIdentity,
          await capturePhysicalDirectoryIdentity(artifactsDirectory),
        ];
        await this.#windowsPrivateDirectoriesAuthority(protectedDirectories);
        const verifiedIdentities = await Promise.all(
          protectedDirectories.map((directoryPath) =>
            capturePhysicalDirectoryIdentity(directoryPath),
          ),
        );
        for (let index = 0; index < protectedDirectories.length; index += 1) {
          if (
            !samePhysicalDirectoryIdentity(initialIdentities[index]!, verifiedIdentities[index]!)
          ) {
            throw new Error(
              "Remote artifact directory generation changed during Windows private ACL protection",
            );
          }
        }
      } else {
        await mkdir(this.#sessionsRoot, { recursive: true, mode: 0o700 });
        try {
          await mkdir(namespaceDirectory, { mode: 0o700 });
          namespaceCreated = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error("Remote artifact namespace was not created exclusively");
          }
          throw error;
        }
        namespaceIdentity = await captureArtifactNamespaceIdentity(namespaceDirectory);
        await this.#transactionStore.bindArtifactNamespaceIdentity({
          ...params,
          identity: namespaceIdentity,
        });
        await mkdir(artifactsDirectory, { mode: 0o700 });
        await chmod(namespaceDirectory, 0o700);
        await chmod(artifactsDirectory, 0o700);
      }
      const canonicalArtifactsDirectory = await this.resolveArtifactNamespaceDirectory(
        record.artifactNamespace,
        namespaceIdentity,
      );
      await this.#transactionStore.completeArtifactNamespaceInitialization(params);
      return {
        artifactsDirectory: canonicalArtifactsDirectory,
        ...(this.#platform === "win32" ? { windowsPrivateFiles: true as const } : {}),
      };
    } catch (error) {
      if (namespaceCreated) {
        try {
          const removed = namespaceIdentity
            ? await this.cleanupArtifactNamespace({
                ...record,
                artifactNamespaceState: "initializing",
                artifactNamespaceIdentity: namespaceIdentity,
              })
            : await this.removeFreshEmptyArtifactNamespace(namespaceDirectory);
          if (removed) {
            await this.#transactionStore.rollbackArtifactNamespaceInitialization({
              ...params,
              identity: namespaceIdentity,
            });
          }
        } catch {
          // Retain durable namespace authority below when immediate exact or empty-only rollback fails.
        }
      }

      let failed: RemoteTransactionRecord;
      try {
        failed = await this.#transactionStore.recordRecoverableFailure({
          transactionToken: params.transactionToken,
          error: {
            name: "BrowserAutomationError",
            category: "browser-automation",
            message: "Remote artifact namespace initialization failed before browser work started.",
            code: "remote-artifact-namespace-initialization-failed",
            stage: "remote-artifact-namespace-initialization",
            recoverableDisconnect: false,
          },
        });
      } catch (settlementError) {
        throw new AggregateError(
          [error, settlementError],
          "Remote artifact namespace initialization and durable failure settlement both failed",
        );
      }
      await this.cleanupArtifactNamespace(failed).catch(() => false);
      throw error;
    }
  }

  async prepareRequiredArtifacts(params: {
    transactionToken: string;
    runId: string;
    artifacts: SessionArtifact[];
  }): Promise<DurableRemoteArtifactRegistration[]> {
    const record = await this.#transactionStore.read(params.transactionToken);
    if (
      !record ||
      record.runId !== params.runId ||
      record.artifactNamespaceState !== "initialized" ||
      !record.artifactNamespaceIdentity
    ) {
      throw new Error(
        "Remote artifact registration is not owned by the exact initialized transaction",
      );
    }
    const seenCanonicalPaths = new Set<string>();
    const registrations: DurableRemoteArtifactRegistration[] = [];
    for (const artifact of params.artifacts) {
      if (artifact.kind !== "file" || !artifact.path) continue;
      const registration = await this.buildRegistration({
        transactionToken: params.transactionToken,
        runId: params.runId,
        artifactNamespace: record.artifactNamespace,
        artifactNamespaceIdentity: record.artifactNamespaceIdentity,
        artifact,
      });
      if (seenCanonicalPaths.has(registration.canonicalPath)) continue;
      seenCanonicalPaths.add(registration.canonicalPath);
      registrations.push(registration);
    }
    return registrations;
  }

  async openForDelivery(
    transactionToken: string,
    artifactId: string,
  ): Promise<OpenRemoteArtifact | null> {
    const record = await this.#transactionStore.read(transactionToken);
    if (!record) return null;
    const registration = record.artifacts?.find(
      (artifact) => artifact.descriptor.artifactId === artifactId,
    );
    if (!registration) return null;
    if (!record.leaseExpiresAt || this.#now() >= Date.parse(record.leaseExpiresAt)) {
      throw new RemoteArtifactUnavailableError("transaction_lease_expired");
    }
    if (record.artifactNamespaceState !== "initialized" || !record.artifactNamespaceIdentity) {
      throw new RemoteArtifactUnavailableError("artifact_identity_changed");
    }

    const currentCanonicalPath = await this.resolveContainedArtifactPath(
      registration.canonicalPath,
      record.artifactNamespace,
      record.artifactNamespaceIdentity,
    ).catch(() => null);
    if (!currentCanonicalPath || currentCanonicalPath !== registration.canonicalPath) {
      throw new RemoteArtifactUnavailableError("artifact_identity_changed");
    }

    if (this.#platform === "win32") {
      await verifyWindowsPrivateFile(currentCanonicalPath);
    }
    const handle = await open(currentCanonicalPath, "r").catch(() => null);
    if (!handle) throw new RemoteArtifactUnavailableError("artifact_unavailable");
    try {
      const fileStat = await handle.stat({ bigint: true });
      const currentIdentity = fileIdentityFromStat(fileStat);
      if (
        !fileStat.isFile() ||
        fileStat.size <= 0n ||
        fileStat.size > BigInt(this.#maximumArtifactBytes) ||
        Number(fileStat.size) !== registration.descriptor.byteSize ||
        !sameFileSnapshotIdentity(currentIdentity, registration.fileIdentity)
      ) {
        throw new RemoteArtifactUnavailableError("artifact_identity_changed");
      }
      const sha256 = await computeOpenFileSha256(handle);
      const afterHashStat = await handle.stat({ bigint: true });
      if (
        !afterHashStat.isFile() ||
        afterHashStat.size !== fileStat.size ||
        !sameFileSnapshotIdentity(fileIdentityFromStat(afterHashStat), currentIdentity)
      ) {
        throw new RemoteArtifactUnavailableError("artifact_identity_changed");
      }
      if (sha256 !== registration.descriptor.sha256) {
        throw new RemoteArtifactUnavailableError("artifact_content_changed");
      }
      if (this.#platform === "win32") {
        await verifyWindowsPrivateFile(currentCanonicalPath);
        const pathStat = await lstat(currentCanonicalPath, { bigint: true });
        if (
          pathStat.isSymbolicLink() ||
          !pathStat.isFile() ||
          !sameFileSnapshotIdentity(fileIdentityFromStat(pathStat), currentIdentity)
        ) {
          throw new RemoteArtifactUnavailableError("artifact_identity_changed");
        }
      }
      return { handle, registration };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async recordDeliveryReceipt(params: {
    transactionToken: string;
    artifactId: string;
    byteSize: number;
    sha256: string;
  }): Promise<DurableRemoteArtifactDeliveryReceipt> {
    const receiptId = createHash("sha256")
      .update(params.transactionToken)
      .update("\0")
      .update(params.artifactId)
      .update("\0")
      .update(params.sha256)
      .update("\0")
      .update(String(params.byteSize))
      .digest("hex");
    const proposedReceipt: DurableRemoteArtifactDeliveryReceipt = {
      receiptId,
      deliveredAt: new Date(this.#now()).toISOString(),
      byteSize: params.byteSize,
      sha256: params.sha256,
    };
    try {
      return await this.#transactionStore.recordArtifactDelivery({
        transactionToken: params.transactionToken,
        artifactId: params.artifactId,
        receipt: proposedReceipt,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("expired transaction lease")) {
        throw new RemoteArtifactUnavailableError("transaction_lease_expired");
      }
      throw error;
    }
  }

  async recordManualCopyWaiver(params: {
    transactionToken: string;
    artifactId: string;
    byteSize: number;
    sha256: string;
  }): Promise<DurableRemoteArtifactManualCopyWaiver | null> {
    const waiver: DurableRemoteArtifactManualCopyWaiver = {
      waiverId: deriveRemoteArtifactManualCopyWaiverId(params),
      waivedAt: new Date(this.#now()).toISOString(),
      disposition: "manual-copy-required",
      byteSize: params.byteSize,
      sha256: params.sha256,
    };
    try {
      return await this.#transactionStore.recordArtifactManualCopyWaiver({
        transactionToken: params.transactionToken,
        artifactId: params.artifactId,
        waiver,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("expired transaction lease")) {
        throw new RemoteArtifactUnavailableError("transaction_lease_expired");
      }
      throw error;
    }
  }

  private namespaceDirectory(artifactNamespace: string): string {
    const sessionsRoot = path.resolve(this.#sessionsRoot);
    const namespaceDirectory = path.resolve(sessionsRoot, artifactNamespace);
    if (path.dirname(namespaceDirectory) !== sessionsRoot) {
      throw new Error("Remote artifact namespace escapes the configured sessions root");
    }
    return namespaceDirectory;
  }

  private async removeFreshEmptyArtifactNamespace(namespaceDirectory: string): Promise<boolean> {
    try {
      await rmdir(namespaceDirectory);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return true;
      if (code === "ENOTEMPTY" || code === "EEXIST") return false;
      throw error;
    }
  }

  private async cleanupArtifactNamespace(record: RemoteTransactionRecord): Promise<boolean> {
    if (record.artifactNamespaceState === "uninitialized") return true;
    const namespaceDirectory = this.namespaceDirectory(record.artifactNamespace);
    const identity = record.artifactNamespaceIdentity;
    if (!identity) {
      try {
        await captureArtifactNamespaceIdentity(namespaceDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      }
      return false;
    }

    const verifyIdentity = async (candidatePath: string): Promise<boolean> => {
      try {
        return samePhysicalDirectoryIdentity(
          await captureArtifactNamespaceIdentity(candidatePath),
          identity,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    };
    await replayPendingIsolatedDirectoryRemovals(this.#sessionsRoot, namespaceDirectory, {
      verifyGenerationForRemoval: verifyIdentity,
    });
    let currentMatches: boolean;
    try {
      currentMatches = await verifyIdentity(namespaceDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    if (!currentMatches) {
      try {
        await captureArtifactNamespaceIdentity(namespaceDirectory);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
      }
    }
    const isolation = await isolateDirectoryGenerationForRemoval(
      namespaceDirectory,
      verifyIdentity,
      namespaceDirectory,
    );
    if (isolation.status === "missing") return true;
    if (isolation.status === "changed") return false;
    await removeIsolatedDirectoryGeneration(isolation.rootPath, {
      verifyGenerationForRemoval: verifyIdentity,
    });
    return true;
  }

  private async buildRegistration(params: {
    transactionToken: string;
    runId: string;
    artifactNamespace: string;
    artifactNamespaceIdentity: DurableRemoteArtifactNamespaceIdentity;
    artifact: SessionArtifact;
  }): Promise<DurableRemoteArtifactRegistration> {
    if (params.artifact.path.endsWith(".crdownload")) {
      throw new Error("Remote artifact is still a Chrome partial download");
    }
    if (
      !Number.isSafeInteger(params.artifact.sizeBytes) ||
      !params.artifact.sizeBytes ||
      !/^[a-f0-9]{64}$/u.test(params.artifact.sha256 ?? "") ||
      !params.artifact.fileIdentity
    ) {
      throw new Error("Remote artifact is missing exact producer byte identity");
    }
    const canonicalPath = await this.resolveContainedArtifactPath(
      params.artifact.path,
      params.artifactNamespace,
      params.artifactNamespaceIdentity,
    );
    if (this.#platform === "win32") {
      await verifyWindowsPrivateFile(canonicalPath);
    }
    const handle = await open(canonicalPath, "r");
    try {
      const fileStat = await handle.stat({ bigint: true });
      const fileIdentity = fileIdentityFromStat(fileStat);
      if (
        !fileStat.isFile() ||
        fileStat.size <= 0n ||
        fileStat.size > BigInt(this.#maximumArtifactBytes)
      ) {
        throw new Error("Remote artifact is not a completed file within the transfer limit");
      }
      if (
        Number(fileStat.size) !== params.artifact.sizeBytes ||
        !sameFileSnapshotIdentity(fileIdentity, params.artifact.fileIdentity)
      ) {
        throw new Error("Remote artifact physical identity does not match producer evidence");
      }
      const filename = sanitizeArtifactFilename(path.basename(canonicalPath), "artifact.bin");
      const mimeType = sanitizeArtifactMimeType(params.artifact.mimeType);
      const validation =
        params.artifact.validation ??
        (await validateArtifactFile({ path: canonicalPath, filename, mimeType }));
      const sha256 = await computeOpenFileSha256(handle);
      const afterHashStat = await handle.stat({ bigint: true });
      if (
        afterHashStat.size !== fileStat.size ||
        !sameFileSnapshotIdentity(fileIdentityFromStat(afterHashStat), fileIdentity)
      ) {
        throw new Error("Remote artifact physical identity changed during registration");
      }
      if (sha256 !== params.artifact.sha256) {
        throw new Error("Remote artifact sha256 does not match producer evidence");
      }
      if (this.#platform === "win32") {
        await verifyWindowsPrivateFile(canonicalPath);
        const pathStat = await lstat(canonicalPath, { bigint: true });
        if (
          pathStat.isSymbolicLink() ||
          !pathStat.isFile() ||
          !sameFileSnapshotIdentity(fileIdentityFromStat(pathStat), fileIdentity)
        ) {
          throw new Error(
            "Remote artifact physical identity changed during Windows ACL verification",
          );
        }
      }
      const descriptor: RemoteArtifactDescriptor & { required: boolean } = {
        artifactId: randomUUID(),
        runId: params.runId,
        kind: "file",
        filename,
        mimeType,
        byteSize: params.artifact.sizeBytes,
        sha256: params.artifact.sha256,
        validation,
        sourceUrlKind: classifySourceUrlKind(params.artifact.sourceUrl),
        transferStatus: "ready",
        required: true,
      };
      return {
        descriptor,
        transactionToken: params.transactionToken,
        canonicalPath,
        fileIdentity: params.artifact.fileIdentity,
      };
    } finally {
      await handle.close();
    }
  }

  private async resolveArtifactNamespaceDirectory(
    artifactNamespace: string,
    expectedIdentity: DurableRemoteArtifactNamespaceIdentity,
  ): Promise<string> {
    const namespaceDirectory = this.namespaceDirectory(artifactNamespace);
    if (
      !samePhysicalDirectoryIdentity(
        await captureArtifactNamespaceIdentity(namespaceDirectory),
        expectedIdentity,
      )
    ) {
      throw new Error("Remote artifact namespace physical identity changed");
    }
    const [canonicalSessionsRoot, canonicalArtifactsDirectory] = await Promise.all([
      realpath(this.#sessionsRoot),
      realpath(path.join(namespaceDirectory, "artifacts")),
    ]);
    const expectedDirectory = path.join(canonicalSessionsRoot, artifactNamespace, "artifacts");
    if (
      canonicalArtifactsDirectory !== expectedDirectory ||
      !samePhysicalDirectoryIdentity(
        await captureArtifactNamespaceIdentity(namespaceDirectory),
        expectedIdentity,
      )
    ) {
      throw new Error("Remote artifact namespace is not the exact server-owned directory");
    }
    return canonicalArtifactsDirectory;
  }

  private async resolveContainedArtifactPath(
    filePath: string,
    artifactNamespace: string,
    artifactNamespaceIdentity: DurableRemoteArtifactNamespaceIdentity,
  ): Promise<string> {
    const lexicalArtifactsDirectory = path.resolve(
      this.#sessionsRoot,
      artifactNamespace,
      "artifacts",
    );
    const requestedDirectory = path.dirname(path.resolve(filePath));
    let canonicalArtifactsDirectory: string;
    if (requestedDirectory === lexicalArtifactsDirectory) {
      canonicalArtifactsDirectory = await this.resolveArtifactNamespaceDirectory(
        artifactNamespace,
        artifactNamespaceIdentity,
      );
    } else {
      try {
        canonicalArtifactsDirectory = await this.resolveArtifactNamespaceDirectory(
          artifactNamespace,
          artifactNamespaceIdentity,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error("Remote artifact is outside its exact transaction artifact namespace");
        }
        throw error;
      }
      if (requestedDirectory !== canonicalArtifactsDirectory) {
        throw new Error("Remote artifact is outside its exact transaction artifact namespace");
      }
    }
    const canonicalPath = await realpath(filePath);
    if (path.dirname(canonicalPath) !== canonicalArtifactsDirectory) {
      throw new Error("Remote artifact is outside its exact transaction artifact namespace");
    }
    return canonicalPath;
  }
}

async function captureArtifactNamespaceIdentity(
  directoryPath: string,
): Promise<DurableRemoteArtifactNamespaceIdentity> {
  try {
    return await capturePhysicalDirectoryIdentity(directoryPath);
  } catch (error) {
    if (!(error instanceof PhysicalDirectoryIdentityUnavailableError)) throw error;
    throw new Error(
      `Remote artifact namespace ${directoryPath} cannot establish durable replacement-safe authority. Move ORACLE_HOME_DIR to a filesystem with stable nonzero birth time.`,
      { cause: error },
    );
  }
}

export class RemoteArtifactUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RemoteArtifactUnavailableError";
  }
}

function fileIdentityFromStat(fileStat: {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
  ctimeNs: bigint;
}): DurableRemoteFileIdentity {
  return {
    device: fileStat.dev.toString(),
    inode: fileStat.ino.toString(),
    birthtimeNs: fileStat.birthtimeNs.toString(),
    ctimeNs: fileStat.ctimeNs.toString(),
  };
}

function sameStableFileIdentity(
  left: DurableRemoteFileIdentity,
  right: DurableRemoteFileIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sameFileSnapshotIdentity(
  left: DurableRemoteFileIdentity,
  right: DurableRemoteFileIdentity,
): boolean {
  return sameStableFileIdentity(left, right) && left.ctimeNs === right.ctimeNs;
}

async function computeOpenFileSha256(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function classifySourceUrlKind(sourceUrl?: string): RemoteArtifactDescriptor["sourceUrlKind"] {
  if (sourceUrl?.startsWith("sandbox:")) return "sandbox";
  return sourceUrl === "browser-download" ? "browser-download" : "chatgpt-file-endpoint";
}
