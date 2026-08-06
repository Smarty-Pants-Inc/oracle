import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import {
  capturePhysicalDirectoryIdentity,
  samePhysicalDirectoryIdentity,
  type PhysicalDirectoryIdentity,
} from "../browser/filesystemLockDirectoryIdentity.js";
import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import type { BrowserModelSelectionEvidence, BrowserRuntimeMetadata } from "../sessionManager.js";
import { syncDirectory } from "../fsDurability.js";
import {
  applyRemoteTransactionTransition,
  createRemoteTransactionRecord,
} from "./transactionReducer.js";
import type {
  DurableRemoteArtifactDeliveryReceipt,
  DurableRemoteArtifactManualCopyWaiver,
  DurableRemoteArtifactRegistration,
  DurableRemoteAutomationError,
  DurableRemoteCaptureWarning,
  ExpiredRemoteTransactionSettlement,
  ReconcileRemoteTransactionResult,
  RemoteTransactionBeginRecord,
  RemoteTransactionControllerShutdownPlan,
  RemoteTransactionRecord,
  RemoteTransactionSettlementBinding,
  RemoteTransactionSettlementExecution,
  RemoteTransactionTransition,
  RemoteTransactionTransitionOutcome,
  RemoteTransactionTransitionType,
} from "./transactionModel.js";
import {
  isTerminalRemoteTransactionState,
  validateRemoteTransactionRecord,
} from "./transactionValidation.js";
import {
  MAX_REMOTE_TRANSACTION_RECORDS,
  MAX_REMOTE_TRANSACTION_STORE_BYTES,
  REMOTE_TERMINAL_RETENTION_MS,
  REMOTE_TRANSACTION_TOKEN_PATTERN,
  type RemotePublicRunResult,
} from "./types.js";

const MAX_REMOTE_TRANSACTION_LEASE_MS = 24 * 60 * 60 * 1000;
const REMOTE_TRANSACTION_RECORD_ENVELOPE_VERSION = 1;
const REMOTE_TRANSACTION_RECORD_ALGORITHM = "hmac-sha256";
const REMOTE_TRANSACTION_KEY_ID_DOMAIN =
  "oracle.remote-controller.transaction-store.integrity-key-id.v1";
const REMOTE_TRANSACTION_RECORD_MAC_DOMAIN = "oracle.remote-controller.transaction-store.record.v1";
const REMOTE_TRANSACTION_RECORD_MAC_PATTERN = /^[a-f0-9]{64}$/u;
const REMOTE_TRANSACTION_RECORD_KEY_ID_PATTERN = /^[a-f0-9]{64}$/u;
const REMOTE_TRANSACTION_INTEGRITY_KEY_BYTES = 32;
type RemoteArtifactNamespaceCleanup = (record: RemoteTransactionRecord) => Promise<boolean>;
type RemoteTransactionRecordEnvelope = {
  version: typeof REMOTE_TRANSACTION_RECORD_ENVELOPE_VERSION;
  algorithm: typeof REMOTE_TRANSACTION_RECORD_ALGORITHM;
  keyId: string;
  payload: string;
  mac: string;
};
type RemoteTransactionIntegrityKey = {
  bytes: Buffer;
  keyId: string;
  path: string;
  fileIdentity: BigIntStats;
  directory: string;
  directoryIdentity: PhysicalDirectoryIdentity;
};

export interface RemoteTransactionStoreOptions {
  directory: string;
  integrityKeyPath: string;
  controllerGeneration?: string;
  terminalRetentionMs?: number;
  maximumRecords?: number;
  maximumBytes?: number;
  now?: () => number;
  leaseDurationMs?: number;
}
export class RemoteTransactionStore {
  readonly directory: string;
  readonly controllerGeneration: string;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #terminalRetentionMs: number;
  readonly #leaseDurationMs: number;
  readonly #maximumRecords: number;
  readonly #maximumBytes: number;
  readonly #now: () => number;
  readonly #integrityKey: Buffer;
  readonly #integrityKeyId: string;
  readonly #integrityKeyPath: string;
  readonly #integrityKeyFileIdentity: BigIntStats;
  readonly #integrityKeyDirectory: string;
  readonly #integrityKeyDirectoryIdentity: PhysicalDirectoryIdentity;
  readonly #storeRootIdentity: PhysicalDirectoryIdentity;
  #maintenanceLock: Promise<void> = Promise.resolve();
  #artifactNamespaceCleanup?: RemoteArtifactNamespaceCleanup;

