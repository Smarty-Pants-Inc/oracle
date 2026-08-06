import { isDeepStrictEqual } from "node:util";
import {
  bindBrowserCaptureCleanupSettlement,
  pendingBrowserCaptureCleanup,
} from "../browser/ownedBrowserResources.js";
import { appendArtifacts } from "../browser/artifacts.js";
import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  BrowserPublicationJournalStore,
  hasMatchingTerminalBrowserPublicationProjection,
  projectCompletedBrowserMetadataAudit,
  readBrowserCapturePublicationJournal,
  sanitizeBrowserPublicationMessage,
  sanitizeBrowserPublicationRuntime,
  type BrowserCapturePublicationJournal,
  type BrowserPublicationEvent,
} from "./browserPublicationJournal.js";
import {
  assertDurableBrowserAnswerReceipt,
  ensureDurableBrowserAnswerFile,
  persistDurableBrowserAnswer,
  prepareDurableBrowserAnswer,
  readDurableBrowserAnswer,
  type DurableBrowserAnswerReceipt,
} from "./durableBrowserAnswerFile.js";
import { commitBrowserSessionOutcomeProjection } from "./browserSessionOutcome.js";
import type {
  BrowserPublicationJournalRetirement,
  BrowserPublicationPersistence,
  PublishedBrowserCapture,
  PublishCompletedBrowserCaptureOptions,
} from "./durableAnswerContracts.js";
import {
  durableBrowserAnswerReceiptFromError,
  formatBrowserPublicationError,
  runtimeFromBrowserError,
  verifiedDurableBrowserAnswerReceiptFromError,
} from "./durableAnswerErrors.js";
import {
  browserPublicationOutcome,
  persistBrowserCaptureFinalization,
} from "./durableAnswerFinalization.js";
import type { DurableAnswerJournalAuthority } from "./durableAnswerJournal.js";

/**
 * Publishes a completed browser capture through a crash-recoverable transaction:
 * journal the exact answer intent, durably stage answer/artifacts, bind FINALIZE remotely and
 * locally, atomically commit the terminal session and selected-model projection, then execute
 * idempotent finalize effects. Only a pre-stage failure may select ABORT.
 */
