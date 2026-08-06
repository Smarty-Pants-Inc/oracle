import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { BrowserRuntimeMetadata, SessionArtifact, SessionMetadata } from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";
import { syncDirectory } from "../fsDurability.js";
import { writeFileAtomicDurable } from "../sessionManager.js";
import {
  assertDurableBrowserAnswerReceipt,
  type DurableBrowserAnswerReceipt,
} from "./durableBrowserAnswerFile.js";

const JOURNAL_FILENAME = "browser-capture-publication.json";
const MAX_AUDIT_MESSAGE_CHARS = 240;

export type BrowserPublicationPhase =
  | "preparing"
  | "staged"
  | "finalize-bound"
  | "published"
  | "cleanup-pending";
const BROWSER_PUBLICATION_PHASES: Readonly<Record<BrowserPublicationPhase, true>> = {
  preparing: true,
  staged: true,
  "finalize-bound": true,
  published: true,
  "cleanup-pending": true,
};

type BrowserCapturePublicationJournalBase = {
  version: 2;
  sessionId: string;
  receipt: DurableBrowserAnswerReceipt;
  artifacts: SessionArtifact[];
  completedAt: string;
  usage?: SessionMetadata["usage"];
  elapsedMs?: number;
  response?: SessionMetadata["response"];
  model?: string;
  browserAudit: NonNullable<SessionMetadata["browser"]>;
  runtime: BrowserRuntimeMetadata;
};

type UnfinalizedBrowserPublication = {
  cleanupFinalizationPersisted?: never;
  cleanupErrorCode?: never;
  cleanupErrorMessage?: never;
};

type UnboundBrowserPublication = {
  finalizeSettlementMode?: never;
  completedSessionPersisted?: never;
};

type FinalizeBoundBrowserPublication = {
  finalizeSettlementMode: "finalize";
};

export type BrowserCapturePublicationJournal =
  | (BrowserCapturePublicationJournalBase &
      UnfinalizedBrowserPublication &
      UnboundBrowserPublication & { phase: "preparing" })
  | (BrowserCapturePublicationJournalBase &
      UnfinalizedBrowserPublication &
      UnboundBrowserPublication & { phase: "staged" })
  | (BrowserCapturePublicationJournalBase &
      UnfinalizedBrowserPublication &
      FinalizeBoundBrowserPublication & {
        phase: "finalize-bound";
        completedSessionPersisted?: never;
      })
  | (BrowserCapturePublicationJournalBase &
      FinalizeBoundBrowserPublication & {
        phase: "published";
        completedSessionPersisted: true;
        cleanupFinalizationPersisted?: true;
        cleanupErrorCode?: never;
        cleanupErrorMessage?: never;
      })
  | (BrowserCapturePublicationJournalBase &
      FinalizeBoundBrowserPublication & {
        phase: "cleanup-pending";
        completedSessionPersisted: true;
        cleanupFinalizationPersisted: true;
        cleanupErrorCode: string;
        cleanupErrorMessage: string;
      });

type BrowserPublicationPreparation = Omit<BrowserCapturePublicationJournalBase, "version"> &
  UnfinalizedBrowserPublication &
  UnboundBrowserPublication;

export type BrowserPublicationEvent =
  | { type: "prepare"; journal: BrowserPublicationPreparation }
  | {
      type: "answer-staged";
      receipt: DurableBrowserAnswerReceipt;
      artifacts: SessionArtifact[];
    }
  | {
      type: "finalize-bound";
      receipt: DurableBrowserAnswerReceipt;
      settlementMode: "finalize";
      runtime: BrowserRuntimeMetadata;
      browserAudit: NonNullable<SessionMetadata["browser"]>;
    }
  | {
      type: "completed-session-persisted";
      receipt: DurableBrowserAnswerReceipt;
      completedSessionPersisted: true;
    }
  | {
      type: "cleanup-finalization-persisted";
      completedSessionPersisted: true;
      finalization:
        | { status: "completed"; runtime: BrowserRuntimeMetadata }
        | {
            status: "pending";
            runtime: BrowserRuntimeMetadata;
            errorCode: string;
            errorMessage: string;
          };
    };

