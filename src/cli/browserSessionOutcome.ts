import { isDeepStrictEqual } from "node:util";
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

export async function persistBrowserSessionOutcome(
  sessionId: string,
  outcome: BrowserSessionOutcome,
): Promise<void> {
  const current = await sessionStore.readSession(sessionId).catch(() => null);
  const projection = projectBrowserSessionOutcome(outcome, current);
  if (matchesProjection(current, projection)) return;
  try {
    await commitSessionModelProjection(sessionId, projection);
    return;
  } catch {
    const observed = await sessionStore.readSession(sessionId).catch(() => null);
    if (matchesProjection(observed, projection)) return;
  }

  try {
    await commitSessionModelProjection(sessionId, projection);
  } catch (error) {
    const observed = await sessionStore.readSession(sessionId).catch(() => null);
    if (matchesProjection(observed, projection)) return;
    throw error;
  }
}

function projectBrowserSessionOutcome(
  outcome: BrowserSessionOutcome,
  current: SessionMetadata | null,
): Parameters<typeof commitSessionModelProjection>[1] {
  const artifacts = mergeArtifacts(
    outcome.artifacts,
    outcome.receipt ? [outcome.receipt.artifact] : undefined,
  );
  const browser = {
    ...outcome.browser,
    runtime: outcome.runtime,
  };
  if (
    outcome.kind === "published" ||
    (outcome.kind === "cleanup-pending" && outcome.publication === "published")
  ) {
    const completedAt = current?.completedAt ?? new Date().toISOString();
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
    const publishedBrowser =
      current?.status === "completed" && current.browser
        ? current.browser
        : projectCompletedBrowserMetadataAudit(outcome.browser, auditRuntime, cleanupErrorCode);
    const publishedArtifacts = mergeArtifacts(current?.artifacts, artifacts);
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

function mergeArtifacts(
  existing: SessionArtifact[] | undefined,
  additions: SessionArtifact[] | undefined,
): SessionArtifact[] | undefined {
  if (!existing?.length && !additions?.length) return undefined;
  const merged = [...(existing ?? [])];
  for (const artifact of additions ?? []) {
    if (
      !merged.some(
        (candidate) => candidate.kind === artifact.kind && candidate.path === artifact.path,
      )
    ) {
      merged.push(artifact);
    }
  }
  return merged;
}

function matchesProjection(
  current: SessionMetadata | null,
  projection: Parameters<typeof commitSessionModelProjection>[1],
): boolean {
  if (!current) return false;
  for (const [key, expected] of Object.entries(projection.session)) {
    if (!isDeepStrictEqual(current[key as keyof SessionMetadata], expected)) return false;
  }
  if (!projection.model) return true;
  const model = current.models?.find((run) => run.model === projection.model?.model);
  if (!model) return false;
  for (const [key, expected] of Object.entries(projection.model.updates)) {
    if (!isDeepStrictEqual(model[key as keyof SessionModelRun], expected)) return false;
  }
  return true;
}
