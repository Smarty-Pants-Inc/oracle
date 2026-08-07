import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserLogger } from "./types.js";
import {
  acknowledgeSettledTargetCloseCapabilities,
  markBrowserCaptureCleanupPending,
  OwnedBrowserResourceTransaction,
} from "./ownedBrowserResources.js";
import {
  defaultRecoveryLockPath,
  finalizeRecoveredRuntime,
  pendingFinalization,
  type ReattachFinalizationResult,
} from "./reattachCleanup.js";
import {
  assertSameCommittedPromptEpoch,
  requireCommittedPromptEpochLocator,
} from "./reattachAcquisition.js";
import { acquireReattachRecoveryLock, type ReattachRecoveryLock } from "./reattachLock.js";
import type { CommittedPromptEpochLocator } from "./reattachability.js";
import { hasPendingPromptEpoch } from "./reattachability.js";
import { recoveryCleanupResourceKey } from "./recoveryCleanupIdentity.js";
import type { ReattachCapture, ReattachDeps, ReattachResult } from "./reattachContracts.js";

export interface ReattachSettlementLockAuthority {
  ensure: () => Promise<void>;
  release: (finalize?: () => Promise<void>) => Promise<void>;
}

export type BrowserRecoveryPersistenceOutcome =
  | { status: "persisted" }
  | { status: "pending"; error: string; runtime: BrowserRuntimeMetadata };

export interface BrowserRecoverySettlementOutcome {
  finalization: ReattachFinalizationResult;
  persistence: BrowserRecoveryPersistenceOutcome;
}

export type BrowserRecoverySettlementMode = "finalize" | "abort";

type ReattachPromptLocatorResolver = (
  runtime: BrowserRuntimeMetadata,
) => CommittedPromptEpochLocator;

export interface RetryBrowserRecoveryCleanupDeps extends Pick<
  ReattachDeps,
  "recoveryCleanup" | "recoveryLockPath" | "acquireRecoveryLock" | "isRemotePublicationAcknowledged"
> {
  ownerId?: string;
  loadRuntimeUnderLock?: () => Promise<BrowserRuntimeMetadata>;
  persistFinalizationResult?: (
    result: ReattachFinalizationResult,
    beforeRuntime: BrowserRuntimeMetadata,
    mode: BrowserRecoverySettlementMode,
  ) => Promise<ReattachFinalizationResult>;
  completeFinalizationAfterLockRelease?: (
    result: ReattachFinalizationResult,
    beforeRuntime: BrowserRuntimeMetadata,
    mode: BrowserRecoverySettlementMode,
  ) => Promise<ReattachFinalizationResult>;
}

export interface BrowserRecoverySettlementDeps extends RetryBrowserRecoveryCleanupDeps {
  finalizeRuntime?: (
    runtime: BrowserRuntimeMetadata,
    mode: BrowserRecoverySettlementMode,
  ) => Promise<ReattachFinalizationResult>;
}

const RECOVERY_LOCK_RELEASE_PENDING =
  "Browser cleanup completed, but recovery lock release remains pending";
export function bindCurrentBrowserRecoveryRuntime(
  proposedRuntime: BrowserRuntimeMetadata,
  currentRuntime: BrowserRuntimeMetadata,
  resolvePromptLocator: ReattachPromptLocatorResolver = requireCommittedPromptEpochLocator,
): BrowserRuntimeMetadata {
  const requestedMode = proposedRuntime.recoveryCleanupResult?.settlementMode;
  const proposedHasCleanupAuthority = Boolean(
    proposedRuntime.recoveryCleanupResources?.length || proposedRuntime.recoveryCleanupResult,
  );
  if (!requestedMode && proposedHasCleanupAuthority) {
    throw new BrowserAutomationError(
      "Browser recovery settlement mode is missing during binding.",
      {
        stage: "browser-recovery-settlement",
        code: "settlement-mode-missing",
        runtime: currentRuntime,
      },
    );
  }
  const currentMode = currentRuntime.recoveryCleanupResult?.settlementMode;
  if (currentMode && requestedMode && currentMode !== requestedMode) {
    throw new BrowserAutomationError(
      `Browser recovery is already bound to ${currentMode} settlement.`,
      {
        code: "browser-run-lifecycle-settlement-conflict",
        requestedMode,
        currentMode,
        runtime: currentRuntime,
      },
    );
  }
  const proposedHasCommittedPrompt = proposedRuntime.promptEpoch?.status === "committed";
  const currentHasCommittedPrompt = currentRuntime.promptEpoch?.status === "committed";
  if (proposedHasCommittedPrompt !== currentHasCommittedPrompt) {
    throw new BrowserAutomationError("Browser recovery prompt authority changed while queued.", {
      stage: "browser-recovery-settlement",
      code: "committed-prompt-identity-mismatch",
      runtime: currentRuntime,
    });
  }
  if (proposedHasCommittedPrompt && currentHasCommittedPrompt) {
    assertSameCommittedPromptEpoch(
      resolvePromptLocator(proposedRuntime),
      resolvePromptLocator(currentRuntime),
    );
  }
  if (
    !requestedMode ||
    (!currentRuntime.recoveryCleanupResources?.length && !currentRuntime.recoveryCleanupResult)
  ) {
    return currentRuntime;
  }
  return markBrowserCaptureCleanupPending(currentRuntime, requestedMode);
}

