import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import chalk from "chalk";
import { sessionStore } from "../sessionStore.js";
import type { SessionMetadata } from "../sessionStore.js";
import {
  collectChatGptTabs,
  DEFAULT_REMOTE_CHROME_HOST,
  DEFAULT_REMOTE_CHROME_PORT,
  extractConversationIdFromUrl,
  formatBrowserTabState,
  harvestChatGptTab,
  harvestConnectedChatGptTab,
  sessionMatchesTab,
  type ChatGptTabSummary,
} from "../browser/liveTabs.js";
import {
  isRecoveredConversationHarvestReady,
  recoverConversationTab,
} from "../browser/recoverConversation.js";
import { resolveOutputPath } from "./writeOutputPath.js";
import { browserIdFromWebSocketEndpoint } from "../browser/profileState.js";
import {
  acquireOpenBrowserUseRunLock,
  connectOpenBrowserUseTab,
  hasStoredOpenBrowserUseAffinity,
  prepareOpenBrowserUseConversationRoute,
  registerOpenBrowserUseTerminationHooks,
  resolveStoredOpenBrowserUseAffinity,
  resolveStoredOpenBrowserUseTabAffinity,
  waitForOpenBrowserUseConversationUrl,
  type StoredOpenBrowserUseTabAffinity,
} from "../browser/openBrowserUse.js";
import { ensureChatGptScopeRetained, isChatGptScopeRetained } from "../browser/pageActions.js";
import { delay } from "../browser/utils.js";
import {
  hashConversationTurnText,
  type ConversationTurnBinding,
} from "../browser/conversationTurns.js";
import {
  asOracleUserError,
  BrowserAutomationError,
  sanitizeErrorForPersistence,
} from "../oracle/errors.js";

const LIVE_POLL_MS = 2000;
const DEFAULT_STALL_THRESHOLD_MS = 60_000;

function isRecoverableMissingTabError(message: string): boolean {
  return (
    message.includes("No ChatGPT tab matched") ||
    message.includes("No live ChatGPT tabs found") ||
    message.includes("ECONNREFUSED") ||
    message.includes("Could not connect")
  );
}

function finishRecoveredChrome(
  recoveredChrome: { kill: () => void; process?: { unref?: () => void } } | null,
  closeAfterRecover: boolean | undefined,
): void {
  if (!recoveredChrome) {
    return;
  }
  try {
    if (closeAfterRecover) {
      recoveredChrome.kill();
    } else {
      recoveredChrome.process?.unref?.();
    }
  } catch {
    // best-effort cleanup
  }
}

export interface BrowserHarvestOptions {
  writeOutputPath?: string;
  browserTabRef?: string;
  stallWindowMs?: number;
  quietOutput?: boolean;
  /**
   * When the live tab cannot be found, relaunch Chrome with the session's
   * persistent profile and navigate to the saved tab URL, then retry harvest.
   * Default: true.
   */
  recoverIfMissing?: boolean;
  /**
   * After a successful recovery harvest, close the relaunched Chrome.
   * Default: false (leave the recovered tab visible for the user).
   */
  closeAfterRecover?: boolean;
}

export interface BrowserLiveTailOptions {
  writeOutputPath?: string;
  browserTabRef?: string;
  stallThresholdMs?: number;
  /**
   * When no live tab matches the session's stored target, relaunch Chrome with
   * the persistent profile and navigate to the saved tab URL before tailing.
   * Default: true.
   */
  recoverIfMissing?: boolean;
  /**
   * After completion, close the relaunched Chrome.
   * Default: false (leave the recovered tab visible).
   */
  closeAfterRecover?: boolean;
}

function hasRemoteAffinityMarker(meta: SessionMetadata | null | undefined): boolean {
  const config = meta?.browser?.config;
  const runtime = meta?.browser?.runtime;
  return (
    process.env.ORACLE_WRAPPER_REMOTE_ONLY === "1" ||
    Boolean(
      config?.remoteChrome ||
      config?.remoteChromeBrowserId?.trim() ||
      config?.remoteChromeBrowserWSEndpoint?.trim() ||
      config?.remoteChromeAccountDigest?.trim() ||
      runtime?.chatGptAccountDigest?.trim(),
    )
  );
}

