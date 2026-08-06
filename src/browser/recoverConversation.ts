import { randomUUID } from "node:crypto";
import { acquireManualChromeOwner } from "./manualChromeOwner.js";
import type { BrowserRuntimeMetadata } from "../sessionManager.js";
import type { SessionMetadata } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserCaptureFinalizationResult, BrowserLogger, ChromeClient } from "./types.js";
import { isAnswerNowPlaceholderText } from "./actions/assistantResponse.js";
import { promptIdentitySha256 } from "./actions/committedPrompt.js";
import {
  closeChromeTargetWithExactAuthority,
  connectWithNewTabWithRetainedLiveAuthority,
  connectWithNewTabWithExactAuthority,
  type RetainedChromeEndpointAuthority,
} from "./chromeLifecycle.js";
import { resolveBrowserConfig } from "./config.js";
import { CHATGPT_URL } from "./constants.js";
import { acquireBrowserTabLease } from "./tabLeaseRegistry.js";
import { captureProfileDirectoryIdentity, createChromeProcessLaunchClaim } from "./profileState.js";
import {
  LocalOwnedBrowserResourceAuthority,
  type BrowserCaptureSettlementMode,
} from "./ownedBrowserResources.js";
import {
  isRecoverableChatGptConversationUrl,
  resolveCommittedPromptEpochLocator,
  type CommittedPromptEpochLocator,
} from "./reattachability.js";
import { isImageOnlyUiChromeText } from "./index.js";
import { harvestChatGptTab } from "./liveTabs.js";
import { buildConversationUrl } from "./reattachHelpers.js";
import { retainChromeTargetCloseCapability } from "./targetCloseAuthority.js";
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 1_000;

export type RecoveredConversationCleanup = (
  mode: BrowserCaptureSettlementMode,
  pendingRuntime?: BrowserRuntimeMetadata,
) => Promise<BrowserCaptureFinalizationResult>;

export interface RecoveredConversation {
  host: string;
  port: number;
  url: string;
  ref: string;
  locator: CommittedPromptEpochLocator;
  endpointAuthority?: RetainedChromeEndpointAuthority;
  cleanup: RecoveredConversationCleanup;
}

export interface RecoveryEndpoint {
  host: string;
  port: number;
}

export interface NonOwnedRecoveryEndpoint extends RecoveryEndpoint {
  ownership: "non-owned";
}

