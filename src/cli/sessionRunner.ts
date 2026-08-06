import kleur from "kleur";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  SessionMetadata,
  SessionMode,
  BrowserSessionConfig,
  BrowserRuntimeMetadata,
  BrowserModelSelectionEvidence,
  SessionArtifact,
  SessionModelRun,
} from "../sessionStore.js";
import type { ProviderFailureContext, RunOracleOptions, UsageSummary } from "../oracle.js";
import {
  runOracle,
  OracleResponseError,
  OracleTransportError,
  extractResponseMetadata,
  asOracleUserError,
  extractTextOutput,
  classifyProviderFailure,
} from "../oracle.js";
import {
  ensureSessionArtifacts,
  runBrowserSessionExecution,
  type BrowserSessionRunnerDeps,
} from "../browser/sessionRunner.js";
import { renderMarkdownAnsi } from "./markdownRenderer.js";
import { formatResponseMetadata, formatTransportMetadata } from "./sessionDisplay.js";
import { formatError, markErrorLogged } from "./errorUtils.js";
import {
  type NotificationSettings,
  sendSessionNotification,
  deriveNotificationSettingsFromMetadata,
} from "./notifier.js";
import { commitSessionModelProjection, sessionStore } from "../sessionStore.js";
import { runMultiModelApiSession, type MultiModelRunSummary } from "../oracle/multiModelRunner.js";
import { MODEL_CONFIGS, DEFAULT_SYSTEM_PROMPT } from "../oracle/config.js";
import { isKnownModel } from "../oracle/modelResolver.js";
import { resolveModelConfig } from "../oracle/modelResolver.js";
import { buildPrompt, buildRequestBody } from "../oracle/request.js";
import { estimateRequestTokens } from "../oracle/tokenEstimate.js";
import { formatTokenEstimate, formatTokenValue } from "../oracle/runUtils.js";
import { formatFinishLine } from "../oracle/finishLine.js";
import { sanitizeOscProgress } from "./oscUtils.js";
import { readFiles } from "../oracle/files.js";
import { cwd as getCwd } from "node:process";
import { settleBrowserRecoveryCleanup } from "../browser/reattach.js";
import {
  hasExactPendingChromeAcquisitionAuthority,
  hasPendingChromeAcquisitionIntent,
  hasRecoverableChatGptConversation,
} from "../browser/reattachability.js";
import type { BrowserCaptureFinalizationResult, BrowserLogger } from "../browser/types.js";
import { retainChromeEndpointAuthority } from "../browser/chromeLifecycle.js";
import { isProcessAlive } from "../browser/profileState.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { formatBrowserReattachGuidance } from "./reattachGuidance.js";
import {
  verifiedDurableBrowserAnswerReceiptFromError,
  persistDurableBrowserAnswer,
  publishCompletedBrowserCapture,
  runtimeFromBrowserError,
  type DurableBrowserAnswerReceipt,
} from "./durableAnswer.js";
import {
  MonotonicBrowserRuntimeAuthority,
  hasBrowserRecoveryAuthority,
  hasRemoteRecoveryAuthority,
  hasResumableBrowserAuthority,
  retryableInitialBrowserRuntime,
} from "./browserRuntimeAuthority.js";
import { autoReattachUntilComplete } from "./autoReattachController.js";
import {
  persistBrowserSessionOutcome,
  type BrowserSessionOutcome,
} from "./browserSessionOutcome.js";
import {
  journalHasFinalizeAuthorityForReceipt,
  readBrowserCapturePublicationJournal,
} from "./browserPublicationJournal.js";

const isTty = process.stdout.isTTY;
const dim = (text: string): string => (isTty ? kleur.dim(text) : text);

export interface SessionRunParams {
  sessionMeta: SessionMetadata;
  runOptions: RunOracleOptions;
  mode: SessionMode;
  browserConfig?: BrowserSessionConfig;
  cwd: string;
  log: (message?: string) => void;
  write: (chunk: string) => boolean;
  version: string;
  notifications?: NotificationSettings;
  browserDeps?: BrowserSessionRunnerDeps;
  muteStdout?: boolean;
}

