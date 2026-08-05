import path from "node:path";
import type {
  BrowserRunOptions,
  BrowserRunResult,
  BrowserRunTransaction,
  BrowserLogger,
  CookieParam,
} from "../browser/types.js";
import { getCookies } from "@steipete/sweet-cookie";
import { runProviderSubmissionFlow } from "../browser/providerDomFlow.js";
import {
  BrowserCaptureSettlementController,
  BrowserRunLifecycleController,
  completedBrowserCaptureCleanup,
  createBrowserRunTransaction,
  markBrowserCaptureCleanupPending,
  pendingBrowserCaptureCleanup,
  type BrowserCaptureSettlementAdapters,
} from "../browser/runLifecycle.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { delay } from "../browser/utils.js";
import { runGeminiWebWithFallback, saveFirstGeminiImageFromOutput } from "./client.js";
import { geminiDeepThinkDomProvider } from "../browser/providers/index.js";
import { resolveGeminiWebModel, type GeminiWebModelId } from "./models.js";
import type { GeminiWebOptions, GeminiWebResponse } from "./types.js";
import { openGeminiBrowserSession, type GeminiBrowserSession } from "./browserSessionManager.js";
import { selectGeminiExecutionMode } from "./executionMode.js";
import type { IGeminiExecutionClient } from "./executionClients.js";

const GEMINI_COOKIE_NAMES = [
  "__Secure-1PSID",
  "__Secure-1PSIDTS",
  "__Secure-1PSIDCC",
  "__Secure-1PAPISID",
  "NID",
  "AEC",
  "SOCS",
  "__Secure-BUCKET",
  "__Secure-ENID",
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "__Secure-3PSID",
  "__Secure-3PSIDTS",
  "__Secure-3PAPISID",
  "SIDCC",
] as const;

const GEMINI_REQUIRED_COOKIES = ["__Secure-1PSID", "__Secure-1PSIDTS"] as const;

