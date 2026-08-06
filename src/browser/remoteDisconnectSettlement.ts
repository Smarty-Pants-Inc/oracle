import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { closeChromeTargetWithRetainedCapability } from "./targetCloseAuthority.js";
import {
  completedBrowserCaptureCleanup,
  pendingBrowserCaptureCleanup,
  projectBrowserRetryableCleanupRuntime as projectRetryableCleanupRuntime,
  type BrowserCaptureSettlementMode,
} from "./ownedBrowserResources.js";
import {
  assessChromeDisconnect,
  classifyPreservedBrowserError,
  connectionLostCause,
  connectionLostMessage,
  disconnectAssessmentFailureError,
  hasBrowserErrorCode,
  runtimeFromBrowserAutomationError,
  type ChromeDisconnectAssessment,
} from "./coordinatorPolicy.js";
import { isWebSocketClosureError } from "./responseCaptureCoordinator.js";
import {
  maybeArchiveInterruptedConversation,
  persistCompletedUnpublishedFinalization,
  unpublishedCleanupPendingError,
  withInterruptedArchiveDetails,
} from "./archiveSettlementCoordinator.js";
import {
  appendPostCaptureWarning,
  projectRuntimeAfterChromeTargetLoss,
} from "./publicationSettlementCoordinator.js";
import { closeRemoteConnectionAfterRun } from "./promptSubmissionCoordinator.js";
import type { BrowserCaptureFinalizationResult, BrowserRunTransaction } from "./types.js";
import type { SessionBoundChromeClient } from "./chromeSessionTransport.js";
import type { RemoteBrowserExecutionContext } from "./remoteExecutionContext.js";

function getRemoteDisconnectAssessment(
  context: RemoteBrowserExecutionContext,
): Promise<ChromeDisconnectAssessment> {
  context.disconnectAssessmentPromise ??= assessChromeDisconnect({
    host: context.host,
    port: context.port,
    targetId: context.remoteTargetId,
    browserWSEndpoint: context.browserWSEndpoint,
    lifecycle: context.lifecycle,
    recoveryAllowed: true,
    commitTimeoutMs: context.config.inputTimeoutMs,
    logger: context.logger,
  });
  return context.disconnectAssessmentPromise;
}

function classifyRemoteDisconnectAssessmentFailure(
  context: RemoteBrowserExecutionContext,
  error: unknown,
): BrowserAutomationError {
  let cause = error;
  if (context.lifecycle.promptDispatch().status === "committed") {
    try {
      context.lifecycle.publishRecovery(
        runtimeFromBrowserAutomationError(error) ?? context.buildRuntimeBase(),
      );
    } catch (publicationError) {
      cause = new AggregateError(
        [error, publicationError],
        "Failed to publish verified remote disconnect recovery authority",
      );
    }
  }
  const runtime = context.buildRuntimeMetadata();
  context.preserveBrowserOnError = runtime.promptEpoch?.status === "committed";
  return disconnectAssessmentFailureError({ error: cause, runtime, remote: true });
}

export function installRemoteDisconnectHandler(
  context: RemoteBrowserExecutionContext,
  client: SessionBoundChromeClient,
): void {
  client.on("disconnect", () => {
    context.connectionClosedUnexpectedly = true;
    context.preserveBrowserOnError = true;
    void getRemoteDisconnectAssessment(context)
      .then((assessment) => {
        context.preserveBrowserOnError = assessment.recoverable;
        const tabUrl = assessment.liveness.matchedUrl ?? context.lastUrl;
        context.rejectDisconnect(
          new BrowserAutomationError(connectionLostMessage({ assessment, remote: true }), {
            stage: "connection-lost",
            recoverableDisconnect: assessment.recoverable,
            disconnectCause: connectionLostCause(assessment),
            runtime: context.buildRuntimeMetadata(tabUrl),
          }),
        );
      })
      .catch((error) => {
        const classified = classifyRemoteDisconnectAssessmentFailure(context, error);
        context.disconnectAssessmentFailure = classified;
        context.rejectDisconnect(classified);
      });
  });
}