export async function performSessionRun({
  sessionMeta,
  runOptions,
  mode,
  browserConfig,
  cwd,
  log,
  write,
  version,
  notifications,
  browserDeps,
  muteStdout = false,
}: SessionRunParams): Promise<void> {
  const writeInline = (chunk: string): boolean => {
    // Keep session logs intact while still echoing inline output to the user.
    write(chunk);
    return muteStdout ? true : process.stdout.write(chunk);
  };
  const restartCandidateRuntime = sessionMeta.browser?.runtime;
  const retainedInitialRuntime = browserConfig
    ? retryableInitialBrowserRuntime(restartCandidateRuntime)
    : undefined;
  let currentBrowser: SessionMetadata["browser"] = browserConfig
    ? {
        config: browserConfig,
        ...(retainedInitialRuntime ? { runtime: retainedInitialRuntime } : {}),
      }
    : sessionMeta.browser;
  const runtimeAuthority = new MonotonicBrowserRuntimeAuthority(retainedInitialRuntime);
  await sessionStore.updateSession(sessionMeta.id, {
    status: "running",
    startedAt: new Date().toISOString(),
    mode,
    ...(browserConfig ? { browser: currentBrowser } : {}),
  });
  const notificationSettings =
    notifications ?? deriveNotificationSettingsFromMetadata(sessionMeta, process.env);
  const modelForStatus = runOptions.model ?? sessionMeta.model;
  let durableAnswerReceipt: DurableBrowserAnswerReceipt | undefined;
  let browserPublicationCompleted = false;
  try {
    const restartRuntime = restartCandidateRuntime;
    const restartControllerAlive = restartRuntime?.controllerPid
      ? isProcessAlive(restartRuntime.controllerPid)
      : false;
    const restartWorkerAlive = sessionMeta.lifecycle?.workerPid
      ? isProcessAlive(sessionMeta.lifecycle.workerPid)
      : false;
    const staleRestartLifecycle =
      (sessionMeta.status === "running" || sessionMeta.status === "error") &&
      !restartControllerAlive &&
      !restartWorkerAlive;
    const hasCleanupOnlyRestart =
      mode === "browser" &&
      staleRestartLifecycle &&
      Boolean(
        restartRuntime?.recoveryCleanupResources?.length && restartRuntime.recoveryCleanupResult,
      ) &&
      !hasRemoteRecoveryAuthority(restartRuntime) &&
      !hasRecoverableChatGptConversation(restartRuntime);
    if (hasCleanupOnlyRestart && restartRuntime) {
      if (
        hasPendingChromeAcquisitionIntent(restartRuntime) &&
        !hasExactPendingChromeAcquisitionAuthority(restartRuntime)
      ) {
        throw new BrowserAutomationError(
          "Refusing browser restart because pending Chrome acquisition authority is incomplete or malformed.",
          {
            stage: "browser-acquisition-recovery",
            code: "browser-acquisition-authority-invalid",
            runtime: restartRuntime,
          },
        );
      }
      const recoveryLogger = Object.assign(
        ((message?: string) => {
          if (message) log(dim(message));
        }) as BrowserLogger,
        { verbose: true },
      );
      const sessionPaths = await sessionStore.getPaths(sessionMeta.id);
      const recoveryMode = restartRuntime.recoveryCleanupResult?.settlementMode ?? "abort";
      const persistRecovery = async (result: BrowserCaptureFinalizationResult) => {
        await sessionStore.updateSession(sessionMeta.id, {
          browser: {
            ...currentBrowser,
            ...(browserConfig ? { config: browserConfig } : {}),
            runtime: result.runtime,
          },
        });
        return result;
      };
      const recovery = await settleBrowserRecoveryCleanup(
        restartRuntime,
        recoveryLogger,
        {
          ownerId: sessionMeta.id,
          recoveryLockPath: path.join(sessionPaths.dir, "browser-recovery.lock"),
          recoveryCleanup: { retainChromeEndpointAuthority },
          isRemotePublicationAcknowledged: () => false,
          loadRuntimeUnderLock: async () =>
            (await sessionStore.readSession(sessionMeta.id))?.browser?.runtime ?? restartRuntime,
          persistFinalizationResult: persistRecovery,
          completeFinalizationAfterLockRelease: persistRecovery,
        },
        recoveryMode,
      );
      const recoveryRuntime =
        recovery.persistence.status === "pending"
          ? recovery.persistence.runtime
          : recovery.finalization.runtime;
      const recoveredRuntime = runtimeAuthority.observeTerminal(recoveryRuntime) ?? recoveryRuntime;
      currentBrowser = {
        ...currentBrowser,
        ...(browserConfig ? { config: browserConfig } : {}),
        runtime: recoveredRuntime,
      };
      if (recovery.persistence.status === "pending") {
        throw new BrowserAutomationError(
          `Browser acquisition cleanup remains pending: ${recovery.persistence.error}`,
          {
            stage: "browser-acquisition-recovery",
            code: "browser-acquisition-cleanup-pending",
            runtime: recoveredRuntime,
          },
        );
      }
      if (recovery.finalization.status === "pending") {
        throw new BrowserAutomationError(
          `Browser acquisition cleanup remains pending: ${recovery.finalization.error}`,
          {
            stage: "browser-acquisition-recovery",
            code: "browser-acquisition-cleanup-pending",
            runtime: recoveredRuntime,
          },
        );
      }
    }
    if (mode === "browser") {
      if (!browserConfig) {
        throw new Error("Missing browser configuration for session.");
      }
      if (modelForStatus) {
        await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
          status: "running",
          startedAt: new Date().toISOString(),
        });
      }
      const runnerDeps = {
        ...browserDeps,
        persistRuntimeHint: async (
          runtime: BrowserRuntimeMetadata,
          modelSelection?: BrowserModelSelectionEvidence,
        ) => {
          const authoritativeRuntime = runtimeAuthority.observeHint(runtime);
          const browser = {
            config: browserConfig,
            runtime: authoritativeRuntime,
            ...(modelSelection ? { modelSelection } : {}),
          };
          await sessionStore.updateSession(sessionMeta.id, {
            status: "running",
            browser,
          });
          // Keep this attempt's copy fresh so error paths fall back to the
          // latest persisted browser evidence instead of stale session input.
          currentBrowser = browser;
        },
      };
      const result = await runBrowserSessionExecution(
        {
          runOptions: { ...runOptions, sessionId: runOptions.sessionId ?? sessionMeta.id },
          browserConfig,
          cwd,
          log,
        },
        runnerDeps,
      );
      const resultRuntime = runtimeAuthority.observeHint(result.runtime);
      currentBrowser = {
        config: browserConfig,
        runtime: resultRuntime,
        archive: result.archive,
        modelSelection: result.modelSelection,
        warnings: result.warnings,
      };
      const publication = await publishCompletedBrowserCapture({
        answer: {
          sessionId: sessionMeta.id,
          answer: result.answerText,
        },
        transaction: result,
        browser: currentBrowser ?? {
          config: browserConfig,
          runtime: resultRuntime,
        },
        existingArtifacts: sessionMeta.artifacts,
        prepareArtifacts: async () =>
          ensureSessionArtifacts({
            sessionId: sessionMeta.id,
            prompt: result.promptText ?? runOptions.prompt,
            answerMarkdown: result.answerText,
            conversationUrl: resultRuntime.tabUrl,
            browserConfig,
            existingArtifacts: mergeArtifacts(sessionMeta.artifacts, result.artifacts),
            logger: createBrowserLogger(log),
          }),
        usage: result.usage,
        response: { status: "completed" },
        elapsedMs: result.elapsedMs,
        model: modelForStatus,
        label: "Browser answer",
        log: (message) => log(dim(message)),
        persistAnswer: persistDurableBrowserAnswer,
        projectRuntime: (runtime) => {
          const authoritativeRuntime = runtimeAuthority.observeHint(runtime);
          currentBrowser = {
            ...(currentBrowser ?? { config: browserConfig }),
            config: browserConfig,
            runtime: authoritativeRuntime,
          };
          return authoritativeRuntime;
        },
      });

      durableAnswerReceipt = publication.receipt;
      currentBrowser = {
        ...(currentBrowser ?? { config: browserConfig }),
        config: browserConfig,
        runtime: publication.finalization.runtime,
      };
      browserPublicationCompleted = true;
      if (publication.projection.status === "pending") {
        log(
          dim(
            `Browser answer is durable; terminal session/model projection remains pending for retry: ${publication.projection.error}`,
          ),
        );
      } else if (publication.finalization.status === "pending") {
        log(
          dim("Browser cleanup remains pending; saved the answer and cleanup authority for retry."),
        );
      } else if (publication.finalizationPersistence.status === "pending") {
        log(
          dim(
            `Browser answer is published; cleanup authority projection remains pending for retry: ${publication.finalizationPersistence.error}`,
          ),
        );
      }
      await writeAssistantOutput(runOptions.writeOutputPath, result.answerText, log);
      await sendSessionNotification(
        {
          sessionId: sessionMeta.id,
          sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
          mode,
          model: sessionMeta.model ?? runOptions.model,
          usage: result.usage,
          characters: result.answerText.length,
        },
        notificationSettings,
        log,
        result.answerText.slice(0, 140),
      ).catch((error) => {
        log(dim(`Browser answer published; notification failed: ${formatError(error)}`));
      });
      return;
    }
    const multiModels = Array.isArray(runOptions.models) ? runOptions.models.filter(Boolean) : [];
    if (multiModels.length > 1) {
      const [primaryModel] = multiModels;
      if (!primaryModel) {
        throw new Error("Missing model name for multi-model run.");
      }
      const modelConfig = await resolveModelConfig(primaryModel, {
        baseUrl: runOptions.baseUrl,
        openRouterApiKey: process.env.OPENROUTER_API_KEY,
        modelOverrides: runOptions.modelOverrides,
      });
      const files = await readFiles(runOptions.file ?? [], {
        cwd,
        maxFileSizeBytes: runOptions.maxFileSizeBytes,
      });
      const promptWithFiles = buildPrompt(runOptions.prompt, files, cwd);
      const requestBody = buildRequestBody({
        modelConfig,
        systemPrompt: runOptions.system ?? DEFAULT_SYSTEM_PROMPT,
        userPrompt: promptWithFiles,
        searchEnabled: runOptions.search !== false,
        maxOutputTokens: runOptions.maxOutput,
        background: runOptions.background,
        storeResponse: runOptions.background,
      });
      const estimatedTokens = estimateRequestTokens(requestBody, modelConfig);
      const tokenLabel = formatTokenEstimate(estimatedTokens, (text) =>
        isTty ? kleur.green(text) : text,
      );
      const filesPhrase = files.length === 0 ? "no files" : `${files.length} files`;
      const modelsLabel = multiModels.join(", ");
      log(
        `Calling ${isTty ? kleur.cyan(modelsLabel) : modelsLabel} — ${tokenLabel} tokens, ${filesPhrase}.`,
      );

      const multiRunTips: string[] = [];
      if (files.length === 0) {
        multiRunTips.push(
          "Tip: no files attached — Oracle works best with project context. Add files via --file path/to/code or docs.",
        );
      }
      const shortPrompt = (runOptions.prompt?.trim().length ?? 0) < 80;
      if (shortPrompt) {
        multiRunTips.push(
          "Tip: brief prompts often yield generic answers — aim for 6–30 sentences and attach key files.",
        );
      }
      for (const tip of multiRunTips) {
        log(dim(tip));
      }

      // Surface long-running model expectations up front so users know why a response might lag.
      const longRunningModels = multiModels.filter(
        (model) => isKnownModel(model) && MODEL_CONFIGS[model]?.reasoning?.effort === "high",
      );
      if (longRunningModels.length > 0) {
        for (const model of longRunningModels) {
          log("");
          const headingLabel = `[${model}]`;
          log(isTty ? kleur.bold(headingLabel) : headingLabel);
          log(dim("This model can take up to 60 minutes (usually replies much faster)."));
          log(dim("Press Ctrl+C to cancel."));
        }
      }

      const shouldStreamInline = !muteStdout && process.stdout.isTTY;
      const shouldRenderMarkdown = shouldStreamInline && runOptions.renderPlain !== true;
      const printedModels = new Set<string>();
      const answerFallbacks = new Map<string, string>();
      const stripOscProgress = (text: string): string =>
        sanitizeOscProgress(text, shouldStreamInline);

      const printModelLog = async (model: string) => {
        if (printedModels.has(model)) return;
        printedModels.add(model);
        const body = stripOscProgress(await sessionStore.readModelLog(sessionMeta.id, model));
        log("");
        const fallback = answerFallbacks.get(model);
        const hasBody = body.length > 0;
        if (!hasBody && !fallback) {
          log(dim(`${model}: (no output recorded)`));
          return;
        }
        const headingLabel = `[${model}]`;
        const heading = shouldStreamInline ? kleur.bold(headingLabel) : headingLabel;
        log(heading);
        const content = hasBody ? body : (fallback ?? "");
        const printable = shouldRenderMarkdown ? renderMarkdownAnsi(content) : content;
        writeInline(printable);
        if (!printable.endsWith("\n")) {
          log("");
        }
      };

      const summary = await runMultiModelApiSession(
        {
          sessionMeta,
          runOptions,
          models: multiModels,
          cwd,
          version,
          onModelDone: shouldStreamInline
            ? async (result) => {
                if (result.answerText) {
                  answerFallbacks.set(result.model, result.answerText);
                }
                await printModelLog(result.model);
              }
            : undefined,
        },
        {
          runOracleImpl: muteStdout
            ? (opts, deps) => runOracle(opts, { ...deps, allowStdout: false })
            : undefined,
        },
      );

      if (!shouldStreamInline) {
        // If we couldn't stream inline (e.g., non-TTY), print all logs after completion.
        for (const [index, result] of summary.fulfilled.entries()) {
          if (index > 0) {
            log("");
          }
          await printModelLog(result.model);
        }
      }
      const aggregateUsage = summary.fulfilled.reduce<UsageSummary>(
        (acc, entry) => ({
          inputTokens: acc.inputTokens + entry.usage.inputTokens,
          outputTokens: acc.outputTokens + entry.usage.outputTokens,
          reasoningTokens: acc.reasoningTokens + entry.usage.reasoningTokens,
          totalTokens: acc.totalTokens + entry.usage.totalTokens,
          cost: (acc.cost ?? 0) + (entry.usage.cost ?? 0),
        }),
        { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0 },
      );
      const tokensDisplay = [
        aggregateUsage.inputTokens,
        aggregateUsage.outputTokens,
        aggregateUsage.reasoningTokens,
        aggregateUsage.totalTokens,
      ]
        .map((v, idx) =>
          formatTokenValue(
            v,
            {
              input_tokens: aggregateUsage.inputTokens,
              output_tokens: aggregateUsage.outputTokens,
              reasoning_tokens: aggregateUsage.reasoningTokens,
              total_tokens: aggregateUsage.totalTokens,
            },
            idx,
          ),
        )
        .join("/");
      const tokensPart = (() => {
        const parts = tokensDisplay.split("/");
        if (parts.length !== 4) return tokensDisplay;
        return `↑${parts[0]} ↓${parts[1]} ↻${parts[2]} Δ${parts[3]}`;
      })();
      const statusColor =
        summary.rejected.length === 0
          ? kleur.green
          : summary.fulfilled.length > 0
            ? kleur.yellow
            : kleur.red;
      const overallText = `${summary.fulfilled.length}/${multiModels.length} models`;
      const { line1 } = formatFinishLine({
        elapsedMs: summary.elapsedMs,
        model: overallText,
        costUsd: aggregateUsage.cost ?? null,
        tokensPart,
      });
      log(statusColor(line1));

      const hasFailure = summary.rejected.length > 0;
      const allowPartial = runOptions.partialMode === "ok" && summary.fulfilled.length > 0;
      if (hasFailure) {
        const resultLabel = summary.fulfilled.length > 0 ? "partial success" : "failed";
        log(
          statusColor(
            `Multi-model result: ${resultLabel}, ${summary.fulfilled.length}/${multiModels.length} succeeded`,
          ),
        );
      }
      await sessionStore.updateSession(sessionMeta.id, {
        status: hasFailure ? (allowPartial ? "partial" : "error") : "completed",
        completedAt: new Date().toISOString(),
        usage: aggregateUsage,
        elapsedMs: summary.elapsedMs,
        errorMessage: undefined,
        response: undefined,
        transport: undefined,
        error: undefined,
      });
      const totalCharacters = summary.fulfilled.reduce(
        (sum, entry) => sum + entry.answerText.length,
        0,
      );
      await sendSessionNotification(
        {
          sessionId: sessionMeta.id,
          sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
          mode,
          model: `${multiModels.length} models`,
          usage: aggregateUsage,
          characters: totalCharacters,
        },
        notificationSettings,
        log,
      );
      if (runOptions.writeOutputPath) {
        const savedOutputs: Array<{ model: string; path: string }> = [];
        for (const entry of summary.fulfilled) {
          const modelOutputPath = deriveModelOutputPath(runOptions.writeOutputPath, entry.model);
          const savedPath = await writeAssistantOutput(modelOutputPath, entry.answerText, log);
          if (savedPath) {
            savedOutputs.push({ model: entry.model, path: savedPath });
          }
        }
        const sessionWithRuns = (await readSessionForManifest(sessionMeta.id)) ?? {
          ...sessionMeta,
          models: sessionMeta.models,
        };
        const runLogs = await collectMultiModelRunLogs(
          sessionMeta.id,
          sessionWithRuns.models,
          summary,
        );
        const manifestPath = await writeMultiModelOutputManifest({
          baseOutputPath: runOptions.writeOutputPath,
          sessionId: sessionMeta.id,
          status: hasFailure ? (allowPartial ? "partial" : "error") : "completed",
          summary,
          savedOutputs,
          modelRuns: sessionWithRuns.models,
          runLogs,
          runOptions,
          log,
        });
        if (savedOutputs.length > 0) {
          log(dim("Saved outputs:"));
          for (const item of savedOutputs) {
            log(dim(`- ${item.model} -> ${item.path}`));
          }
        }
        if (manifestPath) {
          log(dim(`Output manifest: ${manifestPath}`));
        }
        if (runLogs.length > 0) {
          log(dim(""));
          log(dim("Run logs:"));
          for (const item of runLogs) {
            log(dim(`- ${item.model} -> ${item.path}`));
          }
        }
      }
      if (hasFailure) {
        log(dim("Failures:"));
        for (const item of summary.rejected) {
          const providerContext = providerFailureContextForModel(item.model, runOptions);
          log(dim(`- ${item.model}: ${formatMultiModelFailure(item.reason, providerContext)}`));
          for (const line of formatMultiModelFailureDetails(item.reason, providerContext)) {
            log(dim(line));
          }
        }
      }
      if (hasFailure && !allowPartial) {
        const firstFailure = summary.rejected[0];
        throw sanitizeMultiModelFailureForThrow(
          firstFailure.reason,
          providerFailureContextForModel(firstFailure.model, runOptions),
        );
      }
      return;
    }
    const singleModelOverride = multiModels.length === 1 ? multiModels[0] : undefined;
    const apiRunOptions: RunOracleOptions = singleModelOverride
      ? { ...runOptions, model: singleModelOverride, models: undefined }
      : runOptions;
    if (modelForStatus && singleModelOverride == null) {
      await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
        status: "running",
        startedAt: new Date().toISOString(),
      });
    }
    const result = await runOracle(apiRunOptions, {
      cwd,
      log,
      write,
      allowStdout: !muteStdout,
    });
    if (result.mode !== "live") {
      throw new Error("Unexpected preview result while running a session.");
    }
    const answerText = extractTextOutput(result.response);
    await writeAssistantOutput(runOptions.writeOutputPath, answerText, log);
    await sendSessionNotification(
      {
        sessionId: sessionMeta.id,
        sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
        mode,
        model: sessionMeta.model ?? runOptions.model,
        usage: result.usage,
        characters: answerText.length,
      },
      notificationSettings,
      log,
      answerText.slice(0, 140),
    );
    const completedAt = new Date().toISOString();
    await commitSessionModelProjection(sessionMeta.id, {
      session: {
        status: "completed",
        completedAt,
        usage: result.usage,
        elapsedMs: result.elapsedMs,
        errorMessage: undefined,
        response: extractResponseMetadata(result.response),
        transport: undefined,
        error: undefined,
      },
      ...(modelForStatus && singleModelOverride == null
        ? {
            model: {
              model: modelForStatus,
              updates: { status: "completed", completedAt, usage: result.usage },
            },
          }
        : {}),
    });
  } catch (error: unknown) {
    durableAnswerReceipt ??= await verifiedDurableBrowserAnswerReceiptFromError(error);
    const message = formatError(error);
    if (browserPublicationCompleted) {
      log(dim(`Browser answer is published; post-publication work remains retryable: ${message}`));
      return;
    }
    if (mode === "browser" && durableAnswerReceipt) {
      const publicationJournal = await readBrowserCapturePublicationJournal(sessionMeta.id).catch(
        () => null,
      );
      if (journalHasFinalizeAuthorityForReceipt(publicationJournal, durableAnswerReceipt)) {
        log(
          dim(
            `Browser answer is durable under FINALIZE authority; terminal projection/finalization remains retryable: ${message}`,
          ),
        );
        return;
      }
    }
    log(`ERROR: ${message}`);
    markErrorLogged(error);
    const userError = asOracleUserError(error);
    const connectionLost =
      userError?.category === "browser-automation" &&
      (userError.details as { stage?: string } | undefined)?.stage === "connection-lost";
    const assistantTimeout =
      userError?.category === "browser-automation" &&
      (userError.details as { stage?: string } | undefined)?.stage === "assistant-timeout";
    const geminiResponseCaptureFailure =
      userError?.category === "browser-automation" &&
      (userError.details as { stage?: string } | undefined)?.stage === "gemini-response-capture";
    const geminiCaptureFailure =
      geminiResponseCaptureFailure &&
      (userError.details as { reattachable?: boolean } | undefined)?.reattachable === true;
    const reattachExplicitlyUnavailable =
      userError?.category === "browser-automation" &&
      (userError.details as { reattachable?: boolean } | undefined)?.reattachable === false;
    const cloudflareChallenge =
      userError?.category === "browser-automation" &&
      (userError.details as { stage?: string } | undefined)?.stage === "cloudflare-challenge";
    const capturedErrorRuntime = runtimeFromBrowserError(error);
    const errorBrowserRuntime = runtimeAuthority.observeError(capturedErrorRuntime);
    const cleanupCompletedAfterCapturedError = runtimeAuthority.didTerminalCleanupSupersedeError();
    if (errorBrowserRuntime) {
      currentBrowser = { ...currentBrowser, runtime: errorBrowserRuntime };
    }
    const authoritativeErrorDetails =
      userError?.details && capturedErrorRuntime
        ? { ...userError.details, runtime: errorBrowserRuntime }
        : userError?.details;
    const browserCanReattach =
      !cleanupCompletedAfterCapturedError &&
      (!browserConfig?.copyProfileSource || hasRemoteRecoveryAuthority(errorBrowserRuntime));
    let reattachGuidanceLogged = false;
    const logBrowserReattachGuidance = (
      runtime: BrowserRuntimeMetadata | null | undefined,
    ): void => {
      if (reattachGuidanceLogged || mode !== "browser") return;
      if (reattachExplicitlyUnavailable) {
        if (!runtime?.recoveryCleanupResources?.length || !runtime.recoveryCleanupResult) return;
        reattachGuidanceLogged = true;
        log(
          dim(
            `Exact browser response recovery is unavailable; run "oracle session ${sessionMeta.id}" to retry owned browser cleanup without resubmitting.`,
          ),
        );
        return;
      }
      if (!hasBrowserRecoveryAuthority(runtime)) return;
      reattachGuidanceLogged = true;
      log(formatBrowserReattachGuidance(sessionMeta.id));
    };
    if ((connectionLost || geminiCaptureFailure) && mode === "browser" && browserCanReattach) {
      const runtime = errorBrowserRuntime;
      const recoverableRuntime = runtime ?? currentBrowser?.runtime;
      const recoveryAuthorized = geminiCaptureFailure
        ? (userError.details as { reattachable?: boolean } | undefined)?.reattachable === true
        : (userError.details as { recoverableDisconnect?: boolean } | undefined)
            ?.recoverableDisconnect === true;
      const hasRecoveryAuthority = hasResumableBrowserAuthority(recoverableRuntime);
      if (!recoveryAuthorized || !hasRecoveryAuthority) {
        log(
          dim(
            geminiCaptureFailure
              ? "Gemini capture failed without resumable committed-prompt authority; marking session error."
              : "Chrome disconnected without recoverable current-prompt commit authority; marking session error.",
          ),
        );
        const incompleteReason = geminiCaptureFailure
          ? "incomplete-capture"
          : "chrome-disconnected";
        const response = { status: "error", incompleteReason };
        const errorMetadata = {
          category: userError.category,
          message: userError.message,
          details: authoritativeErrorDetails,
        };
        await persistBrowserSessionOutcome(sessionMeta.id, {
          kind: "terminal-error",
          browser: { ...currentBrowser, config: browserConfig },
          runtime: recoverableRuntime,
          response,
          reason: message,
          artifacts: sessionMeta.artifacts,
          receipt: durableAnswerReceipt,
          errorMetadata,
          transportMetadata: undefined,
          modelProjection: modelForStatus
            ? { model: modelForStatus, updates: { response, error: errorMetadata } }
            : undefined,
        });
        throw error;
      }
      log(
        dim(
          geminiCaptureFailure
            ? "Gemini response capture remains incomplete; keeping session running for exact reattach."
            : "Chrome disconnected before completion; keeping session running for reattach.",
        ),
      );
      const recoveryRuntime = recoverableRuntime as BrowserRuntimeMetadata;
      const recoveryResponse = {
        status: "running",
        incompleteReason: geminiCaptureFailure ? "incomplete-capture" : "chrome-disconnected",
      };
      await persistBrowserSessionOutcome(sessionMeta.id, {
        kind: "recovery-running",
        browser: { ...currentBrowser, config: browserConfig },
        runtime: recoveryRuntime,
        response: recoveryResponse,
        reason: message,
        artifacts: sessionMeta.artifacts,
        receipt: durableAnswerReceipt,
        errorMetadata: undefined,
        transportMetadata: undefined,
        modelProjection: modelForStatus ? { model: modelForStatus, updates: {} } : undefined,
      });
      logBrowserReattachGuidance(recoverableRuntime);
      // A live committed target gets one immediate harvest attempt even without a configured loop.
      const configuredIntervalMs = browserConfig?.autoReattachIntervalMs ?? 0;
      const recoveryIntervalMs =
        configuredIntervalMs > 0
          ? configuredIntervalMs
          : Math.max(1_000, Math.min(browserConfig?.timeoutMs ?? 30_000, 30_000));
      const reattach = await autoReattachUntilComplete({
        sessionMeta,
        runtime: recoveryRuntime,
        browserConfig: {
          ...browserConfig,
          autoReattachIntervalMs: recoveryIntervalMs,
          autoReattachDelayMs: browserConfig?.autoReattachDelayMs ?? 0,
          autoReattachTimeoutMs:
            browserConfig?.autoReattachTimeoutMs ?? browserConfig?.timeoutMs ?? 120_000,
        },
        browserMetadata: currentBrowser,
        runOptions,
        modelForStatus,
        notificationSettings,
        log,
        writeAssistantOutput,
        maxAttempts: configuredIntervalMs > 0 ? undefined : 1,
      });
      if (reattach.outcome === "exhausted") {
        const exhaustedRuntime = reattach.runtime ?? recoveryRuntime;
        currentBrowser = {
          ...currentBrowser,
          config: browserConfig,
          runtime: exhaustedRuntime,
        };
        await persistBrowserSessionOutcome(sessionMeta.id, {
          kind: "recovery-running",
          browser: currentBrowser,
          runtime: exhaustedRuntime,
          response: recoveryResponse,
          reason: message,
          artifacts: sessionMeta.artifacts,
          receipt: durableAnswerReceipt,
          errorMetadata: undefined,
          transportMetadata: undefined,
          modelProjection: modelForStatus ? { model: modelForStatus, updates: {} } : undefined,
        });
      }
      return;
    }
    if (assistantTimeout && mode === "browser" && browserCanReattach) {
      const runtime = errorBrowserRuntime;
      log(dim("Assistant response timed out; marking capture incomplete for reattach."));
      const timeoutResponse = {
        status: "incomplete",
        incompleteReason: "incomplete-capture",
      } as const;
      const timeoutError = {
        category: userError.category,
        message: userError.message,
        details: authoritativeErrorDetails,
      };
      const autoReattachIntervalMs = browserConfig?.autoReattachIntervalMs ?? 0;
      let autoRuntime = runtime ?? currentBrowser?.runtime;
      const willAutoReattach =
        autoReattachIntervalMs > 0 && hasResumableBrowserAuthority(autoRuntime);
      if (willAutoReattach) {
        const timeoutRecoveryRuntime = autoRuntime as BrowserRuntimeMetadata;
        await persistBrowserSessionOutcome(sessionMeta.id, {
          kind: "recovery-running",
          browser: { ...currentBrowser, config: browserConfig },
          runtime: timeoutRecoveryRuntime,
          response: timeoutResponse,
          reason: message,
          artifacts: sessionMeta.artifacts,
          receipt: durableAnswerReceipt,
          errorMetadata: timeoutError,
          transportMetadata: undefined,
          modelProjection: modelForStatus
            ? {
                model: modelForStatus,
                updates: { response: timeoutResponse, error: timeoutError },
              }
            : undefined,
        });
        const reattach = await autoReattachUntilComplete({
          sessionMeta,
          runtime: timeoutRecoveryRuntime,
          browserConfig,
          browserMetadata: currentBrowser,
          runOptions,
          modelForStatus,
          notificationSettings,
          log,
          writeAssistantOutput,
        });
        if (reattach.outcome !== "exhausted") {
          return;
        }
        autoRuntime = reattach.runtime ?? autoRuntime;
      }
      await persistBrowserSessionOutcome(sessionMeta.id, {
        kind: "terminal-error",
        browser: { ...currentBrowser, config: browserConfig },
        runtime: autoRuntime,
        response: timeoutResponse,
        reason: message,
        artifacts: sessionMeta.artifacts,
        receipt: durableAnswerReceipt,
        errorMetadata: timeoutError,
        transportMetadata: undefined,
        modelProjection: modelForStatus
          ? {
              model: modelForStatus,
              updates: { response: timeoutResponse, error: timeoutError },
            }
          : undefined,
      });
      logBrowserReattachGuidance(autoRuntime);
      return;
    }
    if (cloudflareChallenge && mode === "browser") {
      const details = userError.details as { reuseProfileHint?: string } | undefined;
      if (browserCanReattach) {
        log(
          dim("Cloudflare challenge detected; browser left running so you can complete the check."),
        );
        if (details?.reuseProfileHint) {
          log(dim(`Reuse this browser profile with: ${details.reuseProfileHint}`));
        }
      } else {
        log(dim("Cloudflare challenge detected; copied profile closed and removed."));
      }
    }
    if (userError) {
      log(dim(`User error (${userError.category}): ${userError.message}`));
    }
    const responseMetadata =
      error instanceof OracleResponseError
        ? error.metadata
        : geminiResponseCaptureFailure
          ? ({ status: "error", incompleteReason: "incomplete-capture" } as const)
          : undefined;
    const metadataLine = formatResponseMetadata(responseMetadata);
    if (metadataLine) {
      log(dim(`Response metadata: ${metadataLine}`));
    }
    const transportMetadata =
      error instanceof OracleTransportError ? { reason: error.reason } : undefined;
    const transportLine = formatTransportMetadata(transportMetadata);
    if (transportLine) {
      log(dim(`Transport: ${transportLine}`));
    }
    const cleanupErrorRuntime =
      errorBrowserRuntime?.recoveryCleanupResources?.length &&
      errorBrowserRuntime.recoveryCleanupResult
        ? errorBrowserRuntime
        : undefined;
    const clearCopiedProfileRuntime =
      mode === "browser" &&
      Boolean(browserConfig?.copyProfileSource) &&
      !cleanupErrorRuntime &&
      !hasRemoteRecoveryAuthority(errorBrowserRuntime);
    const browserRuntime =
      mode === "browser" && !clearCopiedProfileRuntime
        ? (errorBrowserRuntime ?? currentBrowser?.runtime)
        : undefined;
    if (!cloudflareChallenge && (browserCanReattach || reattachExplicitlyUnavailable)) {
      logBrowserReattachGuidance(browserRuntime ?? currentBrowser?.runtime);
    }
    const errorMetadata = userError
      ? {
          category: userError.category,
          message: userError.message,
          details: authoritativeErrorDetails,
        }
      : undefined;
    const modelProjection = modelForStatus
      ? {
          model: modelForStatus,
          updates: geminiResponseCaptureFailure
            ? { response: responseMetadata, error: errorMetadata }
            : {},
        }
      : undefined;
    if (mode === "browser") {
      const outcome: BrowserSessionOutcome = cleanupErrorRuntime
        ? {
            kind: "cleanup-pending",
            publication: "unpublished",
            browser: { ...currentBrowser, config: browserConfig },
            runtime: cleanupErrorRuntime,
            response: responseMetadata,
            reason: message,
            artifacts: sessionMeta.artifacts,
            receipt: durableAnswerReceipt,
            errorMetadata,
            transportMetadata,
            modelProjection,
          }
        : {
            kind: "terminal-error",
            browser: { ...currentBrowser, config: browserConfig },
            runtime: browserRuntime,
            response: responseMetadata,
            reason: message,
            artifacts: sessionMeta.artifacts,
            receipt: durableAnswerReceipt,
            errorMetadata,
            transportMetadata,
            modelProjection,
          };
      await persistBrowserSessionOutcome(sessionMeta.id, outcome);
    } else {
      const completedAt = new Date().toISOString();
      await commitSessionModelProjection(sessionMeta.id, {
        session: {
          status: "error",
          completedAt,
          errorMessage: message,
          mode,
          browser: browserConfig
            ? {
                ...currentBrowser,
                config: browserConfig,
                runtime: browserRuntime,
              }
            : undefined,
          ...(durableAnswerReceipt
            ? {
                artifacts: mergeArtifacts(sessionMeta.artifacts, [durableAnswerReceipt.artifact]),
              }
            : {}),
          response: responseMetadata,
          transport: transportMetadata,
          error: errorMetadata,
        },
        ...(modelForStatus
          ? {
              model: {
                model: modelForStatus,
                updates: {
                  status: "error",
                  completedAt,
                  ...(geminiResponseCaptureFailure
                    ? { response: responseMetadata, error: errorMetadata }
                    : {}),
                },
              },
            }
          : {}),
      });
    }
    throw error;
  }
}

