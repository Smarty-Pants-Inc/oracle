import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { open, realpath, type FileHandle } from "node:fs/promises";
import {
  sanitizeArtifactFilename,
  sanitizeArtifactMimeType,
  validateArtifactFile,
} from "../browser/artifacts.js";
import type { SessionArtifact } from "../sessionManager.js";
import { MAX_REMOTE_ARTIFACT_BYTES, type RemoteArtifactDescriptor } from "./types.js";
import {
  type DurableRemoteArtifactDeliveryReceipt,
  type DurableRemoteArtifactRegistration,
  type DurableRemoteFileIdentity,
  RemoteTransactionStore,
} from "./transactionStore.js";

export interface RemoteArtifactStoreOptions {
  transactionStore: RemoteTransactionStore;
  sessionsRoot: string;
  maximumArtifactBytes?: number;
  now?: () => number;
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

  constructor(options: RemoteArtifactStoreOptions) {
    this.#transactionStore = options.transactionStore;
    this.#sessionsRoot = options.sessionsRoot;
    this.#maximumArtifactBytes = options.maximumArtifactBytes ?? MAX_REMOTE_ARTIFACT_BYTES;
    this.#now = options.now ?? Date.now;
  }

  async prepareRequiredArtifacts(params: {
    transactionToken: string;
    runId: string;
    artifacts: SessionArtifact[];
  }): Promise<DurableRemoteArtifactRegistration[]> {
    const seenCanonicalPaths = new Set<string>();
    const registrations: DurableRemoteArtifactRegistration[] = [];
    for (const artifact of params.artifacts) {
      if (artifact.kind !== "file" || !artifact.path) continue;
      const registration = await this.buildRegistration({
        transactionToken: params.transactionToken,
        runId: params.runId,
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

    const currentCanonicalPath = await this.resolveContainedArtifactPath(
      registration.canonicalPath,
    ).catch(() => null);
    if (!currentCanonicalPath || currentCanonicalPath !== registration.canonicalPath) {
      throw new RemoteArtifactUnavailableError("artifact_identity_changed");
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
        !sameFileIdentity(currentIdentity, registration.fileIdentity)
      ) {
        throw new RemoteArtifactUnavailableError("artifact_identity_changed");
      }
      const sha256 = await computeOpenFileSha256(handle);
      if (sha256 !== registration.descriptor.sha256) {
        throw new RemoteArtifactUnavailableError("artifact_content_changed");
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

  async requiredDeliveriesComplete(transactionToken: string): Promise<boolean> {
    const record = await this.#transactionStore.read(transactionToken);
    if (!record) throw new Error("Remote transaction does not exist");
    return (record.artifacts ?? []).every(
      (artifact) => !artifact.descriptor.required || Boolean(artifact.deliveryReceipt),
    );
  }

  async descriptorsForTransaction(transactionToken: string): Promise<RemoteArtifactDescriptor[]> {
    const record = await this.#transactionStore.read(transactionToken);
    if (!record) throw new Error("Remote transaction does not exist");
    return (record.artifacts ?? []).map((registration) => registration.descriptor);
  }

  private async buildRegistration(params: {
    transactionToken: string;
    runId: string;
    artifact: SessionArtifact;
  }): Promise<DurableRemoteArtifactRegistration> {
    if (params.artifact.path.endsWith(".crdownload")) {
      throw new Error("Remote artifact is still a Chrome partial download");
    }
    const canonicalPath = await this.resolveContainedArtifactPath(params.artifact.path);
    const handle = await open(canonicalPath, "r");
    try {
      const fileStat = await handle.stat({ bigint: true });
      if (
        !fileStat.isFile() ||
        fileStat.size <= 0n ||
        fileStat.size > BigInt(this.#maximumArtifactBytes)
      ) {
        throw new Error("Remote artifact is not a completed file within the transfer limit");
      }
      const filename = sanitizeArtifactFilename(path.basename(canonicalPath), "artifact.bin");
      const mimeType = sanitizeArtifactMimeType(params.artifact.mimeType);
      const validation = await validateArtifactFile({
        path: canonicalPath,
        filename,
        mimeType,
      });
      const sha256 = await computeOpenFileSha256(handle);
      const descriptor: RemoteArtifactDescriptor & { required: boolean } = {
        artifactId: randomUUID(),
        runId: params.runId,
        kind: "file",
        filename,
        mimeType,
        byteSize: Number(fileStat.size),
        sha256,
        validation,
        sourceUrlKind: classifySourceUrlKind(params.artifact.sourceUrl),
        transferStatus: "ready",
        required: true,
      };
      return {
        descriptor,
        transactionToken: params.transactionToken,
        canonicalPath,
        fileIdentity: fileIdentityFromStat(fileStat),
      };
    } finally {
      await handle.close();
    }
  }

  private async resolveContainedArtifactPath(filePath: string): Promise<string> {
    const [canonicalPath, canonicalSessionsRoot] = await Promise.all([
      realpath(filePath),
      realpath(this.#sessionsRoot),
    ]);
    const relative = path.relative(canonicalSessionsRoot, canonicalPath);
    const segments = relative.split(path.sep);
    if (
      !relative ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      segments.length < 3 ||
      segments[1] !== "artifacts"
    ) {
      throw new Error("Remote artifact is outside Oracle's session artifact boundary");
    }
    return canonicalPath;
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

function sameFileIdentity(
  left: DurableRemoteFileIdentity,
  right: DurableRemoteFileIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
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
