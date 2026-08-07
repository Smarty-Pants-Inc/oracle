import { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import {
  assessChromeDisconnect,
  classifyPreservedBrowserError,
  connectionLostCause,
  connectionLostMessage,
  disconnectAssessmentFailureError,
  hasBrowserErrorCode,
  runtimeFromBrowserAutomationError,
  type ChromeDisconnectAssessment,
  type RecoverableDisconnectDetails,
} from "./coordinatorPolicy.js";
import {
  appendPostCaptureWarning,
  projectRuntimeAfterChromeTargetLoss,
} from "./publicationSettlementCoordinator.js";
import {
  maybeArchiveInterruptedConversation,
  withInterruptedArchiveDetails,
} from "./archiveSettlementCoordinator.js";
import { writeOracleChromeOwner } from "./profileState.js";
import { isWebSocketClosureError } from "./responseCaptureCoordinator.js";
import type { LocalBrowserAcquisition } from "./localAcquisition.js";
import type { LocalBrowserRunState } from "./localRunState.js";
import type { BrowserRunLifecycleController } from "./runLifecycle.js";
import type { BrowserLogger, BrowserRunTransaction, ResolvedBrowserConfig } from "./types.js";

export interface LocalDisconnectCoordinatorContext {
  acquisition: LocalBrowserAcquisition;
  state: LocalBrowserRunState;
  lifecycle: BrowserRunLifecycleController;
  config: ResolvedBrowserConfig;
  logger: BrowserLogger;
  usingCopiedProfile: boolean;
  buildRuntimeMetadata: (tabUrl?: string) => BrowserRuntimeMetadata;
}

export interface LocalDisconnectCoordinator {
  race<T>(promise: Promise<T>): Promise<T>;
  getAssessment(): Promise<ChromeDisconnectAssessment>;
  classifyFailure(error: unknown): BrowserAutomationError;
}

export function createLocalDisconnectCoordinator({
  acquisition,
  state,
  lifecycle,
  config,
  logger,
  usingCopiedProfile,
  buildRuntimeMetadata,
}: LocalDisconnectCoordinatorContext): LocalDisconnectCoordinator {
  const { chrome, chromeHost } = acquisition;
  let disconnectAssessmentPromise: Promise<ChromeDisconnectAssessment> | null = null;
  const getAssessment = (): Promise<ChromeDisconnectAssessment> => {
    disconnectAssessmentPromise ??= assessChromeDisconnect({
      host: chromeHost,
      port: chrome.port,
      targetId: state.lastTargetId ?? state.isolatedTargetId,
      lifecycle,
      recoveryAllowed: !usingCopiedProfile,
      commitTimeoutMs: config.inputTimeoutMs,
      logger,
    });
    return disconnectAssessmentPromise;
  };
  const classifyFailure = (error: unknown): BrowserAutomationError => {
    const runtime = runtimeFromBrowserAutomationError(error) ?? buildRuntimeMetadata();
    return disconnectAssessmentFailureError({ error, runtime });
  };
  const disconnectPromise = new Promise<never>((_, reject) => {
    state.client?.on("disconnect", () => {
      state.connectionClosedUnexpectedly = true;
      // Until the fresh liveness/commit probe resolves, cleanup authority is unresolved.
      // Preserve first so no concurrent failure path can tear down a potentially recoverable run.
      state.preserveBrowserOnError = true;
      void getAssessment()
        .then((assessment) => {
          state.preserveBrowserOnError = assessment.recoverable;
          if (assessment.recoverable) {
            logger(
              "CDP client disconnected; Chrome/target still reachable and the prompt is committed. Leaving run recoverable for reattach.",
            );
          } else if (assessment.targetReachable) {
            logger(
              usingCopiedProfile
                ? "CDP client disconnected; copy-profile runs are not retained."
                : "CDP client disconnected before prompt commit could be verified; cleaning up the run.",
            );
          } else {
            logger("Chrome window closed; attempting to abort run.");
          }
          const tabUrl = assessment.liveness.matchedUrl ?? state.lastUrl;
          reject(
            new BrowserAutomationError(
              connectionLostMessage({ assessment, copiedProfile: usingCopiedProfile }),
              {
                stage: "connection-lost",
                recoverableDisconnect: assessment.recoverable,
                disconnectCause: connectionLostCause(assessment, usingCopiedProfile),
                runtime: buildRuntimeMetadata(tabUrl),
              },
            ),
          );
        })
        .catch((error) => {
          const classified = classifyFailure(error);
          state.disconnectAssessmentFailure = classified;
          reject(classified);
        });
    });
  });
  return {
    race: <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, disconnectPromise]),
    getAssessment,
    classifyFailure,
  };
}

