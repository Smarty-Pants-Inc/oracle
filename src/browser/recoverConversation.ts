import type { LaunchedChrome } from "chrome-launcher";
import type { SessionMetadata } from "../sessionStore.js";
import type { BrowserLogger } from "./types.js";
import { isAnswerNowPlaceholderText } from "./actions/assistantResponse.js";
import { resolveBrowserConfig } from "./config.js";
import { acquireManualLoginChromeForRun, isImageOnlyUiChromeText } from "./index.js";
import { isRecoverableChatGptConversationUrl } from "./reattachability.js";
import {
  extractConversationIdFromUrl,
  harvestChatGptTab,
  openChatGptTarget,
  type ChatGptTabSummary,
} from "./liveTabs.js";
import {
  closeTab,
  connectToRemoteChromeTarget,
  type RemoteChromeConnection,
} from "./chromeLifecycle.js";
import { resolveRemoteChromeBrowserIdentity } from "./profileState.js";
import { readChatGptAccountDigest } from "./pageActions.js";
import { CHATGPT_URL } from "./constants.js";
import { delay } from "./utils.js";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 1_000;

export interface RecoveredConversation {
  host: string;
  port: number;
  url: string;
  ref: string;
  browserId?: string;
  accountDigest?: string;
  chrome: LaunchedChrome | null;
}

export interface RecoveryEndpoint {
  host: string;
  port: number;
  browserId?: string;
  accountDigest?: string;
}

/**
 * Picks the URL to navigate the recovered Chrome tab to.
 *
 * Preference order matches `resolveSessionTabRef`: `harvest.url` (post-harvest,
 * always a ChatGPT conversation URL when present) wins over `runtime.tabUrl`
 * (the URL the original run last navigated to, which can be stale).
 *
 * Both candidates are gated by `isRecoverableChatGptConversationUrl` so a stale
 * home / project shell URL or an unrelated external URL stored in metadata
 * cannot navigate the persistent signed-in profile to the wrong page.
 */
export function resolveRecoveryUrl(meta: SessionMetadata): string | null {
  const harvest = meta?.browser?.harvest ?? {};
  const runtime = meta?.browser?.runtime ?? {};
  for (const candidate of [harvest.url, runtime.tabUrl]) {
    if (isRecoverableChatGptConversationUrl(candidate)) {
      return candidate as string;
    }
  }
  return null;
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
  expectedUrl: string,
  timeoutMs: number,
  waitForReady: boolean,
): Promise<void> {
  const expectedConversationId = extractConversationIdFromUrl(expectedUrl);
  if (!expectedConversationId) {
    throw new Error("Saved ChatGPT conversation URL has no stable conversation id.");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let harvested: ChatGptTabSummary | undefined;
    try {
      harvested = await harvestChatGptTab({ ...endpoint, ref, expectedConversationId });
    } catch {
      // Keep polling until the bounded recovery deadline.
    }
    if (harvested) {
      const observedConversationId = extractConversationIdFromUrl(harvested.url);
      if (observedConversationId !== expectedConversationId) {
        if (waitForReady && isRecoveredConversationHarvestReady(harvested)) {
          throw new Error("Recovered ChatGPT conversation changed before recovery completed.");
        }
      } else if (!waitForReady || isRecoveredConversationHarvestReady(harvested)) {
        return;
      } else {
        // The saved conversation is still hydrating; keep polling.
      }
    }
    if (Date.now() < deadline) {
      await delay(READY_POLL_MS);
    }
  }
  const outcome = waitForReady ? "become ready" : "open the saved conversation";
  throw new Error(`Recovered ChatGPT conversation did not ${outcome} in time.`);
}

