import type http from "node:http";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import type {
  BrowserAttachment,
  BrowserArtifactWriteAuthority,
  BrowserLogger,
  BrowserRunResult,
  BrowserRunTransaction,
} from "../browser/types.js";
import { CHATGPT_URL } from "../browser/constants.js";
import { normalizeChatgptUrl } from "../browser/utils.js";
import type { runBrowserModeTransaction } from "../browser/browserCoordinator.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type {
  BrowserRuntimeMetadata,
  BrowserSessionConfig,
  SessionArtifact,
} from "../sessionManager.js";
import type { RemoteArtifactStore } from "./artifactStore.js";
import { sanitizeArtifactFilename } from "../browser/artifacts.js";
import {
  assertBrowserRunTransaction,
  assertCapturedPromptIdentity,
  browserRunResultFromTransaction,
  browserRuntimeFromError,
  hasBrowserCleanupAuthority,
  projectRemotePublicResult,
  serializeDurableBrowserAutomationError,
} from "./transactionCapture.js";
import {
  RemoteLegacyRunPayloadSchema,
  RemoteLegacyTextResultSchema,
  type RemoteLegacyRunEvent,
  type RemoteLegacyRunPayload,
} from "./legacyProtocol.js";
import type { RemoteTransactionCoordinator } from "./transactionCoordinator.js";
import {
  remoteBrowserAutomationError,
  remotePendingSettlementError,
  remoteTransactionPayload,
} from "./transactionProtocol.js";
import type {
  DurableRemoteArtifactRegistration,
  RemoteTransactionRecord,
} from "./transactionModel.js";
import { RemoteTransactionCapacityError, type RemoteTransactionStore } from "./transactionStore.js";
import {
  buildRemotePromptRequestIdentity,
  MAX_REMOTE_ATTACHMENTS,
  MAX_REMOTE_REQUEST_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  RemoteRunPayloadSchema,
  type RemoteBrowserRunConfig,
  type RemoteRunEvent,
  type RemoteRunPayload,
} from "./types.js";
import { formatSocket, readRequestBody, RemoteRequestError, sendJson } from "./serverHttp.js";
import {
  isAbortWorthyRemoteCaptureMismatch,
  isTerminalRemoteBrowserAutomationError,
  persistRemoteBrowserRuntime,
} from "./serverTransactionRuntime.js";
import type { RemoteServerOptions } from "./serverTypes.js";
import { sameFileGeneration, samePhysicalFile } from "./transactionRecordStorage.js";
import {
  assertPrivateDirectoryAuthority,
  createPrivateTempChildGeneration,
  createPrivateTempGeneration,
  type PrivateTempGeneration,
  type PrivateTempRootOptions,
} from "../privateTempRoot.js";

type RemoteScratchGeneration = PrivateTempGeneration;

interface RemoteScratchFile {
  readonly path: string;
  identity: BigIntStats;
  complete: boolean;
}

interface MaterializedRemoteAttachments {
  readonly attachments: BrowserAttachment[];
  readonly files: readonly RemoteScratchFile[];
}

const remoteAttachmentOpenFlags =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);