type RecoveryReadyEndpoint = RecoveryEndpoint & {
  endpointAuthority?: RetainedChromeEndpointAuthority;
};

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
  endpoint: RecoveryReadyEndpoint,
  ref: string,
  timeoutMs: number,
  locator: CommittedPromptEpochLocator,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const harvested = await harvestChatGptTab({
        host: endpoint.host,
        port: endpoint.port,
        ref,
        endpointAuthority: endpoint.endpointAuthority,
      });
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
    existingEndpoint?: NonOwnedRecoveryEndpoint;
    readyTimeoutMs?: number;
    waitForReady?: boolean;
    persistRuntime?: (runtime: BrowserRuntimeMetadata) => void | Promise<void>;
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
  const generationId = randomUUID();
  const launchClaim = createChromeProcessLaunchClaim(generationId);
  const ownerDisposition = config.keepBrowser ? "preserve" : "close-on-last-lease";
  const leaseId = randomUUID();
  const targetMarkerUrl = `about:blank#oracle-recovery=${generationId}`;
  const profileDirectory = await captureProfileDirectoryIdentity(userDataDir);
  const baseRuntime: BrowserRuntimeMetadata = {
    ...(meta.browser?.runtime ?? {}),
    browserTransport: "cdp",
    chromeTargetId: undefined,
    chromeProfileRoot: userDataDir,
    userDataDir,
    tabUrl: url,
    conversationId: locator.conversationId,
    promptEpoch: locator.epoch,
    controllerPid: process.pid,
  };
  delete baseRuntime.recoveryCleanupResources;
  delete baseRuntime.recoveryCleanupResult;
  const resources = new LocalOwnedBrowserResourceAuthority({
    purpose: "Recovered ChatGPT",
    targetLabel: "Recovered",
    baseRuntime,
    userDataDir,
    profileDirectoryIdentity: profileDirectory,
    profileKind: "manual-login",
    keepBrowser: config.keepBrowser,
    closeOwnedTargetOnComplete: true,
    generationId,
    processOwnerProvenance: "manual-canonical-owner",
    processLaunchClaim: launchClaim,
    processOwnerDisposition: ownerDisposition,
    leaseId,
    targetMarkerUrl,
    tabUrl: url,
    logger,
    ...(options.persistRuntime
      ? {
          persistRuntime: async (nextRuntime) => {
            await options.persistRuntime?.(nextRuntime);
            return nextRuntime;
          },
          persistSettlementResult: async (nextRuntime) => options.persistRuntime?.(nextRuntime),
        }
      : {}),
  });
  const settle: RecoveredConversationCleanup = (mode, pendingRuntime) =>
    resources.settle(mode, pendingRuntime);

  const openRecoveredTarget = async (
    endpoint: RecoveryEndpoint,
    endpointAuthority?: RetainedChromeEndpointAuthority,
    nonOwned = false,
  ): Promise<string> => {
    if (!endpointAuthority && !nonOwned) {
      throw new Error("Owned recovered target acquisition requires exact endpoint authority.");
    }
    const opened = await resources.journalAcquisition({
      resource: "chrome-target",
      acquire: async () => {
        let client: ChromeClient;
        let targetId: string;
        let closeAuthority: Parameters<typeof closeChromeTargetWithExactAuthority>[0]["authority"];
        let releaseCloseAuthority: (() => Promise<void>) | undefined;
        let browserWSEndpoint = endpointAuthority?.browserWSEndpoint;
        if (endpointAuthority) {
          const connection = await connectWithNewTabWithExactAuthority(
            endpointAuthority,
            logger,
            targetMarkerUrl,
            { retries: 6 },
          );
          if (!connection.targetId) {
            await connection.client.close().catch(() => undefined);
            throw new Error("Recovered Chrome target is missing an id.");
          }
          client = connection.client;
          targetId = connection.targetId;
          closeAuthority = endpointAuthority;
        } else {
          const connection = await connectWithNewTabWithRetainedLiveAuthority(
            endpoint.port,
            logger,
            targetMarkerUrl,
            endpoint.host,
            { retries: 6 },
          );
          if (!connection.targetId || !connection.targetCloseAuthority) {
            await connection.close().catch(() => undefined);
            throw new Error("Recovered Chrome target has no retained exact live close authority.");
          }
          client = connection.client;
          targetId = connection.targetId;
          closeAuthority = connection.targetCloseAuthority;
          releaseCloseAuthority = connection.close;
          browserWSEndpoint = connection.browserWSEndpoint;
        }
        const capability = retainChromeTargetCloseCapability({
          generationId,
          targetId,
          browserWSEndpoint,
          close: (closeLogger) =>
            closeChromeTargetWithExactAuthority({
              authority: closeAuthority,
              targetId,
              logger: closeLogger,
            }),
          ...(releaseCloseAuthority ? { release: releaseCloseAuthority } : {}),
        });
        return { client, targetId, capability, browserWSEndpoint };
      },
      authority: (connection) => ({
        targetId: connection.targetId,
        chromeHost: endpoint.host,
        chromePort: endpoint.port,
        ...(connection.browserWSEndpoint
          ? { browserWSEndpoint: connection.browserWSEndpoint }
          : {}),
        capability: connection.capability,
      }),
    });
    try {
      const Page = opened.client.Page;
      await Page.enable();
      await Page.navigate({ url });
      await resources.persistProjection({
        keepBrowser: config.keepBrowser,
        closeOwnedTargetOnComplete: true,
        tabUrl: url,
      });
    } finally {
      await opened.client.close().catch(() => undefined);
    }
    return opened.targetId;
  };

  try {
    const lease = await resources.journalAcquisition({
      resource: "tab-lease",
      acquire: () =>
        acquireBrowserTabLease(userDataDir, {
          maxConcurrentTabs: config.maxConcurrentTabs,
          timeoutMs: config.timeoutMs,
          logger,
          sessionId: meta.id,
          leaseId,
        }),
      authority: (acquiredLease) => acquiredLease,
    });

    if (options.existingEndpoint) {
      try {
        logger(
          `[browser] Recovery: opening saved conversation in existing Chrome at ` +
            `${options.existingEndpoint.host}:${options.existingEndpoint.port}`,
        );
        const targetId = await openRecoveredTarget(options.existingEndpoint, undefined, true);
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
          cleanup: settle,
        };
      } catch (error) {
        try {
          await resources.closeTargetForRetry();
        } catch {
          throw error;
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
    const owner = await resources.journalAcquisition({
      resource: "chrome-process",
      acquire: () =>
        acquireManualChromeOwner(userDataDir, config, logger, meta.id, { launchClaim }),
      authority: (acquiredOwner) => ({ kind: "manual", owner: acquiredOwner }),
    });
    const host = owner.chrome.host ?? "127.0.0.1";
    const port = owner.chrome.port;
    const endpointAuthority = owner.endpointAuthority ?? owner.chrome.endpointAuthority;
    if (!endpointAuthority) {
      throw new Error("Recovered Chrome owner has no retained exact endpoint authority.");
    }
    const targetId = await openRecoveredTarget({ host, port }, endpointAuthority);
    if (waitForReady) {
      await waitForRecoveredConversationReady(
        { host, port, endpointAuthority },
        targetId,
        readyTimeoutMs,
        locator,
      );
    }
    await lease.update({
      chromeHost: host,
      chromePort: port,
      chromeTargetId: targetId,
      tabUrl: url,
    });
    logger(`[browser] Recovery: Chrome listening on ${host}:${port}; tab loaded.`);
    return { host, port, url, ref: targetId, locator, endpointAuthority, cleanup: settle };
  } catch (error) {
    const cleanup = await resources.settle("abort");
    if (cleanup.status === "pending") {
      throw new BrowserAutomationError(
        `Recovered browser cleanup remains pending: ${cleanup.error}`,
        { stage: "recovered-conversation-cleanup", runtime: cleanup.runtime },
        error,
      );
    }
    throw error;
  }
}
