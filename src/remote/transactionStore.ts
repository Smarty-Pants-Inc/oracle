import { randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { samePhysicalDirectoryIdentity } from "../browser/filesystemLockDirectoryIdentity.js";
import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import type { BrowserModelSelectionEvidence, BrowserRuntimeMetadata } from "../sessionManager.js";
import {
  resolveWindowsPrivateTreeAuthority,
  type WindowsPrivateTreeAuthority,
} from "./windowsPrivateTreeAcl.js";
import {
  assertRemoteTransactionStoreRootAuthority,
  prepareRemoteTransactionStoreRoot,
  remoteTransactionHeadDirectory,
  type RemoteTransactionStoreRootAuthority,
} from "./transactionStoreRoot.js";
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
  type AuthenticatedRemoteTransactionRecordEnvelope,
  type RemoteTransactionExpectedHead,
} from "./transactionRecordEnvelope.js";
import {
  loadRemoteTransactionIntegrityKey,
  publishSerializedRecord,
  reclaimRetiredRemoteTransactionHeadAuthority,
  reconcileRemoteTransactionHeadAuthority,
  repairStaleCreatePublicationAliases,
  QuarantinableRemoteTransactionRecordIntegrityError,
  readErrorCode,
  readStableRemoteTransactionRecordBytes,
  RemoteTransactionRecordHeadMismatchError,
  retireRemoteTransactionHeadAuthority,
  type RemoteTransactionIntegrityKey,
  type RemoteTransactionPublicationCheckpoint,
  type RemoteTransactionPublicationOperation,
} from "./transactionRecordStorage.js";
import { RemoteTransactionStoreAuthority } from "./transactionStoreAuthority.js";
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
  authorityDirectory?: string;
  controllerGeneration?: string;
  terminalRetentionMs?: number;
  maximumRecords?: number;
  maximumBytes?: number;
  maximumAuthorityRecords?: number;
  maximumAuthorityBytes?: number;
  maximumDecodedRecordBytes?: number;
  maximumQuarantineRecords?: number;
  maximumQuarantineBytes?: number;
  now?: () => number;
  leaseDurationMs?: number;
  beforeQuarantineUnlink?: () => Promise<void>;
  platform?: NodeJS.Platform;
  windowsPrivateTreeAuthority?: WindowsPrivateTreeAuthority;
  rootAuthority?: RemoteTransactionStoreRootAuthority;
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
  readonly #afterRecordPublication?: RemoteTransactionStoreOptions["afterRecordPublication"];
  readonly #integrityKey: RemoteTransactionIntegrityKey;
  readonly #headDirectory: string;
  readonly #authority: RemoteTransactionStoreAuthority;
  readonly #expectedHeads = new Map<string, RemoteTransactionExpectedHead>();
  readonly #maintenance: RemoteTransactionStoreMaintenance;

  private constructor(
    options: RemoteTransactionStoreOptions,
    rootAuthority: RemoteTransactionStoreRootAuthority,
    integrityKey: RemoteTransactionIntegrityKey,
    windowsPrivateTreeAuthority: WindowsPrivateTreeAuthority | undefined,
  ) {
    this.directory = path.resolve(options.directory);
    this.controllerGeneration = options.controllerGeneration ?? randomUUID();
    const terminalRetentionMs = options.terminalRetentionMs ?? REMOTE_TERMINAL_RETENTION_MS;
    this.#leaseDurationMs = options.leaseDurationMs ?? MAX_REMOTE_TRANSACTION_LEASE_MS;
    const maximumRecords = options.maximumRecords ?? MAX_REMOTE_TRANSACTION_RECORDS;
    const maximumAuthorityRecords =
      options.maximumAuthorityRecords ?? MAX_REMOTE_TRANSACTION_RECORDS;
    const maximumAuthorityBytes =
      options.maximumAuthorityBytes ?? MAX_REMOTE_TRANSACTION_STORE_BYTES;
    this.#maximumBytes = options.maximumBytes ?? MAX_REMOTE_TRANSACTION_STORE_BYTES;
    this.#maximumDecodedRecordBytes =
      options.maximumDecodedRecordBytes ?? MAX_REMOTE_TRANSACTION_STORE_BYTES;
    const maximumQuarantineRecords =
      options.maximumQuarantineRecords ?? MAX_REMOTE_TRANSACTION_RECORDS;
    const maximumQuarantineBytes =
      options.maximumQuarantineBytes ?? MAX_REMOTE_TRANSACTION_STORE_BYTES;
    this.#now = options.now ?? Date.now;
    this.#platform = options.platform ?? process.platform;
    this.#afterRecordPublication = options.afterRecordPublication;
    this.#integrityKey = integrityKey;
    this.#headDirectory = rootAuthority.headDirectory;
    this.#authority = new RemoteTransactionStoreAuthority({
      rootAuthority,
      integrityKey,
      platform: this.#platform,
      windowsPrivateTreeAuthority,
    });
    if (
      !Number.isSafeInteger(terminalRetentionMs) ||
      terminalRetentionMs < 0 ||
      !Number.isSafeInteger(this.#leaseDurationMs) ||
      this.#leaseDurationMs <= 0 ||
      this.#leaseDurationMs > MAX_REMOTE_TRANSACTION_LEASE_MS ||
      !Number.isSafeInteger(maximumRecords) ||
      maximumRecords <= 0 ||
      !Number.isSafeInteger(maximumAuthorityRecords) ||
      maximumAuthorityRecords <= 0 ||
      !Number.isSafeInteger(maximumAuthorityBytes) ||
      maximumAuthorityBytes <= 0 ||
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
      headDirectory: this.#headDirectory,
      directory: this.directory,
      platform: this.#platform,
      terminalRetentionMs,
      maximumRecords,
      maximumAuthorityRecords,
      maximumAuthorityBytes,
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
      retireAuthenticatedRecord: (transactionToken) => this.retireRecordHead(transactionToken),
      reclaimRetiredRecord: (transactionToken) => this.reclaimRetiredRecordHead(transactionToken),
      recordPath: (transactionToken) => this.recordPath(transactionToken),
    });
  }

  static async open(options: RemoteTransactionStoreOptions): Promise<RemoteTransactionStore> {
    const platform = options.platform ?? process.platform;
    const directory = path.resolve(options.directory);
    const integrityKeyPath = path.resolve(options.integrityKeyPath);
    const integrityKeyDirectory = path.dirname(integrityKeyPath);
    const headDirectory = remoteTransactionHeadDirectory(
      integrityKeyPath,
      options.authorityDirectory,
    );
    const windowsPrivateTreeAuthority =
      platform === "win32"
        ? (options.windowsPrivateTreeAuthority ?? resolveWindowsPrivateTreeAuthority())
        : undefined;
    const windowsPrivateTreeScope = {
      storeDirectory: directory,
      authorityDirectory: headDirectory,
      integrityKeyDirectory,
      integrityKeyPath,
    };
    let rootAuthority: RemoteTransactionStoreRootAuthority;
    if (options.rootAuthority) {
      if (
        options.rootAuthority.directory !== directory ||
        options.rootAuthority.headDirectory !== headDirectory ||
        options.rootAuthority.integrityKeyDirectory !== integrityKeyDirectory ||
        options.rootAuthority.platform !== platform
      ) {
        throw new Error("Remote transaction root authority does not match configured paths");
      }
      await assertRemoteTransactionStoreRootAuthority(options.rootAuthority);
      rootAuthority = options.rootAuthority;
    } else {
      rootAuthority = await prepareRemoteTransactionStoreRoot({
        directory,
        integrityKeyPath,
        authorityDirectory: headDirectory,
        platform,
        windowsPrivateTreeAuthority,
      });
    }
    const [names, headNames] = await Promise.all([
      readdir(directory),
      readdir(rootAuthority.headDirectory),
    ]);
    await assertRemoteTransactionStoreRootAuthority(rootAuthority);
    const hasPersistedRecords =
      names.some(isPersistedRemoteTransactionStoreEntry) || headNames.length > 0;
    const integrityKey = await loadRemoteTransactionIntegrityKey(
      integrityKeyPath,
      hasPersistedRecords,
      {
        platform,
        windowsPrivateTreeAuthority,
        windowsPrivateTreeScope,
        expectedDirectoryIdentity: rootAuthority.integrityKeyDirectoryIdentity,
      },
    );
    await assertRemoteTransactionStoreRootAuthority(rootAuthority);
    if (
      !samePhysicalDirectoryIdentity(
        integrityKey.directoryIdentity,
        rootAuthority.integrityKeyDirectoryIdentity,
      )
    ) {
      throw new Error(
        "Remote transaction integrity key directory generation changed during key use",
      );
    }
    const store = new RemoteTransactionStore(
      { ...options, directory, integrityKeyPath: integrityKey.path, platform },
      rootAuthority,
      integrityKey,
      windowsPrivateTreeAuthority,
    );
    await store.withWindowsPrivateTreeAuthority(async () => {
      await repairStaleCreatePublicationAliases({
        directory,
        platform,
        assertIntegrityAuthority: () => store.assertIntegrityAuthority(),
        authenticateTarget: (targetPath, transactionToken, expectedLinkCount) =>
          store.readAuthenticatedRecord(targetPath, transactionToken, expectedLinkCount),
      });
      await store.#maintenance.run();
    });
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
      const targetPath = this.recordPath(persisted.transactionToken);
      try {
        await lstat(targetPath);
        throw Object.assign(new Error("Remote transaction already exists"), { code: "EEXIST" });
      } catch (error) {
        if (readErrorCode(error) !== "ENOENT") throw error;
      }
      await this.reconcileHead(persisted.transactionToken, null);
      await this.assertIntegrityAuthority();
      const serialized = serializeRemoteTransactionRecord({
        record: persisted,
        revision: 1,
        integrityKey: this.#integrityKey.bytes,
        integrityKeyId: this.#integrityKey.keyId,
        directory: this.directory,
      });
      await publishSerializedRecord({
        mode: "create",
        directory: this.directory,
        storeDirectory: this.directory,
        headDirectory: this.#headDirectory,
        targetPath,
        transactionToken: persisted.transactionToken,
        previousHead: null,
        serialized,
        integrityKey: this.#integrityKey.bytes,
        integrityKeyId: this.#integrityKey.keyId,
        platform: this.#platform,
        assertIntegrityAuthority: () => this.assertIntegrityAuthority(),
        initializeWindowsPrivateFile: (filePath) => this.initializeWindowsPrivateFile(filePath),
        underMaintenance: (authorityPath, authorityContentsBytes, publish) =>
          this.#maintenance.publishWithCapacity(
            serialized.contents.byteLength,
            undefined,
            persisted.capacityReservationBytes,
            authorityPath,
            authorityContentsBytes,
            publish,
          ),
        afterRecordPublication: this.#afterRecordPublication,
      });
      this.#expectedHeads.set(persisted.transactionToken, serialized.head);
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
      if (readErrorCode(error) === "ENOENT") {
        const authority = await this.reconcileHead(transactionToken, null);
        if (authority?.current) this.#expectedHeads.set(transactionToken, authority.current);
        return null;
      }
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
    return await this.withWindowsPrivateTreeAuthority(async () => {
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
    });
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
      headDirectory: this.#headDirectory,
      storeDirectory: this.directory,
      targetPath,
      transactionToken: record.transactionToken,
      previousHead,
      serialized,
      integrityKey: this.#integrityKey.bytes,
      integrityKeyId: this.#integrityKey.keyId,
      platform: this.#platform,
      assertIntegrityAuthority: () => this.assertIntegrityAuthority(),
      initializeWindowsPrivateFile: (filePath) => this.initializeWindowsPrivateFile(filePath),
      underMaintenance: (authorityPath, authorityContentsBytes, publish) =>
        this.#maintenance.publishWithCapacity(
          serialized.contents.byteLength,
          targetPath,
          record.capacityReservationBytes,
          authorityPath,
          authorityContentsBytes,
          publish,
        ),
      afterRecordPublication: this.#afterRecordPublication,
    });
    this.#expectedHeads.set(record.transactionToken, serialized.head);
  }

  private async readAuthenticatedRecord(
    targetPath: string,
    transactionToken: string,
    expectedLinkCount = 1n,
  ) {
    const authenticated = await readStableRemoteTransactionRecordBytes({
      targetPath,
      platform: this.#platform,
      maximumEncodedBytes: this.#maximumBytes,
      assertIntegrityAuthority: () => this.assertIntegrityAuthority(),
      expectedLinkCount,
    });
    const { contents } = authenticated;
    let parsed: AuthenticatedRemoteTransactionRecordEnvelope;
    try {
      parsed = authenticateRemoteTransactionRecordEnvelope({
        contents,
        transactionToken,
        integrityKey: this.#integrityKey.bytes,
        integrityKeyId: this.#integrityKey.keyId,
        directory: this.directory,
        maximumDecodedRecordBytes: this.#maximumDecodedRecordBytes,
        maximumLeaseDurationMs: this.#leaseDurationMs,
      });
    } catch {
      throw new QuarantinableRemoteTransactionRecordIntegrityError(
        contents,
        authenticated.fileIdentity,
      );
    }
    try {
      const authority = await this.reconcileHead(transactionToken, parsed.head);
      if (!authority?.current) throw new RemoteTransactionRecordHeadMismatchError();
      this.#expectedHeads.set(transactionToken, authority.current);
    } catch (error) {
      if (!(error instanceof RemoteTransactionRecordHeadMismatchError)) throw error;
      throw new QuarantinableRemoteTransactionRecordIntegrityError(
        contents,
        authenticated.fileIdentity,
      );
    }
    return {
      record: parsed.record,
      byteLength: contents.byteLength,
      contents,
      fileIdentity: authenticated.fileIdentity,
    };
  }

  private async reconcileHead(
    transactionToken: string,
    recordHead: RemoteTransactionExpectedHead | null,
  ) {
    const authority = await reconcileRemoteTransactionHeadAuthority({
      headDirectory: this.#headDirectory,
      storeDirectory: this.directory,
      transactionToken,
      recordHead,
      integrityKey: this.#integrityKey.bytes,
      integrityKeyId: this.#integrityKey.keyId,
      platform: this.#platform,
      assertIntegrityAuthority: () => this.assertIntegrityAuthority(),
      initializeWindowsPrivateFile: (filePath) => this.initializeWindowsPrivateFile(filePath),
    });
    const remembered = this.#expectedHeads.get(transactionToken);
    const current = authority?.current ?? null;
    if (
      remembered &&
      (!current ||
        current.revision < remembered.revision ||
        (current.revision === remembered.revision && current.digest !== remembered.digest))
    ) {
      throw new RemoteTransactionRecordHeadMismatchError();
    }
    return authority;
  }

  private async retireRecordHead(transactionToken: string): Promise<void> {
    const expectedHead = this.#expectedHeads.get(transactionToken);
    if (!expectedHead) throw new Error("Remote transaction controller head is unavailable");
    await retireRemoteTransactionHeadAuthority({
      headDirectory: this.#headDirectory,
      storeDirectory: this.directory,
      transactionToken,
      expectedHead,
      integrityKey: this.#integrityKey.bytes,
      integrityKeyId: this.#integrityKey.keyId,
      platform: this.#platform,
      assertIntegrityAuthority: () => this.assertIntegrityAuthority(),
      initializeWindowsPrivateFile: (filePath) => this.initializeWindowsPrivateFile(filePath),
    });
  }

  private async reclaimRetiredRecordHead(transactionToken: string): Promise<boolean> {
    const expectedHead = this.#expectedHeads.get(transactionToken);
    const reclaimed = await reclaimRetiredRemoteTransactionHeadAuthority({
      headDirectory: this.#headDirectory,
      storeDirectory: this.directory,
      transactionToken,
      expectedHead,
      integrityKey: this.#integrityKey.bytes,
      integrityKeyId: this.#integrityKey.keyId,
      platform: this.#platform,
      assertIntegrityAuthority: () => this.assertIntegrityAuthority(),
    });
    if (reclaimed) this.#expectedHeads.delete(transactionToken);
    return reclaimed;
  }

  private async assertIntegrityAuthority(): Promise<void> {
    await this.#authority.assertIntegrity();
  }

  private async initializeWindowsPrivateFile(filePath: string): Promise<void> {
    await this.#authority.initializeWindowsPrivateFile(filePath);
  }

  private async withWindowsPrivateTreeAuthority<T>(operation: () => Promise<T>): Promise<T> {
    return await this.#authority.run(operation);
  }

  private nowIso(): string {
    return new Date(this.#now()).toISOString();
  }
}

export { RemoteTransactionCapacityError } from "./transactionStoreMaintenance.js";
export { RemoteTransactionRecordIntegrityError } from "./transactionRecordStorage.js";
export type { RemoteTransactionPublicationCheckpoint } from "./transactionRecordStorage.js";
