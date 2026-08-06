import kleur from "kleur";
import path from "node:path";
import type { RunOracleOptions } from "../oracle.js";
import { asOracleUserError } from "../oracle.js";
import { ensureSessionArtifacts } from "../browser/sessionRunner.js";
import { resumeBrowserSession, type ReattachResult } from "../browser/reattach.js";
import { appendArtifacts } from "../browser/artifacts.js";
import { estimateTokenCount } from "../browser/utils.js";
import type { BrowserLogger } from "../browser/types.js";
import type {
  BrowserRuntimeMetadata,
  BrowserSessionConfig,
  SessionMetadata,
} from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";
import { wait } from "../sessionManager.js";
import { formatElapsed } from "../oracle/format.js";
import {
  BrowserPublicationTransaction,
  persistDurableBrowserAnswer,
  publishCompletedBrowserCapture,
  runtimeFromBrowserError,
  verifiedDurableBrowserAnswerReceiptFromError,
} from "./durableAnswer.js";
import {
  hasResumableBrowserAuthority,
  MonotonicBrowserRuntimeAuthority,
} from "./browserRuntimeAuthority.js";
import { sendSessionNotification, type NotificationSettings } from "./notifier.js";
import { formatError } from "./errorUtils.js";
import { persistBrowserSessionOutcome } from "./browserSessionOutcome.js";

const isTty = process.stdout.isTTY;
const dim = (text: string): string => (isTty ? kleur.dim(text) : text);

export type AutoReattachOutcome = {
  outcome: "completed" | "terminal" | "exhausted";
  runtime?: BrowserRuntimeMetadata;
};

export interface AutoReattachControllerOptions {
  sessionMeta: SessionMetadata;
  runtime?: BrowserRuntimeMetadata;
  browserConfig?: BrowserSessionConfig;
  browserMetadata?: SessionMetadata["browser"];
  runOptions: RunOracleOptions;
  modelForStatus?: string;
  notificationSettings: NotificationSettings;
  log: (message?: string) => void;
  writeAssistantOutput: (
    targetPath: string | undefined,
    content: string,
    log: (message: string) => void,
  ) => Promise<unknown>;
  maxAttempts?: number;
}

