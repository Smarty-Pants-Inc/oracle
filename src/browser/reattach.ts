import CDP from "chrome-remote-interface";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import type {
  BrowserDownloadedFile,
  BrowserRuntimeMetadata,
  BrowserSessionConfig,
} from "../sessionStore.js";
import {
  waitForAssistantResponse,
  captureAssistantMarkdown,
  readAssistantSnapshot,
  navigateToChatGPT,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
  ensureModelSelection,
  clearPromptComposer,
  submitPrompt,
  clearComposerAttachments,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  waitForUserTurnAttachments,
  isAssistantEmptyResponseError,
  isAssistantRateLimitError,
} from "./pageActions.js";
import {
  type BrowserAttachment,
  type BrowserLogger,
  type ChromeClient,
  reportBrowserProgress,
} from "./types.js";
import { BrowserbaseClient } from "./browserbase.js";
import {
  launchChrome,
  connectToChrome,
  connectWithNewTab,
  closeTab,
  hideChromeWindow,
  startChromeFocusGuard,
  finalizeChromeFocusProtection,
  connectToRemoteChromeTarget,
  listRemoteChromeTargets,
} from "./chromeLifecycle.js";
import { maybeReuseRunningChrome } from "./index.js";
import { normalizeLocalChromeLaunchConfig, resolveBrowserConfig } from "./config.js";
import { syncCookies } from "./cookies.js";
import { CHATGPT_URL, DEFAULT_MODEL_STRATEGY } from "./constants.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  chromePidMatchesUserDataDir,
  cleanupStaleProfileState,
  readChromePid,
  resolveChromePidForUserDataDir,
} from "./profileState.js";
import { ensureThinkingTime } from "./actions/thinkingTime.js";
import { readDevToolsActivePortInfo } from "./detect.js";
import {
  pickTarget,
  isAttachableChatTarget,
  getRuntimeConversationId,
  runtimeHasReusableIdentity,
  runtimeRequiresSpecificTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  conversationHrefMatchesConfiguredScope,
  withTimeout,
  openConversationFromSidebar,
  openConversationFromSidebarWithRetry,
  waitForLocationChange,
  waitForConversationLocation,
  readConversationTurnIndex,
  buildPromptEchoMatcher,
  recoverPromptEcho,
  alignPromptEchoMarkdown,
  type TargetInfoLite,
} from "./reattachHelpers.js";
import { delay, estimateTokenCount, withRetries } from "./utils.js";
import { captureAssistantDownloads } from "./playwrightDownloads.js";

export interface ReattachDeps {
  listTargets?: () => Promise<TargetInfoLite[]>;
  connect?: (options?: unknown) => Promise<ChromeClient>;
  waitForAssistantResponse?: typeof waitForAssistantResponse;
  captureAssistantMarkdown?: typeof captureAssistantMarkdown;
  ensurePromptReady?: typeof ensurePromptReady;
  ensureModelSelection?: typeof ensureModelSelection;
  ensureThinkingTime?: typeof ensureThinkingTime;
  clearPromptComposer?: typeof clearPromptComposer;
  submitPrompt?: typeof submitPrompt;
  clearComposerAttachments?: typeof clearComposerAttachments;
  uploadAttachmentFile?: typeof uploadAttachmentFile;
  waitForAttachmentCompletion?: typeof waitForAttachmentCompletion;
  waitForUserTurnAttachments?: typeof waitForUserTurnAttachments;
  recoverSession?: (
    runtime: BrowserRuntimeMetadata,
    config: BrowserSessionConfig | undefined,
  ) => Promise<ReattachResult>;
  promptPreview?: string;
  baselineTurns?: number | null;
  baselineAssistant?: {
    text: string;
    messageId?: string | null;
    turnId?: string | null;
  } | null;
  downloadsDir?: string;
  forceConversationReload?: boolean;
}

export interface ReattachResult {
  answerText: string;
  answerMarkdown: string;
  downloads?: BrowserDownloadedFile[];
  answerTokens?: number;
  tookMs?: number;
  runtime?: BrowserRuntimeMetadata;
}

export interface ContinueBrowserSessionOptions {
  prompt: string;
  attachments?: BrowserAttachment[];
  downloadsDir?: string;
  fallbackSubmission?: { prompt: string; attachments: BrowserAttachment[] };
}

async function readCurrentHref(Runtime: ChromeClient["Runtime"]): Promise<string> {
  const { result } = await withTimeout(
    Runtime.evaluate({
      expression: "location.href",
      returnByValue: true,
    }),
    5_000,
    "Timed out reading location.href",
  );
  return typeof result?.value === "string" ? result.value : "";
}

async function conversationLocationMatchesConfiguredScope(
  Runtime: ChromeClient["Runtime"],
  baseUrl: string,
): Promise<boolean> {
  const href = await readCurrentHref(Runtime);
  return conversationHrefMatchesConfiguredScope(href, baseUrl);
}

function mergeRuntimeMetadata(
  runtime: BrowserRuntimeMetadata,
  updates: {
    chromePid?: number;
    chromeHost?: string;
    chromePort?: number;
    chromeTargetId?: string | null;
    tabUrl?: string;
    userDataDir?: string;
    controllerPid?: number;
  },
): BrowserRuntimeMetadata {
  const tabUrlProvided = Object.prototype.hasOwnProperty.call(updates, "tabUrl");
  const tabUrl = updates.tabUrl || runtime.tabUrl;
  const derivedConversationId = tabUrl ? extractConversationIdFromUrl(tabUrl) : undefined;
  return {
    ...runtime,
    chromePid: updates.chromePid ?? runtime.chromePid,
    chromeHost: updates.chromeHost ?? runtime.chromeHost,
    chromePort: updates.chromePort ?? runtime.chromePort,
    chromeTargetId:
      updates.chromeTargetId === null
        ? undefined
        : (updates.chromeTargetId ?? runtime.chromeTargetId),
    tabUrl,
    conversationId:
      runtime.conversationId && !tabUrlProvided && derivedConversationId === undefined
        ? runtime.conversationId
        : derivedConversationId,
    userDataDir: updates.userDataDir ?? runtime.userDataDir,
    controllerPid: updates.controllerPid ?? runtime.controllerPid,
  };
}

function isBrowserbaseRuntime(runtime: BrowserRuntimeMetadata): boolean {
  return runtime.browserProvider === "browserbase";
}

function browserbaseRecoveryUnavailable(
  runtime: BrowserRuntimeMetadata,
  cause?: unknown,
): BrowserAutomationError {
  return new BrowserAutomationError(
    "Browserbase browser sessions cannot be recovered by launching local Chrome. Start a new Browserbase run, or use --browserbase-keep-alive and reattach while the cloud session is still alive.",
    { stage: "browserbase-reattach-unavailable", runtime },
    cause,
  );
}

async function refreshBrowserbaseRuntimeForReattach(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  cause?: unknown,
): Promise<BrowserRuntimeMetadata> {
  if (!isBrowserbaseRuntime(runtime)) {
    return runtime;
  }
  if (runtime.browserbaseKeepAlive !== true) {
    throw browserbaseRecoveryUnavailable(runtime, cause);
  }
  const sessionId = runtime.browserbaseSessionId?.trim();
  const apiKey = browserbaseApiKeyForReattach(config);
  if (!sessionId || !apiKey) {
    throw new BrowserAutomationError(
      "Browserbase keep-alive reattach requires a Browserbase session id and API key.",
      {
        stage: "browserbase-reattach-refresh",
        runtime: {
          ...runtime,
          chromeBrowserWSEndpoint: undefined,
        },
      },
      cause,
    );
  }
  const projectId = runtime.browserbaseProjectId ?? config?.browserbase?.projectId ?? undefined;
  const client = new BrowserbaseClient({ apiKey, projectId });
  const session = await client.getSession(sessionId).catch((error) => {
    throw new BrowserAutomationError(
      "Browserbase keep-alive session details could not be refreshed.",
      {
        stage: "browserbase-reattach-refresh",
        runtime: {
          ...runtime,
          chromeBrowserWSEndpoint: undefined,
        },
      },
      error,
    );
  });
  const browserWSEndpoint = session.connectUrl?.trim();
  if (session.status !== "RUNNING" || !browserWSEndpoint) {
    throw new BrowserAutomationError(
      session.status === "RUNNING"
        ? "Browserbase keep-alive session did not return a CDP connectUrl."
        : `Browserbase keep-alive session is ${session.status} and can no longer be reattached.`,
      {
        stage: "browserbase-reattach-refresh",
        runtime: {
          ...runtime,
          chromeBrowserWSEndpoint: undefined,
        },
        status: session.status,
      },
      cause,
    );
  }
  const endpoint = resolveBrowserbaseEndpoint(browserWSEndpoint);
  return {
    ...runtime,
    chromeHost: endpoint.host,
    chromePort: endpoint.port,
    chromeBrowserWSEndpoint: browserWSEndpoint,
    chromePid: undefined,
    chromeProfileRoot: undefined,
    userDataDir: undefined,
    browserbaseProjectId: session.projectId ?? runtime.browserbaseProjectId,
    browserbaseContextId: session.contextId ?? runtime.browserbaseContextId,
  };
}

function browserbaseApiKeyForReattach(
  config: BrowserSessionConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = config?.browserbase?.apiKey?.trim();
  if (configured && configured !== "[redacted]") {
    return configured;
  }
  return env.ORACLE_BROWSERBASE_API_KEY?.trim() || env.BROWSERBASE_API_KEY?.trim() || undefined;
}

function resolveBrowserbaseEndpoint(browserWSEndpoint: string): { host: string; port: number } {
  try {
    const parsed = new URL(browserWSEndpoint);
    return {
      host: parsed.hostname || "connect.browserbase.com",
      port: parsed.port ? Number.parseInt(parsed.port, 10) : 443,
    };
  } catch {
    return { host: "connect.browserbase.com", port: 443 };
  }
}

function isAssistantRateLimitAutomationError(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) {
    return false;
  }
  return (error.details as { stage?: string } | undefined)?.stage === "assistant-rate-limit";
}

function isAssistantRateLimitFailure(error: unknown): boolean {
  return isAssistantRateLimitError(error) || isAssistantRateLimitAutomationError(error);
}

function isSessionIdentityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Unable to locate the existing Oracle browser tab") ||
    message.includes("ChatGPT did not reopen the expected conversation") ||
    message.includes("Reusable Oracle runtime is missing a conversation identity") ||
    message.includes("missing conversation identity metadata")
  );
}

function isRecoverableSessionDiscoveryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Unable to locate the existing Oracle browser tab") ||
    message.includes("ChatGPT did not reopen the expected conversation")
  );
}

function isHiddenBrowserReuseRequiredError(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) {
    return false;
  }
  return (
    (error.details as { stage?: string } | undefined)?.stage === "hidden-browser-reuse-required"
  );
}

function withTimeoutBudget(
  config: BrowserSessionConfig | undefined,
  timeoutMs: number,
): BrowserSessionConfig {
  const budgetMs = Math.max(0, timeoutMs);
  const configuredTimeoutMs = Math.max(0, config?.timeoutMs ?? 0);
  return {
    ...(config ?? {}),
    timeoutMs: configuredTimeoutMs > 0 ? Math.min(configuredTimeoutMs, budgetMs) : budgetMs,
  };
}

