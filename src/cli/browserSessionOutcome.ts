import { isDeepStrictEqual } from "node:util";
import { appendArtifacts } from "../browser/artifacts.js";
import type {
  BrowserRuntimeMetadata,
  SessionArtifact,
  SessionMetadata,
  SessionModelRun,
  SessionTransportMetadata,
  SessionUserErrorMetadata,
} from "../sessionStore.js";
import { commitSessionModelProjection, sessionStore } from "../sessionStore.js";
import type { DurableBrowserAnswerReceipt } from "./durableAnswer.js";
import { projectCompletedBrowserMetadataAudit } from "./browserPublicationJournal.js";
import { formatError } from "./errorUtils.js";

type ModelProjectionUpdates = Omit<Partial<SessionModelRun>, "model" | "status" | "completedAt">;

export interface BrowserOutcomeModelProjection {
  model: string;
  updates: ModelProjectionUpdates;
}

interface BrowserOutcomeProjection {
  browser: NonNullable<SessionMetadata["browser"]>;
  runtime: BrowserRuntimeMetadata | undefined;
  response: SessionMetadata["response"];
  reason: string | undefined;
  artifacts: SessionArtifact[] | undefined;
  receipt: DurableBrowserAnswerReceipt | undefined;
  errorMetadata: SessionUserErrorMetadata | undefined;
  transportMetadata: SessionTransportMetadata | undefined;
  modelProjection: BrowserOutcomeModelProjection | undefined;
}

interface PublishedBrowserOutcome extends BrowserOutcomeProjection {
  kind: "published";
  runtime: BrowserRuntimeMetadata;
  response: NonNullable<SessionMetadata["response"]>;
  reason: undefined;
  artifacts: SessionArtifact[];
  receipt: DurableBrowserAnswerReceipt;
  errorMetadata: undefined;
  transportMetadata: undefined;
  usage: SessionMetadata["usage"];
  elapsedMs: number | undefined;
  completedAt?: string;
}

interface PublishedCleanupPendingOutcome extends BrowserOutcomeProjection {
  kind: "cleanup-pending";
  publication: "published";
  runtime: BrowserRuntimeMetadata;
  response: NonNullable<SessionMetadata["response"]>;
  reason: string;
  artifacts: SessionArtifact[];
  receipt: DurableBrowserAnswerReceipt;
  errorMetadata: undefined;
  transportMetadata: undefined;
  usage: SessionMetadata["usage"];
  elapsedMs: number | undefined;
  completedAt?: string;
}

interface UnpublishedCleanupPendingOutcome extends BrowserOutcomeProjection {
  kind: "cleanup-pending";
  publication: "unpublished";
  runtime: BrowserRuntimeMetadata;
  reason: string;
}

interface RecoveryRunningOutcome extends BrowserOutcomeProjection {
  kind: "recovery-running";
  runtime: BrowserRuntimeMetadata;
  response: NonNullable<SessionMetadata["response"]>;
  reason: string;
}

interface TerminalErrorOutcome extends BrowserOutcomeProjection {
  kind: "terminal-error";
  reason: string;
}

export type BrowserSessionOutcome =
  | PublishedBrowserOutcome
  | PublishedCleanupPendingOutcome
  | UnpublishedCleanupPendingOutcome
  | RecoveryRunningOutcome
  | TerminalErrorOutcome;
export type BrowserSessionProjectionPersistence =
  | { status: "persisted"; metadata: SessionMetadata; recoveredError?: string }
  | { status: "pending"; error: string; cause: unknown };

export async function commitBrowserSessionOutcomeProjection(
  sessionId: string,
  outcome: BrowserSessionOutcome,
): Promise<BrowserSessionProjectionPersistence> {
  const current = await sessionStore.readSession(sessionId).catch(() => null);
  const projection = buildBrowserSessionOutcomeProjection(outcome, current);
  if (matchesProjection(current, projection)) return { status: "persisted", metadata: current };
  let firstError: unknown;
  try {
    const committed = await commitSessionModelProjection(sessionId, projection);
    if (matchesProjection(committed.session, projection)) {
      return { status: "persisted", metadata: committed.session };
    }
    firstError = new Error("Terminal session/model projection commit returned mismatched metadata");
  } catch (error) {
    firstError = error;
  }
  let observed = await sessionStore.readSession(sessionId).catch(() => null);
  if (matchesProjection(observed, projection)) {
    return { status: "persisted", metadata: observed, recoveredError: formatError(firstError) };
  }

  try {
    const committed = await commitSessionModelProjection(sessionId, projection);
    if (matchesProjection(committed.session, projection)) {
      return {
        status: "persisted",
        metadata: committed.session,
        recoveredError: formatError(firstError),
      };
    }
    observed = await sessionStore.readSession(sessionId).catch(() => null);
    if (matchesProjection(observed, projection)) {
      return { status: "persisted", metadata: observed, recoveredError: formatError(firstError) };
    }
    const error = new Error("Terminal session/model projection retry returned mismatched metadata");
    return { status: "pending", error: error.message, cause: error };
  } catch (error) {
    observed = await sessionStore.readSession(sessionId).catch(() => null);
    if (matchesProjection(observed, projection)) {
      return { status: "persisted", metadata: observed, recoveredError: formatError(firstError) };
    }
    return { status: "pending", error: formatError(error), cause: error };
  }
}

