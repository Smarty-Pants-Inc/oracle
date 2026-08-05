import type {
  BrowserRecoveryCleanupMetadata,
  BrowserRecoveryTargetCloseCapabilityMetadata,
} from "../sessionManager.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { closeBlankChromeTabsWithExactAuthority } from "./chromeLifecycle.js";
import {
  releaseManualChromeOwnerEndpointAuthority,
  settleManualChromeOwner,
} from "./manualChromeOwner.js";
import {
  isSafeChromeTerminationOutcome,
  removeProfileDirectoryIfIdentityMatches,
} from "./profileState.js";
import {
  completedBrowserCaptureCleanup,
  pendingBrowserCaptureCleanup,
  projectBrowserRetryableCleanupRuntime,
  BrowserRunLifecycleController,
  type BrowserCaptureSettlementMode,
} from "./runLifecycle.js";
import {
  shouldCleanupBlankTabsAfterLastLease,
  shouldCloseOwnedRunTargetAfterRun,
} from "./promptSubmissionCoordinator.js";
import {
  shouldKeepLocalBrowserOpen,
  shouldPreserveLocalOwnerForRecovery,
} from "./coordinatorPolicy.js";
import { detachKeptChromeProcess } from "./localExecutionContext.js";
import { extractStableConversationIdFromUrl as extractConversationIdFromUrl } from "./conversationUrl.js";
import type { LocalBrowserAcquisition } from "./localAcquisition.js";
import type { LocalBrowserRunState } from "./localRunState.js";
import type {
  BrowserCaptureFinalizationResult,
  BrowserLogger,
  BrowserRunOptions,
} from "./types.js";
import { closeChromeTargetWithRetainedCapability } from "./targetCloseAuthority.js";

export interface LocalRunSettlementContext {
  acquisition: LocalBrowserAcquisition;
  state: LocalBrowserRunState;
  options: BrowserRunOptions;
  logger: BrowserLogger;
  usingCopiedProfile: boolean;
  timing: { startedAt: number };
}

export interface LocalRunSettlementCoordinator {
  lifecycle: BrowserRunLifecycleController;
  buildRuntimeBase: (tabUrl?: string) => BrowserRuntimeMetadata;
  buildRuntimeMetadata: (tabUrl?: string) => BrowserRuntimeMetadata;
  emitRuntimeHint: () => Promise<void>;
}

