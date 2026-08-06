import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
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
  protectWindowsPrivateTreeAcl,
  type WindowsPrivateTreeAuthority,
  type WindowsPrivateTreeScope,
} from "./windowsPrivateTreeAcl.js";
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
  authenticateRemoteTransactionRecordEnvelope,
  serializeRemoteTransactionRecord,
  type RemoteTransactionExpectedHead,
} from "./transactionRecordEnvelope.js";
import {
  assertProtectedIntegrityKeyFile,
  loadRemoteTransactionIntegrityKey,
  publishSerializedRecord,
  QuarantinableRemoteTransactionRecordIntegrityError,
  readErrorCode,
  readStableRemoteTransactionRecordBytes,
  samePhysicalFile,
  type RemoteTransactionIntegrityKey,
  type RemoteTransactionPublicationCheckpoint,
  type RemoteTransactionPublicationOperation,
} from "./transactionRecordStorage.js";
import {
  isPersistedRemoteTransactionStoreEntry,
  RemoteTransactionStoreMaintenance,
} from "./transactionStoreMaintenance.js";
import {
  MAX_REMOTE_TRANSACTION_RECORDS,
  MAX_REMOTE_TRANSACTION_STORE_BYTES,
  REMOTE_TERMINAL_RETENTION_MS,
  REMOTE_TRANSACTION_TOKEN_PATTERN,
  type RemotePublicRunResult,
} from "./types.js";

const MAX_REMOTE_TRANSACTION_LEASE_MS = 24 * 60 * 60 * 1000;
type RemoteArtifactNamespaceCleanup = (record: RemoteTransactionRecord) => Promise<boolean>;

export interface RemoteTransactionStoreOptions {
  directory: string;
  integrityKeyPath: string;
  controllerGeneration?: string;
  terminalRetentionMs?: number;
  maximumRecords?: number;
  maximumBytes?: number;
  maximumDecodedRecordBytes?: number;
  maximumQuarantineRecords?: number;
  maximumQuarantineBytes?: number;
  now?: () => number;
  leaseDurationMs?: number;
  beforeQuarantineUnlink?: () => Promise<void>;
  platform?: NodeJS.Platform;
  windowsPrivateTreeAuthority?: WindowsPrivateTreeAuthority;
  afterRecordPublication?: (
    operation: RemoteTransactionPublicationOperation,
    checkpoint: RemoteTransactionPublicationCheckpoint,
  ) => Promise<void>;
}
export class RemoteTransactionStore {
  readonly directory: string;
  readonly controllerGeneration: string;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #leaseDurationMs: number;
  readonly #maximumBytes: number;
  readonly #maximumDecodedRecordBytes: number;
  readonly #now: () => number;
  readonly #platform: NodeJS.Platform;
  readonly #windowsPrivateTreeAuthority?: WindowsPrivateTreeAuthority;
  readonly #windowsPrivateTreeScope: WindowsPrivateTreeScope;
  readonly #windowsAuthorityContext = new AsyncLocalStorage<boolean>();
  readonly #afterRecordPublication?: RemoteTransactionStoreOptions["afterRecordPublication"];
  readonly #integrityKey: RemoteTransactionIntegrityKey;
  readonly #storeRootIdentity: PhysicalDirectoryIdentity;
  readonly #expectedHeads = new Map<string, RemoteTransactionExpectedHead>();
  readonly #maintenance: RemoteTransactionStoreMaintenance;

