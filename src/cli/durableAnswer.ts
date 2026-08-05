import { createHash } from "node:crypto";
import path from "node:path";
import { open, mkdir, lstat } from "node:fs/promises";
import type { Stats } from "node:fs";
import type {
  BrowserRuntimeMetadata,
  SessionArtifact,
  SessionMetadata,
  SessionModelRun,
} from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";
import type { BrowserCaptureFinalizationResult, BrowserRunTransaction } from "../browser/types.js";
import {
  bindBrowserCaptureCleanupSettlement,
  pendingBrowserCaptureCleanup,
} from "../browser/runLifecycle.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { syncDirectoryIfSupported, writeFileAtomicDurable } from "../sessionManager.js";
import {
  clearBrowserCapturePublicationJournal,
  projectCompletedBrowserMetadataAudit,
  readBrowserCapturePublicationJournal,
  sanitizeBrowserPublicationMessage,
  sanitizeBrowserPublicationRuntime,
  writeBrowserCapturePublicationJournal,
  type BrowserCapturePublicationJournal,
} from "./browserPublicationJournal.js";

export interface DurableBrowserAnswerReceipt {
  artifact: SessionArtifact;
}

export interface PersistDurableBrowserAnswerOptions {
  sessionId: string;
  answer: string;
  logHeader?: string;
  replaceLog?: boolean;
}

export interface BrowserCapturePublicationAcknowledgement {
  isPublished: () => boolean;
  acknowledge: () => void;
}

export function createBrowserCapturePublicationAcknowledgement(): BrowserCapturePublicationAcknowledgement {
  let published = false;
  return {
    isPublished: () => published,
    acknowledge: () => {
      published = true;
    },
  };
}

type RuntimeAuthorityPersistence =
  | { status: "persisted"; recoveredError?: string }
  | { status: "pending"; error: string };

type ModelRunProjection =
  | { status: "not-requested" }
  | { status: "persisted"; recoveredError?: string }
  | { status: "pending"; error: string };

export interface PublishedBrowserCapture {
  published: true;
  receipt: DurableBrowserAnswerReceipt;
  artifacts: SessionArtifact[];
  finalization: BrowserCaptureFinalizationResult;
  runtimeAuthority: RuntimeAuthorityPersistence;
  modelRun: ModelRunProjection;
}

export interface PublishCompletedBrowserCaptureOptions {
  answer: PersistDurableBrowserAnswerOptions;
  transaction: Pick<BrowserRunTransaction, "runtime" | "bindSettlement" | "finalize" | "abort">;
  browser: NonNullable<SessionMetadata["browser"]>;
  existingArtifacts?: SessionArtifact[];
  prepareArtifacts?: () => Promise<SessionArtifact[] | undefined>;
  usage?: SessionMetadata["usage"];
  elapsedMs?: number;
  response?: SessionMetadata["response"];
  model?: string;
  projectRuntime?: (runtime: BrowserRuntimeMetadata) => BrowserRuntimeMetadata;
  acknowledgement?: BrowserCapturePublicationAcknowledgement;
  log?: (message: string) => void;
  label?: string;
  persistAnswer?: typeof persistDurableBrowserAnswer;
}

/**
 * Publishes a completed browser capture through a crash-recoverable transaction:
 * journal the exact answer intent, durably stage answer/artifacts, bind FINALIZE remotely and
 * locally, commit audit-only completed projections, then execute idempotent finalize effects.
 * Only a pre-stage failure may select ABORT.
 */