  private constructor(
    options: RemoteTransactionStoreOptions,
    storeRootIdentity: PhysicalDirectoryIdentity,
    integrityKey: RemoteTransactionIntegrityKey,
  ) {
    this.directory = path.resolve(options.directory);
    this.controllerGeneration = options.controllerGeneration ?? randomUUID();
    this.#terminalRetentionMs = options.terminalRetentionMs ?? REMOTE_TERMINAL_RETENTION_MS;
    this.#leaseDurationMs = options.leaseDurationMs ?? MAX_REMOTE_TRANSACTION_LEASE_MS;
    this.#maximumRecords = options.maximumRecords ?? MAX_REMOTE_TRANSACTION_RECORDS;
    this.#maximumBytes = options.maximumBytes ?? MAX_REMOTE_TRANSACTION_STORE_BYTES;
    this.#now = options.now ?? Date.now;
    this.#integrityKey = integrityKey.bytes;
    this.#integrityKeyId = integrityKey.keyId;
    this.#integrityKeyPath = integrityKey.path;
    this.#integrityKeyFileIdentity = integrityKey.fileIdentity;
    this.#integrityKeyDirectory = integrityKey.directory;
    this.#integrityKeyDirectoryIdentity = integrityKey.directoryIdentity;
    this.#storeRootIdentity = storeRootIdentity;
    if (
      !Number.isSafeInteger(this.#terminalRetentionMs) ||
      this.#terminalRetentionMs < 0 ||
      !Number.isSafeInteger(this.#leaseDurationMs) ||
      this.#leaseDurationMs <= 0 ||
      this.#leaseDurationMs > MAX_REMOTE_TRANSACTION_LEASE_MS ||
      !Number.isSafeInteger(this.#maximumRecords) ||
      this.#maximumRecords <= 0 ||
      !Number.isSafeInteger(this.#maximumBytes) ||
      this.#maximumBytes <= 0
    ) {
      throw new Error("Invalid remote transaction retention, lease, or capacity policy");
    }
  }

  static async open(options: RemoteTransactionStoreOptions): Promise<RemoteTransactionStore> {
    const directory = path.resolve(options.directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);
    await syncDirectory(directory);
    const storeRootIdentity = await capturePhysicalDirectoryIdentity(directory);
    const names = await readdir(directory);
    const hasPersistedRecords = names.some(
      (name) =>
        /^[a-f0-9]{64}\.json$/u.test(name) ||
        /^\.invalid-remote-transaction\.[a-f0-9]{64}\..+\.quarantine$/u.test(name),
    );
    const integrityKey = await loadRemoteTransactionIntegrityKey(
      path.resolve(options.integrityKeyPath),
      hasPersistedRecords,
    );
    const store = new RemoteTransactionStore(
      { ...options, directory, integrityKeyPath: integrityKey.path },
      storeRootIdentity,
      integrityKey,
    );
    await store.runMaintenance();
    return store;
  }

  registerArtifactNamespaceCleanup(cleanup: RemoteArtifactNamespaceCleanup): void {
    this.#artifactNamespaceCleanup = cleanup;
  }

  async begin(record: RemoteTransactionBeginRecord): Promise<void> {
    const persisted = createRemoteTransactionRecord(record, {
      controllerGeneration: this.controllerGeneration,
      leaseDurationMs: this.#leaseDurationMs,
      now: this.#now,
      nowIso: () => this.nowIso(),
    });
    validateRemoteTransactionRecord(persisted, {
      expectedTransactionToken: persisted.transactionToken,
      maximumLeaseDurationMs: this.#leaseDurationMs,
    });
    await this.assertIntegrityAuthority();
    const contents = this.serializeRecord(persisted);
    await this.withMaintenanceLock(async () => {
      await this.pruneExpiredTerminalRecords();
      await this.assertCapacity(contents.byteLength, undefined, persisted.capacityReservationBytes);
      const targetPath = this.recordPath(persisted.transactionToken);
      const tempPath = path.join(
        this.directory,
        `.${persisted.transactionToken}.${process.pid}.${randomUUID()}.tmp`,
      );
      try {
        await this.assertIntegrityAuthority();
        const handle = await open(tempPath, "wx", 0o600);
        try {
          await handle.writeFile(contents);
          if (process.platform !== "win32") await handle.chmod(0o600);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.assertIntegrityAuthority();
        await link(tempPath, targetPath);
        await this.assertIntegrityAuthority();
        await syncDirectory(this.directory);
      } finally {
        await this.assertIntegrityAuthority();
        await rm(tempPath, { force: true });
        await this.assertIntegrityAuthority();
        await syncDirectory(this.directory);
      }
    });
  }

  async read(transactionToken: string): Promise<RemoteTransactionRecord | null> {
    const targetPath = this.recordPath(transactionToken);
    try {
      return (await this.readAuthenticatedRecord(targetPath, transactionToken)).record;
    } catch (error) {
      if (readErrorCode(error) === "ENOENT") return null;
      if (error instanceof QuarantinableRemoteTransactionRecordIntegrityError) {
        await this.quarantineInvalidRecord(targetPath, transactionToken, error);
      }
      throw error;
    }
  }
  async beginArtifactNamespaceInitialization(params: {
    transactionToken: string;
    runId: string;
  }): Promise<RemoteTransactionRecord> {
    return (
      await this.transition(params.transactionToken, {
        type: "begin-artifact-namespace-initialization",
        runId: params.runId,
      })
    ).record;
  }

  async bindArtifactNamespaceIdentity(params: {
    transactionToken: string;
    runId: string;
    identity: NonNullable<RemoteTransactionRecord["artifactNamespaceIdentity"]>;
  }): Promise<RemoteTransactionRecord> {
    return (
      await this.transition(params.transactionToken, {
        type: "bind-artifact-namespace-identity",
        runId: params.runId,
        identity: params.identity,
      })
    ).record;
  }

  async rollbackArtifactNamespaceInitialization(params: {
    transactionToken: string;
    runId: string;
    identity?: NonNullable<RemoteTransactionRecord["artifactNamespaceIdentity"]>;
  }): Promise<RemoteTransactionRecord> {
    return (
      await this.transition(params.transactionToken, {
        type: "rollback-artifact-namespace-initialization",
        runId: params.runId,
        identity: params.identity,
      })
    ).record;
  }

  async completeArtifactNamespaceInitialization(params: {
    transactionToken: string;
    runId: string;
  }): Promise<RemoteTransactionRecord> {
    return (
      await this.transition(params.transactionToken, {
        type: "complete-artifact-namespace-initialization",
        runId: params.runId,
      })
    ).record;
  }

  async renewLease(transactionToken: string): Promise<RemoteTransactionRecord> {
    return (await this.transition(transactionToken, { type: "renew-lease" })).record;
  }

  async listExpiredNonterminalRecords(): Promise<RemoteTransactionRecord[]> {
    await this.runMaintenance();
    await this.assertIntegrityAuthority();
    const expiredAt = this.#now();
    const names = await readdir(this.directory);
    const expired: RemoteTransactionRecord[] = [];
    for (const name of names.sort()) {
      const match = /^([a-f0-9]{64})\.json$/u.exec(name);
      if (!match?.[1]) continue;
      await this.withLock(match[1], async () => {
        const record = await this.read(match[1]);
        if (
          record &&
          !isTerminalRemoteTransactionState(record.state) &&
          Date.parse(record.leaseExpiresAt ?? "") <= expiredAt
        ) {
          expired.push(record);
        }
      });
    }
    return expired;
  }

  async list(): Promise<RemoteTransactionRecord[]> {
    await this.runMaintenance();
    await this.assertIntegrityAuthority();
    const names = await readdir(this.directory);
    const records: RemoteTransactionRecord[] = [];
    for (const name of names.sort()) {
      const match = /^([a-f0-9]{64})\.json$/u.exec(name);
      if (!match?.[1]) continue;
      const record = await this.read(match[1]);
      if (record) records.push(record);
    }
    return records;
  }

  async journalRuntime(
    transactionToken: string,
    runtime: BrowserRuntimeMetadata,
    modelSelection?: BrowserModelSelectionEvidence,
  ): Promise<RemoteTransactionRecord> {
    return (
      await this.transition(transactionToken, {
        type: "journal-runtime",
        runtime,
        modelSelection,
      })
    ).record;
  }

  /**
   * Replaces the durable recovery runtime during an unbound recovery attempt.
   * This is deliberately separate from `journalRuntime`, which is only valid
   * while the initial capture is running.
   */
  async journalRecoveryRuntime(
    transactionToken: string,
    runtime: BrowserRuntimeMetadata,
  ): Promise<RemoteTransactionRecord> {
    return (
      await this.transition(transactionToken, {
        type: "journal-recovery-runtime",
        runtime,
      })
    ).record;
  }

  /**
   * Persists controller runtime only after exact durable settlement binding for
   * a pending capture or an abort-bound recoverable failure.
   */
  async persistSettlementRuntime(
    transactionToken: string,
    runtime: BrowserRuntimeMetadata,
  ): Promise<RemoteTransactionRecord> {
    return (
      await this.transition(transactionToken, {
        type: "persist-settlement-runtime",
        runtime,
      })
    ).record;
  }

  async stageCapture(params: {
    transactionToken: string;
    runId: string;
    result: RemotePublicRunResult;
    runtime: BrowserRuntimeMetadata;
    modelSelection?: BrowserModelSelectionEvidence;
    artifacts?: DurableRemoteArtifactRegistration[];
  }): Promise<RemoteTransactionRecord> {
    return (
      await this.transition(params.transactionToken, {
        type: "stage-capture",
        runId: params.runId,
        result: params.result,
        runtime: params.runtime,
        modelSelection: params.modelSelection,
        artifacts: params.artifacts,
      })
    ).record;
  }

  async promoteStagedCapture(params: {
    transactionToken: string;
    result?: RemotePublicRunResult;
    runtime?: BrowserRuntimeMetadata;
    warning?: DurableRemoteCaptureWarning;
    projectTargetSelectionLoss?: boolean;
  }): Promise<RemoteTransactionRecord> {
    return (
      await this.transition(params.transactionToken, {
        type: "promote-staged-capture",
        result: params.result,
        runtime: params.runtime,
        warning: params.warning,
        projectTargetSelectionLoss: params.projectTargetSelectionLoss ?? false,
      })
    ).record;
  }

  async publishCapture(params: {
    transactionToken: string;
    runId: string;
    result: RemotePublicRunResult;
    runtime: BrowserRuntimeMetadata;
    modelSelection?: BrowserModelSelectionEvidence;
    artifacts?: DurableRemoteArtifactRegistration[];
  }): Promise<RemoteTransactionRecord> {
    return (
      await this.transition(params.transactionToken, {
        type: "publish-capture",
        runId: params.runId,
        result: params.result,
        runtime: params.runtime,
        modelSelection: params.modelSelection,
        artifacts: params.artifacts ?? [],
      })
    ).record;
  }

  async invalidateStagedCapture(params: {
    transactionToken: string;
    runtime?: BrowserRuntimeMetadata;
    error: DurableRemoteAutomationError;
    settlementMode?: "abort";
  }): Promise<RemoteTransactionRecord> {
    return (
      await this.transition(params.transactionToken, {
        type: "invalidate-staged-capture",
        runtime: params.runtime,
        error: params.error,
        settlementMode: params.settlementMode,
      })
    ).record;
  }

  async recordRecoverableFailure(params: {
    transactionToken: string;
    runtime?: BrowserRuntimeMetadata;
    error: DurableRemoteAutomationError;
    settlementMode?: "abort";
  }): Promise<RemoteTransactionRecord> {
    return (
      await this.transition(params.transactionToken, {
        type: "record-failure",
        runtime: params.runtime,
        error: params.error,
        settlementMode: params.settlementMode,
      })
    ).record;
  }

  async recordArtifactDelivery(params: {
    transactionToken: string;
    artifactId: string;
    receipt: DurableRemoteArtifactDeliveryReceipt;
  }): Promise<DurableRemoteArtifactDeliveryReceipt> {
    const transition = await this.transition(params.transactionToken, {
      type: "record-artifact-delivery",
      artifactId: params.artifactId,
      receipt: params.receipt,
    });
    return transition.outcome;
  }

  async recordArtifactManualCopyWaiver(params: {
    transactionToken: string;
    artifactId: string;
    waiver: DurableRemoteArtifactManualCopyWaiver;
  }): Promise<DurableRemoteArtifactManualCopyWaiver | null> {
    const transition = await this.transition(params.transactionToken, {
      type: "record-artifact-manual-copy-waiver",
      artifactId: params.artifactId,
      waiver: params.waiver,
    });
    return transition.outcome;
  }

  async bindSettlement(params: {
    transactionToken: string;
    mode: "finalize" | "abort";
    durablePublication: boolean;
  }): Promise<RemoteTransactionSettlementBinding> {
    const transition = await this.transition(params.transactionToken, {
      type: "bind-settlement",
      mode: params.mode,
      durablePublication: params.durablePublication,
    });
    return { record: transition.record, ...transition.outcome };
  }

  async beginSettlementExecution(params: {
    transactionToken: string;
    mode: "finalize" | "abort";
  }): Promise<RemoteTransactionSettlementExecution> {
    const transition = await this.transition(params.transactionToken, {
      type: "begin-settlement-execution",
      mode: params.mode,
    });
    return { record: transition.record, ...transition.outcome };
  }

  async completeSettlement(params: {
    transactionToken: string;
    mode: "finalize" | "abort";
    finalization: BrowserCaptureFinalizationResult;
  }): Promise<RemoteTransactionRecord> {
    return (
      await this.transition(params.transactionToken, {
        type: "complete-settlement",
        mode: params.mode,
        finalization: params.finalization,
      })
    ).record;
  }
  async prepareControllerShutdown(
    transactionToken: string,
  ): Promise<RemoteTransactionControllerShutdownPlan> {
    const transition = await this.transition(transactionToken, {
      type: "prepare-controller-shutdown",
    });
    return { record: transition.record, ...transition.outcome };
  }

  async expire(params: {
    transactionToken: string;
    expectedLeaseExpiresAt: string;
    buildError: (
      record: RemoteTransactionRecord,
      hadRuntimeAuthority: boolean,
    ) => DurableRemoteAutomationError;
  }): Promise<ExpiredRemoteTransactionSettlement | null> {
    const transition = await this.transition(params.transactionToken, {
      type: "expire",
      expectedLeaseExpiresAt: params.expectedLeaseExpiresAt,
      buildError: params.buildError,
    });
    return transition.outcome;
  }

  async reconcileStaleRunningRecords(params: {
    buildError: (
      record: RemoteTransactionRecord,
      hadRuntimeAuthority: boolean,
    ) => DurableRemoteAutomationError;
  }): Promise<ReconcileRemoteTransactionResult[]> {
    const results: ReconcileRemoteTransactionResult[] = [];
    for (const candidate of await this.list()) {
      const requiresReconciliation =
        candidate.state === "running" ||
        (candidate.state === "recoverable-error" &&
          Boolean(candidate.stagedCapture) &&
          !candidate.settlementMode);
      if (!requiresReconciliation || candidate.controllerGeneration === this.controllerGeneration) {
        continue;
      }
      const transition = await this.transition(candidate.transactionToken, {
        type: "reconcile-controller",
        buildError: params.buildError,
      });
      if (transition.outcome) results.push(transition.outcome);
    }
    return results;
  }

  private async transition<Type extends RemoteTransactionTransitionType>(
    transactionToken: string,
    transition: RemoteTransactionTransition<Type>,
  ): Promise<{
    record: RemoteTransactionRecord;
    outcome: RemoteTransactionTransitionOutcome<Type>;
  }> {
    return await this.withLock(transactionToken, async () => {
      const record = await this.read(transactionToken);
      if (!record) throw new Error(`Remote transaction ${transactionToken} does not exist`);
      const originalRunId = record.runId;
      const originalArtifactNamespace = record.artifactNamespace;
      const applied = applyRemoteTransactionTransition(record, transition, {
        controllerGeneration: this.controllerGeneration,
        leaseDurationMs: this.#leaseDurationMs,
        now: this.#now,
        nowIso: () => this.nowIso(),
      });
      if (applied.persist) {
        if (
          applied.record.transactionToken !== transactionToken ||
          applied.record.runId !== originalRunId ||
          applied.record.artifactNamespace !== originalArtifactNamespace
        ) {
          throw new Error("Remote transaction identity cannot change during a transition");
        }
        validateRemoteTransactionRecord(applied.record, {
          expectedTransactionToken: transactionToken,
          maximumLeaseDurationMs: this.#leaseDurationMs,
        });
        await this.write(applied.record);
      }
      return { record: applied.record, outcome: applied.outcome };
    });
  }

  private async withLock<T>(transactionToken: string, operation: () => Promise<T>): Promise<T> {
    this.recordPath(transactionToken);
    const prior = this.#locks.get(transactionToken) ?? Promise.resolve();
    const gate = Promise.withResolvers<void>();
    const current = prior.then(() => gate.promise);
    this.#locks.set(transactionToken, current);
    await prior;
    try {
      return await operation();
    } finally {
      gate.resolve();
      if (this.#locks.get(transactionToken) === current) this.#locks.delete(transactionToken);
    }
  }

  recordPath(transactionToken: string): string {
    if (!REMOTE_TRANSACTION_TOKEN_PATTERN.test(transactionToken)) {
      throw new Error("Invalid remote transaction token");
    }
    return path.join(this.directory, `${transactionToken}.json`);
  }

  private async write(record: RemoteTransactionRecord): Promise<void> {
    const targetPath = this.recordPath(record.transactionToken);
    const tempPath = path.join(
      this.directory,
      `.${record.transactionToken}.${process.pid}.${randomUUID()}.tmp`,
    );
    await this.assertIntegrityAuthority();
    const contents = this.serializeRecord(record);
    await this.withMaintenanceLock(async () => {
      await this.pruneExpiredTerminalRecords();
      await this.assertCapacity(contents.byteLength, targetPath, record.capacityReservationBytes);
      try {
        await this.assertIntegrityAuthority();
        const handle = await open(tempPath, "wx", 0o600);
        try {
          await handle.writeFile(contents);
          if (process.platform !== "win32") await handle.chmod(0o600);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.assertIntegrityAuthority();
        await rename(tempPath, targetPath);
        await this.assertIntegrityAuthority();
        await syncDirectory(this.directory);
      } finally {
        await this.assertIntegrityAuthority();
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
    });
  }

  private serializeRecord(record: RemoteTransactionRecord): Buffer {
    const payload = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    const envelope: RemoteTransactionRecordEnvelope = {
      version: REMOTE_TRANSACTION_RECORD_ENVELOPE_VERSION,
      algorithm: REMOTE_TRANSACTION_RECORD_ALGORITHM,
      keyId: this.#integrityKeyId,
      payload: payload.toString("base64"),
      mac: this.recordMac(record.transactionToken, payload).toString("hex"),
    };
    return Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  }

  private async readAuthenticatedRecord(
    targetPath: string,
    transactionToken: string,
  ): Promise<{ record: RemoteTransactionRecord; byteLength: number }> {
    const authenticated = await this.readStableRecordBytes(targetPath);
    const { contents } = authenticated;
    try {
      const candidate = JSON.parse(contents.toString("utf8")) as unknown;
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("invalid envelope");
      }
      if (Object.keys(candidate).sort().join(",") !== "algorithm,keyId,mac,payload,version") {
        throw new Error("invalid envelope fields");
      }
      const envelope = candidate as Partial<RemoteTransactionRecordEnvelope>;
      if (
        envelope.version !== REMOTE_TRANSACTION_RECORD_ENVELOPE_VERSION ||
        envelope.algorithm !== REMOTE_TRANSACTION_RECORD_ALGORITHM ||
        typeof envelope.keyId !== "string" ||
        !REMOTE_TRANSACTION_RECORD_KEY_ID_PATTERN.test(envelope.keyId) ||
        envelope.keyId !== this.#integrityKeyId ||
        typeof envelope.payload !== "string" ||
        typeof envelope.mac !== "string" ||
        !REMOTE_TRANSACTION_RECORD_MAC_PATTERN.test(envelope.mac)
      ) {
        throw new Error("invalid envelope authentication");
      }
      const payload = Buffer.from(envelope.payload, "base64");
      if (payload.toString("base64") !== envelope.payload) {
        throw new Error("invalid envelope payload encoding");
      }
      const expectedMac = this.recordMac(transactionToken, payload);
      const actualMac = Buffer.from(envelope.mac, "hex");
      if (
        actualMac.byteLength !== expectedMac.byteLength ||
        !timingSafeEqual(expectedMac, actualMac)
      ) {
        throw new Error("invalid envelope authentication");
      }
      const record = JSON.parse(payload.toString("utf8")) as RemoteTransactionRecord;
      validateRemoteTransactionRecord(record, {
        expectedTransactionToken: transactionToken,
        maximumLeaseDurationMs: this.#leaseDurationMs,
      });
      return { record, byteLength: contents.byteLength };
    } catch {
      throw new QuarantinableRemoteTransactionRecordIntegrityError(
        contents,
        authenticated.fileIdentity,
      );
    }
  }

  private async readStableRecordBytes(
    targetPath: string,
  ): Promise<{ contents: Buffer; fileIdentity: BigIntStats }> {
    await this.assertIntegrityAuthority();
    const before = await lstat(targetPath, { bigint: true });
    assertPhysicalTransactionRecordFile(before);
    const flags =
      process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    const handle = await open(targetPath, flags);
    let contents: Buffer;
    let authenticated: BigIntStats;
    try {
      authenticated = await handle.stat({ bigint: true });
      assertPhysicalTransactionRecordFile(authenticated);
      if (!samePhysicalFile(before, authenticated)) {
        throw new RemoteTransactionRecordIntegrityError();
      }
      contents = await handle.readFile();
      const afterRead = await handle.stat({ bigint: true });
      assertPhysicalTransactionRecordFile(afterRead);
      if (!samePhysicalFile(authenticated, afterRead)) {
        throw new RemoteTransactionRecordIntegrityError();
      }
      authenticated = afterRead;
    } finally {
      await handle.close();
    }
    const namedAfterRead = await lstat(targetPath, { bigint: true });
    assertPhysicalTransactionRecordFile(namedAfterRead);
    if (!samePhysicalFile(authenticated, namedAfterRead)) {
      throw new RemoteTransactionRecordIntegrityError();
    }
    await this.assertIntegrityAuthority();
    return { contents, fileIdentity: namedAfterRead };
  }

  private recordMac(transactionToken: string, payload: Buffer): Buffer {
    const header = Buffer.from(
      JSON.stringify([
        REMOTE_TRANSACTION_RECORD_MAC_DOMAIN,
        REMOTE_TRANSACTION_RECORD_ENVELOPE_VERSION,
        REMOTE_TRANSACTION_RECORD_ALGORITHM,
        this.#integrityKeyId,
        this.directory,
        transactionToken,
        payload.byteLength,
      ]),
      "utf8",
    );
    return createHmac("sha256", this.#integrityKey)
      .update(header)
      .update(Buffer.of(0))
      .update(payload)
      .digest();
  }

  private async assertIntegrityAuthority(): Promise<void> {
    const currentRoot = await capturePhysicalDirectoryIdentity(this.directory);
    if (!samePhysicalDirectoryIdentity(currentRoot, this.#storeRootIdentity)) {
      throw new Error("Remote transaction store root generation changed");
    }
    const currentKeyDirectory = await capturePhysicalDirectoryIdentity(this.#integrityKeyDirectory);
    if (!samePhysicalDirectoryIdentity(currentKeyDirectory, this.#integrityKeyDirectoryIdentity)) {
      throw new Error("Remote transaction integrity key directory generation changed");
    }
    const currentKey = await lstat(this.#integrityKeyPath, { bigint: true });
    assertProtectedIntegrityKeyFile(currentKey);
    if (!samePhysicalFile(currentKey, this.#integrityKeyFileIdentity)) {
      throw new Error("Remote transaction integrity key generation changed");
    }
  }

  private async quarantineInvalidRecord(
    targetPath: string,
    transactionToken: string,
    failure: QuarantinableRemoteTransactionRecordIntegrityError,
  ): Promise<void> {
    const quarantinePath = path.join(
      this.directory,
      `.invalid-remote-transaction.${transactionToken}.${randomUUID()}.quarantine`,
    );
    const evidence = failure.quarantineEvidence();
    await this.assertIntegrityAuthority();
    let currentBefore: BigIntStats;
    try {
      currentBefore = await lstat(targetPath, { bigint: true });
    } catch (error) {
      if (readErrorCode(error) === "ENOENT") return;
      throw error;
    }
    if (!isPhysicalTransactionRecordFile(currentBefore)) return;
    if (!samePhysicalFile(evidence.fileIdentity, currentBefore)) return;

    let published = false;
    let quarantineIdentity: BigIntStats;
    const handle = await open(quarantinePath, "wx", 0o600);
    try {
      await handle.writeFile(evidence.contents);
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
      quarantineIdentity = await handle.stat({ bigint: true });
      assertPhysicalTransactionRecordFile(quarantineIdentity);
      published = true;
    } finally {
      await handle.close();
      if (!published) await rm(quarantinePath, { force: true }).catch(() => undefined);
    }
    const namedQuarantine = await lstat(quarantinePath, { bigint: true });
    assertPhysicalTransactionRecordFile(namedQuarantine);
    if (!samePhysicalFile(quarantineIdentity, namedQuarantine)) {
      throw new Error("Remote transaction quarantine generation changed before publication");
    }
    await this.assertIntegrityAuthority();
    await syncDirectory(this.directory);

    let currentAfter: BigIntStats;
    try {
      currentAfter = await lstat(targetPath, { bigint: true });
    } catch (error) {
      if (readErrorCode(error) === "ENOENT") return;
      throw error;
    }
    if (!isPhysicalTransactionRecordFile(currentAfter)) return;
    if (!samePhysicalFile(evidence.fileIdentity, currentAfter)) return;
    await unlink(targetPath);
    await this.assertIntegrityAuthority();
    await syncDirectory(this.directory);
  }

  private async runMaintenance(): Promise<void> {
    await this.withMaintenanceLock(async () => this.pruneExpiredTerminalRecords());
  }

  private async pruneExpiredTerminalRecords(): Promise<void> {
    const cutoff = this.#now() - this.#terminalRetentionMs;
    await this.assertIntegrityAuthority();
    const names = await readdir(this.directory);
    let removed = false;
    for (const name of names) {
      const match = /^([a-f0-9]{64})\.json$/u.exec(name);
      if (!match?.[1]) continue;
      const targetPath = this.recordPath(match[1]);
      let record: RemoteTransactionRecord;
      try {
        record = (await this.readAuthenticatedRecord(targetPath, match[1])).record;
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
      await this.assertIntegrityAuthority();
      await rm(targetPath, { force: true });
      removed = true;
    }
    if (removed) {
      await this.assertIntegrityAuthority();
      await syncDirectory(this.directory);
    }
  }

  private async assertCapacity(
    contentsBytes: number,
    replacedPath?: string,
    reservationBytes = 0,
  ): Promise<void> {
    await this.assertIntegrityAuthority();
    const names = await readdir(this.directory);
    let records = 0;
    let storedBytes = 0;
    let replacedBytes = 0;
    for (const name of names) {
      const match = /^([a-f0-9]{64})\.json$/u.exec(name);
      if (!match?.[1]) continue;
      const candidatePath = path.join(this.directory, name);
      let authenticated: { record: RemoteTransactionRecord; byteLength: number };
      try {
        authenticated = await this.readAuthenticatedRecord(candidatePath, match[1]);
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
    if (nextRecords > this.#maximumRecords || nextBytes > this.#maximumBytes) {
      throw new RemoteTransactionCapacityError({
        maximumRecords: this.#maximumRecords,
        maximumBytes: this.#maximumBytes,
        currentRecords: records,
        currentBytes: storedBytes,
        requestedBytes,
      });
    }
  }

  private async withMaintenanceLock<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#maintenanceLock;
    const gate = Promise.withResolvers<void>();
    this.#maintenanceLock = prior.then(() => gate.promise);
    await prior;
    try {
      return await operation();
    } finally {
      gate.resolve();
    }
  }

  private nowIso(): string {
    return new Date(this.#now()).toISOString();
  }
}

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

export class RemoteTransactionRecordIntegrityError extends Error {
  readonly code = "remote_transaction_record_integrity_failed";

  constructor() {
    super(
      "Remote transaction record failed authenticated validation and cannot authorize recovery",
    );
    this.name = "RemoteTransactionRecordIntegrityError";
  }
}

class QuarantinableRemoteTransactionRecordIntegrityError extends RemoteTransactionRecordIntegrityError {
  readonly #contents: Buffer;
  readonly #fileIdentity: BigIntStats;

  constructor(contents: Buffer, fileIdentity: BigIntStats) {
    super();
    this.#contents = contents;
    this.#fileIdentity = fileIdentity;
  }

  quarantineEvidence(): { contents: Buffer; fileIdentity: BigIntStats } {
    return { contents: this.#contents, fileIdentity: this.#fileIdentity };
  }
}

async function loadRemoteTransactionIntegrityKey(
  integrityKeyPath: string,
  hasPersistedRecords: boolean,
): Promise<RemoteTransactionIntegrityKey> {
  const directory = path.dirname(integrityKeyPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
  await syncDirectory(directory);
  const directoryIdentity = await capturePhysicalDirectoryIdentity(directory);
  try {
    return await readRemoteTransactionIntegrityKey(integrityKeyPath, directory, directoryIdentity);
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
    return await readRemoteTransactionIntegrityKey(integrityKeyPath, directory, directoryIdentity);
  }
  try {
    await handle.writeFile(key);
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directoryAfterWrite = await capturePhysicalDirectoryIdentity(directory);
  if (!samePhysicalDirectoryIdentity(directoryAfterWrite, directoryIdentity)) {
    throw new Error(
      "Remote transaction integrity key directory generation changed during creation",
    );
  }
  await syncDirectory(directory);
  return await readRemoteTransactionIntegrityKey(integrityKeyPath, directory, directoryIdentity);
}

async function readRemoteTransactionIntegrityKey(
  integrityKeyPath: string,
  directory: string,
  directoryIdentity: PhysicalDirectoryIdentity,
): Promise<RemoteTransactionIntegrityKey> {
  const before = await lstat(integrityKeyPath, { bigint: true });
  assertProtectedIntegrityKeyFile(before);
  const flags =
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(integrityKeyPath, flags);
  let bytes: Buffer;
  let authenticated: BigIntStats;
  try {
    authenticated = await handle.stat({ bigint: true });
    assertProtectedIntegrityKeyFile(authenticated);
    if (!samePhysicalFile(before, authenticated)) {
      throw new Error("Remote transaction integrity key changed before authenticated read");
    }
    bytes = await handle.readFile();
    const afterRead = await handle.stat({ bigint: true });
    assertProtectedIntegrityKeyFile(afterRead);
    if (!samePhysicalFile(authenticated, afterRead)) {
      throw new Error("Remote transaction integrity key changed during authenticated read");
    }
    authenticated = afterRead;
  } finally {
    await handle.close();
  }
  const namedAfterRead = await lstat(integrityKeyPath, { bigint: true });
  assertProtectedIntegrityKeyFile(namedAfterRead);
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
  const keyId = createHash("sha256")
    .update(REMOTE_TRANSACTION_KEY_ID_DOMAIN, "utf8")
    .update(Buffer.of(0))
    .update(bytes)
    .digest("hex");
  return {
    bytes,
    keyId,
    path: integrityKeyPath,
    fileIdentity: namedAfterRead,
    directory,
    directoryIdentity,
  };
}

function isPhysicalTransactionRecordFile(entry: BigIntStats): boolean {
  return (
    entry.isFile() &&
    !entry.isSymbolicLink() &&
    entry.nlink === 1n &&
    (process.platform === "win32" ||
      ((entry.mode & 0o777n) === 0o600n && isOwnedByControllerUser(entry)))
  );
}

function assertPhysicalTransactionRecordFile(entry: BigIntStats): void {
  if (!isPhysicalTransactionRecordFile(entry)) {
    throw new RemoteTransactionRecordIntegrityError();
  }
}

function assertProtectedIntegrityKeyFile(entry: BigIntStats): void {
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n) {
    throw new Error("Remote transaction integrity key is not a singly linked physical file");
  }
  if (process.platform === "win32") return;
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

function samePhysicalFile(left: BigIntStats, right: BigIntStats): boolean {
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

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
