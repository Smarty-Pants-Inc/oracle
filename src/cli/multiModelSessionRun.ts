import fs from "node:fs/promises";
import path from "node:path";
import kleur from "kleur";

import {
  asOracleUserError,
  classifyProviderFailure,
  OracleResponseError,
  OracleTransportError,
  runOracle,
} from "../oracle.js";
import type { ProviderFailureContext, RunOracleOptions, UsageSummary } from "../oracle.js";
import { MODEL_CONFIGS, DEFAULT_SYSTEM_PROMPT } from "../oracle/config.js";
import { readFiles } from "../oracle/files.js";
import { formatFinishLine } from "../oracle/finishLine.js";
import { isKnownModel, resolveModelConfig } from "../oracle/modelResolver.js";
import { runMultiModelApiSession, type MultiModelRunSummary } from "../oracle/multiModelRunner.js";
import { buildPrompt, buildRequestBody } from "../oracle/request.js";
import { formatTokenEstimate, formatTokenValue } from "../oracle/runUtils.js";
import { estimateRequestTokens } from "../oracle/tokenEstimate.js";
import type { SessionMetadata, SessionModelRun } from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";
import { formatError } from "./errorUtils.js";
import { renderMarkdownAnsi } from "./markdownRenderer.js";
import { sendSessionNotification } from "./notifier.js";
import { sanitizeOscProgress } from "./oscUtils.js";
import { dim, isTty, writeAssistantOutput } from "./sessionRunSupport.js";
import type { SessionRunContext } from "./sessionRunTypes.js";

export async function runMultiModelSession(
  context: SessionRunContext,
  multiModels: NonNullable<RunOracleOptions["models"]>,
): Promise<void> {
  const { sessionMeta, runOptions, cwd, log, version, muteStdout, notificationSettings } = context;
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
  if ((runOptions.prompt?.trim().length ?? 0) < 80) {
    multiRunTips.push(
      "Tip: brief prompts often yield generic answers — aim for 6–30 sentences and attach key files.",
    );
  }
  for (const tip of multiRunTips) {
    log(dim(tip));
  }

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

  const writeInline = (chunk: string): boolean => {
    context.write(chunk);
    return muteStdout ? true : process.stdout.write(chunk);
  };
  const shouldStreamInline = !muteStdout && process.stdout.isTTY;
  const shouldRenderMarkdown = shouldStreamInline && runOptions.renderPlain !== true;
  const printedModels = new Set<string>();
  const answerFallbacks = new Map<string, string>();
  const stripOscProgress = (text: string): string => sanitizeOscProgress(text, shouldStreamInline);

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
    .map((value, index) =>
      formatTokenValue(
        value,
        {
          input_tokens: aggregateUsage.inputTokens,
          output_tokens: aggregateUsage.outputTokens,
          reasoning_tokens: aggregateUsage.reasoningTokens,
          total_tokens: aggregateUsage.totalTokens,
        },
        index,
      ),
    )
    .join("/");
  const tokenParts = tokensDisplay.split("/");
  const tokensPart =
    tokenParts.length === 4
      ? `↑${tokenParts[0]} ↓${tokenParts[1]} ↻${tokenParts[2]} Δ${tokenParts[3]}`
      : tokensDisplay;
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
  const status = hasFailure ? (allowPartial ? "partial" : "error") : "completed";
  await sessionStore.updateSession(sessionMeta.id, {
    status,
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
      mode: context.mode,
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
    const runLogs = await collectMultiModelRunLogs(sessionMeta.id, sessionWithRuns.models, summary);
    const manifestPath = await writeMultiModelOutputManifest({
      baseOutputPath: runOptions.writeOutputPath,
      sessionId: sessionMeta.id,
      status,
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

function deriveOutputManifestPath(basePath: string): string {
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
    log(dim(`output manifest failed (${formatError(error)}); session completed anyway.`));
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