export async function autoReattachUntilComplete({
  sessionMeta,
  runtime,
  browserConfig,
  browserMetadata,
  runOptions,
  modelForStatus,
  notificationSettings,
  log,
  writeAssistantOutput,
  maxAttempts,
}: AutoReattachControllerOptions): Promise<AutoReattachOutcome> {
  if (!runtime || !browserConfig) {
    log(dim("Auto-reattach disabled: missing runtime or browser config."));
    return { outcome: "exhausted" };
  }
  const delayMs = Math.max(0, browserConfig.autoReattachDelayMs ?? 0);
  const intervalMs = Math.max(0, browserConfig.autoReattachIntervalMs ?? 0);
  if (intervalMs <= 0) {
    return { outcome: "exhausted", runtime };
  }
  const timeoutMs =
    Math.max(0, browserConfig.autoReattachTimeoutMs ?? 0) ||
    Math.max(0, browserConfig.timeoutMs ?? 0) ||
    120_000;
  const maxTotalMs = 2 * 60 * 60 * 1000;
  const maxDeadline = Date.now() + maxTotalMs;
  const attemptLimit =
    typeof maxAttempts === "number" && maxAttempts > 0
      ? Math.floor(maxAttempts)
      : Number.POSITIVE_INFINITY;

  if (delayMs > 0) {
    log(dim(`Auto-reattach starting in ${formatElapsed(delayMs)}...`));
    await wait(delayMs);
  }
  if (Number.isFinite(attemptLimit)) {
    log(dim(`Auto-reattach will try up to ${attemptLimit} attempt(s).`));
  } else {
    log(
      dim(`Auto-reattach will stop after ${formatElapsed(maxTotalMs)} if no answer is captured.`),
    );
  }

  const logger: BrowserLogger = ((message?: string) => {
    if (message) log(dim(message));
  }) as BrowserLogger;
  logger.verbose = true;
  const recoveryLockPath = path.join(
    (await sessionStore.getPaths(sessionMeta.id)).dir,
    "browser-recovery.lock",
  );
  let retryRuntime = runtime;
  const runtimeAuthority = new MonotonicBrowserRuntimeAuthority(runtime);
  const publication = new BrowserPublicationTransaction();

  let attempt = 0;
  for (;;) {
    const remainingBudgetMs = maxDeadline - Date.now();
    if (remainingBudgetMs <= 0) {
      log(
        dim(
          `Auto-reattach stopped after ${formatElapsed(maxTotalMs)} without capturing an answer.`,
        ),
      );
      return { outcome: "exhausted", runtime: retryRuntime };
    }
    attempt += 1;
    log(dim(`Auto-reattach attempt ${attempt}...`));
    let captureSucceeded = false;
    let durablyCompleted = false;
    let authoritativeRuntime = retryRuntime;
    let publicationBrowser = {
      ...browserMetadata,
      config: browserConfig,
      runtime: authoritativeRuntime,
    };
    try {
      const reattachConfig: BrowserSessionConfig = { ...browserConfig, timeoutMs };
      const reattachResult: ReattachResult = await resumeBrowserSession(
        retryRuntime,
        reattachConfig,
        logger,
        {
          sessionId: sessionMeta.id,
          recoveryLockPath,
          acquireRecoveryLock: publication.acquireRecoveryLock,
          isRemotePublicationAcknowledged: publication.isRemotePublicationAcknowledged,
          runtimeHintCb: async (latestRuntime) => {
            const persistedRuntime = runtimeAuthority.observeHint(latestRuntime);
            authoritativeRuntime = persistedRuntime;
            retryRuntime = persistedRuntime;
            publicationBrowser = { ...publicationBrowser, runtime: persistedRuntime };
            await sessionStore.updateSession(sessionMeta.id, {
              browser: publicationBrowser,
            });
          },
        },
      );
      captureSucceeded = true;
      authoritativeRuntime = runtimeAuthority.observeHint(reattachResult.runtime);
      retryRuntime = authoritativeRuntime;
      const recoveredArtifacts = appendArtifacts(
        appendArtifacts(sessionMeta.artifacts, reattachResult.artifacts ?? []),
        [...(reattachResult.savedImages ?? []), ...(reattachResult.savedFiles ?? [])],
      );
      const answerText = reattachResult.answerMarkdown || reattachResult.answerText || "";
      const outputTokens = Number.isSafeInteger(reattachResult.answerTokens)
        ? (reattachResult.answerTokens as number)
        : estimateTokenCount(answerText);
      const usage = {
        inputTokens: 0,
        outputTokens,
        reasoningTokens: 0,
        totalTokens: outputTokens,
      };
      publicationBrowser = {
        ...publicationBrowser,
        runtime: authoritativeRuntime,
        ...(reattachResult.archive ? { archive: reattachResult.archive } : {}),
        ...(reattachResult.modelSelection ? { modelSelection: reattachResult.modelSelection } : {}),
        ...(reattachResult.warnings ? { warnings: reattachResult.warnings } : {}),
      };
      const publishedCapture = await publishCompletedBrowserCapture({
        answer: {
          sessionId: sessionMeta.id,
          answer: answerText,
          logHeader: `[auto-reattach] captured assistant response on attempt ${attempt}`,
        },
        transaction: reattachResult,
        browser: publicationBrowser,
        existingArtifacts: recoveredArtifacts,
        prepareArtifacts: async () =>
          ensureSessionArtifacts({
            sessionId: sessionMeta.id,
            prompt: runOptions.prompt,
            answerMarkdown: answerText,
            conversationUrl: reattachResult.runtime.tabUrl,
            browserConfig,
            existingArtifacts: recoveredArtifacts,
            logger,
          }),
        elapsedMs: reattachResult.tookMs,
        usage,
        response: { status: "completed" },
        model: modelForStatus,
        publication,
        projectRuntime: (latestRuntime) => {
          const persistedRuntime = runtimeAuthority.observeHint(latestRuntime);
          authoritativeRuntime = persistedRuntime;
          retryRuntime = persistedRuntime;
          return persistedRuntime;
        },
        label: "Auto-reattach answer",
        log: (message) => log(dim(message)),
        persistAnswer: persistDurableBrowserAnswer,
      });
      durablyCompleted = true;
      authoritativeRuntime = publishedCapture.finalization.runtime;
      retryRuntime = authoritativeRuntime;
      if (publishedCapture.projection.status === "pending") {
        log(
          kleur.yellow(
            `Auto-reattach answer is durable; terminal session/model projection remains pending: ${publishedCapture.projection.error}`,
          ),
        );
      } else if (publishedCapture.finalization.status === "pending") {
        log(
          kleur.yellow(
            `Auto-reattach completed; browser cleanup remains pending: ${publishedCapture.finalization.error}`,
          ),
        );
      } else if (publishedCapture.finalizationPersistence.status === "pending") {
        log(
          kleur.yellow(
            `Auto-reattach answer is published; cleanup authority projection remains pending: ${publishedCapture.finalizationPersistence.error}`,
          ),
        );
      } else {
        log(kleur.green("Auto-reattach succeeded; session marked completed."));
      }
      await writeAssistantOutput(runOptions.writeOutputPath, answerText, log);
      await sendSessionNotification(
        {
          sessionId: sessionMeta.id,
          sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
          mode: sessionMeta.mode ?? "browser",
          model: sessionMeta.model ?? runOptions.model,
          usage: { inputTokens: 0, outputTokens },
          characters: answerText.length,
        },
        notificationSettings,
        log,
        answerText.slice(0, 140),
      ).catch((error) => {
        log(dim(`Auto-reattach answer published; notification failed: ${formatError(error)}`));
      });
      return { outcome: "completed", runtime: retryRuntime };
    } catch (error) {
      if (durablyCompleted) {
        log(
          dim(
            `Auto-reattach completed, but a post-publication side effect failed: ${formatError(error)}`,
          ),
        );
        return { outcome: "completed", runtime: retryRuntime };
      }
      if (captureSucceeded) {
        const message = formatError(error);
        const userError = asOracleUserError(error);
        const capturedFailureRuntime = runtimeFromBrowserError(error);
        const failureRuntime =
          runtimeAuthority.observeError(capturedFailureRuntime) ?? authoritativeRuntime;
        authoritativeRuntime = failureRuntime;
        retryRuntime = failureRuntime;
        const failureDetails =
          userError?.details && capturedFailureRuntime
            ? { ...userError.details, runtime: failureRuntime }
            : userError?.details;
        const receipt = await verifiedDurableBrowserAnswerReceiptFromError(error);
        const journal = publication.journal ?? (await publication.refresh());
        if (
          receipt &&
          journal &&
          (journal.phase === "finalize-bound" ||
            journal.phase === "published" ||
            journal.phase === "cleanup-pending")
        ) {
          log(
            dim(
              `Auto-reattach answer is durable under FINALIZE authority; publication repair remains pending: ${message}`,
            ),
          );
          return { outcome: "completed", runtime: retryRuntime };
        }
        const response = { status: "error" as const, incompleteReason: "incomplete-capture" };
        const errorMetadata = userError
          ? {
              category: userError.category,
              message: userError.message,
              details: failureDetails,
            }
          : { category: "internal" as const, message };
        await persistBrowserSessionOutcome(sessionMeta.id, {
          kind: "terminal-error",
          browser: publicationBrowser,
          runtime: failureRuntime,
          response,
          reason: message,
          artifacts: receipt
            ? appendArtifacts(sessionMeta.artifacts, [receipt.artifact])
            : sessionMeta.artifacts,
          receipt,
          errorMetadata,
          transportMetadata: undefined,
          modelProjection: modelForStatus
            ? { model: modelForStatus, updates: { response, error: errorMetadata } }
            : undefined,
        });
        throw error;
      }
      const capturedErrorRuntime = runtimeFromBrowserError(error);
      const terminalAutoReattachError = isTerminalAutoReattachError(error);
      const errorRuntime = terminalAutoReattachError
        ? runtimeAuthority.observeTerminal(capturedErrorRuntime)
        : runtimeAuthority.observeError(capturedErrorRuntime);
      if (errorRuntime) {
        authoritativeRuntime = errorRuntime;
        retryRuntime = errorRuntime;
      }
      const cleanupCompletedAfterCapturedError =
        runtimeAuthority.didTerminalCleanupSupersedeError();
      const message = formatError(error);
      const userError = asOracleUserError(error);
      if (
        terminalAutoReattachError ||
        cleanupCompletedAfterCapturedError ||
        retryRuntime.recoveryCleanupResult?.settlementMode !== undefined ||
        (capturedErrorRuntime !== undefined && !hasResumableBrowserAuthority(errorRuntime))
      ) {
        const details = userError?.details as { stage?: string } | undefined;
        const incompleteReason =
          details?.stage === "connection-lost" ? "chrome-disconnected" : "incomplete-capture";
        const terminalDetails =
          userError?.details && capturedErrorRuntime
            ? { ...userError.details, runtime: errorRuntime }
            : userError?.details;
        const terminalError = userError
          ? {
              category: userError.category,
              message: userError.message,
              details: terminalDetails,
            }
          : { category: "internal" as const, message };
        const response = { status: "error" as const, incompleteReason };
        await persistBrowserSessionOutcome(sessionMeta.id, {
          kind: "terminal-error",
          browser: {
            ...browserMetadata,
            config: browserConfig,
            runtime: retryRuntime,
          },
          runtime: retryRuntime,
          response,
          reason: message,
          artifacts: sessionMeta.artifacts,
          receipt: undefined,
          errorMetadata: terminalError,
          transportMetadata: undefined,
          modelProjection: modelForStatus
            ? { model: modelForStatus, updates: { response, error: terminalError } }
            : undefined,
        });
        log(dim(`Auto-reattach stopped on terminal browser outcome: ${message}`));
        return { outcome: "terminal", runtime: retryRuntime };
      }
      if (errorRuntime) {
        await sessionStore.updateSession(sessionMeta.id, {
          browser: {
            ...browserMetadata,
            config: browserConfig,
            runtime: retryRuntime,
          },
        });
      }
      log(dim(`Auto-reattach attempt ${attempt} failed: ${message}`));
    }
    if (attempt >= attemptLimit) {
      log(dim(`Auto-reattach stopped after ${attempt} attempt(s) without capturing an answer.`));
      return { outcome: "exhausted", runtime: retryRuntime };
    }
    const remainingAfterAttemptMs = maxDeadline - Date.now();
    if (remainingAfterAttemptMs <= 0) {
      log(
        dim(
          `Auto-reattach stopped after ${formatElapsed(maxTotalMs)} without capturing an answer.`,
        ),
      );
      return { outcome: "exhausted", runtime: retryRuntime };
    }
    await wait(Math.min(intervalMs, remainingAfterAttemptMs));
  }
}

function isTerminalAutoReattachError(error: unknown): boolean {
  const userError = asOracleUserError(error);
  if (userError?.category !== "browser-automation") return false;
  const details = userError.details as
    | {
        code?: string;
        reattachable?: boolean;
        reattachClassification?: string;
        recoverableDisconnect?: boolean;
      }
    | undefined;
  return (
    details?.recoverableDisconnect === false ||
    details?.reattachable === false ||
    details?.reattachClassification === "explicit-selector-terminal" ||
    details?.code === "committed-prompt-identity-mismatch"
  );
}
