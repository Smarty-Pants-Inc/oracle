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
import { markErrorLogged } from "./errorUtils.js";
import {
  type NotificationSettings,
  sendSessionNotification,
  deriveNotificationSettingsFromMetadata,
} from "./notifier.js";
import { sessionStore } from "../sessionStore.js";
import { wait } from "../sessionManager.js";
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
import { resumeBrowserSession, type ReattachResult } from "../browser/reattach.js";
import { hasRecoverableChatGptConversation } from "../browser/reattachability.js";
import { estimateTokenCount } from "../browser/utils.js";
import type { BrowserLogger } from "../browser/types.js";
import { formatElapsed } from "../oracle/format.js";
import { formatBrowserReattachGuidance } from "./reattachGuidance.js";
import {
  persistDurableBrowserAnswer,
  publishBrowserCapture,
  runtimeFromBrowserError,
  type DurableBrowserAnswerReceipt,
} from "./durableAnswer.js";

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
  let currentBrowser: SessionMetadata["browser"] = browserConfig
    ? { config: browserConfig }
    : sessionMeta.browser;
  const runtimeAuthority = new MonotonicBrowserRuntimeAuthority(currentBrowser?.runtime);
  await sessionStore.updateSession(sessionMeta.id, {
    status: "running",
    startedAt: new Date().toISOString(),
    mode,
    ...(browserConfig ? { browser: { config: browserConfig } } : {}),
  });
  const notificationSettings =
    notifications ?? deriveNotificationSettingsFromMetadata(sessionMeta, process.env);
  const modelForStatus = runOptions.model ?? sessionMeta.model;
  let durableAnswerReceipt: DurableBrowserAnswerReceipt | undefined;
  try {
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
      const publication = await publishBrowserCapture({
        answerOptions: {
          sessionId: sessionMeta.id,
          answer: result.answerText ?? "",
        },
        transaction: result,
        persistAnswer: persistDurableBrowserAnswer,
        prepare: async (receipt) => {
          durableAnswerReceipt = receipt;
          const artifacts = await ensureSessionArtifacts({
            sessionId: sessionMeta.id,
            prompt: result.promptText ?? runOptions.prompt,
            answerMarkdown: result.answerText ?? "",
            conversationUrl: result.runtime.tabUrl,
            browserConfig,
            existingArtifacts: result.artifacts,
            logger: ((message?: string) => message && log(dim(message))) as BrowserLogger,
          });
          return { artifacts };
        },
        publish: async (receipt, prepared) => {
          await sessionStore.updateSession(sessionMeta.id, {
            status: "completed",
            completedAt: new Date().toISOString(),
            usage: result.usage,
            elapsedMs: result.elapsedMs,
            errorMessage: undefined,
            browser: currentBrowser,
            artifacts: mergeArtifacts(mergeArtifacts(sessionMeta.artifacts, prepared.artifacts), [
              receipt.artifact,
            ]),
            response: undefined,
            transport: undefined,
            error: undefined,
          });
        },
        persistRuntime: async (runtime) => {
          const authoritativeRuntime = runtimeAuthority.observeHint(runtime);
          currentBrowser = { ...currentBrowser, runtime: authoritativeRuntime };
          await sessionStore.updateSession(sessionMeta.id, { browser: currentBrowser });
        },
      });
      if (publication.finalization.status === "pending") {
        log(
          kleur.yellow(
            `Browser capture completed; cleanup remains pending: ${publication.finalization.error}`,
          ),
        );
      }
      await writeAssistantOutput(runOptions.writeOutputPath, result.answerText ?? "", log);
      await sendSessionNotification(
        {
          sessionId: sessionMeta.id,
          sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
          mode,
          model: sessionMeta.model,
          usage: result.usage,
          characters: result.answerText?.length,
        },
        notificationSettings,
        log,
        result.answerText?.slice(0, 140),
      ).catch((error) => {
        log(dim(`Browser answer published; notification failed: ${formatError(error)}`));
      });
      if (modelForStatus) {
        await sessionStore
          .updateModelRun(sessionMeta.id, modelForStatus, {
            status: "completed",
            completedAt: new Date().toISOString(),
            usage: result.usage,
          })
          .catch((error) => {
            log(
              dim(`Browser answer published; model-run projection failed: ${formatError(error)}`),
            );
          });
      }
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
    if (modelForStatus && singleModelOverride == null) {
      await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
        status: "completed",
        completedAt: new Date().toISOString(),
        usage: result.usage,
      });
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
    await sessionStore.updateSession(sessionMeta.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      usage: result.usage,
      elapsedMs: result.elapsedMs,
      errorMessage: undefined,
      response: extractResponseMetadata(result.response),
      transport: undefined,
      error: undefined,
    });
  } catch (error: unknown) {
    const message = formatError(error);
    log(`ERROR: ${message}`);
    markErrorLogged(error);
    const userError = asOracleUserError(error);
    const connectionLost =
      userError?.category === "browser-automation" &&
      (userError.details as { stage?: string } | undefined)?.stage === "connection-lost";
    const assistantTimeout =
      userError?.category === "browser-automation" &&
      (userError.details as { stage?: string } | undefined)?.stage === "assistant-timeout";
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
      if (!hasBrowserRecoveryAuthority(runtime)) return;
      reattachGuidanceLogged = true;
      log(formatBrowserReattachGuidance(sessionMeta.id));
    };
    if (connectionLost && mode === "browser" && browserCanReattach) {
      const runtime = errorBrowserRuntime;
      const recoverableRuntime = runtime ?? currentBrowser?.runtime;
      const recoverableDisconnect =
        (userError.details as { recoverableDisconnect?: boolean } | undefined)
          ?.recoverableDisconnect === true;
      const hasRecoveryAuthority = hasResumableBrowserAuthority(recoverableRuntime);
      if (!recoverableDisconnect || !hasRecoveryAuthority) {
        log(
          dim(
            "Chrome disconnected without recoverable current-prompt commit authority; marking session error.",
          ),
        );
        if (modelForStatus) {
          await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
            status: "error",
            completedAt: new Date().toISOString(),
            response: { status: "error", incompleteReason: "chrome-disconnected" },
            error: {
              category: userError.category,
              message: userError.message,
              details: authoritativeErrorDetails,
            },
          });
        }
        await sessionStore.updateSession(sessionMeta.id, {
          status: "error",
          completedAt: new Date().toISOString(),
          errorMessage: message,
          mode,
          browser: {
            ...currentBrowser,
            config: browserConfig,
            runtime: recoverableRuntime,
          },
          response: { status: "error", incompleteReason: "chrome-disconnected" },
          error: {
            category: userError.category,
            message: userError.message,
            details: authoritativeErrorDetails,
          },
        });
        throw error;
      }
      log(dim("Chrome disconnected before completion; keeping session running for reattach."));
      if (modelForStatus) {
        await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
          status: "running",
          completedAt: undefined,
        });
      }
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        errorMessage: message,
        mode,
        browser: {
          ...currentBrowser,
          config: browserConfig,
          runtime: recoverableRuntime,
        },
        response: { status: "running", incompleteReason: "chrome-disconnected" },
      });
      logBrowserReattachGuidance(recoverableRuntime);
      // Connection-lost should attempt the same recovery path as assistant-timeout.
      // When auto-reattach interval is unset, still try a single resume so a live
      // Chrome/target can be harvested instead of leaving the session permanently running.
      const configuredIntervalMs = browserConfig?.autoReattachIntervalMs ?? 0;
      const connectionLostIntervalMs =
        configuredIntervalMs > 0
          ? configuredIntervalMs
          : Math.max(1_000, Math.min(browserConfig?.timeoutMs ?? 30_000, 30_000));
      const reattach = await autoReattachUntilComplete({
        sessionMeta,
        runtime: recoverableRuntime ?? undefined,
        browserConfig: {
          ...browserConfig,
          autoReattachIntervalMs: connectionLostIntervalMs,
          autoReattachDelayMs: browserConfig?.autoReattachDelayMs ?? 0,
          autoReattachTimeoutMs:
            browserConfig?.autoReattachTimeoutMs ?? browserConfig?.timeoutMs ?? 120_000,
        },
        browserMetadata: currentBrowser,
        runOptions,
        modelForStatus,
        notificationSettings,
        log,
        maxAttempts: configuredIntervalMs > 0 ? undefined : 1,
      });
      if (reattach.outcome === "exhausted") {
        currentBrowser = {
          ...currentBrowser,
          config: browserConfig,
          runtime: reattach.runtime ?? recoverableRuntime,
        };
        await sessionStore.updateSession(sessionMeta.id, {
          status: "running",
          completedAt: undefined,
          errorMessage: message,
          mode,
          browser: currentBrowser,
          response: { status: "running", incompleteReason: "chrome-disconnected" },
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
        if (modelForStatus) {
          await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
            status: "running",
            completedAt: undefined,
            response: timeoutResponse,
            error: timeoutError,
          });
        }
        await sessionStore.updateSession(sessionMeta.id, {
          status: "running",
          completedAt: undefined,
          errorMessage: message,
          mode,
          browser: {
            ...currentBrowser,
            config: browserConfig,
            runtime: autoRuntime,
          },
          response: timeoutResponse,
          error: timeoutError,
        });
        const reattach = await autoReattachUntilComplete({
          sessionMeta,
          runtime: autoRuntime,
          browserConfig,
          browserMetadata: currentBrowser,
          runOptions,
          modelForStatus,
          notificationSettings,
          log,
        });
        if (reattach.outcome !== "exhausted") {
          return;
        }
        autoRuntime = reattach.runtime ?? autoRuntime;
      }
      if (modelForStatus) {
        await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
          status: "error",
          completedAt: new Date().toISOString(),
          response: timeoutResponse,
          error: timeoutError,
        });
      }
      await sessionStore.updateSession(sessionMeta.id, {
        status: "error",
        completedAt: new Date().toISOString(),
        errorMessage: message,
        mode,
        browser: {
          ...currentBrowser,
          config: browserConfig,
          runtime: autoRuntime,
        },
        response: timeoutResponse,
        error: timeoutError,
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
    const responseMetadata = error instanceof OracleResponseError ? error.metadata : undefined;
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
    if (!cloudflareChallenge && browserCanReattach) {
      logBrowserReattachGuidance(browserRuntime ?? currentBrowser?.runtime);
    }
    await sessionStore.updateSession(sessionMeta.id, {
      status: "error",
      completedAt: new Date().toISOString(),
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
      error: userError
        ? {
            category: userError.category,
            message: userError.message,
            details: authoritativeErrorDetails,
          }
        : undefined,
    });
    if (modelForStatus) {
      await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
        status: "error",
        completedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
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

type BrowserPromptEpoch = NonNullable<BrowserRuntimeMetadata["promptEpoch"]>;

/**
 * Runtime hints are durable chronological observations. Error runtimes are snapshots captured
 * before the error escaped, so they may only replace the latest hint when they carry strictly
 * newer prompt or exact recovery authority. A terminal observation may explicitly clear the
 * settled generation. This keeps cleanup removal terminal for that generation without preventing
 * a later target/transaction generation from recovering.
 */
class MonotonicBrowserRuntimeAuthority {
  private current: BrowserRuntimeMetadata | undefined;
  private readonly settledAuthorities = new Map<string, Set<string>>();
  private errorSupersededByTerminalCleanup = false;

  constructor(initial: BrowserRuntimeMetadata | undefined) {
    this.current = initial;
  }

  observeHint(next: BrowserRuntimeMetadata): BrowserRuntimeMetadata {
    return this.observe(next, "hint");
  }

  observeError(next: BrowserRuntimeMetadata | undefined): BrowserRuntimeMetadata | undefined {
    this.errorSupersededByTerminalCleanup = false;
    return next ? this.observe(next, "error") : this.current;
  }

  observeTerminal(next: BrowserRuntimeMetadata | undefined): BrowserRuntimeMetadata | undefined {
    this.errorSupersededByTerminalCleanup = false;
    return next ? this.observe(next, "terminal") : this.current;
  }

  didTerminalCleanupSupersedeError(): boolean {
    return this.errorSupersededByTerminalCleanup;
  }

  private observe(
    next: BrowserRuntimeMetadata,
    source: "hint" | "error" | "terminal",
  ): BrowserRuntimeMetadata {
    const current = this.current;
    if (!current) {
      this.current = next;
      return next;
    }

    const relation = comparePromptEpochs(current.promptEpoch, next.promptEpoch);
    if (relation === "older" || relation === "conflict") return current;
    if (relation === "newer") {
      this.current = next;
      return next;
    }

    const promptMerged = mergeCommittedPromptAuthority(current, next);
    if (!promptMerged) return current;
    const epochKey = promptEpochKey(promptMerged.promptEpoch ?? current.promptEpoch);
    const currentHasCleanup = hasCleanupAuthority(current);
    const nextHasCleanup = hasCleanupAuthority(promptMerged);

    if (epochKey && currentHasCleanup && !nextHasCleanup && source !== "error") {
      const settled = this.settledAuthorities.get(epochKey) ?? new Set<string>();
      for (const authority of recoveryAuthorityKeys(current)) settled.add(authority);
      this.settledAuthorities.set(epochKey, settled);
      this.current = promptMerged;
      return promptMerged;
    }

    const settled = epochKey ? this.settledAuthorities.get(epochKey) : undefined;
    if (settled?.size && nextHasCleanup && !hasNewRecoveryAuthority(promptMerged, settled)) {
      if (source === "error") this.errorSupersededByTerminalCleanup = true;
      const retained = mergeWithoutCleanupRegression(current, promptMerged);
      this.current = retained;
      return retained;
    }

    if (source !== "error") {
      this.current = promptMerged;
      return promptMerged;
    }

    const selected = selectErrorRuntime(current, promptMerged);
    this.current = selected;
    return selected;
  }
}

function comparePromptEpochs(
  current: BrowserPromptEpoch | undefined,
  candidate: BrowserPromptEpoch | undefined,
): "same" | "newer" | "older" | "conflict" {
  if (!current || !candidate) return "same";
  if (candidate.followUpOrdinal !== current.followUpOrdinal) {
    return candidate.followUpOrdinal > current.followUpOrdinal ? "newer" : "older";
  }
  if (promptEpochKey(current) !== promptEpochKey(candidate)) return "conflict";
  if (
    current.status === "committed" &&
    candidate.status === "committed" &&
    committedPromptIdentity(current) !== committedPromptIdentity(candidate)
  ) {
    return "conflict";
  }
  return "same";
}

function promptEpochKey(epoch: BrowserPromptEpoch | undefined): string | undefined {
  if (!epoch) return undefined;
  return JSON.stringify([epoch.epochId, epoch.promptSha256, epoch.followUpOrdinal]);
}

function committedPromptIdentity(
  epoch: Extract<BrowserPromptEpoch, { status: "committed" }>,
): string {
  return JSON.stringify([
    epoch.epochId,
    epoch.promptSha256,
    epoch.followUpOrdinal,
    epoch.conversationId,
    epoch.verifiedUserTurnIndex,
    epoch.verifiedUserTurnId,
    epoch.verifiedUserMessageId,
  ]);
}

function mergeCommittedPromptAuthority(
  current: BrowserRuntimeMetadata,
  candidate: BrowserRuntimeMetadata,
): BrowserRuntimeMetadata | null {
  const currentEpoch = current.promptEpoch;
  const candidateEpoch = candidate.promptEpoch;
  if (candidateEpoch?.status === "committed") {
    if (
      candidate.conversationId !== undefined &&
      candidate.conversationId !== candidateEpoch.conversationId
    ) {
      return null;
    }
    return {
      ...candidate,
      conversationId: candidate.conversationId ?? candidateEpoch.conversationId,
    };
  }
  if (currentEpoch?.status !== "committed") return candidate;
  return {
    ...candidate,
    promptEpoch: currentEpoch,
    conversationId: current.conversationId ?? currentEpoch.conversationId,
    ...(candidate.tabUrl === undefined && current.tabUrl !== undefined
      ? { tabUrl: current.tabUrl }
      : {}),
  };
}

function hasCleanupAuthority(runtime: BrowserRuntimeMetadata): boolean {
  return Boolean(runtime.recoveryCleanupResources?.length || runtime.recoveryCleanupResult);
}

function cleanupRank(runtime: BrowserRuntimeMetadata): number {
  return runtime.recoveryCleanupResult?.status === "failed"
    ? 2
    : hasCleanupAuthority(runtime)
      ? 1
      : 0;
}

function selectErrorRuntime(
  current: BrowserRuntimeMetadata,
  candidate: BrowserRuntimeMetadata,
): BrowserRuntimeMetadata {
  const currentAuthorities = new Set(recoveryAuthorityKeys(current));
  const candidateAuthorities = recoveryAuthorityKeys(candidate);
  const hasNewAuthority = candidateAuthorities.some(
    (authority) => !currentAuthorities.has(authority),
  );
  if (hasNewAuthority && hasCoherentBrowserRecoveryAuthority(candidate)) return candidate;

  const currentRank = cleanupRank(current);
  const candidateRank = cleanupRank(candidate);
  if (candidateRank > currentRank) return candidate;
  if (candidateRank < currentRank) return mergeWithoutCleanupRegression(current, candidate);

  const currentEpoch = current.promptEpoch;
  const candidateEpoch = candidate.promptEpoch;
  if (currentEpoch?.status !== "committed" && candidateEpoch?.status === "committed") {
    return candidate;
  }
  return mergeWithoutCleanupRegression(current, candidate);
}

function mergeWithoutCleanupRegression(
  current: BrowserRuntimeMetadata,
  candidate: BrowserRuntimeMetadata,
): BrowserRuntimeMetadata {
  const merged: BrowserRuntimeMetadata = {
    ...current,
    ...(candidate.browserTransport ? { browserTransport: candidate.browserTransport } : {}),
    ...(candidate.chromePid !== undefined ? { chromePid: candidate.chromePid } : {}),
    ...(candidate.chromeProcessIdentity
      ? { chromeProcessIdentity: candidate.chromeProcessIdentity }
      : {}),
    ...(candidate.chromePort !== undefined ? { chromePort: candidate.chromePort } : {}),
    ...(candidate.chromeHost ? { chromeHost: candidate.chromeHost } : {}),
    ...(candidate.chromeBrowserWSEndpoint
      ? { chromeBrowserWSEndpoint: candidate.chromeBrowserWSEndpoint }
      : {}),
    ...(candidate.chromeProfileRoot ? { chromeProfileRoot: candidate.chromeProfileRoot } : {}),
    ...(candidate.userDataDir ? { userDataDir: candidate.userDataDir } : {}),
    ...(candidate.chromeTargetId ? { chromeTargetId: candidate.chromeTargetId } : {}),
    ...(candidate.tabUrl ? { tabUrl: candidate.tabUrl } : {}),
    ...(candidate.conversationId ? { conversationId: candidate.conversationId } : {}),
    ...(candidate.promptEpoch ? { promptEpoch: candidate.promptEpoch } : {}),
    ...(candidate.controllerPid !== undefined ? { controllerPid: candidate.controllerPid } : {}),
  };
  if (current.recoveryCleanupResources) {
    merged.recoveryCleanupResources = current.recoveryCleanupResources;
  }
  if (current.recoveryCleanupResult) {
    merged.recoveryCleanupResult = current.recoveryCleanupResult;
  }
  return merged;
}

function hasNewRecoveryAuthority(
  runtime: BrowserRuntimeMetadata,
  settled: ReadonlySet<string>,
): boolean {
  return (
    hasCoherentBrowserRecoveryAuthority(runtime) &&
    recoveryAuthorityKeys(runtime).some((authority) => !settled.has(authority))
  );
}

function hasCoherentBrowserRecoveryAuthority(runtime: BrowserRuntimeMetadata): boolean {
  if (!hasBrowserRecoveryAuthority(runtime)) return false;
  const epoch = runtime.promptEpoch;
  const conversationId =
    epoch?.status === "committed" ? epoch.conversationId : runtime.conversationId;
  for (const resource of runtime.recoveryCleanupResources ?? []) {
    if (conversationId && resource.conversationId && resource.conversationId !== conversationId) {
      return false;
    }
    if (
      epoch &&
      resource.promptEpoch &&
      comparePromptEpochs(epoch, resource.promptEpoch) !== "same"
    ) {
      return false;
    }
  }
  return true;
}

function recoveryAuthorityKeys(runtime: BrowserRuntimeMetadata): string[] {
  const keys = new Set<string>();
  addTargetAuthorityKey(keys, runtime.chromeTargetId, runtime.conversationId);
  for (const resource of runtime.recoveryCleanupResources ?? []) {
    addTargetAuthorityKey(
      keys,
      resource.chromeTargetId,
      resource.conversationId ?? runtime.conversationId,
    );
    if (resource.remoteRecovery?.transactionToken) {
      keys.add(`remote:${resource.remoteRecovery.transactionToken}`);
    }
    if (resource.acquisition?.generationId) {
      keys.add(`generation:${resource.acquisition.generationId}`);
    }
    if (resource.tabLease?.id) keys.add(`lease:${resource.tabLease.id}`);
    if (resource.chromeProcessIdentity) {
      const identity = resource.chromeProcessIdentity;
      keys.add(
        `process:${identity.pid}:${identity.processStartTime}:${identity.launchNonce}:${identity.normalizedUserDataDir}`,
      );
    } else if (resource.chromePid !== undefined) {
      keys.add(`pid:${resource.chromePid}:${resource.userDataDir ?? ""}`);
    }
  }
  return [...keys];
}

function addTargetAuthorityKey(
  keys: Set<string>,
  targetId: string | undefined,
  conversationId: string | undefined,
): void {
  if (!targetId?.trim()) return;
  keys.add(`target:${targetId.trim()}:${conversationId?.trim() ?? ""}`);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasRemoteRecoveryAuthority(runtime: BrowserRuntimeMetadata | null | undefined): boolean {
  return Boolean(runtime?.recoveryCleanupResources?.some((resource) => resource.remoteRecovery));
}

function hasBrowserRecoveryAuthority(runtime: BrowserRuntimeMetadata | null | undefined): boolean {
  return hasRemoteRecoveryAuthority(runtime) || hasRecoverableChatGptConversation(runtime);
}

function hasResumableBrowserAuthority(runtime: BrowserRuntimeMetadata | null | undefined): boolean {
  return (
    (hasRemoteRecoveryAuthority(runtime) && !runtime?.recoveryCleanupResult?.settlementMode) ||
    hasRecoverableChatGptConversation(runtime)
  );
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

type AutoReattachOutcome = {
  outcome: "completed" | "terminal" | "exhausted";
  runtime?: BrowserRuntimeMetadata;
};
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

async function autoReattachUntilComplete({
  sessionMeta,
  runtime,
  browserConfig,
  browserMetadata,
  runOptions,
  modelForStatus,
  notificationSettings,
  log,
  maxAttempts,
}: {
  sessionMeta: SessionMetadata;
  runtime?: BrowserRuntimeMetadata;
  browserConfig?: BrowserSessionConfig;
  browserMetadata?: SessionMetadata["browser"];
  runOptions: RunOracleOptions;
  modelForStatus?: string;
  notificationSettings: NotificationSettings;
  log: (message?: string) => void;
  maxAttempts?: number;
}): Promise<AutoReattachOutcome> {
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
  const maxTotalMs = 2 * 60 * 60 * 1000; // 2h hard cap; avoid infinite polling by default.
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
    if (message) {
      log(dim(message));
    }
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
    let reattachResult: ReattachResult | null = null;
    let answerReceipt: DurableBrowserAnswerReceipt | undefined;
    let authoritativeRuntime = retryRuntime;
    let remotePublicationAcknowledged = false;
    try {
      const reattachConfig: BrowserSessionConfig = {
        ...browserConfig,
        timeoutMs,
      };
      reattachResult = await resumeBrowserSession(retryRuntime, reattachConfig, logger, {
        recoveryLockPath,
        isRemotePublicationAcknowledged: () => remotePublicationAcknowledged,
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
      });
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
      const publication = await publishBrowserCapture({
        answerOptions: {
          sessionId: sessionMeta.id,
          answer: answerText,
          logHeader: `[auto-reattach] captured assistant response on attempt ${attempt}`,
        },
        transaction: reattachResult,
        persistAnswer: persistDurableBrowserAnswer,
        prepare: async (receipt) => {
          answerReceipt = receipt;
          const artifacts = await ensureSessionArtifacts({
            sessionId: sessionMeta.id,
            prompt: runOptions.prompt,
            answerMarkdown: answerText,
            conversationUrl: reattachResult?.runtime.tabUrl,
            browserConfig,
            existingArtifacts: sessionMeta.artifacts,
            logger,
          });
          return { artifacts };
        },
        publish: async (receipt, prepared) => {
          await sessionStore.updateSession(sessionMeta.id, {
            status: "completed",
            completedAt: new Date().toISOString(),
            usage,
            errorMessage: undefined,
            browser: {
              ...browserMetadata,
              config: browserConfig,
              runtime: reattachResult?.runtime ?? authoritativeRuntime,
            },
            artifacts: mergeArtifacts(mergeArtifacts(sessionMeta.artifacts, prepared.artifacts), [
              receipt.artifact,
            ]),
            response: { status: "completed" },
            error: undefined,
            transport: undefined,
          });
          remotePublicationAcknowledged = true;
        },
        persistRuntime: async (latestRuntime) => {
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
      });
      durablyCompleted = true;
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
      if (modelForStatus) {
        await sessionStore
          .updateModelRun(sessionMeta.id, modelForStatus, {
            status: "completed",
            completedAt: new Date().toISOString(),
            usage,
          })
          .catch((error) => {
            log(
              dim(
                `Auto-reattach answer published; model-run projection failed: ${formatError(error)}`,
              ),
            );
          });
      }
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
        await sessionStore.updateSession(sessionMeta.id, {
          status: "error",
          completedAt: new Date().toISOString(),
          errorMessage: message,
          browser: {
            ...browserMetadata,
            config: browserConfig,
            runtime: failureRuntime,
          },
          ...(answerReceipt
            ? { artifacts: mergeArtifacts(sessionMeta.artifacts, [answerReceipt.artifact]) }
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