export async function publishBrowserCapture(
  authority: DurableAnswerJournalAuthority,
  options: PublishCompletedBrowserCaptureOptions,
): Promise<PublishedBrowserCapture> {
  const label = options.label ?? "Browser answer";
  const projectRuntime = options.projectRuntime ?? ((runtime) => runtime);
  const journalStore = authority.requireJournalStore();
  let journal = authority.journal;
  if (journal) {
    assertJournalMatchesCapture(journal, options.transaction.runtime);
    journal = authority.observe(await recognizeCommittedPublication(journalStore, journal));
  } else {
    try {
      journal = authority.observe(
        await prepareBrowserCapturePublication(options, projectRuntime, journalStore),
      );
    } catch (stageError) {
      if (isBrowserCapturePublicationRecoveryPending(stageError)) throw stageError;
      return abortPreStageFailure(options, stageError, projectRuntime, authority.retireJournal);
    }
  }

  if (journal.phase === "preparing") {
    try {
      journal = authority.observe(await stageBrowserCapture(options, journal, journalStore));
    } catch (stageError) {
      if (isBrowserCapturePublicationRecoveryPending(stageError)) throw stageError;
      return abortPreStageFailure(options, stageError, projectRuntime, authority.retireJournal);
    }
    authority.acknowledgeDurableAnswer();
  }

  let projection: BrowserPublicationPersistence;
  try {
    if (journal.phase === "staged") {
      journal = authority.observe(
        await bindFinalizeAuthority(options, journal, projectRuntime, journalStore),
      );
    }
    if (journal.phase === "finalize-bound") {
      await persistFinalizeBoundRuntime(options, journal);
    }
    const committed = await commitTerminalPublication(options, journal, label, journalStore);
    journal = authority.observe(committed.journal);
    projection = committed.projection;
  } catch (error) {
    await releaseSettlementLockAfterFailure(options, error);
    throw error;
  }

  if (projection.status === "pending") {
    await releaseSettlementLockAfterFailure(options, projection.error);
    const finalizationError = `Terminal session/model projection remains retryable: ${projection.error}`;
    const finalization = pendingBrowserCaptureCleanup(
      journal.runtime,
      finalizationError,
      "finalize",
    );
    return completedPublication(journal, projection, finalization, {
      status: "pending",
      error: finalizationError,
    });
  }
  authority.acknowledge();
  if (projection.recoveredError) {
    options.log?.(
      `${label} published; recovered terminal session/model projection after retry: ${projection.recoveredError}`,
    );
  }

  const runtimeBeforeFinalization = options.transaction.runtime;
  let finalization: BrowserCaptureFinalizationResult;
  try {
    finalization = bindBrowserCaptureCleanupSettlement(
      await options.transaction.finalize(),
      "finalize",
    );
  } catch (finalizeError) {
    finalization = pendingBrowserCaptureCleanup(
      runtimeFromBrowserError(finalizeError) ?? journal.runtime,
      `Browser cleanup finalize failed and remains retryable: ${formatBrowserPublicationError(finalizeError)}`,
      "finalize",
    );
  }
  finalization = {
    ...finalization,
    runtime: projectRuntime(finalization.runtime),
  };
  if (finalization.status === "pending") {
    finalization = {
      ...finalization,
      error: sanitizeBrowserPublicationMessage(finalization.error),
    };
  }

  const managedPersistence = authority.finalizationPersistence();
  if (managedPersistence) {
    return completedPublication(journal, projection, finalization, managedPersistence);
  }

  try {
    finalization = await persistBrowserCaptureFinalization(
      authority,
      options.browser,
      finalization,
      runtimeBeforeFinalization,
      "finalize",
      true,
    );
    const persistence = authority.finalizationPersistence() ?? { status: "persisted" as const };
    if (persistence.status === "persisted" && persistence.recoveredError) {
      options.log?.(
        `${label} published; recovered final cleanup authority persistence after retry: ${persistence.recoveredError}`,
      );
    }
    return completedPublication(journal, projection, finalization, persistence);
  } catch (persistenceError) {
    const authorityError = runtimeAuthorityPersistenceFailure(
      journal,
      finalization,
      persistenceError,
    );
    if (!isRuntimeAuthorityPersistenceFailure(authorityError)) throw authorityError;
    const persistedState = authority.finalizationPersistence();
    const persistence =
      persistedState?.status === "pending"
        ? persistedState
        : { status: "pending" as const, error: formatBrowserPublicationError(persistenceError) };
    options.log?.(
      `${label} published; exact cleanup authority persistence remains deferred after retry: ${persistence.error}`,
    );
    return completedPublication(journal, projection, finalization, persistence);
  }
}

async function prepareBrowserCapturePublication(
  options: PublishCompletedBrowserCaptureOptions,
  projectRuntime: (runtime: BrowserRuntimeMetadata) => BrowserRuntimeMetadata,
  journalStore: BrowserPublicationJournalStore,
): Promise<BrowserCapturePublicationJournal> {
  const { receipt } = await prepareDurableBrowserAnswer(options.answer);
  const runtime = projectRuntime(options.transaction.runtime);
  const event = {
    type: "prepare",
    journal: {
      sessionId: options.answer.sessionId,
      receipt,
      artifacts: options.existingArtifacts ?? [],
      completedAt: new Date().toISOString(),
      usage: options.usage,
      elapsedMs: options.elapsedMs,
      response: options.response,
      model: options.model,
      browserAudit: projectCompletedBrowserMetadataAudit(options.browser, runtime),
      runtime,
    },
  } satisfies BrowserPublicationEvent;
  const expected = journalStore.reduce(null, event);
  try {
    return await journalStore.transition(null, event);
  } catch (writeError) {
    const recovered = await recoverExpectedPublicationJournalWrite(
      journalStore,
      expected,
      null,
      event,
      writeError,
    );
    if (recovered) return recovered;
    throw writeError;
  }
}

