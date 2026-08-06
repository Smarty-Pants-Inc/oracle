import path from "node:path";
import type { BrowserRuntimeMetadata, SessionArtifact, SessionMetadata } from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";
import type {
  BrowserCaptureFinalizationResult,
  BrowserLogger,
  BrowserRunTransaction,
} from "../browser/types.js";
import {
  bindBrowserCaptureCleanupSettlement,
  pendingBrowserCaptureCleanup,
} from "../browser/runLifecycle.js";
import {
  acknowledgeSettledTargetCloseCapabilities,
  OwnedBrowserResourceTransaction,
  projectBrowserCaptureFinalization,
} from "../browser/ownedBrowserResources.js";
import { retainChromeEndpointAuthority } from "../browser/chromeLifecycle.js";
import { acquireReattachRecoveryLock, type ReattachRecoveryLock } from "../browser/reattachLock.js";
import {
  bindCurrentBrowserRecoveryRuntime,
  settleBrowserRecoveryCleanup,
} from "../browser/reattachSettlement.js";
import { appendArtifacts } from "../browser/artifacts.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  BrowserPublicationJournalStore,
  hasMatchingTerminalBrowserPublicationProjection,
  isBrowserPublicationAcknowledged,
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
  type PersistDurableBrowserAnswerOptions,
} from "./durableBrowserAnswerFile.js";
import {
  commitBrowserSessionOutcomeProjection,
  type BrowserSessionOutcome,
} from "./browserSessionOutcome.js";

export { persistDurableBrowserAnswer, readDurableBrowserAnswer };
export type { DurableBrowserAnswerReceipt, PersistDurableBrowserAnswerOptions };

export type BrowserPublicationProjectionPersistence =
  | { status: "persisted"; recoveredError?: string }
  | { status: "pending"; error: string };

export type BrowserPublicationFinalizationPersistence =
  | { status: "persisted"; recoveredError?: string }
  | { status: "pending"; error: string };

export interface PublishedBrowserCapture {
  published: true;
  receipt: DurableBrowserAnswerReceipt;
  artifacts: SessionArtifact[];
  projection: BrowserPublicationProjectionPersistence;
  finalization: BrowserCaptureFinalizationResult;
  finalizationPersistence: BrowserPublicationFinalizationPersistence;
}

export interface PublishCompletedBrowserCaptureOptions {
  answer: PersistDurableBrowserAnswerOptions;
  transaction: Pick<BrowserRunTransaction, "runtime" | "bindSettlement" | "finalize" | "abort"> & {
    releaseSettlementLock?: () => Promise<void>;
  };
  browser: NonNullable<SessionMetadata["browser"]>;
  existingArtifacts?: SessionArtifact[];
  prepareArtifacts?: () => Promise<SessionArtifact[] | undefined>;
  usage?: SessionMetadata["usage"];
  elapsedMs?: number;
  response?: SessionMetadata["response"];
  model?: string;
  projectRuntime?: (runtime: BrowserRuntimeMetadata) => BrowserRuntimeMetadata;
  publication?: BrowserPublicationTransaction;
  log?: (message: string) => void;
  label?: string;
  persistAnswer?: typeof persistDurableBrowserAnswer;
}

type BrowserPublicationRecoveryAnswer =
  | { status: "none" }
  | { status: "pending" }
  | { status: "ready"; answer: string };

export class BrowserPublicationTransaction {
  private sessionId: string | undefined;
  private currentJournal: BrowserCapturePublicationJournal | null = null;
  private authorityJournal: BrowserCapturePublicationJournal | null = null;
  private journalStore: BrowserPublicationJournalStore | undefined;
  private publicationAcknowledged = false;
  private recoveryLock: ReattachRecoveryLock | null = null;
  private recoveryLockPath: string | null = null;
  private persistenceState: BrowserPublicationFinalizationPersistence | undefined;
  private durableAnswerAcknowledged = false;
  private acquireRecoveryLockEffect: typeof acquireReattachRecoveryLock =
    acquireReattachRecoveryLock;

  static async open(sessionId: string): Promise<BrowserPublicationTransaction> {
    const publication = new BrowserPublicationTransaction();
    await publication.bind(sessionId);
    return publication;
  }

  get journal(): BrowserCapturePublicationJournal | null {
    return this.currentJournal;
  }

  get hasJournal(): boolean {
    return this.currentJournal !== null;
  }

