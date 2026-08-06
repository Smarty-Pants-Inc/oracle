import {
  acknowledgeSettledTargetCloseCapabilities,
  projectBrowserCaptureFinalization,
} from "../browser/ownedBrowserResources.js";
import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import type { BrowserRuntimeMetadata, SessionMetadata } from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";
import {
  hasMatchingTerminalBrowserPublicationProjection,
  isBrowserPublicationAcknowledged,
  readBrowserCapturePublicationJournal,
  sanitizeBrowserPublicationMessage,
  sanitizeBrowserPublicationRuntime,
  type BrowserCapturePublicationJournal,
  type BrowserPublicationEvent,
} from "./browserPublicationJournal.js";
import {
  commitBrowserSessionOutcomeProjection,
  type BrowserSessionOutcome,
} from "./browserSessionOutcome.js";
import type {
  PersistBrowserCaptureFinalizationOptions,
  PersistedBrowserCaptureFinalizationState,
  PublishCompletedBrowserCaptureOptions,
} from "./durableAnswerContracts.js";
import { formatBrowserPublicationError } from "./durableAnswerErrors.js";
import type { DurableAnswerJournalAuthority } from "./durableAnswerJournal.js";

export async function persistBrowserCaptureFinalization(
  authority: DurableAnswerJournalAuthority,
  browser: NonNullable<SessionMetadata["browser"]>,
  finalization: BrowserCaptureFinalizationResult,
  beforeRuntime: BrowserRuntimeMetadata,
  mode: "finalize" | "abort",
  lockReleased: boolean,
  options: PersistBrowserCaptureFinalizationOptions = {},
): Promise<BrowserCaptureFinalizationResult> {
  const projected = projectBrowserCaptureFinalization(beforeRuntime, finalization, mode);
  let firstError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const persistedState: PersistedBrowserCaptureFinalizationState =
        mode === "abort"
          ? {
              finalization: await persistAbortRuntime(
                authority.requireSessionId(),
                browser,
                projected,
              ),
              projection: { status: "persisted" as const },
            }
          : await persistBrowserCaptureFinalizationStateOnce(
              authority,
              authority.requireJournal(),
              browser,
              projected,
              beforeRuntime,
              options,
            );
      await authority.refresh();
      if (persistedState.projection.status === "pending") {
        authority.setFinalizationPersistence(persistedState.projection);
        return persistedState.finalization;
      }
      const recoveredError = firstError ?? persistedState.projection.recoveredError;
      authority.setFinalizationPersistence(
        lockReleased ||
          !persistedState.finalization.runtime.recoveryCleanupResult?.lockReleasePending
          ? { status: "persisted", ...(recoveredError ? { recoveredError } : {}) }
          : {
              status: "pending",
              error:
                persistedState.finalization.runtime.recoveryCleanupResult.error ??
                "Browser recovery lock release remains pending",
            },
      );
      return persistedState.finalization;
    } catch (error) {
      firstError ??= formatBrowserPublicationError(error);
      if (attempt === 0) continue;
      const message = formatBrowserPublicationError(error);
      authority.setFinalizationPersistence({ status: "pending", error: message });
      throw error;
    }
  }
  throw new Error("Browser finalization persistence retry exhausted");
}