function sessionBrowserEndpoint(
  meta: SessionMetadata | null | undefined,
): { host: string; port: number; browserId?: string; accountDigest?: string } | null {
  const runtime = meta?.browser?.runtime ?? {};
  const config = meta?.browser?.config;
  const remote = config?.remoteChrome;
  const host = runtime.chromeHost ?? remote?.host;
  const port = runtime.chromePort ?? remote?.port;
  const requiresAffinity = hasRemoteAffinityMarker(meta);
  if (!host || !port) {
    if (requiresAffinity) {
      throw new Error("Stored remote Chrome browser and account identity is incomplete.");
    }
    return null;
  }
  if (!requiresAffinity) return { host, port };
  const configuredBrowserWSEndpoint = config?.remoteChromeBrowserWSEndpoint?.trim();
  const runtimeBrowserWSEndpoint = runtime.chromeBrowserWSEndpoint?.trim();
  const configuredAccountDigest = config?.remoteChromeAccountDigest?.trim();
  const runtimeAccountDigest = runtime.chatGptAccountDigest?.trim();
  if (
    configuredAccountDigest &&
    runtimeAccountDigest &&
    configuredAccountDigest !== runtimeAccountDigest
  ) {
    throw new Error("Stored remote Chrome account identity is conflicting.");
  }
  const browserWSEndpoint = runtimeBrowserWSEndpoint ?? configuredBrowserWSEndpoint;
  const accountDigest = runtimeAccountDigest ?? configuredAccountDigest;
  if (!browserWSEndpoint || !accountDigest) {
    throw new Error("Stored remote Chrome browser and account identity is incomplete.");
  }
  if (!/^[a-f0-9]{64}$/.test(accountDigest)) {
    throw new Error("Stored remote Chrome account identity is invalid.");
  }
  const browserId = browserIdFromWebSocketEndpoint(browserWSEndpoint);
  const configuredBrowserId = config?.remoteChromeBrowserId?.trim();
  if (configuredBrowserId && configuredBrowserId !== browserId) {
    throw new Error("Stored remote Chrome browser identity is conflicting.");
  }
  if (
    configuredBrowserWSEndpoint &&
    browserIdFromWebSocketEndpoint(configuredBrowserWSEndpoint) !== browserId
  ) {
    throw new Error("Stored remote Chrome browser identity is conflicting.");
  }
  return { host, port, browserId, accountDigest };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function collectUniqueEndpoints(
  metas: SessionMetadata[],
): Array<{ host: string; port: number; browserId?: string; accountDigest?: string }> {
  const entries = new Map<
    string,
    { host: string; port: number; browserId?: string; accountDigest?: string }
  >();
  let suppressRawDefault = process.env.ORACLE_WRAPPER_REMOTE_ONLY === "1";
  for (const meta of metas) {
    const runtime = meta?.browser?.runtime ?? {};
    const remote = meta?.browser?.config?.remoteChrome;
    const recordedHost = runtime.chromeHost ?? remote?.host;
    const recordedPort = runtime.chromePort ?? remote?.port;
    if (
      hasRemoteAffinityMarker(meta) ||
      (recordedHost && isLoopbackHost(recordedHost) && recordedPort === DEFAULT_REMOTE_CHROME_PORT)
    ) {
      suppressRawDefault = true;
    }
    try {
      const endpoint = sessionBrowserEndpoint(meta);
      if (!endpoint) continue;
      const key = `${endpoint.host.toLowerCase()}:${endpoint.port}\t${endpoint.browserId ?? ""}\t${endpoint.accountDigest ?? ""}`;
      if (!entries.has(key)) entries.set(key, endpoint);
    } catch {
      // Named operations fail closed; global discovery skips incomplete legacy sessions.
    }
  }
  if (!suppressRawDefault) {
    entries.set(`${DEFAULT_REMOTE_CHROME_HOST}:${DEFAULT_REMOTE_CHROME_PORT}\t\t`, {
      host: DEFAULT_REMOTE_CHROME_HOST,
      port: DEFAULT_REMOTE_CHROME_PORT,
    });
  }
  return Array.from(entries.values());
}
export function collectUniqueEndpointsForTest(
  metas: SessionMetadata[],
): Array<{ host: string; port: number; browserId?: string; accountDigest?: string }> {
  return collectUniqueEndpoints(metas);
}

function buildSessionIndex(metas: SessionMetadata[]): SessionMetadata[] {
  return metas
    .filter((meta) => meta?.mode === "browser")
    .sort((left, right) =>
      String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")),
    );
}

function resolveLinkedSession(
  tab: ChatGptTabSummary,
  metas: SessionMetadata[],
): SessionMetadata | null {
  return buildSessionIndex(metas).find((meta) => sessionMatchesTab(meta, tab)) ?? null;
}

function snippet(text: string, max = 120): string {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function resolveSessionTabRef(meta: SessionMetadata): string {
  const runtime = meta?.browser?.runtime ?? {};
  const harvest = meta?.browser?.harvest ?? {};
  const configuredUrl = meta?.browser?.config?.url;
  const configuredConversationUrl = configuredUrl?.includes("/c/") ? configuredUrl : undefined;
  return (
    harvest.url ??
    runtime.tabUrl ??
    harvest.conversationId ??
    runtime.conversationId ??
    configuredConversationUrl ??
    harvest.targetId ??
    runtime.chromeTargetId ??
    "current"
  );
}

export function resolveSessionTabRefForTest(meta: SessionMetadata): string {
  return resolveSessionTabRef(meta);
}

function normalizeHarvestComparison(text: string): string {
  return String(text ?? "")
    .replace(/\s*attachments-bundle(?:\(\d+\))?(?:\.txtDocument)?\s*/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function storedConversationTurnBinding(meta: SessionMetadata): ConversationTurnBinding | undefined {
  const runtime = meta.browser?.runtime;
  if (!runtime) return undefined;
  const binding = {
    promptDigest: runtime.promptDigest,
    promptTurnIndex: runtime.promptTurnIndex,
    promptTurnId: runtime.promptTurnId,
    promptMessageId: runtime.promptMessageId,
    assistantTurnIndex: runtime.assistantTurnIndex,
    assistantTurnId: runtime.assistantTurnId,
    assistantMessageId: runtime.assistantMessageId,
  };
  return Object.values(binding).some((value) => value !== undefined) ? binding : undefined;
}

function harvestMatchesSessionPrompt(meta: SessionMetadata, harvested: ChatGptTabSummary): boolean {
  const rawHarvestedPrompt = harvested.lastUserText || harvested.lastUserSnippet;
  const binding = storedConversationTurnBinding(meta);
  if (binding?.promptDigest) {
    return Boolean(
      rawHarvestedPrompt && hashConversationTurnText(rawHarvestedPrompt) === binding.promptDigest,
    );
  }
  const harvestedPrompt = normalizeHarvestComparison(rawHarvestedPrompt);
  const promptPreview = normalizeHarvestComparison(meta.promptPreview ?? "");
  if (!promptPreview) return true;
  return Boolean(harvestedPrompt && harvestedPrompt.startsWith(promptPreview));
}

function assertHarvestMatchesSessionPrompt(
  meta: SessionMetadata,
  harvested: ChatGptTabSummary,
): void {
  if (harvestMatchesSessionPrompt(meta, harvested)) return;
  throw new BrowserAutomationError(
    "The stored ChatGPT thread now ends with a different Oracle prompt; refusing to return another session's answer.",
    {
      stage: "chatgpt-turn-affinity",
      code: "turn-affinity-mismatch",
      conversationUrl: harvested.url,
    },
  );
}

function stableProjectKey(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const segment = new URL(value).pathname.match(/^\/g\/([^/]+)/u)?.[1];
    if (!segment) return null;
    return (segment.match(/^(g-p-[0-9a-f]{32})(?=-|$)/iu)?.[1] ?? segment).toLowerCase();
  } catch {
    return null;
  }
}

export function recoverBrowserMetadataFromHarvestForTest(
  meta: SessionMetadata,
  harvested: ChatGptTabSummary,
  persistedOutput?: string,
): NonNullable<SessionMetadata["browser"]> {
  const browser = meta.browser ?? {};
  const conversationId = harvested.conversationId ?? extractConversationIdFromUrl(harvested.url);
  const hasTurnBinding = Boolean(storedConversationTurnBinding(meta));
  const promptMatched = Boolean(
    (hasTurnBinding || normalizeHarvestComparison(meta.promptPreview ?? "")) &&
    harvestMatchesSessionPrompt(meta, harvested),
  );
  const outputMatched = Boolean(
    persistedOutput &&
    normalizeHarvestComparison(persistedOutput) ===
      normalizeHarvestComparison(
        harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "",
      ),
  );
  const configuredProject = stableProjectKey(browser.config?.url);
  const harvestedProject = stableProjectKey(harvested.url);
  const existingConversationIds = [
    browser.runtime?.conversationId,
    extractConversationIdFromUrl(browser.runtime?.tabUrl ?? ""),
    extractConversationIdFromUrl(browser.archive?.conversationUrl ?? ""),
  ].filter((value): value is string => Boolean(value));
  const runtimeRepaired = Boolean(
    conversationId &&
    harvested.targetId &&
    harvested.state === "completed" &&
    harvested.stopExists === false &&
    harvested.assistantCount > 0 &&
    harvested.currentModelLabel.trim() &&
    promptMatched &&
    outputMatched &&
    (!configuredProject || configuredProject === harvestedProject) &&
    existingConversationIds.every((value) => value === conversationId),
  );
  const harvest = {
    targetId: harvested.targetId,
    url: harvested.url,
    conversationId,
    harvestedAt: new Date().toISOString(),
    assistantHash: createHash("sha1")
      .update(harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "")
      .digest("hex"),
    state: harvested.state,
    stopExists: harvested.stopExists,
    sendExists: harvested.sendExists,
    assistantCount: harvested.assistantCount,
    currentModelLabel: harvested.currentModelLabel,
    lastAssistantSnippet: harvested.lastAssistantSnippet,
    lastUserSnippet: harvested.lastUserSnippet,
    outputMatched,
    promptMatched,
    runtimeRepaired,
  };
  const hasAssistantAffinity = Boolean(
    typeof harvested.lastAssistantTurnIndex === "number" ||
    harvested.lastAssistantTurnId ||
    harvested.lastAssistantMessageId,
  );
  const runtimeWithAssistant =
    promptMatched && hasAssistantAffinity
      ? {
          ...(browser.runtime ?? {}),
          ...(typeof harvested.lastAssistantTurnIndex === "number"
            ? { assistantTurnIndex: harvested.lastAssistantTurnIndex }
            : {}),
          ...(harvested.lastAssistantTurnId
            ? { assistantTurnId: harvested.lastAssistantTurnId }
            : {}),
          ...(harvested.lastAssistantMessageId
            ? { assistantMessageId: harvested.lastAssistantMessageId }
            : {}),
        }
      : browser.runtime;
  if (!runtimeRepaired || !conversationId) {
    return {
      ...browser,
      ...(runtimeWithAssistant ? { runtime: runtimeWithAssistant } : {}),
      harvest,
    };
  }
  return {
    ...browser,
    runtime: {
      ...(runtimeWithAssistant ?? {}),
      ...(browser.runtime?.browserTransport === "obu"
        ? { obuTabId: Number(harvested.targetId) }
        : { chromeTargetId: harvested.targetId }),
      tabUrl: harvested.url,
      conversationId,
    },
    archive: {
      ...(browser.archive ?? {
        mode: browser.config?.archiveConversations ?? "never",
        attempted: false,
        archived: false,
      }),
      conversationUrl: harvested.url,
    },
    harvest,
  };
}

async function persistHarvest(
  sessionId: string,
  meta: SessionMetadata,
  harvested: ChatGptTabSummary,
): Promise<void> {
  let persistedOutput: string | undefined;
  try {
    const outputPath = resolveOutputPath(meta.options.writeOutputPath, meta.cwd ?? process.cwd());
    if (outputPath && outputPath !== "-" && outputPath !== "/dev/stdout") {
      persistedOutput = await fs.readFile(outputPath, "utf8");
    }
  } catch {
    // Harvesting remains useful even when the original output artifact is unavailable.
  }
  const browser = recoverBrowserMetadataFromHarvestForTest(meta, harvested, persistedOutput);
  await sessionStore.updateSession(sessionId, { browser });
  meta.browser = browser;
}

function printHarvestSummary(sessionId: string, harvested: ChatGptTabSummary): void {
  console.log(chalk.bold(`Session: ${sessionId}`));
  console.log(`Target: ${harvested.targetId}`);
  console.log(`State: ${formatBrowserTabState(harvested)}`);
  console.log(`Model: ${harvested.currentModelLabel || "(unknown)"}`);
  console.log(`URL: ${harvested.url}`);
  console.log(`Assistant turns: ${harvested.assistantCount}`);
  console.log(
    `Signals: stop=${harvested.stopExists ? "yes" : "no"} send=${harvested.sendExists ? "yes" : "no"}`,
  );
  if (harvested.lastUserSnippet) {
    console.log(`Last user: ${harvested.lastUserSnippet}`);
  }
  console.log(chalk.dim("---"));
}

async function maybeWriteHarvestOutput(
  pathInput: string | undefined,
  cwd: string,
  content: string,
): Promise<void> {
  const resolved = resolveOutputPath(pathInput, cwd);
  if (!resolved) {
    return;
  }
  const payload = content ?? "";
  if (resolved === "-" || resolved === "/dev/stdout") {
    process.stdout.write(`${payload}${payload.endsWith("\n") ? "" : "\n"}`);
    return;
  }
  await fs.writeFile(resolved, payload, "utf8");
  console.log(chalk.dim(`Wrote harvested assistant output to ${resolved}`));
}

async function withPersistedOpenBrowserUseOperationError<T>(
  meta: SessionMetadata,
  operationName: "harvest" | "live-tail",
  operation: () => Promise<T>,
): Promise<T> {
  try {
    const result = await operation();
    const currentMeta = (await sessionStore.readSession(meta.id)) ?? meta;
    if (currentMeta.browser?.operationErrors?.[operationName]) {
      const operationErrors = { ...currentMeta.browser.operationErrors };
      delete operationErrors[operationName];
      const browser = {
        ...currentMeta.browser,
        operationErrors: Object.keys(operationErrors).length > 0 ? operationErrors : undefined,
      };
      await sessionStore.updateSession(meta.id, { browser });
      meta.browser = browser;
    }
    return result;
  } catch (error) {
    const userError = asOracleUserError(error);
    const message = error instanceof Error ? error.message : String(error);
    const operationError = {
      category: userError?.category ?? "browser-automation",
      ...sanitizeErrorForPersistence(
        userError?.message ?? message,
        userError?.details,
        operationName,
      ),
    };
    const currentMeta = (await sessionStore.readSession(meta.id)) ?? meta;
    const browser = {
      ...(currentMeta.browser ?? {}),
      operationErrors: {
        ...(currentMeta.browser?.operationErrors ?? {}),
        [operationName]: operationError,
      },
    };
    await sessionStore.updateSession(meta.id, { browser }).catch(() => undefined);
    meta.browser = browser;
    throw error;
  }
}
async function appendBrowserWarning(
  meta: SessionMetadata,
  code: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof BrowserAutomationError ? error.details : undefined;
  const warning = {
    code,
    severity: "warning" as const,
    ...sanitizeErrorForPersistence(message, details),
  };
  const browser = {
    ...(meta.browser ?? {}),
    warnings: [...(meta.browser?.warnings ?? []), warning],
  };
  await sessionStore.updateSession(meta.id, { browser }).catch(() => undefined);
  meta.browser = browser;
}

function storedOpenBrowserUseAffinity(
  meta: SessionMetadata,
): StoredOpenBrowserUseTabAffinity & { conversationUrl: string | null } {
  const runtime = meta.browser?.runtime;
  const configs = [meta.options.browserConfig, meta.browser?.config];
  const conversationUrls = [
    meta.browser?.harvest?.url,
    runtime?.tabUrl,
    meta.browser?.archive?.conversationUrl,
    meta.options.browserResumeConversationUrl,
    ...configs.flatMap((config) => [
      config?.resumeConversationUrl,
      config?.chatgptUrl,
      config?.url,
    ]),
  ];
  const selectedUrl = conversationUrls.find((value) => extractConversationIdFromUrl(value ?? ""));
  const selectedId = runtime?.conversationId ?? meta.browser?.harvest?.conversationId;
  const conversationUrl =
    selectedUrl ?? (selectedId ? `https://chatgpt.com/c/${selectedId}` : null);
  if (!conversationUrl) {
    return {
      ...resolveStoredOpenBrowserUseTabAffinity({ runtime, configs }),
      conversationUrl: null,
    };
  }
  return resolveStoredOpenBrowserUseAffinity({
    runtime,
    configs,
    conversationUrl,
    conversationUrls,
    conversationIds: [meta.browser?.harvest?.conversationId],
  });
}

interface OpenBrowserUseHarvestContext {
  meta: SessionMetadata;
  affinity: StoredOpenBrowserUseTabAffinity & { conversationUrl: string };
  connection: Awaited<ReturnType<typeof connectOpenBrowserUseTab>>;
  recoveryTimeoutMs: number;
  close(keepTab: boolean): Promise<void>;
}

async function persistRecoveredOpenBrowserUseAffinity(
  meta: SessionMetadata,
  affinity: StoredOpenBrowserUseTabAffinity & { conversationUrl: string },
  connection: Awaited<ReturnType<typeof connectOpenBrowserUseTab>>,
): Promise<void> {
  const route = {
    browserTransport: "obu" as const,
    obuSessionId: connection.sessionId,
    obuTabId: connection.tabId,
    chatGptAccountEmail: affinity.email,
    chatGptWorkspaceName: affinity.workspaceName,
    chatGptAccountDigest: affinity.accountDigest,
    chatGptWorkspaceDigest: affinity.workspaceDigest,
  };
  const baseConfig = meta.browser?.config ?? meta.options.browserConfig ?? {};
  const recoveredConfig = { ...baseConfig, ...route };
  const browser = {
    ...(meta.browser ?? {}),
    config: recoveredConfig,
    runtime: {
      ...(meta.browser?.runtime ?? {}),
      ...route,
      tabUrl: affinity.conversationUrl,
      conversationId: extractConversationIdFromUrl(affinity.conversationUrl),
    },
  };
  const options = {
    ...meta.options,
    browserConfig: recoveredConfig,
  };
  await sessionStore.updateSession(meta.id, { browser, options });
  meta.browser = browser;
  meta.options = options;
}

async function openOpenBrowserUseHarvestContext(
  meta: SessionMetadata,
): Promise<OpenBrowserUseHarvestContext> {
  const logger = (message: string) => console.log(message);
  const lock = await acquireOpenBrowserUseRunLock({
    timeoutMs: meta.browser?.config?.profileLockTimeoutMs ?? 300_000,
    logger,
  });
  let connection: Awaited<ReturnType<typeof connectOpenBrowserUseTab>> | null = null;
  let connectionReady: ReturnType<typeof connectOpenBrowserUseTab> | null = null;
  let lockUncertain = false;
  const markLockUncertain = async (reason: string, error?: unknown): Promise<void> => {
    lockUncertain = true;
    const details = error instanceof BrowserAutomationError ? error.details : undefined;
    const candidate = details?.recoveryHandle;
    const recoveryHandle =
      candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>)
        : connection
          ? {
              transport: "obu",
              sessionId: connection.sessionId,
              tabId: connection.tabId,
              conversationUrl: connection.tabUrl ?? null,
            }
          : undefined;
    try {
      await lock.markUncertain?.({
        reason,
        ...(recoveryHandle ? { recoveryHandle } : {}),
      });
    } catch (markError) {
      logger(
        `[browser] Failed to persist uncertain harvest lock state: ${markError instanceof Error ? markError.message : String(markError)}`,
      );
    }
  };
  const removeTerminationHooks = registerOpenBrowserUseTerminationHooks({
    connection: () => connection ?? connectionReady,
    preserveTab: () => {
      connection?.requestKeepTab?.();
    },
    releaseLock: () => lock.release(),
    markLockUncertain: (details) => lock.markUncertain?.(details),
    logger,
  });
  try {
    const freshMeta = await sessionStore.readSession(meta.id);
    if (!freshMeta) {
      throw new Error(`No session found with ID ${meta.id}.`);
    }
    const affinity = storedOpenBrowserUseAffinity(freshMeta);
    connectionReady = connectOpenBrowserUseTab({
      oracleSessionId: freshMeta.id,
      obuSessionId: affinity.sessionId,
      obuTabId: affinity.tabId,
      exactTabOnly: !affinity.conversationUrl,
      conversationUrl: affinity.conversationUrl,
      timeoutMs: freshMeta.browser?.config?.inputTimeoutMs,
      logger,
    });
    connection = await connectionReady;
    const identity = {
      email: affinity.email,
      workspaceName: affinity.workspaceName,
      accountDigest: affinity.accountDigest,
      workspaceDigest: affinity.workspaceDigest,
    };
    if (!affinity.conversationUrl) {
      affinity.conversationUrl = await waitForOpenBrowserUseConversationUrl({
        connection,
        timeoutMs:
          freshMeta.browser?.config?.inputTimeoutMs ??
          freshMeta.options.browserConfig?.inputTimeoutMs ??
          30_000,
      });
    }
    await prepareOpenBrowserUseConversationRoute({
      connection,
      expectation: identity,
      targetUrl: affinity.conversationUrl,
      logger,
    });
    await persistRecoveredOpenBrowserUseAffinity(
      freshMeta,
      affinity as StoredOpenBrowserUseTabAffinity & { conversationUrl: string },
      connection,
    );
    return {
      meta: freshMeta,
      affinity: affinity as StoredOpenBrowserUseTabAffinity & { conversationUrl: string },
      connection,
      recoveryTimeoutMs:
        freshMeta.browser?.config?.inputTimeoutMs ??
        freshMeta.options.browserConfig?.inputTimeoutMs ??
        30_000,
      close: async (keepTab: boolean) => {
        if (keepTab) connection?.requestKeepTab?.();
        await removeTerminationHooks.waitForDrain();
        let finalizeFailure: unknown;
        try {
          await connection?.finalize(keepTab || removeTerminationHooks.isTerminating());
        } catch (error) {
          finalizeFailure = error;
          await markLockUncertain("Main-Chrome harvest tab finalization was inconclusive.", error);
        } finally {
          await removeTerminationHooks.waitForDrain();
          removeTerminationHooks();
          if (!removeTerminationHooks.isLockUncertain() && !lockUncertain) {
            await lock.release().catch(() => undefined);
          }
        }
        if (finalizeFailure) throw finalizeFailure;
      },
    };
  } catch (error) {
    await removeTerminationHooks.waitForDrain();
    try {
      await connection?.finalize(removeTerminationHooks.isTerminating());
    } catch (cleanupError) {
      await markLockUncertain("Main-Chrome harvest cleanup was inconclusive.", cleanupError);
      if (error instanceof BrowserAutomationError && error.details) {
        (error.details as Record<string, unknown>).cleanupFailure =
          cleanupError instanceof BrowserAutomationError
            ? { message: cleanupError.message, details: cleanupError.details }
            : {
                message:
                  cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
              };
      }
    } finally {
      await removeTerminationHooks.waitForDrain();
      removeTerminationHooks();
      if (!removeTerminationHooks.isLockUncertain() && !lockUncertain) {
        await lock.release().catch(() => undefined);
      }
    }
    throw error;
  }
}

async function harvestOpenBrowserUseContext(
  context: OpenBrowserUseHarvestContext,
  stallWindowMs?: number,
): Promise<ChatGptTabSummary> {
  const identity = {
    email: context.affinity.email,
    workspaceName: context.affinity.workspaceName,
    accountDigest: context.affinity.accountDigest,
    workspaceDigest: context.affinity.workspaceDigest,
  };
  const expectedConversationId = extractConversationIdFromUrl(context.affinity.conversationUrl);
  const recoveryDeadline = Date.now() + context.recoveryTimeoutMs;
  const hydrationUnavailable = () =>
    new BrowserAutomationError("Main-Chrome conversation did not hydrate before harvest.", {
      stage: "assistant-timeout",
      code: "recovered-content-unavailable",
      recoveryHandle: {
        transport: "obu",
        sessionId: context.connection.sessionId,
        tabId: context.connection.tabId,
        conversationUrl: context.affinity.conversationUrl,
      },
    });
  let lastAffinityError: BrowserAutomationError | null = null;
  const deadlineError = () => lastAffinityError ?? hydrationUnavailable();
  const runBeforeDeadline = async <T>(
    operation: (remainingMs: number) => Promise<T>,
  ): Promise<T> => {
    const remainingMs = recoveryDeadline - Date.now();
    if (remainingMs <= 0) throw deadlineError();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(deadlineError()), remainingMs);
      });
      const result = await Promise.race([timeout, operation(remainingMs)]);
      if (Date.now() >= recoveryDeadline) throw deadlineError();
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const waitForRetry = async () => {
    const remainingMs = recoveryDeadline - Date.now();
    if (remainingMs <= 0) throw deadlineError();
    await delay(Math.min(LIVE_POLL_MS, remainingMs));
  };
  for (;;) {
    await runBeforeDeadline(() =>
      ensureChatGptScopeRetained(
        context.connection.client.Runtime,
        context.affinity.conversationUrl,
      ),
    );
    let harvested: ChatGptTabSummary;
    try {
      harvested = await runBeforeDeadline((remainingMs) =>
        harvestConnectedChatGptTab({
          client: context.connection.client,
          targetId: String(context.connection.tabId),
          title: "Oracle main-Chrome tab",
          url: context.affinity.conversationUrl,
          identity,
          stallWindowMs:
            stallWindowMs === undefined ? undefined : Math.min(stallWindowMs, remainingMs),
          turnBinding: storedConversationTurnBinding(context.meta),
        }),
      );
    } catch (error) {
      const affinityStillHydrating =
        error instanceof BrowserAutomationError &&
        error.details?.stage === "chatgpt-turn-affinity" &&
        error.details?.code === "turn-affinity-missing";
      if (!affinityStillHydrating) throw error;
      lastAffinityError = error;
      await waitForRetry();
      continue;
    }
    lastAffinityError = null;
    if (
      !expectedConversationId ||
      harvested.conversationId !== expectedConversationId ||
      !isChatGptScopeRetained(harvested.url, context.affinity.conversationUrl)
    ) {
      throw new BrowserAutomationError(
        "Main-Chrome tab left the stored ChatGPT conversation during harvest.",
        {
          stage: "chatgpt-scope",
          code: "scope-mismatch",
          expectedUrl: context.affinity.conversationUrl,
          actualUrl: harvested.url,
        },
      );
    }
    if (isRecoveredConversationHarvestReady(harvested)) return harvested;
    await waitForRetry();
  }
}