  readonly isPublished = (): boolean => this.publicationAcknowledged;
  readonly isRemotePublicationAcknowledged = (): boolean =>
    this.publicationAcknowledged || this.durableAnswerAcknowledged;

  readonly acknowledge = (): void => {
    this.publicationAcknowledged = true;
  };

  async bind(sessionId: string): Promise<void> {
    if (this.sessionId && this.sessionId !== sessionId) {
      throw new Error("Browser publication transaction cannot change sessions");
    }
    this.sessionId = sessionId;
    this.journalStore ??= new BrowserPublicationJournalStore(sessionId);
    await this.refresh();
  }

  observe(journal: BrowserCapturePublicationJournal): BrowserCapturePublicationJournal {
    this.assertSession(journal.sessionId);
    if (this.authorityJournal) {
      assertDurableBrowserAnswerReceipt(journal.receipt, this.authorityJournal.receipt);
    }
    this.currentJournal = journal;
    this.authorityJournal = journal;
    return journal;
  }

  async refresh(): Promise<BrowserCapturePublicationJournal | null> {
    const sessionId = this.requireSessionId();
    const journal = await readBrowserCapturePublicationJournal(sessionId);
    if (journal) {
      this.observe(journal);
      const metadata = await sessionStore.readSession(sessionId).catch(() => null);
      this.publicationAcknowledged = isBrowserPublicationAcknowledged(journal, metadata);
    } else {
      this.currentJournal = null;
      this.publicationAcknowledged = false;
    }
    return journal;
  }

  async clear(): Promise<void> {
    if (!this.currentJournal) return;
    const metadata = await sessionStore.readSession(this.requireSessionId());
    if (!isBrowserPublicationAcknowledged(this.currentJournal, metadata)) {
      throw new Error("Browser publication journal cannot retire before terminal model projection");
    }
    await this.requireJournalStore().remove(this.currentJournal, {
      type: "retire-completed-publication",
      receipt: this.currentJournal.receipt,
      completedSessionPersisted: true,
    });
    this.currentJournal = null;
    this.durableAnswerAcknowledged = false;
    this.publicationAcknowledged = false;
  }

  async discardAbortedPreparation(runtime: BrowserRuntimeMetadata | undefined): Promise<boolean> {
    if (runtime?.recoveryCleanupResult?.settlementMode !== "abort") return false;
    return this.discardPreparationForAbort();
  }

  async discardPreparationForAbort(): Promise<boolean> {
    if (this.currentJournal?.phase !== "preparing") return false;
    await this.requireJournalStore().remove(this.currentJournal, {
      type: "abort-preparation",
      receipt: this.currentJournal.receipt,
    });
    this.currentJournal = null;
    this.durableAnswerAcknowledged = false;
    return true;
  }

  async recoveryAnswer(): Promise<BrowserPublicationRecoveryAnswer> {
    if (!this.currentJournal) return { status: "none" };
    const answer = await readDurableBrowserAnswer(this.currentJournal.receipt);
    if (answer !== null) {
      this.durableAnswerAcknowledged = true;
      return { status: "ready", answer };
    }
    return this.currentJournal.phase === "preparing" ? { status: "none" } : { status: "pending" };
  }

  async preferDurablePreparingAnswer(capturedAnswer: string): Promise<string> {
    if (this.currentJournal?.phase !== "preparing") return capturedAnswer;
    const durableAnswer = await readDurableBrowserAnswer(this.currentJournal.receipt);
    if (durableAnswer !== null) this.durableAnswerAcknowledged = true;
    return durableAnswer ?? capturedAnswer;
  }

  finalizationPersistence(): BrowserPublicationFinalizationPersistence | undefined {
    return this.persistenceState;
  }

  readonly acquireRecoveryLock = async (lockPath: string): Promise<ReattachRecoveryLock> => {
    if (this.recoveryLock && this.recoveryLockPath !== lockPath) {
      throw new Error("Browser publication recovery lock path changed during the transaction");
    }
    if (!this.recoveryLock) {
      this.recoveryLock = await this.acquireRecoveryLockEffect(lockPath);
      this.recoveryLockPath = lockPath;
    }
    return { release: this.releaseRecoveryLock };
  };

  readonly releaseRecoveryLock = async (finalize?: () => Promise<void>): Promise<void> => {
    const heldLock = this.recoveryLock;
    if (!heldLock) {
      await finalize?.();
      return;
    }
    await heldLock.release(finalize);
    if (this.recoveryLock === heldLock) {
      this.recoveryLock = null;
      this.recoveryLockPath = null;
    }
  };

