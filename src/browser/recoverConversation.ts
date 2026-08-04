import type { BrowserChrome } from "./manualChromeOwner.js";
import type { SessionMetadata } from "../sessionStore.js";
import type { BrowserLogger, ResolvedBrowserConfig } from "./types.js";
import { isAnswerNowPlaceholderText } from "./actions/assistantResponse.js";
import { closeChromeTarget } from "./chromeLifecycle.js";
import { resolveBrowserConfig } from "./config.js";
import { isImageOnlyUiChromeText } from "./index.js";
import { acquireManualChromeOwner } from "./manualChromeOwner.js";
import { isSafeChromeTerminationOutcome } from "./profileState.js";
import { isRecoverableChatGptConversationUrl } from "./reattachability.js";
import { acquireBrowserTabLease, type BrowserTabLease } from "./tabLeaseRegistry.js";
import { extractConversationIdFromUrl, harvestChatGptTab, openChatGptTarget } from "./liveTabs.js";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 1_000;

export interface RecoveredConversation {
  host: string;
  port: number;
  url: string;
  ref: string;
  cleanup: () => Promise<void>;
}

export interface RecoveryEndpoint {
  host: string;
  port: number;
}

/**
 * Picks the URL to navigate the recovered Chrome tab to.
 *
 * A committed prompt epoch is the durable conversation authority: every
 * recoverable harvest/runtime URL must name its exact conversation. Epoch-less
 * legacy sessions retain URL-only recovery; a pending epoch has no committed
 * conversation authority and therefore cannot authorize a recovery target.
 */
export function resolveRecoveryUrl(meta: SessionMetadata): string | null {
  const harvest = meta?.browser?.harvest ?? {};
  const runtime = meta?.browser?.runtime ?? {};
  const promptEpoch = runtime.promptEpoch;
  if (promptEpoch && promptEpoch.status !== "committed") return null;
  const committedConversationId =
    promptEpoch?.status === "committed" ? promptEpoch.conversationId.trim() : null;
  if (promptEpoch && !committedConversationId) return null;
  let recoveryUrl: string | null = null;
  for (const candidate of [harvest.url, runtime.tabUrl]) {
    if (!isRecoverableChatGptConversationUrl(candidate)) continue;
    const recoverableUrl = candidate as string;
    if (
      committedConversationId &&
      extractConversationIdFromUrl(recoverableUrl) !== committedConversationId
    ) {
      return null;
    }
    recoveryUrl ??= recoverableUrl;
  }
  return recoveryUrl;
}

export function resolveRecoveryProfileDir(meta: SessionMetadata): string {
  const config = meta?.browser?.config;
  const resolved = resolveBrowserConfig(config);
  if (!resolved.manualLogin) {
    throw new Error(
      "Cannot recover conversation: session was not run with a manual-login browser profile.",
    );
  }
  const runtime = meta?.browser?.runtime;
  const profileDir = runtime?.userDataDir ?? resolved.manualLoginProfileDir;
  if (typeof profileDir !== "string" || profileDir.trim().length === 0) {
    throw new Error(
      "Cannot recover conversation: session metadata has no recorded manual-login profile directory.",
    );
  }
  return profileDir;
}

async function waitForRecoveredConversationReady(
  endpoint: RecoveryEndpoint,
  ref: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const harvested = await harvestChatGptTab({ ...endpoint, ref });
      if (isRecoveredConversationHarvestReady(harvested)) {
        return;
      }
      lastError = new Error(`recovered tab is still ${harvested.state}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Recovered ChatGPT conversation did not become ready in time.${suffix}`);
}

export function isRecoveredConversationHarvestReady(harvested: {
  stopExists?: boolean;
  assistantCount?: number;
  assistantFollowsLatestUser?: boolean;
  lastAssistantTurnIndex?: number;
  lastUserTurnIndex?: number;
  lastAssistantMarkdown?: string | null;
  lastAssistantText?: string | null;
  lastAssistantSnippet?: string | null;
}): boolean {
  const latestAssistant =
    harvested.lastAssistantText ??
    harvested.lastAssistantMarkdown ??
    harvested.lastAssistantSnippet ??
    "";
  const assistantFollowsLatestUser =
    harvested.assistantFollowsLatestUser === true ||
    (typeof harvested.lastAssistantTurnIndex === "number" &&
      typeof harvested.lastUserTurnIndex === "number" &&
      harvested.lastAssistantTurnIndex > harvested.lastUserTurnIndex);
  const hasHydratedUserTurn =
    typeof harvested.lastUserTurnIndex === "number" && harvested.lastUserTurnIndex >= 0;
  return (
    (harvested.stopExists === true && hasHydratedUserTurn) ||
    ((harvested.assistantCount ?? 0) > 0 &&
      assistantFollowsLatestUser &&
      latestAssistant.trim().length > 0 &&
      !isImageOnlyUiChromeText(latestAssistant) &&
      !isAnswerNowPlaceholderText(latestAssistant) &&
      !/^answer now$/i.test(latestAssistant.trim()))
  );
}

