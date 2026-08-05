import path from "node:path";
import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import type {
  BrowserModelSelectionEvidence,
  BrowserRemotePromptRequestIdentity,
  BrowserRuntimeMetadata,
  BrowserSessionConfig,
} from "../sessionManager.js";
import {
  RemotePublicRunResultSchema,
  type RemoteArtifactDescriptor,
  type RemotePublicRunResult,
} from "./types.js";
import {
  MAX_REMOTE_TRANSACTION_RECORDS,
  MAX_REMOTE_TRANSACTION_STORE_BYTES,
  REMOTE_TERMINAL_RETENTION_MS,
  REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  REMOTE_TRANSACTION_TOKEN_PATTERN,
} from "./types.js";
import {
  applyRemoteTransactionTransition,
  isTerminalRemoteTransactionState,
  missingRequiredArtifactDeliveries,
  type RemoteTransactionTransition,
  type RemoteTransactionTransitionOutcome,
  type RemoteTransactionTransitionType,
} from "./transactionReducer.js";

export {
  missingRequiredArtifactDeliveries,
  RemoteTransactionTransitionError,
} from "./transactionReducer.js";

const MAX_REMOTE_TRANSACTION_LEASE_MS = 24 * 60 * 60 * 1000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type RemoteTransactionState =
  | "running"
  | "pending"
  | "finalized"
  | "aborted"
  | "recoverable-error"
  | "failed";

export interface DurableRemoteArtifactDeliveryReceipt {
  receiptId: string;
  deliveredAt: string;
  byteSize: number;
  sha256: string;
}

export interface DurableRemoteFileIdentity {
  device: string;
  inode: string;
  birthtimeNs: string;
  ctimeNs: string;
}

export interface DurableRemoteAutomationError {
  name: "BrowserAutomationError";
  category: "browser-automation";
  message: string;
  code?: string;
  stage?: string;
  recoverableDisconnect: boolean;
}

export interface DurableRemoteArtifactRegistration {
  descriptor: RemoteArtifactDescriptor & { required: boolean };
  transactionToken: string;
  canonicalPath: string;
  fileIdentity: DurableRemoteFileIdentity;
  deliveryReceipt?: DurableRemoteArtifactDeliveryReceipt;
}

export interface DurableRemoteTerminalAudit {
  redactedAt: string;
  settlementMode?: "finalize" | "abort";
  publicationAcknowledgedAt?: string;
  artifacts: Array<{
    artifactId: string;
    runId: string;
    required: boolean;
    deliveryReceipt?: DurableRemoteArtifactDeliveryReceipt;
  }>;
  errorCode?: string;
  errorStage?: string;
}
export interface DurableRemoteCaptureWarning {
  code: string;
  message: string;
}

export interface DurableRemoteStagedCapture {
  result: RemotePublicRunResult;
  runtime: BrowserRuntimeMetadata;
  modelSelection?: BrowserModelSelectionEvidence;
  artifacts?: DurableRemoteArtifactRegistration[];
  stagedAt: string;
}

export interface RemoteControllerRestartRecovery {
  previousControllerGeneration: string;
  reconciledAt: string;
  reason: "controller-generation-changed";
}

export interface RemoteTransactionRecord {
  protocolVersion: typeof REMOTE_TRANSACTION_PROTOCOL_VERSION;
  transactionToken: string;
  runId: string;
  createdAt: string;
  updatedAt: string;
  controllerGeneration: string;
  state: RemoteTransactionState;
  capacityReservationBytes?: number;
  requestIdentity: BrowserRemotePromptRequestIdentity;
  browserConfig: BrowserSessionConfig;
  leaseExpiresAt: string;
  result?: RemotePublicRunResult;
  runtime?: BrowserRuntimeMetadata;
  runtimeJournaledAt?: string;
  modelSelection?: BrowserModelSelectionEvidence;
  artifacts?: DurableRemoteArtifactRegistration[];
  stagedCapture?: DurableRemoteStagedCapture;
  error?: DurableRemoteAutomationError;
  settlementMode?: "finalize" | "abort";
  publicationAcknowledgedAt?: string;
  finalization?: BrowserCaptureFinalizationResult;
  restartRecovery?: RemoteControllerRestartRecovery;
  terminalAudit?: DurableRemoteTerminalAudit;
}

