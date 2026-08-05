import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir } from "node:fs/promises";
import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import type { BrowserRecoveryCleanupResourceMetadata } from "../sessionManager.js";
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
import type { BrowserLogger, ChromeClient } from "./types.js";
import {
  launchChrome,
  createChromePageTarget,
  positionChromeWindowOffscreen,
  connectToRemoteChromeTarget,
  closeChromeTarget,
  retainChromeEndpointAuthority,
  type RemoteChromeConnection,
  type RetainedChromeEndpointAuthority,
} from "./chromeLifecycle.js";
import {
  acquireManualChromeOwner,
  releaseManualChromeOwnerEndpointAuthority,
  type BrowserChrome,
  type ManualChromeOwner,
} from "./manualChromeOwner.js";
import { resolveBrowserConfig } from "./config.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import { CHATGPT_URL } from "./constants.js";
import {
  captureProfileDirectoryIdentity,
  createChromeProcessLaunchClaim,
  inspectChromeProcessIdentity,
  sameChromeProcessIdentity,
  verifyProfileDirectoryIdentity,
} from "./profileState.js";
import { acquireBrowserTabLease, type BrowserTabLease } from "./tabLeaseRegistry.js";
import { readDevToolsActivePortInfo } from "./detect.js";
import {
  extractConversationIdFromUrl,
  buildConversationUrl,
  openConversationFromSidebarWithRetry,
  waitForLocationChange,
  type TargetInfoLite,
} from "./reattachHelpers.js";
import { waitForDeepResearchCompletion } from "./actions/deepResearch.js";
import {
  isRecoverableChatGptConversationUrl,
  resolveCommittedPromptEpochLocator,
  type CommittedPromptEpochLocator,
} from "./reattachability.js";
import {
  finalizeRecoveredRuntime,
  pendingFinalization,
  type ReattachCleanupDeps,
  type ReattachFinalizationResult,
} from "./reattachCleanup.js";
import type { ReattachCapture, ReattachDeps } from "./reattach.js";

type ExplicitTargetSelectionFailure = "missing" | "ambiguous" | "mismatched" | "unsupported";

export type TargetSelection =
  | { status: "selected"; target: TargetInfoLite }
  | { status: ExplicitTargetSelectionFailure };
interface RefreshAttachRuntimeDeps {
  readActivePort?: typeof readDevToolsActivePortInfo;
  inspectProcessIdentity?: typeof inspectChromeProcessIdentity;
  retainEndpointAuthority?: (options: {
    host: string;
    port: number;
    browserWSEndpoint?: string;
    userDataDir: string;
    processIdentity: NonNullable<BrowserRuntimeMetadata["chromeProcessIdentity"]>;
  }) => Promise<RetainedChromeEndpointAuthority>;
}