  async loadCurrentRuntime(fallback: BrowserRuntimeMetadata): Promise<BrowserRuntimeMetadata> {
    const journal = await this.refresh();
    if (journal) return journal.runtime;
    const currentSession = await sessionStore.readSession(this.requireSessionId());
    return currentSession?.browser?.runtime ?? fallback;
  }

  async persistFinalization(
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
                finalization: await this.persistAbortRuntime(browser, projected),
                projection: { status: "persisted" as const },
              }
            : await persistBrowserCaptureFinalizationStateOnce(
                this.requireSessionId(),
                browser,
                this.requireJournal(),
                projected,
                beforeRuntime,
                this.requireJournalStore(),
                options,
              );
        await this.refresh();
        if (persistedState.projection.status === "pending") {
          this.persistenceState = persistedState.projection;
          return persistedState.finalization;
        }
        const recoveredError = firstError ?? persistedState.projection.recoveredError;
        this.persistenceState =
          lockReleased ||
          !persistedState.finalization.runtime.recoveryCleanupResult?.lockReleasePending
            ? { status: "persisted", ...(recoveredError ? { recoveredError } : {}) }
            : {
                status: "pending",
                error:
                  persistedState.finalization.runtime.recoveryCleanupResult.error ??
                  "Browser recovery lock release remains pending",
              };
        return persistedState.finalization;
      } catch (error) {
        firstError ??= formatError(error);
        if (attempt === 0) continue;
        const message = sanitizeBrowserPublicationMessage(formatError(error));
        this.persistenceState = { status: "pending", error: message };
        throw error;
      }
    }
    throw new Error("Browser finalization persistence retry exhausted");
  }

  createPersistedRecoveryTransaction(
    browser: NonNullable<SessionMetadata["browser"]>,
    logger: BrowserLogger,
    adapters: {
      acquireRecoveryLock?: typeof acquireReattachRecoveryLock;
      settleRecoveryCleanup?: typeof settleBrowserRecoveryCleanup;
    } = {},
  ): Pick<BrowserRunTransaction, "runtime" | "bindSettlement" | "finalize" | "abort"> & {
    releaseSettlementLock: () => Promise<void>;
  } {
    const sessionId = this.requireSessionId();
    const journal = this.requireJournal();
    this.acquireRecoveryLockEffect = adapters.acquireRecoveryLock ?? this.acquireRecoveryLockEffect;
    const settleRecoveryCleanup = adapters.settleRecoveryCleanup ?? settleBrowserRecoveryCleanup;
    const settlement = new OwnedBrowserResourceTransaction(
      {
        persistRuntime: async (proposedRuntime) => {
          const lockPath = path.join(
            (await sessionStore.getPaths(sessionId)).dir,
            "browser-recovery.lock",
          );
          await this.acquireRecoveryLock(lockPath);
          try {
            const authoritativeRuntime = bindCurrentBrowserRecoveryRuntime(
              proposedRuntime,
              await this.loadCurrentRuntime(journal.runtime),
            );
            await sessionStore.updateSession(sessionId, {
              browser: { ...browser, runtime: authoritativeRuntime },
            });
            return authoritativeRuntime;
          } catch (error) {
            await this.releaseRecoveryLock().catch(() => undefined);
            throw error;
          }
        },
        settleResources: async (mode, runtime) => {
          const lockPath = path.join(
            (await sessionStore.getPaths(sessionId)).dir,
            "browser-recovery.lock",
          );
          const outcome = await settleRecoveryCleanup(
            runtime,
            logger,
            {
              recoveryLockPath: lockPath,
              recoveryCleanup: { retainChromeEndpointAuthority },
              isRemotePublicationAcknowledged: this.isRemotePublicationAcknowledged,
              acquireRecoveryLock: this.acquireRecoveryLock,
              loadRuntimeUnderLock: () => this.loadCurrentRuntime(journal.runtime),
              persistFinalizationResult: (result, beforeRuntime, settlementMode) =>
                this.persistFinalization(browser, result, beforeRuntime, settlementMode, false, {
                  acknowledgeCapabilities: false,
                }),
              completeFinalizationAfterLockRelease: (result, beforeRuntime, settlementMode) =>
                this.persistFinalization(browser, result, beforeRuntime, settlementMode, true, {
                  acknowledgeCapabilities: false,
                }),
            },
            mode,
          );
          if (outcome.persistence.status === "pending") {
            this.persistenceState = {
              status: "pending",
              error: sanitizeBrowserPublicationMessage(outcome.persistence.error),
            };
          } else {
            this.persistenceState ??= { status: "persisted" };
          }
          return outcome.finalization;
        },
      },
      journal.runtime,
    );
    return {
      get runtime() {
        return settlement.runtime();
      },
      bindSettlement: (mode) => settlement.bindSettlement(mode),
      releaseSettlementLock: this.releaseRecoveryLock,
      finalize: () => settlement.settle("finalize"),
      abort: () => settlement.settle("abort"),
    };
  }

  async publish(options: PublishCompletedBrowserCaptureOptions): Promise<PublishedBrowserCapture> {
    const label = options.label ?? "Browser answer";
    const projectRuntime = options.projectRuntime ?? ((runtime) => runtime);
    const journalStore = this.requireJournalStore();
    let journal = this.currentJournal;
    if (journal) {
      assertJournalMatchesCapture(journal, options.transaction.runtime);
      journal = this.observe(await recognizeCommittedPublication(journalStore, journal));
    } else {
      try {
        journal = this.observe(
          await prepareBrowserCapturePublication(options, projectRuntime, journalStore),
        );
      } catch (stageError) {
        if (isBrowserCapturePublicationRecoveryPending(stageError)) throw stageError;
        return abortPreStageFailure(options, stageError, projectRuntime, journalStore);
      }
    }

    if (journal.phase === "preparing") {
      try {
        journal = this.observe(await stageBrowserCapture(options, journal, journalStore));
      } catch (stageError) {
        if (isBrowserCapturePublicationRecoveryPending(stageError)) throw stageError;
        return abortPreStageFailure(options, stageError, projectRuntime, journalStore);
      }
      this.durableAnswerAcknowledged = true;
    }

    let projection: BrowserPublicationProjectionPersistence;
    try {
      if (journal.phase === "staged") {
        journal = this.observe(
          await bindFinalizeAuthority(options, journal, projectRuntime, journalStore),
        );
      }
      if (journal.phase === "finalize-bound") {
        await persistFinalizeBoundRuntime(options, journal);
      }
      const committed = await commitTerminalPublication(options, journal, label, journalStore);
      journal = this.observe(committed.journal);
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
    this.acknowledge();
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
        `Browser cleanup finalize failed and remains retryable: ${formatError(finalizeError)}`,
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

    const managedPersistence = this.finalizationPersistence();
    if (managedPersistence) {
      return completedPublication(journal, projection, finalization, managedPersistence);
    }

    try {
      finalization = await this.persistFinalization(
        options.browser,
        finalization,
        runtimeBeforeFinalization,
        "finalize",
        true,
      );
      const persistence = this.finalizationPersistence() ?? { status: "persisted" as const };
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
      const persistedState = this.finalizationPersistence();
      const persistence =
        persistedState?.status === "pending"
          ? persistedState
          : { status: "pending" as const, error: formatError(persistenceError) };
      options.log?.(
        `${label} published; exact cleanup authority persistence remains deferred after retry: ${persistence.error}`,
      );
      return completedPublication(journal, projection, finalization, persistence);
    }
  }

  private async persistAbortRuntime(
    browser: NonNullable<SessionMetadata["browser"]>,
    finalization: BrowserCaptureFinalizationResult,
  ): Promise<BrowserCaptureFinalizationResult> {
    await sessionStore.updateSession(this.requireSessionId(), {
      browser: { ...browser, runtime: finalization.runtime },
    });
    return finalization;
  }

  private requireJournal(): BrowserCapturePublicationJournal {
    const journal = this.currentJournal ?? this.authorityJournal;
    if (!journal) throw new Error("Browser publication journal is unavailable");
    return journal;
  }
  private requireJournalStore(): BrowserPublicationJournalStore {
    if (!this.journalStore)
      throw new Error("Browser publication transaction is not bound to a session");
    return this.journalStore;
  }

  private requireSessionId(): string {
    if (!this.sessionId)
      throw new Error("Browser publication transaction is not bound to a session");
    return this.sessionId;
  }

  private assertSession(sessionId: string): void {
    if (this.requireSessionId() !== sessionId) {
      throw new Error("Browser publication journal changed sessions");
    }
  }
}