function withAssistantRecheckBudget(
  config: BrowserSessionConfig | undefined,
): BrowserSessionConfig | undefined {
  const budgetMs = Math.max(0, config?.assistantRecheckTimeoutMs ?? 0);
  if (budgetMs <= 0) {
    return config;
  }
  return withTimeoutBudget(config, budgetMs);
}

async function closeClient(client: ChromeClient | null | undefined): Promise<void> {
  if (!client || typeof client.close !== "function") {
    return;
  }
  try {
    await client.close();
  } catch {
    // ignore
  }
}

async function withHiddenExistingChrome<T>(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  action: (liveRuntime: BrowserRuntimeMetadata) => Promise<T>,
): Promise<T> {
  const resolved = normalizeLocalChromeLaunchConfig(resolveBrowserConfig(config ?? {}));
  const liveRuntime =
    (await refreshAttachRuntime(runtime, config).catch((error) => {
      if (isBrowserbaseRuntime(runtime)) {
        throw error;
      }
      return runtime;
    })) ?? runtime;
  if (process.platform !== "darwin" || resolved.headless || !resolved.hideWindow) {
    return action(liveRuntime);
  }
  if (!liveRuntime.chromePid) {
    return action(liveRuntime);
  }

  const chrome = { pid: liveRuntime.chromePid } as Parameters<typeof hideChromeWindow>[0];
  const stopChromeFocusGuard = startChromeFocusGuard(chrome, logger);
  try {
    await hideChromeWindow(chrome, logger);
    return await action(liveRuntime);
  } finally {
    await finalizeChromeFocusProtection(chrome, logger, stopChromeFocusGuard);
  }
}

async function connectReopenedChrome(
  chrome: { port: number },
  chromeHost: string,
  logger: BrowserLogger,
  strictTabIsolation: boolean,
  hiddenTarget: boolean,
): Promise<{ client: ChromeClient; isolatedTargetId: string | null }> {
  if (!strictTabIsolation && !hiddenTarget) {
    return {
      client: await connectToChrome(chrome.port, logger, chromeHost),
      isolatedTargetId: null,
    };
  }
  const connection = await connectWithNewTab(chrome.port, logger, undefined, chromeHost, {
    fallbackToDefault: false,
    hiddenTarget,
    retries: strictTabIsolation || hiddenTarget ? 3 : 0,
    retryDelayMs: 500,
  });
  return {
    client: connection.client,
    isolatedTargetId: connection.targetId ?? null,
  };
}

async function cleanupReopenedChromeLaunch(
  chrome: { kill?: () => Promise<void> | void },
  userDataDir: string,
  manualLogin: boolean,
  logger: BrowserLogger,
): Promise<void> {
  try {
    await chrome.kill?.();
  } catch {
    // ignore kill failures
  }
  if (manualLogin) {
    await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
      () => undefined,
    );
  } else {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function refreshAttachRuntime(
  runtime: BrowserRuntimeMetadata,
  config?: BrowserSessionConfig,
  cause?: unknown,
): Promise<BrowserRuntimeMetadata | null> {
  if (isBrowserbaseRuntime(runtime)) {
    return refreshBrowserbaseRuntimeForReattach(runtime, config, cause);
  }
  if (!runtime.chromeProfileRoot) {
    return runtime;
  }
  const host = runtime.chromeHost ?? "127.0.0.1";
  const activePort = await readDevToolsActivePortInfo(runtime.chromeProfileRoot, {
    host,
  });
  if (!activePort) {
    return runtime;
  }
  return {
    ...runtime,
    chromeHost: host,
    chromePort: activePort.port,
    chromeBrowserWSEndpoint: activePort.browserWSEndpoint,
  };
}

function inferPortFromBrowserWSEndpoint(browserWSEndpoint?: string): number | undefined {
  if (!browserWSEndpoint) {
    return undefined;
  }
  try {
    const parsed = new URL(browserWSEndpoint);
    const port = Number.parseInt(parsed.port, 10);
    if (Number.isFinite(port) && port > 0) {
      return port;
    }
  } catch {
    // ignore malformed ws endpoints and fall back to caller defaults
  }
  return undefined;
}

interface ExistingRuntimeConnection {
  client: ChromeClient;
  close: () => Promise<void>;
  host: string;
  port: number;
  liveRuntime: BrowserRuntimeMetadata;
  target?: TargetInfoLite;
}

async function readConnectedTargetInfo(
  client: ChromeClient,
  fallback: TargetInfoLite,
  options?: { requireVerification?: boolean },
): Promise<TargetInfoLite> {
  try {
    const info = await client.Target?.getTargetInfo?.({});
    if (info?.targetInfo) {
      return {
        targetId: info.targetInfo.targetId ?? fallback.targetId,
        type: info.targetInfo.type ?? fallback.type,
        url: info.targetInfo.url ?? fallback.url,
      };
    }
    if (options?.requireVerification) {
      throw new Error("Target.getTargetInfo returned no target metadata");
    }
  } catch {
    if (options?.requireVerification) {
      throw new Error("Target.getTargetInfo failed while verifying the cached target");
    }
  }
  return fallback;
}

async function refreshOwnedManualLoginRuntime(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  _logger: BrowserLogger,
): Promise<BrowserRuntimeMetadata> {
  const resolved = normalizeLocalChromeLaunchConfig(resolveBrowserConfig(config));
  if (
    !resolved.manualLogin ||
    resolved.attachRunning ||
    resolved.launcher === "carbonyl" ||
    !resolved.keepBrowser
  ) {
    return runtime;
  }
  const configuredProfileDir = resolved.manualLoginProfileDir?.trim();
  const runtimeProfileDir = runtime.userDataDir?.trim();
  const expectedProfileDir = configuredProfileDir || runtimeProfileDir;
  if (!expectedProfileDir) {
    return runtime;
  }
  const normalizedProfileDir = path.resolve(expectedProfileDir);
  if (runtimeProfileDir && path.resolve(runtimeProfileDir) !== normalizedProfileDir) {
    throw new Error(
      "Refusing to attach: cached Oracle runtime profile does not match the owned hidden browser profile.",
    );
  }
  if (!runtimeHasReusableIdentity(runtime)) {
    throw new Error(
      "Refusing to attach: cached Oracle hidden browser runtime is missing conversation identity metadata. Run another Oracle browser turn before reusing this session.",
    );
  }
  const devtoolsInfo = await readDevToolsActivePortInfo(normalizedProfileDir, {
    host: runtime.chromeHost ?? "127.0.0.1",
  });
  const discoveredChromePid = await readChromePid(normalizedProfileDir);
  if (
    discoveredChromePid &&
    !(await chromePidMatchesUserDataDir(discoveredChromePid, normalizedProfileDir))
  ) {
    throw new Error(
      "Refusing to attach: the process holding the Oracle hidden browser profile is not an Oracle-owned Chrome instance.",
    );
  }
  const chromePid = await resolveChromePidForUserDataDir(normalizedProfileDir, runtime.chromePid);
  if (!devtoolsInfo) {
    throw new BrowserAutomationError(
      `Refusing to relaunch the Oracle hidden browser for ${normalizedProfileDir}; reuse the existing hidden browser or start it explicitly before retrying.`,
      {
        stage: "hidden-browser-reuse-required",
        runtime: {
          ...runtime,
          chromePid: chromePid ?? runtime.chromePid,
          userDataDir: normalizedProfileDir,
        },
        userDataDir: normalizedProfileDir,
        chromePid: chromePid ?? runtime.chromePid ?? null,
      },
    );
  }
  return {
    ...runtime,
    chromePid: chromePid ?? runtime.chromePid,
    chromeHost: runtime.chromeHost ?? "127.0.0.1",
    chromePort: devtoolsInfo.port,
    chromeBrowserWSEndpoint: devtoolsInfo.browserWSEndpoint,
    userDataDir: normalizedProfileDir,
  };
}

async function connectToExistingRuntime(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<ExistingRuntimeConnection> {
  const liveRuntime = isBrowserbaseRuntime(runtime)
    ? runtime
    : await refreshOwnedManualLoginRuntime(runtime, config, logger);
  const host = liveRuntime.chromeHost ?? "127.0.0.1";
  const port =
    liveRuntime.chromePort ?? inferPortFromBrowserWSEndpoint(liveRuntime.chromeBrowserWSEndpoint);
  const resolvedPort = port ?? 9222;
  const browserWSEndpoint = liveRuntime.chromeBrowserWSEndpoint ?? undefined;
  const listTargets =
    deps.listTargets ??
    (async () =>
      (await listRemoteChromeTargets({
        host,
        port: resolvedPort,
        browserWSEndpoint,
      })) as TargetInfoLite[]);
  let cachedTargetList: TargetInfoLite[] | null = null;
  if (browserWSEndpoint && liveRuntime.chromeTargetId) {
    cachedTargetList = (await listTargets().catch(
      () => [] as TargetInfoLite[],
    )) as TargetInfoLite[];
  }
  if (browserWSEndpoint && liveRuntime.chromeTargetId && !deps.connect) {
    const cachedListedTarget = cachedTargetList?.find((candidate) => {
      const candidateTargetId = candidate.targetId ?? candidate.id;
      return candidateTargetId === liveRuntime.chromeTargetId;
    });
    if (!cachedListedTarget) {
      logger(
        `[reattach] cached target ${liveRuntime.chromeTargetId} is no longer listed; retrying via target discovery.`,
      );
    } else {
      try {
        const connection = await connectToRemoteChromeTarget(host, resolvedPort, logger, {
          browserWSEndpoint,
          targetId: liveRuntime.chromeTargetId,
          closeTargetOnDispose: false,
        });
        try {
          const target = isBrowserbaseRuntime(liveRuntime)
            ? cachedListedTarget
            : await readConnectedTargetInfo(
                connection.client,
                {
                  targetId: liveRuntime.chromeTargetId,
                  url: liveRuntime.tabUrl,
                },
                { requireVerification: true },
              );
          if (
            !pickTarget([target], liveRuntime, {
              requireMatch: true,
            })
          ) {
            throw new Error("cached target no longer matches the reusable runtime");
          }
          return {
            client: connection.client,
            close: connection.close,
            host,
            port: resolvedPort,
            liveRuntime,
            target,
          };
        } catch (error) {
          await connection.close().catch(() => undefined);
          throw error;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger(
          `[reattach] direct websocket attach to cached target ${liveRuntime.chromeTargetId} failed (${message}); retrying via target discovery.`,
        );
      }
    }
  }
  const requireExactTarget = Boolean(
    browserWSEndpoint || runtimeRequiresSpecificTarget(liveRuntime),
  );
  const allowProjectScopeRecovery = Boolean(
    requireExactTarget && getRuntimeConversationId(liveRuntime),
  );
  let targetList = (cachedTargetList ?? (await listTargets())) as TargetInfoLite[];
  let target = pickTarget(targetList, liveRuntime, {
    requireMatch: requireExactTarget,
    allowProjectScopeRecovery,
  });
  if (!target && requireExactTarget) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await delay(500);
      targetList = ((await listTargets().catch(() => [])) as TargetInfoLite[]) ?? [];
      target = pickTarget(targetList, liveRuntime, {
        requireMatch: true,
        allowProjectScopeRecovery,
      });
      if (target) {
        logger(
          `[reattach] recovered reusable target after retry ${attempt} (${target.type ?? "unknown"} ${target.url ?? ""})`,
        );
        break;
      }
    }
  }
  if (!target && browserWSEndpoint) {
    const portTargetList = (await listRemoteChromeTargets({
      host,
      port: resolvedPort,
    }).catch(() => [])) as TargetInfoLite[];
    target = pickTarget(portTargetList, liveRuntime, {
      requireMatch: true,
      allowProjectScopeRecovery,
    });
    if (target) {
      logger(
        `[reattach] recovered reusable target from host:port discovery (${target.type ?? "unknown"} ${target.url ?? ""})`,
      );
      targetList = portTargetList;
    }
  }
  if (!target) {
    throw new Error(
      requireExactTarget
        ? "Unable to locate the existing Oracle browser tab for the reusable runtime. Run another Oracle browser turn or reopen the Oracle conversation before continuing."
        : "Unable to safely locate a reusable Oracle browser tab for the cached runtime. Run another Oracle browser turn or reopen the Oracle conversation before continuing.",
    );
  }
  const useBrowserSocketTarget = Boolean(browserWSEndpoint && target?.targetId);
  if (useBrowserSocketTarget && !deps.connect) {
    const connection = await connectToRemoteChromeTarget(host, resolvedPort, logger, {
      browserWSEndpoint,
      targetId: target?.targetId,
      closeTargetOnDispose: false,
    });
    const connectedTarget = isBrowserbaseRuntime(liveRuntime)
      ? target
      : await readConnectedTargetInfo(connection.client, target ?? {});
    return {
      client: connection.client,
      close: connection.close,
      host,
      port: resolvedPort,
      liveRuntime,
      target: connectedTarget,
    };
  }
  const client = (await (deps.connect ?? ((options?: unknown) => CDP(options as CDP.Options)))(
    useBrowserSocketTarget
      ? {
          target: browserWSEndpoint,
          local: true,
          targetId: target?.targetId,
        }
      : {
          host,
          port: resolvedPort,
          target: target?.targetId,
        },
  )) as unknown as ChromeClient;
  return {
    client,
    close: async () => closeClient(client),
    host,
    port: resolvedPort,
    liveRuntime,
    target,
  };
}

async function ensureConversationOpenForRuntime(
  Runtime: ChromeClient["Runtime"],
  runtime: BrowserRuntimeMetadata,
  promptPreview?: string,
  baseUrl = CHATGPT_URL,
): Promise<void> {
  const expectedConversationId = getRuntimeConversationId(runtime);
  const href = await readCurrentHref(Runtime);
  const inferredProjectBaseUrl =
    projectBaseUrlFromHref(runtime.tabUrl ?? "") ??
    (!runtime.tabUrl || runtime.tabUrl.trim().length === 0 ? projectBaseUrlFromHref(href) : null);
  const conversationUrl = buildConversationUrl(runtime, inferredProjectBaseUrl ?? baseUrl);
  const projectBaseUrl = normalizeProjectBaseUrl(baseUrl) ?? inferredProjectBaseUrl;
  if (isFreshChatHomeUrl(href) && !expectedConversationId) {
    return;
  }
  if (!expectedConversationId) {
    throw new Error(
      "Reusable Oracle runtime is missing a conversation identity; refusing to continue on an arbitrary existing chat.",
    );
  }
  if (href.includes("/c/")) {
    const currentId = extractConversationIdFromUrl(href);
    if (
      currentId &&
      currentId === expectedConversationId &&
      conversationHrefMatchesConfiguredScope(href, baseUrl)
    ) {
      return;
    }
    if (
      currentId &&
      currentId !== expectedConversationId &&
      conversationUrl &&
      conversationUrl.includes("/c/")
    ) {
      await withTimeout(
        Runtime.evaluate({
          expression: `window.location.href = ${JSON.stringify(conversationUrl)}`,
        }),
        5_000,
        "Timed out reopening the stored ChatGPT conversation",
      ).catch(() => undefined);
      const matched = await waitForConversationLocation(Runtime, expectedConversationId, 15_000);
      if (matched && (await conversationLocationMatchesConfiguredScope(Runtime, baseUrl))) {
        return;
      }
    }
  }
  if (conversationUrl && conversationUrl.includes("/c/")) {
    await withTimeout(
      Runtime.evaluate({
        expression: `window.location.href = ${JSON.stringify(conversationUrl)}`,
      }),
      5_000,
      "Timed out reopening the stored ChatGPT conversation",
    ).catch(() => undefined);
    const matched = await waitForConversationLocation(Runtime, expectedConversationId, 15_000);
    if (matched && (await conversationLocationMatchesConfiguredScope(Runtime, baseUrl))) {
      return;
    }
  }
  if (projectBaseUrl) {
    if (href.replace(/\/+$/, "") !== projectBaseUrl) {
      await withTimeout(
        Runtime.evaluate({
          expression: `window.location.href = ${JSON.stringify(projectBaseUrl)}`,
        }),
        5_000,
        "Timed out reopening the configured ChatGPT project shell",
      ).catch(() => undefined);
      await waitForExactLocation(Runtime, projectBaseUrl, 15_000).catch(() => undefined);
    }
  }
  const opened = await openConversationFromSidebarWithRetry(
    Runtime,
    {
      conversationId: expectedConversationId,
      preferProjects: true,
      promptPreview,
    },
    15_000,
  );
  if (!opened) {
    throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
  }
  if (expectedConversationId) {
    const sidebarHref = await readCurrentHref(Runtime).catch(() => "");
    const sidebarConversationId = extractConversationIdFromUrl(sidebarHref);
    if (
      conversationUrl &&
      conversationUrl.includes("/c/") &&
      sidebarConversationId &&
      sidebarConversationId !== expectedConversationId
    ) {
      await withTimeout(
        Runtime.evaluate({
          expression: `window.location.href = ${JSON.stringify(conversationUrl)}`,
        }),
        5_000,
        "Timed out forcing the stored ChatGPT conversation URL",
      ).catch(() => undefined);
    }
    let matched = await waitForConversationLocation(Runtime, expectedConversationId, 15_000);
    if (!matched && conversationUrl && conversationUrl.includes("/c/")) {
      await withTimeout(
        Runtime.evaluate({
          expression: `window.location.href = ${JSON.stringify(conversationUrl)}`,
        }),
        5_000,
        "Timed out forcing the stored ChatGPT conversation URL",
      ).catch(() => undefined);
      matched = await waitForConversationLocation(Runtime, expectedConversationId, 15_000);
    }
    if (!matched) {
      throw new Error(
        "ChatGPT did not reopen the expected conversation before Oracle continued the session.",
      );
    }
    if (!(await conversationLocationMatchesConfiguredScope(Runtime, baseUrl))) {
      throw new Error(
        "ChatGPT reopened the expected conversation outside the configured project scope.",
      );
    }
    return;
  }
  await waitForLocationChange(Runtime, 15_000);
}

function projectBaseUrlFromHref(href: string): string | null {
  if (!href) {
    return null;
  }
  try {
    const parsed = new URL(href);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const projectPath = pathname.match(/^(\/g\/[^/]+\/project)(?:\/c\/[a-zA-Z0-9-]+)?$/i)?.[1];
    return projectPath ? `${parsed.origin}${projectPath}` : null;
  } catch {
    return null;
  }
}

function isFreshChatHomeUrl(url: string): boolean {
  if (!url || url.includes("/c/")) {
    return false;
  }
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return pathname === "" || pathname === "/" || /^\/g\/[^/]+\/project$/i.test(pathname);
  } catch {
    return (
      url === "https://chatgpt.com" ||
      url === "https://chatgpt.com/" ||
      /^https:\/\/chatgpt\.com\/g\/[^/]+\/project\/?$/i.test(url)
    );
  }
}

