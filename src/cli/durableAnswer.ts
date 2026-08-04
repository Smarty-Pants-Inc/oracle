import { createHash } from "node:crypto";
import path from "node:path";
import { open, mkdir, lstat } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { BrowserRuntimeMetadata, SessionArtifact } from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";
import type { BrowserCaptureFinalizationResult } from "../browser/types.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { syncDirectoryIfSupported, writeFileAtomicDurable } from "../sessionManager.js";

export interface DurableBrowserAnswerReceipt {
  artifact: SessionArtifact;
  sha256: string;
  sizeBytes: number;
}

export interface PersistDurableBrowserAnswerOptions {
  sessionId: string;
  answer: string;
  logHeader?: string;
  replaceLog?: boolean;
}

export async function persistDurableBrowserAnswer(
  options: PersistDurableBrowserAnswerOptions,
): Promise<DurableBrowserAnswerReceipt> {
  if (!options.answer.trim()) {
    throw new Error("Cannot persist an empty browser answer");
  }
  const payload = Buffer.from(options.answer, "utf8");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const paths = await sessionStore.getPaths(options.sessionId);
  const artifactsDir = path.join(paths.dir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  await syncDirectoryIfSupported(paths.dir);
  const answerPath = path.join(artifactsDir, `browser-answer-${sha256}.md`);
  const verified = await ensureDurableFile(answerPath, payload);

  if (options.logHeader) {
    const logPayload = Buffer.from(`${options.logHeader}\nAnswer:\n${options.answer}\n`, "utf8");
    if (options.replaceLog) {
      await writeDurableFile(paths.log, logPayload);
    } else {
      await appendDurableFile(paths.log, logPayload);
    }
  }

  const verifiedSha256 = createHash("sha256").update(verified).digest("hex");
  if (!verified.equals(payload) || verifiedSha256 !== sha256) {
    throw new Error(`Durable browser answer verification failed: ${answerPath}`);
  }
  return {
    artifact: {
      kind: "transcript",
      path: answerPath,
      label: "Durable browser answer",
      mimeType: "text/markdown",
      sizeBytes: verified.byteLength,
      sha256,
      validation: { type: "generic", ok: true },
      transfer: { status: "not-needed" },
      origin: { mode: "local" },
    },
    sha256,
    sizeBytes: verified.byteLength,
  };
}

export interface BrowserCapturePublicationTransaction {
  runtime: BrowserRuntimeMetadata;
  finalize: () => Promise<BrowserCaptureFinalizationResult>;
  abort: () => Promise<BrowserCaptureFinalizationResult>;
}

export interface PublishBrowserCaptureOptions<T> {
  answerOptions: PersistDurableBrowserAnswerOptions;
  transaction: BrowserCapturePublicationTransaction;
  prepare: (receipt: DurableBrowserAnswerReceipt) => Promise<T> | T;
  publish: (receipt: DurableBrowserAnswerReceipt, prepared: T) => Promise<void> | void;
  persistRuntime: (runtime: BrowserRuntimeMetadata) => Promise<void> | void;
  persistAnswer?: typeof persistDurableBrowserAnswer;
}

export interface PublishedBrowserCapture<T> {
  receipt: DurableBrowserAnswerReceipt;
  prepared: T;
  finalization: BrowserCaptureFinalizationResult;
}

export async function publishBrowserCapture<T>(
  options: PublishBrowserCaptureOptions<T>,
): Promise<PublishedBrowserCapture<T>> {
  const persistAnswer = options.persistAnswer ?? persistDurableBrowserAnswer;
  let receipt: DurableBrowserAnswerReceipt | undefined;
  let prepared!: T;
  try {
    receipt = await persistAnswer(options.answerOptions);
    prepared = await options.prepare(receipt);
    await options.publish(receipt, prepared);
  } catch (publicationError) {
    await abortFailedBrowserCapture(options, publicationError, receipt);
  }
  if (!receipt) {
    throw new Error("Browser capture publication completed without a durable answer receipt");
  }

  let finalization: BrowserCaptureFinalizationResult;
  try {
    finalization = await options.transaction.finalize();
  } catch (finalizeError) {
    finalization = {
      status: "pending",
      runtime: runtimeFromBrowserError(finalizeError) ?? options.transaction.runtime,
      error: `Browser cleanup finalize failed and remains retryable: ${formatError(finalizeError)}`,
    };
  }

  try {
    await options.persistRuntime(finalization.runtime);
  } catch (persistenceError) {
    throw new BrowserAutomationError(
      `Browser answer was published, but exact cleanup authority could not be persisted: ${formatError(persistenceError)}`,
      {
        stage: "browser-capture-finalization",
        code: "runtime-authority-persistence-failed",
        runtime: finalization.runtime,
        answerReceipt: receipt,
        cleanupStatus: finalization.status,
        ...(finalization.status === "pending" ? { cleanupError: finalization.error } : {}),
      },
      persistenceError,
    );
  }

  return { receipt, prepared, finalization };
}

async function abortFailedBrowserCapture<T>(
  options: PublishBrowserCaptureOptions<T>,
  publicationError: unknown,
  receipt: DurableBrowserAnswerReceipt | undefined,
): Promise<never> {
  let abortion: BrowserCaptureFinalizationResult;
  try {
    abortion = await options.transaction.abort();
  } catch (abortError) {
    const runtime = runtimeFromBrowserError(abortError) ?? options.transaction.runtime;
    await persistAbortRuntime(options, runtime, publicationError, receipt, abortError);
    throw new BrowserAutomationError(
      `Browser answer publication failed (${formatError(publicationError)}); capture abort failed and remains retryable: ${formatError(abortError)}`,
      {
        stage: "browser-capture-publication",
        code: "publication-abort-failed",
        runtime,
        answerReceipt: receipt,
        abortError: formatError(abortError),
      },
      publicationError,
    );
  }

  await persistAbortRuntime(options, abortion.runtime, publicationError, receipt);
  if (abortion.status === "pending") {
    throw new BrowserAutomationError(
      `Browser answer publication failed (${formatError(publicationError)}); cleanup remains retryable: ${abortion.error}`,
      {
        stage: "browser-capture-publication",
        code: "publication-failed-cleanup-pending",
        runtime: abortion.runtime,
        answerReceipt: receipt,
        cleanupError: abortion.error,
      },
      publicationError,
    );
  }
  throw publicationError;
}

async function persistAbortRuntime<T>(
  options: PublishBrowserCaptureOptions<T>,
  runtime: BrowserRuntimeMetadata,
  publicationError: unknown,
  receipt: DurableBrowserAnswerReceipt | undefined,
  abortError?: unknown,
): Promise<void> {
  try {
    await options.persistRuntime(runtime);
  } catch (persistenceError) {
    throw new BrowserAutomationError(
      `Browser answer publication failed (${formatError(publicationError)}); exact abort authority could not be persisted: ${formatError(persistenceError)}`,
      {
        stage: "browser-capture-publication",
        code: "abort-authority-persistence-failed",
        runtime,
        answerReceipt: receipt,
        ...(abortError ? { abortError: formatError(abortError) } : {}),
      },
      publicationError,
    );
  }
}

function runtimeFromBrowserError(error: unknown): BrowserRuntimeMetadata | undefined {
  if (!(error instanceof BrowserAutomationError)) return undefined;
  const runtime = error.details?.runtime;
  return typeof runtime === "object" && runtime !== null
    ? (runtime as BrowserRuntimeMetadata)
    : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ensureDurableFile(targetPath: string, payload: Buffer): Promise<Buffer> {
  let entry: Stats;
  try {
    entry = await lstat(targetPath);
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
    await writeDurableFile(targetPath, payload);
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
    return existing;
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

async function writeDurableFile(targetPath: string, payload: Buffer): Promise<void> {
  await writeFileAtomicDurable(targetPath, payload);
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
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