function projectRemoteHostText(message: string): string {
  return message
    .replace(/(^|[\s("'])\/(?:[^\s/"']+\/)+[^\s"']*/gu, "$1[host-path]")
    .replace(/(^|[\s("'])[A-Za-z]:\\(?:[^\s"']+\\)+[^\s"']*/gu, "$1[host-path]");
}

async function createRemoteScratchGeneration(
  parent: RemoteScratchGeneration,
  prefix: string,
  options: PrivateTempRootOptions = {},
): Promise<RemoteScratchGeneration> {
  try {
    return await createPrivateTempChildGeneration(parent, prefix, options);
  } catch (error) {
    throw new Error("Remote attachment scratch generation could not be initialized", {
      cause: error,
    });
  }
}

async function assertRemoteScratchGeneration(generation: RemoteScratchGeneration): Promise<void> {
  try {
    await assertPrivateDirectoryAuthority(generation.parent);
    await assertPrivateDirectoryAuthority(generation);
  } catch {
    throw new Error("Remote attachment scratch generation changed");
  }
}

function assertRemoteScratchFileGeneration(entry: BigIntStats, expected?: BigIntStats): void {
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1n ||
    (expected !== undefined && !sameFileGeneration(entry, expected))
  ) {
    throw new Error("Remote attachment scratch file changed");
  }
}

function assertRemoteScratchFile(entry: BigIntStats, expected?: BigIntStats): void {
  assertRemoteScratchFileGeneration(entry, expected);
  if (expected !== undefined && !samePhysicalFile(entry, expected)) {
    throw new Error("Remote attachment scratch file changed");
  }
}

async function writeRemoteScratchFile(
  filePath: string,
  payload: Buffer,
  registeredFiles: RemoteScratchFile[],
): Promise<RemoteScratchFile> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, remoteAttachmentOpenFlags, 0o600);
    const identity = await handle.stat({ bigint: true });
    assertRemoteScratchFile(identity);
    const file: RemoteScratchFile = { path: filePath, identity, complete: false };
    registeredFiles.push(file);
    await handle.writeFile(payload);
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    assertRemoteScratchFileGeneration(written, identity);
    if (written.size !== BigInt(payload.byteLength)) {
      throw new Error("Remote attachment scratch write did not preserve exact bytes");
    }
    const pathEntry = await lstat(filePath, { bigint: true });
    assertRemoteScratchFile(pathEntry, written);
    file.identity = written;
    file.complete = true;
    return file;
  } catch {
    throw new Error("Remote attachment scratch materialization failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertRemoteScratchFiles(files: readonly RemoteScratchFile[]): Promise<void> {
  for (const file of files) {
    if (!file.complete) throw new Error("Remote attachment scratch file changed");
    let entry: BigIntStats;
    try {
      entry = await lstat(file.path, { bigint: true });
    } catch {
      throw new Error("Remote attachment scratch file changed");
    }
    assertRemoteScratchFile(entry, file.identity);
  }
}

async function removeRemoteScratchGeneration(
  generation: RemoteScratchGeneration,
  files: readonly RemoteScratchFile[],
): Promise<boolean> {
  try {
    await assertRemoteScratchGeneration(generation);
    for (const file of files) {
      const entry = await lstat(file.path, { bigint: true });
      if (file.complete) {
        assertRemoteScratchFile(entry, file.identity);
      } else {
        assertRemoteScratchFileGeneration(entry, file.identity);
      }
      await unlink(file.path);
    }
    await assertRemoteScratchGeneration(generation);
    await rmdir(generation.path);
    return true;
  } catch {
    return false;
  }
}

async function releaseRemoteScratchRun(
  run: RemoteScratchGeneration,
  attachments: readonly {
    generation: RemoteScratchGeneration;
    files: readonly RemoteScratchFile[];
  }[],
): Promise<void> {
  let retainedAttachment = false;
  for (const attachment of attachments) {
    if (!(await removeRemoteScratchGeneration(attachment.generation, attachment.files))) {
      retainedAttachment = true;
    }
  }
  if (retainedAttachment) return;
  try {
    await assertRemoteScratchGeneration(run);
    await rmdir(run.path);
  } catch {
    // A changed or nonempty generation is deliberately retained rather than deleting a replacement.
  }
}

export async function handleRemoteRunRequest(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  options: RemoteServerOptions;
  runBrowser: (
    options: Parameters<typeof runBrowserModeTransaction>[0],
  ) => Promise<BrowserRunTransaction>;
  protocol: "transaction-v3" | "legacy-text-v1";
  logger: (message: string) => void;
  verbose: boolean;
  transactionToken: string;
  transactionStore: RemoteTransactionStore;
  artifactStore: RemoteArtifactStore;
  transactionCoordinator: RemoteTransactionCoordinator;
  releaseTransactionAdmission?: () => void;
}): Promise<void> {
  let payload: RemoteRunPayload;
  try {
    const body = await readRequestBody(params.req, MAX_REMOTE_REQUEST_BYTES);
    payload = validateRemoteRunPayload(JSON.parse(body), params.protocol);
  } catch (error) {
    params.releaseTransactionAdmission?.();
    const requestError =
      error instanceof RemoteRequestError
        ? error
        : new RemoteRequestError(400, "invalid_request", "Invalid remote run request");
    sendJson(params.res, requestError.statusCode, {
      error: requestError.code,
      message: requestError.message,
    });
    return;
  }
  const requestIdentity = buildRemotePromptRequestIdentity(payload);
  const effectiveBrowserConfig = buildEffectiveRemoteBrowserConfig(
    payload.browserConfig,
    params.options,
  );

  const existing = await params.transactionStore.read(params.transactionToken);
  if (existing) {
    params.releaseTransactionAdmission?.();
    sendJson(params.res, 409, {
      error: "transaction_exists",
      state: existing.state,
      transactionToken: params.transactionToken,
    });
    return;
  }

  const runId = randomUUID();
  const now = new Date().toISOString();
  try {
    await params.transactionStore.begin({
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      transactionToken: params.transactionToken,
      runId,
      createdAt: now,
      requestIdentity,
      browserConfig: effectiveBrowserConfig,
    });
  } catch (error) {
    params.releaseTransactionAdmission?.();
    if (error instanceof RemoteTransactionCapacityError) {
      sendJson(params.res, 503, {
        error: error.code,
        message: "Remote transaction storage is at capacity; no browser work was started.",
      });
      return;
    }
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      sendJson(params.res, 409, {
        error: "transaction_exists",
        transactionToken: params.transactionToken,
      });
      return;
    }
    throw error;
  }
  params.releaseTransactionAdmission?.();
  let artifactWriteAuthority: BrowserArtifactWriteAuthority;
  try {
    artifactWriteAuthority = await params.artifactStore.createArtifactWriteAuthority({
      transactionToken: params.transactionToken,
      runId,
    });
  } catch (error) {
    const failed = await params.transactionStore.read(params.transactionToken);
    params.logger(
      projectRemoteHostText(
        `[serve] Run ${runId} failed artifact namespace initialization before browser work: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    sendJson(params.res, 500, {
      error: "remote_artifact_namespace_initialization_failed",
      state: failed?.state ?? "failed",
      transactionToken: params.transactionToken,
    });
    return;
  }

  const log = (message: string): void => params.logger(projectRemoteHostText(message));
  log(
    `[serve] Accepted run ${runId} from ${formatSocket(params.req)} (prompt ${payload.prompt.length} chars)`,
  );
  const runStartedAt = Date.now();
  let scratchRun: PrivateTempGeneration | null = null;
  const scratchAttachments: {
    generation: RemoteScratchGeneration;
    files: readonly RemoteScratchFile[];
  }[] = [];
  let legacyResponseHeartbeat: NodeJS.Timeout | undefined;
  params.res.writeHead(200, { "Content-Type": "application/x-ndjson" });

  const sendEvent = (event: RemoteRunEvent | RemoteLegacyRunEvent): boolean => {
    if (params.res.destroyed || params.res.writableEnded) return false;
    const projected =
      event.type === "log" ? { ...event, message: projectRemoteHostText(event.message) } : event;
    return params.res.write(`${JSON.stringify(projected)}\n`);
  };
  if (params.protocol === "legacy-text-v1" && payload.options.heartbeatIntervalMs) {
    const intervalMs = Math.max(25, payload.options.heartbeatIntervalMs);
    const heartbeat = setInterval(() => {
      if (!sendEvent({ type: "log", message: "[serve] Legacy remote run remains active." })) {
        clearInterval(heartbeat);
        if (legacyResponseHeartbeat === heartbeat) legacyResponseHeartbeat = undefined;
      }
    }, intervalMs);
    heartbeat.unref();
    legacyResponseHeartbeat = heartbeat;
  }
  const automationLogger: BrowserLogger = ((message?: string) => {
    if (typeof message === "string") {
      sendEvent({ type: "log", message });
    }
  }) as BrowserLogger;
  const persistExactStagedCapture = async (
    result: BrowserRunResult,
    runtime: BrowserRuntimeMetadata,
  ): Promise<RemoteTransactionRecord> => {
    assertCapturedPromptIdentity(
      requestIdentity,
      { ...result, conversationId: runtime.conversationId },
      runtime,
    );
    const fileArtifacts: SessionArtifact[] = [
      ...(result.savedFiles ?? []),
      ...(result.artifacts ?? []).filter((artifact) => artifact.kind === "file"),
    ];
    const withManualCopyWarning = (
      source: BrowserRunResult,
      message: string,
    ): BrowserRunResult => ({
      ...source,
      warnings: [
        ...(source.warnings ?? []),
        {
          code: "remote-artifact-manual-copy-required",
          severity: "warning" as const,
          message,
        },
      ].slice(-64),
    });
    let stagedResult = result;
    let registrations: DurableRemoteArtifactRegistration[] | undefined =
      fileArtifacts.length === 0 || params.protocol === "legacy-text-v1" ? [] : undefined;
    if (params.protocol === "legacy-text-v1" && fileArtifacts.length > 0) {
      stagedResult = {
        ...result,
        warnings: [
          ...(result.warnings ?? []),
          {
            code: "legacy-remote-artifacts-host-only",
            severity: "warning",
            message:
              "Generated files remain on the remote host and require explicit manual transfer; legacy text compatibility never claims artifact delivery.",
          },
        ],
      };
    } else if (fileArtifacts.length > MAX_REMOTE_ATTACHMENTS) {
      registrations = [];
      stagedResult = withManualCopyWarning(
        result,
        `Automatic remote transfer supports at most ${MAX_REMOTE_ATTACHMENTS} files. The captured text is preserved; open the ChatGPT browser on the remote host and copy the generated files manually.`,
      );
    }
    let stagedRecord = await params.transactionStore.stageCapture({
      transactionToken: params.transactionToken,
      runId,
      result: projectRemotePublicResult(stagedResult),
      runtime,
      modelSelection: result.modelSelection,
      artifacts: registrations,
    });
    if (
      params.protocol === "transaction-v3" &&
      fileArtifacts.length > 0 &&
      registrations === undefined
    ) {
      try {
        registrations = await params.artifactStore.prepareRequiredArtifacts({
          transactionToken: params.transactionToken,
          runId,
          artifacts: fileArtifacts,
        });
        if (registrations.length > MAX_REMOTE_ATTACHMENTS) {
          throw new Error("Remote artifact manifest exceeds the public transaction limit");
        }
      } catch (artifactError) {
        const artifactMessage =
          artifactError instanceof Error ? artifactError.message : String(artifactError);
        registrations = [];
        stagedResult = withManualCopyWarning(
          result,
          "Automatic remote artifact transfer could not be prepared. The captured text is preserved; open the ChatGPT browser on the remote host and copy the generated files manually.",
        );
        sendEvent({
          type: "log",
          message:
            "[browser] Answer captured; generated files require manual copy from the remote host.",
        });
        log(
          `[serve] Run ${runId} preserved its captured answer after artifact preparation failed: ${artifactMessage}`,
        );
      }
      try {
        stagedRecord = await params.transactionStore.stageCapture({
          transactionToken: params.transactionToken,
          runId,
          result: projectRemotePublicResult(stagedResult),
          runtime,
          modelSelection: result.modelSelection,
          artifacts: registrations,
        });
      } catch (enrichmentError) {
        if (registrations.length === 0) throw enrichmentError;
        stagedResult = withManualCopyWarning(
          stagedResult,
          "Automatic remote artifact transfer could not be published. The captured text is preserved; open the ChatGPT browser on the remote host and copy the generated files manually.",
        );
        registrations = [];
        stagedRecord = await params.transactionStore.stageCapture({
          transactionToken: params.transactionToken,
          runId,
          result: projectRemotePublicResult(stagedResult),
          runtime,
          modelSelection: result.modelSelection,
          artifacts: registrations,
        });
        log(
          `[serve] Run ${runId} published its captured text without artifact enrichment: ${enrichmentError instanceof Error ? enrichmentError.message : String(enrichmentError)}`,
        );
      }
    }
    return stagedRecord;
  };

  let capture: BrowserRunTransaction | null = null;
  let durableCapture = false;
  try {
    scratchRun = await createPrivateTempGeneration(`oracle-serve-${runId}-`);
    const attachmentGeneration = await createRemoteScratchGeneration(scratchRun, "attachments-");
    const attachmentFiles: RemoteScratchFile[] = [];
    scratchAttachments.push({ generation: attachmentGeneration, files: attachmentFiles });
    const materializedAttachments = await materializeRemoteAttachments(
      payload.attachments,
      attachmentGeneration.path,
      "attachment",
      attachmentFiles,
    );
    const attachments = materializedAttachments.attachments;
    let fallbackSubmission:
      | {
          prompt: string;
          attachments: BrowserAttachment[];
        }
      | undefined;
    if (payload.fallbackSubmission) {
      const fallbackGeneration = await createRemoteScratchGeneration(
        scratchRun,
        "fallback-attachments-",
      );
      const fallbackFiles: RemoteScratchFile[] = [];
      scratchAttachments.push({ generation: fallbackGeneration, files: fallbackFiles });
      const materializedFallback = await materializeRemoteAttachments(
        payload.fallbackSubmission.attachments,
        fallbackGeneration.path,
        "fallback-attachment",
        fallbackFiles,
      );
      fallbackSubmission = {
        prompt: payload.fallbackSubmission.prompt,
        attachments: materializedFallback.attachments,
      };
    }
    await assertRemoteScratchGeneration(scratchRun);
    for (const attachment of scratchAttachments) {
      await assertRemoteScratchGeneration(attachment.generation);
      await assertRemoteScratchFiles(attachment.files);
    }

    if (params.verbose && params.options.manualLoginDefault) {
      log(`[serve] Enforcing configured manual-login profile for remote run ${runId}`);
    }

    capture = await params.runBrowser({
      prompt: payload.prompt,
      attachments,
      fallbackSubmission,
      config: effectiveBrowserConfig,
      closeOwnedTabOnComplete: Boolean(
        params.options.manualLoginDefault && !payload.options.keepConversationTab,
      ),
      log: automationLogger,
      heartbeatIntervalMs: payload.options.heartbeatIntervalMs,
      verbose: payload.options.verbose,
      sessionId: params.transactionToken,
      artifactWriteAuthority,
      followUpPrompts: payload.options.followUpPrompts,
      runtimeHintCb: (runtime, modelSelection) =>
        persistRemoteBrowserRuntime({
          transactionStore: params.transactionStore,
          transactionToken: params.transactionToken,
          runtime,
          modelSelection,
        }),
      preArchiveCaptureCb: async (result, runtime) => {
        await persistExactStagedCapture(result, runtime);
      },
    });
    assertBrowserRunTransaction(capture);
    const capturedTransaction = capture;
    const result = browserRunResultFromTransaction(capturedTransaction);
    assertCapturedPromptIdentity(requestIdentity, result, capturedTransaction.runtime);
    let stagedRecord = await params.transactionStore.read(params.transactionToken);
    if (!stagedRecord?.stagedCapture || stagedRecord.stagedCapture.artifacts === undefined) {
      stagedRecord = await persistExactStagedCapture(result, capturedTransaction.runtime);
    }
    const stagedCapture = stagedRecord.stagedCapture;
    if (!stagedCapture || stagedCapture.artifacts === undefined) {
      throw new BrowserAutomationError(
        "Remote artifact registration remains incomplete for the exact staged capture.",
        {
          stage: "remote-artifact-preparation",
          code: "remote-artifact-manifest-incomplete",
          recoverableDisconnect: true,
          runtime: capturedTransaction.runtime,
        },
      );
    }
    const registrations = stagedCapture.artifacts;
    const publicResult = projectRemotePublicResult(result);
    let record: RemoteTransactionRecord;
    try {
      record = await params.transactionStore.publishCapture({
        transactionToken: params.transactionToken,
        runId,
        result: publicResult,
        runtime: capturedTransaction.runtime,
        modelSelection: result.modelSelection,
        artifacts: registrations,
      });
    } catch (publicationError) {
      if (isAbortWorthyRemoteCaptureMismatch(publicationError)) throw publicationError;
      const latest = await params.transactionStore.read(params.transactionToken);
      if (latest?.state === "pending" && latest.result && latest.runtime) {
        record = latest;
      } else {
        record = await params.transactionStore.promoteStagedCapture({
          transactionToken: params.transactionToken,
          result: publicResult,
          runtime: capturedTransaction.runtime,
          warning: {
            code: "remote-publication-write-recovered",
            message:
              "The exact assistant answer was published from its durable pre-archive capture after the initial publication write failed.",
          },
        });
      }
      log(
        `[serve] Run ${runId} recovered publication from its durable pre-archive capture: ${publicationError instanceof Error ? publicationError.message : String(publicationError)}`,
      );
    }
    durableCapture = true;
    params.transactionCoordinator.registerActive(params.transactionToken, capturedTransaction);

    if (params.protocol === "legacy-text-v1") {
      const settlement = await params.transactionCoordinator.settle({
        transactionToken: params.transactionToken,
        mode: "finalize",
        durablePublication: true,
      });
      if (settlement.finalization.status !== "completed") {
        sendEvent({
          type: "error",
          message: "Remote answer was captured, but durable cleanup remains pending on the host.",
        });
        return;
      }
      if (!record.result) {
        throw new BrowserAutomationError(
          "Durably captured legacy result is missing its public answer.",
          {
            stage: "remote-publication",
            code: "remote-result-missing",
          },
        );
      }
      sendEvent({
        type: "result",
        result: projectLegacyTextResult(record.result),
      });
      log(`[serve] Legacy text run ${runId} finalized durably in ${Date.now() - runStartedAt}ms`);
      return;
    }
    if (registrations.length > 0) {
      sendEvent({
        type: "log",
        message: `[browser] ${registrations.length} required artifact(s) are ready for verified bridge transfer.`,
      });
    }
    sendEvent({ type: "transaction", transaction: remoteTransactionPayload(record) });
    log(
      `[serve] Run ${runId} captured durably in ${Date.now() - runStartedAt}ms; awaiting client publication acknowledgement`,
    );
  } catch (rawError) {
    if (durableCapture) {
      log(
        `[serve] Run ${runId} remains durably pending after response publication failed: ${rawError instanceof Error ? rawError.message : String(rawError)}`,
      );
      return;
    }

    const error =
      rawError instanceof BrowserAutomationError
        ? rawError
        : new BrowserAutomationError(
            rawError instanceof Error ? rawError.message : "Remote browser automation failed",
            { stage: "execute-browser" },
            rawError,
          );
    const failedCapture = capture;
    const errorRuntime = browserRuntimeFromError(error);
    const journaled = await params.transactionStore.read(params.transactionToken);
    const recoverableRuntime = hasBrowserCleanupAuthority(failedCapture?.runtime)
      ? failedCapture.runtime
      : errorRuntime &&
          (hasBrowserCleanupAuthority(errorRuntime) ||
            error.details?.recoverableDisconnect === true)
        ? errorRuntime
        : hasBrowserCleanupAuthority(journaled?.runtime)
          ? journaled.runtime
          : undefined;
    const abortWorthyMismatch = isAbortWorthyRemoteCaptureMismatch(rawError);
    const terminalFailure =
      abortWorthyMismatch ||
      (!journaled?.stagedCapture &&
        !failedCapture &&
        Boolean(recoverableRuntime) &&
        isTerminalRemoteBrowserAutomationError(error));
    const durableError = serializeDurableBrowserAutomationError(
      new BrowserAutomationError(projectRemoteHostText(error.message), error.details, rawError),
      Boolean(recoverableRuntime) && !terminalFailure,
    );
    let record = abortWorthyMismatch
      ? await params.transactionStore.invalidateStagedCapture({
          transactionToken: params.transactionToken,
          runtime: recoverableRuntime,
          error: durableError,
          settlementMode: terminalFailure && recoverableRuntime ? "abort" : undefined,
        })
      : await params.transactionStore.recordRecoverableFailure({
          transactionToken: params.transactionToken,
          runtime: recoverableRuntime,
          error: durableError,
          settlementMode: terminalFailure && recoverableRuntime ? "abort" : undefined,
        });
    const stagedCaptureRetained = Boolean(record.stagedCapture);
    if (failedCapture || stagedCaptureRetained) {
      log(
        `[serve] Run ${runId} retained its exact staged answer after durable publication failed.`,
      );
    }
    if (terminalFailure && recoverableRuntime) {
      record = (
        await params.transactionCoordinator.settle({
          transactionToken: params.transactionToken,
          mode: "abort",
          durablePublication: false,
        })
      ).record;
    }
    if (params.protocol === "legacy-text-v1") {
      sendEvent({ type: "error", message: "Remote browser automation failed." });
    } else {
      sendEvent({
        type: "error",
        error:
          record.settlementMode &&
          record.error?.recoverableDisconnect === false &&
          record.state !== "aborted" &&
          record.state !== "failed"
            ? remotePendingSettlementError(record)
            : remoteBrowserAutomationError(record),
      });
    }
    log(`[serve] Run ${runId} failed after ${Date.now() - runStartedAt}ms: ${error.message}`);
  } finally {
    clearInterval(legacyResponseHeartbeat);
    if (scratchRun) await releaseRemoteScratchRun(scratchRun, scratchAttachments);
    if (!params.res.destroyed && !params.res.writableEnded) params.res.end();
  }
}

function projectLegacyTextResult(result: NonNullable<RemoteTransactionRecord["result"]>) {
  return RemoteLegacyTextResultSchema.parse({
    answerText: result.answerText,
    answerMarkdown: result.answerMarkdown,
    answerHtml: result.answerHtml,
    tookMs: result.tookMs,
    answerTokens: result.answerTokens,
    answerChars: result.answerChars,
    warnings: result.warnings,
  });
}

function validateRemoteRunPayload(
  value: unknown,
  protocol: "transaction-v3" | "legacy-text-v1",
): RemoteRunPayload {
  if (protocol === "legacy-text-v1") {
    return adaptLegacyRunPayload(RemoteLegacyRunPayloadSchema.parse(value));
  }
  const parsed = RemoteRunPayloadSchema.safeParse(value);
  if (parsed.success) return parsed.data as RemoteRunPayload;
  const issue = parsed.error.issues[0];
  const authorityIssue = parsed.error.issues.find(
    (candidate) => candidate.code === "unrecognized_keys",
  );
  if (authorityIssue) {
    const keys = "keys" in authorityIssue ? authorityIssue.keys.join(", ") : "unknown";
    throw new RemoteRequestError(
      400,
      "authority_fields_rejected",
      `Remote request contains unsupported or authority-bearing field(s): ${keys}`,
    );
  }
  const message = issue?.message ?? "Invalid remote run request";
  const statusCode = /exceed|too big|maximum/i.test(message) ? 413 : 400;
  throw new RemoteRequestError(statusCode, "invalid_request", message);
}

function adaptLegacyRunPayload(payload: RemoteLegacyRunPayload): RemoteRunPayload {
  const attachment = (value: RemoteLegacyRunPayload["attachments"][number]) => ({
    fileName: value.fileName,
    displayPath: value.displayPath,
    sizeBytes: Buffer.from(value.contentBase64, "base64").byteLength,
    contentBase64: value.contentBase64,
  });
  return RemoteRunPayloadSchema.parse({
    protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
    prompt: payload.prompt,
    attachments: payload.attachments.map(attachment),
    fallbackSubmission: payload.fallbackSubmission
      ? {
          prompt: payload.fallbackSubmission.prompt,
          attachments: payload.fallbackSubmission.attachments.map(attachment),
        }
      : undefined,
    browserConfig: {
      chatgptUrl: payload.browserConfig.chatgptUrl ?? payload.browserConfig.url,
      timeoutMs: payload.browserConfig.timeoutMs,
      inputTimeoutMs: payload.browserConfig.inputTimeoutMs,
      attachmentTimeoutMs: payload.browserConfig.attachmentTimeoutMs,
      assistantRecheckDelayMs: payload.browserConfig.assistantRecheckDelayMs,
      assistantRecheckTimeoutMs: payload.browserConfig.assistantRecheckTimeoutMs,
      desiredModel: payload.browserConfig.desiredModel,
      modelStrategy: payload.browserConfig.modelStrategy,
      thinkingTime: payload.browserConfig.thinkingTime,
      researchMode: payload.browserConfig.researchMode,
      archiveConversations: payload.browserConfig.archiveConversations,
      resumeConversationUrl: payload.browserConfig.resumeConversationUrl,
    },
    options: {
      heartbeatIntervalMs: payload.options.heartbeatIntervalMs,
      verbose: payload.options.verbose,
      sessionId: payload.options.sessionId,
      followUpPrompts: payload.options.followUpPrompts,
      keepConversationTab: payload.browserConfig.keepBrowser === true,
    },
  });
}

function buildEffectiveRemoteBrowserConfig(
  config: RemoteBrowserRunConfig,
  options: RemoteServerOptions,
): BrowserSessionConfig {
  const chatgptUrl = normalizeChatgptUrl(config.chatgptUrl ?? CHATGPT_URL, CHATGPT_URL);
  return {
    ...config,
    chatgptUrl,
    url: chatgptUrl,
    chromeProfile: null,
    chromePath: null,
    chromeCookiePath: null,
    attachRunning: false,
    browserTabRef: null,
    debugPort: null,
    cookieSync: true,
    inlineCookies: null,
    inlineCookiesSource: null,
    remoteChrome: null,
    copyProfileSource: null,
    manualLogin: Boolean(options.manualLoginDefault),
    manualLoginProfileDir: options.manualLoginDefault ? options.manualLoginProfileDir : null,
    manualLoginCookieSync: false,
    keepBrowser: Boolean(options.manualLoginDefault),
  };
}

async function materializeRemoteAttachments(
  attachments: RemoteRunPayload["attachments"],
  directory: string,
  fallbackName: string,
  files: RemoteScratchFile[] = [],
): Promise<MaterializedRemoteAttachments> {
  const materialized: BrowserAttachment[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const safeName = sanitizeArtifactFilename(attachment.fileName, `${fallbackName}-${index + 1}`);
    const filePath = path.join(directory, `${index + 1}-${safeName}`);
    const payload = Buffer.from(attachment.contentBase64, "base64");
    await writeRemoteScratchFile(filePath, payload, files);
    materialized.push({
      path: filePath,
      displayPath: attachment.displayPath,
      sizeBytes: payload.byteLength,
    });
  }
  return { attachments: materialized, files };
}

export const __test__ = {
  assertRemoteScratchFiles,
  assertRemoteScratchGeneration,
  createRemoteScratchRun: createPrivateTempGeneration,
  createRemoteScratchGeneration,
  materializeRemoteAttachments,
  projectRemoteHostText,
  releaseRemoteScratchRun,
  removeRemoteScratchGeneration,
};