export async function publishCompletedBrowserCapture(
  options: PublishCompletedBrowserCaptureOptions,
): Promise<PublishedBrowserCapture> {
  const label = options.label ?? "Browser answer";
  const projectRuntime = options.projectRuntime ?? ((runtime) => runtime);
  let journal = await readBrowserCapturePublicationJournal(options.answer.sessionId);
  if (journal) {
    assertJournalMatchesCapture(journal, options.transaction.runtime);
    journal = await recognizeCommittedPublication(journal);
  } else {
    try {
      journal = await prepareBrowserCapturePublication(options, projectRuntime);
    } catch (stageError) {
      return abortPreStageFailure(options, stageError, projectRuntime);
    }
  }

  if (journal.phase === "preparing") {
    try {
      journal = await stageBrowserCapture(options, journal);
    } catch (stageError) {
      return abortPreStageFailure(options, stageError, projectRuntime);
    }
  }

  if (journal.phase === "staged") {
    journal = await bindFinalizeAuthority(options, journal, projectRuntime);
  }

  if (journal.phase === "finalize-bound") {
    await persistFinalizeBoundRuntime(options, journal);
    journal = await commitStagedPublication(options, journal, label);
  }

  options.acknowledgement?.acknowledge();
  const modelRun = await persistCompletedModelRun(options, journal.completedAt, label);

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

  try {
    await persistFinalizationState(options, journal, finalization);
    return completedPublication(journal, finalization, { status: "persisted" }, modelRun);
  } catch (persistenceError) {
    const authorityError = runtimeAuthorityPersistenceFailure(
      journal,
      finalization,
      persistenceError,
    );
    if (!isRuntimeAuthorityPersistenceFailure(authorityError)) throw authorityError;
    try {
      await persistFinalizationState(options, journal, finalization);
      const recoveredError = formatError(authorityError);
      options.log?.(
        `${label} published; recovered final cleanup authority persistence after retry: ${recoveredError}`,
      );
      return completedPublication(
        journal,
        finalization,
        { status: "persisted", recoveredError },
        modelRun,
      );
    } catch (retryError) {
      const message = formatError(retryError);
      options.log?.(
        `${label} published; exact cleanup authority persistence remains deferred after retry: ${message}`,
      );
      return completedPublication(
        journal,
        finalization,
        { status: "pending", error: message },
        modelRun,
      );
    }
  }
}

export async function persistDurableBrowserAnswer(
  options: PersistDurableBrowserAnswerOptions,
  expectedReceipt?: DurableBrowserAnswerReceipt,
): Promise<DurableBrowserAnswerReceipt> {
  const prepared = await prepareDurableBrowserAnswer(options);
  if (expectedReceipt) assertDurableBrowserAnswerReceipt(prepared.receipt, expectedReceipt);

  const artifactsDir = path.dirname(prepared.receipt.artifact.path);
  await mkdir(artifactsDir, { recursive: true });
  await syncDirectoryIfSupported(prepared.paths.dir);
  await ensureDurableFile(prepared.receipt.artifact.path, prepared.payload);

  if (options.logHeader) {
    const logPayload = Buffer.from(`${options.logHeader}\nAnswer:\n${options.answer}\n`, "utf8");
    if (options.replaceLog) {
      await writeFileAtomicDurable(prepared.paths.log, logPayload);
    } else {
      await appendDurableFile(prepared.paths.log, logPayload);
    }
  }

  return expectedReceipt ?? prepared.receipt;
}