export async function persistBrowserSessionOutcome(
  sessionId: string,
  outcome: BrowserSessionOutcome,
): Promise<void> {
  const persistence = await commitBrowserSessionOutcomeProjection(sessionId, outcome);
  if (persistence.status === "pending") throw persistence.cause;
}

function buildBrowserSessionOutcomeProjection(
  outcome: BrowserSessionOutcome,
  current: SessionMetadata | null,
): Parameters<typeof commitSessionModelProjection>[1] {
  const artifacts = appendArtifacts(outcome.artifacts, [outcome.receipt?.artifact]);
  const browser = {
    ...outcome.browser,
    runtime: outcome.runtime,
  };
  if (
    outcome.kind === "published" ||
    (outcome.kind === "cleanup-pending" && outcome.publication === "published")
  ) {
    const completedAt = outcome.completedAt ?? current?.completedAt ?? new Date().toISOString();
    const cleanupErrorCode =
      outcome.kind === "cleanup-pending" ? "browser-cleanup-finalize-pending" : undefined;
    const prefixedCleanupError = cleanupErrorCode ? `${cleanupErrorCode}: ` : undefined;
    const auditRuntime =
      prefixedCleanupError &&
      outcome.runtime.recoveryCleanupResult?.error?.startsWith(prefixedCleanupError)
        ? {
            ...outcome.runtime,
            recoveryCleanupResult: {
              ...outcome.runtime.recoveryCleanupResult,
              error: outcome.runtime.recoveryCleanupResult.error.slice(prefixedCleanupError.length),
            },
          }
        : outcome.runtime;
    const publishedBrowser = projectCompletedBrowserMetadataAudit(
      outcome.browser,
      auditRuntime,
      cleanupErrorCode,
    );
    const publishedArtifacts = appendArtifacts(current?.artifacts, artifacts ?? []);
    return {
      session: {
        status: "completed",
        completedAt,
        usage: outcome.usage,
        elapsedMs: outcome.elapsedMs,
        errorMessage: undefined,
        mode: "browser",
        browser: publishedBrowser,
        artifacts: publishedArtifacts,
        response: outcome.response,
        transport: undefined,
        error: undefined,
      },
      ...(outcome.modelProjection
        ? {
            model: {
              model: outcome.modelProjection.model,
              updates: {
                ...outcome.modelProjection.updates,
                status: "completed",
                completedAt,
              },
            },
          }
        : {}),
    };
  }

  if (outcome.kind === "recovery-running") {
    return {
      session: {
        status: "running",
        completedAt: undefined,
        errorMessage: outcome.reason,
        mode: "browser",
        browser,
        ...(artifacts ? { artifacts } : {}),
        response: outcome.response,
        transport: outcome.transportMetadata,
        error: outcome.errorMetadata,
      },
      ...(outcome.modelProjection
        ? {
            model: {
              model: outcome.modelProjection.model,
              updates: {
                ...outcome.modelProjection.updates,
                status: "running",
                completedAt: undefined,
              },
            },
          }
        : {}),
    };
  }

  const completedAt = new Date().toISOString();
  return {
    session: {
      status: "error",
      completedAt,
      errorMessage: outcome.reason,
      mode: "browser",
      browser,
      ...(artifacts ? { artifacts } : {}),
      response: outcome.response,
      transport: outcome.transportMetadata,
      error: outcome.errorMetadata,
    },
    ...(outcome.modelProjection
      ? {
          model: {
            model: outcome.modelProjection.model,
            updates: {
              ...outcome.modelProjection.updates,
              status: "error",
              completedAt,
            },
          },
        }
      : {}),
  };
}

function matchesProjection(
  current: SessionMetadata | null,
  projection: Parameters<typeof commitSessionModelProjection>[1],
): current is SessionMetadata {
  if (!current) return false;
  for (const [key, expected] of Object.entries(projection.session)) {
    if (!isDeepStrictEqual(current[key as keyof SessionMetadata], expected)) return false;
  }
  if (!projection.model) return true;
  if (current.modelProjectionAuthority !== "session") return false;
  const model = current.models?.find((run) => run.model === projection.model?.model);
  if (!model) return false;
  for (const [key, expected] of Object.entries(projection.model.updates)) {
    if (!isDeepStrictEqual(model[key as keyof SessionModelRun], expected)) return false;
  }
  return true;
}
