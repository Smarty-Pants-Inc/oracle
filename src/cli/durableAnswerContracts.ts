import type { BrowserCaptureFinalizationResult, BrowserRunTransaction } from "../browser/types.js";
import type { BrowserRuntimeMetadata, SessionArtifact, SessionMetadata } from "../sessionStore.js";
import type {
  BrowserCapturePublicationJournal,
  BrowserPublicationRemovalEvent,
} from "./browserPublicationJournal.js";
import type {
  DurableBrowserAnswerReceipt,
  PersistDurableBrowserAnswerOptions,
  persistDurableBrowserAnswer,
} from "./durableBrowserAnswerFile.js";
import type { BrowserPublicationTransaction } from "./durableAnswerTransaction.js";

export type BrowserPublicationPersistence =
  | { status: "persisted"; recoveredError?: string }
  | { status: "pending"; error: string };

export interface PublishedBrowserCapture {
  published: true;
  receipt: DurableBrowserAnswerReceipt;
  artifacts: SessionArtifact[];
  projection: BrowserPublicationPersistence;
  finalization: BrowserCaptureFinalizationResult;
  finalizationPersistence: BrowserPublicationPersistence;
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

export type BrowserPublicationRecoveryAnswer =
  | { status: "none" }
  | { status: "pending" }
  | { status: "ready"; answer: string };

export type BrowserPublicationJournalRetirement = (
  journal: BrowserCapturePublicationJournal | null,
  event: BrowserPublicationRemovalEvent,
) => Promise<void>;

export interface PersistBrowserCaptureFinalizationOptions {
  acknowledgeCapabilities?: boolean;
}

export interface PersistedBrowserCaptureFinalizationState {
  finalization: BrowserCaptureFinalizationResult;
  projection: BrowserPublicationPersistence;
}

export type PersistBrowserCaptureFinalizationEffect = (
  browser: NonNullable<SessionMetadata["browser"]>,
  finalization: BrowserCaptureFinalizationResult,
  beforeRuntime: BrowserRuntimeMetadata,
  mode: "finalize" | "abort",
  lockReleased: boolean,
  options?: PersistBrowserCaptureFinalizationOptions,
) => Promise<BrowserCaptureFinalizationResult>;