async function stageBrowserCapture(
  options: PublishCompletedBrowserCaptureOptions,
  journal: BrowserCapturePublicationJournal,
  journalStore: BrowserPublicationJournalStore,
): Promise<BrowserCapturePublicationJournal> {
  const persistAnswer = options.persistAnswer ?? persistDurableBrowserAnswer;
  let receipt: DurableBrowserAnswerReceipt | undefined;
  try {
    const preparedAnswer = await prepareDurableBrowserAnswer(options.answer);
    assertDurableBrowserAnswerReceipt(preparedAnswer.receipt, journal.receipt);
    const existingAnswer = await readDurableBrowserAnswer(journal.receipt);
    if (existingAnswer === null) {
      try {
        const persistedReceipt = await persistAnswer(options.answer, journal.receipt);
        assertDurableBrowserAnswerReceipt(persistedReceipt, journal.receipt);
        receipt = journal.receipt;
      } catch (persistError) {
        if (isBrowserCapturePublicationRecoveryPending(persistError)) throw persistError;
        const recoveredAnswer = await recoverDurableAnswerAfterPersistenceFailure(
          journal,
          options.answer.answer,
          persistError,
        );
        if (recoveredAnswer === null) throw persistError;
        receipt = journal.receipt;
      }
    } else {
      receipt = journal.receipt;
    }
    if (!receipt) throw new Error("Durable browser answer receipt was not established");
    const durableReceipt = receipt;

    const preparedArtifacts = await options.prepareArtifacts?.();
    const event = {
      type: "answer-staged",
      receipt: durableReceipt,
      artifacts:
        appendArtifacts(
          journal.artifacts.filter(
            (artifact) =>
              artifact.kind !== durableReceipt.artifact.kind ||
              artifact.path !== durableReceipt.artifact.path,
          ),
          [...(preparedArtifacts ?? []), durableReceipt.artifact],
        ) ?? [],
    } satisfies BrowserPublicationEvent;
    const expected = journalStore.reduce(journal, event);
    try {
      return await journalStore.transition(journal, event);
    } catch (writeError) {
      const recovered = await recoverExpectedPublicationJournalWrite(
        journalStore,
        expected,
        journal,
        event,
        writeError,
      );
      if (recovered) return recovered;
      throw writeError;
    }
  } catch (error) {
    if (isBrowserCapturePublicationRecoveryPending(error)) throw error;
    if (!receipt) {
      try {
        if ((await readDurableBrowserAnswer(journal.receipt)) !== null) {
          receipt = journal.receipt;
        }
      } catch (recoveryError) {
        throw browserCapturePublicationRecoveryPending(
          journal,
          error,
          `The exact durable answer could not be reconciled: ${formatBrowserPublicationError(recoveryError)}`,
        );
      }
    }
    if (!receipt) throw error;
    throw new BrowserAutomationError(
      `Browser capture staging failed after the answer became durable: ${formatBrowserPublicationError(error)}`,
      {
        stage: "browser-capture-publication",
        code: "browser-capture-staging-failed",
        runtime: journal.runtime,
        answerReceipt: receipt,
      },
      error,
    );
  }
}

async function recoverDurableAnswerAfterPersistenceFailure(
  journal: BrowserCapturePublicationJournal,
  answer: string,
  persistError: unknown,
): Promise<string | null> {
  try {
    const recovered = await readDurableBrowserAnswer(journal.receipt);
    if (recovered === null) return null;
    await ensureDurableBrowserAnswerFile(
      journal.receipt.artifact.path,
      Buffer.from(answer, "utf8"),
    );
    return recovered;
  } catch (recoveryError) {
    throw browserCapturePublicationRecoveryPending(
      journal,
      persistError,
      `The answer write outcome could not be reconciled: ${formatBrowserPublicationError(recoveryError)}`,
    );
  }
}