async function releaseRecoveredConversationLease({
  lease,
  launchedChrome,
  config,
  logger,
}: {
  lease: BrowserTabLease;
  launchedChrome: BrowserChrome | null;
  config: ResolvedBrowserConfig;
  logger: BrowserLogger;
}): Promise<void> {
  await lease.release({
    onRelease: async ({ isLastLease }) => {
      if (!isLastLease || !launchedChrome || config.keepBrowser) return;
      try {
        const outcome = await launchedChrome.kill();
        if (!isSafeChromeTerminationOutcome(outcome)) {
          logger(
            `[browser] Recovered Chrome termination was unsafe; preserving profile state: ${outcome.reason}`,
          );
        }
      } catch (error) {
        logger(
          `[browser] Recovered Chrome termination failed; preserving profile state: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  });
}

function createRecoveredConversationCleanup({
  host,
  port,
  targetId,
  lease,
  launchedChrome,
  config,
  logger,
}: {
  host: string;
  port: number;
  targetId: string;
  lease: BrowserTabLease;
  launchedChrome: BrowserChrome | null;
  config: ResolvedBrowserConfig;
  logger: BrowserLogger;
}): () => Promise<void> {
  let cleanupPromise: Promise<void> | null = null;
  return () => {
    cleanupPromise ??= (async () => {
      try {
        const closed = await closeChromeTarget({ host, port, targetId, logger });
        if (!closed) logger(`[browser] Failed to close recovered target ${targetId}.`);
      } finally {
        await releaseRecoveredConversationLease({ lease, launchedChrome, config, logger });
      }
    })();
    return cleanupPromise;
  };
}

/**
 * Re-open a previously-harvested ChatGPT conversation by acquiring the canonical Chrome owner
 * for the session's persistent profile and navigating a tab to the saved URL.
 *
 * Used as a fallback when `harvestChatGptTab` can find no live tab matching the
 * stored target (common after the original CLI run exits and closes its
 * browser). ChatGPT preserves attachments + history at the conversation URL,
 * so harvesting against the recovered tab returns the original message + any
 * assistant response that completed after the original run gave up.
 */
export async function recoverConversationTab(
  meta: SessionMetadata,
  logger: BrowserLogger,
  options: {
    existingEndpoint?: RecoveryEndpoint;
    readyTimeoutMs?: number;
    waitForReady?: boolean;
  } = {},
): Promise<RecoveredConversation> {
  const url = resolveRecoveryUrl(meta);
  if (!url) {
    throw new Error(
      "Cannot recover conversation: session metadata has no recoverable ChatGPT conversation URL " +
        "(expected browser.harvest.url or browser.runtime.tabUrl to be a chatgpt.com/c/<id> URL).",
    );
  }
  const userDataDir = resolveRecoveryProfileDir(meta);
  const config = resolveBrowserConfig(meta.browser?.config);
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const waitForReady = options.waitForReady !== false;
  const lease = await acquireBrowserTabLease(userDataDir, {
    maxConcurrentTabs: config.maxConcurrentTabs,
    timeoutMs: config.timeoutMs,
    logger,
    sessionId: meta.id,
  });
  let recoveredCleanup: (() => Promise<void>) | null = null;
  let launchedChrome: BrowserChrome | null = null;

  try {
    if (options.existingEndpoint) {
      let targetId: string | null = null;
      try {
        logger(
          `[browser] Recovery: opening saved conversation in existing Chrome at ` +
            `${options.existingEndpoint.host}:${options.existingEndpoint.port}`,
        );
        targetId = await openChatGptTarget({ ...options.existingEndpoint, url });
        if (waitForReady) {
          await waitForRecoveredConversationReady(
            options.existingEndpoint,
            targetId,
            readyTimeoutMs,
          );
        }
        await lease.update({
          chromeHost: options.existingEndpoint.host,
          chromePort: options.existingEndpoint.port,
          chromeTargetId: targetId,
          tabUrl: url,
        });
        recoveredCleanup = createRecoveredConversationCleanup({
          host: options.existingEndpoint.host,
          port: options.existingEndpoint.port,
          targetId,
          lease,
          launchedChrome: null,
          config,
          logger,
        });
        return { ...options.existingEndpoint, url, ref: targetId, cleanup: recoveredCleanup };
      } catch (error) {
        if (targetId) {
          const closed = await closeChromeTarget({
            host: options.existingEndpoint.host,
            port: options.existingEndpoint.port,
            targetId,
            logger,
          });
          if (!closed) logger(`[browser] Failed to close unused recovered target ${targetId}.`);
        }
        const message = error instanceof Error ? error.message : String(error);
        logger(
          `[browser] Recovery: existing Chrome could not reopen the conversation (${message}).`,
        );
      }
    }

    logger(
      `[browser] Recovery: acquiring Chrome owner for profile ${userDataDir} and navigating to ${url}`,
    );
    const owner = await acquireManualChromeOwner(userDataDir, config, logger, meta.id);
    const { chrome } = owner;
    launchedChrome = owner.source === "launched" ? chrome : null;
    const host = chrome.host ?? "127.0.0.1";
    const port = chrome.port;
    const targetId = await openChatGptTarget({ host, port, url });
    recoveredCleanup = createRecoveredConversationCleanup({
      host,
      port,
      targetId,
      lease,
      launchedChrome,
      config,
      logger,
    });
    if (waitForReady) {
      await waitForRecoveredConversationReady({ host, port }, targetId, readyTimeoutMs);
    }
    await lease.update({
      chromeHost: host,
      chromePort: port,
      chromeTargetId: targetId,
      tabUrl: url,
    });
    logger(`[browser] Recovery: Chrome listening on ${host}:${port}; tab loaded.`);
    return { host, port, url, ref: targetId, cleanup: recoveredCleanup };
  } catch (error) {
    await recoveredCleanup?.().catch((cleanupError) => {
      logger(
        `[browser] Recovery cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    });
    if (!recoveredCleanup) {
      await releaseRecoveredConversationLease({ lease, launchedChrome, config, logger }).catch(
        (releaseError) => {
          logger(
            `[browser] Recovery lease release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
          );
        },
      );
    }
    throw error;
  }
}