async function harvestOpenBrowserUseSession(
  meta: SessionMetadata,
  options: { stallWindowMs?: number; keepIncomplete: boolean },
): Promise<{ harvested: ChatGptTabSummary; meta: SessionMetadata }> {
  const context = await openOpenBrowserUseHarvestContext(meta);
  let keepTab = true;
  let harvested: ChatGptTabSummary | null = null;
  let operationError: unknown;
  try {
    harvested = await harvestOpenBrowserUseContext(context, options.stallWindowMs);
    assertHarvestMatchesSessionPrompt(context.meta, harvested);
    keepTab = options.keepIncomplete && harvested.state !== "completed";
  } catch (error) {
    operationError = error;
  }
  try {
    await context.close(keepTab);
  } catch (error) {
    await appendBrowserWarning(context.meta, "obu-tab-finalize-failed", error);
  }
  if (operationError) throw operationError;
  if (!harvested) throw new Error("Main-Chrome harvest returned no result.");
  return { harvested, meta: context.meta };
}

function isOpenBrowserUseSession(meta: SessionMetadata): boolean {
  return hasStoredOpenBrowserUseAffinity({
    runtime: meta.browser?.runtime,
    configs: [meta.options.browserConfig, meta.browser?.config],
  });
}

export async function showBrowserTabsStatus(): Promise<void> {
  const metas = await sessionStore.listSessions();
  const openBrowserUseSessions = metas.filter(isOpenBrowserUseSession);
  const endpoints = collectUniqueEndpoints(metas);
  let printedAny = false;
  for (const endpoint of endpoints) {
    let tabs: ChatGptTabSummary[];
    try {
      tabs = await collectChatGptTabs(endpoint);
    } catch {
      continue;
    }
    if (tabs.length === 0) {
      continue;
    }
    printedAny = true;
    console.log(chalk.bold(`Browser Tabs ${endpoint.host}:${endpoint.port}`));
    for (const tab of tabs) {
      const linkedSession = resolveLinkedSession(
        { ...tab, host: endpoint.host, port: endpoint.port },
        metas,
      );
      console.log(
        `- ${tab.targetId} ${formatBrowserTabState(tab)} model=${tab.currentModelLabel || "(unknown)"} turns=${tab.assistantCount} stop=${tab.stopExists ? "yes" : "no"} send=${tab.sendExists ? "yes" : "no"}`,
      );
      console.log(`  title=${tab.title || "(untitled)"}`);
      console.log(`  url=${tab.url}`);
      if (linkedSession) {
        console.log(`  session=${linkedSession.id}`);
      }
      if (tab.lastAssistantSnippet) {
        console.log(`  last=${snippet(tab.lastAssistantSnippet)}`);
      }
    }
  }
  if (openBrowserUseSessions.length > 0) {
    printedAny = true;
    console.log(
      `Main-Chrome tab inventory is session-affinity scoped; inspect a stored session with “oracle session <id> --browser-harvest” (${openBrowserUseSessions.length} known).`,
    );
  }
  if (!printedAny) {
    console.log("No live ChatGPT tabs found on known Chrome DevTools endpoints.");
  }
}

