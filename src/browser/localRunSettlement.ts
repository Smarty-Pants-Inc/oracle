import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { capturedResultRunStatus } from "./capturedResultPublicationCoordinator.js";
import { closeBlankChromeTabsWithExactAuthority } from "./chromeLifecycle.js";
import { BrowserRunLifecycleController } from "./runLifecycle.js";
import type { BrowserCaptureSettlementMode } from "./ownedBrowserResources.js";
import {
  shouldCleanupBlankTabsAfterLastLease,
  shouldCloseOwnedRunTargetAfterRun,
} from "./promptSubmissionCoordinator.js";
import {
  shouldKeepLocalBrowserOpen,
  shouldPreserveLocalOwnerForRecovery,
} from "./coordinatorPolicy.js";
import { extractStableConversationIdFromUrl as extractConversationIdFromUrl } from "./conversationUrl.js";
import type { LocalBrowserAcquisition } from "./localAcquisition.js";
import type { LocalBrowserRunState } from "./localRunState.js";
import type { BrowserLogger, BrowserRunOptions } from "./types.js";

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
    manualLogin,
    effectiveKeepBrowser,
    chromeOwnerDisposition,
    resourceAuthority,
    config,
  } = acquisition;

  const keepBrowserOpenForRuntime = (): boolean =>
    manualLogin
      ? shouldPreserveLocalOwnerForRecovery({
          effectiveKeepBrowser,
          manualLogin,
          ownerDisposition: chromeOwnerDisposition,
        })
      : shouldKeepLocalBrowserOpen({
          effectiveKeepBrowser,
          preserveBrowserOnError: state.preserveBrowserOnError,
          usingCopiedProfile,
        });
  const buildRuntimeBase = (tabUrl = state.lastUrl): BrowserRuntimeMetadata => {
    const keepBrowser = keepBrowserOpenForRuntime();
    return resourceAuthority.projectRuntime(
      {
        chromeTargetId: state.lastTargetId ?? state.isolatedTargetId ?? undefined,
        ...(tabUrl ? { tabUrl, conversationId: extractConversationIdFromUrl(tabUrl) } : {}),
      },
      {
        keepBrowser,
        closeOwnedTargetOnComplete: shouldCloseOwnedRunTargetAfterRun({
          runStatus: capturedResultRunStatus(state),
          ownsTarget: state.ownsTarget,
          keepBrowser: manualLogin ? effectiveKeepBrowser : keepBrowser,
          closeOwnedTabOnComplete: options.closeOwnedTabOnComplete,
          preserveForRecovery: state.preserveBrowserOnError,
        }),
        ...(tabUrl ? { tabUrl } : {}),
      },
    );
  };
  const keepBrowserOpenForSettlement = (mode: BrowserCaptureSettlementMode): boolean =>
    mode === "abort"
      ? manualLogin
        ? effectiveKeepBrowser || chromeOwnerDisposition === "preserve"
        : shouldKeepLocalBrowserOpen({
            effectiveKeepBrowser: false,
            preserveBrowserOnError: state.preserveBrowserOnError,
            usingCopiedProfile,
          })
      : shouldKeepLocalBrowserOpen({
          effectiveKeepBrowser,
          preserveBrowserOnError: state.preserveBrowserOnError,
          usingCopiedProfile,
        });

  const projectSettlementRuntime = (
    mode: BrowserCaptureSettlementMode,
    runtime: BrowserRuntimeMetadata,
  ): BrowserRuntimeMetadata => {
    const keepBrowser = keepBrowserOpenForSettlement(mode);
    return resourceAuthority.projectRuntime(runtime, {
      keepBrowser,
      closeOwnedTargetOnComplete: shouldCloseOwnedRunTargetAfterRun({
        runStatus: capturedResultRunStatus(state),
        ownsTarget: state.ownsTarget,
        keepBrowser: manualLogin ? effectiveKeepBrowser : effectiveKeepBrowser || keepBrowser,
        closeOwnedTabOnComplete: options.closeOwnedTabOnComplete,
        preserveForRecovery: state.preserveBrowserOnError,
      }),
      ...(state.lastUrl ? { tabUrl: state.lastUrl } : {}),
    });
  };

  resourceAuthority.configureSettlementAdapters(
    {
      beforeProcessSettlement: async () => {
        if (
          !shouldCleanupBlankTabsAfterLastLease({
            runStatus: capturedResultRunStatus(state),
            ownsTarget: state.ownsTarget,
            connectionClosedUnexpectedly: state.connectionClosedUnexpectedly,
            manualLogin,
            keepBrowser: effectiveKeepBrowser,
            chromePort: chrome.port,
          })
        ) {
          return;
        }
        const endpointAuthority = resourceAuthority.endpointAuthority();
        if (!endpointAuthority) {
          throw new Error("Blank-tab cleanup has no retained exact endpoint authority");
        }
        const cleanup = await closeBlankChromeTabsWithExactAuthority(endpointAuthority, logger, {
          excludeTargetIds: [state.isolatedTargetId, state.lastTargetId],
          preserveOneBlank: true,
        });
        if (cleanup.status === "unsafe") {
          throw new Error(`Blank-tab cleanup failed: ${cleanup.reason}`);
        }
      },
      onActiveLeaseHandoff: () => {
        logger("[browser] Other ChatGPT tab leases still active; leaving shared Chrome running.");
      },
      onLeaseSettled: () => {
        state.tabLease = null;
      },
    },
    projectSettlementRuntime,
  );

  const settleLocalResources = async (
    mode: BrowserCaptureSettlementMode,
    pendingRuntime: BrowserRuntimeMetadata,
  ) => {
    const keepBrowserOpen = keepBrowserOpenForSettlement(mode);
    const result = await resourceAuthority.settleResources(mode, pendingRuntime);
    state.tabLease = resourceAuthority.acquiredLease();
    if (result.status === "completed" && !keepBrowserOpen && !state.connectionClosedUnexpectedly) {
      const totalSeconds = (Date.now() - timing.startedAt) / 1000;
      logger(`Cleanup ${capturedResultRunStatus(state)} • ${totalSeconds.toFixed(1)}s total`);
    }
    return result;
  };

  const lifecycle = new BrowserRunLifecycleController(
    {
      ...(options.runtimeHintCb ? { ownerId: resourceAuthority.ownerIdValue() } : {}),
      getRuntime: () => buildRuntimeBase(),
      projectSettlementRuntime,
      persistRuntime: async (runtime) => {
        if (!chrome.port || !options.runtimeHintCb) return;
        await options.runtimeHintCb(runtime, state.modelSelectionEvidence);
      },
      persistSettlementResult: async (runtime) => {
        if (!chrome.port || !options.runtimeHintCb) return;
        await options.runtimeHintCb(runtime, state.modelSelectionEvidence);
      },
      settleResources: settleLocalResources,
      onPromptCommitted: () => {
        void state.conversationUrlMonitor?.schedule("post-submit", config.timeoutMs ?? 120_000);
      },
    },
    acquisition.resourceTransaction,
  );
  const buildRuntimeMetadata = (tabUrl = state.lastUrl): BrowserRuntimeMetadata =>
    lifecycle.runtime(buildRuntimeBase(tabUrl));
  const emitRuntimeHint = async (): Promise<void> => {
    if (!chrome.port) return;
    try {
      await options.runtimeHintCb?.(buildRuntimeMetadata(), state.modelSelectionEvidence);
      await resourceAuthority.acquiredLease()?.update({
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