function createBrowserLogger(log: (message?: string) => void): BrowserLogger {
  const logger = ((message?: string) => {
    if (message) log(dim(message));
  }) as BrowserLogger;
  logger.sessionLog = log;
  return logger;
}

function mergeArtifacts(
  existing: SessionArtifact[] | undefined,
  additions: SessionArtifact[] | undefined,
): SessionArtifact[] | undefined {
  const merged = new Map<string, SessionArtifact>();
  for (const artifact of existing ?? []) {
    merged.set(`${artifact.kind}:${artifact.path}`, artifact);
  }
  for (const artifact of additions ?? []) {
    merged.set(`${artifact.kind}:${artifact.path}`, artifact);
  }
  const values = Array.from(merged.values());
  return values.length > 0 ? values : undefined;
}

function providerFailureContextForModel(
  model: string,
  runOptions: RunOracleOptions,
): ProviderFailureContext {
  return {
    model,
    providerMode: runOptions.provider,
    azure: runOptions.azure,
    baseUrl: runOptions.baseUrl,
    apiKey: runOptions.apiKey,
  };
}

function formatMultiModelFailure(
  error: unknown,
  context?: string | ProviderFailureContext,
): string {
  const userError = asOracleUserError(error);
  if (userError) {
    return `${userError.category}, ${userError.message}`;
  }
  const providerFailure = classifyProviderFailure(error, context);
  if (providerFailure) {
    return providerFailure.label;
  }
  if (error instanceof OracleTransportError) {
    return `${error.reason}, ${error.message}`;
  }
  if (error instanceof OracleResponseError) {
    return error.message;
  }
  return formatError(error);
}

