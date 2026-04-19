import kleur from "kleur";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  SessionMetadata,
  SessionMode,
  BrowserSessionConfig,
  BrowserRuntimeMetadata,
  SessionProgressMetadata,
  SupervisorThreadBindingMetadata,
} from "../sessionStore.js";
import type { RunOracleOptions, UsageSummary } from "../oracle.js";
import {
  runOracle,
  OracleResponseError,
  OracleTransportError,
  BrowserAutomationError,
  extractResponseMetadata,
  asOracleUserError,
  extractTextOutput,
} from "../oracle.js";
import {
  runBrowserSessionExecution,
  continueBrowserSessionExecution,
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
import { runMultiModelApiSession } from "../oracle/multiModelRunner.js";
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
import { resumeBrowserSession } from "../browser/reattach.js";
import {
  conversationHrefMatchesConfiguredScope,
  extractConversationIdFromUrl,
} from "../browser/reattachHelpers.js";
import { estimateTokenCount } from "../browser/utils.js";
import type { BrowserLogger, BrowserProgressUpdate } from "../browser/types.js";
import { formatElapsed } from "../oracle/format.js";

const isTty = process.stdout.isTTY;
const dim = (text: string): string => (isTty ? kleur.dim(text) : text);

function mergeBrowserRuntime(
  runtime: BrowserRuntimeMetadata | undefined,
  updates?: Partial<BrowserRuntimeMetadata>,
): BrowserRuntimeMetadata | undefined {
  if (!runtime && !updates) {
    return undefined;
  }
  const tabUrlProvided = Boolean(
    updates && Object.prototype.hasOwnProperty.call(updates, "tabUrl"),
  );
  const tabUrl = updates?.tabUrl ?? runtime?.tabUrl;
  const derivedConversationId = tabUrl ? extractConversationIdFromUrl(tabUrl) : undefined;
  const next = {
    ...(runtime ?? {}),
    ...(updates ?? {}),
    ...(tabUrlProvided ? { conversationId: updates?.conversationId ?? derivedConversationId } : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

function observedRuntimeConversationId(
  runtime: BrowserRuntimeMetadata | undefined,
): string | undefined {
  const fromUrl = extractConversationIdFromUrl(runtime?.tabUrl ?? "");
  if (fromUrl) {
    return fromUrl;
  }
  const explicit = runtime?.conversationId?.trim();
  return explicit ? explicit : undefined;
}

function buildSessionProgress(
  update: BrowserProgressUpdate,
  runtime?: BrowserRuntimeMetadata,
): SessionProgressMetadata {
  return {
    stage: update.stage,
    message: update.message,
    updatedAt: new Date().toISOString(),
    conversationId: update.runtime?.conversationId ?? runtime?.conversationId,
    tabUrl: update.runtime?.tabUrl ?? runtime?.tabUrl,
    chromeTargetId: update.runtime?.chromeTargetId ?? runtime?.chromeTargetId,
  };
}

function normalizeSupervisorThreadBinding(
  value: SessionMetadata["supervisorThread"] | null | undefined,
): SupervisorThreadBindingMetadata | null {
  const conversationId = value?.conversationId?.trim();
  if (!conversationId) {
    return null;
  }
  return {
    conversationId,
    url: value?.url?.trim() || undefined,
    projectUrl: value?.projectUrl?.trim() || undefined,
    verifiedAt: value?.verifiedAt?.trim() || new Date(0).toISOString(),
  };
}

function applySupervisorThreadBindingToRuntime(
  runtime: BrowserRuntimeMetadata | undefined,
  binding: SupervisorThreadBindingMetadata | null,
): BrowserRuntimeMetadata | undefined {
  if (!binding) {
    return runtime;
  }
  return {
    ...(runtime ?? {}),
    conversationId: binding.conversationId,
    tabUrl: binding.url ?? runtime?.tabUrl,
  };
}

function stabilizeRuntimeWithSupervisorThread(
  runtime: BrowserRuntimeMetadata | undefined,
  binding: SupervisorThreadBindingMetadata | null,
): BrowserRuntimeMetadata | undefined {
  if (!runtime && !binding) {
    return undefined;
  }
  const next: BrowserRuntimeMetadata = {
    ...(runtime ?? {}),
  };
  if (!next.tabUrl && binding?.url) {
    next.tabUrl = binding.url;
  }
  const conversationId = observedRuntimeConversationId(next);
  if (conversationId) {
    next.conversationId = conversationId;
  } else if (binding?.conversationId) {
    next.conversationId = binding.conversationId;
    if (binding.url) {
      next.tabUrl = binding.url;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function observedRuntimeViolatesSupervisorThread(
  runtime: BrowserRuntimeMetadata | undefined,
  binding: SupervisorThreadBindingMetadata | null,
): boolean {
  if (!runtime || !binding) {
    return false;
  }
  const conversationId = observedRuntimeConversationId(runtime);
  if (conversationId) {
    return conversationId !== binding.conversationId;
  }
  const tabUrl = runtime.tabUrl?.trim();
  const projectUrl = binding.projectUrl?.trim();
  if (tabUrl && projectUrl) {
    return !conversationHrefMatchesConfiguredScope(tabUrl, projectUrl);
  }
  return false;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  const sessionSupervisorThread = normalizeSupervisorThreadBinding(sessionMeta.supervisorThread);
  let latestObservedBrowserRuntime = sessionMeta.browser?.runtime;
  let activeSupervisorThread = sessionSupervisorThread;
  let latestBrowserRuntime = stabilizeRuntimeWithSupervisorThread(
    latestObservedBrowserRuntime,
    activeSupervisorThread,
  );
  const browserSessionLogWriter =
    mode === "browser" ? sessionStore.createLogWriter(sessionMeta.id) : null;
  const browserModelLogWriter =
    mode === "browser" && sessionMeta.model
      ? sessionStore.createLogWriter(sessionMeta.id, sessionMeta.model)
      : null;
  const browserSessionLog = (message?: string): void => {
    if (!message) {
      return;
    }
    browserSessionLogWriter?.logLine(message);
    browserModelLogWriter?.logLine(message);
  };
  const persistBrowserProgress = async (update: BrowserProgressUpdate): Promise<void> => {
    latestObservedBrowserRuntime = mergeBrowserRuntime(
      latestObservedBrowserRuntime,
      update.runtime,
    );
    latestBrowserRuntime = stabilizeRuntimeWithSupervisorThread(
      latestObservedBrowserRuntime,
      activeSupervisorThread,
    );
    try {
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        mode,
        browser: browserConfig
          ? {
              config: browserConfig,
              runtime: latestBrowserRuntime,
            }
          : undefined,
        progress: buildSessionProgress(update, latestBrowserRuntime),
      });
    } catch (error) {
      browserSessionLog(
        `[browser-progress:error] Failed to persist browser progress: ${describeError(error)}`,
      );
    }
  };
  const writeInline = (chunk: string): boolean => {
    // Keep session logs intact while still echoing inline output to the user.
    write(chunk);
    return muteStdout ? true : process.stdout.write(chunk);
  };
  await sessionStore.updateSession(sessionMeta.id, {
    status: "running",
    startedAt: new Date().toISOString(),
    mode,
    progress:
      mode === "browser"
        ? {
            stage: "starting",
            message: "Starting browser session.",
            updatedAt: new Date().toISOString(),
            conversationId: latestBrowserRuntime?.conversationId,
            tabUrl: latestBrowserRuntime?.tabUrl,
            chromeTargetId: latestBrowserRuntime?.chromeTargetId,
          }
        : undefined,
    ...(browserConfig ? { browser: { config: browserConfig } } : {}),
  });
  const notificationSettings =
    notifications ?? deriveNotificationSettingsFromMetadata(sessionMeta, process.env);
  const modelForStatus = runOptions.model ?? sessionMeta.model;
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
        persistRuntimeHint: async (runtime: BrowserRuntimeMetadata) => {
          latestObservedBrowserRuntime = mergeBrowserRuntime(latestObservedBrowserRuntime, runtime);
          latestBrowserRuntime = stabilizeRuntimeWithSupervisorThread(
            latestObservedBrowserRuntime,
            activeSupervisorThread,
          );
          try {
            await sessionStore.updateSession(sessionMeta.id, {
              status: "running",
              browser: { config: browserConfig, runtime: latestBrowserRuntime },
            });
          } catch (error) {
            browserSessionLog(
              `[browser-progress:error] Failed to persist browser runtime hint: ${describeError(error)}`,
            );
          }
        },
      };
      const parentSessionId = sessionMeta.options?.followupSessionId?.trim();
      const parentSession =
        parentSessionId && parentSessionId !== sessionMeta.id
          ? await sessionStore.readSession(parentSessionId)
          : null;
      let effectiveParentSession = parentSession;
      const effectiveSupervisorThread =
        sessionSupervisorThread ??
        normalizeSupervisorThreadBinding(parentSession?.supervisorThread);
      activeSupervisorThread = effectiveSupervisorThread;
      latestBrowserRuntime = stabilizeRuntimeWithSupervisorThread(
        latestObservedBrowserRuntime,
        activeSupervisorThread,
      );
      if (parentSessionId && parentSessionId !== sessionMeta.id) {
        if (!parentSession) {
          throw new Error(
            `Browser follow-up parent session ${parentSessionId} could not be found.`,
          );
        }
        if ((parentSession.mode ?? parentSession.options?.mode) !== "browser") {
          throw new Error(`Session ${parentSessionId} is not a browser session.`);
        }
        const parentSessionStatus = String(parentSession.status ?? "").toLowerCase();
        const parentResponseStatus = String(parentSession.response?.status ?? "").toLowerCase();
        const parentIncompleteReason = parentSession.response?.incompleteReason?.trim() || null;
        if (
          parentSessionStatus !== "completed" ||
          (parentResponseStatus && parentResponseStatus !== "completed") ||
          parentIncompleteReason
        ) {
          const reason = parentIncompleteReason
            ? `${parentSessionStatus || parentResponseStatus || "incomplete"} (${parentIncompleteReason})`
            : parentSessionStatus || parentResponseStatus || "incomplete";
          throw new Error(
            `Browser follow-up parent session ${parentSessionId} is not reusable yet (${reason}).`,
          );
        }
        const parentModel = String(
          parentSession.model ?? parentSession.options?.model ?? "",
        ).toLowerCase();
        const requestedModel = String(runOptions.model ?? sessionMeta.model ?? "").toLowerCase();
        if (parentModel.startsWith("gemini") || requestedModel.startsWith("gemini")) {
          throw new Error(
            "Browser follow-up currently supports ChatGPT/GPT browser sessions only.",
          );
        }
        const effectiveRuntime =
          parentSession.browser?.runtime || sessionMeta.browser?.runtime
            ? applySupervisorThreadBindingToRuntime(
                {
                  ...(parentSession.browser?.runtime ?? {}),
                  ...(sessionMeta.browser?.runtime ?? {}),
                },
                effectiveSupervisorThread,
              )
            : undefined;
        const effectiveResponse = sessionMeta.response?.assistantOutput?.trim()
          ? sessionMeta.response
          : parentSession.response;
        effectiveParentSession = {
          ...parentSession,
          supervisorThread: effectiveSupervisorThread ?? undefined,
          response: effectiveResponse,
          browser: {
            config: sessionMeta.browser?.config ?? parentSession.browser?.config ?? browserConfig,
            runtime: effectiveRuntime,
          },
        };
        if (effectiveRuntime) {
          latestObservedBrowserRuntime = effectiveRuntime;
          latestBrowserRuntime = effectiveRuntime;
          await sessionStore.updateSession(sessionMeta.id, {
            status: "running",
            browser: {
              config: browserConfig,
              runtime: effectiveRuntime,
            },
          });
        }
      }
      const downloadsDir = path.join(sessionStore.sessionsDir(), sessionMeta.id, "downloads");
      const result = effectiveParentSession
        ? await continueBrowserSessionExecution(
            {
              runOptions,
              browserConfig,
              downloadsDir,
              cwd,
              log,
              sessionLog: browserSessionLog,
              persistProgress: persistBrowserProgress,
              parentSession: effectiveParentSession,
            },
            runnerDeps,
          )
        : await runBrowserSessionExecution(
            {
              runOptions,
              browserConfig,
              downloadsDir,
              cwd,
              log,
              sessionLog: browserSessionLog,
              persistProgress: persistBrowserProgress,
            },
            runnerDeps,
          );
      const observedBrowserRuntime = mergeBrowserRuntime(
        latestObservedBrowserRuntime,
        result.runtime,
      );
      const finalizedBrowserRuntime = stabilizeRuntimeWithSupervisorThread(
        observedBrowserRuntime,
        activeSupervisorThread,
      );
      if (
        effectiveSupervisorThread &&
        observedRuntimeViolatesSupervisorThread(observedBrowserRuntime, effectiveSupervisorThread)
      ) {
        throw new BrowserAutomationError(
          `Browser follow-up drifted to Oracle conversation ${observedRuntimeConversationId(observedBrowserRuntime) ?? "unknown"} while ${effectiveSupervisorThread.conversationId} was required.`,
          {
            stage: "browser-followup-thread-identity-mismatch",
            runtime: observedBrowserRuntime,
            expectedConversationId: effectiveSupervisorThread.conversationId,
          },
        );
      }
      latestObservedBrowserRuntime = observedBrowserRuntime;
      latestBrowserRuntime = finalizedBrowserRuntime ?? latestBrowserRuntime;
      const attemptedOutputWrite = Boolean(runOptions.writeOutputPath);
      const savedOutputPath = await writeAssistantOutput(
        runOptions.writeOutputPath,
        result.answerText ?? "",
        log,
      );
      const nextOptions = finalizeSessionOutputOptions(
        sessionMeta.options,
        savedOutputPath,
        attemptedOutputWrite,
      );
      if (modelForStatus) {
        await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
          status: "completed",
          completedAt: new Date().toISOString(),
          usage: result.usage,
        });
      }
      await sessionStore.updateSession(sessionMeta.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        usage: result.usage,
        elapsedMs: result.elapsedMs,
        browser: {
          config: browserConfig,
          runtime: latestBrowserRuntime,
        },
        progress: {
          stage: "assistant-completed",
          message: "Captured the assistant response.",
          updatedAt: new Date().toISOString(),
          conversationId: latestBrowserRuntime?.conversationId,
          tabUrl: latestBrowserRuntime?.tabUrl,
          chromeTargetId: latestBrowserRuntime?.chromeTargetId,
        },
        options: nextOptions,
        response: {
          status: "completed",
          assistantOutput: result.answerText ?? "",
          downloads: result.downloads,
        },
        transport: undefined,
        error: undefined,
      });
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
      );
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
      await sessionStore.updateSession(sessionMeta.id, {
        status: hasFailure ? "error" : "completed",
        completedAt: new Date().toISOString(),
        usage: aggregateUsage,
        elapsedMs: summary.elapsedMs,
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
        if (savedOutputs.length > 0) {
          log(dim("Saved outputs:"));
          for (const item of savedOutputs) {
            log(dim(`- ${item.model} -> ${item.path}`));
          }
        }
      }
      if (hasFailure) {
        throw summary.rejected[0].reason;
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
    const attemptedOutputWrite = Boolean(runOptions.writeOutputPath);
    const savedOutputPath = await writeAssistantOutput(runOptions.writeOutputPath, answerText, log);
    const nextOptions = finalizeSessionOutputOptions(
      sessionMeta.options,
      savedOutputPath,
      attemptedOutputWrite,
    );
    await sessionStore.updateSession(sessionMeta.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      usage: result.usage,
      elapsedMs: result.elapsedMs,
      options: nextOptions,
      response: extractResponseMetadata(result.response),
      transport: undefined,
      error: undefined,
    });
    if (modelForStatus && singleModelOverride == null) {
      await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
        status: "completed",
        completedAt: new Date().toISOString(),
        usage: result.usage,
      });
    }
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
    const assistantRateLimit =
      userError?.category === "browser-automation" &&
      (userError.details as { stage?: string } | undefined)?.stage === "assistant-rate-limit";
    const cloudflareChallenge =
      userError?.category === "browser-automation" &&
      (userError.details as { stage?: string } | undefined)?.stage === "cloudflare-challenge";
    const cloudflareBackendChallenge =
      userError?.category === "browser-automation" &&
      (userError.details as { stage?: string } | undefined)?.stage ===
        "cloudflare-backend-challenge";
    if (connectionLost && mode === "browser") {
      const runtime = (userError.details as { runtime?: BrowserRuntimeMetadata } | undefined)
        ?.runtime;
      latestBrowserRuntime = runtime ?? latestBrowserRuntime;
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
          config: browserConfig,
          runtime: runtime ?? latestBrowserRuntime,
        },
        response: { status: "running", incompleteReason: "chrome-disconnected" },
      });
      return;
    }
    if (assistantTimeout && mode === "browser") {
      const runtime = (userError.details as { runtime?: BrowserRuntimeMetadata } | undefined)
        ?.runtime;
      latestBrowserRuntime = runtime ?? latestBrowserRuntime;
      log(dim("Assistant response timed out; keeping session running for reattach."));
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
          config: browserConfig,
          runtime: runtime ?? latestBrowserRuntime,
        },
        response: { status: "running", incompleteReason: "assistant-timeout" },
      });
      const autoReattachIntervalMs = browserConfig?.autoReattachIntervalMs ?? 0;
      if (autoReattachIntervalMs > 0) {
        const autoRuntime = runtime ?? latestBrowserRuntime;
        const success = await autoReattachUntilComplete({
          sessionMeta,
          runtime: autoRuntime ?? undefined,
          browserConfig,
          runOptions,
          modelForStatus,
          notificationSettings,
          log,
        });
        if (success) {
          return;
        }
      }
      log(dim(`Reattach later with: oracle session ${sessionMeta.id}`));
      return;
    }
    if (assistantRateLimit && mode === "browser") {
      log(
        dim(
          "ChatGPT temporarily rate-limited this browser profile; wait a few minutes before retrying.",
        ),
      );
    }
    if (cloudflareChallenge && mode === "browser") {
      const details = userError.details as { reuseProfileHint?: string } | undefined;
      if (details?.reuseProfileHint) {
        log(
          dim("Cloudflare challenge detected; browser left running so you can complete the check."),
        );
        log(dim(`Reuse this browser profile with: ${details.reuseProfileHint}`));
      } else {
        log(
          dim(
            "Cloudflare challenge detected in true headless mode; no reusable browser was left running.",
          ),
        );
      }
    }
    if (cloudflareBackendChallenge && mode === "browser") {
      log(
        dim(
          "Cloudflare is challenging ChatGPT backend API requests in this browser runtime; Oracle cannot submit prompts or capture replies here.",
        ),
      );
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
    const browserRuntime =
      mode === "browser"
        ? ((userError?.details as { runtime?: BrowserRuntimeMetadata } | undefined)?.runtime ??
          latestBrowserRuntime)
        : undefined;
    await sessionStore.updateSession(sessionMeta.id, {
      status: "error",
      completedAt: new Date().toISOString(),
      errorMessage: message,
      mode,
      browser: browserConfig
        ? {
            config: browserConfig,
            runtime: browserRuntime ?? undefined,
          }
        : undefined,
      progress:
        mode === "browser"
          ? {
              stage: "error",
              message,
              updatedAt: new Date().toISOString(),
              conversationId: browserRuntime?.conversationId,
              tabUrl: browserRuntime?.tabUrl,
              chromeTargetId: browserRuntime?.chromeTargetId,
            }
          : undefined,
      response: responseMetadata,
      transport: transportMetadata,
      error: userError
        ? {
            category: userError.category,
            message: userError.message,
            details: userError.details,
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
  } finally {
    browserSessionLogWriter?.stream.end();
    browserModelLogWriter?.stream.end();
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function finalizeSessionOutputOptions(
  options: SessionMetadata["options"],
  savedOutputPath: string | undefined,
  attemptedOutputWrite: boolean,
): SessionMetadata["options"] {
  if (!options && !savedOutputPath && !attemptedOutputWrite) {
    return {};
  }
  const next = { ...(options ?? {}) };
  if (savedOutputPath) {
    next.writeOutputPath = savedOutputPath;
  } else if (attemptedOutputWrite) {
    delete next.writeOutputPath;
  }
  return next;
}

async function autoReattachUntilComplete({
  sessionMeta,
  runtime,
  browserConfig,
  runOptions,
  modelForStatus,
  notificationSettings,
  log,
}: {
  sessionMeta: SessionMetadata;
  runtime?: BrowserRuntimeMetadata;
  browserConfig?: BrowserSessionConfig;
  runOptions: RunOracleOptions;
  modelForStatus?: string;
  notificationSettings: NotificationSettings;
  log: (message?: string) => void;
}): Promise<boolean> {
  if (!runtime || !browserConfig) {
    log(dim("Auto-reattach disabled: missing runtime or browser config."));
    return false;
  }
  const delayMs = Math.max(0, browserConfig.autoReattachDelayMs ?? 0);
  const intervalMs = Math.max(0, browserConfig.autoReattachIntervalMs ?? 0);
  if (intervalMs <= 0) {
    return false;
  }
  const timeoutMs =
    Math.max(0, browserConfig.autoReattachTimeoutMs ?? 0) ||
    Math.max(0, browserConfig.timeoutMs ?? 0) ||
    120_000;
  const maxTotalMs = timeoutMs;
  const maxDeadline = Date.now() + maxTotalMs;

  if (delayMs > 0) {
    log(dim(`Auto-reattach starting in ${formatElapsed(delayMs)}...`));
    await wait(delayMs);
  }
  log(dim(`Auto-reattach will stop after ${formatElapsed(maxTotalMs)} if no answer is captured.`));

  const logger: BrowserLogger = ((message?: string) => {
    if (message) {
      log(dim(message));
    }
  }) as BrowserLogger;
  logger.verbose = true;
  let currentRuntime = runtime;

  let attempt = 0;
  for (;;) {
    const remainingBudgetMs = maxDeadline - Date.now();
    if (remainingBudgetMs <= 0) {
      log(
        dim(
          `Auto-reattach stopped after ${formatElapsed(maxTotalMs)} without capturing an answer.`,
        ),
      );
      return false;
    }
    attempt += 1;
    log(dim(`Auto-reattach attempt ${attempt}...`));
    try {
      const reattachConfig: BrowserSessionConfig = {
        ...browserConfig,
        timeoutMs: Math.min(timeoutMs, remainingBudgetMs),
      };
      const result = await resumeBrowserSession(currentRuntime, reattachConfig, logger, {
        promptPreview: sessionMeta.promptPreview,
        downloadsDir: path.join(sessionStore.sessionsDir(), sessionMeta.id, "downloads"),
      });
      currentRuntime = result.runtime ?? currentRuntime;
      const answerText = result.answerMarkdown || result.answerText || "";
      const outputTokens = estimateTokenCount(answerText);
      const attemptedOutputWrite = Boolean(runOptions.writeOutputPath);
      const savedOutputPath = await writeAssistantOutput(
        runOptions.writeOutputPath,
        answerText,
        log,
      );
      const nextOptions = finalizeSessionOutputOptions(
        sessionMeta.options,
        savedOutputPath,
        attemptedOutputWrite,
      );
      const logWriter = sessionStore.createLogWriter(sessionMeta.id);
      logWriter.logLine(`[auto-reattach] captured assistant response on attempt ${attempt}`);
      logWriter.logLine("Answer:");
      logWriter.logLine(answerText);
      logWriter.stream.end();
      if (modelForStatus) {
        await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
          status: "completed",
          completedAt: new Date().toISOString(),
          usage: {
            inputTokens: 0,
            outputTokens,
            reasoningTokens: 0,
            totalTokens: outputTokens,
          },
        });
      }
      await sessionStore.updateSession(sessionMeta.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        usage: {
          inputTokens: 0,
          outputTokens,
          reasoningTokens: 0,
          totalTokens: outputTokens,
        },
        browser: {
          config: browserConfig,
          runtime: currentRuntime,
        },
        options: nextOptions,
        response: {
          status: "completed",
          assistantOutput: answerText,
          downloads: result.downloads,
        },
        error: undefined,
        transport: undefined,
      });
      await sendSessionNotification(
        {
          sessionId: sessionMeta.id,
          sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
          mode: sessionMeta.mode ?? "browser",
          model: sessionMeta.model ?? runOptions.model,
          usage: {
            inputTokens: 0,
            outputTokens,
          },
          characters: answerText.length,
        },
        notificationSettings,
        log,
        answerText.slice(0, 140),
      );
      log(kleur.green("Auto-reattach succeeded; session marked completed."));
      return true;
    } catch (error) {
      const userError = asOracleUserError(error);
      if (
        userError?.category === "browser-automation" &&
        (userError.details as { stage?: string } | undefined)?.stage === "assistant-rate-limit"
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      log(dim(`Auto-reattach attempt ${attempt} failed: ${message}`));
    }
    const remainingAfterAttemptMs = maxDeadline - Date.now();
    if (remainingAfterAttemptMs <= 0) {
      log(
        dim(
          `Auto-reattach stopped after ${formatElapsed(maxTotalMs)} without capturing an answer.`,
        ),
      );
      return false;
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
