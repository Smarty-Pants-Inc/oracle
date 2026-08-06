import type {
  BrowserAttachment,
  BrowserLogger,
  BrowserRunOptions,
  BrowserRunTransaction,
  ResolvedBrowserConfig,
} from "./types.js";
import { registerTerminationHooks } from "./chromeLifecycle.js";
import {
  assertManualLoginProfileReadyForRun,
  formatManualLoginSetupCommand,
  isManualLoginProfileInitialized,
  resolveManualLoginWaitMs,
} from "./manualLoginProfile.js";
import {
  listIgnoredRemoteChromeFlags,
  normalizeAuthenticatedModelSelectionError,
  shouldKeepLocalBrowserOpen,
  shouldPreserveLocalOwnerForRecovery,
} from "./coordinatorPolicy.js";
import {
  classifyChatGptUiWarningText,
  collectChatGptUiWarnings,
  createAssistantTimeoutError,
} from "./browserFailureProjection.js";
import {
  isAssistantResponseTimeoutError,
  isImageOnlyUiChromeText,
  waitForAssistantResponseWithReload,
} from "./responseCaptureCoordinator.js";
import {
  closeRemoteConnectionAfterRun,
  resolveAttachmentUploadTimeoutMs,
  shouldCleanupBlankTabsAfterLastLease,
  shouldCloseOwnedRunTargetAfterRun,
} from "./promptSubmissionCoordinator.js";
import { unpublishedCleanupPendingError } from "./archiveSettlementCoordinator.js";
import { detachKeptChromeProcess } from "./localExecutionContext.js";
import { acquireLocalBrowserResources } from "./localAcquisition.js";
import { createLocalBrowserRunState } from "./localRunState.js";
import { createLocalRunSettlementCoordinator } from "./localRunSettlement.js";
import { acquireExactLocalBrowserTarget } from "./localTargetAcquisition.js";
import {
  createLocalDisconnectCoordinator,
  recoverLocalBrowserFailure,
  type LocalDisconnectCoordinator,
} from "./localDisconnectRecovery.js";
import { executeLocalPrompt } from "./localPromptExecution.js";
import { captureLocalBrowserResponse } from "./localResponseExecution.js";
import { publishLocalBrowserResult } from "./localResultPublication.js";
import { isCapturedResultPublicationInFlight } from "./capturedResultPublicationCoordinator.js";

export interface LocalBrowserRunContext {
  options: BrowserRunOptions;
  promptText: string;
  attachments: BrowserAttachment[];
  config: ResolvedBrowserConfig;
  logger: BrowserLogger;
  usingCopiedProfile: boolean;
  isResumingConversation: boolean;
  followUpPrompts: string[];
}

export async function runLocalBrowserMode({
  options,
  promptText,
  attachments,
  config,
  logger,
  usingCopiedProfile,
  isResumingConversation,
  followUpPrompts,
}: LocalBrowserRunContext): Promise<BrowserRunTransaction> {
  const acquisition = await acquireLocalBrowserResources({
    options,
    config,
    logger,
    usingCopiedProfile,
  });
  config = acquisition.config;
  const state = createLocalBrowserRunState(acquisition.tabLease);
  const timing = { startedAt: 0 };
  const settlement = createLocalRunSettlementCoordinator({
    acquisition,
    state,
    options,
    logger,
    usingCopiedProfile,
    timing,
  });
  const { lifecycle, buildRuntimeBase, buildRuntimeMetadata, emitRuntimeHint } = settlement;

  let removeTerminationHooks: (() => void) | null = null;
  try {
    removeTerminationHooks = registerTerminationHooks(
      acquisition.chrome,
      acquisition.userDataDir,
      acquisition.effectiveKeepBrowser ||
        (acquisition.manualLogin && acquisition.chromeOwnerDisposition === "preserve"),
      logger,
      {
        isInFlight: () => isCapturedResultPublicationInFlight(state),
        emitRuntimeHint,
        preserveUserDataDir: acquisition.manualLogin,
        // copy-profile is a throwaway copy of a signed-in profile; never leave it on disk.
        forceProfileCleanup: usingCopiedProfile,
      },
    );
  } catch {
    // Cleanup still happens through lifecycle settlement.
  }
  timing.startedAt = Date.now();

  let disconnect: LocalDisconnectCoordinator | null = null;
  try {
    await acquireExactLocalBrowserTarget({
      acquisition,
      state,
      logger,
      publishRuntime: async () => {
        await options.runtimeHintCb?.(buildRuntimeMetadata(), state.modelSelectionEvidence);
      },
    });
    disconnect = createLocalDisconnectCoordinator({
      acquisition,
      state,
      lifecycle,
      config,
      logger,
      usingCopiedProfile,
      buildRuntimeMetadata,
    });
    const prompt = await executeLocalPrompt({
      acquisition,
      state,
      lifecycle,
      disconnect,
      options,
      promptText,
      attachments,
      logger,
      isResumingConversation,
      followUpPrompts,
      emitRuntimeHint,
    });
    const captured = await captureLocalBrowserResponse({
      acquisition,
      state,
      lifecycle,
      prompt,
      options,
      promptText,
      followUpPrompts,
      logger,
      buildRuntimeMetadata,
      emitRuntimeHint,
    });
    return await publishLocalBrowserResult({
      acquisition,
      state,
      lifecycle,
      prompt,
      captured,
      options,
      promptText,
      followUpPrompts,
      logger,
      startedAt: timing.startedAt,
      buildRuntimeMetadata,
    });
  } catch (error) {
    return await recoverLocalBrowserFailure(
      {
        acquisition,
        state,
        lifecycle,
        disconnect,
        config,
        logger,
        usingCopiedProfile,
        followUpPrompts,
        buildRuntimeBase,
        buildRuntimeMetadata,
        emitRuntimeHint,
      },
      error,
    );
  } finally {
    await state.conversationUrlMonitor?.stop();
    try {
      if (!state.connectionClosedUnexpectedly) {
        await state.client?.close();
      }
    } catch {
      // ignore
    }
    state.removeDialogHandler?.();
    removeTerminationHooks?.();
    const finalization = await lifecycle.settleIfUnpublished();
    if (finalization?.status === "pending") {
      // Cleanup authority deliberately supersedes the run outcome; the original failure is its cause.
      await Promise.reject(unpublishedCleanupPendingError(finalization, state.escapingFailure));
    }
  }
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  assertManualLoginProfileReadyForRun,
  closeRemoteConnectionAfterRun,
  classifyChatGptUiWarningText,
  collectChatGptUiWarnings,
  createAssistantTimeoutError,
  unpublishedCleanupPendingError,
  detachKeptChromeProcess,
  formatManualLoginSetupCommand,
  isAssistantResponseTimeoutError,
  isManualLoginProfileInitialized,
  isImageOnlyUiChromeText,
  listIgnoredRemoteChromeFlags,
  normalizeAuthenticatedModelSelectionError,
  resolveAttachmentUploadTimeoutMs,
  resolveManualLoginWaitMs,
  shouldCleanupBlankTabsAfterLastLease,
  shouldCloseOwnedRunTargetAfterRun,
  shouldKeepLocalBrowserOpen,
  shouldPreserveLocalOwnerForRecovery,
  waitForAssistantResponseWithReload,
};