async function recoverExpectedPublicationJournalWrite(
  journalStore: BrowserPublicationJournalStore,
  expected: BrowserCapturePublicationJournal,
  previous: BrowserCapturePublicationJournal | null,
  event: BrowserPublicationEvent,
  writeError: unknown,
): Promise<BrowserCapturePublicationJournal | null> {
  let recovered: BrowserCapturePublicationJournal | null;
  try {
    recovered = await readBrowserCapturePublicationJournal(expected.sessionId);
  } catch (recoveryError) {
    throw browserCapturePublicationRecoveryPending(
      expected,
      writeError,
      `The publication journal write outcome could not be read: ${formatBrowserPublicationError(recoveryError)}`,
    );
  }
  if (recovered && durableJournalBoundariesMatch(recovered, expected)) {
    try {
      return await journalStore.transition(previous, event);
    } catch (retryError) {
      throw browserCapturePublicationRecoveryPending(
        expected,
        writeError,
        `The exact publication journal could not complete its durability barrier: ${formatBrowserPublicationError(retryError)}`,
      );
    }
  }
  if (
    (recovered === null && previous === null) ||
    (recovered && previous && durableJournalBoundariesMatch(recovered, previous))
  ) {
    return null;
  }
  throw browserCapturePublicationRecoveryPending(
    expected,
    writeError,
    "The publication journal write outcome does not match either transaction boundary.",
  );
}

function durableJournalBoundariesMatch(
  actual: BrowserCapturePublicationJournal,
  expected: BrowserCapturePublicationJournal,
): boolean {
  return isDeepStrictEqual(
    canonicalizeDurableJournalBoundary(actual),
    canonicalizeDurableJournalBoundary(expected),
  );
}

function canonicalizeDurableJournalBoundary(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      entry === undefined ? null : canonicalizeDurableJournalBoundary(entry),
    );
  }
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    return value;
  }
  const canonical: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) canonical[key] = canonicalizeDurableJournalBoundary(entry);
  }
  return canonical;
}

function browserCapturePublicationRecoveryPending(
  journal: BrowserCapturePublicationJournal,
  cause: unknown,
  reason: string,
): BrowserAutomationError {
  return new BrowserAutomationError(
    `Browser capture publication recovery remains pending. ${reason}`,
    {
      stage: "browser-capture-publication",
      code: "browser-capture-staging-recovery-pending",
      runtime: journal.runtime,
      answerReceipt: journal.receipt,
    },
    cause,
  );
}

function isBrowserCapturePublicationRecoveryPending(error: unknown): boolean {
  return (
    error instanceof BrowserAutomationError &&
    error.details?.code === "browser-capture-staging-recovery-pending"
  );
}

async function bindFinalizeAuthority(
  options: PublishCompletedBrowserCaptureOptions,
  journal: BrowserCapturePublicationJournal,
  projectRuntime: (runtime: BrowserRuntimeMetadata) => BrowserRuntimeMetadata,
  journalStore: BrowserPublicationJournalStore,
): Promise<BrowserCapturePublicationJournal> {
  let boundRuntime = journal.runtime;
  try {
    boundRuntime = await options.transaction.bindSettlement("finalize");
    boundRuntime = projectRuntime(boundRuntime);
  } catch (error) {
    throw new BrowserAutomationError(
      `Browser answer is durably staged, but FINALIZE authority could not be bound: ${formatBrowserPublicationError(error)}`,
      {
        stage: "browser-capture-publication",
        code: "finalize-binding-pending",
        runtime: runtimeFromBrowserError(error) ?? boundRuntime,
        answerReceipt: journal.receipt,
      },
      error,
    );
  }
  try {
    return await journalStore.transition(journal, {
      type: "finalize-bound",
      receipt: journal.receipt,
      settlementMode: "finalize",
      runtime: sanitizeBrowserPublicationRuntime(boundRuntime, "finalize-bound"),
      browserAudit: projectCompletedBrowserMetadataAudit(options.browser, boundRuntime),
    });
  } catch (error) {
    throw new BrowserAutomationError(
      `FINALIZE authority is bound, but its publication journal remains pending: ${formatBrowserPublicationError(error)}`,
      {
        stage: "browser-capture-publication",
        code: "finalize-binding-journal-persistence-failed",
        runtime: boundRuntime,
        answerReceipt: journal.receipt,
      },
      error,
    );
  }
}