export type RemoteTransactionBeginRecord = Pick<
  RemoteTransactionRecord,
  | "protocolVersion"
  | "transactionToken"
  | "runId"
  | "createdAt"
  | "requestIdentity"
  | "browserConfig"
>;

export interface RemoteTransactionStoreOptions {
  directory: string;
  controllerGeneration?: string;
  terminalRetentionMs?: number;
  maximumRecords?: number;
  maximumBytes?: number;
  now?: () => number;
  leaseDurationMs?: number;
}

export interface ReconcileRemoteTransactionResult {
  transactionToken: string;
  previousControllerGeneration: string;
  state: "recoverable-error" | "failed";
  hadRuntimeAuthority: boolean;
}

export type RemoteTransactionSettlementBinding =
  | {
      record: RemoteTransactionRecord;
      status: "bound";
      cleanupRuntime: BrowserRuntimeMetadata;
    }
  | {
      record: RemoteTransactionRecord;
      status: "completed";
      finalization: BrowserCaptureFinalizationResult;
    };

export interface ExpiredRemoteTransactionSettlement {
  mode: "finalize" | "abort";
  durablePublication: boolean;
}
export type RemoteTransactionControllerShutdownAction =
  | { action: "release" | "preserve" }
  | {
      action: "settle";
      mode: "finalize" | "abort";
      durablePublication: boolean;
    };

export type RemoteTransactionControllerShutdownPlan = RemoteTransactionControllerShutdownAction & {
  record: RemoteTransactionRecord;
};

export class RemoteTransactionStore {
  readonly directory: string;
  readonly controllerGeneration: string;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #terminalRetentionMs: number;
  readonly #leaseDurationMs: number;
  readonly #maximumRecords: number;
  readonly #maximumBytes: number;
  readonly #now: () => number;
  #maintenanceLock: Promise<void> = Promise.resolve();