async function closeRecoveryTarget(
  endpoint: RecoveryEndpoint,
  targetId: string,
  logger: BrowserLogger,
): Promise<void> {
  if (!(await closeTab(endpoint.port, targetId, logger, endpoint.host))) {
    throw new Error("Conversation recovery target cleanup was not confirmed.");
  }
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

async function openRecoveryTarget(
  endpoint: RecoveryEndpoint,
  url: string,
  logger: BrowserLogger,
): Promise<string> {
  const expectedBrowserId = endpoint.browserId?.trim();
  const expectedAccountDigest = endpoint.accountDigest?.trim();
  if (!expectedBrowserId && !expectedAccountDigest) {
    return openChatGptTarget({ ...endpoint, url });
  }
  if (
    !expectedBrowserId ||
    !expectedAccountDigest ||
    !/^[a-f0-9]{64}$/.test(expectedAccountDigest)
  ) {
    throw new Error("Stored remote Chrome browser and account identity is incomplete.");
  }
  const liveIdentity = await resolveRemoteChromeBrowserIdentity(endpoint);
  if (liveIdentity.browserId !== expectedBrowserId) {
    throw new Error("Remote Chrome browser identity changed before conversation recovery.");
  }
  const targetId = await openChatGptTarget({
    host: endpoint.host,
    port: endpoint.port,
    browserWSEndpoint: liveIdentity.browserWSEndpoint,
    url: CHATGPT_URL,
  });
  let connection: RemoteChromeConnection | undefined;
  let operationError: unknown;
  let ready = false;
  try {
    connection = await connectToRemoteChromeTarget(endpoint.host, endpoint.port, logger, {
      browserWSEndpoint: liveIdentity.browserWSEndpoint,
      targetId,
      closeTargetOnDispose: false,
    });
    const { Page, Runtime } = connection.client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    const deadline = Date.now() + 10_000;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        const observedAccountDigest = await readChatGptAccountDigest(Runtime);
        if (observedAccountDigest !== expectedAccountDigest) {
          throw new Error("Remote Chrome account identity changed before conversation recovery.");
        }
        await Page.navigate({ url });
        ready = true;
        break;
      } catch (error) {
        if (error instanceof Error && /identity changed/i.test(error.message)) {
          throw error;
        }
        lastError = error;
        await delay(100);
      }
    }
    if (!ready) {
      throw lastError instanceof Error
        ? lastError
        : new Error("Authenticated ChatGPT account identity is unavailable.");
    }
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (connection) {
    try {
      await connection.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (operationError || cleanupErrors.length) {
    try {
      await closeRecoveryTarget(endpoint, targetId, logger);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (operationError && cleanupErrors.length) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      "Conversation recovery and target cleanup failed.",
    );
  }
  if (operationError) throw operationError;
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, "Conversation recovery target cleanup failed.");
  }
  return targetId;
}

/**
 * Re-open a previously-harvested ChatGPT conversation by relaunching Chrome
 * with the session's persistent profile and navigating to the saved tab URL.
 *
 * Used as a fallback when `harvestChatGptTab` can find no live tab matching the
 * stored target (common after the original CLI run exits and closes its
 * browser). ChatGPT preserves attachments + history at the conversation URL,
 * so harvesting against the relaunched tab returns the original message + any
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
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const waitForReady = options.waitForReady !== false;
  if (options.existingEndpoint) {
    let targetId: string | undefined;
    try {
      logger(
        `[browser] Recovery: opening saved conversation in existing Chrome at ` +
          `${options.existingEndpoint.host}:${options.existingEndpoint.port}`,
      );
      targetId = await openRecoveryTarget(options.existingEndpoint, url, logger);
      await waitForRecoveredConversationReady(
        options.existingEndpoint,
        targetId,
        url,
        readyTimeoutMs,
        waitForReady,
      );
      return { ...options.existingEndpoint, url, ref: targetId, chrome: null };
    } catch (error) {
      if (targetId) {
        try {
          await closeRecoveryTarget(options.existingEndpoint, targetId, logger);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Conversation recovery and target cleanup failed.",
          );
        }
      }
      logger("[browser] Recovery: existing Chrome could not reopen the saved conversation.");
      if (options.existingEndpoint.browserId || options.existingEndpoint.accountDigest) {
        throw error;
      }
    }
  }

  const userDataDir = resolveRecoveryProfileDir(meta);
  const config = resolveBrowserConfig(meta.browser?.config);

  logger("[browser] Recovery: relaunching Chrome with the stored recovery profile.");

  const { chrome } = await acquireManualLoginChromeForRun(userDataDir, config, logger, meta.id, {});
  const host = chrome.host ?? "127.0.0.1";
  const port = chrome.port;

  let targetId: string | undefined;
  try {
    targetId = await openChatGptTarget({ host, port, url });
    await waitForRecoveredConversationReady(
      { host, port },
      targetId,
      url,
      readyTimeoutMs,
      waitForReady,
    );

    logger(`[browser] Recovery: Chrome listening on ${host}:${port}; tab loaded.`);

    return { host, port, url, ref: targetId, chrome };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (targetId) {
      try {
        await closeRecoveryTarget({ host, port }, targetId, logger);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      chrome.kill();
    } catch {
      // best-effort cleanup
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Conversation recovery and target cleanup failed.",
      );
    }
    throw error;
  }
}
