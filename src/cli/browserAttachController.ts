import chalk from "chalk";
import path from "node:path";
import type { BrowserRuntimeMetadata, SessionMetadata } from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";
import type {
  BrowserCaptureFinalizationResult,
  BrowserLogger,
  BrowserRunTransaction,
} from "../browser/types.js";
import {
  bindCurrentBrowserRecoveryRuntime,
  resumeBrowserSession,
  settleBrowserRecoveryCleanup,
  type ReattachResult,
} from "../browser/reattach.js";
import {
  OwnedBrowserResourceTransaction,
  projectBrowserCaptureFinalization,
} from "../browser/ownedBrowserResources.js";
import { retainChromeEndpointAuthority } from "../browser/chromeLifecycle.js";
import { isProcessAlive } from "../browser/profileState.js";
import { acquireReattachRecoveryLock, type ReattachRecoveryLock } from "../browser/reattachLock.js";
import {
  hasExactPendingChromeAcquisitionAuthority,
  hasPendingChromeAcquisitionIntent,
  hasRecoverableChatGptConversation,
  isRecoverableChatGptConversationUrl,
  resolveCommittedPromptEpochLocator,
} from "../browser/reattachability.js";
import {
  appendArtifacts,
  saveBrowserTranscriptArtifact,
  saveDeepResearchReportArtifact,
} from "../browser/artifacts.js";
import { estimateTokenCount } from "../browser/utils.js";
import {
  createBrowserCapturePublicationAcknowledgement,
  persistDurableBrowserAnswer,
  persistBrowserCaptureFinalizationState,
  publishCompletedBrowserCapture,
  readDurableBrowserAnswer,
  runtimeFromBrowserError,
  verifiedDurableBrowserAnswerReceiptFromError,
  type BrowserCapturePublicationAcknowledgement,
  type DurableBrowserAnswerReceipt,
} from "./durableAnswer.js";
import {
  clearBrowserCapturePublicationJournal,
  readBrowserCapturePublicationJournal,
  sanitizeBrowserPublicationMessage,
  type BrowserCapturePublicationJournal,
} from "./browserPublicationJournal.js";
import {
  hasRemoteRecoveryAuthority,
  MonotonicBrowserRuntimeAuthority,
} from "./browserRuntimeAuthority.js";

const isTty = (): boolean => Boolean(process.stdout.isTTY);
const dim = (text: string): string => (isTty() ? chalk.dim(text) : text);

const DEEP_RESEARCH_TOOL_CALL_MARKERS = [
  "called tool",
  "used tool",
  "użyto narzędzia",
  "narzędzie wywołane",
];

export function isDeepResearchPlaceholderCapture(
  metadata: SessionMetadata,
  logText: string,
): boolean {
  if (/\[reattach\][^\n]*\nAnswer:/i.test(logText)) {
    return false;
  }
  const answer = trimBeforeFirstAnswer(logText).replace(/^Answer:\s*/i, "");
  const modelUsage = metadata.models?.find((run) => run.model === metadata.model)?.usage;
  const outputTokens = metadata.usage?.outputTokens ?? modelUsage?.outputTokens;
  return isDeepResearchToolCallPlaceholder(
    answer,
    typeof outputTokens === "number" && Number.isFinite(outputTokens) ? outputTokens : undefined,
  );
}

