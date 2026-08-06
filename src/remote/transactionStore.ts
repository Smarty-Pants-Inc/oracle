import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import type { BrowserModelSelectionEvidence, BrowserRuntimeMetadata } from "../sessionManager.js";
import {
  applyRemoteTransactionTransition,
  createRemoteTransactionRecord,
} from "./transactionReducer.js";
import type {
  DurableRemoteArtifactDeliveryReceipt,
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

export interface RemoteTransactionStoreOptions {
  directory: string;
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
      validateRemoteTransactionRecord(parsed, {
        expectedTransactionToken: transactionToken,
        maximumLeaseDurationMs: this.#leaseDurationMs,
      });
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
        artifacts: params.artifacts,
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
      const applied = applyRemoteTransactionTransition(record, transition, {
        controllerGeneration: this.controllerGeneration,
        leaseDurationMs: this.#leaseDurationMs,
        now: this.#now,
        nowIso: () => this.nowIso(),
      });
      if (applied.persist) {
        if (
          applied.record.transactionToken !== transactionToken ||
          applied.record.runId !== originalRunId
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
        validateRemoteTransactionRecord(record, {
          expectedTransactionToken: match[1],
          maximumLeaseDurationMs: this.#leaseDurationMs,
        });
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
      validateRemoteTransactionRecord(candidate, {
        expectedTransactionToken: match[1],
        maximumLeaseDurationMs: this.#leaseDurationMs,
      });
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

function serializeRecord(record: RemoteTransactionRecord): Buffer {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
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