  private constructor(
    options: RemoteTransactionStoreOptions,
    storeRootIdentity: PhysicalDirectoryIdentity,
    integrityKey: RemoteTransactionIntegrityKey,
    windowsPrivateTreeAuthority: WindowsPrivateTreeAuthority | undefined,
  ) {
    this.directory = path.resolve(options.directory);
    this.controllerGeneration = options.controllerGeneration ?? randomUUID();
    const terminalRetentionMs = options.terminalRetentionMs ?? REMOTE_TERMINAL_RETENTION_MS;
    this.#leaseDurationMs = options.leaseDurationMs ?? MAX_REMOTE_TRANSACTION_LEASE_MS;
    const maximumRecords = options.maximumRecords ?? MAX_REMOTE_TRANSACTION_RECORDS;
    this.#maximumBytes = options.maximumBytes ?? MAX_REMOTE_TRANSACTION_STORE_BYTES;
    this.#maximumDecodedRecordBytes =
      options.maximumDecodedRecordBytes ?? MAX_REMOTE_TRANSACTION_STORE_BYTES;
    const maximumQuarantineRecords =
      options.maximumQuarantineRecords ?? MAX_REMOTE_TRANSACTION_RECORDS;
    const maximumQuarantineBytes =
      options.maximumQuarantineBytes ?? MAX_REMOTE_TRANSACTION_STORE_BYTES;
    this.#now = options.now ?? Date.now;
    this.#platform = options.platform ?? process.platform;
    this.#windowsPrivateTreeAuthority = windowsPrivateTreeAuthority;
    this.#windowsPrivateTreeScope = {
      storeDirectory: this.directory,
      integrityKeyDirectory: integrityKey.directory,
      integrityKeyPath: integrityKey.path,
    };
    this.#afterRecordPublication = options.afterRecordPublication;
    this.#integrityKey = integrityKey;
    this.#storeRootIdentity = storeRootIdentity;
    if (
      !Number.isSafeInteger(terminalRetentionMs) ||
      terminalRetentionMs < 0 ||
      !Number.isSafeInteger(this.#leaseDurationMs) ||
      this.#leaseDurationMs <= 0 ||
      this.#leaseDurationMs > MAX_REMOTE_TRANSACTION_LEASE_MS ||
      !Number.isSafeInteger(maximumRecords) ||
      maximumRecords <= 0 ||
      !Number.isSafeInteger(this.#maximumBytes) ||
      this.#maximumBytes <= 0 ||
      !Number.isSafeInteger(this.#maximumDecodedRecordBytes) ||
      this.#maximumDecodedRecordBytes <= 0 ||
      !Number.isSafeInteger(maximumQuarantineRecords) ||
      maximumQuarantineRecords <= 0 ||
      !Number.isSafeInteger(maximumQuarantineBytes) ||
      maximumQuarantineBytes <= 0
    ) {
      throw new Error("Invalid remote transaction retention, lease, or capacity policy");
    }
    this.#maintenance = new RemoteTransactionStoreMaintenance({
      directory: this.directory,
      platform: this.#platform,
      terminalRetentionMs,
      maximumRecords,
      maximumBytes: this.#maximumBytes,
      maximumQuarantineRecords,
      maximumQuarantineBytes,
      now: this.#now,
      beforeQuarantineUnlink: options.beforeQuarantineUnlink,
      assertIntegrityAuthority: () => this.assertIntegrityAuthority(),
      withWindowsPrivateTreeAuthority: (operation) =>
        this.withWindowsPrivateTreeAuthority(operation),
      readAuthenticatedRecord: (targetPath, transactionToken) =>
        this.readAuthenticatedRecord(targetPath, transactionToken),
      recordPath: (transactionToken) => this.recordPath(transactionToken),
    });
  }