export async function settleRemoteResources(
  context: RemoteBrowserExecutionContext,
  mode: BrowserCaptureSettlementMode,
  pendingRuntime: BrowserRuntimeMetadata,
): Promise<BrowserCaptureFinalizationResult> {
  const errors: string[] = [];
  const aborting = mode === "abort";
  const pendingResource = pendingRuntime.recoveryCleanupResources?.[0];
  const pendingCleanup = pendingResource?.recoveryCleanup;
  const pendingOwnsTarget = pendingCleanup?.ownsTarget === true;
  const finalizeTargetCloseDecision = pendingCleanup?.closeOwnedTargetOnComplete;
  if (!aborting && pendingOwnsTarget && typeof finalizeTargetCloseDecision !== "boolean") {
    return pendingBrowserCaptureCleanup(
      pendingRuntime,
      "Owned remote Chrome target finalize disposition is missing",
    );
  }
  const targetId = pendingResource?.chromeTargetId ?? null;
  const targetCloseCapability = pendingResource?.targetCloseCapability ?? null;
  const completedCapability = context.closedRemoteTargetCloseCapability;
  const targetCleanupCompleted = Boolean(
    targetId &&
    targetCloseCapability &&
    context.closedRemoteTargetId === targetId &&
    completedCapability?.generationId === targetCloseCapability.generationId &&
    completedCapability.capabilityId === targetCloseCapability.capabilityId,
  );
  const shouldCloseOwnedRemoteTarget =
    !targetCleanupCompleted &&
    (aborting ? pendingOwnsTarget : pendingOwnsTarget && finalizeTargetCloseDecision === true);
  if (shouldCloseOwnedRemoteTarget) {
    if (!targetId || !targetCloseCapability) {
      errors.push("Owned remote Chrome target has no retained exact close capability");
    } else {
      const closed = await closeChromeTargetWithRetainedCapability({
        ownerId: context.resourceOwnerId,
        capability: targetCloseCapability,
        targetId,
        logger: context.logger,
      });
      if (closed.status === "completed" || closed.status === "gone") {
        context.closedRemoteTargetId = targetId;
        context.closedRemoteTargetCloseCapability = targetCloseCapability;
      } else {
        errors.push(closed.reason);
      }
    }
  }
  if (errors.length > 0) {
    return pendingBrowserCaptureCleanup(
      projectRetryableCleanupRuntime(pendingRuntime, {
        targetId: context.closedRemoteTargetId,
        targetCloseCapability: context.closedRemoteTargetCloseCapability,
        tabLeaseId: context.releasedRemoteTabLeaseId,
      }),
      errors.join("; "),
    );
  }
  if (context.tabLease) {
    const handle = context.tabLease;
    try {
      await handle.release();
      context.releasedRemoteTabLeaseId = handle.id;
      context.tabLease = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Browser lease release failed: ${message}`);
      context.logger(
        `[browser] Browser lease release failed; preserving remote target: ${message}`,
      );
    }
  }
  const targetAuthorityReleased = Boolean(
    targetId &&
    targetCloseCapability &&
    context.closedRemoteTargetId === targetId &&
    context.closedRemoteTargetCloseCapability?.generationId ===
      targetCloseCapability.generationId &&
    context.closedRemoteTargetCloseCapability.capabilityId === targetCloseCapability.capabilityId,
  );
  if (targetAuthorityReleased) {
    context.retainRemoteConnectionForSettlement = false;
  } else if (!context.connectionClosedUnexpectedly && context.connection) {
    try {
      await context.connection.close();
      context.retainRemoteConnectionForSettlement = false;
    } catch (error) {
      errors.push(
        `Remote Chrome connection release failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const totalSeconds = (Date.now() - context.startedAt) / 1000;
  context.logger(`Remote session complete • ${totalSeconds.toFixed(1)}s total`);
  const retryableRuntime = projectRetryableCleanupRuntime(pendingRuntime, {
    targetId: context.closedRemoteTargetId,
    targetCloseCapability: context.closedRemoteTargetCloseCapability,
    tabLeaseId: context.releasedRemoteTabLeaseId,
  });
  return errors.length > 0
    ? pendingBrowserCaptureCleanup(retryableRuntime, errors.join("; "))
    : completedBrowserCaptureCleanup(retryableRuntime);
}

export async function handleRemoteBrowserFailure(
  context: RemoteBrowserExecutionContext,
  error: unknown,
): Promise<BrowserRunTransaction> {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  if (hasBrowserErrorCode(normalizedError, "pre-archive-capture-persistence-failed")) {
    throw context.rememberEscapingFailure(normalizedError);
  }
  const socketClosed =
    context.connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
  context.connectionClosedUnexpectedly = context.connectionClosedUnexpectedly || socketClosed;
  const postCaptureAssessment =
    context.publishableCapture && socketClosed
      ? await getRemoteDisconnectAssessment(context).catch((assessmentError) => {
          context.logger(
            `[browser] Could not refine post-capture remote target authority: ${assessmentError instanceof Error ? assessmentError.message : String(assessmentError)}`,
          );
          return null;
        })
      : null;
  const identityRevalidationLostWithTarget =
    context.postCapturePendingWork?.code === "browser-final-identity-verification-pending" &&
    !hasBrowserErrorCode(normalizedError, "committed-prompt-identity-mismatch") &&
    postCaptureAssessment?.liveness.targetFound === false;
  if (
    context.publishableCapture &&
    (context.postCapturePendingWork?.code === "browser-final-target-liveness-pending" ||
      identityRevalidationLostWithTarget)
  ) {
    const pendingWork = identityRevalidationLostWithTarget
      ? {
          code: "browser-final-target-liveness-pending",
          context: "final committed-turn revalidation after remote Chrome target loss",
        }
      : (context.postCapturePendingWork ?? {
          code: "browser-publication-pending",
          context: "answer publication",
        });
    appendPostCaptureWarning(
      context.publishableCapture,
      pendingWork.code,
      pendingWork.context,
      normalizedError,
      context.logger,
    );
    let publicationBase = context.buildRuntimeBase(context.lastUrl);
    if (postCaptureAssessment?.liveness.targetFound === false) {
      publicationBase = projectRuntimeAfterChromeTargetLoss(publicationBase);
    }
    const transaction = context.lifecycle.issueCapture(context.publishableCapture, publicationBase);
    context.retainRemoteConnectionForSettlement =
      context.lifecycle.hasPendingPromptAuthorityJournal();
    return transaction;
  }
  const preservedErrorKind = classifyPreservedBrowserError(
    normalizedError,
    context.config.headless,
  );

  if (!socketClosed) {
    const archive = context.browserRuntime
      ? await maybeArchiveInterruptedConversation({
          Runtime: context.browserRuntime,
          logger: context.logger,
          config: context.config,
          conversationUrl: context.lastUrl,
          followUpCount: context.followUpPrompts.length,
        })
      : null;
    if (archive?.conversationUrl) {
      context.lastUrl = archive.conversationUrl;
      await context.emitRuntimeHint();
    }
    context.preserveBrowserOnError =
      context.lifecycle.isPromptCommitted() ||
      preservedErrorKind === "cloudflare-challenge" ||
      (preservedErrorKind === "reattachable-capture" && archive?.archived !== true);
    context.logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
    if (
      (context.config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") &&
      normalizedError.stack
    ) {
      context.logger(normalizedError.stack);
    }
    throw context.rememberEscapingFailure(withInterruptedArchiveDetails(normalizedError, archive));
  }

  let assessment: ChromeDisconnectAssessment;
  try {
    assessment = await getRemoteDisconnectAssessment(context);
  } catch (assessmentError) {
    const classified =
      context.disconnectAssessmentFailure ??
      classifyRemoteDisconnectAssessmentFailure(context, assessmentError);
    await context.emitRuntimeHint();
    throw context.rememberEscapingFailure(classified);
  }
  context.preserveBrowserOnError = assessment.recoverable;
  const tabUrl = assessment.liveness.matchedUrl ?? context.lastUrl;
  if (assessment.recoverable) {
    context.lifecycle.publishRecovery(context.buildRuntimeBase(tabUrl));
  }
  await context.emitRuntimeHint();
  throw context.rememberEscapingFailure(
    new BrowserAutomationError(
      connectionLostMessage({ assessment, remote: true }),
      {
        stage: "connection-lost",
        recoverableDisconnect: assessment.recoverable,
        disconnectCause: connectionLostCause(assessment),
        runtime: context.buildRuntimeMetadata(tabUrl),
      },
      normalizedError,
    ),
  );
}

export async function finalizeRemoteBrowserRun(
  context: RemoteBrowserExecutionContext,
): Promise<void> {
  await context.conversationUrlMonitor?.stop();
  try {
    if (
      !context.ownsTarget &&
      !context.retainRemoteConnectionForSettlement &&
      !context.lifecycle.hasPendingPromptAuthorityJournal()
    ) {
      await closeRemoteConnectionAfterRun({
        connectionClosedUnexpectedly: context.connectionClosedUnexpectedly,
        connection: context.connection,
        client: context.client,
        runStatus: context.runStatus,
      });
    }
  } catch {
    // ignore
  }
  context.removeDialogHandler?.();
  const finalization = await context.lifecycle.settleIfUnpublished();
  await persistCompletedUnpublishedFinalization(
    finalization,
    context.options.runtimeHintCb,
    context.modelSelectionEvidence,
    context.escapingFailure,
  );
  if (finalization?.status === "pending") {
    await Promise.reject(unpublishedCleanupPendingError(finalization, context.escapingFailure));
  }
}