interface GeminiCookieLoadResult {
  cookieMap: Record<string, string>;
  warnings: string[];
  cleanupSession?: GeminiBrowserSession;
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function createSettledGeminiTransaction(
  result: BrowserRunResult,
  runtime: BrowserRuntimeMetadata = {},
): BrowserRunTransaction {
  const finalization = completedBrowserCaptureCleanup(runtime);
  return {
    ...result,
    runtime: finalization.runtime,
    finalize: async () => finalization,
    abort: async () => finalization,
  };
}

function combineGeminiSessionRuntime(sessions: GeminiBrowserSession[]): BrowserRuntimeMetadata {
  const runtimes = sessions.map((session) => session.runtime());
  const first = runtimes[0] ?? {};
  const recoveryCleanupResources = runtimes.flatMap(
    (runtime) => runtime.recoveryCleanupResources ?? [],
  );
  return {
    ...first,
    ...(recoveryCleanupResources.length > 0 ? { recoveryCleanupResources } : {}),
  };
}

async function settleGeminiSessions(sessions: GeminiBrowserSession[]): Promise<string | null> {
  const errors: string[] = [];
  for (const session of sessions) {
    try {
      await session.close();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors.length > 0 ? [...new Set(errors)].join("; ") : null;
}

function createGeminiSettlementAdapters(
  sessions: GeminiBrowserSession[],
  persistRuntime?: (runtime: BrowserRuntimeMetadata) => void | Promise<void>,
): BrowserCaptureSettlementAdapters {
  return {
    ...(persistRuntime
      ? { persistRuntime: async (runtime: BrowserRuntimeMetadata) => persistRuntime(runtime) }
      : {}),
    settleResources: async (mode) => {
      const error = await settleGeminiSessions(sessions);
      const runtime = combineGeminiSessionRuntime(sessions);
      return error
        ? pendingBrowserCaptureCleanup(markBrowserCaptureCleanupPending(runtime, mode), error, mode)
        : completedBrowserCaptureCleanup(runtime);
    },
  };
}

function createGeminiRunLifecycle(
  sessions: GeminiBrowserSession[],
  persistRuntime?: (runtime: BrowserRuntimeMetadata) => void | Promise<void>,
): BrowserRunLifecycleController {
  return new BrowserRunLifecycleController({
    ...createGeminiSettlementAdapters(sessions, persistRuntime),
    getRuntime: () => combineGeminiSessionRuntime(sessions),
  });
}

async function createGeminiBrowserTransaction(
  result: BrowserRunResult,
  sessions: GeminiBrowserSession[],
  persistRuntime?: (runtime: BrowserRuntimeMetadata) => void | Promise<void>,
): Promise<BrowserRunTransaction> {
  if (sessions.length === 0) return createSettledGeminiTransaction(result);

  const pendingRuntime = markBrowserCaptureCleanupPending(combineGeminiSessionRuntime(sessions));
  const settlement = new BrowserCaptureSettlementController(
    createGeminiSettlementAdapters(sessions, persistRuntime),
    pendingRuntime,
  );
  try {
    await persistRuntime?.(pendingRuntime);
  } catch (cause) {
    const abort = await settlement.settle("abort");
    const cleanupDetail =
      abort.status === "completed"
        ? "unpublished resources were aborted"
        : `cleanup remains retryable: ${abort.error ?? "unknown cleanup failure"}`;
    throw new BrowserAutomationError(
      `Failed to durably persist Gemini browser cleanup authority before returning capture; ${cleanupDetail}.`,
      {
        stage: "gemini-browser-publication",
        code: "gemini-browser-runtime-persistence-failed",
        runtime: abort.runtime,
      },
      cause,
    );
  }
  return createBrowserRunTransaction(result, settlement);
}

async function throwAfterGeminiSessionCleanup(
  error: unknown,
  sessions: GeminiBrowserSession[],
): Promise<never> {
  const cleanupError = await settleGeminiSessions(sessions);
  if (!cleanupError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const runtime = pendingBrowserCaptureCleanup(
    combineGeminiSessionRuntime(sessions),
    cleanupError,
    "abort",
  ).runtime;
  throw new BrowserAutomationError(
    `${message}; Gemini browser cleanup remains retryable: ${cleanupError}`,
    { stage: "gemini-browser-cleanup", runtime },
    error,
  );
}

function resolveInvocationPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
}

function resolveCookieDomain(cookie: { domain?: string; url?: string }): string | null {
  const rawDomain = cookie.domain?.trim();
  if (rawDomain) {
    return rawDomain.startsWith(".") ? rawDomain.slice(1) : rawDomain;
  }
  const rawUrl = cookie.url?.trim();
  if (rawUrl) {
    try {
      return new URL(rawUrl).hostname;
    } catch {
      return null;
    }
  }
  return null;
}

function pickCookieValue<
  T extends { name?: string; value?: string; domain?: string; path?: string; url?: string },
>(cookies: T[], name: string): string | undefined {
  const matches = cookies.filter(
    (cookie) => cookie.name === name && typeof cookie.value === "string",
  );
  if (matches.length === 0) return undefined;

  const preferredDomain = matches.find((cookie) => {
    const domain = resolveCookieDomain(cookie);
    return domain === "google.com" && (cookie.path ?? "/") === "/";
  });
  const googleDomain = matches.find((cookie) =>
    (resolveCookieDomain(cookie) ?? "").endsWith("google.com"),
  );
  return (preferredDomain ?? googleDomain ?? matches[0])?.value;
}

function buildGeminiCookieMap<
  T extends { name?: string; value?: string; domain?: string; path?: string; url?: string },
>(cookies: T[]): Record<string, string> {
  const cookieMap: Record<string, string> = {};
  for (const name of GEMINI_COOKIE_NAMES) {
    const value = pickCookieValue(cookies, name);
    if (value) cookieMap[name] = value;
  }
  return cookieMap;
}

function hasRequiredGeminiCookies(cookieMap: Record<string, string>): boolean {
  return GEMINI_REQUIRED_COOKIES.every((name) => Boolean(cookieMap[name]));
}

const GEMINI_CDP_COOKIE_URLS = [
  "https://gemini.google.com",
  "https://accounts.google.com",
  "https://www.google.com",
];

async function loadGeminiCookiesFromCDP(
  browserConfig: BrowserRunOptions["config"],
  log?: BrowserLogger,
): Promise<GeminiCookieLoadResult> {
  const session = await openGeminiBrowserSession({
    browserConfig,
    keepBrowserDefault: false,
    purpose: "Gemini manual-login cookie extraction (no keychain)",
    log,
  });
  try {
    const client = session.client;
    const { Network, Page } = client;
    await Network.enable({});
    await Page.enable();

    log?.("[gemini-web] Navigating to gemini.google.com for sign-in/cookie capture...");
    await Page.navigate({ url: "https://gemini.google.com" });
    await delay(2_000);

    const pollTimeoutMs = 5 * 60_000;
    const pollIntervalMs = 2_000;
    const deadline = Date.now() + pollTimeoutMs;
    let lastNotice = 0;
    let cookieMap: Record<string, string> = {};

    while (Date.now() < deadline) {
      const { cookies } = await Network.getCookies({ urls: GEMINI_CDP_COOKIE_URLS });
      cookieMap = buildGeminiCookieMap(cookies);

      if (hasRequiredGeminiCookies(cookieMap)) {
        log?.(`[gemini-web] Extracted ${Object.keys(cookieMap).length} Gemini cookie(s) via CDP.`);
        return { cookieMap, warnings: [], cleanupSession: session };
      }

      const now = Date.now();
      if (now - lastNotice > 10_000) {
        log?.(
          "[gemini-web] Waiting for Google sign-in... please sign in in the opened Chrome window.",
        );
        lastNotice = now;
      }

      await delay(pollIntervalMs);
    }

    throw new Error("Timed out waiting for Google sign-in (5 minutes). Please sign in and retry.");
  } catch (error) {
    return throwAfterGeminiSessionCleanup(error, [session]);
  }
}

async function runGeminiDeepThinkViaBrowser(
  prompt: string,
  browserConfig: BrowserRunOptions["config"],
  options: {
    showThoughts: boolean;
    startedAt: number;
    persistRuntime?: (runtime: BrowserRuntimeMetadata) => void | Promise<void>;
  },
  log?: BrowserLogger,
): Promise<BrowserRunTransaction> {
  const session = await openGeminiBrowserSession({
    browserConfig,
    keepBrowserDefault: true,
    purpose: "Gemini Deep Think",
    log,
  });
  const lifecycle = createGeminiRunLifecycle([session], options.persistRuntime);
  lifecycle.markAcquired();
  try {
    await options.persistRuntime?.(lifecycle.runtime());
    const client = session.client;
    const { Runtime, Page } = client;
    if (
      !Runtime ||
      typeof Runtime.enable !== "function" ||
      typeof Runtime.evaluate !== "function"
    ) {
      throw new Error("Chrome Runtime domain unavailable for Gemini Deep Think DOM automation.");
    }
    if (!Page || typeof Page.enable !== "function" || typeof Page.navigate !== "function") {
      throw new Error("Chrome Page domain unavailable for Gemini Deep Think DOM automation.");
    }
    await Runtime.enable();
    await Page.enable();

    const evaluate = async <T>(expression: string): Promise<T | undefined> => {
      const evaluation = await Runtime.evaluate({
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (evaluation.exceptionDetails) {
        const detail =
          evaluation.exceptionDetails.exception?.description ??
          evaluation.exceptionDetails.text ??
          "unknown exception";
        throw new Error(`Gemini Deep Think DOM evaluation failed: ${detail}`);
      }
      return evaluation.result?.value as T | undefined;
    };

    log?.("[gemini-web] Navigating to gemini.google.com...");
    await Page.navigate({ url: "https://gemini.google.com/app" });
    await delay(3_000);

    const promptEpochIdentity = await lifecycle.beginPromptDispatch(prompt, 0, 0, 0);
    const providerContext = {
      prompt,
      evaluate,
      delay,
      log,
      state: {
        inputTimeoutMs: browserConfig?.inputTimeoutMs,
        timeoutMs: browserConfig?.timeoutMs,
        geminiConversationId: session.targetId,
      },
    };
    const commitEvidence = await runProviderSubmissionFlow(
      geminiDeepThinkDomProvider,
      providerContext,
    );
    await lifecycle.recordPromptCommitEvidence(commitEvidence, promptEpochIdentity);
    const response = await geminiDeepThinkDomProvider.waitForResponse(providerContext);
    const thoughts = geminiDeepThinkDomProvider.extractThoughts
      ? await geminiDeepThinkDomProvider.extractThoughts(providerContext)
      : null;

    log?.(`[gemini-web] Deep Think response received (${response.text.length} chars).`);
    const tookMs = Date.now() - options.startedAt;
    let answerMarkdown = response.text;
    if (options.showThoughts && thoughts) {
      answerMarkdown = `## Thinking\n\n${thoughts}\n\n## Response\n\n${response.text}`;
    }
    log?.(`[gemini-web] Completed in ${tookMs}ms`);
    return lifecycle.issueCapture({
      answerText: response.text,
      answerMarkdown,
      tookMs,
      answerTokens: estimateTokenCount(response.text),
      answerChars: response.text.length,
    });
  } catch (error) {
    const finalization = await lifecycle.settleIfUnpublished();
    if (finalization?.status === "pending") {
      const message = error instanceof Error ? error.message : String(error);
      throw new BrowserAutomationError(
        `${message}; Gemini browser cleanup remains retryable: ${finalization.error}`,
        { stage: "gemini-browser-cleanup", runtime: finalization.runtime },
        error,
      );
    }
    throw error;
  }
}

async function loadGeminiCookiesFromInline(
  browserConfig: BrowserRunOptions["config"],
  log?: BrowserLogger,
): Promise<GeminiCookieLoadResult> {
  const inline = browserConfig?.inlineCookies;
  if (!inline || inline.length === 0) return { cookieMap: {}, warnings: [] };

  const cookieMap = buildGeminiCookieMap(
    inline.filter((cookie): cookie is CookieParam =>
      Boolean(cookie?.name && typeof cookie.value === "string"),
    ),
  );

  if (Object.keys(cookieMap).length > 0) {
    const source = browserConfig?.inlineCookiesSource ?? "inline";
    log?.(
      `[gemini-web] Loaded Gemini cookies from inline payload (${source}): ${Object.keys(cookieMap).length} cookie(s).`,
    );
  } else {
    log?.("[gemini-web] Inline cookie payload provided but no Gemini cookies matched.");
  }

  return { cookieMap, warnings: [] };
}

async function loadGeminiCookiesFromChrome(
  browserConfig: BrowserRunOptions["config"],
  log?: BrowserLogger,
): Promise<GeminiCookieLoadResult> {
  try {
    // Learned: Gemini web relies on Google auth cookies in the *browser* profile, not API keys.
    const profileCandidate =
      browserConfig?.chromeCookiePath ?? browserConfig?.chromeProfile ?? undefined;
    const profile =
      typeof profileCandidate === "string" && profileCandidate.trim().length > 0
        ? profileCandidate.trim()
        : undefined;

    const sources = [
      "https://gemini.google.com",
      "https://accounts.google.com",
      "https://www.google.com",
    ];

    const { cookies, warnings } = await getCookies({
      url: sources[0],
      origins: sources,
      names: [...GEMINI_COOKIE_NAMES],
      browsers: ["chrome"],
      mode: "merge",
      chromeProfile: profile,
      timeoutMs: 5_000,
    });
    if (warnings.length && log?.verbose) {
      log(`[gemini-web] Cookie warnings:\n- ${warnings.join("\n- ")}`);
    }

    const cookieMap = buildGeminiCookieMap(cookies);

    log?.(
      `[gemini-web] Loaded Gemini cookies from Chrome (node): ${Object.keys(cookieMap).length} cookie(s).`,
    );
    return { cookieMap, warnings };
  } catch (error) {
    log?.(
      `[gemini-web] Failed to load Chrome cookies via node: ${error instanceof Error ? error.message : String(error ?? "")}`,
    );
    return { cookieMap: {}, warnings: [] };
  }
}

function formatGeminiCookieError(warnings: string[]): string {
  const base =
    "Gemini browser mode requires Chrome cookies for google.com (missing __Secure-1PSID/__Secure-1PSIDTS).";
  const guidance =
    "Try --browser-manual-login or --browser-inline-cookies-file if local cookie extraction is unavailable.";
  if (warnings.length === 0) {
    return `${base} ${guidance}`;
  }
  return `${base}\nCookie read warnings:\n- ${warnings.join("\n- ")}\n${guidance}`;
}

async function loadGeminiCookies(
  browserConfig: BrowserRunOptions["config"],
  log?: BrowserLogger,
  options?: { preferManualNoKeychain?: boolean },
): Promise<GeminiCookieLoadResult> {
  const inlineResult = await loadGeminiCookiesFromInline(browserConfig, log);
  const hasInlineRequired = hasRequiredGeminiCookies(inlineResult.cookieMap);
  if (hasInlineRequired) {
    return inlineResult;
  }

  const manualNoKeychain =
    Boolean(browserConfig?.manualLogin) || Boolean(options?.preferManualNoKeychain);
  if (manualNoKeychain) {
    log?.("[gemini-web] Using manual-login cookie extraction path (no keychain cookie read).");
    const cdpResult = await loadGeminiCookiesFromCDP(browserConfig, log);
    return {
      cookieMap: { ...cdpResult.cookieMap, ...inlineResult.cookieMap },
      warnings: [...inlineResult.warnings, ...cdpResult.warnings],
      cleanupSession: cdpResult.cleanupSession,
    };
  }

  if (browserConfig?.cookieSync === false && !hasInlineRequired) {
    log?.("[gemini-web] Cookie sync disabled and inline cookies missing Gemini auth tokens.");
    return inlineResult;
  }

  const chromeResult = await loadGeminiCookiesFromChrome(browserConfig, log);
  return {
    cookieMap: { ...chromeResult.cookieMap, ...inlineResult.cookieMap },
    warnings: [...inlineResult.warnings, ...chromeResult.warnings],
  };
}

export function createGeminiWebExecutor(
  geminiOptions: GeminiWebOptions,
): (runOptions: BrowserRunOptions) => Promise<BrowserRunTransaction> {
  return async (runOptions: BrowserRunOptions): Promise<BrowserRunTransaction> => {
    const startTime = Date.now();
    const log = runOptions.log;

    log?.("[gemini-web] Starting Gemini web executor (TypeScript)");

    const model: GeminiWebModelId = resolveGeminiWebModel(runOptions.config?.desiredModel, log);
    const generateImagePath = resolveInvocationPath(geminiOptions.generateImage);
    const editImagePath = resolveInvocationPath(geminiOptions.editImage);
    const outputPath = resolveInvocationPath(geminiOptions.outputPath);
    const attachmentPaths = (runOptions.attachments ?? []).map((attachment) => attachment.path);

    let prompt = runOptions.prompt;
    if (geminiOptions.aspectRatio && (generateImagePath || editImagePath)) {
      prompt = `${prompt} (aspect ratio: ${geminiOptions.aspectRatio})`;
    }
    if (geminiOptions.youtube) {
      prompt = `${prompt}\n\nYouTube video: ${geminiOptions.youtube}`;
    }
    if (generateImagePath && !editImagePath) {
      prompt = `Generate an image: ${prompt}`;
    }

    const modeSelection = selectGeminiExecutionMode({
      model,
      attachmentPaths,
      generateImagePath,
      editImagePath,
    });

    const domClient: IGeminiExecutionClient = {
      mode: "dom",
      execute: () => {
        log?.("[gemini-web] Using browser DOM automation for Deep Think.");
        return runGeminiDeepThinkViaBrowser(
          prompt,
          runOptions.config,
          {
            showThoughts: Boolean(geminiOptions.showThoughts),
            startedAt: startTime,
            persistRuntime: runOptions.runtimeHintCb,
          },
          log,
        );
      },
    };

    const httpClient: IGeminiExecutionClient = {
      mode: "http",
      execute: async () => {
        const useNoKeychainPath = Boolean(runOptions.config?.manualLogin);
        const cookieResult = await loadGeminiCookies(runOptions.config, log, {
          preferManualNoKeychain: useNoKeychainPath,
        });
        if (!hasRequiredGeminiCookies(cookieResult.cookieMap)) {
          const error = new Error(formatGeminiCookieError(cookieResult.warnings));
          if (cookieResult.cleanupSession) {
            return throwAfterGeminiSessionCleanup(error, [cookieResult.cleanupSession]);
          }
          throw error;
        }

        const configTimeout =
          typeof runOptions.config?.timeoutMs === "number" &&
          Number.isFinite(runOptions.config.timeoutMs)
            ? Math.max(1_000, runOptions.config.timeoutMs)
            : null;

        const defaultTimeoutMs = geminiOptions.youtube
          ? 240_000
          : geminiOptions.generateImage || geminiOptions.editImage
            ? 300_000
            : 120_000;

        const timeoutMs = Math.min(configTimeout ?? defaultTimeoutMs, 600_000);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        let response: GeminiWebResponse;

        try {
          if (editImagePath) {
            const intro = await runGeminiWebWithFallback({
              prompt: "Here is an image to edit",
              files: [editImagePath],
              model,
              cookieMap: cookieResult.cookieMap,
              chatMetadata: null,
              signal: controller.signal,
            });
            const editPrompt = `Use image generation tool to ${prompt}`;
            const out = await runGeminiWebWithFallback({
              prompt: editPrompt,
              files: attachmentPaths,
              model,
              cookieMap: cookieResult.cookieMap,
              chatMetadata: intro.metadata,
              signal: controller.signal,
            });
            response = {
              text: out.text ?? null,
              thoughts: geminiOptions.showThoughts ? out.thoughts : null,
              has_images: false,
              image_count: 0,
            };

            const resolvedOutputPath = outputPath ?? generateImagePath ?? "generated.png";
            const imageSave = await saveFirstGeminiImageFromOutput(
              out,
              cookieResult.cookieMap,
              resolvedOutputPath,
              controller.signal,
            );
            response.has_images = imageSave.saved;
            response.image_count = imageSave.imageCount;
            if (!imageSave.saved) {
              throw new Error(
                `No images generated. Response text:\n${out.text || "(empty response)"}`,
              );
            }
          } else if (generateImagePath) {
            const out = await runGeminiWebWithFallback({
              prompt,
              files: attachmentPaths,
              model,
              cookieMap: cookieResult.cookieMap,
              chatMetadata: null,
              signal: controller.signal,
            });
            response = {
              text: out.text ?? null,
              thoughts: geminiOptions.showThoughts ? out.thoughts : null,
              has_images: false,
              image_count: 0,
            };
            const imageSave = await saveFirstGeminiImageFromOutput(
              out,
              cookieResult.cookieMap,
              generateImagePath,
              controller.signal,
            );
            response.has_images = imageSave.saved;
            response.image_count = imageSave.imageCount;
            if (!imageSave.saved) {
              throw new Error(
                `No images generated. Response text:\n${out.text || "(empty response)"}`,
              );
            }
          } else {
            const out = await runGeminiWebWithFallback({
              prompt,
              files: attachmentPaths,
              model,
              cookieMap: cookieResult.cookieMap,
              chatMetadata: null,
              signal: controller.signal,
            });
            response = {
              text: out.text ?? null,
              thoughts: geminiOptions.showThoughts ? out.thoughts : null,
              has_images: out.images.length > 0,
              image_count: out.images.length,
            };
          }
        } catch (error) {
          if (cookieResult.cleanupSession) {
            return throwAfterGeminiSessionCleanup(error, [cookieResult.cleanupSession]);
          }
          throw error;
        } finally {
          clearTimeout(timeout);
        }

        const answerText = response.text ?? "";
        let answerMarkdown = answerText;

        if (geminiOptions.showThoughts && response.thoughts) {
          answerMarkdown = `## Thinking\n\n${response.thoughts}\n\n## Response\n\n${answerText}`;
        }

        if (response.has_images && response.image_count > 0) {
          const imagePath = generateImagePath || outputPath || "generated.png";
          answerMarkdown += `\n\n*Generated ${response.image_count} image(s). Saved to: ${imagePath}*`;
        }

        const tookMs = Date.now() - startTime;
        log?.(`[gemini-web] Completed in ${tookMs}ms`);

        return createGeminiBrowserTransaction(
          {
            answerText,
            answerMarkdown,
            tookMs,
            answerTokens: estimateTokenCount(answerText),
            answerChars: answerText.length,
          },
          cookieResult.cleanupSession ? [cookieResult.cleanupSession] : [],
          runOptions.runtimeHintCb,
        );
      },
    };

    if (model === "gemini-3-pro-deep-think" && modeSelection.mode === "http") {
      log?.(
        `[gemini-web] Deep Think DOM path skipped (${modeSelection.reasons.join(", ")} requested); using HTTP/header fallback path.`,
      );
    }

    const executionClient = modeSelection.mode === "dom" ? domClient : httpClient;
    return executionClient.execute();
  };
}
