import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir } from "node:fs/promises";
import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import type { BrowserRecoveryCleanupResourceMetadata } from "../sessionManager.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { loadUserConfig } from "../config.js";
import { resumeRemoteBrowserTransaction, settleRemoteBrowserRecovery } from "../remote/client.js";
import { resolveRemoteServiceConfig } from "../remote/remoteServiceConfig.js";
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
import type { BrowserCaptureFinalizationResult, BrowserLogger, ChromeClient } from "./types.js";
import {
  launchChrome,
  createChromePageTarget,
  positionChromeWindowOffscreen,
  connectToRemoteChromeTarget,
  listRemoteChromeTargets,
  closeChromeTarget,
  type RemoteChromeConnection,
} from "./chromeLifecycle.js";
import { acquireManualChromeOwner, type BrowserChrome } from "./manualChromeOwner.js";
import { resolveBrowserConfig } from "./config.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import { CHATGPT_URL } from "./constants.js";
import {
  cleanupStaleProfileState,
  captureProfileDirectoryIdentity,
  isSafeChromeTerminationOutcome,
  removeProfileDirectoryIfIdentityMatches,
  terminateRecordedChromeForProfile,
  verifyProfileDirectoryIdentity,
  type ProfileDirectoryIdentity,
} from "./profileState.js";
import {
  acquireBrowserTabLease,
  releaseBrowserTabLease,
  teardownBrowserResourcesIfNoActiveLeases,
  type BrowserTabLease,
} from "./tabLeaseRegistry.js";
import {
  acquireCrashRecoverableFilesystemLock,
  FilesystemLockBusyError,
} from "./filesystemLock.js";
import { readDevToolsActivePortInfo } from "./detect.js";
import {
  extractConversationIdFromUrl,
  buildConversationUrl,
  withTimeout,
  openConversationFromSidebar,
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

export interface ReattachCleanupDeps {
  closeChromeTarget?: typeof closeChromeTarget;
  terminateRecordedChromeForProfile?: typeof terminateRecordedChromeForProfile;
  cleanupStaleProfileState?: typeof cleanupStaleProfileState;
  teardownBrowserResourcesIfNoActiveLeases?: typeof teardownBrowserResourcesIfNoActiveLeases;
  removeProfile?: (profileDir: string) => Promise<boolean>;
  releaseBrowserTabLease?: typeof releaseBrowserTabLease;
  settleRemoteBrowserRecovery?: typeof settleRemoteBrowserRecovery;
  resolveRemoteRecoveryConfig?: () => Promise<{ host?: string; token?: string }>;
  isRemotePublicationAcknowledged?: () => boolean;
}

export interface ReattachRecoveryLock {
  release: () => Promise<void>;
}

export interface ReattachCapture {
  answerText: string;
  answerMarkdown: string;
  runtime?: BrowserRuntimeMetadata;
  finalizeResources?: () => Promise<ReattachFinalizationResult>;
  abortResources?: () => Promise<ReattachFinalizationResult>;
}

export interface ReattachDeps {
  listTargets?: () => Promise<TargetInfoLite[]>;
  connect?: (options?: unknown) => Promise<ChromeClient>;
  waitForAssistantResponse?: typeof waitForAssistantResponse;
  captureAssistantMarkdown?: typeof captureAssistantMarkdown;
  waitForDeepResearchCompletion?: typeof waitForDeepResearchCompletion;
  waitForConversationHydration?: typeof waitForResumedConversationHydration;
  verifyCommittedPromptTurn?: typeof verifyCommittedPromptTurn;
  acquireManualChromeOwner?: typeof acquireManualChromeOwner;
  createRecoveryTarget?: typeof createChromePageTarget;
  connectRecoveryTarget?: typeof connectToRemoteChromeTarget;
  recoverSession?: (
    runtime: BrowserRuntimeMetadata,
    config: BrowserSessionConfig | undefined,
  ) => Promise<ReattachCapture>;
  recoveryCleanup?: ReattachCleanupDeps;
  recoveryLockPath?: string;
  acquireRecoveryLock?: (lockPath: string) => Promise<ReattachRecoveryLock>;
  isRemotePublicationAcknowledged?: () => boolean;
  resumeRemoteBrowserTransaction?: typeof resumeRemoteBrowserTransaction;
}

export type ReattachFinalizationResult = BrowserCaptureFinalizationResult;

export interface ReattachResult {
  answerText: string;
  answerMarkdown: string;
  runtime: BrowserRuntimeMetadata;
  finalize: () => Promise<ReattachFinalizationResult>;
  abort: () => Promise<ReattachFinalizationResult>;
}

export async function resumeBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps = {},
): Promise<ReattachResult> {
  const promptLocator = requireCommittedPromptEpochLocator(runtime);
  const promptEpoch = promptLocator.epoch;
  const minAssistantTurnIndex = promptLocator.verifiedUserTurnIndex + 1;
  const lockPath = deps.recoveryLockPath ?? defaultRecoveryLockPath(runtime);
  const recoveryLock = await (deps.acquireRecoveryLock ?? acquireReattachRecoveryLock)(lockPath);
  let lockHeld = true;
  const releaseRecoveryLock = async (): Promise<void> => {
    if (!lockHeld) return;
    await recoveryLock.release();
    lockHeld = false;
  };
  const recoverSession =
    deps.recoverSession ??
    (async (runtimeMeta, configMeta) =>
      resumeBrowserSessionViaNewChrome(runtimeMeta, configMeta, logger, deps));
  let closeAttachedConnection: (() => Promise<void>) | null = null;
  const closeAttached = async (): Promise<void> => {
    const close = closeAttachedConnection;
    closeAttachedConnection = null;
    await close?.().catch(() => undefined);
  };

  const buildResult = (
    capture: ReattachCapture,
    authoritativeRuntime: BrowserRuntimeMetadata = runtime,
  ): ReattachResult => {
    const runtimeForCapture = capture.runtime ?? authoritativeRuntime;
    const captureLocator = requireCommittedPromptEpochLocator(runtimeForCapture);
    assertSameCommittedPromptEpoch(promptLocator, captureLocator);
    const capturedRuntime = markRecoveryCleanupPending(runtimeForCapture);
    let settlementMode: "finalize" | "abort" | null = null;
    let settlementRuntime = capturedRuntime;
    let settlementInFlight: Promise<ReattachFinalizationResult> | null = null;
    let completedSettlement: ReattachFinalizationResult | null = null;

    const settle = async (mode: "finalize" | "abort"): Promise<ReattachFinalizationResult> => {
      if (settlementMode && settlementMode !== mode) {
        throw new BrowserAutomationError(
          `Browser recovery is already bound to ${settlementMode} settlement.`,
          { stage: "browser-recovery-settlement", code: "settlement-mode-conflict" },
        );
      }
      if (completedSettlement) return completedSettlement;
      if (settlementInFlight) return settlementInFlight;
      settlementMode = mode;
      settlementInFlight = (async () => {
        let result: ReattachFinalizationResult;
        try {
          const captureSettler =
            mode === "abort"
              ? (capture.abortResources ?? capture.finalizeResources)
              : capture.finalizeResources;
          result = captureSettler
            ? await captureSettler()
            : await finalizeRecoveredRuntime(
                settlementRuntime,
                logger,
                {
                  ...deps.recoveryCleanup,
                  isRemotePublicationAcknowledged: deps.isRemotePublicationAcknowledged,
                },
                mode,
              );
        } catch (error) {
          result = pendingFinalization(
            settlementRuntime,
            error instanceof Error ? error.message : String(error),
          );
        }
        settlementRuntime = result.runtime;
        if (result.status !== "completed") return result;
        try {
          await releaseRecoveryLock();
        } catch (error) {
          return pendingFinalization(
            settlementRuntime,
            `Cleanup finished but recovery lock release failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        completedSettlement = result;
        return result;
      })().finally(() => {
        settlementInFlight = null;
      });
      return settlementInFlight;
    };

    return {
      answerText: capture.answerText,
      answerMarkdown: capture.answerMarkdown,
      runtime: capturedRuntime,
      finalize: () => settle("finalize"),
      abort: () => settle("abort"),
    };
  };

  const recover = async (
    authoritativeRuntime: BrowserRuntimeMetadata = runtime,
  ): Promise<ReattachResult> => {
    const capture = await recoverSession(authoritativeRuntime, config);
    return buildResult(capture, authoritativeRuntime);
  };

  try {
    if (runtime.remoteRecovery) {
      const configured = deps.recoveryCleanup?.resolveRemoteRecoveryConfig
        ? await deps.recoveryCleanup.resolveRemoteRecoveryConfig()
        : resolveRemoteServiceConfig({
            userConfig: (await loadUserConfig({ includeProject: false })).config,
            env: process.env,
          });
      const transaction = await (
        deps.resumeRemoteBrowserTransaction ?? resumeRemoteBrowserTransaction
      )({
        runtime,
        configuredHost: configured.host ?? "",
        authToken: configured.token,
        log: logger,
      });
      return buildResult(
        {
          answerText: transaction.answerText,
          answerMarkdown: transaction.answerMarkdown,
          runtime: transaction.runtime,
          finalizeResources: transaction.finalize,
          abortResources: transaction.abort,
        },
        transaction.runtime,
      );
    }
    if (!runtime.chromePort && !runtime.chromeBrowserWSEndpoint) {
      logger("No running Chrome detected; reopening browser to locate the session.");
      return await recover();
    }

    let liveRuntime = runtime;
    try {
      liveRuntime = (await refreshAttachRuntime(runtime).catch(() => runtime)) ?? runtime;
      const livePromptLocator = requireCommittedPromptEpochLocator(liveRuntime);
      assertSameCommittedPromptEpoch(promptLocator, livePromptLocator);
      const host = liveRuntime.chromeHost ?? "127.0.0.1";
      const port =
        liveRuntime.chromePort ??
        inferPortFromBrowserWSEndpoint(liveRuntime.chromeBrowserWSEndpoint);
      const browserWSEndpoint = liveRuntime.chromeBrowserWSEndpoint ?? undefined;
      const listTargets =
        deps.listTargets ??
        (async () =>
          (await listRemoteChromeTargets({
            host,
            port: port ?? 9222,
            browserWSEndpoint,
          })) as TargetInfoLite[]);
      const targetList = await listTargets();
      const explicitTabRef = config?.browserTabRef?.trim() || undefined;
      const target = pickTarget(targetList, liveRuntime, explicitTabRef);
      const targetId = target?.targetId ?? target?.id;
      if (!targetId) {
        liveRuntime = { ...liveRuntime, chromeTargetId: undefined };
        throw new Error(
          explicitTabRef
            ? `Explicit browser tab ${explicitTabRef} is unavailable.`
            : "Stored Chrome target is unavailable or no longer matches the committed conversation.",
        );
      }
      const previousTargetId = liveRuntime.chromeTargetId;
      const selectedResources = [...(liveRuntime.recoveryCleanupResources ?? [])];
      const promptIdentity = JSON.stringify(immutablePromptIdentity(liveRuntime.promptEpoch));
      for (let index = selectedResources.length - 1; index >= 0; index -= 1) {
        const resource = selectedResources[index];
        if (!resource) continue;
        const samePrompt =
          JSON.stringify(immutablePromptIdentity(resource.promptEpoch)) === promptIdentity;
        const sameTarget = previousTargetId
          ? resource.chromeTargetId === previousTargetId
          : !resource.chromeTargetId;
        if (!samePrompt || !sameTarget) continue;
        selectedResources[index] = {
          ...resource,
          chromeHost: host,
          chromePort: port,
          chromeBrowserWSEndpoint: browserWSEndpoint,
          chromeTargetId: targetId,
          recoveryCleanup: explicitTabRef
            ? { ...resource.recoveryCleanup, ownsTarget: false }
            : resource.recoveryCleanup,
        };
        break;
      }
      liveRuntime = {
        ...liveRuntime,
        chromeTargetId: targetId,
        recoveryCleanupResources: selectedResources,
      };
      const connection = deps.connect
        ? await (async () => {
            const client = await deps.connect?.(
              browserWSEndpoint
                ? { target: browserWSEndpoint, local: true, targetId }
                : { host, port, target: targetId },
            );
            if (!client) throw new Error("Chrome target connection returned no client.");
            return { client, close: () => client.close() };
          })()
        : await connectToRemoteChromeTarget(host, port ?? 9222, logger, {
            browserWSEndpoint,
            targetId,
            closeTargetOnDispose: false,
          });
      closeAttachedConnection = () => connection.close();

      const client: ChromeClient = connection.client;
      const { Runtime, DOM, Page } = client;
      if (Runtime?.enable) await Runtime.enable();
      if (DOM && typeof DOM.enable === "function") await DOM.enable();
      if (Page && typeof Page.enable === "function") await Page.enable();

      const ensureConversationOpen = async () => {
        const { result } = await Runtime.evaluate({
          expression: "location.href",
          returnByValue: true,
        });
        const href = typeof result?.value === "string" ? result.value : "";
        if (extractRecoverableConversationId(href) === promptEpoch.conversationId) return;
        const opened = await openConversationFromSidebarWithRetry(
          Runtime,
          {
            conversationId: promptEpoch.conversationId,
            preferProjects: true,
          },
          15_000,
        );
        if (!opened) throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
        await waitForLocationChange(Runtime, 15_000);
      };

      const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
      const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
      const timeoutMs = config?.timeoutMs ?? 120_000;
      const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
      await withTimeout(
        Runtime.evaluate({ expression: "1+1", returnByValue: true }),
        pingTimeoutMs,
        "Reattach target did not respond",
      );
      await ensureConversationOpen();
      const waitForHydration =
        deps.waitForConversationHydration ?? waitForResumedConversationHydration;
      const expectedConversationUrl = buildCommittedConversationUrl(
        runtime,
        resolveBrowserConfig(config ?? {}).url,
        promptEpoch.conversationId,
      );
      await waitForHydration(Runtime, timeoutMs, logger, {
        requirePriorTurns: true,
        requirePromptReady: false,
        expectedConversationUrl: expectedConversationUrl ?? undefined,
      });
      const verifyPromptTurn = deps.verifyCommittedPromptTurn ?? verifyCommittedPromptTurn;
      await verifyPromptTurn(Runtime, promptLocator);
      const minTurnIndex = minAssistantTurnIndex;
      if (config?.researchMode === "deep") {
        const waitForDeepResearch =
          deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
        const researchResult = await withTimeout(
          waitForDeepResearch(Runtime, logger, timeoutMs, minTurnIndex, Page, client, {
            requireScopedTargetOwner: true,
            expectedConversationId: promptLocator.conversationId,
            expectedPromptTurn: promptLocator,
          }),
          timeoutMs + 5_000,
          "Reattach Deep Research response timed out",
        );
        await closeAttached();
        return buildResult({
          answerText: researchResult.text,
          answerMarkdown: researchResult.text,
          runtime: liveRuntime,
        });
      }
      const answer = await withTimeout(
        waitForResponse(
          Runtime,
          timeoutMs,
          logger,
          minTurnIndex,
          promptLocator.conversationId,
          promptLocator,
        ),
        timeoutMs + 5_000,
        "Reattach response timed out",
      );
      const markdown =
        (await withTimeout(
          captureMarkdown(
            Runtime,
            answer.meta,
            logger,
            promptLocator.conversationId,
            promptLocator,
          ),
          15_000,
          "Reattach markdown capture timed out",
        )) ?? answer.text;
      await closeAttached();
      return buildResult({
        answerText: answer.text,
        answerMarkdown: markdown,
        runtime: liveRuntime,
      });
    } catch (error) {
      await closeAttached();
      if (
        error instanceof BrowserAutomationError &&
        error.details?.code === "committed-prompt-identity-mismatch"
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger(
        `Existing Chrome reattach failed (${message}); reopening browser to locate the session.`,
      );
      return await recover(liveRuntime);
    }
  } catch (error) {
    await releaseRecoveryLock().catch((lockError) => {
      logger(
        `Failed to release recovery lock after reattach error: ${lockError instanceof Error ? lockError.message : String(lockError)}`,
      );
    });
    throw error;
  }
}

export async function retryBrowserRecoveryCleanup(
  runtime: BrowserRuntimeMetadata,
  logger: BrowserLogger,
  deps: Pick<
    ReattachDeps,
    | "recoveryCleanup"
    | "recoveryLockPath"
    | "acquireRecoveryLock"
    | "isRemotePublicationAcknowledged"
  > = {},
): Promise<ReattachFinalizationResult> {
  const lockPath = deps.recoveryLockPath ?? defaultRecoveryLockPath(runtime);
  const recoveryLock = await (deps.acquireRecoveryLock ?? acquireReattachRecoveryLock)(lockPath);
  let result: ReattachFinalizationResult;
  try {
    result = await finalizeRecoveredRuntime(
      runtime,
      logger,
      {
        ...deps.recoveryCleanup,
        isRemotePublicationAcknowledged: deps.isRemotePublicationAcknowledged,
      },
      "finalize",
    );
  } catch (error) {
    result = pendingFinalization(runtime, error instanceof Error ? error.message : String(error));
  }
  try {
    await recoveryLock.release();
  } catch (error) {
    return pendingFinalization(
      runtime,
      `Cleanup finished but recovery lock release failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return result;
}

type RecoveryCleanupEntry = {
  resource: BrowserRecoveryCleanupResourceMetadata;
  order: number;
};

type RecoveryCleanupGroup = {
  key: string;
  entries: RecoveryCleanupEntry[];
};

async function finalizeRecoveredRuntime(
  runtime: BrowserRuntimeMetadata,
  logger: BrowserLogger,
  deps: ReattachCleanupDeps = {},
  mode: "finalize" | "abort" = "finalize",
): Promise<ReattachFinalizationResult> {
  const groups = groupRecoveryCleanupResources(runtime);
  const pending: RecoveryCleanupEntry[] = [];
  const errors: string[] = [];

  for (const group of groups) {
    const result = await finalizeRecoveryCleanupGroup(group, logger, deps, mode);
    pending.push(...result.pending);
    errors.push(...result.errors);
  }

  if (pending.length === 0) {
    const completedRuntime = { ...runtime };
    delete completedRuntime.recoveryCleanupResources;
    delete completedRuntime.recoveryCleanupResult;
    delete completedRuntime.remoteRecovery;
    return { status: "completed", runtime: completedRuntime };
  }

  const error = [...new Set(errors)].join("; ") || "Browser recovery cleanup remains pending";
  const pendingRuntime = rebuildPendingCleanupRuntime(runtime, pending, error);
  return { status: "pending", runtime: pendingRuntime, error };
}

async function finalizeRecoveryCleanupGroup(
  group: RecoveryCleanupGroup,
  logger: BrowserLogger,
  deps: ReattachCleanupDeps,
  mode: "finalize" | "abort",
): Promise<{ pending: RecoveryCleanupEntry[]; errors: string[] }> {
  if (group.entries[0]?.resource.recoveryCleanup.transport === "remote") {
    return finalizeRemoteRecoveryCleanupGroup(group, deps, mode);
  }
  const pending: RecoveryCleanupEntry[] = [];
  const errors: string[] = [];
  const pendingKeys = new Set<string>();
  const releasedLeaseIds = new Set<string>();
  const groupLabel = createHash("sha256").update(group.key).digest("hex").slice(0, 12);
  const addPending = (entry: RecoveryCleanupEntry, error: string): void => {
    const key = recoveryCleanupResourceKey(entry.resource);
    if (!pendingKeys.has(key)) {
      pendingKeys.add(key);
      pending.push(entry);
    }
    errors.push(`Cleanup group ${groupLabel}: ${error}`);
  };

  try {
    const closeTarget = deps.closeChromeTarget ?? closeChromeTarget;
    let connectionResource: BrowserRecoveryCleanupResourceMetadata | undefined;
    for (let index = group.entries.length - 1; index >= 0; index -= 1) {
      const candidate = group.entries[index]?.resource;
      if (
        candidate &&
        Boolean(
          candidate.chromePort ?? inferPortFromBrowserWSEndpoint(candidate.chromeBrowserWSEndpoint),
        )
      ) {
        connectionResource = candidate;
        break;
      }
    }
    const connectionPort = connectionResource
      ? (connectionResource.chromePort ??
        inferPortFromBrowserWSEndpoint(connectionResource.chromeBrowserWSEndpoint))
      : undefined;
    const targets = new Map<string, RecoveryCleanupEntry[]>();
    for (const entry of group.entries) {
      const { resource } = entry;
      const cleanup = resource.recoveryCleanup;
      if (!cleanup.ownsTarget || (!cleanup.closeOwnedTargetOnComplete && cleanup.keepBrowser)) {
        continue;
      }
      const targetKey =
        resource.chromeTargetId ?? `missing:${recoveryCleanupResourceKey(resource)}`;
      const targetEntries = targets.get(targetKey);
      if (targetEntries) targetEntries.push(entry);
      else targets.set(targetKey, [entry]);
    }

    for (const targetEntries of targets.values()) {
      const representative = targetEntries[0];
      if (!representative) continue;
      const resource = representative.resource;
      if (!resource.chromeTargetId || !connectionResource || !connectionPort) {
        for (const entry of targetEntries) {
          addPending(entry, "Owned Chrome target cleanup metadata is incomplete");
        }
        continue;
      }
      try {
        const closed = await closeTarget({
          host: connectionResource.chromeHost ?? "127.0.0.1",
          port: connectionPort,
          browserWSEndpoint: connectionResource.chromeBrowserWSEndpoint,
          targetId: resource.chromeTargetId,
          logger,
        });
        if (!closed) {
          for (const entry of targetEntries) {
            addPending(entry, `Chrome target close was not confirmed: ${resource.chromeTargetId}`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const entry of targetEntries) {
          addPending(entry, `Chrome target close failed: ${message}`);
        }
      }
    }

    const teardownEntries = group.entries.filter((entry) =>
      requestsProcessTeardown(entry.resource),
    );
    const preserveProcess = group.entries.some(
      (entry) => entry.resource.recoveryCleanup.keepBrowser,
    );
    const teardownRepresentative =
      teardownEntries.find((entry) => entry.resource.userDataDir) ?? teardownEntries[0];
    const teardownEntry = teardownRepresentative
      ? teardownOnlyEntry(teardownRepresentative)
      : undefined;
    if (teardownEntries.length > 0 && !preserveProcess) {
      const invariantError = await validateGroupTeardownInvariants(teardownEntries);
      if (invariantError && teardownEntry) {
        addPending(teardownEntry, invariantError);
        return { pending, errors };
      }
    }

    let teardownViaLeaseAttempted = false;
    let teardownViaLeaseError: string | null = null;
    const releaseLease = deps.releaseBrowserTabLease ?? releaseBrowserTabLease;
    const seenLeaseIds = new Set<string>();
    for (const entry of group.entries) {
      const lease = entry.resource.tabLease;
      if (!lease || seenLeaseIds.has(lease.id)) continue;
      seenLeaseIds.add(lease.id);
      if (pendingKeys.has(recoveryCleanupResourceKey(entry.resource))) continue;
      const profileDir = entry.resource.userDataDir;
      if (!profileDir) {
        addPending(teardownOnlyEntry(entry), "Browser tab lease profile path is missing");
        continue;
      }
      try {
        await releaseLease(profileDir, lease.id, logger, {
          expectedProfileIdentity: lease.profileDirectory,
          onRelease:
            teardownEntry &&
            teardownEntries.length > 0 &&
            !preserveProcess &&
            teardownEntry.resource.recoveryCleanup.profileKind === "manual-login"
              ? async ({ isLastLease }) => {
                  if (!isLastLease) return;
                  teardownViaLeaseAttempted = true;
                  teardownViaLeaseError = await teardownLocalRecoveryGroup(
                    teardownEntry.resource,
                    logger,
                    deps,
                  );
                }
              : undefined,
        });
        releasedLeaseIds.add(lease.id);
      } catch (error) {
        addPending(
          teardownOnlyEntry(entry),
          `Browser tab lease release failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (pending.length > 0) {
      if (
        teardownEntry &&
        teardownEntries.length > 0 &&
        !preserveProcess &&
        !pending.some((entry) => requestsProcessTeardown(entry.resource))
      ) {
        addPending(
          removeReleasedLeaseAuthority(teardownEntry, releasedLeaseIds),
          "Process teardown deferred until target and lease cleanup complete",
        );
      }
      return { pending, errors };
    }

    if (!teardownEntry || teardownEntries.length === 0 || preserveProcess) {
      return { pending, errors };
    }

    const resource = removeReleasedLeaseAuthority(teardownEntry, releasedLeaseIds).resource;
    const profileKind = resource.recoveryCleanup.profileKind;
    try {
      let teardownError: string | null = null;
      if (
        group.entries.some((entry) => entry.resource.tabLease) &&
        profileKind === "manual-login"
      ) {
        teardownError = teardownViaLeaseAttempted
          ? teardownViaLeaseError
          : "Manual-login cleanup preserved resources (active-leases)";
      } else if (profileKind === "manual-login") {
        const teardown =
          deps.teardownBrowserResourcesIfNoActiveLeases ?? teardownBrowserResourcesIfNoActiveLeases;
        const profileDir = resource.userDataDir;
        const processIdentity = resource.chromeProcessIdentity;
        const profileDirectory = physicalProfileDirectoryIdentity(
          processIdentity?.profileDirectory,
        );
        if (!profileDir) {
          teardownError = "Cleanup profile path is missing";
        } else if (!processIdentity) {
          teardownError = "Chrome process identity cleanup metadata is missing";
        } else if (!profileDirectory) {
          teardownError = "Chrome physical profile identity cleanup metadata is missing";
        } else {
          let directError: string | null = null;
          const outcome = await teardown(
            profileDir,
            async () => {
              directError = await teardownLocalRecoveryGroup(resource, logger, deps);
              return directError === null;
            },
            { logger, expectedProfileIdentity: profileDirectory },
          );
          if (outcome.status !== "completed") {
            teardownError =
              directError ??
              outcome.error ??
              `Manual-login cleanup preserved resources (${outcome.reason})`;
          }
        }
      } else {
        teardownError = await teardownLocalRecoveryGroup(resource, logger, deps);
      }

      if (teardownError) {
        addPending(removeReleasedLeaseAuthority(teardownEntry, releasedLeaseIds), teardownError);
      }
    } catch (error) {
      addPending(
        removeReleasedLeaseAuthority(teardownEntry, releasedLeaseIds),
        error instanceof Error ? error.message : String(error),
      );
    }
    return { pending, errors };
  } catch (error) {
    const first = group.entries[0];
    if (first) addPending(first, error instanceof Error ? error.message : String(error));
    return { pending, errors };
  }
}

async function finalizeRemoteRecoveryCleanupGroup(
  group: RecoveryCleanupGroup,
  deps: ReattachCleanupDeps,
  mode: "finalize" | "abort",
): Promise<{ pending: RecoveryCleanupEntry[]; errors: string[] }> {
  const representative = group.entries[group.entries.length - 1];
  if (!representative) return { pending: [], errors: [] };
  const authority = representative.resource.remoteRecovery;
  const groupLabel = createHash("sha256").update(group.key).digest("hex").slice(0, 12);
  const pending = (error: string, remoteRecovery = authority) => ({
    pending: group.entries.map((entry) => ({
      ...entry,
      resource: {
        ...entry.resource,
        remoteRecovery,
        recoveryCleanup: { ...entry.resource.recoveryCleanup, transport: "remote" as const },
      },
    })),
    errors: [`Cleanup group ${groupLabel}: ${error}`],
  });
  if (!authority) {
    return pending("Remote cleanup transaction authority is missing.");
  }
  if (mode === "finalize" && deps.isRemotePublicationAcknowledged?.() !== true) {
    return pending("Remote settlement requires durable answer publication acknowledgment.");
  }

  let configured: { host?: string; token?: string };
  try {
    if (deps.resolveRemoteRecoveryConfig) {
      configured = await deps.resolveRemoteRecoveryConfig();
    } else {
      const { config: userConfig } = await loadUserConfig({ includeProject: false });
      configured = resolveRemoteServiceConfig({ userConfig, env: process.env });
    }
  } catch (error) {
    return pending(
      `Remote cleanup configuration is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const resource = representative.resource;
  const remoteResources = group.entries.map((entry) => ({
    ...entry.resource,
    remoteRecovery: authority,
    recoveryCleanup: { ...entry.resource.recoveryCleanup, transport: "remote" as const },
  }));
  const runtime: BrowserRuntimeMetadata = {
    chromePid: resource.chromePid,
    chromeProcessIdentity: resource.chromeProcessIdentity,
    chromePort: resource.chromePort,
    chromeHost: resource.chromeHost,
    chromeBrowserWSEndpoint: resource.chromeBrowserWSEndpoint,
    chromeProfileRoot: resource.chromeProfileRoot,
    userDataDir: resource.userDataDir,
    chromeTargetId: resource.chromeTargetId,
    conversationId: resource.conversationId,
    promptEpoch: resource.promptEpoch,
    recoveryCleanupResources: remoteResources,
    recoveryCleanupResult: { status: "pending" },
    remoteRecovery: authority,
  };
  let result: BrowserCaptureFinalizationResult;
  try {
    result = await (deps.settleRemoteBrowserRecovery ?? settleRemoteBrowserRecovery)({
      runtime,
      configuredHost: configured.host ?? "",
      authToken: configured.token,
      mode,
    });
  } catch (error) {
    return pending(
      `Remote cleanup settlement remains retryable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.status === "completed") return { pending: [], errors: [] };
  const returnedAuthority =
    result.runtime.recoveryCleanupResources?.find(
      (candidate) => candidate.recoveryCleanup.transport === "remote",
    )?.remoteRecovery ?? result.runtime.remoteRecovery;
  return pending(
    result.error || "Remote cleanup settlement remains pending.",
    returnedAuthority ?? authority,
  );
}

async function teardownLocalRecoveryGroup(
  resource: BrowserRecoveryCleanupResourceMetadata,
  logger: BrowserLogger,
  deps: ReattachCleanupDeps,
): Promise<string | null> {
  const profileKind = resource.recoveryCleanup.profileKind;
  const profileDir = resource.userDataDir;
  const profileError = validateCleanupProfilePath(resource, profileKind);
  if (!profileDir || profileError) return profileError ?? "Cleanup profile path is missing";

  if (
    (profileKind === "temporary" || profileKind === "copied") &&
    (await cleanupProfileAbsent(profileDir))
  ) {
    return null;
  }

  const processIdentity = resource.chromeProcessIdentity;
  const profileDirectory = physicalProfileDirectoryIdentity(
    processIdentity?.profileDirectory ?? resource.profileDirectoryIdentity,
  );
  if (!profileDirectory) {
    return "Chrome physical profile identity cleanup metadata is missing";
  }
  if (!(await verifyProfileDirectoryIdentity(profileDir, profileDirectory))) {
    return "Chrome process identity does not match the cleanup profile";
  }

  if (processIdentity) {
    const terminateChrome =
      deps.terminateRecordedChromeForProfile ?? terminateRecordedChromeForProfile;
    const termination = await terminateChrome(profileDir, processIdentity, logger);
    if (!isSafeChromeTerminationOutcome(termination)) {
      if (profileKind === "manual-login") {
        logger(`[browser] Preserving manual-login profile: ${termination.reason}`);
      }
      return termination.reason;
    }
  } else if (profileKind === "manual-login") {
    return "Chrome process identity cleanup metadata is missing";
  }

  if (profileKind === "manual-login") {
    const cleanupProfileState = deps.cleanupStaleProfileState ?? cleanupStaleProfileState;
    return (await cleanupProfileState(profileDir, logger, {
      lockRemovalMode: "never",
      expectedProfileIdentity: profileDirectory,
    }))
      ? null
      : `Manual-login profile cleanup was not confirmed: ${profileDir}`;
  }

  return (await removeCleanupProfile(profileDir, profileDirectory, deps.removeProfile))
    ? null
    : `Profile removal was not confirmed: ${profileDir}`;
}
function groupRecoveryCleanupResources(runtime: BrowserRuntimeMetadata): RecoveryCleanupGroup[] {
  const entries: RecoveryCleanupEntry[] = (runtime.recoveryCleanupResources ?? []).map(
    (resource, order) => ({ resource, order }),
  );
  const unique = new Map<string, RecoveryCleanupEntry>();
  for (const entry of entries) {
    const key = recoveryCleanupResourceKey(entry.resource);
    if (!unique.has(key)) unique.set(key, entry);
  }

  const groups = new Map<string, RecoveryCleanupGroup>();
  for (const entry of unique.values()) {
    const key = recoveryCleanupGroupKey(entry.resource);
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { key, entries: [entry] });
  }
  return [...groups.values()];
}

function recoveryCleanupGroupKey(resource: BrowserRecoveryCleanupResourceMetadata): string {
  const cleanup = resource.recoveryCleanup;
  if (cleanup.transport === "local") {
    const processIdentity = resource.chromeProcessIdentity;
    const profileIdentity = profileDirectoryIdentityKey(
      processIdentity?.profileDirectory ?? resource.profileDirectoryIdentity,
    ) ?? ["missing-physical-profile", resource.chromeProfileRoot ?? resource.userDataDir ?? null];
    return JSON.stringify(["local", chromeProcessIdentityKey(processIdentity), profileIdentity]);
  }
  const remoteIdentity = remoteRecoveryIdentityKey(resource.remoteRecovery);
  return JSON.stringify(
    remoteIdentity
      ? ["remote", remoteIdentity]
      : [
          "remote-missing-authority",
          immutablePromptIdentity(resource.promptEpoch),
          resource.conversationId ?? null,
          resource.chromeProfileRoot ?? resource.userDataDir ?? null,
        ],
  );
}

function recoveryCleanupResourceKey(resource: BrowserRecoveryCleanupResourceMetadata): string {
  return JSON.stringify([
    recoveryCleanupGroupKey(resource),
    resource.chromeTargetId ?? null,
    resource.chromeHost ?? null,
    resource.chromePort ?? null,
    resource.chromeBrowserWSEndpoint ?? null,
    resource.tabLease
      ? [resource.tabLease.id, profileDirectoryIdentityKey(resource.tabLease.profileDirectory)]
      : null,
    resource.recoveryCleanup.ownsTarget,
    resource.recoveryCleanup.profileKind,
    resource.recoveryCleanup.keepBrowser,
    Boolean(resource.recoveryCleanup.closeOwnedTargetOnComplete),
  ]);
}

function chromeProcessIdentityKey(
  identity: BrowserRecoveryCleanupResourceMetadata["chromeProcessIdentity"],
): readonly unknown[] | null {
  if (!identity) return null;
  return [
    identity.pid,
    identity.processStartTime,
    identity.executablePath,
    identity.normalizedUserDataDir,
    identity.launchNonce,
    profileDirectoryIdentityKey(identity.profileDirectory) ?? ["missing-physical-profile"],
  ];
}

function physicalProfileDirectoryIdentity(identity: unknown): ProfileDirectoryIdentity | null {
  if (!identity || typeof identity !== "object") return null;
  const candidate = identity as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.platform !== "string" ||
    typeof candidate.canonicalPath !== "string" ||
    typeof candidate.device !== "string" ||
    typeof candidate.inode !== "string"
  ) {
    return null;
  }
  return identity as ProfileDirectoryIdentity;
}

function profileDirectoryIdentityKey(identity: unknown): readonly unknown[] | null {
  const physicalProfile = physicalProfileDirectoryIdentity(identity);
  if (!physicalProfile) return null;
  return [
    physicalProfile.version,
    physicalProfile.platform,
    physicalProfile.canonicalPath,
    physicalProfile.device,
    physicalProfile.inode,
  ];
}

function immutablePromptIdentity(
  promptEpoch: BrowserRecoveryCleanupResourceMetadata["promptEpoch"],
): readonly unknown[] | null {
  if (!promptEpoch) return null;
  return [
    promptEpoch.epochId,
    promptEpoch.promptSha256,
    promptEpoch.followUpOrdinal,
    promptEpoch.status === "committed" ? promptEpoch.conversationId : null,
  ];
}

function remoteRecoveryIdentityKey(
  authority: BrowserRecoveryCleanupResourceMetadata["remoteRecovery"],
): readonly unknown[] | null {
  return authority ? [authority.protocolVersion, authority.host, authority.transactionToken] : null;
}

function requestsProcessTeardown(resource: BrowserRecoveryCleanupResourceMetadata): boolean {
  const cleanup = resource.recoveryCleanup;
  return cleanup.transport === "local" && !cleanup.keepBrowser && cleanup.profileKind !== "none";
}

function teardownOnlyEntry(entry: RecoveryCleanupEntry): RecoveryCleanupEntry {
  return {
    order: entry.order,
    resource: {
      ...entry.resource,
      chromeTargetId: undefined,
      recoveryCleanup: {
        ...entry.resource.recoveryCleanup,
        ownsTarget: false,
        closeOwnedTargetOnComplete: undefined,
      },
    },
  };
}

function removeReleasedLeaseAuthority(
  entry: RecoveryCleanupEntry,
  releasedLeaseIds: Set<string>,
): RecoveryCleanupEntry {
  const leaseId = entry.resource.tabLease?.id;
  if (!leaseId || !releasedLeaseIds.has(leaseId)) return entry;
  return {
    ...entry,
    resource: { ...entry.resource, tabLease: undefined },
  };
}

async function validateGroupTeardownInvariants(
  entries: RecoveryCleanupEntry[],
): Promise<string | null> {
  const first = entries[0]?.resource;
  if (!first) return "Cleanup group has no teardown authority";
  const firstProcessIdentity = first.chromeProcessIdentity;
  const firstProfileDirectory = physicalProfileDirectoryIdentity(
    firstProcessIdentity?.profileDirectory ?? first.profileDirectoryIdentity,
  );
  const fallbackProfileSource = firstProcessIdentity
    ? null
    : (first.chromeProfileRoot ?? first.userDataDir);
  const fallbackProfile = fallbackProfileSource ? path.resolve(fallbackProfileSource) : null;
  for (const { resource } of entries) {
    if (recoveryCleanupGroupKey(resource) !== recoveryCleanupGroupKey(first)) {
      return "Cleanup group contains conflicting Chrome process identities";
    }
    if (resource.recoveryCleanup.profileKind !== first.recoveryCleanup.profileKind) {
      return "Cleanup group contains conflicting profile teardown metadata";
    }
    if (firstProfileDirectory) {
      if (
        resource.userDataDir &&
        !(await cleanupProfileAbsent(resource.userDataDir)) &&
        !(await verifyProfileDirectoryIdentity(resource.userDataDir, firstProfileDirectory))
      ) {
        return "Cleanup group user-data directory does not match its process identity";
      }
      if (
        resource.chromeProfileRoot &&
        !(await cleanupProfileAbsent(resource.chromeProfileRoot)) &&
        !(await verifyProfileDirectoryIdentity(resource.chromeProfileRoot, firstProfileDirectory))
      ) {
        return "Cleanup group profile root does not match its process identity";
      }
    } else {
      if (
        fallbackProfile &&
        resource.userDataDir &&
        path.resolve(resource.userDataDir) !== fallbackProfile
      ) {
        return "Cleanup group user-data directory does not match its process identity";
      }
      if (
        fallbackProfile &&
        resource.chromeProfileRoot &&
        path.resolve(resource.chromeProfileRoot) !== fallbackProfile
      ) {
        return "Cleanup group profile root does not match its process identity";
      }
    }
  }
  return null;
}

function rebuildPendingCleanupRuntime(
  runtime: BrowserRuntimeMetadata,
  entries: RecoveryCleanupEntry[],
  error: string,
): BrowserRuntimeMetadata {
  const ordered = [...entries].sort((left, right) => left.order - right.order);
  const resources: BrowserRecoveryCleanupResourceMetadata[] = [];
  const seen = new Set<string>();
  for (const entry of ordered) {
    const key = recoveryCleanupResourceKey(entry.resource);
    if (seen.has(key)) continue;
    seen.add(key);
    resources.push(entry.resource);
  }
  return {
    ...runtime,
    recoveryCleanupResources: resources,
    recoveryCleanupResult: { status: "failed", error },
  };
}

async function cleanupProfileAbsent(profileDir: string): Promise<boolean> {
  try {
    await access(profileDir);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function markRecoveryCleanupPending(runtime: BrowserRuntimeMetadata): BrowserRuntimeMetadata {
  if (!runtime.recoveryCleanupResources?.length) return runtime;
  return { ...runtime, recoveryCleanupResult: { status: "pending" } };
}

function pendingFinalization(
  runtime: BrowserRuntimeMetadata,
  error: string,
): ReattachFinalizationResult {
  return {
    status: "pending",
    runtime: {
      ...runtime,
      recoveryCleanupResult: { status: "failed", error },
    },
    error,
  };
}

function validateCleanupProfilePath(
  runtime: BrowserRuntimeMetadata,
  profileKind: "temporary" | "manual-login" | "copied" | "none",
): string | null {
  const profileDir = runtime.userDataDir;
  if (!profileDir) return "Cleanup profile path is missing";
  if (!path.isAbsolute(profileDir) || path.resolve(profileDir) !== profileDir) {
    return `Cleanup profile path is not canonical and absolute: ${profileDir}`;
  }
  const root = path.parse(profileDir).root;
  if (profileDir === root || profileDir === path.resolve(os.homedir())) {
    return `Refusing unsafe cleanup profile path: ${profileDir}`;
  }
  if (
    runtime.chromeProfileRoot &&
    path.resolve(runtime.chromeProfileRoot) !== path.resolve(profileDir)
  ) {
    return "Serialized Chrome profile roots disagree";
  }
  if (profileKind !== "temporary" && profileKind !== "copied") return null;
  const basename = path.basename(profileDir);
  if (!basename.startsWith("oracle-browser-") && !basename.startsWith("oracle-reattach-")) {
    return `Refusing unrecognized temporary profile path: ${profileDir}`;
  }
  const allowedRoots = [
    os.tmpdir(),
    "/tmp",
    "/mnt/c/Users/Public/AppData/Local/Temp",
    "/mnt/c/Temp",
    "/mnt/c/Windows/Temp",
  ].map((candidate) => path.resolve(candidate));
  if (!allowedRoots.some((candidate) => isPathWithin(candidate, profileDir))) {
    return `Temporary profile is outside approved runtime roots: ${profileDir}`;
  }
  return null;
}

function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function removeCleanupProfile(
  profileDir: string,
  expectedIdentity: ProfileDirectoryIdentity,
  removeProfile?: (profileDir: string) => Promise<boolean>,
): Promise<boolean> {
  if (removeProfile) {
    return (await removeProfile(profileDir)) === true;
  }
  return removeProfileDirectoryIfIdentityMatches(profileDir, expectedIdentity);
}
function defaultRecoveryLockPath(runtime: BrowserRuntimeMetadata): string {
  const cleanupAuthority = (runtime.recoveryCleanupResources ?? []).map((resource) =>
    recoveryCleanupResourceKey(resource),
  );
  const identity = JSON.stringify([
    "recovery-v3",
    cleanupAuthority,
    remoteRecoveryIdentityKey(runtime.remoteRecovery),
    immutablePromptIdentity(runtime.promptEpoch),
    runtime.conversationId ?? null,
  ]);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return path.join(os.tmpdir(), "oracle-browser-recovery-locks", `${digest}.lock`);
}

async function acquireReattachRecoveryLock(lockPath: string): Promise<ReattachRecoveryLock> {
  try {
    return await acquireCrashRecoverableFilesystemLock(lockPath);
  } catch (error) {
    if (error instanceof FilesystemLockBusyError) {
      const owner = error.owner ? ` (pid ${error.owner.pid})` : "";
      throw new Error(`Browser recovery is already in progress${owner}`);
    }
    throw error;
  }
}

async function refreshAttachRuntime(
  runtime: BrowserRuntimeMetadata,
): Promise<BrowserRuntimeMetadata | null> {
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
  const runtimeProcessKey = chromeProcessIdentityKey(runtime.chromeProcessIdentity);
  const profileRoot = path.resolve(runtime.chromeProfileRoot);
  const recoveryCleanupResources = runtime.recoveryCleanupResources?.map((resource) => {
    if (resource.recoveryCleanup.transport !== "local") return resource;
    const sameAuthority = runtimeProcessKey
      ? JSON.stringify(chromeProcessIdentityKey(resource.chromeProcessIdentity)) ===
        JSON.stringify(runtimeProcessKey)
      : [resource.chromeProfileRoot, resource.userDataDir].some(
          (candidate) => candidate && path.resolve(candidate) === profileRoot,
        );
    return sameAuthority
      ? {
          ...resource,
          chromeHost: host,
          chromePort: activePort.port,
          chromeBrowserWSEndpoint: activePort.browserWSEndpoint,
        }
      : resource;
  });
  return {
    ...runtime,
    chromeHost: host,
    chromePort: activePort.port,
    chromeBrowserWSEndpoint: activePort.browserWSEndpoint,
    recoveryCleanupResources,
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

function pickTarget(
  targets: TargetInfoLite[],
  runtime: Pick<BrowserRuntimeMetadata, "chromeTargetId" | "tabUrl" | "conversationId">,
  browserTabRef?: string,
): TargetInfoLite | undefined {
  if (!Array.isArray(targets) || targets.length === 0) return undefined;
  const targetId = (target: TargetInfoLite): string | undefined => target.targetId ?? target.id;
  const conversationId =
    runtime.conversationId?.trim() || extractRecoverableConversationId(runtime.tabUrl);
  if (!conversationId) return undefined;
  const matchesConversation = (target: TargetInfoLite): boolean =>
    extractRecoverableConversationId(target.url) === conversationId;
  if (browserTabRef) {
    if (browserTabRef.toLowerCase() === "current") return undefined;
    const exactId = targets.find((target) => targetId(target) === browserTabRef);
    if (exactId) return matchesConversation(exactId) ? exactId : undefined;
    const exactUrls = targets.filter(
      (target) => target.url === browserTabRef && matchesConversation(target),
    );
    if (exactUrls.length === 1) return exactUrls[0];
    if (browserTabRef !== conversationId) return undefined;
    const exactConversations = targets.filter(matchesConversation);
    return exactConversations.length === 1 ? exactConversations[0] : undefined;
  }
  if (!runtime.chromeTargetId) return undefined;
  const exactTarget = targets.find((target) => targetId(target) === runtime.chromeTargetId);
  return exactTarget && matchesConversation(exactTarget) ? exactTarget : undefined;
}

function extractRecoverableConversationId(
  candidate: string | null | undefined,
): string | undefined {
  return isRecoverableChatGptConversationUrl(candidate)
    ? extractConversationIdFromUrl(candidate ?? "")
    : undefined;
}

function buildCommittedConversationUrl(
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

function requireCommittedPromptEpochLocator(
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

function assertSameCommittedPromptEpoch(
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

async function createOwnedRecoveryTargetConnection(
  chrome: Pick<BrowserChrome, "host" | "port">,
  logger: BrowserLogger,
  deps: ReattachDeps,
  onTargetAcquired?: (targetId: string) => void,
  onTargetCleaned?: (targetId: string) => void,
): Promise<RemoteChromeConnection> {
  const host = chrome.host ?? "127.0.0.1";
  const createTarget = deps.createRecoveryTarget ?? createChromePageTarget;
  const targetId = await createTarget(chrome.port, logger, host);
  if (!targetId) {
    throw new Error("Unable to create a dedicated Chrome target for browser recovery.");
  }
  onTargetAcquired?.(targetId);

  let connection: RemoteChromeConnection | null = null;
  try {
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
      else onTargetCleaned?.(targetId);
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

async function resumeBrowserSessionViaNewChrome(
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

  const inheritedRecoveryCleanupResources = [...(runtime.recoveryCleanupResources ?? [])];
  let fallbackLease: BrowserTabLease | null = null;
  let chrome: BrowserChrome | null = null;
  let fallbackTargetId: string | null = null;
  let fallbackRuntime: BrowserRuntimeMetadata | null = null;
  let client: ChromeClient | null = null;
  let closeFallbackConnection: (() => Promise<void>) | null = null;
  const refreshFallbackRuntime = (): BrowserRuntimeMetadata => {
    const ownsProcess = Boolean(chrome && !resolved.keepBrowser);
    const hasNewAuthority = !manualLogin || Boolean(fallbackLease || chrome || fallbackTargetId);
    const profileKind = ownsProcess
      ? manualLogin
        ? "manual-login"
        : "temporary"
      : !chrome && !manualLogin
        ? "temporary"
        : "none";
    const resource: BrowserRecoveryCleanupResourceMetadata = {
      chromePid: chrome?.pid,
      chromeProcessIdentity: chrome?.processIdentity,
      profileDirectoryIdentity:
        chrome?.processIdentity?.profileDirectory ?? fallbackProfileIdentity,
      chromePort: chrome?.port,
      chromeHost: chrome?.host ?? "127.0.0.1",
      chromeProfileRoot: userDataDir,
      userDataDir,
      chromeTargetId: fallbackTargetId ?? undefined,
      conversationId: promptEpoch.conversationId,
      promptEpoch,
      tabLease: fallbackLease
        ? { id: fallbackLease.id, profileDirectory: fallbackLease.profileDirectory }
        : undefined,
      recoveryCleanup: {
        transport: "local",
        ownsTarget: Boolean(fallbackTargetId),
        profileKind,
        keepBrowser: profileKind === "none" ? true : Boolean(resolved.keepBrowser),
      },
    };
    const next: BrowserRuntimeMetadata = {
      ...runtime,
      browserTransport: "cdp",
      chromePid: chrome?.pid,
      chromeProcessIdentity: chrome?.processIdentity,
      chromePort: chrome?.port,
      chromeHost: chrome?.host ?? "127.0.0.1",
      chromeBrowserWSEndpoint: undefined,
      chromeProfileRoot: userDataDir,
      userDataDir,
      chromeTargetId: fallbackTargetId ?? undefined,
      recoveryCleanupResources: hasNewAuthority
        ? [...inheritedRecoveryCleanupResources, resource]
        : inheritedRecoveryCleanupResources,
      recoveryCleanupResult: hasNewAuthority
        ? { status: "pending" }
        : runtime.recoveryCleanupResult,
      controllerPid: process.pid,
    };
    delete next.remoteRecovery;
    fallbackRuntime = next;
    return next;
  };

  refreshFallbackRuntime();
  try {
    if (manualLogin) {
      fallbackLease = await acquireBrowserTabLease(userDataDir, {
        maxConcurrentTabs: resolved.maxConcurrentTabs,
        timeoutMs: resolved.timeoutMs,
        logger,
        sessionId: `reattach-${process.pid}`,
      });
      refreshFallbackRuntime();
    }
    if (manualLogin) {
      const owner = await (deps.acquireManualChromeOwner ?? acquireManualChromeOwner)(
        userDataDir,
        resolved,
        logger,
        `reattach-${process.pid}`,
      );
      chrome = owner.chrome;
    } else {
      chrome = await launchChrome(resolved, userDataDir, logger);
    }
    refreshFallbackRuntime();
    const chromeHost = chrome.host ?? "127.0.0.1";
    const recoveryConnection = await createOwnedRecoveryTargetConnection(
      chrome,
      logger,
      deps,
      (targetId) => {
        fallbackTargetId = targetId;
        refreshFallbackRuntime();
      },
      () => {
        fallbackTargetId = null;
        refreshFallbackRuntime();
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
    return {
      answerText,
      answerMarkdown,
      runtime: fallbackRuntime ?? refreshFallbackRuntime(),
    };
  } catch (error) {
    if (closeFallbackConnection) {
      await closeFallbackConnection().catch(() => undefined);
      closeFallbackConnection = null;
    } else {
      await client?.close().catch(() => undefined);
    }
    client = null;
    const authorityRuntime = fallbackRuntime ?? refreshFallbackRuntime();
    let cleanupResult: ReattachFinalizationResult;
    try {
      cleanupResult = await finalizeRecoveredRuntime(
        authorityRuntime,
        logger,
        deps.recoveryCleanup,
        "abort",
      );
    } catch (cleanupError) {
      cleanupResult = pendingFinalization(
        authorityRuntime,
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
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

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  openConversationFromSidebar,
  finalizeRecoveredRuntime,
  recoveryCleanupGroupKey,
  defaultRecoveryLockPath,
  createOwnedRecoveryTargetConnection,
};
