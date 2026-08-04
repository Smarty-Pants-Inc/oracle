import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import type { BrowserRunTransaction } from "../browserMode.js";
import type { BrowserRuntimeMetadata } from "../sessionManager.js";
import {
  missingRequiredArtifactDeliveries,
  type RemoteTransactionRecord,
  RemoteTransactionStore,
} from "./transactionStore.js";

export class RemoteTransactionConflictError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RemoteTransactionConflictError";
  }
}

export interface RemoteTransactionSettlementOutcome {
  record: RemoteTransactionRecord;
  finalization: BrowserCaptureFinalizationResult;
}

export interface RemoteTransactionCoordinatorOptions {
  transactionStore: RemoteTransactionStore;
  retryCleanup: (
    runtime: BrowserRuntimeMetadata,
    mode: "finalize" | "abort",
  ) => Promise<BrowserCaptureFinalizationResult>;
  activeTransactions?: Map<string, BrowserRunTransaction>;
}

export class RemoteTransactionCoordinator {
  readonly #transactionStore: RemoteTransactionStore;
  readonly #retryCleanup: (
    runtime: BrowserRuntimeMetadata,
    mode: "finalize" | "abort",
  ) => Promise<BrowserCaptureFinalizationResult>;
  readonly #activeTransactions: Map<string, BrowserRunTransaction>;

  constructor(options: RemoteTransactionCoordinatorOptions) {
    this.#transactionStore = options.transactionStore;
    this.#retryCleanup = options.retryCleanup;
    this.#activeTransactions = options.activeTransactions ?? new Map();
  }

  registerActive(transactionToken: string, transaction: BrowserRunTransaction): void {
    if (this.#activeTransactions.has(transactionToken)) {
      throw new Error("Remote transaction already has live browser authority");
    }
    this.#activeTransactions.set(transactionToken, transaction);
  }

  hasActive(transactionToken: string): boolean {
    return this.#activeTransactions.has(transactionToken);
  }

  async settle(params: {
    transactionToken: string;
    mode: "finalize" | "abort";
    durablePublication: boolean;
  }): Promise<RemoteTransactionSettlementOutcome> {
    return await this.#transactionStore.withTransactionRecord(
      params.transactionToken,
      async (record, persist) => {
        if (record.state === "running") {
          throw new RemoteTransactionConflictError(
            409,
            "transaction_running",
            "Transaction is still running",
          );
        }
        if (record.state === "failed") {
          throw new RemoteTransactionConflictError(
            409,
            "transaction_failed",
            "Transaction did not capture an answer or recoverable browser authority",
          );
        }
        if (record.state === "recoverable-error" && !record.result && params.mode === "finalize") {
          throw new RemoteTransactionConflictError(
            409,
            "transaction_has_no_capture",
            "Recoverable browser authority has no durably captured answer to finalize",
          );
        }
        if (record.state === "finalized" || record.state === "aborted") {
          const terminalMode = record.state === "finalized" ? "finalize" : "abort";
          if (terminalMode !== params.mode) {
            throw new RemoteTransactionConflictError(
              409,
              "transaction_already_settled",
              `Transaction was already ${record.state}`,
            );
          }
          if (!record.finalization || record.finalization.status !== "completed") {
            throw new Error("Terminal remote transaction lacks completed finalization state");
          }
          return { record, finalization: record.finalization };
        }
        if (record.settlementMode && record.settlementMode !== params.mode) {
          throw new RemoteTransactionConflictError(
            409,
            "transaction_settlement_conflict",
            `Transaction is already bound to ${record.settlementMode}`,
          );
        }
        if (!record.runtime) throw new Error("Pending transaction lacks runtime authority");
        if (params.mode === "finalize") {
          if (!params.durablePublication) {
            throw new RemoteTransactionConflictError(
              409,
              "durable_publication_ack_required",
              "Durable answer publication acknowledgement is required",
            );
          }
          const missingDeliveries = missingRequiredArtifactDeliveries(record);
          if (missingDeliveries.length > 0) {
            throw new RemoteTransactionConflictError(
              409,
              "required_artifact_delivery_incomplete",
              `${missingDeliveries.length} required artifact delivery receipt(s) are missing`,
            );
          }
        }

        record.controllerGeneration = this.#transactionStore.controllerGeneration;
        record.settlementMode = params.mode;
        if (params.mode === "finalize" && !record.publicationAcknowledgedAt) {
          record.publicationAcknowledgedAt = new Date().toISOString();
        }
        await persist();

        const active = this.#activeTransactions.get(params.transactionToken);
        const runtimeBeforeSettlement = record.runtime;
        const finalization = active
          ? await active[params.mode]().catch((error) =>
              pendingFinalization(runtimeBeforeSettlement, error),
            )
          : await this.#retryCleanup(runtimeBeforeSettlement, params.mode).catch((error) =>
              pendingFinalization(runtimeBeforeSettlement, error),
            );

        record.runtime = finalization.runtime;
        record.finalization = finalization;
        record.state =
          finalization.status === "completed"
            ? params.mode === "finalize"
              ? "finalized"
              : "aborted"
            : "pending";
        if (record.error && !record.result) {
          record.error = {
            ...record.error,
            recoverableDisconnect: finalization.status === "pending",
          };
        }
        await persist();
        if (finalization.status === "completed") {
          this.#activeTransactions.delete(params.transactionToken);
        }
        return { record, finalization };
      },
    );
  }
}

function pendingFinalization(
  runtime: BrowserRuntimeMetadata,
  error: unknown,
): BrowserCaptureFinalizationResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: "pending",
    runtime: {
      ...runtime,
      recoveryCleanupResult: { status: "failed", error: message },
    },
    error: message,
  };
}