export async function orchestrateBrowserAttachAuthority(
  sessionId: string,
  initialMetadata: SessionMetadata,
): Promise<SessionMetadata> {
  let metadata = initialMetadata;
  let publicationJournal = await readBrowserCapturePublicationJournal(sessionId);
  let runtime = publicationJournal?.runtime ?? metadata.browser?.runtime;
  const controllerPid = runtime?.controllerPid;
  const workerPid = metadata.lifecycle?.workerPid;
  const controllerAlive = typeof controllerPid === "number" && isProcessAlive(controllerPid);
  const workerAlive = typeof workerPid === "number" && isProcessAlive(workerPid);
  const completedRuntime = metadata.browser?.runtime;
  if (
    publicationJournal &&
    metadata.status === "completed" &&
    completedRuntime !== undefined &&
    !completedRuntime.recoveryCleanupResources?.length &&
    !completedRuntime.recoveryCleanupResult &&
    hasDurableBrowserAnswerReceipt(metadata, publicationJournal.receipt)
  ) {
    try {
      await clearBrowserCapturePublicationJournal(sessionId);
      publicationJournal = null;
    } catch (error) {
      console.log(
        chalk.yellow(
          `Completed browser cleanup is durable, but its stale publication journal could not be retired: ${sanitizeBrowserPublicationMessage(formatError(error))}`,
        ),
      );
      return metadata;
    }
  }
  if (
    publicationJournal?.phase === "preparing" &&
    metadata.browser?.runtime?.recoveryCleanupResult?.settlementMode === "abort"
  ) {
    await clearBrowserCapturePublicationJournal(sessionId);
    publicationJournal = null;
  }
  if (publicationJournal && (controllerAlive || workerAlive)) {
    return metadata;
  }
  if (publicationJournal) {
    const durableAnswer = await readDurableBrowserAnswer(publicationJournal.receipt);
    if (durableAnswer !== null || publicationJournal.phase !== "preparing") {
      if (durableAnswer === null) {
        console.log(
          chalk.yellow(
            "Durable browser publication recovery is pending because its verified answer is unavailable.",
          ),
        );
        return metadata;
      }
      try {
        return await recoverDurableBrowserPublication(
          sessionId,
          metadata,
          publicationJournal,
          durableAnswer,
        );
      } catch (error) {
        console.log(
          chalk.red(
            `Durable browser publication recovery remains pending: ${sanitizeBrowserPublicationMessage(formatError(error))}`,
          ),
        );
        return (await sessionStore.readSession(sessionId)) ?? metadata;
      }
    }
  }
  runtime = publicationJournal?.runtime ?? metadata.browser?.runtime;
  if (!publicationJournal) {
    const repairedRuntime = repairTrustedStaleConversationUrl(runtime);
    if (repairedRuntime !== runtime && repairedRuntime) {
      await sessionStore.updateSession(sessionId, {
        browser: { ...metadata.browser, runtime: repairedRuntime },
      });
      metadata = {
        ...metadata,
        browser: { ...metadata.browser, runtime: repairedRuntime },
      };
      runtime = repairedRuntime;
    }
  }

  const persistedCleanupMode = runtime?.recoveryCleanupResult?.settlementMode;
  const publicationRecoveryPending = publicationJournal !== null;
  const explicitlyNonReattachable = readBooleanErrorDetail(metadata, "reattachable") === false;
  const nonReattachableCleanupOnly =
    metadata.mode === "browser" &&
    metadata.status === "error" &&
    explicitlyNonReattachable &&
    !publicationRecoveryPending &&
    !controllerAlive &&
    !workerAlive &&
    Boolean(runtime?.recoveryCleanupResources?.length) &&
    Boolean(runtime?.recoveryCleanupResult);
  const completedCleanupAcknowledged = publicationJournal
    ? publicationJournal.phase === "published" || publicationJournal.phase === "cleanup-pending"
    : metadata.status === "completed" && hasDurableBrowserAnswerReceipt(metadata);
  const pendingAcquisitionIntent = hasPendingChromeAcquisitionIntent(runtime);
  const staleAcquisitionLifecycle =
    (metadata.status === "running" || metadata.status === "error") &&
    !controllerAlive &&
    !workerAlive;
  const acquisitionOnlyCleanup =
    metadata.mode === "browser" &&
    staleAcquisitionLifecycle &&
    pendingAcquisitionIntent &&
    !hasRemoteRecoveryAuthority(runtime) &&
    !hasRecoverableChatGptConversation(runtime);
  const exactPendingAcquisitionAuthority = hasExactPendingChromeAcquisitionAuthority(runtime);
  const automaticAcquisitionCleanupMode =
    acquisitionOnlyCleanup && exactPendingAcquisitionAuthority ? "abort" : null;
  const malformedAcquisitionOnlyCleanup =
    acquisitionOnlyCleanup && !exactPendingAcquisitionAuthority;
  let cleanupRetryMode: "finalize" | "abort" | null = automaticAcquisitionCleanupMode;
  if (!cleanupRetryMode && nonReattachableCleanupOnly && persistedCleanupMode === undefined) {
    cleanupRetryMode = "abort";
  } else if (!cleanupRetryMode && !malformedAcquisitionOnlyCleanup) {
    if (persistedCleanupMode === "abort") {
      cleanupRetryMode = "abort";
    } else if (
      completedCleanupAcknowledged &&
      (persistedCleanupMode === undefined || persistedCleanupMode === "finalize")
    ) {
      cleanupRetryMode = "finalize";
    } else if (metadata.status === "error") {
      cleanupRetryMode = persistedCleanupMode ?? null;
    }
  }

  if (
    !publicationRecoveryPending &&
    cleanupRetryMode &&
    runtime &&
    (runtime.recoveryCleanupResult || automaticAcquisitionCleanupMode)
  ) {
    const cleanupLogger = browserLogger();
    const staleRunningAcquisitionRecovered =
      automaticAcquisitionCleanupMode !== null && metadata.status === "running";
    const cleanupMessageFor = (result: BrowserCaptureFinalizationResult): string =>
      sanitizeBrowserPublicationMessage(
        nonReattachableCleanupOnly
          ? result.status === "pending"
            ? `Browser response recovery is unavailable; owned browser cleanup remains pending: ${result.error}`
            : "Browser response recovery is unavailable; owned browser cleanup completed without resubmitting."
          : result.status === "pending"
            ? `Browser acquisition cleanup remains pending: ${result.error}`
            : "Browser session stopped before committing a prompt; acquisition cleanup completed.",
      );
    const persistCleanupProjection = async (
      result: BrowserCaptureFinalizationResult,
    ): Promise<BrowserCaptureFinalizationResult> => {
      const cleanupMessage = cleanupMessageFor(result);
      await sessionStore.updateSession(sessionId, {
        browser: { ...metadata.browser, runtime: result.runtime },
        ...(staleRunningAcquisitionRecovered
          ? {
              status: "error",
              completedAt: new Date().toISOString(),
              errorMessage: cleanupMessage,
              response: { status: "error", incompleteReason: "incomplete-capture" },
              error: {
                category: "browser-automation",
                message: cleanupMessage,
                details: {
                  stage: "browser-acquisition-recovery",
                  code:
                    result.status === "pending"
                      ? "browser-acquisition-cleanup-pending"
                      : "browser-acquisition-cleanup-completed",
                },
              },
            }
          : {}),
      });
      return result;
    };
    try {
      const sessionPaths = await sessionStore.getPaths(sessionId);
      const outcome = await settleBrowserRecoveryCleanup(
        runtime,
        cleanupLogger,
        {
          recoveryLockPath: path.join(sessionPaths.dir, "browser-recovery.lock"),
          recoveryCleanup: { retainChromeEndpointAuthority },
          isRemotePublicationAcknowledged: () =>
            completedCleanupAcknowledged && cleanupRetryMode === "finalize",
          loadRuntimeUnderLock: async () => {
            if (await readBrowserCapturePublicationJournal(sessionId)) {
              throw new Error("Browser publication authority changed while cleanup was queued");
            }
            const latestRuntime = (await sessionStore.readSession(sessionId))?.browser?.runtime;
            if (!latestRuntime) {
              throw new Error("Browser recovery runtime disappeared while cleanup was queued");
            }
            return latestRuntime;
          },
          persistFinalizationResult: persistCleanupProjection,
          completeFinalizationAfterLockRelease: persistCleanupProjection,
        },
        cleanupRetryMode,
      );
      metadata = (await sessionStore.readSession(sessionId)) ?? metadata;
      runtime = metadata.browser?.runtime;
      const displayResult: BrowserCaptureFinalizationResult =
        outcome.persistence.status === "pending"
          ? {
              status: "pending",
              runtime: outcome.persistence.runtime,
              error: outcome.persistence.error,
            }
          : outcome.finalization;
      const cleanupMessage = cleanupMessageFor(displayResult);
      if (displayResult.status === "pending") {
        console.log(chalk.yellow(cleanupMessage));
      } else if (nonReattachableCleanupOnly) {
        console.log(dim(cleanupMessage));
      }
    } catch (error) {
      console.log(
        chalk.yellow(
          `Browser cleanup retry was deferred: ${sanitizeBrowserPublicationMessage(formatError(error))}`,
        ),
      );
    }
  }

  publicationJournal = await readBrowserCapturePublicationJournal(sessionId);
  runtime = publicationJournal?.runtime ?? metadata.browser?.runtime;
  const hasChromeDisconnect = metadata.response?.incompleteReason === "chrome-disconnected";
  const hasIncompleteCapture = metadata.response?.incompleteReason === "incomplete-capture";
  const hasResumableRemoteAuthority =
    hasRemoteRecoveryAuthority(runtime) && !runtime?.recoveryCleanupResult?.settlementMode;
  const statusAllowsReattach =
    publicationJournal !== null ||
    metadata.status === "running" ||
    (metadata.status === "error" &&
      (hasChromeDisconnect || hasIncompleteCapture || hasResumableRemoteAuthority));
  const hasFallbackSessionInfo = Boolean(
    publicationJournal ||
    hasResumableRemoteAuthority ||
    runtime?.chromePort ||
    runtime?.chromeBrowserWSEndpoint ||
    runtime?.chromeProfileRoot ||
    runtime?.tabUrl ||
    runtime?.conversationId,
  );
  const deepResearchPlaceholderCapture =
    isDeepResearchBrowserSession(metadata) &&
    hasFallbackSessionInfo &&
    isDeepResearchPlaceholderCapture(
      metadata,
      await sessionStore.readLog(sessionId).catch(() => ""),
    );
  const completedDeepResearchPlaceholder =
    metadata.status === "completed" && deepResearchPlaceholderCapture;
  const hasRecoverableConversation =
    publicationJournal !== null ||
    hasResumableRemoteAuthority ||
    hasRecoverableChatGptConversation(runtime);
  const recoverableDisconnect = readBooleanErrorDetail(metadata, "recoverableDisconnect");
  const disconnectRecoveryAuthorized =
    !hasChromeDisconnect || hasResumableRemoteAuthority || recoverableDisconnect === true;
  const explicitlyNonRecoverable = recoverableDisconnect === false;
  const canReattach =
    (statusAllowsReattach || completedDeepResearchPlaceholder) &&
    metadata.mode === "browser" &&
    Boolean(runtime) &&
    hasFallbackSessionInfo &&
    hasRecoverableConversation &&
    persistedCleanupMode !== "abort" &&
    !explicitlyNonRecoverable &&
    !explicitlyNonReattachable &&
    disconnectRecoveryAuthorized &&
    !workerAlive &&
    (publicationJournal !== null ||
      hasResumableRemoteAuthority ||
      hasChromeDisconnect ||
      hasIncompleteCapture ||
      completedDeepResearchPlaceholder ||
      (runtime?.controllerPid && !controllerAlive));

  if (!canReattach || !runtime) return metadata;

  if (publicationJournal) {
    console.log(chalk.yellow("Recovering a staged browser answer publication..."));
  } else if (hasResumableRemoteAuthority) {
    console.log(chalk.yellow("Attempting to resume the persisted remote browser transaction..."));
  } else {
    const portInfo = runtime.chromePort ? `port ${runtime.chromePort}` : "unknown port";
    const urlInfo = runtime.tabUrl ? `url=${runtime.tabUrl}` : "url=unknown";
    console.log(
      chalk.yellow(
        `Attempting to reattach to the existing Chrome session (${portInfo}, ${urlInfo})...`,
      ),
    );
  }

  const runtimeAuthority = new MonotonicBrowserRuntimeAuthority(runtime);
  let authoritativeRuntime = runtime;
  let answerPublished = false;
  const acknowledgement = createBrowserCapturePublicationAcknowledgement();
  let liveFinalizationJournal = publicationJournal;
  let liveFinalizationPersistence: { status: "persisted" } | { status: "pending"; error: string } =
    {
      status: "pending",
      error: "Browser finalization has not completed under the recovery lock",
    };
  const persistLiveFinalization = async (
    result: BrowserCaptureFinalizationResult,
    beforeRuntime: BrowserRuntimeMetadata,
    mode: "finalize" | "abort",
    released: boolean,
  ): Promise<BrowserCaptureFinalizationResult> => {
    const projectedResult = projectBrowserCaptureFinalization(beforeRuntime, result, mode);
    for (let attempt = 0; ; attempt += 1) {
      try {
        let persistedResult: BrowserCaptureFinalizationResult;
        if (mode === "abort") {
          await sessionStore.updateSession(sessionId, {
            browser: { ...metadata.browser, runtime: projectedResult.runtime },
          });
          persistedResult = projectedResult;
        } else {
          const observedJournal = await readBrowserCapturePublicationJournal(sessionId);
          if (observedJournal) liveFinalizationJournal = observedJournal;
          const expectedJournal = observedJournal ?? liveFinalizationJournal;
          if (!expectedJournal) throw new Error("Browser publication journal is unavailable");
          persistedResult = await persistBrowserCaptureFinalizationState(
            sessionId,
            metadata.browser ?? expectedJournal.browserAudit,
            expectedJournal,
            projectedResult,
            beforeRuntime,
            { acknowledgeCapabilities: false },
          );
        }
        liveFinalizationPersistence =
          released || !persistedResult.runtime.recoveryCleanupResult?.lockReleasePending
            ? { status: "persisted" }
            : {
                status: "pending",
                error:
                  persistedResult.runtime.recoveryCleanupResult.error ??
                  "Browser recovery lock release remains pending",
              };
        return persistedResult;
      } catch (error) {
        if (attempt < 1) continue;
        const message = sanitizeBrowserPublicationMessage(formatError(error));
        liveFinalizationPersistence = { status: "pending", error: message };
        throw error;
      }
    }
  };
  if (
    publicationJournal?.phase === "published" ||
    publicationJournal?.phase === "cleanup-pending"
  ) {
    acknowledgement.acknowledge();
  }

  try {
    const sessionPaths = await sessionStore.getPaths(sessionId);
    const reattachResult: ReattachResult = await resumeBrowserSession(
      authoritativeRuntime,
      metadata.browser?.config,
      browserLogger(),
      {
        recoveryLockPath: path.join(sessionPaths.dir, "browser-recovery.lock"),
        isRemotePublicationAcknowledged: acknowledgement.isPublished,
        runtimeHintCb: async (latestRuntime) => {
          authoritativeRuntime = runtimeAuthority.observeHint(latestRuntime);
          if (!publicationJournal) {
            await sessionStore.updateSession(sessionId, {
              browser: { ...metadata.browser, runtime: authoritativeRuntime },
            });
          }
        },
        loadRuntimeUnderLock: async () =>
          (await readBrowserCapturePublicationJournal(sessionId))?.runtime ??
          (await sessionStore.readSession(sessionId))?.browser?.runtime ??
          authoritativeRuntime,
        persistFinalizationResult: (result, beforeRuntime, mode) =>
          persistLiveFinalization(result, beforeRuntime, mode, false),
        completeFinalizationAfterLockRelease: (result, beforeRuntime, mode) =>
          persistLiveFinalization(result, beforeRuntime, mode, true),
      },
    );
    authoritativeRuntime = runtimeAuthority.observeHint(reattachResult.runtime);
    const capturedAnswer = reattachResult.answerMarkdown || reattachResult.answerText;
    const journaledAnswer =
      publicationJournal?.phase === "preparing"
        ? await readDurableBrowserAnswer(publicationJournal.receipt)
        : null;
    const answerText = journaledAnswer ?? capturedAnswer;
    const outputTokens = estimateTokenCount(answerText);
    const usage = publicationJournal?.usage ?? {
      inputTokens: 0,
      outputTokens,
      reasoningTokens: 0,
      totalTokens: outputTokens,
    };
    const publication = await publishCompletedBrowserCapture({
      answer: {
        sessionId,
        answer: answerText,
        logHeader:
          completedDeepResearchPlaceholder ||
          (hasIncompleteCapture && deepResearchPlaceholderCapture)
            ? "[reattach] replaced incomplete Deep Research capture from existing Chrome tab"
            : "[reattach] captured assistant response from existing Chrome tab",
        replaceLog:
          completedDeepResearchPlaceholder ||
          (hasIncompleteCapture && deepResearchPlaceholderCapture),
      },
      transaction: reattachResult,
      persistAnswer: persistDurableBrowserAnswer,
      browser: {
        ...metadata.browser,
        runtime: authoritativeRuntime,
      },
      existingArtifacts: metadata.artifacts,
      prepareArtifacts: async () => saveReattachBrowserArtifacts(sessionId, metadata, answerText),
      usage,
      response: { status: "completed" },
      model: metadata.model,
      acknowledgement,
      projectRuntime: (latestRuntime) => {
        authoritativeRuntime = runtimeAuthority.observeHint(latestRuntime);
        return authoritativeRuntime;
      },
      label: "Reattach answer",
      log: (message) => console.log(dim(message)),
      finalizationPersistence: () => liveFinalizationPersistence,
    });
    answerPublished = true;
    authoritativeRuntime = publication.finalization.runtime;
    if (publication.finalization.status === "pending") {
      console.log(
        chalk.yellow(
          `Reattach completed; browser cleanup remains pending: ${sanitizeBrowserPublicationMessage(publication.finalization.error)}`,
        ),
      );
    } else if (publication.runtimeAuthority.status === "pending") {
      console.log(
        chalk.yellow(
          `Reattach answer is published; cleanup authority projection remains pending: ${sanitizeBrowserPublicationMessage(publication.runtimeAuthority.error)}`,
        ),
      );
    } else {
      console.log(chalk.green("Reattach succeeded; session marked completed."));
    }
    return (await sessionStore.readSession(sessionId)) ?? metadata;
  } catch (error) {
    authoritativeRuntime =
      runtimeAuthority.observeError(runtimeFromBrowserError(error)) ?? authoritativeRuntime;
    publicationJournal = await readBrowserCapturePublicationJournal(sessionId);
    const receipt = await verifiedDurableBrowserAnswerReceiptFromError(error);
    let authorityPersisted = publicationJournal !== null;
    if (!publicationJournal) {
      try {
        await sessionStore.updateSession(sessionId, {
          browser: { ...metadata.browser, runtime: authoritativeRuntime },
          ...(receipt
            ? { artifacts: appendArtifacts(metadata.artifacts, [receipt.artifact]) }
            : {}),
        });
        authorityPersisted = true;
      } catch (authorityError) {
        console.log(
          chalk.red(
            `Reattach cleanup authority could not be persisted: ${sanitizeBrowserPublicationMessage(formatError(authorityError))}`,
          ),
        );
      }
    }
    const message = sanitizeBrowserPublicationMessage(formatError(error));
    console.log(
      chalk.red(
        answerPublished
          ? `Reattach completed, but cleanup state persistence failed: ${message}`
          : publicationJournal
            ? `Reattach publication remains recoverable and pending: ${message}`
            : `Reattach failed: ${message}`,
      ),
    );
    if (completedDeepResearchPlaceholder && !answerPublished && !publicationJournal) {
      const failureMessage = `Deep Research capture incomplete: ${message}`;
      if (metadata.model) {
        await sessionStore.updateModelRun(metadata.id, metadata.model, {
          status: "error",
          response: { status: "incomplete", incompleteReason: "incomplete-capture" },
          error: {
            category: "browser-automation",
            message: failureMessage,
          },
        });
      }
      await sessionStore.updateSession(sessionId, {
        status: "error",
        errorMessage: failureMessage,
        response: { status: "incomplete", incompleteReason: "incomplete-capture" },
        error: {
          category: "browser-automation",
          message: failureMessage,
        },
      });
      metadata = (await sessionStore.readSession(sessionId)) ?? metadata;
    }
    if (!authorityPersisted) throw error;
    return metadata;
  }
}