export async function refreshAttachRuntime(
  runtime: BrowserRuntimeMetadata,
  deps: RefreshAttachRuntimeDeps = {},
): Promise<BrowserRuntimeMetadata | null> {
  const recordedEndpoint = runtime.chromeBrowserWSEndpoint
    ? new URL(runtime.chromeBrowserWSEndpoint)
    : null;
  const host = runtime.chromeHost ?? recordedEndpoint?.hostname ?? "127.0.0.1";
  const normalizedHost = host.toLowerCase();
  const localHost =
    normalizedHost === "localhost" ||
    normalizedHost === "localhost." ||
    normalizedHost.startsWith("127.") ||
    normalizedHost === "::1" ||
    normalizedHost === "[::1]";
  const profileRoot = runtime.chromeProfileRoot ?? runtime.userDataDir;
  if (!profileRoot) {
    if (localHost) {
      throw new Error("Recorded local Chrome endpoint has no physical profile authority");
    }
    return runtime;
  }

  const processIdentity = runtime.chromeProcessIdentity;
  if (!processIdentity) {
    throw new Error("Recorded local Chrome endpoint has no exact process identity");
  }
  const inspection = await (deps.inspectProcessIdentity ?? inspectChromeProcessIdentity)(
    profileRoot,
    processIdentity,
  );
  if (inspection === "exited") return null;
  if (inspection !== "current") {
    throw new Error("Recorded local Chrome process generation could not be authenticated");
  }

  const activePort = await (deps.readActivePort ?? readDevToolsActivePortInfo)(profileRoot, {
    host,
  });
  const browserWSEndpoint =
    activePort?.browserWSEndpoint ?? runtime.chromeBrowserWSEndpoint ?? undefined;
  const endpointPort = browserWSEndpoint
    ? Number.parseInt(new URL(browserWSEndpoint).port, 10)
    : undefined;
  const port = activePort?.port ?? runtime.chromePort ?? endpointPort;
  if (!port) {
    throw new Error("Recorded local Chrome endpoint has no valid DevTools port");
  }

  const authority = await (deps.retainEndpointAuthority ?? retainChromeEndpointAuthority)({
    host,
    port,
    browserWSEndpoint,
    userDataDir: profileRoot,
    processIdentity,
  });
  try {
    const recoveryCleanupResources = runtime.recoveryCleanupResources?.map((resource) => {
      if (
        resource.remoteRecovery ||
        !resource.chromeProcessIdentity ||
        !sameChromeProcessIdentity(resource.chromeProcessIdentity, processIdentity)
      ) {
        return resource;
      }
      return {
        ...resource,
        chromeHost: host,
        chromePort: port,
        chromeBrowserWSEndpoint: authority.browserWSEndpoint,
      };
    });
    return {
      ...runtime,
      chromeHost: host,
      chromePort: port,
      chromeBrowserWSEndpoint: authority.browserWSEndpoint,
      recoveryCleanupResources,
    };
  } finally {
    await authority.release();
  }
}

export function selectTarget(
  targets: TargetInfoLite[],
  runtime: Pick<BrowserRuntimeMetadata, "chromeTargetId" | "tabUrl" | "conversationId">,
  browserTabRef?: string,
): TargetSelection {
  if (!Array.isArray(targets) || targets.length === 0) return { status: "missing" };
  const conversationId =
    runtime.conversationId?.trim() || extractRecoverableConversationId(runtime.tabUrl);
  if (!conversationId) return { status: "mismatched" };
  const matchesConversation = (target: TargetInfoLite): boolean =>
    extractRecoverableConversationId(target.url) === conversationId;

  if (browserTabRef) {
    if (browserTabRef.toLowerCase() === "current") return { status: "unsupported" };

    const exactIds = targets.filter((target) => (target.targetId ?? target.id) === browserTabRef);
    if (exactIds.length > 1) return { status: "ambiguous" };
    const exactId = exactIds[0];
    if (exactId) {
      return matchesConversation(exactId)
        ? { status: "selected", target: exactId }
        : { status: "mismatched" };
    }

    const exactUrls = targets.filter((target) => target.url === browserTabRef);
    if (exactUrls.length > 1) return { status: "ambiguous" };
    const exactUrl = exactUrls[0];
    if (exactUrl) {
      return matchesConversation(exactUrl)
        ? { status: "selected", target: exactUrl }
        : { status: "mismatched" };
    }

    if (browserTabRef !== conversationId) return { status: "missing" };
    const exactConversations = targets.filter(matchesConversation);
    if (exactConversations.length > 1) return { status: "ambiguous" };
    const exactConversation = exactConversations[0];
    return exactConversation
      ? { status: "selected", target: exactConversation }
      : { status: "missing" };
  }

  if (!runtime.chromeTargetId) return { status: "missing" };
  const exactTarget = targets.find(
    (target) => (target.targetId ?? target.id) === runtime.chromeTargetId,
  );
  return exactTarget && matchesConversation(exactTarget)
    ? { status: "selected", target: exactTarget }
    : { status: "missing" };
}