  static async open(options: RemoteTransactionStoreOptions): Promise<RemoteTransactionStore> {
    const platform = options.platform ?? process.platform;
    const directory = path.resolve(options.directory);
    const integrityKeyPath = path.resolve(options.integrityKeyPath);
    const integrityKeyDirectory = path.dirname(integrityKeyPath);
    const windowsPrivateTreeAuthority =
      platform === "win32"
        ? (options.windowsPrivateTreeAuthority ?? protectWindowsPrivateTreeAcl)
        : undefined;
    const windowsPrivateTreeScope = {
      storeDirectory: directory,
      integrityKeyDirectory,
      integrityKeyPath,
    };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(integrityKeyDirectory, { recursive: true, mode: 0o700 });
    const storeRootBeforeWindowsAuthority =
      platform === "win32" ? await capturePhysicalDirectoryIdentity(directory) : undefined;
    const integrityKeyDirectoryBeforeWindowsAuthority =
      platform === "win32"
        ? await capturePhysicalDirectoryIdentity(integrityKeyDirectory)
        : undefined;
    if (platform === "win32") {
      await windowsPrivateTreeAuthority?.(windowsPrivateTreeScope);
    } else {
      await chmod(directory, 0o700);
    }
    await syncDirectory(directory);
    const storeRootIdentity = await capturePhysicalDirectoryIdentity(directory);
    if (
      storeRootBeforeWindowsAuthority &&
      !samePhysicalDirectoryIdentity(storeRootBeforeWindowsAuthority, storeRootIdentity)
    ) {
      throw new Error(
        "Remote transaction store root generation changed during Windows private ACL protection",
      );
    }
    const integrityKeyDirectoryIdentity =
      await capturePhysicalDirectoryIdentity(integrityKeyDirectory);
    if (
      integrityKeyDirectoryBeforeWindowsAuthority &&
      !samePhysicalDirectoryIdentity(
        integrityKeyDirectoryBeforeWindowsAuthority,
        integrityKeyDirectoryIdentity,
      )
    ) {
      throw new Error(
        "Remote transaction integrity key directory generation changed during Windows private ACL protection",
      );
    }
    const names = await readdir(directory);
    const storeRootAfterInventory = await capturePhysicalDirectoryIdentity(directory);
    if (!samePhysicalDirectoryIdentity(storeRootIdentity, storeRootAfterInventory)) {
      throw new Error("Remote transaction store root generation changed during inventory");
    }
    const hasPersistedRecords = names.some(isPersistedRemoteTransactionStoreEntry);
    const integrityKey = await loadRemoteTransactionIntegrityKey(
      integrityKeyPath,
      hasPersistedRecords,
      {
        platform,
        windowsPrivateTreeAuthority,
        windowsPrivateTreeScope,
        expectedDirectoryIdentity: platform === "win32" ? integrityKeyDirectoryIdentity : undefined,
      },
    );
    const store = new RemoteTransactionStore(
      { ...options, directory, integrityKeyPath: integrityKey.path, platform },
      storeRootIdentity,
      integrityKey,
      windowsPrivateTreeAuthority,
    );
    await store.#maintenance.run();
    return store;
  }

