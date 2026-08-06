import path from "node:path";
import type {
  BrowserCaptureFinalizationResult,
  BrowserRunOptions,
  BrowserRunResult,
  BrowserRunTransaction,
  BrowserLogger,
  CookieParam,
} from "../browser/types.js";
import { getCookies } from "@steipete/sweet-cookie";
import { runProviderSubmissionFlow } from "../browser/providerDomFlow.js";
import {
  completedBrowserCaptureCleanup,
  OwnedBrowserResourceTransaction,
  pendingBrowserCaptureCleanup,
  projectBrowserCaptureCleanupRuntime,
  type BrowserCaptureSettlementMode,
} from "../browser/ownedBrowserResources.js";
import { BrowserRunLifecycleController } from "../browser/runLifecycle.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { delay } from "../browser/utils.js";
import { runGeminiWebWithFallback, saveFirstGeminiImageFromOutput } from "./client.js";
import {
  geminiDeepThinkDomProvider,
  hasImmutableGeminiPromptIdentity,
} from "../browser/providers/geminiDeepThinkDomProvider.js";
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
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function createSettledGeminiTransaction(
  result: BrowserRunResult,
  runtime: BrowserRuntimeMetadata = {},
): BrowserRunTransaction {
  const finalization = completedBrowserCaptureCleanup(runtime);
  const settlement = new OwnedBrowserResourceTransaction(
    { settleResources: async () => finalization },
    finalization.runtime,
  );
  return {
    ...result,
    get runtime() {
      return settlement.runtime();
    },
    bindSettlement: (mode) => settlement.bindSettlement(mode),
    finalize: () => settlement.settle("finalize"),
    abort: () => settlement.settle("abort"),
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

async function settleGeminiSessions(
  sessions: GeminiBrowserSession[],
  mode: BrowserCaptureSettlementMode,
  pendingRuntime: BrowserRuntimeMetadata,
): Promise<BrowserCaptureFinalizationResult> {
  let authoritativeRuntime = pendingRuntime;
  const pendingResources = [] as NonNullable<BrowserRuntimeMetadata["recoveryCleanupResources"]>;
  const errors: string[] = [];
  for (const session of sessions) {
    try {
      const result = await session.settle(mode, authoritativeRuntime);
      authoritativeRuntime = projectBrowserCaptureCleanupRuntime(
        authoritativeRuntime,
        result.runtime,
      );
      if (result.status === "pending") {
        errors.push(result.error);
        pendingResources.push(...(result.runtime.recoveryCleanupResources ?? []));
      }
    } catch (error) {
      if (
        error instanceof BrowserAutomationError &&
        error.details?.code === "browser-run-lifecycle-settlement-conflict"
      ) {
        throw error;
      }
      errors.push(error instanceof Error ? error.message : String(error));
      const sessionRuntime = session.runtime();
      authoritativeRuntime = projectBrowserCaptureCleanupRuntime(
        authoritativeRuntime,
        sessionRuntime,
      );
      pendingResources.push(...(sessionRuntime.recoveryCleanupResources ?? []));
    }
  }
  if (errors.length === 0) return completedBrowserCaptureCleanup(authoritativeRuntime);
  const retryRuntime: BrowserRuntimeMetadata = {
    ...authoritativeRuntime,
    ...(pendingResources.length > 0 ? { recoveryCleanupResources: pendingResources } : {}),
  };
  return pendingBrowserCaptureCleanup(retryRuntime, [...new Set(errors)].join("; "), mode);
}

function createGeminiRunLifecycle(
  sessions: GeminiBrowserSession[],
  persistRuntime?: (runtime: BrowserRuntimeMetadata) => void | Promise<void>,
): BrowserRunLifecycleController {
  return new BrowserRunLifecycleController({
    ...(persistRuntime
      ? { persistRuntime: async (runtime: BrowserRuntimeMetadata) => persistRuntime(runtime) }
      : {}),
    settleResources: (mode, pendingRuntime) => settleGeminiSessions(sessions, mode, pendingRuntime),
    getRuntime: () => combineGeminiSessionRuntime(sessions),
  });
}

async function throwAfterGeminiSessionCleanup(
  error: unknown,
  sessions: GeminiBrowserSession[],
): Promise<never> {
  const runtime = combineGeminiSessionRuntime(sessions);
  const cleanup = await settleGeminiSessions(sessions, "abort", runtime);
  if (cleanup.status === "completed") throw error;
  const message = error instanceof Error ? error.message : String(error);
  throw new BrowserAutomationError(
    `${message}; Gemini browser cleanup remains retryable: ${cleanup.error}`,
    { stage: "gemini-browser-cleanup", runtime: cleanup.runtime },
    error,
  );
}

function throwAfterGeminiCookieCaptureCleanupFailure(
  error: unknown,
  session: GeminiBrowserSession,
): never {
  const wrappedCleanupError = error instanceof Error ? error.message : String(error);
  const errorRuntime =
    error instanceof BrowserAutomationError &&
    error.details?.runtime &&
    typeof error.details.runtime === "object" &&
    !Array.isArray(error.details.runtime)
      ? (error.details.runtime as BrowserRuntimeMetadata)
      : session.runtime();
  const authoritativeRuntime = projectBrowserCaptureCleanupRuntime(session.runtime(), errorRuntime);
  const exactCleanupError =
    authoritativeRuntime.recoveryCleanupResult?.error ?? wrappedCleanupError;
  const runtime = pendingBrowserCaptureCleanup(
    authoritativeRuntime,
    exactCleanupError,
    "abort",
  ).runtime;
  throw new BrowserAutomationError(
    `Gemini cookie capture succeeded but browser cleanup remains retryable: ${exactCleanupError}`,
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
  sessionId: string | undefined,
  persistRuntime?: (runtime: BrowserRuntimeMetadata) => void | Promise<void>,
  log?: BrowserLogger,
): Promise<GeminiCookieLoadResult> {
  const session = await openGeminiBrowserSession({
    browserConfig: { ...browserConfig, keepBrowser: false },
    keepBrowserDefault: false,
    purpose: "Gemini manual-login cookie extraction (no keychain)",
    log,
    ...(sessionId !== undefined ? { sessionId } : {}),
    persistRuntime,
  });
  let cookieMap: Record<string, string> = {};
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

    while (Date.now() < deadline) {
      const { cookies } = await Network.getCookies({ urls: GEMINI_CDP_COOKIE_URLS });
      cookieMap = buildGeminiCookieMap(cookies);

      if (hasRequiredGeminiCookies(cookieMap)) {
        log?.(`[gemini-web] Extracted ${Object.keys(cookieMap).length} Gemini cookie(s) via CDP.`);
        break;
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

    if (!hasRequiredGeminiCookies(cookieMap)) {
      throw new Error(
        "Timed out waiting for Google sign-in (5 minutes). Please sign in and retry.",
      );
    }
  } catch (error) {
    return throwAfterGeminiSessionCleanup(error, [session]);
  }

  try {
    await session.close();
  } catch (error) {
    throwAfterGeminiCookieCaptureCleanupFailure(error, session);
  }
  return { cookieMap, warnings: [] };
}

async function runGeminiDeepThinkViaBrowser(
  prompt: string,
  browserConfig: BrowserRunOptions["config"],
  options: {
    showThoughts: boolean;
    sessionId?: string;
    startedAt: number;
    persistRuntime?: (runtime: BrowserRuntimeMetadata) => void | Promise<void>;
  },
  log?: BrowserLogger,
): Promise<BrowserRunTransaction> {
  const session = await openGeminiBrowserSession({
    browserConfig,
    keepBrowserDefault: true,
    purpose: "Gemini Deep Think",
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    log,
    ...(options.persistRuntime ? { persistRuntime: options.persistRuntime } : {}),
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
    if (lifecycle.isPromptCommitted()) {
      const runtime = lifecycle.publishRecovery();
      const message = error instanceof Error ? error.message : String(error);
      const reattachable = hasImmutableGeminiPromptIdentity(runtime.promptEpoch);
      const recoveryMessage = reattachable
        ? "the live browser session was preserved for recovery"
        : "the live browser session was preserved without exact reattach authority";
      throw new BrowserAutomationError(
        `Gemini response capture failed after verified prompt commit; ${recoveryMessage}: ${message}`,
        {
          stage: "gemini-response-capture",
          code: reattachable
            ? "gemini-response-capture-recoverable"
            : "gemini-reattach-authority-unavailable",
          reattachable,
          runtime,
        },
        error,
      );
    }
    const finalization = await lifecycle.settleIfUnpublished();
    if (finalization?.status === "pending") {
      const message = error instanceof Error ? error.message : String(error);
      if (finalization.runtime.promptEpoch?.status === "pending") {
        throw new BrowserAutomationError(
          `${message}; pending prompt epoch recovery remains ambiguous: ${finalization.error}`,
          {
            stage: "prompt-epoch-reconciliation",
            code: "pending-prompt-epoch-ambiguous",
            reattachable: true,
            recoverableDisconnect: true,
            runtime: finalization.runtime,
          },
          error,
        );
      }
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
  options?: {
    preferManualNoKeychain?: boolean;
    sessionId?: string;
    persistRuntime?: (runtime: BrowserRuntimeMetadata) => void | Promise<void>;
  },
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
    const cdpResult = await loadGeminiCookiesFromCDP(
      browserConfig,
      options?.sessionId,
      options?.persistRuntime,
      log,
    );
    return {
      cookieMap: { ...cdpResult.cookieMap, ...inlineResult.cookieMap },
      warnings: [...inlineResult.warnings, ...cdpResult.warnings],
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
            ...(runOptions.sessionId !== undefined ? { sessionId: runOptions.sessionId } : {}),
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
          ...(runOptions.sessionId !== undefined ? { sessionId: runOptions.sessionId } : {}),
          ...(runOptions.runtimeHintCb ? { persistRuntime: runOptions.runtimeHintCb } : {}),
        });
        if (!hasRequiredGeminiCookies(cookieResult.cookieMap)) {
          throw new Error(formatGeminiCookieError(cookieResult.warnings));
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

        return createSettledGeminiTransaction({
          answerText,
          answerMarkdown,
          tookMs,
          answerTokens: estimateTokenCount(answerText),
          answerChars: answerText.length,
        });
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