export function createReattachSettlement(
  capture: ReattachCapture,
  authoritativeRuntime: BrowserRuntimeMetadata,
  expectedPromptLocator: CommittedPromptEpochLocator | null,
  logger: BrowserLogger,
  deps: ReattachDeps,
  lockAuthority: ReattachSettlementLockAuthority,
  resolvePromptLocator: ReattachPromptLocatorResolver = requireCommittedPromptEpochLocator,
): ReattachResult {
  const { runtime: captureRuntime, finalizeResources, abortResources, ...capturedResult } = capture;
  const ownerId = deps.sessionId?.trim();
  const runtimeForCapture = markBrowserCaptureCleanupPending(
    captureRuntime ?? authoritativeRuntime,
  );
  const captureLocator = resolvePromptLocator(runtimeForCapture);
  if (expectedPromptLocator) assertSameCommittedPromptEpoch(expectedPromptLocator, captureLocator);
  const persistRuntime = async (
    result: ReattachFinalizationResult,
  ): Promise<ReattachFinalizationResult> => {
    await deps.runtimeHintCb?.(result.runtime);
    return result;
  };
  let captureCleanupRuntime = runtimeForCapture;
  const settlement = new OwnedBrowserResourceTransaction(
    {
      ownerId,
      persistRuntime: async (pendingRuntime) => {
        await lockAuthority.ensure();
        try {
          const currentRuntime = await (deps.loadRuntimeUnderLock?.() ??
            Promise.resolve(pendingRuntime));
          const authoritativeBoundRuntime = bindCurrentBrowserRecoveryRuntime(
            pendingRuntime,
            currentRuntime,
            resolvePromptLocator,
          );
          await deps.runtimeHintCb?.(authoritativeBoundRuntime);
          return authoritativeBoundRuntime;
        } catch (error) {
          await lockAuthority.release().catch((lockError) => {
            logger(
              `Failed to release recovery lock after runtime persistence error: ${lockError instanceof Error ? lockError.message : String(lockError)}`,
            );
          });
          throw error;
        }
      },
      settleResources: async (mode, pendingRuntime) => {
        const outcome = await settleBrowserRecoveryCleanup(
          pendingRuntime,
          logger,
          {
            ownerId,
            recoveryCleanup: deps.recoveryCleanup,
            isRemotePublicationAcknowledged: deps.isRemotePublicationAcknowledged,
            acquireRecoveryLock: async () => {
              await lockAuthority.ensure();
              return { release: lockAuthority.release };
            },
            loadRuntimeUnderLock: deps.loadRuntimeUnderLock ?? (async () => pendingRuntime),
            persistFinalizationResult: deps.persistFinalizationResult ?? persistRuntime,
            completeFinalizationAfterLockRelease:
              deps.completeFinalizationAfterLockRelease ?? persistRuntime,
            finalizeRuntime: async (runtime, settlementMode) => {
              const captureSettler =
                settlementMode === "abort"
                  ? (abortResources ?? finalizeResources)
                  : finalizeResources;
              if (
                captureSettler &&
                recoveryCleanupAuthoritiesMatch(captureCleanupRuntime, runtime)
              ) {
                const result = await captureSettler();
                captureCleanupRuntime = result.runtime;
                return result;
              }
              return finalizeRecoveredRuntime(
                runtime,
                logger,
                {
                  ...deps.recoveryCleanup,
                  ownerId,
                  isRemotePublicationAcknowledged: deps.isRemotePublicationAcknowledged,
                },
                settlementMode,
              );
            },
          },
          mode,
        );
        return finalizationForLegacyCaller(outcome, mode);
      },
    },
    runtimeForCapture,
  );

  const result = {
    ...capturedResult,
    answerText: capture.answerText,
    answerMarkdown: capture.answerMarkdown,
    get runtime() {
      return settlement.runtime();
    },
    bindSettlement: (mode: BrowserRecoverySettlementMode) => settlement.bindSettlement(mode),
    releaseSettlementLock: () => lockAuthority.release(),
    finalize: () => settlement.settle("finalize"),
    abort: () => settlement.settle("abort"),
  };
  return result;
}

