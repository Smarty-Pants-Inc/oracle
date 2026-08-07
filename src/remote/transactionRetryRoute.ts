import type http from "node:http";
import type { BrowserLogger } from "../browser/types.js";
import { resumeBrowserSession, type ReattachResult } from "../browser/reattach.js";
import { requiresCleanupOnlyCommittedPromptRecovery } from "../browser/reattachability.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { RemoteArtifactStore } from "./artifactStore.js";
import {
  assertCapturedPromptIdentity,
  browserRunResultFromTransaction,
  browserRuntimeFromError,
  browserTransactionFromRecoveredSession,
  remoteArtifactManualCopyWarning,
  serializeDurableBrowserAutomationError,
  stageRemoteCaptureWithArtifactFallback,
} from "./transactionCapture.js";
import {
  RemoteTransactionConflictError,
  RemoteTransactionCoordinator,
} from "./transactionCoordinator.js";
import {
  remoteBrowserAutomationError,
  remotePendingSettlementError,
  remoteTransactionPayload,
  terminalTransactionRetryResponse,
} from "./transactionProtocol.js";
import { settleExpiredRemoteTransaction } from "./transactionServer.js";
import { readRequestBody, RemoteRequestError, sendJson } from "./serverHttp.js";
import type {
  RemoteRecoverableTransactionRecord,
  RemoteSettlementPendingTransactionRecord,
  RemoteSettledTransactionRecord,
  RemoteTransactionRecord,
} from "./transactionModel.js";
import type { RemoteTransactionStore } from "./transactionStore.js";
import {
  isAbortWorthyRemoteCaptureMismatch,
  isTerminalRemoteBrowserAutomationError,
} from "./serverTransactionRuntime.js";
import { RemoteRetryRequestSchema, type RemoteTransactionRetryResponse } from "./types.js";

export interface RemoteTransactionRetryRouteParams {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  transactionStore: RemoteTransactionStore;
  artifactStore: RemoteArtifactStore;
  transactionCoordinator: RemoteTransactionCoordinator;
  transactionToken: string;
  isTransactionAdmitted: (transactionToken: string) => boolean;
  resumeBrowser: typeof resumeBrowserSession;
  runBrowserWork: <T>(operation: () => Promise<T>) => Promise<T>;
  runTransactionRetryWork: <T>(transactionToken: string, operation: () => Promise<T>) => Promise<T>;
  logger: BrowserLogger;
  serverLogger: (message: string) => void;
}