function normalizeProjectBaseUrl(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (/^\/g\/[^/]+\/project$/i.test(pathname)) {
      return `${parsed.origin}${pathname}`;
    }
  } catch {
    const trimmed = baseUrl.replace(/\/+$/, "");
    if (/^https:\/\/chatgpt\.com\/g\/[^/]+\/project$/i.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

async function waitForExactLocation(
  Runtime: ChromeClient["Runtime"],
  expectedUrl: string,
  timeoutMs: number,
): Promise<boolean> {
  const expected = expectedUrl.replace(/\/+$/, "");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const href = (await readCurrentHref(Runtime)).replace(/\/+$/, "");
    if (href === expected) {
      return true;
    }
    await delay(200);
  }
  return false;
}

async function captureConversationResponse(
  runtime: BrowserRuntimeMetadata,
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  deps: ReattachDeps,
  timeoutMs: number,
  promptPreview?: string,
  baselineTurns?: number | null,
  downloadsDir?: string,
  targetClient?: ChromeClient,
): Promise<ReattachResult> {
  const startedAt = Date.now();
  const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
  const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
  const minTurnIndex =
    typeof baselineTurns === "number" && Number.isFinite(baselineTurns) && baselineTurns >= 0
      ? Math.floor(baselineTurns)
      : await readConversationTurnIndex(Runtime, logger);
  await reportBrowserProgress(logger, {
    stage: "assistant-generating",
    message: "Waiting for ChatGPT to finish the assistant response in the bound conversation.",
  });
  const promptEcho = buildPromptEchoMatcher(promptPreview);
  let answer = await withTimeout(
    waitForResponse(Runtime, timeoutMs, logger, minTurnIndex ?? undefined),
    timeoutMs + 5_000,
    "Reattach response timed out",
  );
  if (isStaleBaselineAssistant(answer, deps.baselineAssistant)) {
    logger("Detected stale assistant response; waiting for new response...");
    const remainingMs = Math.max(1_000, timeoutMs - (Date.now() - startedAt));
    const refreshed = await recoverFreshAssistantAfterStaleBaseline({
      Runtime,
      logger,
      matcher: promptEcho,
      minTurnIndex,
      timeoutMs: remainingMs,
      baselineAssistant: deps.baselineAssistant,
    });
    if (refreshed) {
      answer = refreshed;
    } else {
      throw new BrowserAutomationError(
        "Captured the previous assistant turn again while waiting for a follow-up response.",
        {
          stage: "assistant-stale-replay",
          promptSubmitted: true,
          submittedPrompt: promptPreview,
          baselineTurns,
          baselineAssistant: deps.baselineAssistant,
        },
      );
    }
  }
  const recovered = await recoverPromptEcho(
    Runtime,
    answer,
    promptEcho,
    logger,
    minTurnIndex,
    timeoutMs,
  );
  const copiedMarkdown =
    (await withTimeout(
      captureMarkdown(Runtime, recovered.meta, logger, minTurnIndex ?? undefined),
      15_000,
      "Reattach markdown capture timed out",
    )) ?? null;
  const aligned = alignPromptEchoMarkdown(
    recovered.text,
    copiedMarkdown ?? recovered.text,
    promptEcho,
    logger,
  );
  let { answerText, answerMarkdown } = collapseReattachAnswer(
    aligned.answerText,
    aligned.answerMarkdown,
  );
  if (isTransientReattachAnswer(answerText)) {
    const refreshed = await recoverTransientReattachAnswer({
      Runtime,
      captureMarkdown,
      logger,
      matcher: promptEcho,
      minTurnIndex,
      timeoutMs,
    });
    if (refreshed) {
      answerText = refreshed.answerText;
      answerMarkdown = refreshed.answerMarkdown;
    }
  } else {
    const refreshed = await recoverExpandedReattachAnswer({
      Runtime,
      captureMarkdown,
      logger,
      matcher: promptEcho,
      minTurnIndex,
      timeoutMs,
      currentText: answerText,
      currentMarkdown: answerMarkdown,
      currentMeta: recovered.meta,
    });
    if (refreshed) {
      answerText = refreshed.answerText;
      answerMarkdown = refreshed.answerMarkdown;
    }
  }
  const shortRecovered = await recoverShortReattachAnswer({
    Runtime,
    captureMarkdown,
    logger,
    matcher: promptEcho,
    minTurnIndex,
    timeoutMs,
    currentText: answerText,
    currentMarkdown: answerMarkdown,
    currentMeta: recovered.meta,
  });
  if (shortRecovered) {
    answerText = shortRecovered.answerText;
    answerMarkdown = shortRecovered.answerMarkdown;
  }
  await reportBrowserProgress(logger, {
    stage: "assistant-completed",
    message: "Captured the assistant response from the bound ChatGPT conversation.",
  });
  const currentUrl = (await readCurrentHref(Runtime).catch(() => "")) || runtime.tabUrl;
  const downloads = await captureAssistantDownloads({
    browserWSEndpoint: runtime.chromeBrowserWSEndpoint,
    chromeHost: runtime.chromeHost,
    chromePort: runtime.chromePort,
    chromeTargetId: runtime.chromeTargetId,
    tabUrl: currentUrl,
    conversationId: extractConversationIdFromUrl(currentUrl ?? runtime.tabUrl ?? ""),
    downloadsDir,
    assistantMarkdown: answerMarkdown,
    meta: recovered.meta,
    targetClient,
    logger,
  }).catch((error) => {
    logger.sessionLog?.(
      `[browser-downloads] skipped during follow-up capture: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  });
  return {
    answerText,
    answerMarkdown,
    downloads,
    answerTokens: estimateTokenCount(answerText),
    tookMs: Date.now() - startedAt,
  };
}

function isStaleBaselineAssistant(
  candidate:
    | {
        text: string;
        meta: { turnId?: string | null; messageId?: string | null };
      }
    | null
    | undefined,
  baseline:
    | {
        text: string;
        messageId?: string | null;
        turnId?: string | null;
      }
    | null
    | undefined,
): boolean {
  const candidateText = String(candidate?.text ?? "").trim();
  const baselineText = String(baseline?.text ?? "").trim();
  if (!candidateText || !baselineText) {
    return false;
  }
  const candidateMessageId = candidate?.meta?.messageId?.trim() || null;
  const candidateTurnId = candidate?.meta?.turnId?.trim() || null;
  const baselineMessageId = baseline?.messageId?.trim() || null;
  const baselineTurnId = baseline?.turnId?.trim() || null;
  if (candidateMessageId && baselineMessageId && candidateMessageId === baselineMessageId) {
    return true;
  }
  if (candidateTurnId && baselineTurnId && candidateTurnId === baselineTurnId) {
    return true;
  }
  if (candidateText !== baselineText) {
    return false;
  }
  return (
    !candidateMessageId ||
    !baselineMessageId ||
    candidateMessageId === baselineMessageId ||
    !candidateTurnId ||
    !baselineTurnId ||
    candidateTurnId === baselineTurnId
  );
}

async function recoverFreshAssistantAfterStaleBaseline({
  Runtime,
  logger: _logger,
  matcher,
  minTurnIndex,
  timeoutMs,
  baselineAssistant,
}: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  matcher: ReturnType<typeof buildPromptEchoMatcher>;
  minTurnIndex: number | null;
  timeoutMs: number;
  baselineAssistant:
    | {
        text: string;
        messageId?: string | null;
        turnId?: string | null;
      }
    | null
    | undefined;
}): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  while (Date.now() < deadline) {
    const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex ?? undefined).catch(
      () => null,
    );
    const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
    if (!text || isTransientReattachAnswer(text) || matcher?.isEcho(text)) {
      await delay(350);
      continue;
    }
    const candidate = {
      text,
      html: snapshot?.html ?? undefined,
      meta: {
        turnId: snapshot?.turnId ?? undefined,
        messageId: snapshot?.messageId ?? undefined,
      },
    };
    if (isStaleBaselineAssistant(candidate, baselineAssistant)) {
      await delay(350);
      continue;
    }
    return candidate;
  }
  return null;
}

async function retryResumeAfterAssistantShell(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<ReattachResult | null> {
  const delayMs = Math.max(0, config?.assistantRecheckDelayMs ?? 0);
  const timeoutMs = Math.max(0, config?.assistantRecheckTimeoutMs ?? 0);
  if (!delayMs || !timeoutMs) {
    return null;
  }
  const deadline = Date.now() + timeoutMs;
  const retryConfig: BrowserSessionConfig = {
    ...(config ?? {}),
    assistantRecheckDelayMs: 0,
    assistantRecheckTimeoutMs: 0,
  };
  while (Date.now() < deadline) {
    const waitMs = Math.min(delayMs, Math.max(0, deadline - Date.now()));
    if (waitMs <= 0) {
      break;
    }
    logger(
      `[browser] Assistant is still showing a thinking shell; waiting ${Math.max(1, Math.round(waitMs / 1000))}s before rechecking conversation.`,
    );
    await delay(waitMs);
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs <= 0) {
      break;
    }
    try {
      return await resumeBrowserSession(
        runtime,
        withTimeoutBudget(retryConfig, remainingMs),
        logger,
        {
          ...deps,
          forceConversationReload: true,
        },
      );
    } catch (error) {
      if (isAssistantRateLimitFailure(error)) {
        throw error;
      }
      if (!isAssistantEmptyResponseError(error)) {
        throw error;
      }
    }
  }
  return null;
}

function isTransientReattachAnswer(text: string): boolean {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return true;
  }
  const withoutPrefix = normalized.replace(/^chatgpt said:\s*/, "").trim();
  if (!withoutPrefix) {
    return true;
  }
  if (withoutPrefix === "thinking" || withoutPrefix === "pro thinking") {
    return true;
  }
  if (
    /^(?:starting|finalizing answer)(?:\.{3}|…)?$/.test(withoutPrefix) ||
    /^(?:analyzing|researching|reasoning|planning|drafting|reading|browsing|searching(?: the web)?)(?:\.{3}|…)?$/.test(
      withoutPrefix,
    )
  ) {
    return true;
  }
  return /^thought for\b.+?(?:seconds?|minutes?|hours?|secs?|mins?|hrs?|ms|s|m|h)(?:\s+thinking)?$/.test(
    withoutPrefix,
  );
}

function shouldPromoteExpandedReattachAnswer(nextText: string, currentText: string): boolean {
  const next = String(nextText || "").trim();
  const current = String(currentText || "").trim();
  if (!next) {
    return false;
  }
  if (!current) {
    return true;
  }
  if (next === current || next.length <= current.length) {
    return false;
  }
  const normalizedNext = next.toLowerCase().replace(/\s+/g, " ").trim();
  const normalizedCurrent = current.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalizedCurrent) {
    return true;
  }
  if (normalizedNext.includes(normalizedCurrent)) {
    return true;
  }
  return next.length >= current.length + Math.max(24, Math.floor(current.length * 0.15));
}

function pickPreferredReattachBody(answerText: string, answerMarkdown: string): string {
  const text = String(answerText || "").trim();
  const markdown = String(answerMarkdown || "").trim();
  if (!markdown) {
    return text;
  }
  if (!text) {
    return markdown;
  }
  if (text === markdown) {
    return markdown;
  }
  if (isTransientReattachAnswer(markdown) && !isTransientReattachAnswer(text)) {
    return text;
  }
  const normalizedText = text.toLowerCase().replace(/\s+/g, " ").trim();
  const normalizedMarkdown = markdown.toLowerCase().replace(/\s+/g, " ").trim();
  if (
    normalizedMarkdown &&
    normalizedText.length > normalizedMarkdown.length &&
    normalizedText.includes(normalizedMarkdown)
  ) {
    return text;
  }
  const lengthDelta = text.length - markdown.length;
  if (lengthDelta >= Math.max(12, Math.floor(markdown.length * 0.75))) {
    return text;
  }
  return markdown;
}

function collapseReattachAnswer(
  answerText: string,
  answerMarkdown: string,
): {
  answerText: string;
  answerMarkdown: string;
} {
  const text = String(answerText || "").trim();
  const markdown = String(answerMarkdown || "").trim();
  const preferred = pickPreferredReattachBody(text, markdown);
  let preferredMarkdown = markdown;
  if (!preferredMarkdown) {
    preferredMarkdown = preferred;
  } else if (isTransientReattachAnswer(preferredMarkdown) && !isTransientReattachAnswer(text)) {
    preferredMarkdown = preferred;
  } else {
    const normalizedText = text.toLowerCase().replace(/\s+/g, " ").trim();
    const normalizedMarkdown = preferredMarkdown.toLowerCase().replace(/\s+/g, " ").trim();
    const markdownLooksStructured =
      /[`*_>#()[\]|-]/.test(preferredMarkdown) || preferredMarkdown.includes("\n");
    if (
      normalizedMarkdown &&
      normalizedText.length > normalizedMarkdown.length &&
      normalizedText.includes(normalizedMarkdown)
    ) {
      const materiallyShorter =
        text.length - preferredMarkdown.length >=
        Math.max(12, Math.floor(preferredMarkdown.length * 0.75));
      if (!markdownLooksStructured || materiallyShorter) {
        preferredMarkdown = preferred;
      }
    }
  }
  return {
    answerText: preferred,
    answerMarkdown: preferredMarkdown,
  };
}

async function recoverTransientReattachAnswer({
  Runtime,
  captureMarkdown,
  logger,
  matcher,
  minTurnIndex,
  timeoutMs,
}: {
  Runtime: ChromeClient["Runtime"];
  captureMarkdown: typeof captureAssistantMarkdown;
  logger: BrowserLogger;
  matcher: ReturnType<typeof buildPromptEchoMatcher>;
  minTurnIndex: number | null;
  timeoutMs: number;
}): Promise<{ answerText: string; answerMarkdown: string } | null> {
  const deadline = Date.now() + Math.min(timeoutMs, 15_000);
  let bestSnapshot: {
    text: string;
    meta: { turnId?: string | null; messageId?: string | null };
  } | null = null;
  let stableCount = 0;
  while (Date.now() < deadline) {
    const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex ?? undefined).catch(
      () => null,
    );
    const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
    if (!text || isTransientReattachAnswer(text) || matcher?.isEcho(text)) {
      await delay(350);
      continue;
    }
    if (!bestSnapshot || text.length > bestSnapshot.text.length) {
      bestSnapshot = {
        text,
        meta: {
          turnId: snapshot?.turnId ?? undefined,
          messageId: snapshot?.messageId ?? undefined,
        },
      };
      stableCount = 0;
    } else if (text === bestSnapshot.text) {
      stableCount += 1;
    }
    if (stableCount >= 1) {
      break;
    }
    await delay(350);
  }
  if (!bestSnapshot) {
    return null;
  }
  const markdown =
    (await captureMarkdown(
      Runtime,
      {
        messageId: bestSnapshot.meta.messageId ?? undefined,
        turnId: bestSnapshot.meta.turnId ?? undefined,
      },
      logger,
      minTurnIndex ?? undefined,
    ).catch(() => null)) ?? bestSnapshot.text;
  logger("Recovered follow-up assistant response after transient thinking scaffold");
  const aligned = alignPromptEchoMarkdown(bestSnapshot.text, markdown, matcher, logger);
  return collapseReattachAnswer(aligned.answerText, aligned.answerMarkdown);
}

async function recoverExpandedReattachAnswer({
  Runtime,
  captureMarkdown,
  logger,
  matcher,
  minTurnIndex,
  timeoutMs,
  currentText,
  currentMarkdown,
  currentMeta,
}: {
  Runtime: ChromeClient["Runtime"];
  captureMarkdown: typeof captureAssistantMarkdown;
  logger: BrowserLogger;
  matcher: ReturnType<typeof buildPromptEchoMatcher>;
  minTurnIndex: number | null;
  timeoutMs: number;
  currentText: string;
  currentMarkdown: string;
  currentMeta: { turnId?: string | null; messageId?: string | null };
}): Promise<{ answerText: string; answerMarkdown: string } | null> {
  const trimmedCurrentText = currentText.trim();
  if (trimmedCurrentText.length < 16) {
    return null;
  }
  const deadline = Date.now() + Math.min(timeoutMs, 15_000);
  let bestSnapshot = {
    text: trimmedCurrentText,
    meta: {
      turnId: currentMeta.turnId ?? undefined,
      messageId: currentMeta.messageId ?? undefined,
    },
  };
  let improved = false;
  let emptyPolls = 0;
  while (Date.now() < deadline) {
    const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex ?? undefined).catch(
      () => null,
    );
    const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
    if (!text || isTransientReattachAnswer(text) || matcher?.isEcho(text)) {
      emptyPolls += 1;
      if (emptyPolls >= 20 && improved) {
        break;
      }
      await delay(350);
      continue;
    }
    emptyPolls = 0;
    if (shouldPromoteExpandedReattachAnswer(text, bestSnapshot.text)) {
      bestSnapshot = {
        text,
        meta: {
          turnId: snapshot?.turnId ?? undefined,
          messageId: snapshot?.messageId ?? undefined,
        },
      };
      improved = true;
      break;
    }
    await delay(350);
  }
  if (!improved) {
    return null;
  }
  const markdown =
    (await captureMarkdown(
      Runtime,
      {
        messageId: bestSnapshot.meta.messageId ?? undefined,
        turnId: bestSnapshot.meta.turnId ?? undefined,
      },
      logger,
      minTurnIndex ?? undefined,
    ).catch(() => null)) ??
    currentMarkdown ??
    bestSnapshot.text;
  const aligned = alignPromptEchoMarkdown(bestSnapshot.text, markdown, matcher, logger);
  logger("Recovered expanded assistant response during reattach");
  return collapseReattachAnswer(aligned.answerText, aligned.answerMarkdown);
}

async function recoverShortReattachAnswer({
  Runtime,
  captureMarkdown,
  logger,
  matcher,
  minTurnIndex,
  timeoutMs,
  currentText,
  currentMarkdown,
  currentMeta,
}: {
  Runtime: ChromeClient["Runtime"];
  captureMarkdown: typeof captureAssistantMarkdown;
  logger: BrowserLogger;
  matcher: ReturnType<typeof buildPromptEchoMatcher>;
  minTurnIndex: number | null;
  timeoutMs: number;
  currentText: string;
  currentMarkdown: string;
  currentMeta: { turnId?: string | null; messageId?: string | null };
}): Promise<{ answerText: string; answerMarkdown: string } | null> {
  const minAnswerChars = 16;
  const currentLength = String(currentText || "").trim().length;
  if (currentLength === 0 || currentLength >= minAnswerChars) {
    return null;
  }
  const currentMarkdownLength = String(currentMarkdown || "").trim().length;
  const suspiciouslyShort = currentLength <= 1 && currentMarkdownLength <= 1;
  const deadline = Date.now() + Math.min(timeoutMs, suspiciouslyShort ? 12_000 : 2_000);
  let bestSnapshot = {
    text: currentText.trim(),
    meta: {
      turnId: currentMeta.turnId ?? undefined,
      messageId: currentMeta.messageId ?? undefined,
    },
  };
  let stableCycles = 0;
  let noImprovementCycles = 0;
  while (Date.now() < deadline) {
    const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex ?? undefined).catch(
      () => null,
    );
    const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
    if (!text || isTransientReattachAnswer(text) || matcher?.isEcho(text)) {
      stableCycles += 1;
      noImprovementCycles += 1;
      if (!suspiciouslyShort && noImprovementCycles >= 3) {
        break;
      }
      await delay(400);
      continue;
    }
    if (text.length > bestSnapshot.text.length) {
      bestSnapshot = {
        text,
        meta: {
          turnId: snapshot?.turnId ?? undefined,
          messageId: snapshot?.messageId ?? undefined,
        },
      };
      stableCycles = 0;
      noImprovementCycles = 0;
    } else {
      stableCycles += 1;
      noImprovementCycles += 1;
    }
    if (stableCycles >= 2 && bestSnapshot.text.length >= minAnswerChars) {
      break;
    }
    if (!suspiciouslyShort && noImprovementCycles >= 2) {
      break;
    }
    await delay(400);
  }
  if (bestSnapshot.text.length <= currentLength) {
    return null;
  }
  const markdown =
    (await captureMarkdown(
      Runtime,
      {
        messageId: bestSnapshot.meta.messageId ?? undefined,
        turnId: bestSnapshot.meta.turnId ?? undefined,
      },
      logger,
      minTurnIndex ?? undefined,
    ).catch(() => null)) ??
    currentMarkdown ??
    bestSnapshot.text;
  const aligned = alignPromptEchoMarkdown(bestSnapshot.text, markdown, matcher, logger);
  logger("Recovered short follow-up assistant response from latest DOM snapshot");
  return collapseReattachAnswer(aligned.answerText, aligned.answerMarkdown);
}

