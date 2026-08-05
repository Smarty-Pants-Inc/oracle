import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir } from "node:fs/promises";
import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import type { BrowserRecoveryTargetCloseCapabilityMetadata } from "../sessionManager.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  waitForAssistantResponse,
  captureAssistantMarkdown,
  navigateToChatGPT,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
  waitForResumedConversationHydration,
  verifyCommittedPromptTurn,
} from "./pageActions.js";
import type { BrowserLogger } from "./types.js";
import {
  launchChrome,
  positionChromeWindowOffscreen,
  connectToChromeTargetWithExactAuthority,
  closeChromeTargetWithExactAuthority,
  requireExactChromeEndpointOperation,
  type RemoteChromeConnection,
  type RetainedChromeEndpointAuthority,
} from "./chromeLifecycle.js";
import { acquireManualChromeOwner } from "./manualChromeOwner.js";
import { resolveBrowserConfig } from "./config.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import { CHATGPT_URL } from "./constants.js";
import { captureProfileDirectoryIdentity, createChromeProcessLaunchClaim } from "./profileState.js";
import { acquireBrowserTabLease } from "./tabLeaseRegistry.js";
import {
  extractConversationIdFromUrl,
  buildConversationUrl,
  openConversationFromSidebarWithRetry,
  waitForLocationChange,
} from "./reattachHelpers.js";
import { waitForDeepResearchCompletion } from "./actions/deepResearch.js";
import {
  requiresCleanupOnlyCommittedPromptRecovery,
  resolveCommittedPromptEpochLocator,
  type CommittedPromptEpochLocator,
} from "./reattachability.js";
import type { ReattachCapture, ReattachDeps } from "./reattachContracts.js";
import { ReattachFallbackAuthority } from "./reattachFallbackAuthority.js";
import { extractRecoverableConversationId } from "./reattachTargetSelection.js";
import {
  closeChromeTargetWithRetainedCapability,
  retainChromeTargetCloseCapability,
} from "./targetCloseAuthority.js";

export function buildCommittedConversationUrl(
  runtime: Pick<BrowserRuntimeMetadata, "tabUrl" | "conversationId">,
  baseUrl: string,
  conversationId: string,
): string | null {
  if (extractRecoverableConversationId(runtime.tabUrl) === conversationId) {
    return runtime.tabUrl ?? null;
  }
  const configuredUrl = buildConversationUrl({ conversationId }, baseUrl);
  if (extractRecoverableConversationId(configuredUrl) === conversationId) return configuredUrl;
  const canonicalUrl = buildConversationUrl({ conversationId }, CHATGPT_URL);
  return extractRecoverableConversationId(canonicalUrl) === conversationId ? canonicalUrl : null;
}

export function requireCommittedPromptEpochLocator(
  runtime: BrowserRuntimeMetadata,
): CommittedPromptEpochLocator {
  if (requiresCleanupOnlyCommittedPromptRecovery(runtime)) {
    throw new BrowserAutomationError(
      "Browser answer reattach is unavailable because the remaining follow-up prompt queue was not durably persisted; exact abort cleanup is required.",
      {
        stage: "prompt-epoch",
        code: "committed-prompt-identity-mismatch",
        reattachClassification: "cleanup-only-abort",
        remainingFollowUps: runtime.promptEpoch?.remainingFollowUps,
        runtime,
      },
    );
  }
  const locator = resolveCommittedPromptEpochLocator(runtime);
  if (!locator) {
    throw new BrowserAutomationError(
      "Browser reattach requires a structurally valid committed prompt epoch.",
      { stage: "prompt-epoch", code: "committed-prompt-identity-mismatch" },
    );
  }
  return locator;
}

export function assertSameCommittedPromptEpoch(
  expected: CommittedPromptEpochLocator,
  actual: CommittedPromptEpochLocator,
): void {
  if (
    expected.epoch.epochId !== actual.epoch.epochId ||
    expected.promptSha256 !== actual.promptSha256 ||
    expected.conversationId !== actual.conversationId ||
    expected.verifiedUserTurnIndex !== actual.verifiedUserTurnIndex ||
    expected.verifiedUserTurnId !== actual.verifiedUserTurnId ||
    expected.verifiedUserMessageId !== actual.verifiedUserMessageId ||
    expected.epoch.baselineTurns !== actual.epoch.baselineTurns ||
    expected.epoch.followUpOrdinal !== actual.epoch.followUpOrdinal ||
    expected.epoch.remainingFollowUps !== actual.epoch.remainingFollowUps
  ) {
    throw new BrowserAutomationError(
      "Recovered browser runtime does not match the committed prompt epoch.",
      { stage: "prompt-epoch", code: "committed-prompt-identity-mismatch" },
    );
  }
}