export interface LocalBrowserFailureContext {
  acquisition: LocalBrowserAcquisition;
  state: LocalBrowserRunState;
  lifecycle: BrowserRunLifecycleController;
  disconnect: LocalDisconnectCoordinator | null;
  config: ResolvedBrowserConfig;
  logger: BrowserLogger;
  usingCopiedProfile: boolean;
  followUpPrompts: string[];
  buildRuntimeBase: (tabUrl?: string) => BrowserRuntimeMetadata;
  buildRuntimeMetadata: (tabUrl?: string) => BrowserRuntimeMetadata;
  emitRuntimeHint: () => Promise<void>;
}

export async function recoverLocalBrowserFailure(
  {
    acquisition,
    state,
    lifecycle,
    disconnect,
    config,
    logger,
    usingCopiedProfile,
    followUpPrompts,
    buildRuntimeBase,
    buildRuntimeMetadata,
    emitRuntimeHint,
  }: LocalBrowserFailureContext,
  error: unknown,
): Promise<BrowserRunTransaction> {
  const { chrome, chromeOwnerDisposition, userDataDir } = acquisition;
  const rememberEscapingFailure = (escaping: Error): Error => {
    state.escapingFailure = escaping;
    return escaping;
  };
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  if (hasBrowserErrorCode(normalizedError, "pre-archive-capture-persistence-failed")) {
    throw rememberEscapingFailure(normalizedError);
  }
  const socketClosed =
    state.connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
  state.connectionClosedUnexpectedly = state.connectionClosedUnexpectedly || socketClosed;
  const postCaptureAssessment =
    state.publishableCapture && socketClosed && disconnect
      ? await disconnect.getAssessment().catch((assessmentError) => {
          logger(
            `[browser] Could not refine post-capture target authority: ${assessmentError instanceof Error ? assessmentError.message : String(assessmentError)}`,
          );
          return null;
        })
      : null;
  const identityRevalidationLostWithTarget =
    state.postCapturePendingWork?.code === "browser-final-identity-verification-pending" &&
    !hasBrowserErrorCode(normalizedError, "committed-prompt-identity-mismatch") &&
    postCaptureAssessment?.liveness.targetFound === false;
  if (
    state.publishableCapture &&
    (state.postCapturePendingWork?.code === "browser-final-target-liveness-pending" ||
      identityRevalidationLostWithTarget)
  ) {
    const pendingWork = identityRevalidationLostWithTarget
      ? {
          code: "browser-final-target-liveness-pending",
          context: "final committed-turn revalidation after Chrome target loss",
        }
      : (state.postCapturePendingWork ?? {
          code: "browser-publication-pending",
          context: "answer publication",
        });
    appendPostCaptureWarning(
      state.publishableCapture,
      pendingWork.code,
      pendingWork.context,
      normalizedError,
      logger,
    );
    let publicationBase = buildRuntimeBase(state.lastUrl);
    if (postCaptureAssessment?.liveness.targetFound === false) {
      publicationBase = projectRuntimeAfterChromeTargetLoss(publicationBase);
    }
    if (socketClosed && !usingCopiedProfile) {
      try {
        await writeOracleChromeOwner(userDataDir, {
          port: chrome.port,
          processIdentity: chrome.processIdentity,
          disposition: chromeOwnerDisposition,
        });
      } catch (ownerError) {
        appendPostCaptureWarning(
          state.publishableCapture,
          "browser-owner-publication-pending",
          "retained Chrome owner publication",
          ownerError,
          logger,
        );
      }
    }
    return lifecycle.issueCapture(state.publishableCapture, publicationBase);
  }
  state.escapingFailure = normalizedError;
  const preservedErrorKind = classifyPreservedBrowserError(normalizedError, config.headless);
  if (preservedErrorKind === "cloudflare-challenge") {
    if (usingCopiedProfile) {
      logger(
        "Cloudflare challenge detected; closing Chrome and removing the copied profile because copy-profile runs cannot be retained.",
      );
      throw rememberEscapingFailure(
        new BrowserAutomationError(
          "Cloudflare challenge detected. Copy-profile runs cannot be retained; complete the check in the source Chrome profile, then rerun.",
          { stage: "cloudflare-challenge", reattachable: false },
          normalizedError,
        ),
      );
    }
    state.preserveBrowserOnError = true;
    const runtime = buildRuntimeMetadata();
    const reuseProfileHint =
      `oracle --engine browser --browser-manual-login ` +
      `--browser-manual-login-profile-dir ${JSON.stringify(userDataDir)}`;
    await emitRuntimeHint();
    logger("Cloudflare challenge detected; leaving browser open so you can complete the check.");
    logger(`Reuse this browser profile with: ${reuseProfileHint}`);
    throw rememberEscapingFailure(
      new BrowserAutomationError(
        "Cloudflare challenge detected. Complete the “Just a moment…” check in the open browser, then rerun.",
        {
          stage: "cloudflare-challenge",
          runtime,
          reuseProfileHint,
        },
        normalizedError,
      ),
    );
  }
  if (preservedErrorKind === "reattachable-capture") {
    if (usingCopiedProfile) {
      logger(
        "Assistant capture incomplete; closing Chrome and removing the copied profile because copy-profile runs cannot be reattached.",
      );
      const details =
        normalizedError instanceof BrowserAutomationError
          ? { ...normalizedError.details, runtime: undefined, reattachable: false }
          : { stage: "assistant-recheck", reattachable: false };
      throw rememberEscapingFailure(
        new BrowserAutomationError(normalizedError.message, details, normalizedError),
      );
    }
    const archive =
      !socketClosed && state.browserRuntime
        ? await maybeArchiveInterruptedConversation({
            Runtime: state.browserRuntime,
            logger,
            config,
            conversationUrl: state.lastUrl,
            followUpCount: followUpPrompts.length,
          })
        : null;
    if (archive?.conversationUrl) {
      state.lastUrl = archive.conversationUrl;
    }
    state.preserveBrowserOnError = archive?.archived !== true;
    await emitRuntimeHint();
    logger(
      archive?.archived
        ? "Assistant capture incomplete; archived conversation and closing browser."
        : "Assistant capture incomplete; leaving browser open for reattach.",
    );
    throw rememberEscapingFailure(withInterruptedArchiveDetails(normalizedError, archive));
  }
  if (!socketClosed) {
    const archive = state.browserRuntime
      ? await maybeArchiveInterruptedConversation({
          Runtime: state.browserRuntime,
          logger,
          config,
          conversationUrl: state.lastUrl,
          followUpCount: followUpPrompts.length,
        })
      : null;
    if (archive?.conversationUrl) {
      state.lastUrl = archive.conversationUrl;
      await emitRuntimeHint();
    }
    state.preserveBrowserOnError =
      lifecycle.isPromptCommitted() &&
      !lifecycle.hasPendingPromptAuthorityJournal() &&
      state.postCapturePendingWork?.code !== "browser-final-identity-verification-pending" &&
      archive?.archived !== true;
    logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
    if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
      logger(normalizedError.stack);
    }
    throw rememberEscapingFailure(withInterruptedArchiveDetails(normalizedError, archive));
  }
  if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
    logger(`Chrome connection lost before completion: ${normalizedError.message}`);
    logger(normalizedError.stack);
  }
  if (!disconnect) {
    throw rememberEscapingFailure(normalizedError);
  }
  let assessment: ChromeDisconnectAssessment;
  try {
    assessment = await disconnect.getAssessment();
  } catch (assessmentError) {
    let classified =
      state.disconnectAssessmentFailure ?? disconnect.classifyFailure(assessmentError);
    const recoveryRuntime = runtimeFromBrowserAutomationError(classified);
    if (classified.details?.recoverableDisconnect === true && recoveryRuntime) {
      try {
        await writeOracleChromeOwner(userDataDir, {
          port: chrome.port,
          processIdentity: chrome.processIdentity,
          disposition: chromeOwnerDisposition,
        });
        const publishedRuntime = lifecycle.publishRecovery(recoveryRuntime);
        classified = disconnectAssessmentFailureError({
          error: classified.cause ?? classified,
          runtime: publishedRuntime,
        });
        state.preserveBrowserOnError = true;
      } catch (ownerError) {
        classified = new BrowserAutomationError(
          "Chrome disconnected after prompt commit, but retained Chrome owner authority could not be persisted.",
          {
            stage: "connection-lost",
            code: "retained-owner-persistence-failed",
            recoverableDisconnect: false,
            disconnectCause: "prompt-commit-unverified",
            runtime: recoveryRuntime,
          },
          new AggregateError([classified, ownerError], "Retained Chrome owner publication failed"),
        );
      }
    }
    if (classified.details?.recoverableDisconnect === true) await emitRuntimeHint();
    throw rememberEscapingFailure(classified);
  }
  if (assessment.recoverable) {
    try {
      await writeOracleChromeOwner(userDataDir, {
        port: chrome.port,
        processIdentity: chrome.processIdentity,
        disposition: chromeOwnerDisposition,
      });
    } catch (ownerError) {
      logger(
        `[browser] Failed to persist retained Chrome owner authority: ${ownerError instanceof Error ? ownerError.message : String(ownerError)}`,
      );
      assessment = { ...assessment, recoverable: false };
    }
  }
  state.preserveBrowserOnError = assessment.recoverable;
  const tabUrl = assessment.liveness.matchedUrl ?? state.lastUrl;
  if (assessment.recoverable) {
    lifecycle.publishRecovery(buildRuntimeBase(tabUrl));
  }
  await emitRuntimeHint();
  const connectionLostDetails =
    normalizedError instanceof BrowserAutomationError
      ? (normalizedError.details as RecoverableDisconnectDetails | undefined)
      : undefined;
  throw rememberEscapingFailure(
    new BrowserAutomationError(
      connectionLostMessage({ assessment, copiedProfile: usingCopiedProfile }),
      {
        ...connectionLostDetails,
        stage: "connection-lost",
        recoverableDisconnect: assessment.recoverable,
        disconnectCause: connectionLostCause(assessment, usingCopiedProfile),
        runtime: buildRuntimeMetadata(tabUrl),
      },
      normalizedError,
    ),
  );
}