async function applyConversationSettings(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  config: BrowserSessionConfig | undefined,
  deps: ReattachDeps,
): Promise<void> {
  const ensurePromptReadyForFollowup = deps.ensurePromptReady ?? ensurePromptReady;
  const ensureModel = deps.ensureModelSelection ?? ensureModelSelection;
  const ensureThinking = deps.ensureThinkingTime ?? ensureThinkingTime;
  const modelStrategy = config?.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
  if (config?.desiredModel && modelStrategy !== "ignore") {
    await withRetries(
      () => ensureModel(Runtime, config.desiredModel as string, logger, modelStrategy),
      {
        retries: 2,
        delayMs: 300,
        onRetry: (attempt, error) => {
          if (logger.verbose) {
            logger(
              `[retry] Model picker attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
            );
          }
        },
      },
    );
    await ensurePromptReadyForFollowup(Runtime, config.inputTimeoutMs ?? 60_000, logger);
  } else if (modelStrategy === "ignore") {
    logger("Model picker: skipped (strategy=ignore)");
  }
  const thinkingTime = config?.thinkingTime;
  if (thinkingTime) {
    await withRetries(() => ensureThinking(Runtime, thinkingTime, logger), {
      retries: 2,
      delayMs: 300,
      onRetry: (attempt, error) => {
        if (logger.verbose) {
          logger(
            `[retry] Thinking time (${thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
          );
        }
      },
    });
  }
}

async function submitFollowupPrompt(
  Runtime: ChromeClient["Runtime"],
  DOM: ChromeClient["DOM"] | undefined,
  Input: ChromeClient["Input"],
  logger: BrowserLogger,
  options: ContinueBrowserSessionOptions,
  config: BrowserSessionConfig | undefined,
  deps: ReattachDeps,
): Promise<{
  promptPreview: string;
  baselineTurns: number | null;
  baselineAssistant: {
    text: string;
    messageId?: string | null;
    turnId?: string | null;
  } | null;
}> {
  const ensurePromptReadyForFollowup = deps.ensurePromptReady ?? ensurePromptReady;
  const clearComposer = deps.clearPromptComposer ?? clearPromptComposer;
  const submit = deps.submitPrompt ?? submitPrompt;
  const clearAttachments = deps.clearComposerAttachments ?? clearComposerAttachments;
  const uploadAttachment = deps.uploadAttachmentFile ?? uploadAttachmentFile;
  const waitForAttachments = deps.waitForAttachmentCompletion ?? waitForAttachmentCompletion;
  const waitForSentAttachments = deps.waitForUserTurnAttachments ?? waitForUserTurnAttachments;
  const submitOnce = async (
    prompt: string,
    attachments: BrowserAttachment[] = [],
  ): Promise<{
    baselineTurns: number | null;
    baselineAssistant: {
      text: string;
      messageId?: string | null;
      turnId?: string | null;
    } | null;
  }> => {
    let promptSubmitted = false;
    let baselineTurns: number | null = null;
    let baselineAssistant: {
      text: string;
      messageId?: string | null;
      turnId?: string | null;
    } | null = null;
    let progressCommitted = false;
    const markPromptCommitted = async (): Promise<void> => {
      if (progressCommitted) {
        return;
      }
      progressCommitted = true;
      const attachmentLabel =
        attachments.length > 0
          ? ` with ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`
          : "";
      await reportBrowserProgress(logger, {
        stage: "prompt-committed",
        message: `Committed the follow-up prompt to the bound ChatGPT conversation${attachmentLabel}.`,
      });
    };
    try {
      await ensurePromptReadyForFollowup(Runtime, config?.inputTimeoutMs ?? 60_000, logger);
      await clearComposer(Runtime, logger);
      const attachmentNames = attachments.map((attachment) => path.basename(attachment.path));
      let attachmentWaitTimedOut = false;
      let inputOnlyAttachments = false;
      if (attachments.length > 0) {
        if (!DOM) {
          throw new Error("Chrome DOM domain unavailable while uploading attachments.");
        }
        await clearAttachments(Runtime, 5_000, logger);
        for (let attachmentIndex = 0; attachmentIndex < attachments.length; attachmentIndex += 1) {
          const attachment = attachments[attachmentIndex];
          logger(`Uploading attachment: ${attachment.displayPath}`);
          const uiConfirmed = await uploadAttachment(
            { runtime: Runtime, dom: DOM, input: Input },
            attachment,
            logger,
            { expectedCount: attachmentIndex + 1 },
          );
          if (!uiConfirmed) {
            inputOnlyAttachments = true;
          }
          await delay(500);
        }
        const baseTimeout = config?.inputTimeoutMs ?? 30_000;
        const perFileTimeout = 20_000;
        const waitBudget =
          Math.max(baseTimeout, 45_000) + (attachments.length - 1) * perFileTimeout;
        try {
          await waitForAttachments(Runtime, waitBudget, attachmentNames, logger);
          logger("All attachments uploaded");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/Attachments did not finish uploading before timeout/i.test(message)) {
            attachmentWaitTimedOut = true;
            logger(
              `[browser] Attachment upload timed out after ${Math.round(waitBudget / 1000)}s; continuing without confirmation.`,
            );
          } else {
            throw error;
          }
        }
      }
      const baselineTurnIndex = await readConversationTurnIndex(Runtime, logger);
      baselineTurns =
        typeof baselineTurnIndex === "number" && Number.isFinite(baselineTurnIndex)
          ? baselineTurnIndex + 1
          : null;
      const baselineSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);
      const baselineText =
        typeof baselineSnapshot?.text === "string" ? baselineSnapshot.text.trim() : "";
      baselineAssistant = baselineText
        ? {
            text: baselineText,
            messageId: baselineSnapshot?.messageId ?? undefined,
            turnId: baselineSnapshot?.turnId ?? undefined,
          }
        : deps.baselineAssistant
          ? {
              text: deps.baselineAssistant.text,
              messageId: deps.baselineAssistant.messageId ?? undefined,
              turnId: deps.baselineAssistant.turnId ?? undefined,
            }
          : null;
      await submit(
        {
          runtime: Runtime,
          input: Input,
          baselineTurns: baselineTurns ?? undefined,
          inputTimeoutMs: config?.inputTimeoutMs ?? undefined,
        },
        prompt,
        logger,
      );
      promptSubmitted = true;
      await markPromptCommitted();
      if (attachmentNames.length === 0) {
        return { baselineTurns, baselineAssistant };
      }
      if (attachmentWaitTimedOut) {
        logger("Attachment confirmation timed out; skipping user-turn attachment verification.");
        return { baselineTurns, baselineAssistant };
      }
      if (inputOnlyAttachments) {
        logger(
          "Attachment UI did not render before send; skipping user-turn attachment verification.",
        );
        return { baselineTurns, baselineAssistant };
      }
      const verified = await waitForSentAttachments(Runtime, attachmentNames, 20_000, logger);
      if (!verified) {
        throw new Error("Sent user message did not expose attachment UI after upload.");
      }
      logger("Verified attachments present on sent user message");
      return { baselineTurns, baselineAssistant };
    } catch (error) {
      const postSubmitDetails =
        error instanceof BrowserAutomationError
          ? (error.details as
              | {
                  promptSubmitted?: boolean;
                  submittedPrompt?: string;
                  baselineTurns?: number | null;
                  baselineAssistant?: {
                    text: string;
                    messageId?: string | null;
                    turnId?: string | null;
                  } | null;
                  code?: string;
                }
              | undefined)
          : undefined;
      const errorPromptSubmitted = postSubmitDetails?.promptSubmitted === true;
      if (postSubmitDetails?.submittedPrompt) {
        prompt = postSubmitDetails.submittedPrompt;
      }
      if (typeof postSubmitDetails?.baselineTurns === "number") {
        baselineTurns = postSubmitDetails.baselineTurns;
      }
      if ("baselineAssistant" in (postSubmitDetails ?? {})) {
        baselineAssistant = postSubmitDetails?.baselineAssistant ?? baselineAssistant;
      }
      if (promptSubmitted || errorPromptSubmitted) {
        await markPromptCommitted();
        throw new BrowserAutomationError(
          error instanceof Error ? error.message : "Follow-up verification failed after send.",
          {
            stage: "followup-post-submit",
            promptSubmitted: true,
            submittedPrompt: prompt,
            baselineTurns,
            baselineAssistant,
            code: postSubmitDetails?.code,
          },
          error,
        );
      }
      throw error;
    }
  };
  try {
    const submission = await submitOnce(options.prompt, options.attachments ?? []);
    return {
      promptPreview: options.prompt,
      baselineTurns: submission.baselineTurns,
      baselineAssistant: submission.baselineAssistant,
    };
  } catch (error) {
    const isPromptTooLarge =
      error instanceof BrowserAutomationError &&
      (error.details as { code?: string } | undefined)?.code === "prompt-too-large";
    if (options.fallbackSubmission && isPromptTooLarge) {
      logger("[browser] Inline prompt too large; retrying with file uploads.");
      const submission = await submitOnce(
        options.fallbackSubmission.prompt,
        options.fallbackSubmission.attachments,
      );
      return {
        promptPreview: options.fallbackSubmission.prompt,
        baselineTurns: submission.baselineTurns,
        baselineAssistant: submission.baselineAssistant,
      };
    }
    throw error;
  }
}