export async function createOwnedRecoveryTargetConnection(
  endpointAuthority: RetainedChromeEndpointAuthority,
  generationId: string,
  logger: BrowserLogger,
  deps: ReattachDeps,
  targetMarkerUrl?: string,
  onTargetAcquired?: (
    targetId: string,
    capability: BrowserRecoveryTargetCloseCapabilityMetadata,
  ) => void | Promise<void>,
  onTargetCleaned?: (targetId: string) => void | Promise<void>,
): Promise<RemoteChromeConnection> {
  let connection: RemoteChromeConnection | null = null;
  let targetId: string | null = null;
  let targetCloseCapability: BrowserRecoveryTargetCloseCapabilityMetadata | null = null;
  try {
    const result = await (
      deps.connectRecoveryTargetWithExactAuthority ?? connectToChromeTargetWithExactAuthority
    )({
      authority: endpointAuthority,
      targetUrl: targetMarkerUrl,
      closeTargetOnDispose: false,
    });
    connection = requireExactChromeEndpointOperation(
      result,
      "Unable to acquire a dedicated recovery target through exact Chrome endpoint authority",
    );
    targetId = connection.targetId;
    if (connection.ownership !== "created") {
      throw new Error(`Recovery target ${targetId} was not created by this recovery acquisition.`);
    }
    targetCloseCapability = retainChromeTargetCloseCapability({
      generationId,
      targetId,
      close: (closeLogger) =>
        (
          deps.recoveryCleanup?.closeChromeTargetWithExactAuthority ??
          closeChromeTargetWithExactAuthority
        )({
          authority: endpointAuthority,
          targetId: targetId as string,
          logger: closeLogger,
        }),
    });
    await onTargetAcquired?.(targetId, targetCloseCapability);
    return connection;
  } catch (error) {
    await connection?.close().catch(() => undefined);
    if (!targetId) throw error;

    let cleanupError: string | null = null;
    try {
      const closed = targetCloseCapability
        ? await (
            deps.recoveryCleanup?.closeChromeTargetWithRetainedCapability ??
            closeChromeTargetWithRetainedCapability
          )({ capability: targetCloseCapability, targetId, logger })
        : await (
            deps.recoveryCleanup?.closeChromeTargetWithExactAuthority ??
            closeChromeTargetWithExactAuthority
          )({ authority: endpointAuthority, targetId, logger });
      if (closed.status === "unsafe" || closed.status === "unavailable") {
        cleanupError = closed.reason;
      } else {
        await onTargetCleaned?.(targetId);
      }
    } catch (closeError) {
      cleanupError = closeError instanceof Error ? closeError.message : String(closeError);
    }
    if (cleanupError) {
      const original = error instanceof Error ? error.message : String(error);
      throw new BrowserAutomationError(
        `${original} Created recovery target cleanup remains pending: ${cleanupError}`,
        {
          stage: "browser-recovery-target",
          code: "created-target-cleanup-pending",
        },
        error,
      );
    }
    throw error;
  }
}