export async function serveRemoteTransactionRetry(
  params: RemoteTransactionRetryRouteParams,
): Promise<void> {
  try {
    const raw = await readRequestBody(params.req, 4096);
    RemoteRetryRequestSchema.parse(raw ? JSON.parse(raw) : {});
  } catch (error) {
    if (error instanceof RemoteRequestError) {
      sendJson(params.res, error.statusCode, { error: error.code, message: error.message });
    } else {
      sendJson(params.res, 400, { error: "invalid_retry_request" });
    }
    return;
  }
  if (params.isTransactionAdmitted(params.transactionToken)) {
    sendJson(params.res, 202, { status: "running" });
    return;
  }

  try {
    let record = await loadRetryRecord(params);
    if (!record) {
      sendJson(params.res, 404, {
        error: "transaction_not_retained",
        transactionToken: params.transactionToken,
      });
      return;
    }
    if (record.state === "finalized" || record.state === "aborted" || record.state === "failed") {
      sendJson(params.res, 200, terminalTransactionRetryResponse(record));
      return;
    }
    if (record.state === "running") {
      sendJson(params.res, 202, { status: "running" });
      return;
    }
    if (record.settlementMode) {
      const transactionToken = record.transactionToken;
      const settlementMode = record.settlementMode;
      const settled = (
        await params.runBrowserWork(
          async () =>
            await params.transactionCoordinator.settle({
              transactionToken,
              mode: settlementMode,
              durablePublication: settlementMode === "finalize",
            }),
        )
      ).record;
      sendJson(params.res, 200, retryFailureResponse(settled));
      return;
    }
    if (requiresCleanupOnlyCommittedPromptRecovery(record.runtime)) {
      const transactionToken = record.transactionToken;
      const outcome = await params.runBrowserWork(
        async () =>
          await params.transactionCoordinator.settle({
            transactionToken,
            mode: "abort",
            durablePublication: false,
          }),
      );
      const settled = outcome.record;
      const response: RemoteTransactionRetryResponse =
        settled.state === "finalized" || settled.state === "aborted" || settled.state === "failed"
          ? terminalTransactionRetryResponse(settled)
          : {
              status: "error",
              error: settled.error
                ? remoteBrowserAutomationError(settled)
                : remotePendingSettlementError(settled),
            };
      sendJson(params.res, 200, response);
      return;
    }
    if (record.state === "pending") {
      const response: RemoteTransactionRetryResponse = {
        status: "transaction",
        transaction: remoteTransactionPayload(record),
      };
      sendJson(params.res, 200, response);
      return;
    }
    if (record.stagedCapture && record.stagedCapture.artifacts === undefined) {
      const staged = record.stagedCapture;
      record = await params.transactionStore.stageCapture({
        transactionToken: record.transactionToken,
        runId: record.runId,
        result: {
          ...staged.result,
          warnings: [...(staged.result.warnings ?? []), remoteArtifactManualCopyWarning()].slice(
            -64,
          ),
        },
        runtime: staged.runtime,
        modelSelection: staged.modelSelection,
        artifacts: [],
      });
    }
    if (record.stagedCapture?.artifacts !== undefined) {
      const targetLivenessUnavailable =
        Boolean(record.restartRecovery) ||
        record.error?.stage === "connection-lost" ||
        record.error?.code === "browser-final-target-liveness-pending";
      const published = await params.transactionStore.promoteStagedCapture({
        transactionToken: record.transactionToken,
        projectTargetSelectionLoss: targetLivenessUnavailable,
        warning: targetLivenessUnavailable
          ? {
              code: "remote-post-archive-target-unavailable",
              message:
                "The exact pre-archive answer was promoted because post-archive identity revalidation became impossible after Chrome target liveness could no longer be established.",
            }
          : {
              code: "remote-publication-retry-recovered",
              message:
                "The exact assistant answer was published from its durable pre-archive capture without browser recapture.",
            },
      });
      const response: RemoteTransactionRetryResponse = {
        status: "transaction",
        transaction: remoteTransactionPayload(published),
      };
      sendJson(params.res, 200, response);
      return;
    }

    if (record.state !== "recoverable-error") {
      throw new Error(`Cannot retry browser recovery from transaction state ${record.state}`);
    }
    const outcome = await params.runTransactionRetryWork(
      params.transactionToken,
      async () => await params.runBrowserWork(async () => await recoverTransaction(params, record)),
    );
    sendJson(params.res, outcome.statusCode, outcome.body);
  } catch (error) {
    if (error instanceof RemoteTransactionConflictError) {
      sendJson(params.res, error.statusCode, {
        error: error.code,
        ...(error.settlementAuthority ? { settlementAuthority: error.settlementAuthority } : {}),
      });
      return;
    }
    throw error;
  }
}

async function loadRetryRecord(
  params: RemoteTransactionRetryRouteParams,
): Promise<RemoteTransactionRecord | null> {
  try {
    return await params.transactionStore.renewLease(params.transactionToken);
  } catch (error) {
    const latest = await params.transactionStore.read(params.transactionToken);
    if (!latest) return null;
    if (latest.state === "finalized" || latest.state === "aborted" || latest.state === "failed") {
      return latest;
    }
    if (!(error instanceof Error) || !error.message.includes("expired remote transaction lease")) {
      throw error;
    }
    return await params.runBrowserWork(
      async () =>
        await settleExpiredRemoteTransaction({
          transactionStore: params.transactionStore,
          transactionCoordinator: params.transactionCoordinator,
          logger: params.serverLogger,
          record: latest,
        }),
    );
  }
}

