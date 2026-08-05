import { randomUUID } from "node:crypto";
import {
  acquireManualChromeOwner,
  releaseManualChromeOwnerEndpointAuthority,
  settleManualChromeOwner,
  type ManualChromeOwner,
} from "./manualChromeOwner.js";
import type {
  BrowserRecoveryCleanupResourceMetadata,
  BrowserRuntimeMetadata,
} from "../sessionManager.js";
import type { SessionMetadata } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserCaptureFinalizationResult, BrowserLogger } from "./types.js";
import { isAnswerNowPlaceholderText } from "./actions/assistantResponse.js";
import { promptIdentitySha256 } from "./actions/promptComposer.js";
import { closeChromeTarget, connectWithNewTab } from "./chromeLifecycle.js";
import { resolveBrowserConfig } from "./config.js";
import { CHATGPT_URL } from "./constants.js";
import {
  acquireBrowserTabLease,
  retainBrowserTabLeaseTeardownAuthority,
  type BrowserTabLease,
  type BrowserTabLeaseTeardownAuthority,
} from "./tabLeaseRegistry.js";
import { captureProfileDirectoryIdentity } from "./profileState.js";
import {
  OwnedBrowserResourceTransaction,
  completedBrowserCaptureCleanup,
  pendingBrowserCaptureCleanup,
  projectBrowserCaptureCleanupRuntime,
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
  cleanup: RecoveredConversationCleanup;
}

export interface RecoveryEndpoint {
  host: string;
  port: number;
}

type RecoveryTarget = RecoveryEndpoint & { targetId: string };