export async function harvestSessionBrowserOutput(
  sessionId: string,
  options: BrowserHarvestOptions = {},
): Promise<ChatGptTabSummary> {
  const meta = await sessionStore.readSession(sessionId);
  if (!meta) {
    throw new Error(`No session found with ID ${sessionId}.`);
  }
  if (isOpenBrowserUseSession(meta)) {
    return withPersistedOpenBrowserUseOperationError(meta, "harvest", async () => {
      if (options.browserTabRef) {
        throw new Error(
          "Main-Chrome sessions use their stored conversation affinity; remove --browser-tab.",
        );
      }
      const { harvested, meta: activeMeta } = await harvestOpenBrowserUseSession(meta, {
        stallWindowMs: options.stallWindowMs,
        keepIncomplete: true,
      });
      await persistHarvest(sessionId, activeMeta, harvested);
      printHarvestSummary(sessionId, harvested);
      const output = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
      if (options.writeOutputPath) {
        await maybeWriteHarvestOutput(
          options.writeOutputPath,
          activeMeta.cwd ?? process.cwd(),
          output,
        );
      }
      if (!options.quietOutput && output) {
        process.stdout.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
      }
      return harvested;
    });
  }
  const recordedEndpoint = sessionBrowserEndpoint(meta);
  const initialEndpoint = recordedEndpoint ?? {
    host: DEFAULT_REMOTE_CHROME_HOST,
    port: DEFAULT_REMOTE_CHROME_PORT,
  };
  const ref = options.browserTabRef ?? resolveSessionTabRef(meta);
  const recoverIfMissing = options.recoverIfMissing !== false && !options.browserTabRef;
  if (!recordedEndpoint && !recoverIfMissing && !options.browserTabRef) {
    throw new Error(
      `Session "${sessionId}" has no recorded Chrome endpoint. Re-run without --no-recover to reopen its saved conversation.`,
    );
  }

  let recoveredChrome: { kill: () => void; process?: { unref?: () => void } } | null = null;
  try {
    const recoverAndHarvest = async (): Promise<ChatGptTabSummary> => {
      console.log(
        chalk.yellow(
          `No live ChatGPT tab matched session "${sessionId}". Attempting recovery by reopening the saved conversation URL.`,
        ),
      );
      const recovered = await recoverConversationTab(meta, (line) => console.log(line), {
        existingEndpoint: recordedEndpoint ?? undefined,
      });
      recoveredChrome = recovered.chrome;
      return harvestChatGptTab({
        host: recovered.host,
        port: recovered.port,
        browserId: recovered.browserId,
        accountDigest: recovered.accountDigest,
        ref: recovered.ref,
        turnBinding: storedConversationTurnBinding(meta),
        stallWindowMs: options.stallWindowMs,
      });
    };

    let harvested: ChatGptTabSummary;
    if (!recordedEndpoint && recoverIfMissing) {
      harvested = await recoverAndHarvest();
    } else {
      try {
        harvested = await harvestChatGptTab({
          ...initialEndpoint,
          ref,
          turnBinding: storedConversationTurnBinding(meta),
          stallWindowMs: options.stallWindowMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isRecoverableMissingTabError(message) || !recoverIfMissing) throw error;
        harvested = await recoverAndHarvest();
      }
    }
    assertHarvestMatchesSessionPrompt(meta, harvested);
    await persistHarvest(sessionId, meta, harvested);
    printHarvestSummary(sessionId, harvested);
    const output = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
    if (options.writeOutputPath) {
      await maybeWriteHarvestOutput(options.writeOutputPath, meta.cwd ?? process.cwd(), output);
    }
    if (!options.quietOutput && output) {
      process.stdout.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
    }
    return harvested;
  } finally {
    finishRecoveredChrome(recoveredChrome, options.closeAfterRecover);
  }
}

export async function liveTailSessionBrowserOutput(
  sessionId: string,
  options: BrowserLiveTailOptions = {},
): Promise<ChatGptTabSummary> {
  const meta = await sessionStore.readSession(sessionId);
  if (!meta) throw new Error(`No session found with ID ${sessionId}.`);
  if (isOpenBrowserUseSession(meta)) {
    return withPersistedOpenBrowserUseOperationError(meta, "live-tail", async () => {
      if (options.browserTabRef) {
        throw new Error(
          "Main-Chrome sessions use their stored conversation affinity; remove --browser-tab.",
        );
      }
      const context = await openOpenBrowserUseHarvestContext(meta);
      const activeMeta = context.meta;
      const stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
      let lastHash: string | null = null;
      let unchangedSince = Date.now();
      let keepTab = true;
      let finalHarvest: ChatGptTabSummary | null = null;
      let operationError: unknown;
      try {
        while (true) {
          const harvested = await harvestOpenBrowserUseContext(context);
          assertHarvestMatchesSessionPrompt(activeMeta, harvested);
          const fullText = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
          const hash = createHash("sha1").update(fullText).digest("hex");
          if (hash !== lastHash) {
            lastHash = hash;
            unchangedSince = Date.now();
            console.log(
              `[${new Date().toISOString()}] state=${harvested.state} stop=${harvested.stopExists ? "yes" : "no"} ` +
                `send=${harvested.sendExists ? "yes" : "no"} model=${harvested.currentModelLabel || "(unknown)"} ` +
                `snippet=${snippet(harvested.lastAssistantSnippet || fullText, 160)}`,
            );
            await persistHarvest(sessionId, activeMeta, harvested);
          }
          const derivedState =
            harvested.state === "running"
              ? Date.now() - unchangedSince >= stallThresholdMs
                ? "stalled"
                : "running"
              : harvested.state;
          if (derivedState !== "running") {
            finalHarvest = { ...harvested, state: derivedState };
            keepTab = derivedState !== "completed";
            await persistHarvest(sessionId, activeMeta, finalHarvest);
            printHarvestSummary(sessionId, finalHarvest);
            const output =
              finalHarvest.lastAssistantMarkdown ?? finalHarvest.lastAssistantText ?? "";
            if (options.writeOutputPath) {
              await maybeWriteHarvestOutput(
                options.writeOutputPath,
                activeMeta.cwd ?? process.cwd(),
                output,
              );
            }
            if (output) process.stdout.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
            break;
          }
          await delay(LIVE_POLL_MS);
        }
      } catch (error) {
        operationError = error;
      }
      try {
        await context.close(keepTab);
      } catch (error) {
        await appendBrowserWarning(activeMeta, "obu-tab-finalize-failed", error);
      }
      if (operationError) throw operationError;
      if (!finalHarvest) throw new Error("Main-Chrome live tail returned no result.");
      return finalHarvest;
    });
  }
  const recordedEndpoint = sessionBrowserEndpoint(meta);
  let endpoint = recordedEndpoint ?? {
    host: DEFAULT_REMOTE_CHROME_HOST,
    port: DEFAULT_REMOTE_CHROME_PORT,
  };
  let browserTabRef = options.browserTabRef ?? resolveSessionTabRef(meta);
  const recoverIfMissing = options.recoverIfMissing !== false && !options.browserTabRef;
  let recoveredChrome: { kill: () => void; process?: { unref?: () => void } } | null = null;
  const stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  let lastHash: string | null = null;
  let unchangedSince = Date.now();
  let requireRecoveredContent = false;
  let recoveredContentDeadlineMs = 0;

  try {
    // Probe once to see if the live tab is still alive; recover if not.
    try {
      await harvestChatGptTab({
        ...endpoint,
        ref: browserTabRef,
        turnBinding: storedConversationTurnBinding(meta),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isRecoverableMissingTabError(message) || !recoverIfMissing) {
        throw error;
      }
      console.log(
        chalk.yellow(
          `No live ChatGPT tab matched session "${sessionId}". Attempting recovery by reopening the saved conversation URL.`,
        ),
      );
      const recovered = await recoverConversationTab(meta, (line) => console.log(line), {
        existingEndpoint: recordedEndpoint ?? undefined,
        waitForReady: false,
      });
      recoveredChrome = recovered.chrome;
      endpoint = {
        host: recovered.host,
        port: recovered.port,
        browserId: recovered.browserId,
        accountDigest: recovered.accountDigest,
      };
      browserTabRef = recovered.ref;
      requireRecoveredContent = true;
      recoveredContentDeadlineMs = Date.now() + stallThresholdMs;
    }

    while (true) {
      const harvested = await harvestChatGptTab({
        ...endpoint,
        ref: browserTabRef,
        turnBinding: storedConversationTurnBinding(meta),
      });
      const fullText = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
      if (requireRecoveredContent && !isRecoveredConversationHarvestReady(harvested)) {
        if (Date.now() < recoveredContentDeadlineMs) {
          await delay(LIVE_POLL_MS);
          continue;
        }
        throw new Error("Recovered ChatGPT conversation did not become ready in time.");
      }
      requireRecoveredContent = false;
      const hash = createHash("sha1").update(fullText).digest("hex");
      if (hash !== lastHash) {
        lastHash = hash;
        unchangedSince = Date.now();
        const statusLine =
          `[${new Date().toISOString()}] state=${harvested.state} stop=${harvested.stopExists ? "yes" : "no"} ` +
          `send=${harvested.sendExists ? "yes" : "no"} model=${harvested.currentModelLabel || "(unknown)"} ` +
          `snippet=${snippet(harvested.lastAssistantSnippet || fullText, 160)}`;
        console.log(statusLine);
        await persistHarvest(sessionId, meta, harvested);
      }

      const derivedState = harvested.stopExists
        ? Date.now() - unchangedSince >= stallThresholdMs
          ? "stalled"
          : "running"
        : harvested.authenticated
          ? "completed"
          : "detached";

      if (
        derivedState === "completed" ||
        derivedState === "stalled" ||
        derivedState === "detached"
      ) {
        const finalHarvest: ChatGptTabSummary = {
          ...harvested,
          state: derivedState,
        };
        await persistHarvest(sessionId, meta, finalHarvest);
        printHarvestSummary(sessionId, finalHarvest);
        const output = finalHarvest.lastAssistantMarkdown ?? finalHarvest.lastAssistantText ?? "";
        if (options.writeOutputPath) {
          await maybeWriteHarvestOutput(options.writeOutputPath, meta.cwd ?? process.cwd(), output);
        }
        if (output) {
          process.stdout.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
        }
        return finalHarvest;
      }

      await delay(LIVE_POLL_MS);
    }
  } finally {
    finishRecoveredChrome(recoveredChrome, options.closeAfterRecover);
  }
}