export function createLocalRunSettlementCoordinator({
  acquisition,
  state,
  options,
  logger,
  usingCopiedProfile,
  timing,
}: LocalRunSettlementContext): LocalRunSettlementCoordinator {
  const {
    chrome,
    chromeHost,
    userDataDir,
    manualLogin,
    effectiveKeepBrowser,
    acquisitionGenerationId,
    acquisitionLaunchClaim,
    acquisitionOwnerDisposition,
    acquisitionTargetMarkerUrl,
    acquisitionProfileIdentity,
    chromeOwner,
    chromeOwnerDisposition,
    settlementEndpointAuthority,
    manualLeaseTeardownAuthority,
    config,
  } = acquisition;

  const buildLocalRecoveryCleanupMetadata = (): BrowserRecoveryCleanupMetadata => ({
    ownsTarget: state.ownsTarget,
    profileKind: manualLogin ? "manual-login" : usingCopiedProfile ? "copied" : "temporary",
    keepBrowser: shouldPreserveLocalOwnerForRecovery({
      effectiveKeepBrowser,
      manualLogin,
      ownerDisposition: chromeOwnerDisposition,
    }),
    closeOwnedTargetOnComplete: shouldCloseOwnedRunTargetAfterRun({
      runStatus: state.runStatus,
      ownsTarget: state.ownsTarget,
      keepBrowser: effectiveKeepBrowser,
      closeOwnedTabOnComplete: options.closeOwnedTabOnComplete,
      preserveForRecovery: state.preserveBrowserOnError,
    }),
  });

  const buildRuntimeBase = (tabUrl = state.lastUrl): BrowserRuntimeMetadata => ({
    chromePid: chrome.pid,
    chromeProcessIdentity: chrome.processIdentity,
    chromePort: chrome.port,
    chromeHost,
    chromeBrowserWSEndpoint: settlementEndpointAuthority?.browserWSEndpoint,
    chromeProfileRoot: userDataDir,
    userDataDir,
    chromeTargetId: state.lastTargetId ?? state.isolatedTargetId ?? undefined,
    tabUrl,
    conversationId: tabUrl ? extractConversationIdFromUrl(tabUrl) : undefined,
    recoveryCleanupResources: [
      {
        chromePid: chrome.pid,
        chromeProcessIdentity: chrome.processIdentity,
        profileDirectoryIdentity:
          chrome.processIdentity?.profileDirectory ?? acquisitionProfileIdentity,
        chromePort: chrome.port,
        chromeHost,
        chromeBrowserWSEndpoint: settlementEndpointAuthority?.browserWSEndpoint,
        chromeProfileRoot: userDataDir,
        userDataDir,
        chromeTargetId: state.lastTargetId ?? state.isolatedTargetId ?? undefined,
        targetCloseCapability: state.ownsTarget ? state.targetCloseCapability : undefined,
        conversationId: tabUrl ? extractConversationIdFromUrl(tabUrl) : undefined,
        tabLease: state.tabLease
          ? { id: state.tabLease.id, profileDirectory: state.tabLease.profileDirectory }
          : undefined,
        acquisition: {
          generationId: acquisitionGenerationId,
          processOwnerProvenance: manualLogin ? "manual-canonical-owner" : "temporary-launch",
          processLaunchClaim: acquisitionLaunchClaim,
          processOwnerDisposition: acquisitionOwnerDisposition,
          ...(config.browserTabRef ? {} : { targetMarkerUrl: acquisitionTargetMarkerUrl }),
        },
        recoveryCleanup: buildLocalRecoveryCleanupMetadata(),
      },
    ],
    controllerPid: process.pid,
  });

  let manualOwnerSettled = false;
  let closedOwnedTargetId: string | null = null;
  let closedOwnedTargetCloseCapability: BrowserRecoveryTargetCloseCapabilityMetadata | null = null;
  let releasedTabLeaseId: string | null = null;

  const settleLocalResources = async (
    mode: BrowserCaptureSettlementMode,
    pendingRuntime: BrowserRuntimeMetadata,
  ): Promise<BrowserCaptureFinalizationResult> => {
    const errors: string[] = [];
    const aborting = mode === "abort";
    const pendingResource = pendingRuntime.recoveryCleanupResources?.[0];
    const pendingCleanup = pendingResource?.recoveryCleanup;
    const pendingOwnsTarget = pendingCleanup?.ownsTarget === true;
    const finalizeTargetCloseDecision = pendingCleanup?.closeOwnedTargetOnComplete;
    if (!aborting && pendingOwnsTarget && typeof finalizeTargetCloseDecision !== "boolean") {
      return pendingBrowserCaptureCleanup(
        pendingRuntime,
        "Owned Chrome target finalize disposition is missing",
      );
    }
    const targetId = pendingResource?.chromeTargetId ?? null;
    const targetCleanupCompleted = Boolean(targetId && closedOwnedTargetId === targetId);
    const shouldCloseOwnedRunTarget =
      !targetCleanupCompleted &&
      pendingOwnsTarget &&
      (aborting || finalizeTargetCloseDecision === true);
    let keepBrowserOpen = aborting
      ? manualLogin && (effectiveKeepBrowser || chromeOwnerDisposition === "preserve")
      : shouldKeepLocalBrowserOpen({
          effectiveKeepBrowser,
          preserveBrowserOnError: state.preserveBrowserOnError,
          usingCopiedProfile,
        });
    if (shouldCloseOwnedRunTarget) {
      const capability = pendingResource?.targetCloseCapability;
      if (!targetId || !capability) {
        errors.push("Owned Chrome target has no retained exact close capability");
      } else {
        const targetCleanup = await closeChromeTargetWithRetainedCapability({
          capability,
          targetId,
          logger,
        });
        if (targetCleanup.status === "completed" || targetCleanup.status === "gone") {
          closedOwnedTargetId = targetId;
          closedOwnedTargetCloseCapability = capability;
        } else if (manualLogin || keepBrowserOpen) {
          errors.push(targetCleanup.reason);
        }
      }
    }
    if (errors.length > 0) {
      return pendingBrowserCaptureCleanup(
        projectBrowserRetryableCleanupRuntime(pendingRuntime, {
          targetId: closedOwnedTargetId,
          targetCloseCapability: closedOwnedTargetCloseCapability,
          tabLeaseId: releasedTabLeaseId,
        }),
        errors.join("; "),
      );
    }
    const cleanupBlankTabs = async () => {
      if (
        !shouldCleanupBlankTabsAfterLastLease({
          runStatus: state.runStatus,
          ownsTarget: state.ownsTarget,
          connectionClosedUnexpectedly: state.connectionClosedUnexpectedly,
          manualLogin,
          keepBrowser: effectiveKeepBrowser,
          chromePort: chrome.port,
        })
      ) {
        return;
      }
      if (!settlementEndpointAuthority) {
        throw new Error("Blank-tab cleanup has no retained exact endpoint authority");
      }
      const blankCleanup = await closeBlankChromeTabsWithExactAuthority(
        settlementEndpointAuthority,
        logger,
        {
          excludeTargetIds: [state.isolatedTargetId, state.lastTargetId],
          preserveOneBlank: true,
        },
      );
      if (blankCleanup.status === "unsafe") throw new Error(blankCleanup.reason);
    };
    if (manualLogin && !keepBrowserOpen && manualLeaseTeardownAuthority) {
      let teardownError: string | null = null;
      const outcome = await manualLeaseTeardownAuthority.settle(async () => {
        try {
          await cleanupBlankTabs();
        } catch (error) {
          teardownError = `Blank-tab cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
          return false;
        }
        try {
          const settlement = await settleManualChromeOwner(userDataDir, chromeOwner, logger);
          if (settlement.status === "unsafe") {
            teardownError = settlement.reason;
            return false;
          }
          manualOwnerSettled = true;
          if (settlement.status === "preserved") {
            keepBrowserOpen = true;
            logger("[browser] Preserved canonical Chrome owner; leaving shared Chrome running.");
          }
          return true;
        } catch (error) {
          teardownError = `Manual-login teardown failed: ${error instanceof Error ? error.message : String(error)}`;
          return false;
        }
      });
      if (manualLeaseTeardownAuthority.leaseReleased && state.tabLease) {
        releasedTabLeaseId = state.tabLease.id;
        state.tabLease = null;
      }
      if (outcome.status === "completed" && outcome.disposition === "active-lease-handoff") {
        keepBrowserOpen = true;
        logger("[browser] Other ChatGPT tab leases still active; leaving shared Chrome running.");
      } else if (outcome.status === "preserved") {
        keepBrowserOpen = true;
        const reason =
          teardownError ??
          outcome.error ??
          `Manual-login cleanup preserved resources (${outcome.reason})`;
        errors.push(reason);
        logger(`[browser] Preserving shared Chrome resources: ${reason}`);
      }
    } else if (state.tabLease) {
      const handle = state.tabLease;
      try {
        await handle.release({
          onRelease: async ({ isLastLease }) => {
            if (!isLastLease) {
              if (!keepBrowserOpen && manualLogin) {
                keepBrowserOpen = true;
                logger(
                  "[browser] Other ChatGPT tab leases still active; leaving shared Chrome running.",
                );
              }
              return;
            }
            try {
              await cleanupBlankTabs();
            } catch (error) {
              errors.push(
                `Blank-tab cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          },
        });
        releasedTabLeaseId = handle.id;
        state.tabLease = null;
      } catch (error) {
        keepBrowserOpen = true;
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Browser lease release failed: ${message}`);
        logger(`[browser] Browser lease release failed; preserving Chrome resources: ${message}`);
      }
    } else {
      try {
        await cleanupBlankTabs();
      } catch (error) {
        errors.push(
          `Blank-tab cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (manualLogin && !keepBrowserOpen) {
        keepBrowserOpen = true;
        errors.push("Manual-login cleanup has no retained lease teardown authority");
        logger(
          "[browser] Manual-login cleanup has no retained lease teardown authority; preserving Chrome resources.",
        );
      }
    }
    if (
      manualLogin &&
      effectiveKeepBrowser &&
      chromeOwnerDisposition === "close-on-last-lease" &&
      !manualOwnerSettled
    ) {
      try {
        await releaseManualChromeOwnerEndpointAuthority(chromeOwner);
        manualOwnerSettled = true;
      } catch (error) {
        errors.push(
          `Exact Chrome endpoint release failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (manualLogin && chromeOwnerDisposition === "preserve" && !manualOwnerSettled) {
      const settlement = await settleManualChromeOwner(userDataDir, chromeOwner, logger);
      if (settlement.status === "unsafe") {
        keepBrowserOpen = true;
        errors.push(settlement.reason);
        logger(`[browser] Preserving shared Chrome resources: ${settlement.reason}`);
      } else {
        manualOwnerSettled = true;
        keepBrowserOpen = true;
      }
    }
    if (!keepBrowserOpen && !manualLogin) {
      const termination = settlementEndpointAuthority
        ? await settlementEndpointAuthority.kill().catch((terminationError: unknown) => ({
            status: "unsafe" as const,
            pid: chrome.pid,
            reason:
              terminationError instanceof Error
                ? terminationError.message
                : String(terminationError),
          }))
        : {
            status: "unsafe" as const,
            pid: chrome.pid,
            reason: "Chrome teardown has no retained exact endpoint authority",
          };
      if (!isSafeChromeTerminationOutcome(termination)) {
        keepBrowserOpen = true;
        errors.push(termination.reason);
        logger(
          `[browser] Chrome termination was not safely confirmed; preserving its profile directory: ${termination.reason}`,
        );
      } else {
        const removed = await removeProfileDirectoryIfIdentityMatches(
          userDataDir,
          chrome.processIdentity.profileDirectory,
        ).catch(() => false);
        if (!removed) {
          errors.push(`Profile removal was not confirmed: ${userDataDir}`);
          logger(`[browser] Failed to remove temporary Chrome profile ${userDataDir}.`);
        }
      }
    }
    if (keepBrowserOpen && !manualLogin && errors.length === 0 && settlementEndpointAuthority) {
      try {
        await settlementEndpointAuthority.release();
      } catch (error) {
        errors.push(
          `Exact Chrome endpoint release failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!keepBrowserOpen && !state.connectionClosedUnexpectedly) {
      const totalSeconds = (Date.now() - timing.startedAt) / 1000;
      logger(`Cleanup ${state.runStatus} • ${totalSeconds.toFixed(1)}s total`);
    }
    if (keepBrowserOpen) {
      detachKeptChromeProcess(chrome);
      if (!state.connectionClosedUnexpectedly) {
        logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
      }
    }
    const retryableRuntime = projectBrowserRetryableCleanupRuntime(pendingRuntime, {
      targetId: closedOwnedTargetId,
      targetCloseCapability: closedOwnedTargetCloseCapability,
      tabLeaseId: releasedTabLeaseId,
    });
    return errors.length > 0
      ? pendingBrowserCaptureCleanup(retryableRuntime, errors.join("; "))
      : completedBrowserCaptureCleanup(retryableRuntime);
  };

  const lifecycle = new BrowserRunLifecycleController({
    getRuntime: () => buildRuntimeBase(),
    persistRuntime: async (runtime) => {
      if (!chrome.port || !options.runtimeHintCb) return;
      await options.runtimeHintCb(runtime, state.modelSelectionEvidence);
    },
    settleResources: settleLocalResources,
    onPromptCommitted: () => {
      void state.conversationUrlMonitor?.schedule("post-submit", config.timeoutMs ?? 120_000);
    },
  });
  const buildRuntimeMetadata = (tabUrl = state.lastUrl): BrowserRuntimeMetadata =>
    lifecycle.runtime(buildRuntimeBase(tabUrl));
  const emitRuntimeHint = async (): Promise<void> => {
    if (!chrome.port) return;
    try {
      await options.runtimeHintCb?.(buildRuntimeMetadata(), state.modelSelectionEvidence);
      await state.tabLease?.update({
        chromeHost,
        chromePort: chrome.port,
        chromeTargetId: state.lastTargetId,
        tabUrl: state.lastUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
    }
  };

  return {
    lifecycle,
    buildRuntimeBase,
    buildRuntimeMetadata,
    emitRuntimeHint,
  };
}
