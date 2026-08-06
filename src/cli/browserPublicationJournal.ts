import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import type { BrowserRuntimeMetadata, SessionArtifact, SessionMetadata } from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";
import { syncDirectoryIfSupported, writeFileAtomicDurable } from "../sessionManager.js";
import type { DurableBrowserAnswerReceipt } from "./durableBrowserAnswerFile.js";

const JOURNAL_FILENAME = "browser-capture-publication.json";
const MAX_AUDIT_MESSAGE_CHARS = 240;

export type BrowserPublicationPhase =
  | "preparing"
  | "staged"
  | "finalize-bound"
  | "published"
  | "cleanup-pending";
const BROWSER_PUBLICATION_PHASES: Readonly<
  Record<BrowserPublicationPhase, { acknowledged: boolean }>
> = {
  preparing: { acknowledged: false },
  staged: { acknowledged: false },
  "finalize-bound": { acknowledged: false },
  published: { acknowledged: true },
  "cleanup-pending": { acknowledged: true },
};

export function isBrowserPublicationPhase(value: unknown): value is BrowserPublicationPhase {
  return typeof value === "string" && value in BROWSER_PUBLICATION_PHASES;
}

export function isBrowserPublicationAcknowledged(
  phase: BrowserPublicationPhase | null | undefined,
): boolean {
  return phase ? BROWSER_PUBLICATION_PHASES[phase].acknowledged : false;
}

export interface BrowserCapturePublicationJournal {
  version: 1;
  sessionId: string;
  phase: BrowserPublicationPhase;
  receipt: DurableBrowserAnswerReceipt;
  artifacts: SessionArtifact[];
  completedAt: string;
  usage?: SessionMetadata["usage"];
  elapsedMs?: number;
  response?: SessionMetadata["response"];
  model?: string;
  browserAudit: NonNullable<SessionMetadata["browser"]>;
  runtime: BrowserRuntimeMetadata;
  cleanupFinalizationPersisted?: true;
  cleanupErrorCode?: string;
  cleanupErrorMessage?: string;
}

export async function readBrowserCapturePublicationJournal(
  sessionId: string,
): Promise<BrowserCapturePublicationJournal | null> {
  const journalPath = await resolveJournalPath(sessionId);
  try {
    const parsed: unknown = JSON.parse(await readFile(journalPath, "utf8"));
    if (!isBrowserCapturePublicationJournal(parsed, sessionId)) {
      throw new Error(`Browser publication journal is invalid: ${journalPath}`);
    }
    return parsed;
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  }
}

export async function writeBrowserCapturePublicationJournal(
  journal: BrowserCapturePublicationJournal,
): Promise<void> {
  const journalPath = await resolveJournalPath(journal.sessionId);
  await writeFileAtomicDurable(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
}

export async function clearBrowserCapturePublicationJournal(sessionId: string): Promise<void> {
  const journalPath = await resolveJournalPath(sessionId);
  await rm(journalPath, { force: true });
  await syncDirectoryIfSupported(path.dirname(journalPath));
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

function isBrowserCapturePublicationJournal(
  value: unknown,
  sessionId: string,
): value is BrowserCapturePublicationJournal {
  if (!value || typeof value !== "object") return false;
  if (!("version" in value) || value.version !== 1) return false;
  if (!("sessionId" in value) || value.sessionId !== sessionId) return false;
  if (!("phase" in value) || !isBrowserPublicationPhase(value.phase)) return false;
  if (!("completedAt" in value) || typeof value.completedAt !== "string") return false;
  if (!("runtime" in value) || !value.runtime || typeof value.runtime !== "object") return false;
  if (!("browserAudit" in value) || !value.browserAudit || typeof value.browserAudit !== "object") {
    return false;
  }
  if (!("receipt" in value) || !isReceipt(value.receipt)) return false;
  return "artifacts" in value && Array.isArray(value.artifacts);
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