async function recoverDurableBrowserPublication(
  sessionId: string,
  metadata: SessionMetadata,
  journal: BrowserCapturePublicationJournal,
  answer: string,
): Promise<SessionMetadata> {
  console.log(chalk.yellow("Recovering a durable browser answer publication..."));
  const acknowledgement = createBrowserCapturePublicationAcknowledgement();
  if (journal.phase === "published" || journal.phase === "cleanup-pending") {
    acknowledgement.acknowledge();
  }
  const persistedTransaction = createPersistedBrowserPublicationTransaction(
    sessionId,
    metadata,
    journal,
    acknowledgement,
  );
  const outputTokens = estimateTokenCount(answer);
  const publication = await publishCompletedBrowserCapture({
    answer: {
      sessionId,
      answer,
      logHeader: "[reattach] recovered durable assistant response without browser recapture",
    },
    transaction: persistedTransaction.transaction,
    persistAnswer: persistDurableBrowserAnswer,
    browser: metadata.browser ?? journal.browserAudit,
    existingArtifacts: metadata.artifacts,
    prepareArtifacts: async () => saveReattachBrowserArtifacts(sessionId, metadata, answer),
    usage: journal.usage ?? {
      inputTokens: 0,
      outputTokens,
      reasoningTokens: 0,
      totalTokens: outputTokens,
    },
    response: journal.response ?? { status: "completed" },
    model: journal.model ?? metadata.model,
    acknowledgement,
    label: "Recovered browser answer",
    log: (message) => console.log(dim(message)),
    finalizationPersistence: persistedTransaction.finalizationPersistence,
  });
  if (publication.finalization.status === "pending") {
    console.log(
      chalk.yellow(
        `Durable browser answer is published; cleanup remains pending: ${sanitizeBrowserPublicationMessage(publication.finalization.error)}`,
      ),
    );
  } else {
    console.log(chalk.green("Durable browser answer publication recovered."));
  }
  return (await sessionStore.readSession(sessionId)) ?? metadata;
}