function recoveryTargetFromRuntime(runtime: BrowserRuntimeMetadata): RecoveryTarget | null {
  const resource = runtime.recoveryCleanupResources?.[0];
  const host = resource?.chromeHost;
  const port = resource?.chromePort;
  const targetId = resource?.chromeTargetId;
  if (
    typeof host !== "string" ||
    host.trim().length === 0 ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port <= 0 ||
    typeof targetId !== "string" ||
    targetId.trim().length === 0
  ) {
    return null;
  }
  return { host, port, targetId };
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
  const leaseId = randomUUID();
  const targetMarkerUrl = `about:blank#oracle-recovery=${generationId}`;
  let profileDirectory = await captureProfileDirectoryIdentity(userDataDir);
  let lease: BrowserTabLease | null = null;
  let owner: ManualChromeOwner | null = null;
  let teardownAuthority: BrowserTabLeaseTeardownAuthority | null = null;
  let target: { host: string; port: number; targetId: string } | null = null;
  let targetUrl: string | undefined;
  let targetClosed = false;
  let leaseReleased = false;
  let ownerSettled = false;

  const runtime = (
    pendingResource?: "tab-lease" | "chrome-process" | "chrome-target",
  ): BrowserRuntimeMetadata => {
    const chrome = owner?.chrome;
    const targetCleanupPending = Boolean(
      (target && !targetClosed) || pendingResource === "chrome-target",
    );
    const cleanupPending = Boolean(
      pendingResource || targetCleanupPending || !leaseReleased || (owner && !ownerSettled),
    );
    const base: BrowserRuntimeMetadata = {
      ...(meta.browser?.runtime ?? {}),
      browserTransport: "cdp",
      chromePid: chrome?.pid,
      chromeProcessIdentity: owner?.processIdentity,
      chromePort: target?.port ?? chrome?.port,
      chromeHost: target?.host ?? chrome?.host ?? "127.0.0.1",
      chromeProfileRoot: userDataDir,
      userDataDir,
      chromeTargetId: targetCleanupPending ? (target?.targetId ?? undefined) : undefined,
      tabUrl: targetUrl ?? url,
      conversationId: locator.conversationId,
      promptEpoch: locator.epoch,
      controllerPid: process.pid,
    };
    if (!cleanupPending) {
      delete base.recoveryCleanupResources;
      delete base.recoveryCleanupResult;
      return base;
    }
    const resource: BrowserRecoveryCleanupResourceMetadata = {
      chromePid: chrome?.pid,
      chromeProcessIdentity: owner?.processIdentity,
      profileDirectoryIdentity: owner?.processIdentity.profileDirectory ?? profileDirectory,
      chromePort: target?.port ?? chrome?.port,
      chromeHost: target?.host ?? chrome?.host ?? "127.0.0.1",
      chromeProfileRoot: userDataDir,
      userDataDir,
      chromeTargetId: targetCleanupPending ? (target?.targetId ?? undefined) : undefined,
      conversationId: locator.conversationId,
      promptEpoch: locator.epoch,
      tabLease: !leaseReleased
        ? {
            id: lease?.id ?? leaseId,
            profileDirectory: lease?.profileDirectory ?? profileDirectory,
          }
        : undefined,
      acquisition: {
        generationId,
        processOwnerProvenance: "manual-canonical-owner",
        ...(pendingResource ? { pendingResource } : {}),
        targetMarkerUrl,
      },
      recoveryCleanup: {
        ownsTarget: targetCleanupPending,
        profileKind: "manual-login",
        keepBrowser: owner ? owner.disposition === "preserve" : true,
        closeOwnedTargetOnComplete: targetCleanupPending,
      },
    };
    return {
      ...base,
      recoveryCleanupResources: [resource],
      recoveryCleanupResult: { status: "pending" },
    };
  };

  const settleResources = async (
    mode: BrowserCaptureSettlementMode,
    pendingRuntime: BrowserRuntimeMetadata,
  ): Promise<BrowserCaptureFinalizationResult> => {
    const errors: string[] = [];
    const cleanup = pendingRuntime.recoveryCleanupResources?.[0]?.recoveryCleanup;
    if (
      mode === "finalize" &&
      cleanup?.ownsTarget === true &&
      typeof cleanup.closeOwnedTargetOnComplete !== "boolean"
    ) {
      return pendingBrowserCaptureCleanup(
        pendingRuntime,
        "Recovered target finalize disposition is missing",
        mode,
      );
    }
    if (target && !targetClosed && cleanup?.ownsTarget === true) {
      try {
        const closed = await closeChromeTarget({ ...target, logger });
        if (!closed) errors.push(`Recovered target close was not confirmed: ${target.targetId}`);
        else targetClosed = true;
      } catch (error) {
        errors.push(
          `Recovered target close failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (
      errors.length === 0 &&
      lease &&
      (!leaseReleased || Boolean(teardownAuthority && owner && !ownerSettled))
    ) {
      if (teardownAuthority && owner) {
        let ownerError: string | null = null;
        const ownerForSettlement = owner;
        const outcome = await teardownAuthority.settle(async () => {
          const settlement = await settleManualChromeOwner(userDataDir, ownerForSettlement, logger);
          if (settlement.status === "unsafe") {
            ownerError = settlement.reason;
            return false;
          }
          ownerSettled = true;
          return true;
        });
        leaseReleased = teardownAuthority.leaseReleased;
        if (outcome.status === "preserved") {
          errors.push(ownerError ?? outcome.error ?? outcome.reason);
        } else if (outcome.disposition === "active-lease-handoff") {
          ownerSettled = true;
        }
      } else {
        try {
          await lease.release();
          leaseReleased = true;
        } catch (error) {
          errors.push(
            `Recovered browser lease release failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (leaseReleased && owner && !ownerSettled) {
          const settlement = await settleManualChromeOwner(userDataDir, owner, logger);
          if (settlement.status === "unsafe") errors.push(settlement.reason);
          else ownerSettled = true;
        }
      }
    }
    if (errors.length === 0 && !teardownAuthority && leaseReleased && owner && !ownerSettled) {
      const settlement = await settleManualChromeOwner(userDataDir, owner, logger);
      if (settlement.status === "unsafe") errors.push(settlement.reason);
      else ownerSettled = true;
    }
    const resourceRuntime = runtime();
    return errors.length > 0
      ? pendingBrowserCaptureCleanup(resourceRuntime, [...new Set(errors)].join("; "), mode)
      : completedBrowserCaptureCleanup(resourceRuntime);
  };

  const resources = new OwnedBrowserResourceTransaction(
    {
      ...(options.persistRuntime
        ? {
            persistRuntime: async (nextRuntime) => options.persistRuntime?.(nextRuntime),
            persistSettlementResult: async (nextRuntime) => options.persistRuntime?.(nextRuntime),
          }
        : {}),
      settleResources,
    },
    runtime(),
  );

  const settle: RecoveredConversationCleanup = async (mode, pendingRuntime) => {
    const currentRuntime = resources.runtime();
    if (
      pendingRuntime &&
      currentRuntime.recoveryCleanupResources?.length &&
      !currentRuntime.recoveryCleanupResult?.settlementMode
    ) {
      resources.replaceRuntime(projectBrowserCaptureCleanupRuntime(pendingRuntime, runtime()));
    }
    return resources.settle(mode);
  };

  const openRecoveredTarget = async (endpoint: RecoveryEndpoint): Promise<string> => {
    const opened = await resources.journalAcquisition({
      intentRuntime: runtime("chrome-target"),
      acquire: async () => {
        const connection = await connectWithNewTab(
          endpoint.port,
          logger,
          targetMarkerUrl,
          endpoint.host,
          { fallbackToDefault: false, retries: 6 },
        );
        if (!connection.targetId) throw new Error("Recovered Chrome target is missing an id.");
        return { client: connection.client, targetId: connection.targetId };
      },
      acquiredRuntime: (connection) => {
        target = { ...endpoint, targetId: connection.targetId };
        targetClosed = false;
        targetUrl = targetMarkerUrl;
        return runtime();
      },
    });
    try {
      const Page = opened.client.Page;
      await Page.enable();
      await Page.navigate({ url });
      targetUrl = url;
      await resources.persist(runtime());
    } finally {
      await opened.client.close().catch(() => undefined);
    }
    return opened.targetId;
  };

  try {
    lease = await resources.journalAcquisition({
      intentRuntime: runtime("tab-lease"),
      acquire: () =>
        acquireBrowserTabLease(userDataDir, {
          maxConcurrentTabs: config.maxConcurrentTabs,
          timeoutMs: config.timeoutMs,
          logger,
          sessionId: meta.id,
          leaseId,
        }),
      acquiredRuntime: (acquiredLease) => {
        lease = acquiredLease;
        profileDirectory = acquiredLease.profileDirectory;
        return runtime();
      },
    });

    if (options.existingEndpoint) {
      try {
        logger(
          `[browser] Recovery: opening saved conversation in existing Chrome at ` +
            `${options.existingEndpoint.host}:${options.existingEndpoint.port}`,
        );
        const targetId = await openRecoveredTarget(options.existingEndpoint);
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
        const failedTarget = recoveryTargetFromRuntime(resources.runtime());
        if (failedTarget && !targetClosed) {
          const closed = await closeChromeTarget({ ...failedTarget, logger }).catch(() => false);
          if (!closed) throw error;
          targetClosed = true;
          target = null;
          await resources.persist(runtime());
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
    owner = await resources.journalAcquisition({
      intentRuntime: runtime("chrome-process"),
      acquire: () => acquireManualChromeOwner(userDataDir, config, logger, meta.id),
      acquiredRuntime: (acquiredOwner) => {
        owner = acquiredOwner;
        return runtime();
      },
    });
    if (owner.disposition === "close-on-last-lease") {
      const ownerForHandoff = owner;
      teardownAuthority = retainBrowserTabLeaseTeardownAuthority(userDataDir, lease, {
        logger,
        onActiveLeaseHandoff: () => releaseManualChromeOwnerEndpointAuthority(ownerForHandoff),
      });
    }
    const host = owner.chrome.host ?? "127.0.0.1";
    const port = owner.chrome.port;
    const targetId = await openRecoveredTarget({ host, port });
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
    return { host, port, url, ref: targetId, locator, cleanup: settle };
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