async function persistFinalizeBoundRuntime(
  options: PublishCompletedBrowserCaptureOptions,
  journal: BrowserCapturePublicationJournal,
): Promise<void> {
  try {
    await sessionStore.updateSession(options.answer.sessionId, {
      browser: { ...options.browser, runtime: journal.runtime },
    });
  } catch (error) {
    try {
      await sessionStore.updateSession(options.answer.sessionId, {
        browser: { ...options.browser, runtime: journal.runtime },
      });
    } catch (retryError) {
      throw new BrowserAutomationError(
        `FINALIZE authority is bound, but its local session projection remains pending: ${formatBrowserPublicationError(retryError)}`,
        {
          stage: "browser-capture-publication",
          code: "finalize-local-binding-persistence-failed",
          runtime: journal.runtime,
          answerReceipt: journal.receipt,
          firstError: formatBrowserPublicationError(error),
        },
        retryError,
      );
    }
  }
}

async function commitTerminalPublication(
  options: PublishCompletedBrowserCaptureOptions,
  journal: BrowserCapturePublicationJournal,
  label: string,
  journalStore: BrowserPublicationJournalStore,
): Promise<{
  journal: BrowserCapturePublicationJournal;
  projection: BrowserPublicationPersistence;
}> {
  const outcome = browserPublicationOutcome(
    options,
    journal,
    journal.runtime,
    journal.phase === "cleanup-pending" ? journal.cleanupErrorMessage : undefined,
  );
  const persisted = await commitBrowserSessionOutcomeProjection(options.answer.sessionId, outcome);
  const projection: BrowserPublicationPersistence =
    persisted.status === "persisted"
      ? {
          status: "persisted",
          ...(persisted.recoveredError ? { recoveredError: persisted.recoveredError } : {}),
        }
      : { status: "pending", error: persisted.error };
  if (projection.status === "pending") {
    options.log?.(
      `${label} is durable under FINALIZE authority; terminal session/model projection remains retryable: ${projection.error}`,
    );
    return { journal, projection };
  }
  if (journal.phase !== "finalize-bound") return { journal, projection };

  const event = {
    type: "completed-session-persisted",
    receipt: journal.receipt,
    completedSessionPersisted: true,
  } as const;
  const publishedJournal = journalStore.reduce(journal, event);
  try {
    await journalStore.transition(journal, event);
  } catch (error) {
    options.log?.(
      `${label} terminal session/model projection is durable; publication journal phase update remains retryable: ${formatBrowserPublicationError(error)}`,
    );
  }
  return { journal: publishedJournal, projection };
}

async function releaseSettlementLockAfterFailure(
  options: PublishCompletedBrowserCaptureOptions,
  publicationError: unknown,
): Promise<void> {
  try {
    await options.transaction.releaseSettlementLock?.();
  } catch (releaseError) {
    options.log?.(
      `Browser publication failed (${formatBrowserPublicationError(publicationError)}); recovery lock release remains retryable: ${formatBrowserPublicationError(releaseError)}`,
    );
  }
}

async function recognizeCommittedPublication(
  journalStore: BrowserPublicationJournalStore,
  journal: BrowserCapturePublicationJournal,
): Promise<BrowserCapturePublicationJournal> {
  if (journal.phase !== "finalize-bound") return journal;
  const metadata = await sessionStore.readSession(journal.sessionId);
  if (!metadata || !hasMatchingTerminalBrowserPublicationProjection(metadata, journal)) {
    return journal;
  }
  return journalStore.reduce(journal, {
    type: "completed-session-persisted",
    receipt: journal.receipt,
    completedSessionPersisted: true,
  });
}