export async function readDurableBrowserAnswer(
  receipt: DurableBrowserAnswerReceipt,
): Promise<string | null> {
  const targetPath = receipt.artifact.path;
  let entry: Stats;
  try {
    entry = await lstat(targetPath);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (!entry.isFile()) {
    throw new Error(`Durable browser answer is not a regular file: ${targetPath}`);
  }

  const handle = await open(targetPath, "r");
  try {
    const before = await handle.stat();
    if (!isUnchangedFile(entry, before)) {
      throw new Error(`Durable browser answer path changed during recovery: ${targetPath}`);
    }
    const payload = await handle.readFile();
    const afterRead = await handle.stat();
    if (!isUnchangedFile(before, afterRead)) {
      throw new Error(`Durable browser answer changed during recovery: ${targetPath}`);
    }
    const sha256 = createHash("sha256").update(payload).digest("hex");
    if (payload.byteLength !== receipt.artifact.sizeBytes || sha256 !== receipt.artifact.sha256) {
      throw new Error(`Durable browser answer receipt mismatch: ${targetPath}`);
    }
    const named = await lstat(targetPath);
    if (!isUnchangedFile(afterRead, named)) {
      throw new Error(`Durable browser answer path changed during recovery: ${targetPath}`);
    }
    return payload.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function prepareDurableBrowserAnswer(options: PersistDurableBrowserAnswerOptions) {
  if (!options.answer.trim()) {
    throw new Error("Cannot persist an empty browser answer");
  }
  const payload = Buffer.from(options.answer, "utf8");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const paths = await sessionStore.getPaths(options.sessionId);
  const answerPath = path.join(paths.dir, "artifacts", `browser-answer-${sha256}.md`);
  const receipt: DurableBrowserAnswerReceipt = {
    artifact: {
      kind: "transcript",
      path: answerPath,
      label: "Durable browser answer",
      mimeType: "text/markdown",
      sizeBytes: payload.byteLength,
      sha256,
      validation: { type: "generic", ok: true },
      transfer: { status: "not-needed" },
      origin: { mode: "local" },
    },
  };
  return { paths, payload, receipt };
}

export function durableBrowserAnswerReceiptFromError(
  error: unknown,
): DurableBrowserAnswerReceipt | undefined {
  if (!(error instanceof BrowserAutomationError)) return undefined;
  const receipt = error.details?.answerReceipt;
  if (!receipt || typeof receipt !== "object" || !("artifact" in receipt)) return undefined;
  return receipt as DurableBrowserAnswerReceipt;
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
): Promise<BrowserCapturePublicationJournal> {
  const { receipt } = await prepareDurableBrowserAnswer(options.answer);
  const runtime = projectRuntime(options.transaction.runtime);
  const journal: BrowserCapturePublicationJournal = {
    version: 1,
    sessionId: options.answer.sessionId,
    phase: "preparing",
    receipt,
    artifacts: options.existingArtifacts ?? [],
    completedAt: new Date().toISOString(),
    usage: options.usage,
    elapsedMs: options.elapsedMs,
    response: options.response,
    model: options.model,
    browserAudit: projectCompletedBrowserMetadataAudit(options.browser, runtime),
    runtime,
  };
  await writeBrowserCapturePublicationJournal(journal);
  return journal;
}

async function stageBrowserCapture(
  options: PublishCompletedBrowserCaptureOptions,
  journal: BrowserCapturePublicationJournal,
): Promise<BrowserCapturePublicationJournal> {
  const persistAnswer = options.persistAnswer ?? persistDurableBrowserAnswer;
  const preparedAnswer = await prepareDurableBrowserAnswer(options.answer);
  assertDurableBrowserAnswerReceipt(preparedAnswer.receipt, journal.receipt);
  const existingAnswer = await readDurableBrowserAnswer(journal.receipt);
  const receipt =
    existingAnswer === null
      ? await persistAnswer(options.answer, journal.receipt)
      : journal.receipt;
  assertDurableBrowserAnswerReceipt(receipt, journal.receipt);
  try {
    const preparedArtifacts = await options.prepareArtifacts?.();
    const stagedJournal: BrowserCapturePublicationJournal = {
      ...journal,
      phase: "staged",
      receipt,
      artifacts: mergeArtifacts(
        journal.artifacts.filter(
          (artifact) =>
            artifact.kind !== receipt.artifact.kind || artifact.path !== receipt.artifact.path,
        ),
        [...(preparedArtifacts ?? []), receipt.artifact],
      ),
    };
    await writeBrowserCapturePublicationJournal(stagedJournal);
    return stagedJournal;
  } catch (error) {
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

async function bindFinalizeAuthority(
  options: PublishCompletedBrowserCaptureOptions,
  journal: BrowserCapturePublicationJournal,
  projectRuntime: (runtime: BrowserRuntimeMetadata) => BrowserRuntimeMetadata,
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
  const boundJournal: BrowserCapturePublicationJournal = {
    ...journal,
    phase: "finalize-bound",
    runtime: sanitizeBrowserPublicationRuntime(boundRuntime, "finalize-bound"),
    browserAudit: projectCompletedBrowserMetadataAudit(options.browser, boundRuntime),
  };
  try {
    await writeBrowserCapturePublicationJournal(boundJournal);
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
  return boundJournal;
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

async function commitStagedPublication(
  options: PublishCompletedBrowserCaptureOptions,
  journal: BrowserCapturePublicationJournal,
  label: string,
): Promise<BrowserCapturePublicationJournal> {
  try {
    await persistCompletedSession(options, journal, journal.runtime);
  } catch (error) {
    try {
      await persistCompletedSession(options, journal, journal.runtime);
    } catch (retryError) {
      throw new BrowserAutomationError(
        `${label} remains staged under FINALIZE authority because completed publication failed: ${formatError(retryError)}`,
        {
          stage: "browser-capture-publication",
          code: "finalize-bound-publication-pending",
          runtime: journal.runtime,
          answerReceipt: journal.receipt,
          firstError: formatError(error),
        },
        retryError,
      );
    }
  }
  options.acknowledgement?.acknowledge();
  const publishedJournal = { ...journal, phase: "published" as const };
  try {
    await writeBrowserCapturePublicationJournal(publishedJournal);
  } catch (error) {
    options.log?.(
      `${label} completed projection is durable; publication journal phase update remains retryable: ${formatError(error)}`,
    );
  }
  return publishedJournal;
}

async function recognizeCommittedPublication(
  journal: BrowserCapturePublicationJournal,
): Promise<BrowserCapturePublicationJournal> {
  if (journal.phase !== "finalize-bound") return journal;
  const metadata = await sessionStore.readSession(journal.sessionId);
  if (
    metadata?.status !== "completed" ||
    !metadata.artifacts?.some(
      (artifact) =>
        artifact.path === journal.receipt.artifact.path &&
        artifact.sha256 === journal.receipt.artifact.sha256,
    )
  ) {
    return journal;
  }
  return { ...journal, phase: "published" };
}

async function persistCompletedSession(
  options: PublishCompletedBrowserCaptureOptions,
  journal: BrowserCapturePublicationJournal,
  runtime: BrowserRuntimeMetadata,
  cleanupErrorCode?: string,
): Promise<void> {
  await sessionStore.updateSession(options.answer.sessionId, {
    status: "completed",
    completedAt: journal.completedAt,
    usage: journal.usage,
    elapsedMs: journal.elapsedMs,
    errorMessage: undefined,
    browser: projectCompletedBrowserMetadataAudit(options.browser, runtime, cleanupErrorCode),
    artifacts: journal.artifacts,
    response: journal.response,
    transport: undefined,
    error: undefined,
  });
}

async function persistCompletedModelRun(
  options: PublishCompletedBrowserCaptureOptions,
  completedAt: string,
  label: string,
): Promise<ModelRunProjection> {
  if (!options.model) return { status: "not-requested" };
  const updates: Partial<SessionModelRun> = {
    status: "completed",
    completedAt,
    usage: options.usage,
    response: { status: "completed" },
    transport: undefined,
    error: undefined,
  };
  try {
    await sessionStore.updateModelRun(options.answer.sessionId, options.model, updates);
    return { status: "persisted" };
  } catch (error) {
    const firstError = formatError(error);
    try {
      await sessionStore.updateModelRun(options.answer.sessionId, options.model, updates);
      options.log?.(
        `${label} published; recovered model-run projection after retry: ${firstError}`,
      );
      return { status: "persisted", recoveredError: firstError };
    } catch (retryError) {
      const message = formatError(retryError);
      options.log?.(`${label} published; model-run projection failed after retry: ${message}`);
      return { status: "pending", error: message };
    }
  }
}

async function persistFinalizationState(
  options: PublishCompletedBrowserCaptureOptions,
  journal: BrowserCapturePublicationJournal,
  finalization: BrowserCaptureFinalizationResult,
): Promise<void> {
  if (finalization.status === "pending") {
    const pendingJournal: BrowserCapturePublicationJournal = {
      ...journal,
      phase: "cleanup-pending",
      runtime: sanitizeBrowserPublicationRuntime(
        finalization.runtime,
        "browser-cleanup-finalize-pending",
      ),
      cleanupErrorCode: "browser-cleanup-finalize-pending",
      cleanupErrorMessage: projectCompletedBrowserMetadataAudit(
        options.browser,
        finalization.runtime,
        "browser-cleanup-finalize-pending",
      ).runtime?.recoveryCleanupResult?.error,
    };
    await writeBrowserCapturePublicationJournal(pendingJournal);
    await persistCompletedSession(
      options,
      pendingJournal,
      finalization.runtime,
      "browser-cleanup-finalize-pending",
    );
    return;
  }
  await persistCompletedSession(options, journal, finalization.runtime);
  await clearBrowserCapturePublicationJournal(options.answer.sessionId);
}

async function abortPreStageFailure(
  options: PublishCompletedBrowserCaptureOptions,
  stageError: unknown,
  projectRuntime: (runtime: BrowserRuntimeMetadata) => BrowserRuntimeMetadata,
): Promise<never> {
  const answerReceipt = durableBrowserAnswerReceiptFromError(stageError);
  const artifacts = answerReceipt
    ? mergeArtifacts(options.existingArtifacts, [answerReceipt.artifact])
    : undefined;
  let boundRuntime: BrowserRuntimeMetadata;
  try {
    boundRuntime = projectRuntime(await options.transaction.bindSettlement("abort"));
  } catch (bindingError) {
    throw new BrowserAutomationError(
      `Browser capture staging failed (${formatError(stageError)}); ABORT authority could not be bound: ${formatError(bindingError)}`,
      {
        stage: "browser-capture-publication",
        code: "abort-binding-failed",
        runtime: runtimeFromBrowserError(bindingError) ?? options.transaction.runtime,
        answerReceipt,
      },
      stageError,
    );
  }
  try {
    await sessionStore.updateSession(options.answer.sessionId, {
      browser: { ...options.browser, runtime: boundRuntime },
      ...(artifacts ? { artifacts } : {}),
    });
  } catch (persistenceError) {
    throw new BrowserAutomationError(
      `Browser capture staging failed (${formatError(stageError)}); bound ABORT authority could not be projected locally: ${formatError(persistenceError)}`,
      {
        stage: "browser-capture-publication",
        code: "abort-authority-persistence-failed",
        runtime: boundRuntime,
        answerReceipt,
      },
      stageError,
    );
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
          answerReceipt,
          firstError: formatError(error),
        },
        retryError,
      );
    }
  }
  if (answerReceipt) {
    try {
      await clearBrowserCapturePublicationJournal(options.answer.sessionId);
    } catch (clearError) {
      throw new BrowserAutomationError(
        `Browser capture staging failed (${formatError(stageError)}); durable publication intent cleanup remains pending: ${formatError(clearError)}`,
        {
          stage: "browser-capture-publication",
          code: "abort-publication-journal-cleanup-failed",
          runtime: abortionRuntime,
          answerReceipt,
        },
        clearError,
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
        answerReceipt,
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
  finalization: BrowserCaptureFinalizationResult,
  runtimeAuthority: RuntimeAuthorityPersistence,
  modelRun: ModelRunProjection,
): PublishedBrowserCapture {
  return {
    published: true,
    receipt: journal.receipt,
    artifacts: journal.artifacts,
    finalization,
    runtimeAuthority,
    modelRun,
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

function assertDurableBrowserAnswerReceipt(
  actual: DurableBrowserAnswerReceipt,
  expected: DurableBrowserAnswerReceipt,
): void {
  if (
    actual.artifact.kind !== expected.artifact.kind ||
    actual.artifact.path !== expected.artifact.path ||
    actual.artifact.sha256 !== expected.artifact.sha256 ||
    actual.artifact.sizeBytes !== expected.artifact.sizeBytes
  ) {
    throw new Error("Durable browser answer receipt does not match its publication intent");
  }
}

function mergeArtifacts(
  existing: SessionArtifact[] | undefined,
  additions: SessionArtifact[],
): SessionArtifact[] {
  const merged = new Map<string, SessionArtifact>();
  for (const artifact of existing ?? []) {
    merged.set(`${artifact.kind}:${artifact.path}`, artifact);
  }
  for (const artifact of additions) {
    merged.set(`${artifact.kind}:${artifact.path}`, artifact);
  }
  return Array.from(merged.values());
}

async function ensureDurableFile(targetPath: string, payload: Buffer): Promise<void> {
  let entry: Stats;
  try {
    entry = await lstat(targetPath);
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
    await writeFileAtomicDurable(targetPath, payload);
    entry = await lstat(targetPath);
  }
  if (!entry.isFile()) {
    throw new Error(`Durable browser answer is not a regular file: ${targetPath}`);
  }

  const handle = await open(targetPath, "r+");
  try {
    const before = await handle.stat();
    if (!isUnchangedFile(entry, before)) {
      throw new Error(`Durable browser answer path changed during verification: ${targetPath}`);
    }
    const existing = await handle.readFile();
    const afterRead = await handle.stat();
    if (!isUnchangedFile(before, afterRead)) {
      throw new Error(`Durable browser answer changed during verification: ${targetPath}`);
    }
    if (!existing.equals(payload)) {
      throw new Error(`Durable browser answer hash collision: ${targetPath}`);
    }
    await handle.sync();
    const afterSync = await handle.stat();
    if (!isUnchangedFile(before, afterSync)) {
      throw new Error(`Durable browser answer changed during verification: ${targetPath}`);
    }
    await syncDirectoryIfSupported(path.dirname(targetPath));
    const named = await lstat(targetPath);
    if (!isUnchangedFile(afterSync, named)) {
      throw new Error(`Durable browser answer path changed during verification: ${targetPath}`);
    }
  } finally {
    await handle.close();
  }
}

function isUnchangedFile(
  before: { dev: number; ino: number; size: number; mtimeMs: number },
  after: { dev: number; ino: number; size: number; mtimeMs: number },
): boolean {
  return (
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.size === before.size &&
    after.mtimeMs === before.mtimeMs
  );
}

async function appendDurableFile(targetPath: string, payload: Buffer): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const handle = await open(targetPath, "a", 0o600);
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeBrowserPublicationMessage(message) || "browser publication failed";
}