/**
 * Publishes a completed browser capture through a crash-recoverable transaction:
 * journal the exact answer intent, durably stage answer/artifacts, bind FINALIZE remotely and
 * locally, atomically commit the terminal session and selected-model projection, then execute
 * idempotent finalize effects. Only a pre-stage failure may select ABORT.
 */
export async function publishCompletedBrowserCapture(
  options: PublishCompletedBrowserCaptureOptions,
): Promise<PublishedBrowserCapture> {
  const publication = options.publication ?? new BrowserPublicationTransaction();
  await publication.bind(options.answer.sessionId);
  return publication.publish({ ...options, publication });
}

export function durableBrowserAnswerReceiptFromError(
  error: unknown,
): DurableBrowserAnswerReceipt | undefined {
  if (!(error instanceof BrowserAutomationError)) return undefined;
  const receipt = error.details?.answerReceipt;
  if (!receipt || typeof receipt !== "object" || !("artifact" in receipt)) return undefined;
  return receipt as DurableBrowserAnswerReceipt;
}
export async function verifiedDurableBrowserAnswerReceiptFromError(
  error: unknown,
): Promise<DurableBrowserAnswerReceipt | undefined> {
  const receipt = durableBrowserAnswerReceiptFromError(error);
  if (!receipt) return undefined;
  try {
    return (await readDurableBrowserAnswer(receipt)) === null ? undefined : receipt;
  } catch {
    return undefined;
  }
}

