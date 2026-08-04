import path from "node:path";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import type { BrowserModelSelectionEvidence, BrowserRuntimeMetadata } from "../sessionManager.js";
import type { RemoteArtifactDescriptor, RemotePublicRunResult } from "./types.js";
import {
  MAX_REMOTE_TRANSACTION_RECORDS,
  MAX_REMOTE_TRANSACTION_STORE_BYTES,
  REMOTE_TERMINAL_RETENTION_MS,
  REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  REMOTE_TRANSACTION_TOKEN_PATTERN,
} from "./types.js";

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
  expiresAt: string;
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
  result?: RemotePublicRunResult;
  runtime?: BrowserRuntimeMetadata;
  runtimeJournaledAt?: string;
  modelSelection?: BrowserModelSelectionEvidence;
  artifacts?: DurableRemoteArtifactRegistration[];
  error?: DurableRemoteAutomationError;
  settlementMode?: "finalize" | "abort";
  publicationAcknowledgedAt?: string;
  finalization?: BrowserCaptureFinalizationResult;
  restartRecovery?: RemoteControllerRestartRecovery;
  terminalAudit?: DurableRemoteTerminalAudit;
}
export interface RemoteTransactionStoreOptions {
  directory: string;
  controllerGeneration?: string;
  terminalRetentionMs?: number;
  maximumRecords?: number;
  maximumBytes?: number;
  now?: () => number;
}

export interface ReconcileRemoteTransactionResult {
  transactionToken: string;
  previousControllerGeneration: string;
  state: "recoverable-error" | "failed";
  hadRuntimeAuthority: boolean;
}

export class RemoteTransactionStore {
  readonly directory: string;
  readonly controllerGeneration: string;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #terminalRetentionMs: number;
  readonly #maximumRecords: number;
  readonly #maximumBytes: number;
  readonly #now: () => number;
  #maintenanceLock: Promise<void> = Promise.resolve();