function formatMultiModelFailureDetails(
  error: unknown,
  context?: string | ProviderFailureContext,
): string[] {
  const providerFailure = classifyProviderFailure(error, context);
  if (!providerFailure) {
    return [];
  }
  const lines: string[] = [];
  if (providerFailure.keyEnv) {
    lines.push(`  key: ${providerFailure.keyEnv}`);
  }
  lines.push(`  provider said: ${providerFailure.providerMessage}`);
  lines.push(`  fix: ${providerFailure.fix}`);
  return lines;
}

function sanitizeMultiModelFailureForThrow(
  error: unknown,
  context?: string | ProviderFailureContext,
): unknown {
  const providerFailure = classifyProviderFailure(error, context);
  if (!providerFailure) {
    return error;
  }
  const modelPrefix = typeof context === "object" && context?.model ? `${context.model}: ` : "";
  const message = `${modelPrefix}${providerFailure.label}: ${providerFailure.providerMessage}`;
  if (!(error instanceof Error)) {
    return new Error(message);
  }
  let sanitized: Error;
  if (error instanceof OracleTransportError) {
    sanitized = new OracleTransportError(error.reason, message);
  } else if (error instanceof OracleResponseError) {
    sanitized = new OracleResponseError(message, error.response);
  } else {
    sanitized = new Error(message);
    sanitized.name = error.name;
  }
  if (error.stack) {
    const [, ...rest] = error.stack.split("\n");
    sanitized.stack = [sanitized.name ? `${sanitized.name}: ${message}` : message, ...rest].join(
      "\n",
    );
  }
  return sanitized;
}