export function pickTarget(
  targets: TargetInfoLite[],
  runtime: Pick<BrowserRuntimeMetadata, "chromeTargetId" | "tabUrl" | "conversationId">,
  browserTabRef?: string,
): TargetInfoLite | undefined {
  const selection = selectTarget(targets, runtime, browserTabRef);
  return selection.status === "selected" ? selection.target : undefined;
}

export function extractRecoverableConversationId(
  candidate: string | null | undefined,
): string | undefined {
  return isRecoverableChatGptConversationUrl(candidate)
    ? extractConversationIdFromUrl(candidate ?? "")
    : undefined;
}

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
  const locator = resolveCommittedPromptEpochLocator(runtime);
  if (!locator) {
    throw new BrowserAutomationError(
      "Browser reattach requires a structurally valid committed prompt epoch.",
      { stage: "prompt-epoch", code: "committed-prompt-identity-mismatch" },
    );
  }
  if (locator.epoch.remainingFollowUps > 0) {
    throw new BrowserAutomationError(
      "Browser reattach cannot complete while committed follow-up prompts remain pending.",
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
  chrome: Pick<BrowserChrome, "host" | "port">,
  logger: BrowserLogger,
  deps: ReattachDeps,
  targetMarkerUrl?: string,
  onTargetAcquired?: (targetId: string) => void | Promise<void>,
  onTargetCleaned?: (targetId: string) => void | Promise<void>,
): Promise<RemoteChromeConnection> {
  const host = chrome.host ?? "127.0.0.1";
  const createTarget = deps.createRecoveryTarget ?? createChromePageTarget;
  const targetId = await createTarget(chrome.port, logger, host, targetMarkerUrl);
  if (!targetId) {
    throw new Error("Unable to create a dedicated Chrome target for browser recovery.");
  }

  let connection: RemoteChromeConnection | null = null;
  try {
    await onTargetAcquired?.(targetId);
    connection = await (deps.connectRecoveryTarget ?? connectToRemoteChromeTarget)(
      host,
      chrome.port,
      logger,
      { targetId, closeTargetOnDispose: false },
    );
    if (connection.targetId !== targetId) {
      throw new Error(
        `Recovery target connection resolved ${connection.targetId} instead of created target ${targetId}.`,
      );
    }
    return { ...connection, targetId, ownership: "created" };
  } catch (error) {
    await connection?.close().catch(() => undefined);
    const closeTarget = deps.recoveryCleanup?.closeChromeTarget ?? closeChromeTarget;
    let cleanupError: string | null = null;
    try {
      const closed = await closeTarget({ host, port: chrome.port, targetId, logger });
      if (!closed) cleanupError = "created target close was not confirmed";
      else await onTargetCleaned?.(targetId);
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

function borrowManualOwnerEndpointAuthority(
  authority: RetainedChromeEndpointAuthority,
): RetainedChromeEndpointAuthority {
  if (!authority.runExactOperation) {
    return {
      browserWSEndpoint: authority.browserWSEndpoint,
      kill: authority.kill,
      release: async () => undefined,
    };
  }
  return {
    browserWSEndpoint: authority.browserWSEndpoint,
    kill: authority.kill,
    runExactOperation<T>(operation: (client: ChromeClient) => Promise<T>) {
      return authority.runExactOperation!(operation);
    },
    release: async () => undefined,
  };
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
  const inheritedRecoveryCleanupResources = [...(runtime.recoveryCleanupResources ?? [])];
  let manualChromeOwner: ManualChromeOwner | null = null;
  let fallbackLease: BrowserTabLease | null = null;
  let chrome: BrowserChrome | null = null;
  let retainedOwnedChrome: BrowserChrome | null = null;
  let fallbackTargetId: string | null = null;
  let fallbackRuntime: BrowserRuntimeMetadata | null = null;
  let client: ChromeClient | null = null;
  let closeFallbackConnection: (() => Promise<void>) | null = null;
  let completedFallbackCleanup: Extract<
    ReattachFinalizationResult,
    { status: "completed" }
  > | null = null;
  let manualOwnerEndpointReleased = false;
  const refreshFallbackRuntime = (
    pendingResource?: "tab-lease" | "chrome-process" | "chrome-target",
  ): BrowserRuntimeMetadata => {
    const currentEndpointAuthority =
      manualChromeOwner?.endpointAuthority ?? chrome?.endpointAuthority;
    const closesProcess = manualLogin
      ? manualChromeOwner?.disposition === "close-on-last-lease"
      : !resolved.keepBrowser;
    const ownsProcess = Boolean(chrome && closesProcess);
    const profileKind = manualLogin ? "manual-login" : "temporary";
    const ownsTarget = pendingResource === "chrome-target" || Boolean(fallbackTargetId);
    const resource: BrowserRecoveryCleanupResourceMetadata = {
      chromePid: chrome?.pid,
      chromeProcessIdentity: chrome?.processIdentity,
      profileDirectoryIdentity:
        chrome?.processIdentity?.profileDirectory ?? fallbackProfileIdentity,
      chromePort: chrome?.port,
      chromeBrowserWSEndpoint: currentEndpointAuthority?.browserWSEndpoint,
      chromeHost: chrome?.host ?? "127.0.0.1",
      chromeProfileRoot: userDataDir,
      userDataDir,
      chromeTargetId: fallbackTargetId ?? undefined,
      conversationId: promptEpoch.conversationId,
      promptEpoch,
      tabLease:
        fallbackLease || manualLogin
          ? {
              id: fallbackLease?.id ?? fallbackLeaseId,
              profileDirectory: fallbackLease?.profileDirectory ?? fallbackProfileIdentity,
            }
          : undefined,
      acquisition: {
        generationId: acquisitionGenerationId,
        processOwnerProvenance: manualLogin ? "manual-canonical-owner" : "temporary-launch",
        processLaunchClaim: acquisitionLaunchClaim,
        processOwnerDisposition: acquisitionOwnerDisposition,
        ...(pendingResource ? { pendingResource } : {}),
        targetMarkerUrl: fallbackTargetMarkerUrl,
      },
      recoveryCleanup: {
        ownsTarget,
        profileKind,
        keepBrowser:
          pendingResource === "tab-lease" ||
          (manualLogin
            ? manualChromeOwner?.disposition === "preserve"
            : chrome
              ? !ownsProcess
              : Boolean(resolved.keepBrowser)),
        closeOwnedTargetOnComplete: ownsTarget,
      },
    };
    const next: BrowserRuntimeMetadata = {
      ...runtime,
      browserTransport: "cdp",
      chromePid: chrome?.pid,
      chromeProcessIdentity: chrome?.processIdentity,
      chromePort: chrome?.port,
      chromeHost: chrome?.host ?? "127.0.0.1",
      chromeBrowserWSEndpoint: currentEndpointAuthority?.browserWSEndpoint,
      chromeProfileRoot: userDataDir,
      userDataDir,
      chromeTargetId: fallbackTargetId ?? undefined,
      recoveryCleanupResources: [...inheritedRecoveryCleanupResources, resource],
      recoveryCleanupResult: { status: "pending" },
      controllerPid: process.pid,
    };
    fallbackRuntime = next;
    return next;
  };
  const persistFallbackRuntime = async (
    pendingResource?: "tab-lease" | "chrome-process" | "chrome-target",
  ): Promise<BrowserRuntimeMetadata> => {
    const next = refreshFallbackRuntime(pendingResource);
    await deps.runtimeHintCb?.(next);
    return next;
  };
  const retainPendingEndpointReleaseRuntime = (
    completedRuntime: BrowserRuntimeMetadata,
    authorityRuntime: BrowserRuntimeMetadata,
  ): BrowserRuntimeMetadata => {
    const resource = (authorityRuntime.recoveryCleanupResources ?? [])
      .toReversed()
      .find(
        (candidate) =>
          candidate.recoveryCleanup.profileKind === "manual-login" &&
          candidate.userDataDir &&
          path.resolve(candidate.userDataDir) === path.resolve(userDataDir),
      );
    if (!resource) return authorityRuntime;
    return {
      ...completedRuntime,
      chromeTargetId: undefined,
      recoveryCleanupResources: [
        {
          ...resource,
          chromeTargetId: undefined,
          tabLease: undefined,
          recoveryCleanup: {
            ...resource.recoveryCleanup,
            ownsTarget: false,
            keepBrowser: true,
            closeOwnedTargetOnComplete: undefined,
          },
        },
      ],
      recoveryCleanupResult: { status: "pending" },
    };
  };
  const settleFallbackResources = async (
    mode: "finalize" | "abort",
  ): Promise<ReattachFinalizationResult> => {
    if (closeFallbackConnection) {
      await closeFallbackConnection().catch(() => undefined);
      closeFallbackConnection = null;
    } else {
      await client?.close().catch(() => undefined);
    }
    client = null;

    const authorityRuntime = fallbackRuntime ?? refreshFallbackRuntime();
    const retainedChrome =
      retainedOwnedChrome ??
      (manualChromeOwner?.endpointAuthority ? manualChromeOwner.chrome : null);
    const fallbackExactTerminator = deps.recoveryCleanup?.terminateExactChromeForProfile;
    const retainedEndpointAuthority =
      manualChromeOwner?.endpointAuthority ?? retainedChrome?.endpointAuthority;
    const cleanupEndpointAuthority =
      manualChromeOwner?.endpointAuthority === retainedEndpointAuthority &&
      retainedEndpointAuthority
        ? borrowManualOwnerEndpointAuthority(retainedEndpointAuthority)
        : retainedEndpointAuthority;
    const fallbackRetainEndpointAuthority =
      deps.recoveryCleanup?.retainChromeEndpointAuthority ?? retainChromeEndpointAuthority;
    const cleanupDeps: ReattachCleanupDeps = retainedChrome
      ? {
          ...deps.recoveryCleanup,
          retainChromeEndpointAuthority: cleanupEndpointAuthority
            ? async (options: Parameters<typeof retainChromeEndpointAuthority>[0]) => {
                if (
                  path.resolve(options.userDataDir) === path.resolve(userDataDir) &&
                  options.port === retainedChrome.port &&
                  options.host === (retainedChrome.host ?? "127.0.0.1") &&
                  sameChromeProcessIdentity(
                    options.processIdentity,
                    retainedChrome.processIdentity,
                  ) &&
                  (!options.browserWSEndpoint ||
                    options.browserWSEndpoint === cleanupEndpointAuthority.browserWSEndpoint)
                ) {
                  return cleanupEndpointAuthority;
                }
                return fallbackRetainEndpointAuthority(options);
              }
            : deps.recoveryCleanup?.retainChromeEndpointAuthority,
          terminateExactChromeForProfile: cleanupEndpointAuthority
            ? fallbackExactTerminator
            : async (profileDir, serializedIdentity, cleanupLogger) => {
                if (path.resolve(profileDir) !== path.resolve(userDataDir)) {
                  if (fallbackExactTerminator) {
                    return fallbackExactTerminator(profileDir, serializedIdentity, cleanupLogger);
                  }
                  return {
                    status: "unsafe",
                    pid: serializedIdentity.pid,
                    reason:
                      "No exact Chrome teardown authority matches the retained launch profile",
                  };
                }
                if (
                  retainedChrome.pid !== retainedChrome.processIdentity.pid ||
                  !sameChromeProcessIdentity(serializedIdentity, retainedChrome.processIdentity)
                ) {
                  return {
                    status: "unsafe",
                    pid: serializedIdentity.pid,
                    reason: "Serialized Chrome process identity does not match the retained launch",
                  };
                }
                if (
                  !(await verifyProfileDirectoryIdentity(
                    profileDir,
                    retainedChrome.processIdentity.profileDirectory,
                  ))
                ) {
                  return {
                    status: "unsafe",
                    pid: serializedIdentity.pid,
                    reason: "Serialized Chrome profile identity does not match the retained launch",
                  };
                }
                try {
                  return await retainedChrome.kill();
                } catch (error) {
                  return {
                    status: "unsafe",
                    pid: retainedChrome.pid,
                    reason: error instanceof Error ? error.message : String(error),
                  };
                }
              },
        }
      : (deps.recoveryCleanup ?? {});

    if (!completedFallbackCleanup) {
      try {
        const cleanupResult = await finalizeRecoveredRuntime(
          authorityRuntime,
          logger,
          cleanupDeps,
          mode,
        );
        if (cleanupResult.status === "pending") return cleanupResult;
        completedFallbackCleanup = cleanupResult;
      } catch (cleanupError) {
        return pendingFinalization(
          authorityRuntime,
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          mode,
        );
      }
    }

    if (manualChromeOwner && !manualOwnerEndpointReleased) {
      try {
        await releaseManualChromeOwnerEndpointAuthority(manualChromeOwner);
        manualOwnerEndpointReleased = true;
      } catch (releaseError) {
        const error = `Exact Chrome endpoint release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`;
        return pendingFinalization(
          retainPendingEndpointReleaseRuntime(completedFallbackCleanup.runtime, authorityRuntime),
          error,
          mode,
        );
      }
    }
    return completedFallbackCleanup;
  };

  await persistFallbackRuntime(manualLogin ? "tab-lease" : "chrome-process");
  try {
    if (manualLogin) {
      fallbackLease = await (deps.acquireBrowserTabLease ?? acquireBrowserTabLease)(userDataDir, {
        maxConcurrentTabs: resolved.maxConcurrentTabs,
        timeoutMs: resolved.timeoutMs,
        logger,
        sessionId: `reattach-${process.pid}`,
        leaseId: fallbackLeaseId,
      });
      await persistFallbackRuntime("chrome-process");
    }
    if (manualLogin) {
      const owner = await (deps.acquireManualChromeOwner ?? acquireManualChromeOwner)(
        userDataDir,
        resolved,
        logger,
        `reattach-${process.pid}`,
        { launchClaim: acquisitionLaunchClaim },
      );
      manualChromeOwner = owner;
      chrome = owner.chrome;
    } else {
      chrome = await (deps.launchChrome ?? launchChrome)(resolved, userDataDir, logger, {
        launchClaim: acquisitionLaunchClaim,
      });
    }
    if (
      chrome &&
      (manualLogin
        ? manualChromeOwner?.disposition === "close-on-last-lease"
        : !resolved.keepBrowser)
    ) {
      retainedOwnedChrome = chrome;
    }
    await persistFallbackRuntime("chrome-target");
    const chromeHost = chrome.host ?? "127.0.0.1";
    const recoveryConnection = await createOwnedRecoveryTargetConnection(
      chrome,
      logger,
      deps,
      fallbackTargetMarkerUrl,
      async (targetId) => {
        fallbackTargetId = targetId;
        await persistFallbackRuntime();
      },
      async () => {
        fallbackTargetId = null;
        await persistFallbackRuntime("chrome-target");
      },
    );
    const recoveryTargetId = recoveryConnection.targetId;
    client = recoveryConnection.client;
    closeFallbackConnection = recoveryConnection.close;
    await fallbackLease?.update({
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

    const closeConnection = closeFallbackConnection;
    if (!closeConnection) throw new Error("Recovery target connection cleanup is unavailable.");
    await closeConnection().catch(() => undefined);
    closeFallbackConnection = null;
    client = null;
    const captureRuntime = fallbackRuntime ?? refreshFallbackRuntime();
    return {
      answerText,
      answerMarkdown,
      runtime: captureRuntime,
      finalizeResources: () => settleFallbackResources("finalize"),
      abortResources: () => settleFallbackResources("abort"),
    };
  } catch (error) {
    const cleanupResult = await settleFallbackResources("abort");
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
