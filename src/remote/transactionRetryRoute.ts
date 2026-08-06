import type http from "node:http";
import type { BrowserLogger } from "../browser/types.js";
import { resumeBrowserSession, type ReattachResult } from "../browser/reattach.js";
import { requiresCleanupOnlyCommittedPromptRecovery } from "../browser/reattachability.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserRuntimeMetadata, SessionArtifact } from "../sessionManager.js";
import { RemoteArtifactStore } from "./artifactStore.js";
import {
  assertCapturedPromptIdentity,
  browserRunResultFromTransaction,
  browserRuntimeFromError,
  browserTransactionFromRecoveredSession,
  projectRemotePublicResult,
  serializeDurableBrowserAutomationError,
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
import { sendJson } from "./serverHttp.js";
import type { RemoteTransactionRecord } from "./transactionModel.js";
import { RemoteTransactionStore } from "./transactionStore.js";
import {
  isAbortWorthyRemoteCaptureMismatch,
  isTerminalRemoteBrowserAutomationError,
} from "./serverTransactionRuntime.js";
import { RemoteRetryRequestSchema, type RemoteTransactionRetryResponse } from "./types.js";

type RecoverableRemoteTransactionRecord = RemoteTransactionRecord & {
  state: "recoverable-error";
  runtime: BrowserRuntimeMetadata;
};

function isRecoverableRemoteTransactionRecord(
  record: RemoteTransactionRecord,
): record is RecoverableRemoteTransactionRecord {
  return record.state === "recoverable-error" && record.runtime !== undefined;
}

export interface RemoteTransactionRetryRouteParams {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  transactionStore: RemoteTransactionStore;
  artifactStore: RemoteArtifactStore;
  transactionCoordinator: RemoteTransactionCoordinator;
  transactionToken: string;
  resumeBrowser: typeof resumeBrowserSession;
  runBrowserWork: <T>(operation: () => Promise<T>) => Promise<T>;
  logger: BrowserLogger;
  serverLogger: (message: string) => void;
}

export async function serveRemoteTransactionRetry(
  params: RemoteTransactionRetryRouteParams,
): Promise<void> {
  try {
    const raw = await readRetryRequestBody(params.req);
    RemoteRetryRequestSchema.parse(raw ? JSON.parse(raw) : {});
  } catch {
    sendJson(params.res, 400, { error: "invalid_retry_request" });
    return;
  }

  try {
    const record = await loadRetryRecord(params);
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
      const settled =
        record.settlementMode === "abort" && record.error?.recoverableDisconnect === false
          ? (
              await params.runBrowserWork(
                async () =>
                  await params.transactionCoordinator.settle({
                    transactionToken: record.transactionToken,
                    mode: "abort",
                    durablePublication: false,
                  }),
              )
            ).record
          : record;
      sendJson(params.res, 200, retryFailureResponse(settled));
      return;
    }
    if (requiresCleanupOnlyCommittedPromptRecovery(record.runtime)) {
      const outcome = await params.runBrowserWork(
        async () =>
          await params.transactionCoordinator.settle({
            transactionToken: record.transactionToken,
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
    if (record.result) {
      const response: RemoteTransactionRetryResponse = {
        status: "transaction",
        transaction: remoteTransactionPayload(record),
      };
      sendJson(params.res, 200, response);
      return;
    }
    if (record.stagedCapture?.artifacts !== undefined) {
      const targetAuthorityUnavailable =
        Boolean(record.restartRecovery) ||
        record.error?.stage === "connection-lost" ||
        record.error?.code === "browser-final-target-liveness-pending";
      const published = await params.transactionStore.promoteStagedCapture({
        transactionToken: record.transactionToken,
        stripTargetAuthority: targetAuthorityUnavailable,
        warning: targetAuthorityUnavailable
          ? {
              code: "remote-post-archive-target-unavailable",
              message:
                "The exact pre-archive answer was promoted because post-archive identity revalidation became impossible after the Chrome target was lost.",
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
    if (!isRecoverableRemoteTransactionRecord(record)) {
      const response: RemoteTransactionRetryResponse = {
        status: "error",
        error: remoteBrowserAutomationError(record),
      };
      sendJson(params.res, 200, response);
      return;
    }

    const outcome = await params.runBrowserWork(
      async () => await recoverTransaction(params, record),
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
  record: RecoverableRemoteTransactionRecord,
): Promise<{ statusCode: number; body: RemoteTransactionRetryResponse }> {
  const recoveryRuntime = record.runtime;
  const recoveryStartedAt = Date.now();
  let recovered: ReattachResult;
  try {
    recovered = await params.resumeBrowser(recoveryRuntime, record.browserConfig, params.logger, {
      runtimeHintCb: async (runtime) => {
        if (runtime.recoveryCleanupResult?.settlementMode) {
          await params.transactionStore.persistSettlementRuntime(record.transactionToken, runtime);
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
      return { statusCode: 200, body: retryFailureResponse(failed) };
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

  const capture = browserTransactionFromRecoveredSession(recovered, Date.now() - recoveryStartedAt);
  const result = browserRunResultFromTransaction(capture);
  try {
    assertCapturedPromptIdentity(record.requestIdentity, result, capture.runtime);
    const fileArtifacts: SessionArtifact[] = [
      ...(result.savedFiles ?? []),
      ...(result.artifacts ?? []).filter((artifact) => artifact.kind === "file"),
    ];
    const registrations = await params.artifactStore.prepareRequiredArtifacts({
      transactionToken: record.transactionToken,
      runId: record.runId,
      artifacts: fileArtifacts,
    });
    await params.transactionStore.stageCapture({
      transactionToken: record.transactionToken,
      runId: record.runId,
      result: projectRemotePublicResult(result),
      runtime: capture.runtime,
      modelSelection: result.modelSelection,
      artifacts: registrations,
    });
    const published = await params.transactionStore.publishCapture({
      transactionToken: record.transactionToken,
      runId: record.runId,
      result: projectRemotePublicResult(result),
      runtime: capture.runtime,
      modelSelection: result.modelSelection,
      artifacts: registrations,
    });
    params.transactionCoordinator.registerActive(record.transactionToken, capture);
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
      return { statusCode: 200, body: retryFailureResponse(failed) };
    }
    params.transactionCoordinator.registerActive(record.transactionToken, capture);
    const settled = (
      await params.transactionCoordinator.settle({
        transactionToken: record.transactionToken,
        mode: "abort",
        durablePublication: false,
      })
    ).record;
    return { statusCode: 200, body: retryFailureResponse(settled) };
  }
}

function retryFailureResponse(record: RemoteTransactionRecord): RemoteTransactionRetryResponse {
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

async function readRetryRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.byteLength;
    if (receivedBytes > 4096) throw new Error("Remote retry request body exceeds size limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, receivedBytes).toString("utf8");
}