function createPersistedBrowserPublicationTransaction(
  sessionId: string,
  metadata: SessionMetadata,
  journal: BrowserCapturePublicationJournal,
  acknowledgement: BrowserCapturePublicationAcknowledgement,
): {
  transaction: Pick<BrowserRunTransaction, "runtime" | "bindSettlement" | "finalize" | "abort"> & {
    releaseSettlementLock: () => Promise<void>;
  };
  finalizationPersistence: () =>
    | { status: "persisted" }
    | { status: "pending"; error: string }
    | undefined;
} {
  let finalizationPersistence:
    | { status: "persisted" }
    | { status: "pending"; error: string }
    | undefined;
  let recoveryLock: ReattachRecoveryLock | null = null;
  let currentJournal: BrowserCapturePublicationJournal | null = journal;
  const ensureRecoveryLock = async (): Promise<void> => {
    if (recoveryLock) return;
    const sessionPaths = await sessionStore.getPaths(sessionId);
    recoveryLock = await acquireReattachRecoveryLock(
      path.join(sessionPaths.dir, "browser-recovery.lock"),
    );
  };
  const releaseRecoveryLock = async (finalize?: () => Promise<void>): Promise<void> => {
    const heldLock = recoveryLock;
    if (!heldLock) {
      await finalize?.();
      return;
    }
    await heldLock.release(finalize);
    if (recoveryLock === heldLock) recoveryLock = null;
  };
  const loadCurrentRuntime = async (): Promise<BrowserRuntimeMetadata> => {
    currentJournal = await readBrowserCapturePublicationJournal(sessionId);
    if (!currentJournal) {
      const currentSession = await sessionStore.readSession(sessionId);
      return currentSession?.browser?.runtime ?? journal.runtime;
    }
    if (
      currentJournal.receipt.artifact.path !== journal.receipt.artifact.path ||
      currentJournal.receipt.artifact.sha256 !== journal.receipt.artifact.sha256 ||
      currentJournal.receipt.artifact.sizeBytes !== journal.receipt.artifact.sizeBytes
    ) {
      throw new Error("Browser publication authority changed while recovery was queued");
    }
    return currentJournal.runtime;
  };
  const settlement = new OwnedBrowserResourceTransaction(
    {
      persistRuntime: async (proposedRuntime) => {
        await ensureRecoveryLock();
        try {
          const authoritativeBoundRuntime = bindCurrentBrowserRecoveryRuntime(
            proposedRuntime,
            await loadCurrentRuntime(),
          );
          await sessionStore.updateSession(sessionId, {
            browser: {
              ...(metadata.browser ?? journal.browserAudit),
              runtime: authoritativeBoundRuntime,
            },
          });
          return authoritativeBoundRuntime;
        } catch (error) {
          await releaseRecoveryLock().catch(() => undefined);
          throw error;
        }
      },
      settleResources: async (mode, runtime) => {
        currentJournal = journal;
        const persistProjection = async (
          result: BrowserCaptureFinalizationResult,
          beforeRuntime: BrowserRuntimeMetadata,
        ): Promise<BrowserCaptureFinalizationResult> => {
          const expectedJournal = currentJournal;
          if (!expectedJournal) {
            throw new Error("Browser finalization journal is unavailable");
          }
          for (let attempt = 0; ; attempt += 1) {
            try {
              return await persistBrowserCaptureFinalizationState(
                sessionId,
                metadata.browser ?? expectedJournal.browserAudit,
                expectedJournal,
                result,
                beforeRuntime,
                { acknowledgeCapabilities: false },
              );
            } catch (error) {
              if (attempt >= 1) throw error;
            }
          }
        };
        const outcome = await settleBrowserRecoveryCleanup(
          runtime,
          browserLogger(),
          {
            recoveryCleanup: { retainChromeEndpointAuthority },
            isRemotePublicationAcknowledged: acknowledgement.isPublished,
            acquireRecoveryLock: async () => {
              await ensureRecoveryLock();
              return { release: releaseRecoveryLock };
            },
            loadRuntimeUnderLock: loadCurrentRuntime,
            persistFinalizationResult: persistProjection,
            completeFinalizationAfterLockRelease: persistProjection,
          },
          mode,
        );
        finalizationPersistence =
          outcome.persistence.status === "persisted"
            ? { status: "persisted" }
            : {
                status: "pending",
                error: sanitizeBrowserPublicationMessage(outcome.persistence.error),
              };
        return outcome.finalization;
      },
    },
    journal.runtime,
  );
  return {
    transaction: {
      get runtime() {
        return settlement.runtime();
      },
      bindSettlement: (mode) => settlement.bindSettlement(mode),
      releaseSettlementLock: () => releaseRecoveryLock(),
      finalize: () => settlement.settle("finalize"),
      abort: () => settlement.settle("abort"),
    },
    finalizationPersistence: () => finalizationPersistence,
  };
}

