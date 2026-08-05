import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserLogger } from "./types.js";
import { markBrowserCaptureCleanupPending } from "./runLifecycle.js";
import { OwnedBrowserResourceTransaction } from "./ownedBrowserResources.js";
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
import type { ReattachCapture, ReattachDeps, ReattachResult } from "./reattachContracts.js";

export interface ReattachSettlementLockAuthority {
  ensure: () => Promise<void>;
  release: () => Promise<void>;
}

export function createReattachSettlement(
  capture: ReattachCapture,
  authoritativeRuntime: BrowserRuntimeMetadata,
  expectedPromptLocator: CommittedPromptEpochLocator | null,
  logger: BrowserLogger,
  deps: ReattachDeps,
  lockAuthority: ReattachSettlementLockAuthority,
): ReattachResult {
  const runtimeForCapture = markBrowserCaptureCleanupPending(
    capture.runtime ?? authoritativeRuntime,
  );
  const captureLocator = requireCommittedPromptEpochLocator(runtimeForCapture);
  if (expectedPromptLocator) assertSameCommittedPromptEpoch(expectedPromptLocator, captureLocator);
  const persistSettlementResult = async (resultRuntime: BrowserRuntimeMetadata): Promise<void> => {
    await deps.runtimeHintCb?.(resultRuntime);
  };
  const settlement = new OwnedBrowserResourceTransaction(
    {
      persistRuntime: async (pendingRuntime) => {
        await lockAuthority.ensure();
        try {
          await deps.runtimeHintCb?.(pendingRuntime);
        } catch (error) {
          await lockAuthority.release().catch((lockError) => {
            logger(
              `Failed to release recovery lock after runtime persistence error: ${lockError instanceof Error ? lockError.message : String(lockError)}`,
            );
          });
          throw error;
        }
      },
      persistSettlementResult,
      settleResources: async (mode, pendingRuntime) => {
        await lockAuthority.ensure();
        let result: ReattachFinalizationResult;
        try {
          const captureSettler =
            mode === "abort"
              ? (capture.abortResources ?? capture.finalizeResources)
              : capture.finalizeResources;
          result = captureSettler
            ? await captureSettler()
            : await finalizeRecoveredRuntime(
                pendingRuntime,
                logger,
                {
                  ...deps.recoveryCleanup,
                  isRemotePublicationAcknowledged: deps.isRemotePublicationAcknowledged,
                },
                mode,
              );
        } catch (error) {
          const errorRuntime =
            error instanceof BrowserAutomationError &&
            typeof error.details?.runtime === "object" &&
            error.details.runtime !== null
              ? (error.details.runtime as BrowserRuntimeMetadata)
              : pendingRuntime;
          result = pendingFinalization(
            errorRuntime,
            error instanceof Error ? error.message : String(error),
            mode,
          );
        }
        try {
          await lockAuthority.release();
        } catch (error) {
          return pendingFinalization(
            result.runtime,
            `Cleanup finished but recovery lock release failed: ${error instanceof Error ? error.message : String(error)}`,
            mode,
          );
        }
        return result;
      },
    },
    runtimeForCapture,
  );

  return {
    answerText: capture.answerText,
    answerMarkdown: capture.answerMarkdown,
    get runtime() {
      return settlement.runtime();
    },
    bindSettlement: (mode) => settlement.bindSettlement(mode),
    finalize: () => settlement.settle("finalize"),
    abort: () => settlement.settle("abort"),
  };
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
  mode?: "finalize" | "abort",
): Promise<ReattachFinalizationResult> {
  const persistedMode = runtime.recoveryCleanupResult?.settlementMode;
  const hasCleanupAuthority = Boolean(
    runtime.recoveryCleanupResources?.length || runtime.recoveryCleanupResult,
  );
  if (!mode && !persistedMode && hasCleanupAuthority) {
    throw new BrowserAutomationError(
      "Browser recovery cleanup has no authoritative settlement mode.",
      {
        stage: "browser-recovery-settlement",
        code: "settlement-mode-missing",
        runtime,
      },
    );
  }
  const settlementMode = mode ?? persistedMode ?? "finalize";
  if (persistedMode && persistedMode !== settlementMode) {
    throw new BrowserAutomationError(
      `Browser recovery is already bound to ${persistedMode} settlement.`,
      {
        stage: "browser-recovery-settlement",
        code: "settlement-mode-conflict",
        runtime,
      },
    );
  }

  const lockPath = deps.recoveryLockPath ?? defaultRecoveryLockPath(runtime);
  let recoveryLock: ReattachRecoveryLock;
  try {
    recoveryLock = await (deps.acquireRecoveryLock ?? acquireReattachRecoveryLock)(lockPath);
  } catch (error) {
    return pendingFinalization(
      runtime,
      `Browser recovery lock remains pending: ${error instanceof Error ? error.message : String(error)}`,
      settlementMode,
    );
  }

  let result: ReattachFinalizationResult;
  try {
    result = await finalizeRecoveredRuntime(
      runtime,
      logger,
      {
        ...deps.recoveryCleanup,
        isRemotePublicationAcknowledged: deps.isRemotePublicationAcknowledged,
      },
      settlementMode,
    );
  } catch (error) {
    const errorRuntime =
      error instanceof BrowserAutomationError &&
      typeof error.details?.runtime === "object" &&
      error.details.runtime !== null
        ? (error.details.runtime as BrowserRuntimeMetadata)
        : runtime;
    result = pendingFinalization(
      errorRuntime,
      error instanceof Error ? error.message : String(error),
      settlementMode,
    );
  }
  try {
    await recoveryLock.release();
  } catch (error) {
    return pendingFinalization(
      result.runtime,
      `Cleanup finished but recovery lock release failed: ${error instanceof Error ? error.message : String(error)}`,
      settlementMode,
    );
  }
  return result;
}