export async function resumeBrowserSessionViaNewChrome(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<ReattachCapture> {
  const resolved = resolveBrowserConfig(config ?? {});
  const promptLocator = requireCommittedPromptEpochLocator(runtime);
  const promptEpoch = promptLocator.epoch;
  const minTurnIndex = promptLocator.verifiedUserTurnIndex + 1;
  const manualLogin = Boolean(resolved.manualLogin);
  const userDataDir = manualLogin
    ? (resolved.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile"))
    : await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
  if (manualLogin) await mkdir(userDataDir, { recursive: true });
  const fallbackProfileIdentity = await captureProfileDirectoryIdentity(userDataDir);

  const acquisitionGenerationId = randomUUID();
  const acquisitionLaunchClaim = createChromeProcessLaunchClaim(acquisitionGenerationId);
  const acquisitionOwnerDisposition = resolved.keepBrowser ? "preserve" : "close-on-last-lease";
  const fallbackLeaseId = randomUUID();
  const fallbackTargetMarkerUrl = `about:blank#oracle-acquisition=${acquisitionGenerationId}`;
  const fallbackAuthority = new ReattachFallbackAuthority({
    baseRuntime: runtime,
    userDataDir,
    profileIdentity: fallbackProfileIdentity,
    manualLogin,
    keepBrowser: Boolean(resolved.keepBrowser),
    generationId: acquisitionGenerationId,
    launchClaim: acquisitionLaunchClaim,
    ownerDisposition: acquisitionOwnerDisposition,
    leaseId: fallbackLeaseId,
    targetMarkerUrl: fallbackTargetMarkerUrl,
    logger,
    runtimeHintCb: deps.runtimeHintCb,
    recoveryCleanup: deps.recoveryCleanup,
  });

  await fallbackAuthority.persist(manualLogin ? "tab-lease" : "chrome-process");
  try {
    if (manualLogin) {
      const lease = await (deps.acquireBrowserTabLease ?? acquireBrowserTabLease)(userDataDir, {
        maxConcurrentTabs: resolved.maxConcurrentTabs,
        timeoutMs: resolved.timeoutMs,
        logger,
        sessionId: `reattach-${process.pid}`,
        leaseId: fallbackLeaseId,
      });
      fallbackAuthority.setLease(lease);
      await fallbackAuthority.persist("chrome-process");
    }
    if (manualLogin) {
      const owner = await (deps.acquireManualChromeOwner ?? acquireManualChromeOwner)(
        userDataDir,
        resolved,
        logger,
        `reattach-${process.pid}`,
        { launchClaim: acquisitionLaunchClaim },
      );
      fallbackAuthority.setManualChromeOwner(owner);
    } else {
      const launchedChrome = await (deps.launchChrome ?? launchChrome)(
        resolved,
        userDataDir,
        logger,
        { launchClaim: acquisitionLaunchClaim },
      );
      fallbackAuthority.setLaunchedChrome(launchedChrome);
    }
    const chrome = fallbackAuthority.acquiredChrome();
    await fallbackAuthority.persist("chrome-target");
    const chromeHost = chrome.host ?? "127.0.0.1";
    const recoveryEndpointAuthority = fallbackAuthority.endpointAuthority();
    if (!recoveryEndpointAuthority) {
      throw new Error("Local recovery Chrome has no retained exact endpoint authority.");
    }
    const recoveryConnection = await createOwnedRecoveryTargetConnection(
      recoveryEndpointAuthority,
      acquisitionGenerationId,
      logger,
      deps,
      fallbackTargetMarkerUrl,
      (targetId, capability) => fallbackAuthority.recordOwnedTarget(targetId, capability),
      (targetId) => fallbackAuthority.clearOwnedTarget(targetId),
    );
    const recoveryTargetId = recoveryConnection.targetId;
    const client = fallbackAuthority.attachConnection(recoveryConnection);
    await fallbackAuthority.lease()?.update({
      chromeHost,
      chromePort: chrome.port,
      chromeTargetId: recoveryTargetId,
    });
    const { Network, Page, Runtime, DOM, Target } = client;

    if (Runtime?.enable) await Runtime.enable();
    if (DOM && typeof DOM.enable === "function") await DOM.enable();
    if (!resolved.headless && resolved.hideWindow) {
      await positionChromeWindowOffscreen(client, logger);
    }
    let appliedCookies = 0;
    if (!manualLogin && resolved.cookieSync) {
      appliedCookies = await syncCookies(Network, resolved.url, resolved.chromeProfile, logger, {
        allowErrors: resolved.allowCookieErrors,
        filterNames: resolved.cookieNames ?? undefined,
        inlineCookies: resolved.inlineCookies ?? undefined,
        cookiePath: resolved.chromeCookiePath ?? undefined,
        waitMs: resolved.cookieSyncWaitMs ?? 0,
      });
    }

    await clearStaleChatGptConversationCookies(Network, Target, logger, {
      preserveConversationIds: [
        promptEpoch.conversationId,
        extractConversationIdFromUrl(resolved.url),
      ],
    });

    await navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger);
    await ensureNotBlocked(Runtime, resolved.headless, logger);
    await ensureLoggedIn(Runtime, logger, { appliedCookies });
    if (resolved.url !== CHATGPT_URL) {
      await navigateToChatGPT(Page, Runtime, resolved.url, logger);
      await ensureNotBlocked(Runtime, resolved.headless, logger);
    }
    await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);

    const conversationUrl = buildCommittedConversationUrl(
      runtime,
      resolved.url,
      promptEpoch.conversationId,
    );
    if (conversationUrl) {
      logger(`Reopening conversation at ${conversationUrl}`);
      await navigateToChatGPT(Page, Runtime, conversationUrl, logger);
      await ensureNotBlocked(Runtime, resolved.headless, logger);
      await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);
    } else {
      const opened = await openConversationFromSidebarWithRetry(
        Runtime,
        {
          conversationId: promptEpoch.conversationId,
          preferProjects:
            resolved.url !== CHATGPT_URL ||
            Boolean(
              runtime.tabUrl &&
              (/\/g\//.test(runtime.tabUrl) || runtime.tabUrl.includes("/project")),
            ),
        },
        15_000,
      );
      if (!opened) throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
      await waitForLocationChange(Runtime, 15_000);
    }

    const waitForHydration =
      deps.waitForConversationHydration ?? waitForResumedConversationHydration;
    await waitForHydration(Runtime, resolved.inputTimeoutMs, logger, {
      requirePriorTurns: true,
      requirePromptReady: false,
      expectedConversationUrl: conversationUrl ?? undefined,
    });
    const verifyPromptTurn = deps.verifyCommittedPromptTurn ?? verifyCommittedPromptTurn;
    await verifyPromptTurn(Runtime, promptLocator);
    const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
    const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
    const timeoutMs = resolved.timeoutMs ?? 120_000;

    let answerText: string;
    let answerMarkdown: string;
    if (resolved.researchMode === "deep") {
      const waitForDeepResearch =
        deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
      const researchResult = await waitForDeepResearch(
        Runtime,
        logger,
        timeoutMs,
        minTurnIndex,
        Page,
        client,
        {
          requireScopedTargetOwner: true,
          expectedConversationId: promptLocator.conversationId,
          expectedPromptTurn: promptLocator,
        },
      );
      answerText = researchResult.text;
      answerMarkdown = researchResult.text;
    } else {
      const answer = await waitForResponse(
        Runtime,
        timeoutMs,
        logger,
        minTurnIndex,
        promptLocator.conversationId,
        promptLocator,
      );
      const markdown =
        (await captureMarkdown(
          Runtime,
          answer.meta,
          logger,
          promptLocator.conversationId,
          promptLocator,
        )) ?? answer.text;
      answerText = answer.text;
      answerMarkdown = markdown;
    }

    await fallbackAuthority.disconnectConnection();
    const captureRuntime = fallbackAuthority.runtime();
    return {
      answerText,
      answerMarkdown,
      runtime: captureRuntime,
      finalizeResources: () => fallbackAuthority.settle("finalize"),
      abortResources: () => fallbackAuthority.settle("abort"),
    };
  } catch (error) {
    const cleanupResult = await fallbackAuthority.settle("abort");
    try {
      await deps.runtimeHintCb?.(cleanupResult.runtime);
    } catch (persistenceError) {
      const persistenceMessage =
        persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
      throw new BrowserAutomationError(
        `Browser fallback recovery failed; exact abort cleanup authority could not be persisted: ${persistenceMessage}`,
        {
          stage: "browser-reattach-fallback-cleanup",
          code: "fallback-cleanup-runtime-persistence-failed",
          runtime: cleanupResult.runtime,
          cleanupStatus: cleanupResult.status,
          ...(cleanupResult.status === "pending" ? { cleanupError: cleanupResult.error } : {}),
        },
        error,
      );
    }
    if (cleanupResult.status === "pending") {
      throw new BrowserAutomationError(
        `Browser fallback recovery failed and cleanup remains pending: ${cleanupResult.error}`,
        {
          stage: "browser-reattach-fallback-cleanup",
          code: "fallback-cleanup-pending",
          runtime: cleanupResult.runtime,
        },
        error,
      );
    }
    throw error;
  }
}