  registerArtifactNamespaceCleanup(cleanup: RemoteArtifactNamespaceCleanup): void {
    this.#maintenance.registerArtifactNamespaceCleanup(cleanup);
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
    await this.withLock(persisted.transactionToken, async () => {
      if (this.#expectedHeads.has(persisted.transactionToken)) {
        throw Object.assign(new Error("Remote transaction already exists"), { code: "EEXIST" });
      }
      await this.assertIntegrityAuthority();
      const serialized = serializeRemoteTransactionRecord({
        record: persisted,
        revision: 1,
        integrityKey: this.#integrityKey.bytes,
        integrityKeyId: this.#integrityKey.keyId,
        directory: this.directory,
      });
      const targetPath = this.recordPath(persisted.transactionToken);
      await publishSerializedRecord({
        mode: "create",
        directory: this.directory,
        targetPath,
        transactionToken: persisted.transactionToken,
        serialized,
        platform: this.#platform,
        maximumEncodedBytes: this.#maximumBytes,
        expectedHeads: this.#expectedHeads,
        assertIntegrityAuthority: () => this.assertIntegrityAuthority(),
        underMaintenance: (publish) =>
          this.#maintenance.publishWithCapacity(
            serialized.contents.byteLength,
            undefined,
            persisted.capacityReservationBytes,
            publish,
          ),
        afterRecordPublication: this.#afterRecordPublication,
      });
    });
  }

  async read(transactionToken: string): Promise<RemoteTransactionRecord | null> {
    return await this.withLock(transactionToken, async () => this.readUnlocked(transactionToken));
  }

  private async readUnlocked(transactionToken: string): Promise<RemoteTransactionRecord | null> {
    const targetPath = this.recordPath(transactionToken);
    try {
      return (await this.readAuthenticatedRecord(targetPath, transactionToken)).record;
    } catch (error) {
      if (readErrorCode(error) === "ENOENT") return null;
      if (error instanceof QuarantinableRemoteTransactionRecordIntegrityError) {
        await this.#maintenance.quarantineInvalidRecord(targetPath, transactionToken, error);
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
    return await this.withWindowsPrivateTreeAuthority(async () => {
      await this.#maintenance.run();
      await this.assertIntegrityAuthority();
      const expiredAt = this.#now();
      const names = await readdir(this.directory);
      const expired: RemoteTransactionRecord[] = [];
      for (const name of names.sort()) {
        const match = /^([a-f0-9]{64})\.json$/u.exec(name);
        if (!match?.[1]) continue;
        await this.withLock(match[1], async () => {
          const record = await this.readUnlocked(match[1]);
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
    });
  }

  async list(): Promise<RemoteTransactionRecord[]> {
    return await this.withWindowsPrivateTreeAuthority(async () => {
      await this.#maintenance.run();
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
    });
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
      const record = await this.readUnlocked(transactionToken);
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
      return await this.withWindowsPrivateTreeAuthority(operation);
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
    const previousHead = this.#expectedHeads.get(record.transactionToken);
    if (!previousHead || previousHead.revision < 1) {
      throw new Error("Remote transaction controller head is unavailable");
    }
    const serialized = serializeRemoteTransactionRecord({
      record,
      revision: previousHead.revision + 1,
      integrityKey: this.#integrityKey.bytes,
      integrityKeyId: this.#integrityKey.keyId,
      directory: this.directory,
    });
    await this.assertIntegrityAuthority();
    await publishSerializedRecord({
      mode: "replace",
      directory: this.directory,
      targetPath,
      transactionToken: record.transactionToken,
      serialized,
      platform: this.#platform,
      maximumEncodedBytes: this.#maximumBytes,
      expectedHeads: this.#expectedHeads,
      assertIntegrityAuthority: () => this.assertIntegrityAuthority(),
      underMaintenance: (publish) =>
        this.#maintenance.publishWithCapacity(
          serialized.contents.byteLength,
          targetPath,
          record.capacityReservationBytes,
          publish,
        ),
      afterRecordPublication: this.#afterRecordPublication,
    });
  }

  private async readAuthenticatedRecord(targetPath: string, transactionToken: string) {
    const authenticated = await readStableRemoteTransactionRecordBytes({
      targetPath,
      platform: this.#platform,
      maximumEncodedBytes: this.#maximumBytes,
      assertIntegrityAuthority: () => this.assertIntegrityAuthority(),
    });
    const { contents } = authenticated;
    try {
      const expectedHead = this.#expectedHeads.get(transactionToken);
      const { record, head } = authenticateRemoteTransactionRecordEnvelope({
        contents,
        transactionToken,
        integrityKey: this.#integrityKey.bytes,
        integrityKeyId: this.#integrityKey.keyId,
        directory: this.directory,
        maximumDecodedRecordBytes: this.#maximumDecodedRecordBytes,
        maximumLeaseDurationMs: this.#leaseDurationMs,
        expectedHead,
      });
      if (!expectedHead) this.#expectedHeads.set(transactionToken, head);
      return {
        record,
        byteLength: contents.byteLength,
        contents,
        fileIdentity: authenticated.fileIdentity,
      };
    } catch {
      throw new QuarantinableRemoteTransactionRecordIntegrityError(
        contents,
        authenticated.fileIdentity,
      );
    }
  }

  private async assertIntegrityAuthority(): Promise<void> {
    const currentRoot = await capturePhysicalDirectoryIdentity(this.directory);
    if (!samePhysicalDirectoryIdentity(currentRoot, this.#storeRootIdentity)) {
      throw new Error("Remote transaction store root generation changed");
    }
    const currentKeyDirectory = await capturePhysicalDirectoryIdentity(
      this.#integrityKey.directory,
    );
    if (!samePhysicalDirectoryIdentity(currentKeyDirectory, this.#integrityKey.directoryIdentity)) {
      throw new Error("Remote transaction integrity key directory generation changed");
    }
    const currentKey = await lstat(this.#integrityKey.path, { bigint: true });
    assertProtectedIntegrityKeyFile(currentKey, this.#platform);
    if (!samePhysicalFile(currentKey, this.#integrityKey.fileIdentity)) {
      throw new Error("Remote transaction integrity key generation changed");
    }
  }

  private async withWindowsPrivateTreeAuthority<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#windowsPrivateTreeAuthority || this.#windowsAuthorityContext.getStore()) {
      return await operation();
    }
    await this.#windowsPrivateTreeAuthority(this.#windowsPrivateTreeScope);
    return await this.#windowsAuthorityContext.run(true, operation);
  }

  private nowIso(): string {
    return new Date(this.#now()).toISOString();
  }
}

export { RemoteTransactionCapacityError } from "./transactionStoreMaintenance.js";
export { RemoteTransactionRecordIntegrityError } from "./transactionRecordStorage.js";
export type { RemoteTransactionPublicationCheckpoint } from "./transactionRecordStorage.js";