async function abortPreStageFailure(
  options: PublishCompletedBrowserCaptureOptions,
  stageError: unknown,
  projectRuntime: (runtime: BrowserRuntimeMetadata) => BrowserRuntimeMetadata,
  retireJournal: BrowserPublicationJournalRetirement,
): Promise<never> {
  const errorAnswerReceipt = durableBrowserAnswerReceiptFromError(stageError);
  const answerReceipt = await verifiedDurableBrowserAnswerReceiptFromError(stageError);
  const artifacts = answerReceipt
    ? appendArtifacts(options.existingArtifacts, [answerReceipt.artifact])
    : undefined;
  let boundRuntime: BrowserRuntimeMetadata;
  try {
    boundRuntime = projectRuntime(await options.transaction.bindSettlement("abort"));
  } catch (bindingError) {
    const failure = new BrowserAutomationError(
      `Browser capture staging failed (${formatBrowserPublicationError(stageError)}); ABORT authority could not be bound: ${formatBrowserPublicationError(bindingError)}`,
      {
        stage: "browser-capture-publication",
        code: "abort-binding-failed",
        runtime: runtimeFromBrowserError(bindingError) ?? options.transaction.runtime,
        answerReceipt: errorAnswerReceipt,
      },
      stageError,
    );
    await releaseSettlementLockAfterFailure(options, failure);
    throw failure;
  }
  try {
    await sessionStore.updateSession(options.answer.sessionId, {
      browser: { ...options.browser, runtime: boundRuntime },
      ...(artifacts ? { artifacts } : {}),
    });
  } catch (persistenceError) {
    const failure = new BrowserAutomationError(
      `Browser capture staging failed (${formatBrowserPublicationError(stageError)}); bound ABORT authority could not be projected locally: ${formatBrowserPublicationError(persistenceError)}`,
      {
        stage: "browser-capture-publication",
        code: "abort-authority-persistence-failed",
        runtime: boundRuntime,
        answerReceipt: errorAnswerReceipt,
      },
      stageError,
    );
    await releaseSettlementLockAfterFailure(options, failure);
    throw failure;
  }
  try {
    const preparation = await readBrowserCapturePublicationJournal(options.answer.sessionId);
    await retireJournal(preparation, {
      type: "abort-preparation",
      receipt: preparation?.receipt ?? errorAnswerReceipt,
    });
  } catch (clearError) {
    const failure = new BrowserAutomationError(
      `Browser capture staging failed (${formatBrowserPublicationError(stageError)}); durable publication intent cleanup remains pending: ${formatBrowserPublicationError(clearError)}`,
      {
        stage: "browser-capture-publication",
        code: "abort-publication-journal-cleanup-failed",
        runtime: boundRuntime,
        answerReceipt: errorAnswerReceipt,
      },
      clearError,
    );
    await releaseSettlementLockAfterFailure(options, failure);
    throw failure;
  }

  let abortion: BrowserCaptureFinalizationResult;
  try {
    abortion = bindBrowserCaptureCleanupSettlement(await options.transaction.abort(), "abort");
  } catch (abortError) {
    abortion = pendingBrowserCaptureCleanup(
      runtimeFromBrowserError(abortError) ?? boundRuntime,
      `Browser cleanup abort failed and remains retryable: ${formatBrowserPublicationError(abortError)}`,
      "abort",
    );
  }
  if (abortion.status === "pending") {
    abortion = {
      ...abortion,
      error: sanitizeBrowserPublicationMessage(abortion.error),
    };
  }
  const abortionRuntime = projectRuntime(abortion.runtime);
  try {
    await sessionStore.updateSession(options.answer.sessionId, {
      browser: { ...options.browser, runtime: abortionRuntime },
      ...(artifacts ? { artifacts } : {}),
    });
  } catch (error) {
    try {
      await sessionStore.updateSession(options.answer.sessionId, {
        browser: { ...options.browser, runtime: abortionRuntime },
        ...(artifacts ? { artifacts } : {}),
      });
    } catch (retryError) {
      throw new BrowserAutomationError(
        `Browser capture staging failed (${formatBrowserPublicationError(stageError)}); cleanup authority projection failed: ${formatBrowserPublicationError(retryError)}`,
        {
          stage: "browser-capture-publication",
          code: "abort-authority-persistence-failed",
          runtime: abortionRuntime,
          answerReceipt: errorAnswerReceipt,
          firstError: formatBrowserPublicationError(error),
        },
        retryError,
      );
    }
  }
  if (abortion.status === "pending") {
    throw new BrowserAutomationError(
      `Browser capture staging failed (${formatBrowserPublicationError(stageError)}); cleanup remains retryable: ${abortion.error}`,
      {
        stage: "browser-capture-publication",
        code: "publication-failed-cleanup-pending",
        runtime: abortionRuntime,
        answerReceipt: errorAnswerReceipt,
        cleanupError: abortion.error,
      },
      stageError,
    );
  }
  throw stageError;
}

