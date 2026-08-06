import { acquireReattachRecoveryLock, type ReattachRecoveryLock } from "../browser/reattachLock.js";
import { settleBrowserRecoveryCleanup } from "../browser/reattachSettlement.js";
import type {
  BrowserCaptureFinalizationResult,
  BrowserLogger,
  BrowserRunTransaction,
} from "../browser/types.js";
import type { BrowserRuntimeMetadata, SessionMetadata } from "../sessionStore.js";
import type { BrowserCapturePublicationJournal } from "./browserPublicationJournal.js";
import type {
  BrowserPublicationPersistence,
  BrowserPublicationRecoveryAnswer,
  PersistBrowserCaptureFinalizationOptions,
  PublishedBrowserCapture,
  PublishCompletedBrowserCaptureOptions,
} from "./durableAnswerContracts.js";
import { persistBrowserCaptureFinalization } from "./durableAnswerFinalization.js";
import { DurableAnswerJournalAuthority } from "./durableAnswerJournal.js";
import { publishBrowserCapture } from "./durableAnswerPublication.js";

export class BrowserPublicationTransaction {
  private readonly authority = new DurableAnswerJournalAuthority();

  static async open(sessionId: string): Promise<BrowserPublicationTransaction> {
    const publication = new BrowserPublicationTransaction();
    await publication.bind(sessionId);
    return publication;
  }

  get journal(): BrowserCapturePublicationJournal | null {
    return this.authority.journal;
  }

  get hasJournal(): boolean {
    return this.authority.hasJournal;
  }

  readonly isPublished = (): boolean => this.authority.isPublished();
  readonly isRemotePublicationAcknowledged = (): boolean =>
    this.authority.isRemotePublicationAcknowledged();
  readonly acknowledge = (): void => this.authority.acknowledge();

  async bind(sessionId: string): Promise<void> {
    await this.authority.bind(sessionId);
  }

  observe(journal: BrowserCapturePublicationJournal): BrowserCapturePublicationJournal {
    return this.authority.observe(journal);
  }

  async refresh(): Promise<BrowserCapturePublicationJournal | null> {
    return this.authority.refresh();
  }

  async clear(): Promise<void> {
    await this.authority.clear();
  }

  async discardAbortedPreparation(runtime: BrowserRuntimeMetadata | undefined): Promise<boolean> {
    return this.authority.discardAbortedPreparation(runtime);
  }

  async discardPreparationForAbort(): Promise<boolean> {
    return this.authority.discardPreparationForAbort();
  }

  async recoveryAnswer(): Promise<BrowserPublicationRecoveryAnswer> {
    return this.authority.recoveryAnswer();
  }

  async preferDurablePreparingAnswer(capturedAnswer: string): Promise<string> {
    return this.authority.preferDurablePreparingAnswer(capturedAnswer);
  }

  finalizationPersistence(): BrowserPublicationPersistence | undefined {
    return this.authority.finalizationPersistence();
  }

  readonly acquireRecoveryLock = async (lockPath: string): Promise<ReattachRecoveryLock> =>
    this.authority.acquireRecoveryLock(lockPath);

  readonly releaseRecoveryLock = async (finalize?: () => Promise<void>): Promise<void> =>
    this.authority.releaseRecoveryLock(finalize);

  async loadCurrentRuntime(fallback: BrowserRuntimeMetadata): Promise<BrowserRuntimeMetadata> {
    return this.authority.loadCurrentRuntime(fallback);
  }

  async persistFinalization(
    browser: NonNullable<SessionMetadata["browser"]>,
    finalization: BrowserCaptureFinalizationResult,
    beforeRuntime: BrowserRuntimeMetadata,
    mode: "finalize" | "abort",
    lockReleased: boolean,
    options: PersistBrowserCaptureFinalizationOptions = {},
  ): Promise<BrowserCaptureFinalizationResult> {
    return persistBrowserCaptureFinalization(
      this.authority,
      browser,
      finalization,
      beforeRuntime,
      mode,
      lockReleased,
      options,
    );
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
    return this.authority.createPersistedRecoveryTransaction(
      browser,
      logger,
      adapters,
      (publicationBrowser, result, beforeRuntime, mode, lockReleased, options) =>
        this.persistFinalization(
          publicationBrowser,
          result,
          beforeRuntime,
          mode,
          lockReleased,
          options,
        ),
    );
  }

  async publish(options: PublishCompletedBrowserCaptureOptions): Promise<PublishedBrowserCapture> {
    return publishBrowserCapture(this.authority, options);
  }
}

export async function publishCompletedBrowserCapture(
  options: PublishCompletedBrowserCaptureOptions,
): Promise<PublishedBrowserCapture> {
  const publication = options.publication ?? new BrowserPublicationTransaction();
  await publication.bind(options.answer.sessionId);
  return publication.publish({ ...options, publication });
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