  private constructor(options: RemoteTransactionStoreOptions) {
    this.directory = options.directory;
    this.controllerGeneration = options.controllerGeneration ?? randomUUID();
    this.#terminalRetentionMs = options.terminalRetentionMs ?? REMOTE_TERMINAL_RETENTION_MS;
    this.#maximumRecords = options.maximumRecords ?? MAX_REMOTE_TRANSACTION_RECORDS;
    this.#maximumBytes = options.maximumBytes ?? MAX_REMOTE_TRANSACTION_STORE_BYTES;
    this.#now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.#terminalRetentionMs) ||
      this.#terminalRetentionMs < 0 ||
      !Number.isSafeInteger(this.#maximumRecords) ||
      this.#maximumRecords <= 0 ||
      !Number.isSafeInteger(this.#maximumBytes) ||
      this.#maximumBytes <= 0
    ) {
      throw new Error("Invalid remote transaction retention or capacity policy");
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

  async create(record: Omit<RemoteTransactionRecord, "controllerGeneration">): Promise<void> {
    validateRemoteTransactionRecord(record);
    const persisted: RemoteTransactionRecord = {
      ...record,
      controllerGeneration: this.controllerGeneration,
      capacityReservationBytes: isTerminalState(record.state)
        ? undefined
        : REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES,
    };
    redactTerminalRecord(persisted, this.nowIso());
    validateRemoteTransactionRecord(persisted);
    const contents = serializeRecord(persisted);
    await this.withMaintenanceLock(async () => {
      await this.pruneExpiredTerminalRecords();
      await this.assertCapacity(contents.byteLength, undefined, persisted.capacityReservationBytes);
      const targetPath = this.recordPath(persisted.transactionToken);
      const handle = await open(targetPath, "wx", 0o600);
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(this.directory);
    });
  }

  async read(transactionToken: string): Promise<RemoteTransactionRecord | null> {
    const targetPath = this.recordPath(transactionToken);
    try {
      const parsed = JSON.parse(await readFile(targetPath, "utf8")) as RemoteTransactionRecord;
      validateRemoteTransactionRecord(parsed, transactionToken);
      return parsed;
    } catch (error) {
      if (readErrorCode(error) === "ENOENT") return null;
      throw error;
    }
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

  async update(
    transactionToken: string,
    updateRecord: (record: RemoteTransactionRecord) => void,
  ): Promise<RemoteTransactionRecord> {
    return await this.withTransactionRecord(transactionToken, async (record, persist) => {
      updateRecord(record);
      await persist();
      return record;
    });
  }

  async withTransactionRecord<T>(
    transactionToken: string,
    operation: (record: RemoteTransactionRecord, persist: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return await this.withLock(transactionToken, async () => {
      const record = await this.read(transactionToken);
      if (!record) throw new Error(`Remote transaction ${transactionToken} does not exist`);
      const originalRunId = record.runId;
      const persist = async (): Promise<void> => {
        if (record.transactionToken !== transactionToken || record.runId !== originalRunId) {
          throw new Error("Remote transaction identity cannot change during an update");
        }
        record.updatedAt = this.nowIso();
        redactTerminalRecord(record, this.nowIso());
        validateRemoteTransactionRecord(record, transactionToken);
        await this.write(record);
      };
      return await operation(record, persist);
    });
  }

  async journalRuntime(
    transactionToken: string,
    runtime: BrowserRuntimeMetadata,
    modelSelection?: BrowserModelSelectionEvidence,
  ): Promise<RemoteTransactionRecord> {
    return await this.update(transactionToken, (record) => {
      if (record.state !== "running") {
        throw new Error(`Cannot journal runtime for transaction in state ${record.state}`);
      }
      if (record.controllerGeneration !== this.controllerGeneration) {
        throw new Error("Cannot journal runtime from a stale remote controller generation");
      }
      record.runtime = runtime;
      record.runtimeJournaledAt = this.nowIso();
      record.modelSelection = modelSelection;
    });
  }

  async reconcileStaleRunningRecords(params: {
    buildError: (
      record: RemoteTransactionRecord,
      hadRuntimeAuthority: boolean,
    ) => DurableRemoteAutomationError;
  }): Promise<ReconcileRemoteTransactionResult[]> {
    const results: ReconcileRemoteTransactionResult[] = [];
    for (const candidate of await this.list()) {
      if (
        candidate.state !== "running" ||
        candidate.controllerGeneration === this.controllerGeneration
      ) {
        continue;
      }
      const reconciled = await this.update(candidate.transactionToken, (record) => {
        if (
          record.state !== "running" ||
          record.controllerGeneration === this.controllerGeneration
        ) {
          return record;
        }
        const previousControllerGeneration = record.controllerGeneration;
        const hadRuntimeAuthority = Boolean(record.runtime);
        record.controllerGeneration = this.controllerGeneration;
        record.state = hadRuntimeAuthority ? "recoverable-error" : "failed";
        record.error = params.buildError(record, hadRuntimeAuthority);
        record.restartRecovery = {
          previousControllerGeneration,
          reconciledAt: this.nowIso(),
          reason: "controller-generation-changed",
        };
        results.push({
          transactionToken: record.transactionToken,
          previousControllerGeneration,
          state: record.state,
          hadRuntimeAuthority,
        });
        return record;
      });
      if (reconciled.state !== "recoverable-error" && reconciled.state !== "failed") {
        continue;
      }
    }
    return results;
  }

  async withLock<T>(transactionToken: string, operation: () => Promise<T>): Promise<T> {
    this.recordPath(transactionToken);
    const prior = this.#locks.get(transactionToken) ?? Promise.resolve();
    const gate = createPromiseGate();
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
      } catch (error) {
        if (readErrorCode(error) === "ENOENT") continue;
        throw error;
      }
      if (!isTerminalState(record.state) || Date.parse(record.updatedAt) > cutoff) continue;
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
    const gate = createPromiseGate();
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

export function missingRequiredArtifactDeliveries(
  record: Pick<RemoteTransactionRecord, "artifacts">,
): DurableRemoteArtifactRegistration[] {
  return (record.artifacts ?? []).filter(
    (artifact) => artifact.descriptor.required && !artifact.deliveryReceipt,
  );
}

function serializeRecord(record: RemoteTransactionRecord): Buffer {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function isTerminalState(state: RemoteTransactionState): boolean {
  return state === "finalized" || state === "aborted" || state === "failed";
}

function redactTerminalRecord(record: RemoteTransactionRecord, redactedAt: string): void {
  if (!isTerminalState(record.state)) return;
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
  record.runtime = undefined;
  record.runtimeJournaledAt = undefined;
  record.modelSelection = undefined;
  record.artifacts = undefined;
  record.error = undefined;
  record.settlementMode = undefined;
  record.publicationAcknowledgedAt = undefined;
  record.restartRecovery = undefined;
}

function validateRemoteTransactionRecord(
  record: Omit<RemoteTransactionRecord, "controllerGeneration"> | RemoteTransactionRecord,
  expectedTransactionToken?: string,
): void {
  if (
    record.protocolVersion !== REMOTE_TRANSACTION_PROTOCOL_VERSION ||
    !REMOTE_TRANSACTION_TOKEN_PATTERN.test(record.transactionToken) ||
    (expectedTransactionToken && record.transactionToken !== expectedTransactionToken) ||
    typeof record.runId !== "string" ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    throw new Error("Invalid remote transaction record");
  }
  if ("controllerGeneration" in record) {
    if (typeof record.controllerGeneration !== "string" || !record.controllerGeneration) {
      throw new Error("Remote transaction record is missing controller generation");
    }
    if (
      !isTerminalState(record.state) &&
      record.capacityReservationBytes !== REMOTE_TRANSACTION_CAPACITY_RESERVATION_BYTES
    ) {
      throw new Error("Active remote transaction is missing its capacity reservation");
    }
  }
  for (const artifact of record.artifacts ?? []) {
    if (
      artifact.transactionToken !== record.transactionToken ||
      artifact.descriptor.runId !== record.runId ||
      !artifact.canonicalPath ||
      !artifact.expiresAt
    ) {
      throw new Error("Remote artifact registration is not owned by its transaction");
    }
  }
  if (record.terminalAudit) {
    if (
      !Number.isFinite(Date.parse(record.terminalAudit.redactedAt)) ||
      record.terminalAudit.artifacts.some((artifact) => artifact.runId !== record.runId)
    ) {
      throw new Error("Terminal remote transaction audit is invalid");
    }
    if (
      record.capacityReservationBytes ||
      record.result ||
      record.runtime ||
      record.runtimeJournaledAt ||
      record.modelSelection ||
      record.artifacts ||
      record.error ||
      record.settlementMode ||
      record.publicationAcknowledgedAt ||
      record.restartRecovery ||
      (record.finalization && record.finalization.status !== "completed")
    ) {
      throw new Error("Terminal remote transaction contains unredacted authority");
    }
  } else if (isTerminalState(record.state)) {
    throw new Error("Terminal remote transaction is missing its redacted audit record");
  }
}
function createPromiseGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
