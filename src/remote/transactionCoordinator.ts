import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import type { BrowserRunTransaction } from "../browserMode.js";
import type { BrowserRuntimeMetadata } from "../sessionManager.js";
import {
  pendingBrowserCaptureCleanup,
  projectBrowserCaptureFinalization,
} from "../browser/runLifecycle.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  type RemoteTransactionRecord,
  RemoteTransactionStore,
  RemoteTransactionTransitionError,
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

  activeTransactionTokens(): string[] {
    return [...this.#activeTransactions.keys()];
  }

  async settle(params: {
    transactionToken: string;
    mode: "finalize" | "abort";
    durablePublication: boolean;
  }): Promise<RemoteTransactionSettlementOutcome> {
    let binding;
    try {
      binding = await this.#transactionStore.bindSettlement(params);
    } catch (error) {
      if (error instanceof RemoteTransactionTransitionError) {
        throw new RemoteTransactionConflictError(409, error.code, error.message);
      }
      throw error;
    }
    if (binding.status === "completed") {
      if (!binding.finalization) {
        throw new Error("Completed remote transaction lacks finalization result");
      }
      return { record: binding.record, finalization: binding.finalization };
    }
    const runtime = binding.cleanupRuntime;
    const mode = binding.record.settlementMode;
    if (!mode) throw new Error("Bound transaction lacks exact runtime authority");

    const active = this.#activeTransactions.get(params.transactionToken);
    const rawFinalization = active
      ? await active[mode]().catch((error) => retryableCleanupFailure(runtime, mode, error))
      : await this.#retryCleanup(runtime, mode).catch((error) =>
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
