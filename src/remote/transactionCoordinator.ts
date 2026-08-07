import type { BrowserCaptureFinalizationResult, BrowserRunTransaction } from "../browser/types.js";
import type { BrowserRuntimeMetadata } from "../sessionManager.js";
import {
  pendingBrowserCaptureCleanup,
  projectBrowserCaptureFinalization,
} from "../browser/ownedBrowserResources.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type {
  RemoteMaterializedSettlementAuthorityTransactionRecord,
  RemoteSettlementPendingTransactionRecord,
  RemoteSettledTransactionRecord,
  RemoteTransactionSettlementAuthority,
  RemoteTransactionSettlementBinding,
} from "./transactionModel.js";
import { RemoteTransactionTransitionError } from "./transactionReducer.js";
import { RemoteTransactionStore } from "./transactionStore.js";

export class RemoteTransactionConflictError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly settlementAuthority?: RemoteTransactionSettlementAuthority,
  ) {
    super(message);
    this.name = "RemoteTransactionConflictError";
  }
}

export interface RemoteTransactionSettlementOutcome {
  record: RemoteSettlementPendingTransactionRecord | RemoteSettledTransactionRecord;
  finalization: BrowserCaptureFinalizationResult;
}

export type RemoteTransactionSettlementBindingOutcome =
  | {
      record: RemoteMaterializedSettlementAuthorityTransactionRecord;
      settlementAuthority: RemoteTransactionSettlementAuthority & {
        outcome: "bound";
        state: RemoteMaterializedSettlementAuthorityTransactionRecord["state"];
      };
    }
  | {
      record: RemoteSettledTransactionRecord;
      settlementAuthority: RemoteTransactionSettlementAuthority & {
        outcome: "completed";
        state: RemoteSettledTransactionRecord["state"];
      };
      finalization: Extract<BrowserCaptureFinalizationResult, { status: "completed" }>;
    };

export interface RemoteTransactionCoordinatorOptions {
  transactionStore: RemoteTransactionStore;
  retryCleanup: (
    runtime: BrowserRuntimeMetadata,
    mode: "finalize" | "abort",
    ownerId: string,
  ) => Promise<BrowserCaptureFinalizationResult>;
  activeTransactions?: Map<string, BrowserRunTransaction>;
}

export class RemoteTransactionCoordinator {
  readonly #transactionStore: RemoteTransactionStore;
  readonly #retryCleanup: (
    runtime: BrowserRuntimeMetadata,
    mode: "finalize" | "abort",
    ownerId: string,
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

  activeTransactionTokens(): string[] {
    return [...this.#activeTransactions.keys()];
  }

  async bindSettlement(params: {
    transactionToken: string;
    mode: "finalize" | "abort";
    durablePublication: boolean;
  }): Promise<RemoteTransactionSettlementBindingOutcome> {
    let binding: RemoteTransactionSettlementBinding;
    try {
      binding = await this.#transactionStore.bindSettlement(params);
    } catch (error) {
      if (error instanceof RemoteTransactionTransitionError) {
        throw new RemoteTransactionConflictError(
          409,
          error.code,
          error.message,
          error.settlementAuthority,
        );
      }
      throw error;
    }
    if (binding.status === "completed") {
      return {
        record: binding.record,
        settlementAuthority: {
          mode: binding.record.terminalAudit.settlementMode,
          outcome: "completed",
          state: binding.record.state,
        },
        finalization: binding.finalization,
      };
    }
    return {
      record: binding.record,
      settlementAuthority: {
        mode: binding.record.settlementMode,
        outcome: "bound",
        state: binding.record.state,
      },
    };
  }

  async settle(params: {
    transactionToken: string;
    mode: "finalize" | "abort";
    durablePublication: boolean;
  }): Promise<RemoteTransactionSettlementOutcome> {
    const binding = await this.bindSettlement(params);
    if ("finalization" in binding) {
      return { record: binding.record, finalization: binding.finalization };
    }

    let execution;
    try {
      execution = await this.#transactionStore.beginSettlementExecution({
        transactionToken: params.transactionToken,
        mode: binding.settlementAuthority.mode,
      });
    } catch (error) {
      if (error instanceof RemoteTransactionTransitionError) {
        throw new RemoteTransactionConflictError(
          409,
          error.code,
          error.message,
          error.settlementAuthority,
        );
      }
      throw error;
    }
    if (execution.status === "completed") {
      return { record: execution.record, finalization: execution.finalization };
    }
    const runtime = execution.cleanupRuntime;
    const mode = execution.record.settlementMode;

    const active = this.#activeTransactions.get(params.transactionToken);
    const rawFinalization = active
      ? await active[mode]().catch((error) => retryableCleanupFailure(runtime, mode, error))
      : await this.#retryCleanup(runtime, mode, params.transactionToken).catch((error) =>
          retryableCleanupFailure(runtime, mode, error),
        );
    const resourceFinalization =
      rawFinalization.status === "pending"
        ? pendingBrowserCaptureCleanup(
            withRemoteSettlementAuthority(rawFinalization.runtime),
            rawFinalization.error,
            mode,
          )
        : rawFinalization;
    const finalization = projectBrowserCaptureFinalization(runtime, resourceFinalization, mode);
    const record = await this.#transactionStore.completeSettlement({
      transactionToken: params.transactionToken,
      mode,
      finalization,
    });
    if (finalization.status === "completed") {
      this.#activeTransactions.delete(params.transactionToken);
    }
    return { record, finalization };
  }
}

function withRemoteSettlementAuthority(runtime: BrowserRuntimeMetadata): BrowserRuntimeMetadata {
  if (runtime.recoveryCleanupResources?.length || runtime.recoveryCleanupResult) return runtime;
  return { ...runtime, recoveryCleanupResult: { status: "pending" } };
}

function retryableCleanupFailure(
  runtime: BrowserRuntimeMetadata,
  mode: "finalize" | "abort",
  error: unknown,
): BrowserCaptureFinalizationResult {
  if (error instanceof BrowserAutomationError) {
    const code = error.details?.code;
    if (
      code === "browser-run-lifecycle-settlement-conflict" ||
      code === "settlement-mode-conflict" ||
      code === "remote-settlement-mode-conflict"
    ) {
      throw error;
    }
  }
  return pendingBrowserCaptureCleanup(
    runtime,
    error instanceof Error ? error.message : String(error),
    mode,
  );
}