async function recoverTransaction(
  params: RemoteTransactionRetryRouteParams,
  record: RemoteRecoverableTransactionRecord,
): Promise<{ statusCode: number; body: RemoteTransactionRetryResponse }> {
  const recoveryRuntime = record.runtime;
  const recoveryStartedAt = Date.now();
  let recovered: ReattachResult | undefined;
  let coordinatorOwnsSettlement = false;
  try {
    try {
      recovered = await params.resumeBrowser(recoveryRuntime, record.browserConfig, params.logger, {
        sessionId: record.transactionToken,
        pendingPromptSha256Authorities: record.requestIdentity.acceptedPromptSha256,
        runtimeHintCb: async (runtime) => {
          if (runtime.recoveryCleanupResult?.settlementMode) {
            await params.transactionStore.persistSettlementRuntime(
              record.transactionToken,
              runtime,
            );
          } else {
            await params.transactionStore.journalRecoveryRuntime(record.transactionToken, runtime);
          }
        },
      });
    } catch (rawError) {
      const error =
        rawError instanceof BrowserAutomationError
          ? rawError
          : new BrowserAutomationError(
              rawError instanceof Error ? rawError.message : "Remote browser recovery failed",
              { stage: "remote-answer-recovery" },
              rawError,
            );
      const terminalFailure = isTerminalRemoteBrowserAutomationError(error);
      const failed = await params.transactionStore.recordRecoverableFailure({
        transactionToken: record.transactionToken,
        runtime: browserRuntimeFromError(error) ?? recoveryRuntime,
        error: serializeDurableBrowserAutomationError(error, !terminalFailure),
        settlementMode: terminalFailure ? "abort" : undefined,
      });
      if (!terminalFailure) {
        if (failed.state !== "recoverable-error") {
          throw new Error("Recoverable browser recovery failure became terminal unexpectedly");
        }
        return {
          statusCode: 200,
          body: { status: "error", error: remoteBrowserAutomationError(failed) },
        };
      }
      const settled = (
        await params.transactionCoordinator.settle({
          transactionToken: record.transactionToken,
          mode: "abort",
          durablePublication: false,
        })
      ).record;
      return { statusCode: 200, body: retryFailureResponse(settled) };
    }

    if (!recovered) throw new Error("Remote browser recovery returned no capture transaction");
    const capture = browserTransactionFromRecoveredSession(
      recovered,
      Date.now() - recoveryStartedAt,
    );
    const result = browserRunResultFromTransaction(capture);
    try {
      assertCapturedPromptIdentity(record.requestIdentity, result, capture.runtime);
      const staged = await stageRemoteCaptureWithArtifactFallback({
        transactionStore: params.transactionStore,
        artifactStore: params.artifactStore,
        transactionToken: record.transactionToken,
        runId: record.runId,
        result,
        runtime: capture.runtime,
      });
      if (staged.artifactFallback) {
        params.serverLogger(
          `[serve] Retry for run ${record.runId} preserved its captured text with manual artifact copy fallback (${staged.artifactFallback.stage}).`,
        );
      }
      const published = await params.transactionStore.promoteStagedCapture({
        transactionToken: record.transactionToken,
      });
      params.transactionCoordinator.registerActive(record.transactionToken, capture);
      coordinatorOwnsSettlement = true;
      return {
        statusCode: 200,
        body: { status: "transaction", transaction: remoteTransactionPayload(published) },
      };
    } catch (rawError) {
      const error =
        rawError instanceof BrowserAutomationError
          ? rawError
          : new BrowserAutomationError(
              rawError instanceof Error
                ? rawError.message
                : "Recovered remote capture could not be durably published.",
              {
                stage: "remote-answer-publication",
                code: "remote-answer-publication-failed",
              },
              rawError,
            );
      const terminalFailure = isAbortWorthyRemoteCaptureMismatch(rawError);
      const failed = await params.transactionStore.recordRecoverableFailure({
        transactionToken: record.transactionToken,
        runtime: capture.runtime,
        error: serializeDurableBrowserAutomationError(error, !terminalFailure),
        settlementMode: terminalFailure ? "abort" : undefined,
      });
      if (!terminalFailure) {
        if (failed.state !== "recoverable-error") {
          throw new Error("Recoverable capture publication failure became terminal unexpectedly");
        }
        return {
          statusCode: 200,
          body: { status: "error", error: remoteBrowserAutomationError(failed) },
        };
      }
      params.transactionCoordinator.registerActive(record.transactionToken, capture);
      coordinatorOwnsSettlement = true;
      const settled = (
        await params.transactionCoordinator.settle({
          transactionToken: record.transactionToken,
          mode: "abort",
          durablePublication: false,
        })
      ).record;
      return { statusCode: 200, body: retryFailureResponse(settled) };
    }
  } finally {
    if (recovered && !coordinatorOwnsSettlement) {
      await recovered.releaseSettlementLock();
    }
  }
}

function retryFailureResponse(
  record: RemoteSettlementPendingTransactionRecord | RemoteSettledTransactionRecord,
): RemoteTransactionRetryResponse {
  if (record.state === "finalized" || record.state === "aborted" || record.state === "failed") {
    return terminalTransactionRetryResponse(record);
  }
  return {
    status: "error",
    error:
      record.settlementMode && record.error?.recoverableDisconnect === false
        ? remotePendingSettlementError(record)
        : record.error
          ? remoteBrowserAutomationError(record)
          : remotePendingSettlementError(record),
  };
}