export async function resumeBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps = {},
): Promise<ReattachResult> {
  runtime = await refreshBrowserbaseRuntimeForReattach(runtime, config);
  const reattachBaseUrl = resolveBrowserConfig(config ?? {}).url;
  const recoverSession =
    deps.recoverSession ??
    (async (runtimeMeta, configMeta) => {
      if (isBrowserbaseRuntime(runtimeMeta)) {
        throw browserbaseRecoveryUnavailable(runtimeMeta);
      }
      return resumeBrowserSessionViaNewChrome(runtimeMeta, configMeta, logger, deps);
    });

  if (!runtime.chromePort && !runtime.chromeBrowserWSEndpoint) {
    logger("No running Chrome detected; reopening browser to locate the session.");
    return recoverSession(runtime, config);
  }

  let closeConnection: (() => Promise<void>) | undefined;
  let targetId: string | undefined;
  try {
    return await withHiddenExistingChrome(runtime, config, logger, async (liveRuntime) => {
      const connection = await connectToExistingRuntime(liveRuntime, config, logger, deps);
      closeConnection = connection.close;
      const { client, host, port, target } = connection;
      targetId = target?.targetId;
      if (target && !isAttachableChatTarget(target)) {
        logger(
          `[browser] Cached Oracle target type=${target.type}; reopening the conversation in a dedicated page target before recovering the session.`,
        );
        return recoverSession(liveRuntime, config);
      }
      const { Runtime, DOM, Page } = client;
      if (Runtime?.enable) {
        await Runtime.enable();
      }
      if (DOM && typeof DOM.enable === "function") {
        await DOM.enable();
      }

      const timeoutMs = config?.timeoutMs ?? 120_000;
      const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
      await withTimeout(
        Runtime.evaluate({ expression: "1+1", returnByValue: true }),
        pingTimeoutMs,
        "Reattach target did not respond",
      );
      await ensureConversationOpenForRuntime(
        Runtime,
        liveRuntime,
        deps.promptPreview,
        reattachBaseUrl,
      );
      const boundHref = await readCurrentHref(Runtime).catch(() => liveRuntime.tabUrl ?? "");
      const boundRuntime = mergeRuntimeMetadata(liveRuntime, {
        chromeHost: host,
        chromePort: port,
        chromeTargetId: target?.targetId,
        tabUrl: boundHref || liveRuntime.tabUrl,
        controllerPid: process.pid,
      });
      await reportBrowserProgress(logger, {
        stage: "thread-bound",
        message: `Bound to existing ChatGPT conversation ${boundRuntime.conversationId ?? "unknown"}.`,
        runtime: boundRuntime,
      });
      if (deps.forceConversationReload && Page && typeof Page.navigate === "function") {
        const conversationUrl = await readCurrentHref(Runtime);
        const reloadUrl =
          (conversationUrl && conversationUrl.includes("/c/") ? conversationUrl : null) ??
          buildConversationUrl(liveRuntime, reattachBaseUrl);
        if (reloadUrl) {
          logger(`[browser] Rechecking assistant response at ${reloadUrl}`);
          await Page.navigate({ url: reloadUrl });
          await delay(1000);
        }
      }
      const result = await captureConversationResponse(
        boundRuntime,
        Runtime,
        logger,
        deps,
        timeoutMs,
        deps.promptPreview,
        deps.baselineTurns,
        deps.downloadsDir,
        client,
      );
      const href = await readCurrentHref(Runtime);
      await connection.close().catch(() => undefined);

      return {
        ...result,
        runtime: mergeRuntimeMetadata(boundRuntime, {
          chromeHost: host,
          chromePort: port,
          chromeTargetId: target?.targetId,
          tabUrl: href || boundRuntime.tabUrl,
        }),
      };
    });
  } catch (error) {
    if (closeConnection) {
      await closeConnection().catch(() => undefined);
    }
    if (isAssistantRateLimitFailure(error)) {
      if (isAssistantRateLimitAutomationError(error)) {
        throw error;
      }
      throw new BrowserAutomationError(
        "ChatGPT temporarily limited this browser profile after too many requests. Wait a few minutes before retrying.",
        {
          stage: "assistant-rate-limit",
          runtime: mergeRuntimeMetadata(runtime, {
            chromeTargetId: targetId,
          }),
        },
        error,
      );
    }
    if (isAssistantEmptyResponseError(error)) {
      const rechecked = await retryResumeAfterAssistantShell(runtime, config, logger, deps);
      if (rechecked) {
        return rechecked;
      }
      throw error;
    }
    if (isSessionIdentityError(error)) {
      if (isRecoverableSessionDiscoveryError(error) && getRuntimeConversationId(runtime)) {
        const message = error instanceof Error ? error.message : String(error);
        logger(
          `Existing Chrome reattach could not safely reuse the prior target (${message}); reopening browser to locate the stored conversation.`,
        );
        return recoverSession(runtime, config);
      }
      throw error;
    }
    if (isHiddenBrowserReuseRequiredError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger(
      `Existing Chrome reattach failed (${message}); reopening browser to locate the session.`,
    );
    return recoverSession(runtime, config);
  }
}

async function resumeBrowserSessionViaNewChrome(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<ReattachResult> {
  const resolved = resolveBrowserConfig(config ?? {});
  const launchConfig = normalizeLocalChromeLaunchConfig(resolved);
  const ensurePromptReadyForFollowup = deps.ensurePromptReady ?? ensurePromptReady;
  const manualLogin = Boolean(launchConfig.manualLogin);
  const userDataDir = manualLogin
    ? (launchConfig.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile"))
    : await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
  }
  const shouldHideChromeWindow =
    launchConfig.launcher !== "carbonyl" && !launchConfig.headless && launchConfig.hideWindow;
  const reusedChrome = manualLogin
    ? await maybeReuseRunningChrome(userDataDir, logger, {
        waitForPortMs: launchConfig.reuseChromeWaitMs,
        failOnLiveChromeWithoutDevtools: true,
      })
    : null;
  const chrome = reusedChrome ?? (await launchChrome(launchConfig, userDataDir, logger));
  const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
  const strictTabIsolation = Boolean(manualLogin && reusedChrome);
  let stopChromeFocusGuard: (() => void) | null = null;
  if (shouldHideChromeWindow) {
    stopChromeFocusGuard = startChromeFocusGuard(chrome, logger);
    await hideChromeWindow(chrome, logger);
  }
  try {
    const { client, isolatedTargetId } = await connectReopenedChrome(
      chrome,
      chromeHost,
      logger,
      strictTabIsolation,
      shouldHideChromeWindow,
    );
    const { Network, Page, Runtime, DOM } = client;

    if (Runtime?.enable) {
      await Runtime.enable();
    }
    if (DOM && typeof DOM.enable === "function") {
      await DOM.enable();
    }

    let appliedCookies = 0;
    if (!manualLogin && launchConfig.cookieSync) {
      appliedCookies = await syncCookies(
        Network,
        launchConfig.url,
        launchConfig.chromeProfile,
        logger,
        {
          allowErrors: launchConfig.allowCookieErrors,
          filterNames: launchConfig.cookieNames ?? undefined,
          inlineCookies: launchConfig.inlineCookies ?? undefined,
          cookiePath: launchConfig.chromeCookiePath ?? undefined,
          waitMs: launchConfig.cookieSyncWaitMs ?? 0,
        },
      );
    }

    await navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger);
    await ensureNotBlocked(Runtime, launchConfig.headless, logger);
    await ensureLoggedIn(Runtime, logger, { appliedCookies });
    if (launchConfig.url !== CHATGPT_URL) {
      await navigateToChatGPT(Page, Runtime, launchConfig.url, logger);
      await ensureNotBlocked(Runtime, launchConfig.headless, logger);
    }
    const conversationUrl = buildConversationUrl(runtime, launchConfig.url);
    const hasReusableConversation = Boolean(conversationUrl || runtimeHasReusableIdentity(runtime));
    if (hasReusableConversation) {
      logger(
        conversationUrl
          ? `Reopening conversation at ${conversationUrl}`
          : "Reopening stored Oracle conversation.",
      );
      await ensureConversationOpenForRuntime(
        Runtime,
        runtime,
        deps.promptPreview,
        launchConfig.url,
      );
      await ensureNotBlocked(Runtime, launchConfig.headless, logger);
      await ensurePromptReadyForFollowup(Runtime, launchConfig.inputTimeoutMs, logger);
    } else {
      await ensurePromptReadyForFollowup(Runtime, launchConfig.inputTimeoutMs, logger);
    }
    const boundHref = await readCurrentHref(Runtime).catch(
      () => conversationUrl || runtime.tabUrl || "",
    );
    const boundRuntime = mergeRuntimeMetadata(runtime, {
      chromePid: chrome.pid,
      chromeHost,
      chromePort: chrome.port,
      chromeTargetId: isolatedTargetId ?? null,
      tabUrl: boundHref || conversationUrl || runtime.tabUrl,
      userDataDir,
      controllerPid: process.pid,
    });
    await reportBrowserProgress(logger, {
      stage: "thread-bound",
      message: `Bound to existing ChatGPT conversation ${boundRuntime.conversationId ?? "unknown"}.`,
      runtime: boundRuntime,
    });

    const result = await captureConversationResponse(
      boundRuntime,
      Runtime,
      logger,
      deps,
      resolved.timeoutMs ?? 120_000,
      deps.promptPreview,
      deps.baselineTurns,
      deps.downloadsDir,
      client,
    );
    const href = await readCurrentHref(Runtime);
    await closeClient(client);
    if (isolatedTargetId && chrome.port) {
      await closeTab(chrome.port, isolatedTargetId, logger, chromeHost).catch(() => undefined);
    }

    if (!launchConfig.keepBrowser && !reusedChrome) {
      try {
        await chrome.kill();
      } catch {
        // ignore
      }
      if (manualLogin) {
        await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
          () => undefined,
        );
      } else {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    return {
      ...result,
      runtime: mergeRuntimeMetadata(boundRuntime, {
        chromePid: chrome.pid,
        chromeHost,
        chromePort: chrome.port,
        chromeTargetId: isolatedTargetId ?? null,
        tabUrl: href || boundRuntime.tabUrl,
        userDataDir,
        controllerPid: process.pid,
      }),
    };
  } finally {
    if (shouldHideChromeWindow) {
      await finalizeChromeFocusProtection(chrome, logger, stopChromeFocusGuard);
      stopChromeFocusGuard = null;
    }
  }
}

export async function continueBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  options: ContinueBrowserSessionOptions,
  deps: ReattachDeps = {},
): Promise<ReattachResult> {
  runtime = await refreshBrowserbaseRuntimeForReattach(runtime, config);
  const prompt = options.prompt.trim();
  if (!prompt) {
    throw new Error("Prompt text is required to continue a browser session.");
  }
  const reattachBaseUrl = resolveBrowserConfig(config ?? {}).url;

  const recoverSession =
    deps.recoverSession ??
    (async (runtimeMeta, configMeta) => {
      if (isBrowserbaseRuntime(runtimeMeta)) {
        throw browserbaseRecoveryUnavailable(runtimeMeta);
      }
      return continueBrowserSessionViaNewChrome(runtimeMeta, configMeta, logger, options, deps);
    });

  if (!runtime.chromePort && !runtime.chromeBrowserWSEndpoint) {
    logger("No running Chrome detected; reopening browser to continue the session.");
    return recoverSession(runtime, config);
  }

  let closeConnection: (() => Promise<void>) | undefined;
  let targetId: string | undefined;
  let promptSubmitted = false;
  let submittedPromptPreview = prompt;
  let submittedBaselineTurns: number | null = deps.baselineTurns ?? null;
  let submittedBaselineAssistant = deps.baselineAssistant ?? null;
  try {
    return await withHiddenExistingChrome(runtime, config, logger, async (liveRuntime) => {
      const browserWSEndpoint = liveRuntime.chromeBrowserWSEndpoint ?? undefined;
      if (browserWSEndpoint) {
        const host = liveRuntime.chromeHost ?? "127.0.0.1";
        const port =
          liveRuntime.chromePort ??
          inferPortFromBrowserWSEndpoint(liveRuntime.chromeBrowserWSEndpoint);
        const resolvedPort = port ?? 9222;
        const preflightTargets = await (
          deps.listTargets ??
          (async () =>
            (await listRemoteChromeTargets({
              host,
              port: resolvedPort,
              browserWSEndpoint,
            })) as TargetInfoLite[])
        )().catch(() => [] as TargetInfoLite[]);
        const cachedTarget = liveRuntime.chromeTargetId
          ? preflightTargets.find((candidate) => candidate.targetId === liveRuntime.chromeTargetId)
          : undefined;
        if (cachedTarget && !isAttachableChatTarget(cachedTarget)) {
          logger(
            `[browser] Cached Oracle target type=${cachedTarget.type}; reopening the conversation in a dedicated page target before sending the follow-up.`,
          );
          return recoverSession(liveRuntime, config);
        }
      }
      const connection = await connectToExistingRuntime(liveRuntime, config, logger, deps);
      closeConnection = connection.close;
      const { client, host, port, target } = connection;
      targetId = target?.targetId;
      if (target && !isAttachableChatTarget(target)) {
        logger(
          `[browser] Existing Oracle target type=${target.type}; reopening the conversation in a dedicated page target before sending the follow-up.`,
        );
        await connection.close().catch(() => undefined);
        closeConnection = undefined;
        return recoverSession(liveRuntime, config);
      }
      const { Runtime, DOM, Input } = client;
      if (Runtime?.enable) {
        await Runtime.enable();
      }
      if (DOM && typeof DOM.enable === "function") {
        await DOM.enable();
      }

      const timeoutMs = config?.timeoutMs ?? 120_000;
      const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
      await withTimeout(
        Runtime.evaluate({ expression: "1+1", returnByValue: true }),
        pingTimeoutMs,
        "Follow-up target did not respond",
      );
      await ensureConversationOpenForRuntime(
        Runtime,
        liveRuntime,
        deps.promptPreview,
        reattachBaseUrl,
      );
      const boundHref = await readCurrentHref(Runtime).catch(() => liveRuntime.tabUrl ?? "");
      const boundRuntime = mergeRuntimeMetadata(liveRuntime, {
        chromeHost: host,
        chromePort: port,
        chromeTargetId: target?.targetId,
        tabUrl: boundHref || liveRuntime.tabUrl,
        controllerPid: process.pid,
      });
      await reportBrowserProgress(logger, {
        stage: "thread-bound",
        message: `Bound to existing ChatGPT conversation ${boundRuntime.conversationId ?? "unknown"}.`,
        runtime: boundRuntime,
      });
      await applyConversationSettings(Runtime, logger, config, deps);
      const submission = await submitFollowupPrompt(
        Runtime,
        DOM,
        Input,
        logger,
        options,
        config,
        deps,
      );
      submittedPromptPreview = submission.promptPreview;
      submittedBaselineTurns = submission.baselineTurns;
      submittedBaselineAssistant = submission.baselineAssistant;
      promptSubmitted = true;
      const result = await captureConversationResponse(
        boundRuntime,
        Runtime,
        logger,
        {
          ...deps,
          baselineAssistant: submittedBaselineAssistant,
        },
        timeoutMs,
        submittedPromptPreview,
        submission.baselineTurns,
        options.downloadsDir,
        client,
      );
      const href = await readCurrentHref(Runtime);
      await connection.close().catch(() => undefined);

      return {
        ...result,
        runtime: mergeRuntimeMetadata(boundRuntime, {
          chromeHost: host,
          chromePort: port,
          chromeTargetId: target?.targetId,
          tabUrl: href || boundRuntime.tabUrl,
        }),
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (closeConnection) {
      await closeConnection().catch(() => undefined);
    }
    if (isAssistantRateLimitError(error)) {
      throw new BrowserAutomationError(
        "ChatGPT temporarily limited this browser profile after too many requests. Wait a few minutes before retrying.",
        {
          stage: "assistant-rate-limit",
          runtime: mergeRuntimeMetadata(runtime, {
            chromeTargetId: targetId,
          }),
        },
        error,
      );
    }
    const postSubmitDetails =
      error instanceof BrowserAutomationError
        ? (error.details as
            | {
                promptSubmitted?: boolean;
                submittedPrompt?: string;
                baselineTurns?: number | null;
                baselineAssistant?: {
                  text: string;
                  messageId?: string | null;
                  turnId?: string | null;
                } | null;
              }
            | undefined)
        : undefined;
    const errorPromptSubmitted = postSubmitDetails?.promptSubmitted === true;
    if (postSubmitDetails?.submittedPrompt) {
      submittedPromptPreview = postSubmitDetails.submittedPrompt;
    }
    if (typeof postSubmitDetails?.baselineTurns === "number") {
      submittedBaselineTurns = postSubmitDetails.baselineTurns;
    }
    if ("baselineAssistant" in (postSubmitDetails ?? {})) {
      submittedBaselineAssistant = postSubmitDetails?.baselineAssistant ?? null;
    }
    const assistantRecheckConfigured =
      Math.max(0, config?.assistantRecheckDelayMs ?? 0) > 0 &&
      Math.max(0, config?.assistantRecheckTimeoutMs ?? 0) > 0;
    if (
      isAssistantEmptyResponseError(error) &&
      (!(promptSubmitted || errorPromptSubmitted) || !assistantRecheckConfigured)
    ) {
      throw error;
    }
    if (isSessionIdentityError(error)) {
      if (isRecoverableSessionDiscoveryError(error) && runtimeHasReusableIdentity(runtime)) {
        const message = error instanceof Error ? error.message : String(error);
        logger(
          `Existing Chrome follow-up could not safely reuse the prior target (${message}); reopening browser to continue the session.`,
        );
        return recoverSession(runtime, config);
      }
      throw error;
    }
    if (isHiddenBrowserReuseRequiredError(error)) {
      throw error;
    }
    if (promptSubmitted || errorPromptSubmitted) {
      const { recoverSession: _recoverSession, ...resumeDeps } = deps;
      logger(
        isAssistantEmptyResponseError(error)
          ? "[browser] Existing Chrome follow-up is still on a thinking shell; reattaching without resending."
          : `Existing Chrome follow-up lost DevTools after sending the prompt (${message}); reopening browser to resume without resending.`,
      );
      const liveRuntime =
        (await refreshAttachRuntime(runtime, config, error).catch((refreshError) => {
          if (isBrowserbaseRuntime(runtime)) {
            throw refreshError;
          }
          return runtime;
        })) ?? runtime;
      const resumeConfig =
        isAssistantEmptyResponseError(error) && assistantRecheckConfigured
          ? withAssistantRecheckBudget(config)
          : config;
      return resumeBrowserSession(
        mergeRuntimeMetadata(liveRuntime, {
          chromeTargetId: targetId,
        }),
        resumeConfig,
        logger,
        {
          ...resumeDeps,
          promptPreview: submittedPromptPreview,
          baselineTurns: submittedBaselineTurns,
          baselineAssistant: submittedBaselineAssistant,
        },
      );
    }
    logger(
      `Existing Chrome follow-up failed (${message}); reopening browser to continue the session.`,
    );
    return recoverSession(runtime, config);
  }
}

async function continueBrowserSessionViaNewChrome(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  options: ContinueBrowserSessionOptions,
  deps: ReattachDeps,
): Promise<ReattachResult> {
  const resolved = resolveBrowserConfig(config ?? {});
  const launchConfig = normalizeLocalChromeLaunchConfig(resolved);
  const manualLogin = Boolean(launchConfig.manualLogin);
  const userDataDir = manualLogin
    ? (launchConfig.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile"))
    : await mkdtemp(path.join(os.tmpdir(), "oracle-followup-"));
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
  }
  const shouldHideChromeWindow =
    launchConfig.launcher !== "carbonyl" && !launchConfig.headless && launchConfig.hideWindow;
  const reusedChrome = manualLogin
    ? await maybeReuseRunningChrome(userDataDir, logger, {
        waitForPortMs: launchConfig.reuseChromeWaitMs,
        failOnLiveChromeWithoutDevtools: true,
      })
    : null;
  const chrome = reusedChrome ?? (await launchChrome(launchConfig, userDataDir, logger));
  const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
  const strictTabIsolation = Boolean(manualLogin && reusedChrome);
  let stopChromeFocusGuard: (() => void) | null = null;
  if (shouldHideChromeWindow) {
    stopChromeFocusGuard = startChromeFocusGuard(chrome, logger);
    await hideChromeWindow(chrome, logger);
  }
  try {
    const { client, isolatedTargetId } = await connectReopenedChrome(
      chrome,
      chromeHost,
      logger,
      strictTabIsolation,
      shouldHideChromeWindow,
    );
    const { Network, Page, Runtime, DOM, Input } = client;

    if (Runtime?.enable) {
      await Runtime.enable();
    }
    if (DOM && typeof DOM.enable === "function") {
      await DOM.enable();
    }

    let appliedCookies = 0;
    if (!manualLogin && launchConfig.cookieSync) {
      appliedCookies = await syncCookies(
        Network,
        launchConfig.url,
        launchConfig.chromeProfile,
        logger,
        {
          allowErrors: launchConfig.allowCookieErrors,
          filterNames: launchConfig.cookieNames ?? undefined,
          inlineCookies: launchConfig.inlineCookies ?? undefined,
          cookiePath: launchConfig.chromeCookiePath ?? undefined,
          waitMs: launchConfig.cookieSyncWaitMs ?? 0,
        },
      );
    }

    await navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger);
    await ensureNotBlocked(Runtime, launchConfig.headless, logger);
    await ensureLoggedIn(Runtime, logger, { appliedCookies });
    if (launchConfig.url !== CHATGPT_URL) {
      await navigateToChatGPT(Page, Runtime, launchConfig.url, logger);
      await ensureNotBlocked(Runtime, launchConfig.headless, logger);
    }
    const conversationUrl = buildConversationUrl(runtime, launchConfig.url);
    const hasReusableConversation = Boolean(conversationUrl || runtimeHasReusableIdentity(runtime));
    if (hasReusableConversation) {
      logger(
        conversationUrl
          ? `Reopening conversation at ${conversationUrl}`
          : "Reopening stored Oracle conversation.",
      );
      await ensureConversationOpenForRuntime(
        Runtime,
        runtime,
        deps.promptPreview,
        launchConfig.url,
      );
      await ensureNotBlocked(Runtime, launchConfig.headless, logger);
      await ensurePromptReady(Runtime, launchConfig.inputTimeoutMs, logger);
    } else {
      await ensurePromptReady(Runtime, launchConfig.inputTimeoutMs, logger);
    }
    const boundHref = await readCurrentHref(Runtime).catch(
      () => conversationUrl || runtime.tabUrl || "",
    );
    const boundRuntime = mergeRuntimeMetadata(runtime, {
      chromePid: chrome.pid,
      chromeHost,
      chromePort: chrome.port,
      chromeTargetId: isolatedTargetId ?? null,
      tabUrl: boundHref || conversationUrl || runtime.tabUrl,
      userDataDir,
      controllerPid: process.pid,
    });
    await reportBrowserProgress(logger, {
      stage: "thread-bound",
      message: `Bound to existing ChatGPT conversation ${boundRuntime.conversationId ?? "unknown"}.`,
      runtime: boundRuntime,
    });

    await applyConversationSettings(Runtime, logger, launchConfig, deps);
    let submittedPrompt: string;
    let submittedBaselineTurns: number | null = null;
    let submittedBaselineAssistant: {
      text: string;
      messageId?: string | null;
      turnId?: string | null;
    } | null = null;
    try {
      const submission = await submitFollowupPrompt(
        Runtime,
        DOM,
        Input,
        logger,
        options,
        resolved,
        deps,
      );
      submittedPrompt = submission.promptPreview;
      submittedBaselineTurns = submission.baselineTurns;
      submittedBaselineAssistant = submission.baselineAssistant;
    } catch (error) {
      const postSubmitDetails =
        error instanceof BrowserAutomationError
          ? (error.details as
              | {
                  promptSubmitted?: boolean;
                  submittedPrompt?: string;
                  baselineTurns?: number | null;
                  baselineAssistant?: {
                    text: string;
                    messageId?: string | null;
                    turnId?: string | null;
                  } | null;
                }
              | undefined)
          : undefined;
      const promptWasSubmitted = postSubmitDetails?.promptSubmitted === true;
      if (!promptWasSubmitted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger(
        `[browser] Follow-up submission completed but verification failed (${message}); continuing to observe the response without resending.`,
      );
      submittedPrompt = postSubmitDetails?.submittedPrompt ?? options.prompt;
      submittedBaselineTurns = postSubmitDetails?.baselineTurns ?? null;
      submittedBaselineAssistant = postSubmitDetails?.baselineAssistant ?? null;
    }
    const launchedRuntime = mergeRuntimeMetadata(runtime, {
      chromePid: chrome.pid,
      chromeHost,
      chromePort: chrome.port,
      chromeTargetId: isolatedTargetId ?? null,
      tabUrl: boundRuntime.tabUrl,
      userDataDir,
      controllerPid: process.pid,
    });
    let result: ReattachResult;
    let resumedAfterObservationFailure = false;
    try {
      result = await captureConversationResponse(
        launchedRuntime,
        Runtime,
        logger,
        {
          ...deps,
          baselineAssistant: submittedBaselineAssistant,
        },
        resolved.timeoutMs ?? 120_000,
        submittedPrompt,
        submittedBaselineTurns,
        options.downloadsDir,
        client,
      );
    } catch (error) {
      const assistantRecheckConfigured =
        Math.max(0, resolved.assistantRecheckDelayMs ?? 0) > 0 &&
        Math.max(0, resolved.assistantRecheckTimeoutMs ?? 0) > 0;
      if (isAssistantEmptyResponseError(error) && !assistantRecheckConfigured) {
        if (!launchConfig.keepBrowser && !reusedChrome) {
          await cleanupReopenedChromeLaunch(chrome, userDataDir, manualLogin, logger);
        }
        throw error;
      }
      if (isAssistantRateLimitError(error)) {
        if (!launchConfig.keepBrowser && !reusedChrome) {
          await cleanupReopenedChromeLaunch(chrome, userDataDir, manualLogin, logger);
        }
        throw new BrowserAutomationError(
          "ChatGPT temporarily limited this browser profile after too many requests. Wait a few minutes before retrying.",
          {
            stage: "assistant-rate-limit",
            runtime: launchedRuntime,
          },
          error,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      resumedAfterObservationFailure = true;
      await closeClient(client);
      logger(
        isAssistantEmptyResponseError(error)
          ? "[browser] Follow-up is still on a thinking shell; reattaching without resending."
          : `[browser] Follow-up observation failed after send (${message}); reattaching without resending.`,
      );
      const resumeConfig =
        isAssistantEmptyResponseError(error) && assistantRecheckConfigured
          ? withAssistantRecheckBudget(resolved)
          : resolved;
      try {
        result = await resumeBrowserSession(launchedRuntime, resumeConfig, logger, {
          ...deps,
          promptPreview: submittedPrompt,
          baselineTurns: submittedBaselineTurns,
          baselineAssistant: submittedBaselineAssistant,
        });
      } finally {
        if (!launchConfig.keepBrowser && !reusedChrome) {
          await cleanupReopenedChromeLaunch(chrome, userDataDir, manualLogin, logger);
        }
      }
    }
    if (resumedAfterObservationFailure) {
      return {
        ...result,
        runtime: result.runtime ?? launchedRuntime,
      };
    }
    const href = await readCurrentHref(Runtime);
    await closeClient(client);
    if (isolatedTargetId && chrome.port) {
      await closeTab(chrome.port, isolatedTargetId, logger, chromeHost).catch(() => undefined);
    }

    if (!launchConfig.keepBrowser && !reusedChrome) {
      await cleanupReopenedChromeLaunch(chrome, userDataDir, manualLogin, logger);
    }

    return {
      ...result,
      runtime:
        result.runtime ??
        mergeRuntimeMetadata(launchedRuntime, {
          chromeTargetId: isolatedTargetId ?? null,
          tabUrl: href || boundRuntime.tabUrl,
        }),
    };
  } finally {
    if (shouldHideChromeWindow) {
      await finalizeChromeFocusProtection(chrome, logger, stopChromeFocusGuard);
      stopChromeFocusGuard = null;
    }
  }
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  conversationHrefMatchesConfiguredScope,
  mergeRuntimeMetadata,
  openConversationFromSidebar,
  isTransientReattachAnswer,
};
