import chalk from "chalk";
import path from "node:path";
import type { BrowserRuntimeMetadata, SessionMetadata } from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";
import type { BrowserCaptureFinalizationResult, BrowserLogger } from "../browser/types.js";
import {
  resumeBrowserSession,
  settleBrowserRecoveryCleanup,
  type ReattachResult,
} from "../browser/reattach.js";
import { retainChromeEndpointAuthority } from "../browser/chromeLifecycle.js";
import { isProcessAlive } from "../browser/profileState.js";
import { acquireReattachRecoveryLock } from "../browser/reattachLock.js";
import {
  hasExactPendingChromeAcquisitionAuthority,
  hasPendingChromeAcquisitionIntent,
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
  BrowserPublicationTransaction,
  persistDurableBrowserAnswer,
  publishCompletedBrowserCapture,
  runtimeFromBrowserError,
  verifiedDurableBrowserAnswerReceiptFromError,
  type DurableBrowserAnswerReceipt,
} from "./durableAnswer.js";
import { sanitizeBrowserPublicationMessage } from "./browserPublicationJournal.js";
import {
  hasBrowserRecoveryAuthority,
  hasRemoteRecoveryAuthority,
  hasResumableBrowserAuthority,
  MonotonicBrowserRuntimeAuthority,
} from "./browserRuntimeAuthority.js";
import { formatError } from "./errorUtils.js";
import { persistBrowserSessionOutcome } from "./browserSessionOutcome.js";

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
  const publication = await BrowserPublicationTransaction.open(sessionId);
  let publicationJournal = publication.journal;
  let runtime = publicationJournal?.runtime ?? metadata.browser?.runtime;
  const controllerPid = runtime?.controllerPid;
  const workerPid = metadata.lifecycle?.workerPid;
  const controllerAlive = typeof controllerPid === "number" && isProcessAlive(controllerPid);
  const workerAlive = typeof workerPid === "number" && isProcessAlive(workerPid);
  const completedRuntime = metadata.browser?.runtime;
  const exactEpochlessAcquisitionAbort =
    metadata.mode === "browser" &&
    (metadata.status === "running" || metadata.status === "error") &&
    !controllerAlive &&
    !workerAlive &&
    hasPendingChromeAcquisitionIntent(completedRuntime) &&
    hasExactPendingChromeAcquisitionAuthority(completedRuntime) &&
    !hasBrowserRecoveryAuthority(completedRuntime, metadata.browser?.config);
  if (
    publicationJournal &&
    publication.isPublished() &&
    metadata.status === "completed" &&
    completedRuntime !== undefined &&
    !completedRuntime.recoveryCleanupResources?.length &&
    !completedRuntime.recoveryCleanupResult &&
    hasDurableBrowserAnswerReceipt(metadata, publicationJournal.receipt)
  ) {
    try {
      await publication.clear();
      publicationJournal = publication.journal;
    } catch (error) {
      console.log(
        chalk.yellow(
          `Completed browser cleanup is durable, but its stale publication journal could not be retired: ${sanitizeBrowserPublicationMessage(formatError(error))}`,
        ),
      );
      return metadata;
    }
  }
  if (await publication.discardAbortedPreparation(metadata.browser?.runtime)) {
    publicationJournal = publication.journal;
  }
  if (exactEpochlessAcquisitionAbort && (await publication.discardPreparationForAbort())) {
    publicationJournal = publication.journal;
  }
  if (publicationJournal && (controllerAlive || workerAlive)) {
    return metadata;
  }
  if (publicationJournal) {
    const durableAnswer = await publication.recoveryAnswer();
    if (durableAnswer.status !== "none") {
      if (durableAnswer.status === "pending") {
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
          publication,
          durableAnswer.answer,
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
  const completedCleanupAcknowledged = publication.hasJournal
    ? publication.isPublished()
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
    !hasBrowserRecoveryAuthority(runtime, metadata.browser?.config);
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
      const browser = { ...metadata.browser, runtime: result.runtime };
      if (staleRunningAcquisitionRecovered) {
        const response = { status: "error" as const, incompleteReason: "incomplete-capture" };
        const errorMetadata = {
          category: "browser-automation" as const,
          message: cleanupMessage,
          details: {
            stage: "browser-acquisition-recovery",
            code:
              result.status === "pending"
                ? "browser-acquisition-cleanup-pending"
                : "browser-acquisition-cleanup-completed",
          },
        };
        await persistBrowserSessionOutcome(sessionId, {
          kind: "terminal-error",
          browser,
          runtime: result.runtime,
          response,
          reason: cleanupMessage,
          artifacts: metadata.artifacts,
          receipt: undefined,
          errorMetadata,
          transportMetadata: undefined,
          modelProjection: metadata.model
            ? { model: metadata.model, updates: { response, error: errorMetadata } }
            : undefined,
        });
      } else {
        await sessionStore.updateSession(sessionId, { browser });
      }
      return result;
    };
    try {
      const sessionPaths = await sessionStore.getPaths(sessionId);
      const outcome = await settleBrowserRecoveryCleanup(
        runtime,
        cleanupLogger,
        {
          ownerId: sessionId,
          recoveryLockPath: path.join(sessionPaths.dir, "browser-recovery.lock"),
          recoveryCleanup: { retainChromeEndpointAuthority },
          isRemotePublicationAcknowledged: () =>
            completedCleanupAcknowledged && cleanupRetryMode === "finalize",
          loadRuntimeUnderLock: async () => {
            if (await publication.refresh()) {
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

  publicationJournal = await publication.refresh();
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
    hasResumableBrowserAuthority(runtime, metadata.browser?.config);
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

  const runtimeAuthority = new MonotonicBrowserRuntimeAuthority(runtime, metadata.browser?.config);
  let authoritativeRuntime = runtime;
  let answerPublished = false;

  try {
    const existingPublicationBrowser = metadata.browser ?? publication.journal?.browserAudit;
    if (!existingPublicationBrowser) throw new Error("Browser publication metadata is unavailable");
    let publicationBrowser = existingPublicationBrowser;
    const sessionPaths = await sessionStore.getPaths(sessionId);
    const reattachResult: ReattachResult = await resumeBrowserSession(
      authoritativeRuntime,
      metadata.browser?.config,
      browserLogger(),
      {
        sessionId,
        recoveryLockPath: path.join(sessionPaths.dir, "browser-recovery.lock"),
        acquireRecoveryLock: publication.acquireRecoveryLock,
        isRemotePublicationAcknowledged: publication.isRemotePublicationAcknowledged,
        runtimeHintCb: async (latestRuntime) => {
          authoritativeRuntime = runtimeAuthority.observeHint(latestRuntime);
          if (!publication.hasJournal) {
            publicationBrowser = { ...publicationBrowser, runtime: authoritativeRuntime };
            await sessionStore.updateSession(sessionId, {
              browser: publicationBrowser,
            });
          }
        },
        loadRuntimeUnderLock: () => publication.loadCurrentRuntime(authoritativeRuntime),
        persistFinalizationResult: (result, beforeRuntime, mode) =>
          publication.persistFinalization(publicationBrowser, result, beforeRuntime, mode, false, {
            acknowledgeCapabilities: false,
          }),
        completeFinalizationAfterLockRelease: (result, beforeRuntime, mode) =>
          publication.persistFinalization(publicationBrowser, result, beforeRuntime, mode, true, {
            acknowledgeCapabilities: false,
          }),
      },
    );
    authoritativeRuntime = runtimeAuthority.observeHint(reattachResult.runtime);
    publicationBrowser = {
      ...publicationBrowser,
      runtime: authoritativeRuntime,
      ...(reattachResult.archive ? { archive: reattachResult.archive } : {}),
      ...(reattachResult.modelSelection ? { modelSelection: reattachResult.modelSelection } : {}),
      ...(reattachResult.warnings ? { warnings: reattachResult.warnings } : {}),
    };
    const recoveredArtifacts = appendArtifacts(
      appendArtifacts(metadata.artifacts, reattachResult.artifacts ?? []),
      [...(reattachResult.savedImages ?? []), ...(reattachResult.savedFiles ?? [])],
    );
    const capturedAnswer = reattachResult.answerMarkdown || reattachResult.answerText;
    const answerText = await publication.preferDurablePreparingAnswer(capturedAnswer);
    const outputTokens = Number.isSafeInteger(reattachResult.answerTokens)
      ? (reattachResult.answerTokens as number)
      : estimateTokenCount(answerText);
    const usage = publicationJournal?.usage ?? {
      inputTokens: 0,
      outputTokens,
      reasoningTokens: 0,
      totalTokens: outputTokens,
    };
    const publishedCapture = await publishCompletedBrowserCapture({
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
      browser: publicationBrowser,
      existingArtifacts: recoveredArtifacts,
      prepareArtifacts: async () =>
        saveReattachBrowserArtifacts(
          sessionId,
          { ...metadata, browser: publicationBrowser },
          answerText,
          recoveredArtifacts,
        ),
      elapsedMs: reattachResult.tookMs,
      usage,
      response: { status: "completed" },
      model: metadata.model,
      publication,
      projectRuntime: (latestRuntime) => {
        authoritativeRuntime = runtimeAuthority.observeHint(latestRuntime);
        return authoritativeRuntime;
      },
      label: "Reattach answer",
      log: (message) => console.log(dim(message)),
    });
    answerPublished = true;
    authoritativeRuntime = publishedCapture.finalization.runtime;
    if (publishedCapture.projection.status === "pending") {
      console.log(
        chalk.yellow(
          `Reattach answer is durable; terminal session/model projection remains pending: ${sanitizeBrowserPublicationMessage(publishedCapture.projection.error)}`,
        ),
      );
    } else if (publishedCapture.finalization.status === "pending") {
      console.log(
        chalk.yellow(
          `Reattach completed; browser cleanup remains pending: ${sanitizeBrowserPublicationMessage(publishedCapture.finalization.error)}`,
        ),
      );
    } else if (publishedCapture.finalizationPersistence.status === "pending") {
      console.log(
        chalk.yellow(
          `Reattach answer is published; cleanup authority projection remains pending: ${sanitizeBrowserPublicationMessage(publishedCapture.finalizationPersistence.error)}`,
        ),
      );
    } else {
      console.log(chalk.green("Reattach succeeded; session marked completed."));
    }
    return (await sessionStore.readSession(sessionId)) ?? metadata;
  } catch (error) {
    authoritativeRuntime =
      runtimeAuthority.observeError(runtimeFromBrowserError(error)) ?? authoritativeRuntime;
    publicationJournal = await publication.refresh();
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
      const response = { status: "incomplete" as const, incompleteReason: "incomplete-capture" };
      const errorMetadata = {
        category: "browser-automation" as const,
        message: failureMessage,
      };
      await persistBrowserSessionOutcome(sessionId, {
        kind: "terminal-error",
        browser: { ...metadata.browser, runtime: authoritativeRuntime },
        runtime: authoritativeRuntime,
        response,
        reason: failureMessage,
        artifacts: receipt
          ? appendArtifacts(metadata.artifacts, [receipt.artifact])
          : metadata.artifacts,
        receipt,
        errorMetadata,
        transportMetadata: undefined,
        modelProjection: metadata.model
          ? { model: metadata.model, updates: { response, error: errorMetadata } }
          : undefined,
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
  publication: BrowserPublicationTransaction,
  answer: string,
): Promise<SessionMetadata> {
  console.log(chalk.yellow("Recovering a durable browser answer publication..."));
  const journal = publication.journal;
  if (!journal) throw new Error("Browser publication journal is unavailable");
  const browser = metadata.browser ?? journal.browserAudit;
  const transaction = publication.createPersistedRecoveryTransaction(browser, browserLogger(), {
    acquireRecoveryLock: acquireReattachRecoveryLock,
    settleRecoveryCleanup: settleBrowserRecoveryCleanup,
  });
  const outputTokens = estimateTokenCount(answer);
  const publishedCapture = await publishCompletedBrowserCapture({
    answer: {
      sessionId,
      answer,
      logHeader: "[reattach] recovered durable assistant response without browser recapture",
    },
    transaction,
    persistAnswer: persistDurableBrowserAnswer,
    browser,
    existingArtifacts: metadata.artifacts,
    prepareArtifacts: async () =>
      saveReattachBrowserArtifacts(sessionId, metadata, answer, metadata.artifacts),
    usage: journal.usage ?? {
      inputTokens: 0,
      outputTokens,
      reasoningTokens: 0,
      totalTokens: outputTokens,
    },
    response: journal.response ?? { status: "completed" },
    model: journal.model ?? metadata.model,
    publication,
    label: "Recovered browser answer",
    log: (message) => console.log(dim(message)),
  });
  if (publishedCapture.projection.status === "pending") {
    console.log(
      chalk.yellow(
        `Durable browser answer remains retryable until terminal session/model projection is repaired: ${sanitizeBrowserPublicationMessage(publishedCapture.projection.error)}`,
      ),
    );
  } else if (publishedCapture.finalization.status === "pending") {
    console.log(
      chalk.yellow(
        `Durable browser answer is published; cleanup remains pending: ${sanitizeBrowserPublicationMessage(publishedCapture.finalization.error)}`,
      ),
    );
  } else if (publishedCapture.finalizationPersistence.status === "pending") {
    console.log(
      chalk.yellow(
        `Durable browser answer is published; cleanup authority projection remains pending: ${sanitizeBrowserPublicationMessage(publishedCapture.finalizationPersistence.error)}`,
      ),
    );
  } else {
    console.log(chalk.green("Durable browser answer publication recovered."));
  }
  return (await sessionStore.readSession(sessionId)) ?? metadata;
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
  existingArtifacts: SessionMetadata["artifacts"],
): Promise<SessionMetadata["artifacts"]> {
  const conversationUrl = metadata.browser?.runtime?.tabUrl;
  const logger = browserLogger();
  const hasReport = existingArtifacts?.some((artifact) => artifact.kind === "deep-research-report");
  const reportArtifact =
    isDeepResearchBrowserSession(metadata) && !hasReport
      ? await saveDeepResearchReportArtifact({
          sessionId,
          reportMarkdown: body,
          conversationUrl,
          logger,
        }).catch(() => null)
      : null;
  const prompt = (await readStoredPrompt(sessionId)) ?? metadata.promptPreview ?? "";
  const artifactsWithReport = appendArtifacts(existingArtifacts, [reportArtifact]);
  const hasTranscript = artifactsWithReport?.some((artifact) => artifact.kind === "transcript");
  const transcriptArtifact = hasTranscript
    ? null
    : await saveBrowserTranscriptArtifact({
        sessionId,
        prompt,
        answerMarkdown: body,
        conversationUrl,
        artifacts: artifactsWithReport,
        logger,
      }).catch(() => null);
  return appendArtifacts(artifactsWithReport, [transcriptArtifact]);
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
