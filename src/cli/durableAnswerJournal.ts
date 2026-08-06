import path from "node:path";
import { OwnedBrowserResourceTransaction } from "../browser/ownedBrowserResources.js";
import { retainChromeEndpointAuthority } from "../browser/chromeLifecycle.js";
import { acquireReattachRecoveryLock, type ReattachRecoveryLock } from "../browser/reattachLock.js";
import {
  bindCurrentBrowserRecoveryRuntime,
  settleBrowserRecoveryCleanup,
} from "../browser/reattachSettlement.js";
import type { BrowserLogger, BrowserRunTransaction } from "../browser/types.js";
import type { BrowserRuntimeMetadata, SessionMetadata } from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";
import {
  BrowserPublicationJournalStore,
  isBrowserPublicationAcknowledged,
  readBrowserCapturePublicationJournal,
  sanitizeBrowserPublicationMessage,
  type BrowserCapturePublicationJournal,
} from "./browserPublicationJournal.js";
import {
  assertDurableBrowserAnswerReceipt,
  readDurableBrowserAnswer,
} from "./durableBrowserAnswerFile.js";
import type {
  BrowserPublicationJournalRetirement,
  BrowserPublicationPersistence,
  BrowserPublicationRecoveryAnswer,
  PersistBrowserCaptureFinalizationEffect,
} from "./durableAnswerContracts.js";

export class DurableAnswerJournalAuthority {
  private sessionId: string | undefined;
  private currentJournal: BrowserCapturePublicationJournal | null = null;
  private authorityJournal: BrowserCapturePublicationJournal | null = null;
  private journalStore: BrowserPublicationJournalStore | undefined;
  private publicationAcknowledged = false;
  private recoveryLock: ReattachRecoveryLock | null = null;
  private recoveryLockPath: string | null = null;
  private persistenceState: BrowserPublicationPersistence | undefined;
  private durableAnswerAcknowledged = false;
  private acquireRecoveryLockEffect: typeof acquireReattachRecoveryLock =
    acquireReattachRecoveryLock;

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

  acknowledgeDurableAnswer(): void {
    this.durableAnswerAcknowledged = true;
  }

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
    const journal = this.currentJournal;
    if (!journal) return;
    const metadata = await sessionStore.readSession(this.requireSessionId());
    if (!isBrowserPublicationAcknowledged(journal, metadata)) {
      throw new Error("Browser publication journal cannot retire before terminal model projection");
    }
    await this.retireJournal(journal, {
      type: "retire-completed-publication",
      receipt: journal.receipt,
      completedSessionPersisted: true,
    });
  }

  async discardAbortedPreparation(runtime: BrowserRuntimeMetadata | undefined): Promise<boolean> {
    if (runtime?.recoveryCleanupResult?.settlementMode !== "abort") return false;
    return this.discardPreparationForAbort();
  }

  async discardPreparationForAbort(): Promise<boolean> {
    const journal = this.currentJournal;
    if (journal?.phase !== "preparing") return false;
    await this.retireJournal(journal, {
      type: "abort-preparation",
      receipt: journal.receipt,
    });
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

  finalizationPersistence(): BrowserPublicationPersistence | undefined {
    return this.persistenceState;
  }

  setFinalizationPersistence(persistence: BrowserPublicationPersistence): void {
    this.persistenceState = persistence;
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

  createPersistedRecoveryTransaction(
    browser: NonNullable<SessionMetadata["browser"]>,
    logger: BrowserLogger,
    adapters: {
      acquireRecoveryLock?: typeof acquireReattachRecoveryLock;
      settleRecoveryCleanup?: typeof settleBrowserRecoveryCleanup;
    },
    persistFinalization: PersistBrowserCaptureFinalizationEffect,
  ): Pick<BrowserRunTransaction, "runtime" | "bindSettlement" | "finalize" | "abort"> & {
    releaseSettlementLock: () => Promise<void>;
  } {
    const sessionId = this.requireSessionId();
    const journal = this.requireJournal();
    this.acquireRecoveryLockEffect = adapters.acquireRecoveryLock ?? this.acquireRecoveryLockEffect;
    const settleRecoveryCleanup = adapters.settleRecoveryCleanup ?? settleBrowserRecoveryCleanup;
    const settlement = new OwnedBrowserResourceTransaction(
      {
        ownerId: sessionId,
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
              ownerId: sessionId,
              recoveryLockPath: lockPath,
              recoveryCleanup: { retainChromeEndpointAuthority },
              isRemotePublicationAcknowledged: this.isRemotePublicationAcknowledged,
              acquireRecoveryLock: this.acquireRecoveryLock,
              loadRuntimeUnderLock: () => this.loadCurrentRuntime(journal.runtime),
              persistFinalizationResult: (result, beforeRuntime, settlementMode) =>
                persistFinalization(browser, result, beforeRuntime, settlementMode, false, {
                  acknowledgeCapabilities: false,
                }),
              completeFinalizationAfterLockRelease: (result, beforeRuntime, settlementMode) =>
                persistFinalization(browser, result, beforeRuntime, settlementMode, true, {
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

  readonly retireJournal: BrowserPublicationJournalRetirement = async (journal, event) => {
    await this.requireJournalStore().remove(journal, event);
    this.currentJournal = null;
    this.authorityJournal = null;
    this.durableAnswerAcknowledged = false;
    this.publicationAcknowledged = false;
  };

  requireJournal(): BrowserCapturePublicationJournal {
    const journal = this.currentJournal ?? this.authorityJournal;
    if (!journal) throw new Error("Browser publication journal is unavailable");
    return journal;
  }

  requireJournalStore(): BrowserPublicationJournalStore {
    if (!this.journalStore) {
      throw new Error("Browser publication transaction is not bound to a session");
    }
    return this.journalStore;
  }

  requireSessionId(): string {
    if (!this.sessionId) {
      throw new Error("Browser publication transaction is not bound to a session");
    }
    return this.sessionId;
  }

  private assertSession(sessionId: string): void {
    if (this.requireSessionId() !== sessionId) {
      throw new Error("Browser publication journal changed sessions");
    }
  }
}