function repairTrustedStaleConversationUrl(
  runtime: BrowserRuntimeMetadata | undefined,
): BrowserRuntimeMetadata | undefined {
  const candidate = runtime?.tabUrl?.trim();
  if (!runtime || !candidate || isRecoverableChatGptConversationUrl(candidate)) return runtime;
  let shellUrl: URL;
  try {
    shellUrl = new URL(candidate);
  } catch {
    return runtime;
  }
  if (
    shellUrl.protocol !== "https:" ||
    shellUrl.port ||
    (shellUrl.hostname !== "chatgpt.com" && shellUrl.hostname !== "chat.openai.com")
  ) {
    return runtime;
  }
  if (/\/c(?:\/|$)/u.test(shellUrl.pathname)) return runtime;
  const locator = resolveCommittedPromptEpochLocator({ ...runtime, tabUrl: undefined });
  if (!locator || locator.epoch.remainingFollowUps > 0) return runtime;
  return {
    ...runtime,
    conversationId: locator.conversationId,
    tabUrl: `${shellUrl.origin}/c/${locator.conversationId}`,
  };
}

function isDeepResearchBrowserSession(metadata: SessionMetadata): boolean {
  return metadata.mode === "browser" && metadata.browser?.config?.researchMode === "deep";
}

export function isDeepResearchToolCallPlaceholder(
  answerText: string,
  outputTokens?: number,
): boolean {
  const lines = answerText
    .toLowerCase()
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!lines[0] || !DEEP_RESEARCH_TOOL_CALL_MARKERS.includes(lines[0])) return false;
  if (lines.length === 1) return outputTokens == null || outputTokens <= 8;
  const wrapper = lines.slice(1).join(" ");
  const structuralSignals = [
    wrapper.includes("deep research app"),
    /\bcall tool\b/.test(wrapper),
    /\brequest\s*\{/.test(wrapper),
    /\bresponse\s*\{/.test(wrapper),
    /\bsession[_ ]id\b/.test(wrapper),
  ].filter(Boolean).length;
  return wrapper.includes("deep research app") && structuralSignals >= 2;
}

async function saveReattachBrowserArtifacts(
  sessionId: string,
  metadata: SessionMetadata,
  body: string,
): Promise<SessionMetadata["artifacts"]> {
  const conversationUrl = metadata.browser?.runtime?.tabUrl;
  const logger = browserLogger();
  const reportArtifact = isDeepResearchBrowserSession(metadata)
    ? await saveDeepResearchReportArtifact({
        sessionId,
        reportMarkdown: body,
        conversationUrl,
        logger,
      }).catch(() => null)
    : null;
  const prompt = (await readStoredPrompt(sessionId)) ?? metadata.promptPreview ?? "";
  const transcriptArtifact = await saveBrowserTranscriptArtifact({
    sessionId,
    prompt,
    answerMarkdown: body,
    conversationUrl,
    artifacts: appendArtifacts(undefined, [reportArtifact]),
    logger,
  }).catch(() => null);
  return appendArtifacts(metadata.artifacts, [reportArtifact, transcriptArtifact]);
}

function hasDurableBrowserAnswerReceipt(
  metadata: SessionMetadata,
  expected?: DurableBrowserAnswerReceipt,
): boolean {
  return Boolean(
    metadata.artifacts?.some(
      (artifact) =>
        artifact.kind === "transcript" &&
        artifact.label === "Durable browser answer" &&
        typeof artifact.sha256 === "string" &&
        artifact.sha256.length === 64 &&
        typeof artifact.sizeBytes === "number" &&
        (!expected ||
          (artifact.path === expected.artifact.path &&
            artifact.sha256 === expected.artifact.sha256 &&
            artifact.sizeBytes === expected.artifact.sizeBytes)),
    ),
  );
}

function browserLogger(): BrowserLogger {
  const logger: BrowserLogger = (message?: string) => {
    if (message) console.log(dim(message));
  };
  logger.verbose = true;
  return logger;
}

function readBooleanErrorDetail(metadata: SessionMetadata, key: string): boolean | undefined {
  const details = metadata.error?.details;
  if (!details || typeof details !== "object" || !(key in details)) return undefined;
  return typeof details[key] === "boolean" ? details[key] : undefined;
}

async function readStoredPrompt(sessionId: string): Promise<string | null> {
  const request = await sessionStore.readRequest(sessionId);
  if (request?.prompt && request.prompt.trim().length > 0) return request.prompt;
  const metadata = await sessionStore.readSession(sessionId);
  if (metadata?.options?.prompt && metadata.options.prompt.trim().length > 0) {
    return metadata.options.prompt;
  }
  return null;
}

function trimBeforeFirstAnswer(logText: string): string {
  const answerIndex = logText.search(/(?:^|\n)Answer:\s*/);
  return answerIndex >= 0 ? logText.slice(answerIndex).replace(/^\n/, "") : logText;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
