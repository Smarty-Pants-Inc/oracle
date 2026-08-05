import type { BrowserRunTransaction } from "../browserMode.js";
import type {
  DurableRemoteAutomationError,
  ReconcileRemoteTransactionResult,
  RemoteTransactionRecord,
  RemoteTransactionStore,
} from "./transactionStore.js";
import type { RemoteTransactionCoordinator } from "./transactionCoordinator.js";

interface RemoteTransactionServerAuthority {
  transactionStore: RemoteTransactionStore;
  transactionCoordinator: RemoteTransactionCoordinator;
  logger: (message: string) => void;
}

export async function reconcileRemoteTransactionAuthority(
  params: RemoteTransactionServerAuthority,
): Promise<ReconcileRemoteTransactionResult[]> {
  return await params.transactionStore.reconcileStaleRunningRecords({
    buildError: buildControllerRestartError,
  });
}

export async function settleExpiredRemoteTransaction(
  params: RemoteTransactionServerAuthority & { record: RemoteTransactionRecord },
): Promise<RemoteTransactionRecord | null> {
  const settlement = await params.transactionStore.expire({
    transactionToken: params.record.transactionToken,
    expectedLeaseExpiresAt: params.record.leaseExpiresAt,
    buildError: buildExpiredLeaseError,
  });
  if (settlement) {
    try {
      const outcome = await params.transactionCoordinator.settle({
        transactionToken: params.record.transactionToken,
        mode: settlement.mode,
        durablePublication: settlement.durablePublication,
      });
      params.logger(
        `[serve] Expired transaction ${params.record.transactionToken.slice(0, 12)} settled as ${outcome.record.state}.`,
      );
      return outcome.record;
    } catch (error) {
      params.logger(
        `[serve] Expired transaction ${params.record.transactionToken.slice(0, 12)} remains pending: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return await params.transactionStore.read(params.record.transactionToken);
}

export async function sweepExpiredRemoteTransactions(
  params: RemoteTransactionServerAuthority,
): Promise<void> {
  for (const record of await params.transactionStore.listExpiredNonterminalRecords()) {
    await settleExpiredRemoteTransaction({ ...params, record });
  }
}

export async function settleRemoteControllerShutdown(
  params: RemoteTransactionServerAuthority & {
    activeTransactions: Map<string, BrowserRunTransaction>;
  },
): Promise<void> {
  for (const transactionToken of params.transactionCoordinator.activeTransactionTokens()) {
    const shutdown = await params.transactionStore.prepareControllerShutdown(transactionToken);
    if (shutdown.action !== "settle") {
      params.activeTransactions.delete(transactionToken);
      continue;
    }
    const outcome = await params.transactionCoordinator.settle({
      transactionToken,
      mode: shutdown.mode,
      durablePublication: shutdown.durablePublication,
    });
    if (outcome.finalization.status !== "completed") {
      throw new Error(
        `Remote server cannot close while transaction ${transactionToken} cleanup remains pending`,
      );
    }
  }
  if (params.transactionCoordinator.activeTransactionTokens().length > 0) {
    throw new Error("Remote server cannot close while live transaction authority remains");
  }
}

function buildControllerRestartError(
  record: RemoteTransactionRecord,
  hadRuntimeAuthority: boolean,
): DurableRemoteAutomationError {
  return {
    name: "BrowserAutomationError",
    category: "browser-automation",
    message: hadRuntimeAuthority
      ? `Remote controller restarted while run ${record.runId} still owned recoverable browser authority.`
      : `Remote controller restarted before run ${record.runId} acquired browser authority.`,
    code: hadRuntimeAuthority ? "remote-controller-restarted" : "remote-controller-pre-authority",
    stage: "remote-controller-restart",
    recoverableDisconnect: hadRuntimeAuthority,
  };
}

function buildExpiredLeaseError(
  record: RemoteTransactionRecord,
  hadRuntimeAuthority: boolean,
): DurableRemoteAutomationError {
  return {
    name: "BrowserAutomationError",
    category: "browser-automation",
    message: hadRuntimeAuthority
      ? `Remote transaction lease expired while run ${record.runId} still owned browser authority.`
      : `Remote transaction lease expired before run ${record.runId} journaled browser authority.`,
    code: hadRuntimeAuthority ? "remote-transaction-lease-expired" : "remote-lease-pre-authority",
    stage: "remote-transaction-lease",
    recoverableDisconnect: hadRuntimeAuthority,
  };
}