export function runtimeFromBrowserError(error: unknown): BrowserRuntimeMetadata | undefined {
  if (!(error instanceof BrowserAutomationError)) return undefined;
  const runtime = error.details?.runtime;
  return typeof runtime === "object" && runtime !== null
    ? (runtime as BrowserRuntimeMetadata)
    : undefined;
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
          `The exact durable answer could not be reconciled: ${formatError(recoveryError)}`,
        );
      }
    }
    if (!receipt) throw error;
    throw new BrowserAutomationError(
      `Browser capture staging failed after the answer became durable: ${formatError(error)}`,
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
      `The answer write outcome could not be reconciled: ${formatError(recoveryError)}`,
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
      `The publication journal write outcome could not be read: ${formatError(recoveryError)}`,
    );
  }
  if (recovered && publicationJournalsMatch(recovered, expected)) {
    try {
      return await journalStore.transition(previous, event);
    } catch (retryError) {
      throw browserCapturePublicationRecoveryPending(
        expected,
        writeError,
        `The exact publication journal could not complete its durability barrier: ${formatError(retryError)}`,
      );
    }
  }
  if (
    (recovered === null && previous === null) ||
    (recovered && previous && publicationJournalsMatch(recovered, previous))
  ) {
    return null;
  }
  throw browserCapturePublicationRecoveryPending(
    expected,
    writeError,
    "The publication journal write outcome does not match either transaction boundary.",
  );
}

