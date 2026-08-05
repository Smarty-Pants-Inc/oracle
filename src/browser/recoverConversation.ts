import {
  acquireManualChromeOwner,
  settleManualChromeOwner,
  type ManualChromeOwner,
} from "./manualChromeOwner.js";
import type {
  BrowserRecoveryCleanupResourceMetadata,
  BrowserRuntimeMetadata,
} from "../sessionManager.js";
import type { SessionMetadata } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserLogger } from "./types.js";
import { isAnswerNowPlaceholderText } from "./actions/assistantResponse.js";
import { promptIdentitySha256 } from "./actions/promptComposer.js";
import { closeChromeTarget } from "./chromeLifecycle.js";
import { resolveBrowserConfig } from "./config.js";
import { CHATGPT_URL } from "./constants.js";
import {
  retainBrowserTabLeaseTeardownAuthority,
  acquireBrowserTabLease,
  type BrowserTabLease,
} from "./tabLeaseRegistry.js";
import {
  isRecoverableChatGptConversationUrl,
  resolveCommittedPromptEpochLocator,
  type CommittedPromptEpochLocator,
} from "./reattachability.js";
import { isImageOnlyUiChromeText } from "./index.js";
import { harvestChatGptTab, openChatGptTarget } from "./liveTabs.js";
import { buildConversationUrl } from "./reattachHelpers.js";
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 1_000;

export type RecoveredConversationCleanupResult =
  | { status: "completed" }
  | {
      status: "pending";
      resource: BrowserRecoveryCleanupResourceMetadata;
      error: string;
    };

export type RecoveredConversationCleanup = () => Promise<RecoveredConversationCleanupResult>;

export interface RecoveredConversation {
  host: string;
  port: number;
  url: string;
  ref: string;
  locator: CommittedPromptEpochLocator;
  cleanup: RecoveredConversationCleanup;
}

export interface RecoveryEndpoint {
  host: string;
  port: number;
}