export type BrowserPublicationRemovalEvent =
  | { type: "abort-preparation"; receipt?: DurableBrowserAnswerReceipt }
  | {
      type: "retire-completed-publication";
      receipt: DurableBrowserAnswerReceipt;
      completedSessionPersisted: true;
    };

export function isBrowserPublicationAcknowledged(
  journal: BrowserCapturePublicationJournal | null | undefined,
  metadata: SessionMetadata | null | undefined,
): boolean {
  return Boolean(
    journal &&
    journal.phase !== "preparing" &&
    journal.phase !== "staged" &&
    metadata &&
    hasMatchingTerminalBrowserPublicationProjection(metadata, journal),
  );
}

export function hasMatchingTerminalBrowserPublicationProjection(
  metadata: SessionMetadata,
  journal: BrowserCapturePublicationJournal,
): boolean {
  if (metadata.status !== "completed" || metadata.completedAt !== journal.completedAt) return false;
  if (!artifactsContainReceipt(metadata.artifacts ?? [], journal.receipt)) return false;
  if (!journal.model) return true;
  if (metadata.modelProjectionAuthority !== "session") return false;
  const selectedModel = metadata.models?.find((run) => run.model === journal.model);
  return Boolean(
    selectedModel &&
    selectedModel.status === "completed" &&
    selectedModel.completedAt === journal.completedAt &&
    isDeepStrictEqual(selectedModel.usage, journal.usage) &&
    isDeepStrictEqual(selectedModel.response, { status: "completed" }) &&
    selectedModel.transport === undefined &&
    selectedModel.error === undefined,
  );
}

export function reduceBrowserPublicationEvent(
  current: BrowserCapturePublicationJournal | null,
  event: BrowserPublicationEvent,
): BrowserCapturePublicationJournal {
  if (current) assertBrowserCapturePublicationJournal(current, current.sessionId);
  let next: BrowserCapturePublicationJournal;
  switch (event.type) {
    case "prepare":
      if (current !== null) throw illegalPublicationTransition(current.phase, event.type);
      next = { ...event.journal, version: 2, phase: "preparing" };
      break;
    case "answer-staged": {
      const previous = publicationPredecessor(current, event.type, ["preparing"]);
      assertDurableBrowserAnswerReceipt(event.receipt, previous.receipt);
      next = { ...previous, phase: "staged", artifacts: event.artifacts };
      break;
    }
    case "finalize-bound": {
      const previous = publicationPredecessor(current, event.type, ["staged"]);
      assertDurableBrowserAnswerReceipt(event.receipt, previous.receipt);
      if (event.settlementMode !== "finalize") {
        throw invalidPublicationJournal("finalize-bound requires FINALIZE settlement proof");
      }
      next = {
        ...previous,
        phase: "finalize-bound",
        finalizeSettlementMode: event.settlementMode,
        runtime: event.runtime,
        browserAudit: event.browserAudit,
      };
      break;
    }
    case "completed-session-persisted": {
      const previous = publicationPredecessor(current, event.type, ["finalize-bound"]);
      assertDurableBrowserAnswerReceipt(event.receipt, previous.receipt);
      if (event.completedSessionPersisted !== true) {
        throw invalidPublicationJournal("published requires completed session proof");
      }
      next = {
        ...previous,
        phase: "published",
        completedSessionPersisted: true,
      };
      break;
    }
    case "cleanup-finalization-persisted": {
      const previous = publicationPredecessor(current, event.type, [
        "finalize-bound",
        "published",
        "cleanup-pending",
      ]);
      if (event.completedSessionPersisted !== true) {
        throw invalidPublicationJournal("finalization requires completed session proof");
      }
      const {
        cleanupErrorCode: _cleanupErrorCode,
        cleanupErrorMessage: _cleanupErrorMessage,
        ...journal
      } = previous;
      next =
        event.finalization.status === "pending"
          ? {
              ...journal,
              phase: "cleanup-pending",
              completedSessionPersisted: true,
              runtime: event.finalization.runtime,
              cleanupFinalizationPersisted: true,
              cleanupErrorCode: event.finalization.errorCode,
              cleanupErrorMessage: event.finalization.errorMessage,
            }
          : {
              ...journal,
              phase: "published",
              completedSessionPersisted: true,
              runtime: event.finalization.runtime,
              cleanupFinalizationPersisted: true,
            };
      break;
    }
  }
  assertBrowserCapturePublicationJournal(next, next.sessionId);
  return next;
}

