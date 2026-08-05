import kleur from "kleur";
import path from "node:path";
import type { RunOracleOptions } from "../oracle.js";
import { asOracleUserError } from "../oracle.js";
import { ensureSessionArtifacts } from "../browser/sessionRunner.js";
import { resumeBrowserSession, type ReattachResult } from "../browser/reattach.js";
import { estimateTokenCount } from "../browser/utils.js";
import type { BrowserLogger } from "../browser/types.js";
import type {
  BrowserRuntimeMetadata,
  BrowserSessionConfig,
  SessionArtifact,
  SessionMetadata,
} from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";
import { wait } from "../sessionManager.js";
import { formatElapsed } from "../oracle/format.js";
import {
  createBrowserCapturePublicationAcknowledgement,
  durableBrowserAnswerReceiptFromError,
  persistDurableBrowserAnswer,
  publishCompletedBrowserCapture,
  runtimeFromBrowserError,
} from "./durableAnswer.js";
import {
  hasResumableBrowserAuthority,
  MonotonicBrowserRuntimeAuthority,
} from "./browserRuntimeAuthority.js";
import { sendSessionNotification, type NotificationSettings } from "./notifier.js";

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
    try {
      const acknowledgement = createBrowserCapturePublicationAcknowledgement();
      const reattachConfig: BrowserSessionConfig = { ...browserConfig, timeoutMs };
      const reattachResult: ReattachResult = await resumeBrowserSession(
        retryRuntime,
        reattachConfig,
        logger,
        {
          recoveryLockPath,
          isRemotePublicationAcknowledged: acknowledgement.isPublished,
          runtimeHintCb: async (latestRuntime) => {
            const persistedRuntime = runtimeAuthority.observeHint(latestRuntime);
            authoritativeRuntime = persistedRuntime;
            retryRuntime = persistedRuntime;
            await sessionStore.updateSession(sessionMeta.id, {
              browser: {
                ...browserMetadata,
                config: browserConfig,
                runtime: persistedRuntime,
              },
            });
          },
        },
      );
      captureSucceeded = true;
      authoritativeRuntime = runtimeAuthority.observeHint(reattachResult.runtime);
      retryRuntime = authoritativeRuntime;
      const answerText = reattachResult.answerMarkdown || reattachResult.answerText || "";
      const outputTokens = estimateTokenCount(answerText);
      const usage = {
        inputTokens: 0,
        outputTokens,
        reasoningTokens: 0,
        totalTokens: outputTokens,
      };
      const publication = await publishCompletedBrowserCapture({
        answer: {
          sessionId: sessionMeta.id,
          answer: answerText,
          logHeader: `[auto-reattach] captured assistant response on attempt ${attempt}`,
        },
        transaction: reattachResult,
        browser: {
          ...browserMetadata,
          config: browserConfig,
          runtime: authoritativeRuntime,
        },
        existingArtifacts: sessionMeta.artifacts,
        prepareArtifacts: async () =>
          ensureSessionArtifacts({
            sessionId: sessionMeta.id,
            prompt: runOptions.prompt,
            answerMarkdown: answerText,
            conversationUrl: reattachResult.runtime.tabUrl,
            browserConfig,
            existingArtifacts: sessionMeta.artifacts,
            logger,
          }),
        usage,
        response: { status: "completed" },
        model: modelForStatus,
        acknowledgement,
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
      authoritativeRuntime = publication.finalization.runtime;
      retryRuntime = authoritativeRuntime;
      if (publication.finalization.status === "pending") {
        log(
          kleur.yellow(
            `Auto-reattach completed; browser cleanup remains pending: ${publication.finalization.error}`,
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
        const receipt = durableBrowserAnswerReceiptFromError(error);
        await sessionStore.updateSession(sessionMeta.id, {
          status: "error",
          completedAt: new Date().toISOString(),
          errorMessage: message,
          browser: {
            ...browserMetadata,
            config: browserConfig,
            runtime: failureRuntime,
          },
          ...(receipt
            ? { artifacts: mergeArtifacts(sessionMeta.artifacts, [receipt.artifact]) }
            : {}),
          response: { status: "error", incompleteReason: "incomplete-capture" },
          error: userError
            ? {
                category: userError.category,
                message: userError.message,
                details: failureDetails,
              }
            : { category: "internal", message },
        });
        if (modelForStatus) {
          await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
            status: "error",
            completedAt: new Date().toISOString(),
          });
        }
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
        await sessionStore.updateSession(sessionMeta.id, {
          status: "error",
          completedAt: new Date().toISOString(),
          errorMessage: message,
          browser: {
            ...browserMetadata,
            config: browserConfig,
            runtime: retryRuntime,
          },
          response: { status: "error", incompleteReason },
          error: terminalError,
        });
        if (modelForStatus) {
          await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
            status: "error",
            completedAt: new Date().toISOString(),
            response: { status: "error", incompleteReason },
            error: terminalError,
          });
        }
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

function mergeArtifacts(
  existing: SessionArtifact[] | undefined,
  additions: SessionArtifact[],
): SessionArtifact[] {
  const merged = new Map<string, SessionArtifact>();
  for (const artifact of existing ?? []) merged.set(`${artifact.kind}:${artifact.path}`, artifact);
  for (const artifact of additions) merged.set(`${artifact.kind}:${artifact.path}`, artifact);
  return Array.from(merged.values());
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