interface MultiModelManifestRunLog {
  model: string;
  path: string;
}

interface MultiModelOutputManifest {
  version: 1;
  sessionId: string;
  status: "completed" | "partial" | "error";
  outputBasePath: string;
  createdAt: string;
  models: Array<{
    model: string;
    status: string;
    outputPath?: string;
    logPath?: string;
    errorCategory?: string;
    errorMessage?: string;
    elapsedMs?: number;
    usage?: UsageSummary;
  }>;
}

export function deriveOutputManifestPath(basePath: string): string {
  const ext = path.extname(basePath);
  const stem = path.basename(basePath, ext);
  const dir = path.dirname(basePath);
  return path.join(dir, `${stem}.oracle.json`);
}

async function collectMultiModelRunLogs(
  sessionId: string,
  modelRuns: SessionModelRun[] | undefined,
  summary: MultiModelRunSummary,
): Promise<MultiModelManifestRunLog[]> {
  const sessionDir = await resolveSessionDir(sessionId);
  const logsByModel = new Map<string, string>();
  for (const run of modelRuns ?? []) {
    if (run.log?.path) {
      logsByModel.set(run.model, resolveSessionPath(sessionDir, run.log.path));
    }
  }
  for (const entry of summary.fulfilled) {
    if (!logsByModel.has(entry.model)) {
      logsByModel.set(entry.model, entry.logPath);
    }
  }
  return [...logsByModel.entries()].map(([model, logPath]) => ({ model, path: logPath }));
}

