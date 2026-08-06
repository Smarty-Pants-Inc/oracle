import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { link, lstat, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "../fsDurability.js";
import type { RemoteTransactionRecord } from "./transactionModel.js";
import { isTerminalRemoteTransactionState } from "./transactionValidation.js";
import {
  assertPhysicalTransactionRecordFile,
  isPhysicalTransactionRecordFile,
  QuarantinableRemoteTransactionRecordIntegrityError,
  readErrorCode,
  readStableRemoteTransactionRecordBytes,
  RemoteTransactionRecordIntegrityError,
  sameFileGeneration,
  samePhysicalFile,
  sameQuarantineEvidence,
  type RemoteTransactionQuarantineEvidence,
} from "./transactionRecordStorage.js";

const REMOTE_TRANSACTION_RECORD_PATTERN = /^([a-f0-9]{64})\.json$/u;
const REMOTE_TRANSACTION_QUARANTINE_PATTERN =
  /^\.invalid-remote-transaction\.([a-f0-9]{64})\..+\.quarantine$/u;
const REMOTE_TRANSACTION_PRESERVED_AUTHORITY_PATTERN =
  /^\.preserved-remote-transaction\.[a-f0-9]{64}\..+\.authority$/u;

type RemoteArtifactNamespaceCleanup = (record: RemoteTransactionRecord) => Promise<boolean>;

type AuthenticatedRemoteTransactionRecord = {
  record: RemoteTransactionRecord;
  byteLength: number;
  contents: Buffer;
  fileIdentity: BigIntStats;
};

type RemoteTransactionStoreMaintenanceOptions = {
  directory: string;
  platform: NodeJS.Platform;
  terminalRetentionMs: number;
  maximumRecords: number;
  maximumBytes: number;
  maximumQuarantineRecords: number;
  maximumQuarantineBytes: number;
  now: () => number;
  beforeQuarantineUnlink?: () => Promise<void>;
  assertIntegrityAuthority: () => Promise<void>;
  withWindowsPrivateTreeAuthority: <T>(operation: () => Promise<T>) => Promise<T>;
  readAuthenticatedRecord: (
    targetPath: string,
    transactionToken: string,
  ) => Promise<AuthenticatedRemoteTransactionRecord>;
  recordPath: (transactionToken: string) => string;
};

export class RemoteTransactionCapacityError extends Error {
  readonly code = "remote_transaction_capacity_exhausted";

  constructor(
    readonly policy: {
      maximumRecords: number;
      maximumBytes: number;
      currentRecords: number;
      currentBytes: number;
      requestedBytes: number;
    },
  ) {
    super("Remote transaction storage capacity is exhausted");
    this.name = "RemoteTransactionCapacityError";
  }
}

export function isPersistedRemoteTransactionStoreEntry(name: string): boolean {
  return (
    REMOTE_TRANSACTION_RECORD_PATTERN.test(name) ||
    REMOTE_TRANSACTION_QUARANTINE_PATTERN.test(name) ||
    REMOTE_TRANSACTION_PRESERVED_AUTHORITY_PATTERN.test(name)
  );
}

export class RemoteTransactionStoreMaintenance {
  readonly #options: RemoteTransactionStoreMaintenanceOptions;
  #maintenanceLock: Promise<void> = Promise.resolve();
  #quarantineMaintenanceLock: Promise<void> = Promise.resolve();
  #artifactNamespaceCleanup?: RemoteArtifactNamespaceCleanup;

  constructor(options: RemoteTransactionStoreMaintenanceOptions) {
    this.#options = options;
  }

  registerArtifactNamespaceCleanup(cleanup: RemoteArtifactNamespaceCleanup): void {
    this.#artifactNamespaceCleanup = cleanup;
  }

  async run(): Promise<void> {
    await this.withMaintenanceLock(async () => {
      await this.pruneExpiredTerminalRecords();
      await this.maintainQuarantineRetention();
    });
  }

  async publishWithCapacity(
    contentsBytes: number,
    replacedPath: string | undefined,
    reservationBytes: number | undefined,
    publish: () => Promise<void>,
  ): Promise<void> {
    await this.withMaintenanceLock(async () => {
      await this.pruneExpiredTerminalRecords();
      await this.assertCapacity(contentsBytes, replacedPath, reservationBytes);
      await publish();
    });
  }

  async quarantineInvalidRecord(
    targetPath: string,
    transactionToken: string,
    failure: QuarantinableRemoteTransactionRecordIntegrityError,
  ): Promise<void> {
    const evidence = failure.quarantineEvidence();
    const quarantinePath = this.newQuarantinePath(transactionToken);
    await this.#options.assertIntegrityAuthority();
    await this.#options.beforeQuarantineUnlink?.();
    try {
      await rename(targetPath, quarantinePath);
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") throw error;
      if (evidence.contents !== undefined) {
        await this.publishQuarantineBytes(transactionToken, evidence.contents);
      }
      await this.maintainQuarantineRetention();
      return;
    }
    await this.syncStorageDirectory();

    let movedEvidence: RemoteTransactionQuarantineEvidence;
    try {
      movedEvidence = await this.readQuarantineEvidence(quarantinePath);
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") throw error;
      if (evidence.contents !== undefined) {
        await this.publishQuarantineBytes(transactionToken, evidence.contents);
      }
      await this.maintainQuarantineRetention();
      return;
    }
    if (sameQuarantineEvidence(evidence, movedEvidence)) {
      await this.maintainQuarantineRetention();
      return;
    }

    try {
      const authenticated = await this.#options.readAuthenticatedRecord(
        quarantinePath,
        transactionToken,
      );
      if (await this.restoreAuthenticatedRecord(targetPath, authenticated.contents)) {
        await this.retireQuarantineGeneration(
          quarantinePath,
          transactionToken,
          authenticated.fileIdentity,
          authenticated.contents,
        );
      } else {
        await this.preserveAuthenticatedGeneration(quarantinePath, transactionToken);
      }
    } catch (error) {
      if (
        readErrorCode(error) !== "ENOENT" &&
        !(error instanceof RemoteTransactionRecordIntegrityError)
      ) {
        throw error;
      }
    }
    if (evidence.contents !== undefined) {
      await this.publishQuarantineBytes(transactionToken, evidence.contents);
    }
    await this.maintainQuarantineRetention();
  }

  private newQuarantinePath(transactionToken: string): string {
    return path.join(
      this.#options.directory,
      `.invalid-remote-transaction.${transactionToken}.${randomUUID()}.quarantine`,
    );
  }

  private async preserveAuthenticatedGeneration(
    quarantinePath: string,
    transactionToken: string,
  ): Promise<void> {
    const preservedPath = path.join(
      this.#options.directory,
      `.preserved-remote-transaction.${transactionToken}.${randomUUID()}.authority`,
    );
    try {
      await rename(quarantinePath, preservedPath);
    } catch (error) {
      if (readErrorCode(error) === "ENOENT") return;
      throw error;
    }
    await this.syncStorageDirectory();
  }

  private async readQuarantineEvidence(
    quarantinePath: string,
  ): Promise<RemoteTransactionQuarantineEvidence> {
    try {
      return await readStableRemoteTransactionRecordBytes({
        targetPath: quarantinePath,
        platform: this.#options.platform,
        maximumEncodedBytes: this.#options.maximumBytes,
        assertIntegrityAuthority: this.#options.assertIntegrityAuthority,
      });
    } catch (error) {
      if (error instanceof QuarantinableRemoteTransactionRecordIntegrityError) {
        return error.quarantineEvidence();
      }
      throw error;
    }
  }

  private async publishQuarantineBytes(
    transactionToken: string,
    contents: Buffer,
  ): Promise<string> {
    const quarantinePath = this.newQuarantinePath(transactionToken);
    let published = false;
    let quarantineIdentity: BigIntStats;
    const handle = await open(quarantinePath, "wx", 0o600);
    try {
      await handle.writeFile(contents);
      if (this.#options.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
      quarantineIdentity = await handle.stat({ bigint: true });
      assertPhysicalTransactionRecordFile(quarantineIdentity, this.#options.platform);
      published = true;
    } finally {
      await handle.close();
      if (!published) await rm(quarantinePath, { force: true }).catch(() => undefined);
    }
    const namedQuarantine = await lstat(quarantinePath, { bigint: true });
    assertPhysicalTransactionRecordFile(namedQuarantine, this.#options.platform);
    if (!samePhysicalFile(quarantineIdentity, namedQuarantine)) {
      throw new Error("Remote transaction quarantine generation changed before publication");
    }
    await this.syncStorageDirectory();
    return quarantinePath;
  }

  private async restoreAuthenticatedRecord(targetPath: string, contents: Buffer): Promise<boolean> {
    const tempPath = path.join(
      this.#options.directory,
      `.restore-remote-transaction.${process.pid}.${randomUUID()}.tmp`,
    );
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(contents);
      if (this.#options.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await this.#options.assertIntegrityAuthority();
      try {
        await link(tempPath, targetPath);
      } catch (error) {
        if (readErrorCode(error) === "EEXIST") return false;
        throw error;
      }
      await this.syncStorageDirectory();
      return true;
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
      await this.syncStorageDirectory();
    }
  }

  private async retireQuarantineGeneration(
    quarantinePath: string,
    transactionToken: string,
    expectedIdentity: BigIntStats,
    expectedContents?: Buffer,
  ): Promise<boolean> {
    const retiredPath = this.newQuarantinePath(transactionToken);
    try {
      await rename(quarantinePath, retiredPath);
    } catch (error) {
      if (readErrorCode(error) === "ENOENT") return false;
      throw error;
    }
    await this.syncStorageDirectory();
    const retired = await this.readQuarantineEvidence(retiredPath);
    if (
      !sameFileGeneration(expectedIdentity, retired.fileIdentity) ||
      expectedIdentity.size !== retired.fileIdentity.size ||
      (expectedContents !== undefined &&
        (retired.contents === undefined || !retired.contents.equals(expectedContents)))
    ) {
      return false;
    }
    await rm(retiredPath);
    await this.syncStorageDirectory();
    return true;
  }

  private async maintainQuarantineRetention(): Promise<void> {
    await this.withQuarantineMaintenanceLock(async () => this.pruneQuarantineRecords());
  }

  private async pruneQuarantineRecords(): Promise<void> {
    await this.#options.assertIntegrityAuthority();
    const candidates: Array<{
      name: string;
      transactionToken: string;
      path: string;
      identity: BigIntStats;
    }> = [];
    for (const name of await readdir(this.#options.directory)) {
      const match = REMOTE_TRANSACTION_QUARANTINE_PATTERN.exec(name);
      if (!match?.[1]) continue;
      const candidatePath = path.join(this.#options.directory, name);
      let identity: BigIntStats;
      try {
        identity = await lstat(candidatePath, { bigint: true });
      } catch (error) {
        if (readErrorCode(error) === "ENOENT") continue;
        throw error;
      }
      if (!isPhysicalTransactionRecordFile(identity, this.#options.platform)) continue;
      candidates.push({ name, transactionToken: match[1], path: candidatePath, identity });
    }
    candidates.sort((left, right) => {
      if (left.identity.mtimeNs !== right.identity.mtimeNs) {
        return left.identity.mtimeNs < right.identity.mtimeNs ? -1 : 1;
      }
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    });

    let retainedRecords = candidates.length;
    let retainedBytes = candidates.reduce(
      (total, candidate) => total + candidate.identity.size,
      0n,
    );
    const maximumBytes = BigInt(this.#options.maximumQuarantineBytes);
    for (const candidate of candidates) {
      if (
        retainedRecords <= this.#options.maximumQuarantineRecords &&
        retainedBytes <= maximumBytes
      ) {
        break;
      }
      if (
        await this.retireQuarantineGeneration(
          candidate.path,
          candidate.transactionToken,
          candidate.identity,
        )
      ) {
        retainedRecords -= 1;
        retainedBytes -= candidate.identity.size;
      }
    }
  }

  private async pruneExpiredTerminalRecords(): Promise<void> {
    const cutoff = this.#options.now() - this.#options.terminalRetentionMs;
    await this.#options.assertIntegrityAuthority();
    const names = await readdir(this.#options.directory);
    let removed = false;
    for (const name of names) {
      const match = REMOTE_TRANSACTION_RECORD_PATTERN.exec(name);
      if (!match?.[1]) continue;
      const targetPath = this.#options.recordPath(match[1]);
      let record: RemoteTransactionRecord;
      try {
        record = (await this.#options.readAuthenticatedRecord(targetPath, match[1])).record;
      } catch (error) {
        if (readErrorCode(error) === "ENOENT") continue;
        if (error instanceof QuarantinableRemoteTransactionRecordIntegrityError) {
          await this.quarantineInvalidRecord(targetPath, match[1], error);
          continue;
        }
        throw error;
      }
      if (
        !isTerminalRemoteTransactionState(record.state) ||
        Date.parse(record.updatedAt) > cutoff
      ) {
        continue;
      }
      if (record.artifactNamespaceState !== "uninitialized") {
        const cleanup = this.#artifactNamespaceCleanup;
        if (!cleanup) continue;
        let cleaned = false;
        try {
          cleaned = await cleanup(record);
        } catch {
          continue;
        }
        if (!cleaned) continue;
      }
      await this.#options.assertIntegrityAuthority();
      await rm(targetPath, { force: true });
      removed = true;
    }
    if (removed) await this.syncStorageDirectory();
  }

  private async assertCapacity(
    contentsBytes: number,
    replacedPath?: string,
    reservationBytes = 0,
  ): Promise<void> {
    await this.#options.assertIntegrityAuthority();
    const names = await readdir(this.#options.directory);
    let records = 0;
    let storedBytes = 0;
    let replacedBytes = 0;
    for (const name of names) {
      const match = REMOTE_TRANSACTION_RECORD_PATTERN.exec(name);
      if (!match?.[1]) continue;
      const candidatePath = path.join(this.#options.directory, name);
      let authenticated: { record: RemoteTransactionRecord; byteLength: number };
      try {
        authenticated = await this.#options.readAuthenticatedRecord(candidatePath, match[1]);
      } catch (error) {
        if (readErrorCode(error) === "ENOENT") continue;
        if (error instanceof QuarantinableRemoteTransactionRecordIntegrityError) {
          await this.quarantineInvalidRecord(candidatePath, match[1], error);
          continue;
        }
        throw error;
      }
      const chargedBytes = Math.max(
        authenticated.byteLength,
        authenticated.record.capacityReservationBytes ?? 0,
      );
      records += 1;
      storedBytes += chargedBytes;
      if (replacedPath === candidatePath) replacedBytes = chargedBytes;
    }
    const nextRecords = replacedPath ? records : records + 1;
    const requestedBytes = Math.max(contentsBytes, reservationBytes);
    const nextBytes = storedBytes - replacedBytes + requestedBytes;
    if (nextRecords > this.#options.maximumRecords || nextBytes > this.#options.maximumBytes) {
      throw new RemoteTransactionCapacityError({
        maximumRecords: this.#options.maximumRecords,
        maximumBytes: this.#options.maximumBytes,
        currentRecords: records,
        currentBytes: storedBytes,
        requestedBytes,
      });
    }
  }

  private async syncStorageDirectory(): Promise<void> {
    await this.#options.assertIntegrityAuthority();
    await syncDirectory(this.#options.directory);
  }

  private async withMaintenanceLock<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#maintenanceLock;
    const gate = Promise.withResolvers<void>();
    this.#maintenanceLock = prior.then(() => gate.promise);
    await prior;
    try {
      return await this.#options.withWindowsPrivateTreeAuthority(operation);
    } finally {
      gate.resolve();
    }
  }

  private async withQuarantineMaintenanceLock<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#quarantineMaintenanceLock;
    const gate = Promise.withResolvers<void>();
    this.#quarantineMaintenanceLock = prior.then(() => gate.promise);
    await prior;
    try {
      return await this.#options.withWindowsPrivateTreeAuthority(operation);
    } finally {
      gate.resolve();
    }
  }
}