export async function settleBrowserRecoveryCleanup(
  runtime: BrowserRuntimeMetadata,
  logger: BrowserLogger,
  deps: BrowserRecoverySettlementDeps = {},
  requestedMode?: BrowserRecoverySettlementMode,
): Promise<BrowserRecoverySettlementOutcome> {
  const ownerId = deps.ownerId?.trim() ?? "";
  const lockPath = deps.recoveryLockPath ?? (await defaultRecoveryLockPath(runtime));
  let recoveryLock: ReattachRecoveryLock;
  try {
    recoveryLock = await (deps.acquireRecoveryLock ?? acquireReattachRecoveryLock)(lockPath);
  } catch (error) {
    const mode = requestedMode ?? runtime.recoveryCleanupResult?.settlementMode ?? "finalize";
    const message = `Browser recovery lock remains pending: ${error instanceof Error ? error.message : String(error)}`;
    const finalization = pendingFinalization(runtime, message, mode);
    return {
      finalization,
      persistence: { status: "pending", error: message, runtime: finalization.runtime },
    };
  }

  let currentRuntime: BrowserRuntimeMetadata;
  try {
    currentRuntime = await (deps.loadRuntimeUnderLock?.() ?? Promise.resolve(runtime));
  } catch (error) {
    await recoveryLock.release().catch(() => undefined);
    const mode = requestedMode ?? runtime.recoveryCleanupResult?.settlementMode ?? "finalize";
    const message = `Browser recovery authority reload failed: ${error instanceof Error ? error.message : String(error)}`;
    const finalization = pendingFinalization(runtime, message, mode);
    return {
      finalization,
      persistence: { status: "pending", error: message, runtime: finalization.runtime },
    };
  }
  if (hasPendingPromptEpoch(currentRuntime)) {
    await recoveryLock.release().catch(() => undefined);
    const error = "Pending prompt dispatch must be reconciled before browser recovery settlement.";
    return {
      finalization: { status: "pending", runtime: currentRuntime, error },
      persistence: { status: "persisted" },
    };
  }

  const persistedMode = currentRuntime.recoveryCleanupResult?.settlementMode;
  const hasCleanupAuthority = Boolean(
    currentRuntime.recoveryCleanupResources?.length || currentRuntime.recoveryCleanupResult,
  );
  if (!requestedMode && !persistedMode && hasCleanupAuthority) {
    await recoveryLock.release().catch(() => undefined);
    throw new BrowserAutomationError(
      "Browser recovery cleanup has no authoritative settlement mode.",
      {
        stage: "browser-recovery-settlement",
        code: "settlement-mode-missing",
        runtime: currentRuntime,
      },
    );
  }
  const settlementMode = persistedMode ?? requestedMode ?? "finalize";
  if (persistedMode && requestedMode && persistedMode !== requestedMode) {
    await recoveryLock.release().catch(() => undefined);
    throw new BrowserAutomationError(
      `Browser recovery is already bound to ${persistedMode} settlement.`,
      {
        stage: "browser-recovery-settlement",
        code: "settlement-mode-conflict",
        runtime: currentRuntime,
      },
    );
  }

  let cleanupResult: ReattachFinalizationResult;
  if (currentRuntime.recoveryCleanupResult?.lockReleasePending) {
    const completedRuntime = { ...currentRuntime };
    delete completedRuntime.recoveryCleanupResources;
    delete completedRuntime.recoveryCleanupResult;
    cleanupResult = { status: "completed", runtime: completedRuntime };
  } else {
    try {
      cleanupResult = await (deps.finalizeRuntime
        ? deps.finalizeRuntime(currentRuntime, settlementMode)
        : finalizeRecoveredRuntime(
            currentRuntime,
            logger,
            {
              ...deps.recoveryCleanup,
              ownerId,
              isRemotePublicationAcknowledged: deps.isRemotePublicationAcknowledged,
            },
            settlementMode,
          ));
    } catch (error) {
      const errorRuntime =
        error instanceof BrowserAutomationError &&
        typeof error.details?.runtime === "object" &&
        error.details.runtime !== null
          ? (error.details.runtime as BrowserRuntimeMetadata)
          : currentRuntime;
      cleanupResult = pendingFinalization(
        errorRuntime,
        error instanceof Error ? error.message : String(error),
        settlementMode,
      );
    }
  }

  const requiresReleaseCompletion = hasCleanupAuthority && cleanupResult.status === "completed";
  let underLockResult: ReattachFinalizationResult = cleanupResult;
  if (hasCleanupAuthority && cleanupResult.status === "completed") {
    underLockResult = pendingLockReleaseFinalization(cleanupResult, currentRuntime, settlementMode);
  }
  let durableUnderLock = underLockResult;
  if (hasCleanupAuthority && deps.persistFinalizationResult) {
    try {
      durableUnderLock = await deps.persistFinalizationResult(
        underLockResult,
        currentRuntime,
        settlementMode,
      );
      await acknowledgeSettledTargetCloseCapabilities(
        currentRuntime,
        durableUnderLock.runtime,
        ownerId,
      );
    } catch (error) {
      const message = `Browser cleanup finished but its durable result remains pending: ${error instanceof Error ? error.message : String(error)}`;
      await recoveryLock.release().catch(() => undefined);
      return {
        finalization: cleanupResult,
        persistence: { status: "pending", error: message, runtime: currentRuntime },
      };
    }
  }

  let releasedFinalization = cleanupResult;
  let releaseCompletionRan = false;
  const completeRelease = async (): Promise<void> => {
    if (!requiresReleaseCompletion) return;
    releaseCompletionRan = true;
    const completeProjection =
      deps.completeFinalizationAfterLockRelease ?? deps.persistFinalizationResult;
    releasedFinalization = completeProjection
      ? await completeProjection(cleanupResult, currentRuntime, settlementMode)
      : cleanupResult;
    if (completeProjection) {
      await acknowledgeSettledTargetCloseCapabilities(
        currentRuntime,
        releasedFinalization.runtime,
        ownerId,
      );
    }
  };
  try {
    await recoveryLock.release(requiresReleaseCompletion ? completeRelease : undefined);
    if (requiresReleaseCompletion && !releaseCompletionRan) await completeRelease();
  } catch (error) {
    const message = `Cleanup finished but recovery lock release remains pending: ${error instanceof Error ? error.message : String(error)}`;
    return {
      finalization: cleanupResult,
      persistence: { status: "pending", error: message, runtime: durableUnderLock.runtime },
    };
  }

  return {
    finalization: releasedFinalization,
    persistence: { status: "persisted" },
  };
}