function runtimeAuthorityPersistenceFailure(
  journal: BrowserCapturePublicationJournal,
  finalization: BrowserCaptureFinalizationResult,
  persistenceError: unknown,
): BrowserAutomationError {
  return new BrowserAutomationError(
    `Browser answer was published, but exact cleanup authority could not be persisted: ${formatBrowserPublicationError(persistenceError)}`,
    {
      stage: "browser-capture-finalization",
      code: "runtime-authority-persistence-failed",
      runtime: finalization.runtime,
      publishedAnswer: { published: true, receipt: journal.receipt },
      finalization,
      answerReceipt: journal.receipt,
      cleanupStatus: finalization.status,
      ...(finalization.status === "pending" ? { cleanupError: finalization.error } : {}),
    },
    persistenceError,
  );
}

function isRuntimeAuthorityPersistenceFailure(error: unknown): boolean {
  return (
    error instanceof BrowserAutomationError &&
    error.details?.code === "runtime-authority-persistence-failed"
  );
}

function completedPublication(
  journal: BrowserCapturePublicationJournal,
  projection: BrowserPublicationPersistence,
  finalization: BrowserCaptureFinalizationResult,
  finalizationPersistence: BrowserPublicationPersistence,
): PublishedBrowserCapture {
  return {
    published: true,
    receipt: journal.receipt,
    artifacts: journal.artifacts,
    projection,
    finalization,
    finalizationPersistence,
  };
}

function assertJournalMatchesCapture(
  journal: BrowserCapturePublicationJournal,
  runtime: BrowserRuntimeMetadata,
): void {
  const journalEpoch = journal.runtime.promptEpoch;
  const runtimeEpoch = runtime.promptEpoch;
  if (!journalEpoch || !runtimeEpoch) return;
  const journalIdentity = [
    journalEpoch.epochId,
    journalEpoch.promptSha256,
    journalEpoch.followUpOrdinal,
    journalEpoch.status === "committed" ? journalEpoch.conversationId : null,
  ];
  const runtimeIdentity = [
    runtimeEpoch.epochId,
    runtimeEpoch.promptSha256,
    runtimeEpoch.followUpOrdinal,
    runtimeEpoch.status === "committed" ? runtimeEpoch.conversationId : null,
  ];
  if (!isDeepStrictEqual(journalIdentity, runtimeIdentity)) {
    throw new BrowserAutomationError(
      "Refusing to recover a staged browser publication with a different prompt authority.",
      {
        stage: "browser-capture-publication",
        code: "staged-publication-authority-mismatch",
        runtime: journal.runtime,
        answerReceipt: journal.receipt,
      },
    );
  }
}
