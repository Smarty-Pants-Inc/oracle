import chalk from "chalk";
import path from "node:path";
import type { BrowserRuntimeMetadata, SessionMetadata } from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";
import type { BrowserLogger } from "../browser/types.js";
import {
  resumeBrowserSession,
  retryBrowserRecoveryCleanup,
  type ReattachResult,
} from "../browser/reattach.js";
import { retainChromeEndpointAuthority } from "../browser/chromeLifecycle.js";
import { isProcessAlive } from "../browser/profileState.js";
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
  durableBrowserAnswerReceiptFromError,
  persistDurableBrowserAnswer,
  publishCompletedBrowserCapture,
  readDurableBrowserAnswer,
  runtimeFromBrowserError,
  type DurableBrowserAnswerReceipt,
} from "./durableAnswer.js";
import {
  clearBrowserCapturePublicationJournal,
  readBrowserCapturePublicationJournal,
  sanitizeBrowserPublicationMessage,
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
  if (
    publicationJournal?.phase === "preparing" &&
    metadata.browser?.runtime?.recoveryCleanupResult?.settlementMode === "abort" &&
    hasDurableBrowserAnswerReceipt(metadata, publicationJournal.receipt)
  ) {
    await clearBrowserCapturePublicationJournal(sessionId);
    publicationJournal = null;
  }
  let runtime = publicationJournal?.runtime ?? metadata.browser?.runtime;
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

  const controllerPid = runtime?.controllerPid;
  const workerPid = metadata.lifecycle?.workerPid;
  const controllerAlive = typeof controllerPid === "number" && isProcessAlive(controllerPid);
  const workerAlive = typeof workerPid === "number" && isProcessAlive(workerPid);
  const persistedCleanupMode = runtime?.recoveryCleanupResult?.settlementMode;
  const publicationRecoveryPending = publicationJournal !== null;
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
  if (!cleanupRetryMode && !malformedAcquisitionOnlyCleanup) {
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
    try {
      const sessionPaths = await sessionStore.getPaths(sessionId);
      const cleanup = await retryBrowserRecoveryCleanup(
        runtime,
        cleanupLogger,
        {
          recoveryLockPath: path.join(sessionPaths.dir, "browser-recovery.lock"),
          recoveryCleanup: { retainChromeEndpointAuthority },
          isRemotePublicationAcknowledged: () =>
            completedCleanupAcknowledged && cleanupRetryMode === "finalize",
        },
        cleanupRetryMode,
      );
      const staleRunningAcquisitionRecovered =
        automaticAcquisitionCleanupMode !== null && metadata.status === "running";
      const cleanupMessage = sanitizeBrowserPublicationMessage(
        cleanup.status === "pending"
          ? `Browser acquisition cleanup remains pending: ${cleanup.error}`
          : "Browser session stopped before committing a prompt; acquisition cleanup completed.",
      );
      const updates: Partial<SessionMetadata> = {
        browser: { ...metadata.browser, runtime: cleanup.runtime },
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
                    cleanup.status === "pending"
                      ? "browser-acquisition-cleanup-pending"
                      : "browser-acquisition-cleanup-completed",
                },
              },
            }
          : {}),
      };
      await sessionStore.updateSession(sessionId, updates);
      metadata = (await sessionStore.readSession(sessionId)) ?? { ...metadata, ...updates };
      runtime = metadata.browser?.runtime;
      if (cleanup.status === "pending") {
        console.log(chalk.yellow(cleanupMessage));
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
    const receipt = durableBrowserAnswerReceiptFromError(error);
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