export async function retryBrowserRecoveryCleanup(
  runtime: BrowserRuntimeMetadata,
  logger: BrowserLogger,
  deps: RetryBrowserRecoveryCleanupDeps = {},
  mode?: BrowserRecoverySettlementMode,
): Promise<ReattachFinalizationResult> {
  return finalizationForLegacyCaller(
    await settleBrowserRecoveryCleanup(runtime, logger, deps, mode),
    mode ?? runtime.recoveryCleanupResult?.settlementMode ?? "finalize",
  );
}

function recoveryCleanupAuthoritiesMatch(
  capturedRuntime: BrowserRuntimeMetadata,
  currentRuntime: BrowserRuntimeMetadata,
): boolean {
  const capturedResources = capturedRuntime.recoveryCleanupResources ?? [];
  const currentResources = currentRuntime.recoveryCleanupResources ?? [];
  return (
    capturedResources.length === currentResources.length &&
    capturedResources.every(
      (resource, index) =>
        recoveryCleanupResourceKey(resource) ===
        recoveryCleanupResourceKey(currentResources[index]!),
    )
  );
}

function pendingLockReleaseFinalization(
  finalization: Extract<ReattachFinalizationResult, { status: "completed" }>,
  beforeRuntime: BrowserRuntimeMetadata,
  mode: BrowserRecoverySettlementMode,
): ReattachFinalizationResult {
  return {
    status: "pending",
    runtime: {
      ...finalization.runtime,
      ...(beforeRuntime.recoveryCleanupResources?.length
        ? { recoveryCleanupResources: beforeRuntime.recoveryCleanupResources }
        : {}),
      recoveryCleanupResult: {
        status: "pending",
        error: RECOVERY_LOCK_RELEASE_PENDING,
        settlementMode: mode,
        lockReleasePending: true,
      },
    },
    error: RECOVERY_LOCK_RELEASE_PENDING,
  };
}

function finalizationForLegacyCaller(
  outcome: BrowserRecoverySettlementOutcome,
  mode: BrowserRecoverySettlementMode,
): ReattachFinalizationResult {
  if (outcome.persistence.status === "persisted") return outcome.finalization;
  return pendingFinalization(outcome.persistence.runtime, outcome.persistence.error, mode);
}