  private constructor(options: RemoteTransactionStoreOptions) {
    this.directory = options.directory;
    this.controllerGeneration = options.controllerGeneration ?? randomUUID();
    this.#terminalRetentionMs = options.terminalRetentionMs ?? REMOTE_TERMINAL_RETENTION_MS;
    this.#leaseDurationMs = options.leaseDurationMs ?? MAX_REMOTE_TRANSACTION_LEASE_MS;
    this.#maximumRecords = options.maximumRecords ?? MAX_REMOTE_TRANSACTION_RECORDS;
    this.#maximumBytes = options.maximumBytes ?? MAX_REMOTE_TRANSACTION_STORE_BYTES;
    this.#now = options.now ?? Date.now;
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
    const store = new RemoteTransactionStore(options);
    await mkdir(store.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(store.directory, 0o700);
    await syncDirectory(store.directory);
    await store.runMaintenance();
    return store;
  }

  async begin(record: RemoteTransactionBeginRecord): Promise<void> {
    const updatedAt = this.nowIso();
    const persisted: RemoteTransactionRecord = {
      ...record,
      updatedAt,
      controllerGeneration: this.controllerGeneration,
      state: "running",
      capacityReservationBytes: REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES,
      leaseExpiresAt: new Date(Date.parse(updatedAt) + this.#leaseDurationMs).toISOString(),
    };
    validateRemoteTransactionRecord(persisted);
    this.validateLeaseBound(persisted);
    const contents = serializeRecord(persisted);
    await this.withMaintenanceLock(async () => {
      await this.pruneExpiredTerminalRecords();
      await this.assertCapacity(contents.byteLength, undefined, persisted.capacityReservationBytes);
      const targetPath = this.recordPath(persisted.transactionToken);
      const tempPath = path.join(
        this.directory,
        `.${persisted.transactionToken}.${process.pid}.${randomUUID()}.tmp`,
      );
      try {
        const handle = await open(tempPath, "wx", 0o600);
        try {
          await handle.writeFile(contents);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await link(tempPath, targetPath);
        await syncDirectory(this.directory);
      } finally {
        await rm(tempPath, { force: true });
      }
    });
  }

  async read(transactionToken: string): Promise<RemoteTransactionRecord | null> {
    const targetPath = this.recordPath(transactionToken);
    try {
      const parsed = JSON.parse(await readFile(targetPath, "utf8")) as RemoteTransactionRecord;
      validateRemoteTransactionRecord(parsed, transactionToken);
      this.validateLeaseBound(parsed);
      return parsed;
    } catch (error) {
      if (readErrorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async renewLease(transactionToken: string): Promise<RemoteTransactionRecord> {
    return (await this.transition(transactionToken, { type: "renew-lease" })).record;
  }

  async listExpiredNonterminalRecords(): Promise<RemoteTransactionRecord[]> {
    await this.runMaintenance();
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
        artifacts: params.artifacts ?? [],
      })
    ).record;
  }

  async promoteStagedCapture(params: {
    transactionToken: string;
    result?: RemotePublicRunResult;
    runtime?: BrowserRuntimeMetadata;
    warning?: DurableRemoteCaptureWarning;
    stripTargetAuthority?: boolean;
  }): Promise<RemoteTransactionRecord> {
    return (
      await this.transition(params.transactionToken, {
        type: "promote-staged-capture",
        result: params.result,
        runtime: params.runtime,
        warning: params.warning,
        stripTargetAuthority: params.stripTargetAuthority ?? false,
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
  }): Promise<RemoteTransactionRecord> {
    return (
      await this.transition(params.transactionToken, {
        type: "invalidate-staged-capture",
        runtime: params.runtime,
        error: params.error,
      })
    ).record;
  }

  async recordRecoverableFailure(params: {
    transactionToken: string;
    runtime?: BrowserRuntimeMetadata;
    error: DurableRemoteAutomationError;
  }): Promise<RemoteTransactionRecord> {
    return (
      await this.transition(params.transactionToken, {
        type: "record-failure",
        runtime: params.runtime,
        error: params.error,
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
      const applied = applyRemoteTransactionTransition(record, transition, {
        controllerGeneration: this.controllerGeneration,
        now: this.#now,
        nowIso: () => this.nowIso(),
      });
      if (applied.persist) {
        if (record.transactionToken !== transactionToken || record.runId !== originalRunId) {
          throw new Error("Remote transaction identity cannot change during a transition");
        }
        const updatedAt = this.nowIso();
        record.updatedAt = updatedAt;
        record.capacityReservationBytes =
          record.state === "running" ? REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES : undefined;
        if (!isTerminalRemoteTransactionState(record.state)) {
          record.leaseExpiresAt = new Date(
            Date.parse(updatedAt) + this.#leaseDurationMs,
          ).toISOString();
        }
        redactTerminalRecord(record, updatedAt);
        validateRemoteTransactionRecord(record, transactionToken);
        this.validateLeaseBound(record);
        await this.write(record);
      }
      return { record, outcome: applied.outcome };
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
    const contents = serializeRecord(record);
    await this.withMaintenanceLock(async () => {
      await this.pruneExpiredTerminalRecords();
      await this.assertCapacity(contents.byteLength, targetPath, record.capacityReservationBytes);
      try {
        const handle = await open(tempPath, "wx", 0o600);
        try {
          await handle.writeFile(contents);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(tempPath, targetPath);
        await syncDirectory(this.directory);
      } finally {
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
    });
  }

  private async runMaintenance(): Promise<void> {
    await this.withMaintenanceLock(async () => this.pruneExpiredTerminalRecords());
  }

  private async pruneExpiredTerminalRecords(): Promise<void> {
    const cutoff = this.#now() - this.#terminalRetentionMs;
    const names = await readdir(this.directory);
    let removed = false;
    for (const name of names) {
      const match = /^([a-f0-9]{64})\.json$/u.exec(name);
      if (!match?.[1]) continue;
      const targetPath = this.recordPath(match[1]);
      let record: RemoteTransactionRecord;
      try {
        record = JSON.parse(await readFile(targetPath, "utf8")) as RemoteTransactionRecord;
        validateRemoteTransactionRecord(record, match[1]);
        this.validateLeaseBound(record);
      } catch (error) {
        if (readErrorCode(error) === "ENOENT") continue;
        throw error;
      }
      if (
        !isTerminalRemoteTransactionState(record.state) ||
        Date.parse(record.updatedAt) > cutoff
      ) {
        continue;
      }
      await rm(targetPath, { force: true });
      removed = true;
    }
    if (removed) await syncDirectory(this.directory);
  }

  private async assertCapacity(
    contentsBytes: number,
    replacedPath?: string,
    reservationBytes = 0,
  ): Promise<void> {
    const names = await readdir(this.directory);
    let records = 0;
    let storedBytes = 0;
    let replacedBytes = 0;
    for (const name of names) {
      const match = /^([a-f0-9]{64})\.json$/u.exec(name);
      if (!match?.[1]) continue;
      const candidatePath = path.join(this.directory, name);
      const fileStat = await stat(candidatePath).catch((error) => {
        if (readErrorCode(error) === "ENOENT") return null;
        throw error;
      });
      if (!fileStat?.isFile()) continue;
      const candidate = JSON.parse(
        await readFile(candidatePath, "utf8"),
      ) as RemoteTransactionRecord;
      validateRemoteTransactionRecord(candidate, match[1]);
      this.validateLeaseBound(candidate);
      const chargedBytes = Math.max(fileStat.size, candidate.capacityReservationBytes ?? 0);
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

  private validateLeaseBound(record: RemoteTransactionRecord): void {
    if (isTerminalRemoteTransactionState(record.state)) return;
    const updatedAt = Date.parse(record.updatedAt);
    const leaseExpiresAt = Date.parse(record.leaseExpiresAt ?? "");
    if (
      !Number.isFinite(leaseExpiresAt) ||
      leaseExpiresAt <= updatedAt ||
      leaseExpiresAt - updatedAt > this.#leaseDurationMs
    ) {
      throw new Error("Remote transaction lease exceeds the configured bound");
    }
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

function assertArtifactRegistrationsOwned(
  record: RemoteTransactionRecord,
  artifacts: DurableRemoteArtifactRegistration[],
): void {
  const artifactIds = new Set<string>();
  for (const artifact of artifacts) {
    if (
      artifact.transactionToken !== record.transactionToken ||
      artifact.descriptor.runId !== record.runId ||
      !artifact.canonicalPath ||
      artifactIds.has(artifact.descriptor.artifactId)
    ) {
      throw new Error("Remote artifact registration is not uniquely owned by its transaction");
    }
    artifactIds.add(artifact.descriptor.artifactId);
    if (artifact.deliveryReceipt) {
      validateArtifactDeliveryReceipt(artifact, artifact.deliveryReceipt);
    }
  }
}

function validateArtifactDeliveryReceipt(
  registration: DurableRemoteArtifactRegistration,
  receipt: DurableRemoteArtifactDeliveryReceipt,
): void {
  if (
    !receipt.receiptId ||
    !Number.isFinite(Date.parse(receipt.deliveredAt)) ||
    !Number.isSafeInteger(receipt.byteSize) ||
    receipt.byteSize !== registration.descriptor.byteSize ||
    receipt.sha256 !== registration.descriptor.sha256
  ) {
    throw new Error("Remote artifact delivery receipt does not match registered content");
  }
}

function serializeRecord(record: RemoteTransactionRecord): Buffer {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function redactTerminalRecord(record: RemoteTransactionRecord, redactedAt: string): void {
  if (!isTerminalRemoteTransactionState(record.state)) return;
  const promptEpoch = record.runtime?.promptEpoch ?? record.finalization?.runtime.promptEpoch;
  record.terminalAudit ??= {
    redactedAt,
    settlementMode: record.settlementMode,
    publicationAcknowledgedAt: record.publicationAcknowledgedAt,
    artifacts: (record.artifacts ?? []).map((artifact) => ({
      artifactId: artifact.descriptor.artifactId,
      runId: artifact.descriptor.runId,
      required: artifact.descriptor.required,
      deliveryReceipt: artifact.deliveryReceipt,
    })),
    errorCode: record.error?.code,
    errorStage: record.error?.stage,
  };
  record.finalization =
    record.finalization?.status === "completed"
      ? {
          status: "completed",
          runtime: promptEpoch ? { promptEpoch } : {},
        }
      : undefined;
  record.result = undefined;
  record.capacityReservationBytes = undefined;
  Reflect.deleteProperty(record, "requestIdentity");
  Reflect.deleteProperty(record, "browserConfig");
  Reflect.deleteProperty(record, "leaseExpiresAt");
  record.runtime = undefined;
  record.runtimeJournaledAt = undefined;
  record.modelSelection = undefined;
  record.artifacts = undefined;
  record.stagedCapture = undefined;
  record.error = undefined;
  record.settlementMode = undefined;
  record.publicationAcknowledgedAt = undefined;
  record.restartRecovery = undefined;
}

function validateRemoteTransactionRecord(
  record: RemoteTransactionRecord,
  expectedTransactionToken?: string,
): void {
  if (
    record.protocolVersion !== REMOTE_TRANSACTION_PROTOCOL_VERSION ||
    !REMOTE_TRANSACTION_TOKEN_PATTERN.test(record.transactionToken) ||
    (expectedTransactionToken && record.transactionToken !== expectedTransactionToken) ||
    typeof record.runId !== "string" ||
    !record.runId ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt)) ||
    !["running", "pending", "finalized", "aborted", "recoverable-error", "failed"].includes(
      record.state,
    )
  ) {
    throw new Error("Invalid remote transaction record");
  }
  if (typeof record.controllerGeneration !== "string" || !record.controllerGeneration) {
    throw new Error("Remote transaction record is missing controller generation");
  }
  if (
    (record.state === "running" &&
      record.capacityReservationBytes !== REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES) ||
    (record.state !== "running" && record.capacityReservationBytes !== undefined)
  ) {
    throw new Error("Remote transaction capacity reservation does not match its state");
  }

  if (isTerminalRemoteTransactionState(record.state)) {
    validateTerminalRemoteTransactionRecord(record);
    return;
  }

  const requestIdentity = record.requestIdentity;
  if (
    !requestIdentity ||
    !Array.isArray(requestIdentity.acceptedPromptSha256) ||
    requestIdentity.acceptedPromptSha256.length === 0 ||
    requestIdentity.acceptedPromptSha256.length > 64 ||
    !requestIdentity.acceptedPromptSha256.every((sha256) => SHA256_PATTERN.test(sha256)) ||
    !Number.isSafeInteger(requestIdentity.followUpOrdinal) ||
    requestIdentity.followUpOrdinal < 0 ||
    requestIdentity.remainingFollowUps !== 0 ||
    !record.browserConfig ||
    typeof record.browserConfig !== "object" ||
    Array.isArray(record.browserConfig) ||
    typeof record.leaseExpiresAt !== "string" ||
    !Number.isFinite(Date.parse(record.leaseExpiresAt))
  ) {
    throw new Error("Nonterminal remote transaction is missing bounded request authority");
  }
  if (
    record.runtimeJournaledAt !== undefined &&
    (!record.runtime || !Number.isFinite(Date.parse(record.runtimeJournaledAt)))
  ) {
    throw new Error("Remote transaction runtime journal is invalid");
  }
  if (record.runtime && (typeof record.runtime !== "object" || Array.isArray(record.runtime))) {
    throw new Error("Remote transaction runtime authority is invalid");
  }
  if (record.finalization) validatePendingFinalization(record.finalization);
  assertArtifactRegistrationsOwned(record, record.artifacts ?? []);
  if (record.stagedCapture) validateStagedCapture(record);

  switch (record.state) {
    case "running":
      if (
        (record.stagedCapture && !record.runtime) ||
        record.result ||
        record.artifacts ||
        record.error ||
        record.settlementMode ||
        record.publicationAcknowledgedAt ||
        record.finalization ||
        record.restartRecovery
      ) {
        throw new Error("Running remote transaction contains post-capture state");
      }
      return;
    case "pending":
      if (
        !record.runtime ||
        !record.result ||
        record.stagedCapture ||
        record.error ||
        record.restartRecovery
      ) {
        throw new Error("Pending remote transaction requires runtime and captured result only");
      }
      if (!record.settlementMode) {
        if (record.publicationAcknowledgedAt || record.finalization) {
          throw new Error("Unbound pending transaction contains settlement state");
        }
        return;
      }
      if (record.runtime.recoveryCleanupResult?.settlementMode !== record.settlementMode) {
        throw new Error("Bound pending transaction runtime lost its exact settlement mode");
      }
      if (record.settlementMode === "finalize") {
        if (
          !record.publicationAcknowledgedAt ||
          !Number.isFinite(Date.parse(record.publicationAcknowledgedAt)) ||
          missingRequiredArtifactDeliveries(record).length > 0
        ) {
          throw new Error("Finalize-bound transaction lacks publication or artifact durability");
        }
      } else if (record.publicationAcknowledgedAt) {
        throw new Error("Abort-bound transaction cannot acknowledge answer publication");
      }
      return;
    case "recoverable-error":
      if (
        !record.runtime ||
        !record.error ||
        !record.error.recoverableDisconnect ||
        record.result ||
        record.artifacts ||
        record.modelSelection ||
        record.publicationAcknowledgedAt ||
        record.settlementMode === "finalize" ||
        (record.finalization && record.settlementMode !== "abort")
      ) {
        throw new Error("Recoverable remote transaction lacks exact runtime failure authority");
      }
      if (
        record.settlementMode === "abort" &&
        record.runtime.recoveryCleanupResult?.settlementMode !== "abort"
      ) {
        throw new Error("Abort-bound recovery runtime lost its exact settlement mode");
      }
      return;
  }
}
function validateStagedCapture(record: RemoteTransactionRecord): void {
  const staged = record.stagedCapture;
  if (!staged) return;
  const epoch = staged.runtime?.promptEpoch;
  if (
    !Number.isFinite(Date.parse(staged.stagedAt)) ||
    !staged.runtime ||
    typeof staged.runtime !== "object" ||
    Array.isArray(staged.runtime) ||
    epoch?.status !== "committed" ||
    !record.requestIdentity.acceptedPromptSha256.includes(epoch.promptSha256) ||
    epoch.followUpOrdinal !== record.requestIdentity.followUpOrdinal ||
    epoch.remainingFollowUps !== record.requestIdentity.remainingFollowUps ||
    staged.runtime.conversationId !== epoch.conversationId
  ) {
    throw new Error("Staged remote capture lacks exact prompt and conversation identity");
  }
  RemotePublicRunResultSchema.parse(staged.result);
  assertArtifactRegistrationsOwned(record, staged.artifacts ?? []);
}

function validatePendingFinalization(finalization: BrowserCaptureFinalizationResult): void {
  if (
    finalization.status !== "pending" ||
    typeof finalization.error !== "string" ||
    !finalization.error ||
    !finalization.runtime ||
    typeof finalization.runtime !== "object" ||
    Array.isArray(finalization.runtime)
  ) {
    throw new Error("Nonterminal remote transaction finalization must remain pending");
  }
}

function validateTerminalRemoteTransactionRecord(record: RemoteTransactionRecord): void {
  const audit = record.terminalAudit;
  if (
    !audit ||
    !Number.isFinite(Date.parse(audit.redactedAt)) ||
    audit.artifacts.some((artifact) => artifact.runId !== record.runId)
  ) {
    throw new Error("Terminal remote transaction audit is invalid");
  }
  if (
    record.capacityReservationBytes !== undefined ||
    record.requestIdentity ||
    record.browserConfig ||
    record.leaseExpiresAt ||
    record.result ||
    record.runtime ||
    record.runtimeJournaledAt ||
    record.modelSelection ||
    record.artifacts ||
    record.stagedCapture ||
    record.error ||
    record.settlementMode ||
    record.publicationAcknowledgedAt ||
    record.restartRecovery ||
    (record.finalization && record.finalization.status !== "completed")
  ) {
    throw new Error("Terminal remote transaction contains unredacted authority");
  }
  if (record.finalization && !record.finalization.runtime) {
    throw new Error("Terminal finalization lacks redacted runtime metadata");
  }
  if (record.state === "finalized") {
    if (
      audit.settlementMode !== "finalize" ||
      !audit.publicationAcknowledgedAt ||
      !Number.isFinite(Date.parse(audit.publicationAcknowledgedAt)) ||
      !record.finalization
    ) {
      throw new Error("Finalized remote transaction lacks completed finalize settlement");
    }
    return;
  }
  if (record.state === "aborted") {
    if (
      audit.settlementMode !== "abort" ||
      audit.publicationAcknowledgedAt ||
      !record.finalization
    ) {
      throw new Error("Aborted remote transaction lacks completed abort settlement");
    }
    return;
  }
  if (audit.settlementMode) {
    if (
      audit.settlementMode !== "abort" ||
      audit.publicationAcknowledgedAt ||
      !record.finalization
    ) {
      throw new Error("Failed remote transaction cleanup settlement is invalid");
    }
  } else if (record.finalization) {
    throw new Error("Pre-authority failed transaction cannot contain finalization state");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