async function writeMultiModelOutputManifest({
  baseOutputPath,
  sessionId,
  status,
  summary,
  savedOutputs,
  modelRuns,
  runLogs,
  runOptions,
  log,
}: {
  baseOutputPath: string;
  sessionId: string;
  status: "completed" | "partial" | "error";
  summary: MultiModelRunSummary;
  savedOutputs: Array<{ model: string; path: string }>;
  modelRuns?: SessionModelRun[];
  runLogs: MultiModelManifestRunLog[];
  runOptions: RunOracleOptions;
  log: (message: string) => void;
}): Promise<string | undefined> {
  const manifestPath = deriveOutputManifestPath(baseOutputPath);
  const normalizedTarget = path.resolve(manifestPath);
  const normalizedSessionsDir = path.resolve(sessionStore.sessionsDir());
  if (
    normalizedTarget === normalizedSessionsDir ||
    normalizedTarget.startsWith(`${normalizedSessionsDir}${path.sep}`)
  ) {
    log(
      dim(
        `output manifest skipped: refusing to write inside session storage (${normalizedSessionsDir}).`,
      ),
    );
    return undefined;
  }
  const manifest = buildMultiModelOutputManifest({
    baseOutputPath,
    sessionId,
    status,
    summary,
    savedOutputs,
    modelRuns,
    runLogs,
    runOptions,
  });
  try {
    await fs.mkdir(path.dirname(normalizedTarget), { recursive: true });
    await fs.writeFile(normalizedTarget, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return normalizedTarget;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(dim(`output manifest failed (${reason}); session completed anyway.`));
    return undefined;
  }
}

function buildMultiModelOutputManifest({
  baseOutputPath,
  sessionId,
  status,
  summary,
  savedOutputs,
  modelRuns,
  runLogs,
  runOptions,
}: {
  baseOutputPath: string;
  sessionId: string;
  status: "completed" | "partial" | "error";
  summary: MultiModelRunSummary;
  savedOutputs: Array<{ model: string; path: string }>;
  modelRuns?: SessionModelRun[];
  runLogs: MultiModelManifestRunLog[];
  runOptions: RunOracleOptions;
}): MultiModelOutputManifest {
  const outputByModel = new Map(savedOutputs.map((entry) => [entry.model, entry.path]));
  const logsByModel = new Map(runLogs.map((entry) => [entry.model, entry.path]));
  const runsByModel = new Map((modelRuns ?? []).map((run) => [run.model, run]));
  const fulfilledByModel = new Map(summary.fulfilled.map((entry) => [entry.model, entry]));
  const rejectedByModel = new Map(summary.rejected.map((entry) => [entry.model, entry.reason]));
  const orderedModels = [
    ...summary.fulfilled.map((entry) => entry.model),
    ...summary.rejected.map((entry) => entry.model),
  ];
  return {
    version: 1,
    sessionId,
    status,
    outputBasePath: path.resolve(baseOutputPath),
    createdAt: new Date().toISOString(),
    models: orderedModels.map((model) => {
      const run = runsByModel.get(model);
      const fulfilled = fulfilledByModel.get(model);
      const reason = rejectedByModel.get(model);
      const userError = reason ? asOracleUserError(reason) : undefined;
      const providerFailure = reason
        ? classifyProviderFailure(reason, providerFailureContextForModel(model, runOptions))
        : undefined;
      return {
        model,
        status: fulfilled ? "completed" : reason ? "error" : (run?.status ?? "error"),
        outputPath: outputByModel.get(model),
        logPath: logsByModel.get(model),
        errorCategory: run?.error?.category ?? userError?.category ?? providerFailure?.category,
        errorMessage:
          run?.error?.message ??
          userError?.message ??
          providerFailure?.label ??
          (reason ? formatError(reason) : undefined),
        elapsedMs: calculateModelElapsedMs(run),
        usage: run?.usage ?? fulfilled?.usage,
      };
    }),
  };
}

function calculateModelElapsedMs(run?: SessionModelRun): number | undefined {
  if (!run?.startedAt || !run.completedAt) {
    return undefined;
  }
  const startedMs = Date.parse(run.startedAt);
  const completedMs = Date.parse(run.completedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) {
    return undefined;
  }
  return completedMs - startedMs;
}

async function readSessionForManifest(sessionId: string): Promise<SessionMetadata | null> {
  try {
    return (await sessionStore.readSession(sessionId)) ?? null;
  } catch {
    return null;
  }
}

async function resolveSessionDir(sessionId: string): Promise<string | null> {
  try {
    return (await sessionStore.getPaths(sessionId)).dir;
  } catch {
    return null;
  }
}

function resolveSessionPath(sessionDir: string | null, targetPath: string): string {
  if (path.isAbsolute(targetPath) || !sessionDir) {
    return targetPath;
  }
  return path.join(sessionDir, targetPath);
}

async function writeAssistantOutput(
  targetPath: string | undefined,
  content: string,
  log: (message: string) => void,
) {
  if (!targetPath) return;
  if (!content || content.trim().length === 0) {
    log(dim("write-output skipped: no assistant content to save."));
    return;
  }
  const normalizedTarget = path.resolve(targetPath);
  const normalizedSessionsDir = path.resolve(sessionStore.sessionsDir());
  if (
    normalizedTarget === normalizedSessionsDir ||
    normalizedTarget.startsWith(`${normalizedSessionsDir}${path.sep}`)
  ) {
    log(
      dim(
        `write-output skipped: refusing to write inside session storage (${normalizedSessionsDir}).`,
      ),
    );
    return;
  }
  try {
    await fs.mkdir(path.dirname(normalizedTarget), { recursive: true });
    const payload = content.endsWith("\n") ? content : `${content}\n`;
    await fs.writeFile(normalizedTarget, payload, "utf8");
    log(dim(`Saved assistant output to ${normalizedTarget}`));
    return normalizedTarget;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (isPermissionError(error)) {
      const fallbackPath = buildFallbackPath(normalizedTarget);
      if (fallbackPath) {
        try {
          await fs.mkdir(path.dirname(fallbackPath), { recursive: true });
          const payload = content.endsWith("\n") ? content : `${content}\n`;
          await fs.writeFile(fallbackPath, payload, "utf8");
          log(dim(`write-output fallback to ${fallbackPath} (original failed: ${reason})`));
          return fallbackPath;
        } catch (innerError) {
          const innerReason = innerError instanceof Error ? innerError.message : String(innerError);
          log(
            dim(
              `write-output failed (${reason}); fallback failed (${innerReason}); session completed anyway.`,
            ),
          );
          return;
        }
      }
    }
    log(dim(`write-output failed (${reason}); session completed anyway.`));
  }
}

export function deriveModelOutputPath(
  basePath: string | undefined,
  model: string,
): string | undefined {
  if (!basePath) return undefined;
  const ext = path.extname(basePath);
  const stem = path.basename(basePath, ext);
  const dir = path.dirname(basePath);
  const suffix = ext.length > 0 ? `${stem}.${model}${ext}` : `${stem}.${model}`;
  return path.join(dir, suffix);
}

function isPermissionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  return code === "EACCES" || code === "EPERM";
}

function buildFallbackPath(original: string): string | null {
  const ext = path.extname(original);
  const stem = path.basename(original, ext);
  const dir = getCwd();
  const candidate = ext ? `${stem}.fallback${ext}` : `${stem}.fallback`;
  const fallback = path.join(dir, candidate);
  const normalizedSessionsDir = path.resolve(sessionStore.sessionsDir());
  const normalizedFallback = path.resolve(fallback);
  if (
    normalizedFallback === normalizedSessionsDir ||
    normalizedFallback.startsWith(`${normalizedSessionsDir}${path.sep}`)
  ) {
    return null;
  }
  return fallback;
}