/** Resolve the exact conversation URL authorized by a committed prompt epoch. */
export function resolveRecoveryUrl(
  meta: SessionMetadata,
  fallbackBaseUrl = CHATGPT_URL,
): string | null {
  const locator = resolveCommittedPromptEpochLocator(meta.browser?.runtime, [
    meta.browser?.harvest?.url,
  ]);
  if (!locator) return null;
  const savedUrl = locator.conversationUrls[0];
  if (savedUrl) return savedUrl;

  for (const baseUrl of [meta.browser?.config?.url, fallbackBaseUrl, CHATGPT_URL]) {
    if (typeof baseUrl !== "string" || !baseUrl.trim()) continue;
    const built = buildConversationUrl({ conversationId: locator.conversationId }, baseUrl);
    if (built && isRecoverableChatGptConversationUrl(built)) return built;
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
  timeoutMs: number,
  locator: CommittedPromptEpochLocator,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const harvested = await harvestChatGptTab({ ...endpoint, ref });
      if (isRecoveredConversationHarvestReady(harvested, locator)) {
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

export interface RecoveredConversationHarvestIdentity {
  stopExists?: boolean;
  assistantCount?: number;
  assistantFollowsLatestUser?: boolean;
  lastAssistantTurnIndex?: number;
  lastUserTurnIndex?: number;
  lastAssistantMarkdown?: string | null;
  lastAssistantText?: string | null;
  lastAssistantSnippet?: string | null;
  conversationId?: string | null;
  lastUserText?: string | null;
  lastUserTurnId?: string | null;
  lastUserMessageId?: string | null;
}

export function recoveredConversationHarvestMatchesPromptEpoch(
  harvested: RecoveredConversationHarvestIdentity,
  locator: CommittedPromptEpochLocator,
): boolean {
  return (
    harvested.conversationId === locator.conversationId &&
    harvested.lastUserTurnIndex === locator.verifiedUserTurnIndex &&
    typeof harvested.lastUserText === "string" &&
    promptIdentitySha256(harvested.lastUserText) === locator.promptSha256 &&
    harvested.lastUserTurnId === locator.verifiedUserTurnId &&
    harvested.lastUserMessageId === locator.verifiedUserMessageId
  );
}

export function isRecoveredConversationHarvestReady(
  harvested: RecoveredConversationHarvestIdentity,
  locator?: CommittedPromptEpochLocator,
): boolean {
  if (locator && !recoveredConversationHarvestMatchesPromptEpoch(harvested, locator)) {
    return false;
  }
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

interface RecoveredConversationCleanupController {
  cleanup: RecoveredConversationCleanup;
  setTarget: (host: string, port: number, targetId: string) => void;
  clearTarget: () => void;
}

function createRecoveredConversationCleanup({
  userDataDir,
  lease,
  getOwner,
  logger,
  locator,
}: {
  userDataDir: string;
  lease: BrowserTabLease;
  getOwner: () => ManualChromeOwner | null;
  logger: BrowserLogger;
  locator: CommittedPromptEpochLocator;
}): RecoveredConversationCleanupController {
  let target: { host: string; port: number; targetId: string } | null = null;
  let leaseReleased = false;
  let processSettled = false;
  const teardownAuthority = retainBrowserTabLeaseTeardownAuthority(userDataDir, lease, { logger });
  let completed = false;
  let inFlight: Promise<RecoveredConversationCleanupResult> | null = null;

  const pendingResource = (): BrowserRecoveryCleanupResourceMetadata => {
    const owner = getOwner();
    const ownsProcess = Boolean(owner?.disposition === "close-on-last-lease" && !processSettled);
    return {
      chromePid: ownsProcess ? owner?.chrome.pid : undefined,
      chromeProcessIdentity: ownsProcess ? owner?.processIdentity : undefined,
      chromePort: target?.port ?? owner?.chrome.port,
      chromeHost: target?.host ?? owner?.chrome.host ?? "127.0.0.1",
      chromeProfileRoot: ownsProcess ? userDataDir : undefined,
      userDataDir,
      chromeTargetId: target?.targetId,
      conversationId: locator.conversationId,
      promptEpoch: locator.epoch,
      tabLease: leaseReleased
        ? undefined
        : { id: lease.id, profileDirectory: lease.profileDirectory },
      recoveryCleanup: {
        ownsTarget: Boolean(target),
        profileKind: ownsProcess ? "manual-login" : "none",
        keepBrowser: !ownsProcess,
        closeOwnedTargetOnComplete: Boolean(target),
      },
    };
  };

  const pending = (error: string): RecoveredConversationCleanupResult => ({
    status: "pending",
    resource: pendingResource(),
    error,
  });

  const cleanup = async (): Promise<RecoveredConversationCleanupResult> => {
    if (completed) return { status: "completed" };
    if (inFlight) return inFlight;
    const attempt = (async (): Promise<RecoveredConversationCleanupResult> => {
      if (target) {
        let closed = false;
        try {
          closed = await closeChromeTarget({ ...target, logger });
        } catch (error) {
          return pending(
            `Recovered target close failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!closed) {
          return pending(`Recovered target close was not confirmed: ${target.targetId}`);
        }
        target = null;
      }
      const owner = getOwner();
      if (owner?.disposition === "close-on-last-lease") {
        const outcome = await teardownAuthority.settle(async () => {
          const settlement = await settleManualChromeOwner(userDataDir, owner, logger);
          processSettled = settlement.status === "terminated";
          return processSettled;
        });
        leaseReleased = teardownAuthority.leaseReleased;
        if (outcome.status === "preserved") {
          return pending(
            `Recovered Chrome settlement remains pending: ${outcome.error ?? outcome.reason}`,
          );
        }
        completed = true;
        return { status: "completed" };
      }

      if (!leaseReleased) {
        try {
          await lease.release();
          leaseReleased = true;
        } catch (error) {
          return pending(
            `Recovered browser lease release failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (owner?.disposition === "preserve") {
        const settlement = await settleManualChromeOwner(userDataDir, owner, logger);
        if (settlement.status === "unsafe") {
          return pending(
            `Recovered Chrome authority release remains pending: ${settlement.reason}`,
          );
        }
      }
      completed = true;
      return { status: "completed" };
    })().finally(() => {
      inFlight = null;
    });
    inFlight = attempt;
    return attempt;
  };

  return {
    cleanup,
    setTarget: (host, port, targetId) => {
      target = { host, port, targetId };
    },
    clearTarget: () => {
      target = null;
    },
  };
}

function pendingRecoveredConversationCleanupError(
  meta: SessionMetadata,
  result: Extract<RecoveredConversationCleanupResult, { status: "pending" }>,
  cause: unknown,
): BrowserAutomationError {
  const previousRuntime = meta.browser?.runtime ?? {};
  const resources = [...(previousRuntime.recoveryCleanupResources ?? [])];
  const resourceIdentity = JSON.stringify(result.resource);
  if (!resources.some((resource) => JSON.stringify(resource) === resourceIdentity)) {
    resources.push(result.resource);
  }
  const runtime: BrowserRuntimeMetadata = {
    ...previousRuntime,
    recoveryCleanupResources: resources,
    recoveryCleanupResult: { status: "failed", error: result.error },
  };
  return new BrowserAutomationError(
    `Recovered browser cleanup remains pending: ${result.error}`,
    { stage: "recovered-conversation-cleanup", runtime },
    cause,
  );
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
  const locator = resolveCommittedPromptEpochLocator(meta.browser?.runtime, [
    meta.browser?.harvest?.url,
  ]);
  const url = resolveRecoveryUrl(meta);
  if (!locator || !url) {
    throw new Error(
      "Cannot recover conversation: session metadata lacks a valid committed prompt epoch " +
        "bound to an exact ChatGPT conversation URL.",
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
  let owner: ManualChromeOwner | null = null;
  const recoveredCleanup = createRecoveredConversationCleanup({
    userDataDir,
    lease,
    getOwner: () => owner,
    logger,
    locator,
  });

  try {
    if (options.existingEndpoint) {
      let targetId: string | null = null;
      try {
        logger(
          `[browser] Recovery: opening saved conversation in existing Chrome at ` +
            `${options.existingEndpoint.host}:${options.existingEndpoint.port}`,
        );
        targetId = await openChatGptTarget({ ...options.existingEndpoint, url });
        recoveredCleanup.setTarget(
          options.existingEndpoint.host,
          options.existingEndpoint.port,
          targetId,
        );
        if (waitForReady) {
          await waitForRecoveredConversationReady(
            options.existingEndpoint,
            targetId,
            readyTimeoutMs,
            locator,
          );
        }
        await lease.update({
          chromeHost: options.existingEndpoint.host,
          chromePort: options.existingEndpoint.port,
          chromeTargetId: targetId,
          tabUrl: url,
        });
        return {
          ...options.existingEndpoint,
          url,
          ref: targetId,
          locator,
          cleanup: recoveredCleanup.cleanup,
        };
      } catch (error) {
        if (targetId) {
          const closed = await closeChromeTarget({
            host: options.existingEndpoint.host,
            port: options.existingEndpoint.port,
            targetId,
            logger,
          }).catch(() => false);
          if (!closed) throw error;
          recoveredCleanup.clearTarget();
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
    owner = await acquireManualChromeOwner(userDataDir, config, logger, meta.id);
    const { chrome } = owner;
    const host = chrome.host ?? "127.0.0.1";
    const port = chrome.port;
    const targetId = await openChatGptTarget({ host, port, url });
    recoveredCleanup.setTarget(host, port, targetId);
    if (waitForReady) {
      await waitForRecoveredConversationReady({ host, port }, targetId, readyTimeoutMs, locator);
    }
    await lease.update({
      chromeHost: host,
      chromePort: port,
      chromeTargetId: targetId,
      tabUrl: url,
    });
    logger(`[browser] Recovery: Chrome listening on ${host}:${port}; tab loaded.`);
    return { host, port, url, ref: targetId, locator, cleanup: recoveredCleanup.cleanup };
  } catch (error) {
    const cleanupResult = await recoveredCleanup.cleanup();
    if (cleanupResult.status === "pending") {
      throw pendingRecoveredConversationCleanupError(meta, cleanupResult, error);
    }
    throw error;
  }
}