async function persistBrowserCaptureFinalizationStateOnce(
  authority: DurableAnswerJournalAuthority,
  expectedJournal: BrowserCapturePublicationJournal,
  browser: NonNullable<SessionMetadata["browser"]>,
  finalization: BrowserCaptureFinalizationResult,
  beforeFinalizationRuntime: BrowserRuntimeMetadata,
  options: PersistBrowserCaptureFinalizationOptions,
): Promise<PersistedBrowserCaptureFinalizationState> {
  const sessionId = authority.requireSessionId();
  const currentJournal = await readBrowserCapturePublicationJournal(sessionId);
  if (!currentJournal) {
    const currentSession = await sessionStore.readSession(sessionId);
    const terminalRuntime = currentSession?.browser?.runtime;
    const matchingTerminalSession =
      currentSession !== null &&
      currentSession !== undefined &&
      hasMatchingTerminalBrowserPublicationProjection(currentSession, expectedJournal) &&
      terminalRuntime !== undefined &&
      !terminalRuntime.recoveryCleanupResources?.length &&
      !terminalRuntime.recoveryCleanupResult;
    if (!matchingTerminalSession || !terminalRuntime) {
      throw new Error("Browser finalization journal authority changed before persistence");
    }
    if (options.acknowledgeCapabilities !== false) {
      await acknowledgeSettledTargetCloseCapabilities(
        beforeFinalizationRuntime,
        terminalRuntime,
        sessionId,
      );
    }
    return {
      finalization: { status: "completed", runtime: terminalRuntime },
      projection: { status: "persisted" },
    };
  }
  if (
    currentJournal.receipt.artifact.path !== expectedJournal.receipt.artifact.path ||
    currentJournal.receipt.artifact.sha256 !== expectedJournal.receipt.artifact.sha256 ||
    currentJournal.receipt.artifact.sizeBytes !== expectedJournal.receipt.artifact.sizeBytes
  ) {
    throw new Error("Browser finalization journal authority changed before persistence");
  }

  const currentRuntimeIsTerminal =
    currentJournal.cleanupFinalizationPersisted === true &&
    !(
      currentJournal.runtime.recoveryCleanupResources?.length ||
      currentJournal.runtime.recoveryCleanupResult
    );
  const effectiveFinalization =
    currentRuntimeIsTerminal && finalization.status === "pending"
      ? ({ status: "completed", runtime: currentJournal.runtime } as const)
      : finalization;
  const cleanupPending = effectiveFinalization.status === "pending";
  const cleanupErrorCode = cleanupPending ? "browser-cleanup-finalize-pending" : undefined;
  const persistedFinalization: BrowserCaptureFinalizationResult = cleanupPending
    ? {
        ...effectiveFinalization,
        error: sanitizeBrowserPublicationMessage(effectiveFinalization.error),
        runtime: sanitizeBrowserPublicationRuntime(effectiveFinalization.runtime, cleanupErrorCode),
      }
    : effectiveFinalization;
  const persistedRuntime = persistedFinalization.runtime;
  const event: BrowserPublicationEvent =
    persistedFinalization.status === "pending"
      ? {
          type: "cleanup-finalization-persisted",
          completedSessionPersisted: true,
          finalization: {
            status: "pending",
            runtime: persistedRuntime,
            errorCode: "browser-cleanup-finalize-pending",
            errorMessage: persistedFinalization.error,
          },
        }
      : {
          type: "cleanup-finalization-persisted",
          completedSessionPersisted: true,
          finalization: { status: "completed", runtime: persistedRuntime },
        };
  const persistedJournal = await authority.requireJournalStore().transition(currentJournal, event);
  if (options.acknowledgeCapabilities !== false) {
    await acknowledgeSettledTargetCloseCapabilities(
      beforeFinalizationRuntime,
      persistedRuntime,
      sessionId,
    );
  }
  const projection = await commitBrowserSessionOutcomeProjection(
    sessionId,
    browserPublicationOutcome(
      { browser },
      currentJournal,
      effectiveFinalization.runtime,
      persistedFinalization.status === "pending" ? persistedFinalization.error : undefined,
    ),
  );
  if (projection.status === "pending") {
    return {
      finalization: persistedFinalization,
      projection: { status: "pending", error: projection.error },
    };
  }
  if (!cleanupPending && !isBrowserPublicationAcknowledged(persistedJournal, projection.metadata)) {
    throw new Error("Terminal browser publication projection could not be verified for retirement");
  }
  if (!cleanupPending) {
    try {
      await authority.retireJournal(persistedJournal, {
        type: "retire-completed-publication",
        receipt: persistedJournal.receipt,
        completedSessionPersisted: true,
      });
    } catch {
      // Terminal journal + session state are already durable. Re-read only to reconcile an
      // ambiguous remove outcome; a surviving stale journal is retirement debt, not a downgrade.
      await readBrowserCapturePublicationJournal(sessionId).catch(() => null);
    }
  }
  return {
    finalization: persistedFinalization,
    projection: {
      status: "persisted",
      ...(projection.recoveredError ? { recoveredError: projection.recoveredError } : {}),
    },
  };
}

export function browserPublicationOutcome(
  options: Pick<PublishCompletedBrowserCaptureOptions, "browser">,
  journal: BrowserCapturePublicationJournal,
  runtime: BrowserRuntimeMetadata,
  cleanupError?: string,
): BrowserSessionOutcome {
  const browser = { ...options.browser, runtime };
  const shared = {
    browser,
    runtime,
    response: journal.response ?? ({ status: "completed" } as const),
    artifacts: journal.artifacts,
    receipt: journal.receipt,
    errorMetadata: undefined,
    transportMetadata: undefined,
    modelProjection: journal.model
      ? {
          model: journal.model,
          updates: {
            usage: journal.usage,
            response: { status: "completed" as const },
            transport: undefined,
            error: undefined,
          },
        }
      : undefined,
    usage: journal.usage,
    elapsedMs: journal.elapsedMs,
    completedAt: journal.completedAt,
  };
  return cleanupError
    ? {
        ...shared,
        kind: "cleanup-pending",
        publication: "published",
        reason: cleanupError,
      }
    : { ...shared, kind: "published", reason: undefined };
}

async function persistAbortRuntime(
  sessionId: string,
  browser: NonNullable<SessionMetadata["browser"]>,
  finalization: BrowserCaptureFinalizationResult,
): Promise<BrowserCaptureFinalizationResult> {
  await sessionStore.updateSession(sessionId, {
    browser: { ...browser, runtime: finalization.runtime },
  });
  return finalization;
}