export class BrowserPublicationJournalStore {
  constructor(readonly sessionId: string) {}

  reduce(
    current: BrowserCapturePublicationJournal | null,
    event: BrowserPublicationEvent,
  ): BrowserCapturePublicationJournal {
    if (current) this.assertSession(current.sessionId);
    else if (event.type === "prepare") this.assertSession(event.journal.sessionId);
    return reduceBrowserPublicationEvent(current, event);
  }

  async read(): Promise<BrowserCapturePublicationJournal | null> {
    const journalPath = await resolveJournalPath(this.sessionId);
    try {
      const parsed: unknown = JSON.parse(await readFile(journalPath, "utf8"));
      const journal = upgradeLegacyBrowserCapturePublicationJournal(parsed);
      assertBrowserCapturePublicationJournal(journal, this.sessionId);
      return journal;
    } catch (error) {
      if (readErrorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async transition(
    current: BrowserCapturePublicationJournal | null,
    event: BrowserPublicationEvent,
  ): Promise<BrowserCapturePublicationJournal> {
    const next = this.reduce(current, event);
    await this.write(next);
    return next;
  }

  async remove(
    current: BrowserCapturePublicationJournal | null,
    event: BrowserPublicationRemovalEvent,
  ): Promise<void> {
    if (current) {
      this.assertSession(current.sessionId);
      assertBrowserCapturePublicationJournal(current, this.sessionId);
    }
    if (event.type === "abort-preparation") {
      if (current === null) return;
      if (current.phase !== "preparing") {
        throw illegalPublicationTransition(current.phase, event.type);
      }
      if (!event.receipt) throw invalidPublicationJournal("abort clear requires receipt proof");
      assertDurableBrowserAnswerReceipt(event.receipt, current.receipt);
    } else {
      if (
        !current ||
        (current.phase !== "finalize-bound" &&
          current.phase !== "published" &&
          current.phase !== "cleanup-pending")
      ) {
        throw illegalPublicationTransition(current?.phase ?? null, event.type);
      }
      if (event.completedSessionPersisted !== true) {
        throw invalidPublicationJournal("publication retirement requires completed session proof");
      }
      assertDurableBrowserAnswerReceipt(event.receipt, current.receipt);
    }
    const journalPath = await resolveJournalPath(this.sessionId);
    await rm(journalPath, { force: true });
    await syncDirectory(path.dirname(journalPath));
  }

  private async write(journal: BrowserCapturePublicationJournal): Promise<void> {
    this.assertSession(journal.sessionId);
    assertBrowserCapturePublicationJournal(journal, this.sessionId);
    const journalPath = await resolveJournalPath(this.sessionId);
    await writeFileAtomicDurable(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  }

  private assertSession(sessionId: string | undefined): void {
    if (sessionId !== this.sessionId)
      throw new Error("Browser publication journal changed sessions");
  }
}

export async function readBrowserCapturePublicationJournal(
  sessionId: string,
): Promise<BrowserCapturePublicationJournal | null> {
  return new BrowserPublicationJournalStore(sessionId).read();
}

export function projectCompletedBrowserMetadataAudit(
  browser: NonNullable<SessionMetadata["browser"]>,
  runtime: BrowserRuntimeMetadata,
  cleanupErrorCode?: string,
): NonNullable<SessionMetadata["browser"]> {
  const config = browser.config
    ? {
        desiredModel: browser.config.desiredModel,
        modelStrategy: browser.config.modelStrategy,
        researchMode: browser.config.researchMode,
        thinkingTime: browser.config.thinkingTime,
        archiveConversations: browser.config.archiveConversations,
      }
    : undefined;
  const auditRuntime: BrowserRuntimeMetadata = {
    browserTransport: runtime.browserTransport,
    conversationId:
      runtime.conversationId ??
      (runtime.promptEpoch?.status === "committed"
        ? runtime.promptEpoch.conversationId
        : undefined),
    promptEpoch: runtime.promptEpoch,
  };
  if (runtime.recoveryCleanupResult) {
    auditRuntime.recoveryCleanupResult = {
      status: runtime.recoveryCleanupResult.status,
      ...(runtime.recoveryCleanupResult.settlementMode
        ? { settlementMode: runtime.recoveryCleanupResult.settlementMode }
        : {}),
      ...(runtime.recoveryCleanupResult.lockReleasePending ? { lockReleasePending: true } : {}),
      ...(runtime.recoveryCleanupResult.error
        ? {
            error: `${cleanupErrorCode ?? "browser-cleanup-pending"}: ${sanitizeBrowserPublicationMessage(runtime.recoveryCleanupResult.error)}`,
          }
        : {}),
    };
  }
  return {
    ...(config ? { config } : {}),
    runtime: auditRuntime,
    ...(browser.archive
      ? {
          archive: {
            mode: browser.archive.mode,
            attempted: browser.archive.attempted,
            archived: browser.archive.archived,
            ...(browser.archive.reason
              ? { reason: sanitizeBrowserPublicationMessage(browser.archive.reason) }
              : {}),
            ...(browser.archive.error
              ? { error: sanitizeBrowserPublicationMessage(browser.archive.error) }
              : {}),
          },
        }
      : {}),
    ...(browser.modelSelection ? { modelSelection: browser.modelSelection } : {}),
    ...(browser.warnings
      ? {
          warnings: browser.warnings.map((warning) => ({
            code: warning.code,
            severity: warning.severity,
            message: sanitizeBrowserPublicationMessage(warning.message),
          })),
        }
      : {}),
  };
}

export function sanitizeBrowserPublicationRuntime(
  runtime: BrowserRuntimeMetadata,
  cleanupErrorCode?: string,
): BrowserRuntimeMetadata {
  if (!runtime.recoveryCleanupResult?.error) return runtime;
  return {
    ...runtime,
    recoveryCleanupResult: {
      ...runtime.recoveryCleanupResult,
      error: `${cleanupErrorCode ?? "browser-cleanup-pending"}: ${sanitizeBrowserPublicationMessage(runtime.recoveryCleanupResult.error)}`,
    },
  };
}

export function sanitizeBrowserPublicationMessage(message: string): string {
  return message
    .replace(/\b(?:wss?|https?):\/\/[^\s"'`),}\]]+/giu, "[redacted-endpoint]")
    .replace(/\b(?:[A-Za-z0-9.-]+|\[[0-9a-f:]+\]):\d{2,5}\b/giu, "[redacted-endpoint]")
    .replace(
      /(\b(?:transaction[ _-]?token|access[ _-]?token|auth(?:orization)?|bearer|token|secret|credential|password)\b\s*[:=]\s*)[^\s,"'}\]]+/giu,
      "$1[redacted]",
    )
    .replace(/\b(?:chrome|controller)\s*pid\s*[:=]?\s*\d+/giu, "[redacted-pid]")
    .replace(/(?:~\/|\/(?!\/)[^\s,"'`),}\]]+)/gu, "[redacted-path]")
    .replace(/\b[A-Za-z]:\\[^\s,"'}\]]+/gu, "[redacted-path]")
    .replace(/\b[A-Za-z0-9._~+/=:-]{32,}\b/gu, "[redacted]")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_AUDIT_MESSAGE_CHARS);
}

async function resolveJournalPath(sessionId: string): Promise<string> {
  return path.join((await sessionStore.getPaths(sessionId)).dir, JOURNAL_FILENAME);
}

function upgradeLegacyBrowserCapturePublicationJournal(value: unknown): unknown {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("phase" in value) ||
    typeof value.phase !== "string" ||
    !Object.hasOwn(BROWSER_PUBLICATION_PHASES, value.phase)
  ) {
    return value;
  }
  const phase = value.phase as BrowserPublicationPhase;
  return {
    ...value,
    version: 2,
    ...(phase === "finalize-bound" || phase === "published" || phase === "cleanup-pending"
      ? { finalizeSettlementMode: "finalize" }
      : {}),
    ...(phase === "published" || phase === "cleanup-pending"
      ? { completedSessionPersisted: true }
      : {}),
  };
}

function assertBrowserCapturePublicationJournal(
  value: unknown,
  sessionId: string,
): asserts value is BrowserCapturePublicationJournal {
  if (!value || typeof value !== "object") throw invalidPublicationJournal("not an object");
  if (!("version" in value) || value.version !== 2) {
    throw invalidPublicationJournal("unsupported version");
  }
  if (!("sessionId" in value) || value.sessionId !== sessionId) {
    throw invalidPublicationJournal("session identity mismatch");
  }
  if (
    !("phase" in value) ||
    typeof value.phase !== "string" ||
    !Object.hasOwn(BROWSER_PUBLICATION_PHASES, value.phase)
  ) {
    throw invalidPublicationJournal("unknown phase");
  }
  if (!("completedAt" in value) || typeof value.completedAt !== "string" || !value.completedAt) {
    throw invalidPublicationJournal("completedAt is required");
  }
  if (!("runtime" in value) || !value.runtime || typeof value.runtime !== "object") {
    throw invalidPublicationJournal("runtime is required");
  }
  if (!("browserAudit" in value) || !value.browserAudit || typeof value.browserAudit !== "object") {
    throw invalidPublicationJournal("browserAudit is required");
  }
  if (!("receipt" in value) || !isReceipt(value.receipt)) {
    throw invalidPublicationJournal("durable answer receipt is required");
  }
  if (!("artifacts" in value) || !Array.isArray(value.artifacts)) {
    throw invalidPublicationJournal("artifacts are required");
  }

  const phase = value.phase as BrowserPublicationPhase;
  if (phase !== "preparing" && !artifactsContainReceipt(value.artifacts, value.receipt)) {
    throw invalidPublicationJournal(`${phase} requires its durable answer artifact`);
  }
  const finalizeSettlementMode =
    "finalizeSettlementMode" in value ? value.finalizeSettlementMode : undefined;
  const completedSessionPersisted =
    "completedSessionPersisted" in value ? value.completedSessionPersisted : undefined;
  if (phase === "preparing" || phase === "staged") {
    if (finalizeSettlementMode !== undefined || completedSessionPersisted !== undefined) {
      throw invalidPublicationJournal(`${phase} cannot carry finalization proof`);
    }
  } else if (phase === "finalize-bound") {
    if (finalizeSettlementMode !== "finalize") {
      throw invalidPublicationJournal("finalize-bound requires FINALIZE settlement proof");
    }
    if (completedSessionPersisted !== undefined) {
      throw invalidPublicationJournal("finalize-bound cannot carry completed session proof");
    }
  } else if (finalizeSettlementMode !== "finalize" || completedSessionPersisted !== true) {
    throw invalidPublicationJournal(`${phase} requires FINALIZE and completed session proof`);
  }
  const runtime = value.runtime as BrowserRuntimeMetadata;
  if (
    (phase === "finalize-bound" || phase === "published" || phase === "cleanup-pending") &&
    runtime.recoveryCleanupResult?.settlementMode === "abort"
  ) {
    throw invalidPublicationJournal(`${phase} cannot carry ABORT settlement authority`);
  }

  const cleanupFinalizationPersisted =
    "cleanupFinalizationPersisted" in value ? value.cleanupFinalizationPersisted : undefined;
  const cleanupErrorCode = "cleanupErrorCode" in value ? value.cleanupErrorCode : undefined;
  const cleanupErrorMessage =
    "cleanupErrorMessage" in value ? value.cleanupErrorMessage : undefined;
  if (phase === "cleanup-pending") {
    if (cleanupFinalizationPersisted !== true) {
      throw invalidPublicationJournal("cleanup-pending requires persisted finalization proof");
    }
    if (typeof cleanupErrorCode !== "string" || !cleanupErrorCode) {
      throw invalidPublicationJournal("cleanup-pending requires an error code");
    }
    if (typeof cleanupErrorMessage !== "string" || !cleanupErrorMessage) {
      throw invalidPublicationJournal("cleanup-pending requires an error message");
    }
    return;
  }
  if (cleanupErrorCode !== undefined || cleanupErrorMessage !== undefined) {
    throw invalidPublicationJournal(`${phase} cannot carry cleanup failure metadata`);
  }
  if (
    phase === "published"
      ? cleanupFinalizationPersisted !== undefined && cleanupFinalizationPersisted !== true
      : cleanupFinalizationPersisted !== undefined
  ) {
    throw invalidPublicationJournal(`${phase} has invalid cleanup finalization proof`);
  }
}

function publicationPredecessor<Phase extends BrowserPublicationPhase>(
  current: BrowserCapturePublicationJournal | null,
  event: BrowserPublicationEvent["type"],
  allowed: readonly Phase[],
): Extract<BrowserCapturePublicationJournal, { phase: Phase }> {
  if (!current || !allowed.includes(current.phase as Phase)) {
    throw illegalPublicationTransition(current?.phase ?? null, event);
  }
  return current as Extract<BrowserCapturePublicationJournal, { phase: Phase }>;
}

function illegalPublicationTransition(
  phase: BrowserPublicationPhase | null,
  event: BrowserPublicationEvent["type"] | BrowserPublicationRemovalEvent["type"],
): Error {
  return new Error(`Illegal browser publication transition: ${phase ?? "null"} -> ${event}`);
}

function invalidPublicationJournal(reason: string): Error {
  return new Error(`Browser publication journal is invalid: ${reason}`);
}

function artifactsContainReceipt(
  artifacts: SessionArtifact[],
  receipt: DurableBrowserAnswerReceipt,
): boolean {
  return artifacts.some(
    (artifact) =>
      artifact.kind === receipt.artifact.kind &&
      artifact.path === receipt.artifact.path &&
      artifact.sha256 === receipt.artifact.sha256 &&
      artifact.sizeBytes === receipt.artifact.sizeBytes,
  );
}

function isReceipt(value: unknown): value is DurableBrowserAnswerReceipt {
  if (!value || typeof value !== "object" || !("artifact" in value)) return false;
  const artifact = value.artifact;
  return Boolean(
    artifact &&
    typeof artifact === "object" &&
    "kind" in artifact &&
    artifact.kind === "transcript" &&
    "path" in artifact &&
    typeof artifact.path === "string" &&
    "sha256" in artifact &&
    typeof artifact.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(artifact.sha256) &&
    "sizeBytes" in artifact &&
    typeof artifact.sizeBytes === "number" &&
    Number.isSafeInteger(artifact.sizeBytes) &&
    artifact.sizeBytes >= 0,
  );
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