function publicationJournalsMatch(
  actual: BrowserCapturePublicationJournal,
  expected: BrowserCapturePublicationJournal,
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
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
      `Browser answer is durably staged, but FINALIZE authority could not be bound: ${formatError(error)}`,
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
      `FINALIZE authority is bound, but its publication journal remains pending: ${formatError(error)}`,
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
        `FINALIZE authority is bound, but its local session projection remains pending: ${formatError(retryError)}`,
        {
          stage: "browser-capture-publication",
          code: "finalize-local-binding-persistence-failed",
          runtime: journal.runtime,
          answerReceipt: journal.receipt,
          firstError: formatError(error),
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
  projection: BrowserPublicationProjectionPersistence;
}> {
  const outcome = browserPublicationOutcome(
    options,
    journal,
    journal.runtime,
    journal.phase === "cleanup-pending" ? journal.cleanupErrorMessage : undefined,
  );
  const persisted = await commitBrowserSessionOutcomeProjection(options.answer.sessionId, outcome);
  const projection: BrowserPublicationProjectionPersistence =
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
      `${label} terminal session/model projection is durable; publication journal phase update remains retryable: ${formatError(error)}`,
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
      `Browser publication failed (${formatError(publicationError)}); recovery lock release remains retryable: ${formatError(releaseError)}`,
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

function browserPublicationOutcome(
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
export interface PersistBrowserCaptureFinalizationOptions {
  acknowledgeCapabilities?: boolean;
}
interface PersistedBrowserCaptureFinalizationState {
  finalization: BrowserCaptureFinalizationResult;
  projection: BrowserPublicationProjectionPersistence;
}

export async function persistBrowserCaptureFinalizationState(
  sessionId: string,
  browser: NonNullable<SessionMetadata["browser"]>,
  expectedJournal: BrowserCapturePublicationJournal,
  finalization: BrowserCaptureFinalizationResult,
  beforeFinalizationRuntime: BrowserRuntimeMetadata,
  options: PersistBrowserCaptureFinalizationOptions = {},
): Promise<BrowserCaptureFinalizationResult> {
  const publication = await BrowserPublicationTransaction.open(sessionId);
  publication.observe(expectedJournal);
  return publication.persistFinalization(
    browser,
    finalization,
    beforeFinalizationRuntime,
    "finalize",
    true,
    options,
  );
}

async function persistBrowserCaptureFinalizationStateOnce(
  sessionId: string,
  browser: NonNullable<SessionMetadata["browser"]>,
  expectedJournal: BrowserCapturePublicationJournal,
  finalization: BrowserCaptureFinalizationResult,
  beforeFinalizationRuntime: BrowserRuntimeMetadata,
  journalStore: BrowserPublicationJournalStore,
  options: PersistBrowserCaptureFinalizationOptions = {},
): Promise<PersistedBrowserCaptureFinalizationState> {
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
      await acknowledgeSettledTargetCloseCapabilities(beforeFinalizationRuntime, terminalRuntime);
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
  const persistedJournal = await journalStore.transition(currentJournal, event);
  if (options.acknowledgeCapabilities !== false) {
    await acknowledgeSettledTargetCloseCapabilities(beforeFinalizationRuntime, persistedRuntime);
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
      await journalStore.remove(persistedJournal, {
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

async function abortPreStageFailure(
  options: PublishCompletedBrowserCaptureOptions,
  stageError: unknown,
  projectRuntime: (runtime: BrowserRuntimeMetadata) => BrowserRuntimeMetadata,
  journalStore: BrowserPublicationJournalStore,
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
      `Browser capture staging failed (${formatError(stageError)}); ABORT authority could not be bound: ${formatError(bindingError)}`,
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
      `Browser capture staging failed (${formatError(stageError)}); bound ABORT authority could not be projected locally: ${formatError(persistenceError)}`,
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
    await journalStore.remove(preparation, {
      type: "abort-preparation",
      receipt: preparation?.receipt ?? errorAnswerReceipt,
    });
  } catch (clearError) {
    const failure = new BrowserAutomationError(
      `Browser capture staging failed (${formatError(stageError)}); durable publication intent cleanup remains pending: ${formatError(clearError)}`,
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
      `Browser cleanup abort failed and remains retryable: ${formatError(abortError)}`,
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
        `Browser capture staging failed (${formatError(stageError)}); cleanup authority projection failed: ${formatError(retryError)}`,
        {
          stage: "browser-capture-publication",
          code: "abort-authority-persistence-failed",
          runtime: abortionRuntime,
          answerReceipt: errorAnswerReceipt,
          firstError: formatError(error),
        },
        retryError,
      );
    }
  }
  if (abortion.status === "pending") {
    throw new BrowserAutomationError(
      `Browser capture staging failed (${formatError(stageError)}); cleanup remains retryable: ${abortion.error}`,
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
    `Browser answer was published, but exact cleanup authority could not be persisted: ${formatError(persistenceError)}`,
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
  projection: BrowserPublicationProjectionPersistence,
  finalization: BrowserCaptureFinalizationResult,
  finalizationPersistence: BrowserPublicationFinalizationPersistence,
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
  const journalIdentity = JSON.stringify([
    journalEpoch.epochId,
    journalEpoch.promptSha256,
    journalEpoch.followUpOrdinal,
    journalEpoch.status === "committed" ? journalEpoch.conversationId : null,
  ]);
  const runtimeIdentity = JSON.stringify([
    runtimeEpoch.epochId,
    runtimeEpoch.promptSha256,
    runtimeEpoch.followUpOrdinal,
    runtimeEpoch.status === "committed" ? runtimeEpoch.conversationId : null,
  ]);
  if (journalIdentity !== runtimeIdentity) {
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

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeBrowserPublicationMessage(message) || "browser publication failed";
}
