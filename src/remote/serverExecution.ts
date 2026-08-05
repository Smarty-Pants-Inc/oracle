import type http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserAttachment, BrowserLogger, BrowserRunResult } from "../browser/types.js";
import { CHATGPT_URL } from "../browser/constants.js";
import { normalizeChatgptUrl } from "../browser/utils.js";
import type { runBrowserMode, BrowserRunTransaction } from "../browserMode.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type {
  BrowserRuntimeMetadata,
  BrowserSessionConfig,
  SessionArtifact,
} from "../sessionManager.js";
import type { RemoteArtifactStore } from "./artifactStore.js";
import {
  assertBrowserRunTransaction,
  assertCapturedPromptIdentity,
  browserRunResultFromTransaction,
  browserRuntimeFromError,
  hasBrowserCleanupAuthority,
  projectRemotePublicResult,
  serializeDurableBrowserAutomationError,
} from "./transactionCapture.js";
import type { RemoteTransactionCoordinator } from "./transactionCoordinator.js";
import { remoteBrowserAutomationError, remoteTransactionPayload } from "./transactionProtocol.js";
import {
  RemoteTransactionCapacityError,
  type DurableRemoteArtifactRegistration,
  type RemoteTransactionRecord,
  type RemoteTransactionStore,
} from "./transactionStore.js";
import {
  buildRemotePromptRequestIdentity,
  MAX_REMOTE_REQUEST_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  RemoteRunPayloadSchema,
  type RemoteBrowserRunConfig,
  type RemoteRunEvent,
  type RemoteRunPayload,
} from "./types.js";
import {
  formatSocket,
  readRequestBody,
  RemoteRequestError,
  sanitizeName,
  sendJson,
} from "./serverHttp.js";
import {
  isAbortWorthyRemoteCaptureMismatch,
  persistRemoteBrowserRuntime,
} from "./serverTransactionRuntime.js";
import type { RemoteServerOptions } from "./serverTypes.js";

export async function handleRemoteRunRequest(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  options: RemoteServerOptions;
  runBrowser: (options: Parameters<typeof runBrowserMode>[0]) => Promise<BrowserRunTransaction>;
  logger: (message: string) => void;
  verbose: boolean;
  transactionToken: string;
  transactionStore: RemoteTransactionStore;
  artifactStore: RemoteArtifactStore;
  transactionCoordinator: RemoteTransactionCoordinator;
}): Promise<void> {
  let payload: RemoteRunPayload;
  try {
    const body = await readRequestBody(params.req, MAX_REMOTE_REQUEST_BYTES);
    payload = validateRemoteRunPayload(JSON.parse(body));
  } catch (error) {
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
    if (error instanceof RemoteTransactionCapacityError) {
      sendJson(params.res, 503, {
        error: error.code,
        message: "Remote transaction storage is at capacity; no browser work was started.",
      });
      return;
    }
    throw error;
  }

  params.logger(
    `[serve] Accepted run ${runId} from ${formatSocket(params.req)} (prompt ${payload.prompt.length} chars)`,
  );
  const runStartedAt = Date.now();
  let runDir: string | null = null;
  params.res.writeHead(200, { "Content-Type": "application/x-ndjson" });

  const sendEvent = (event: RemoteRunEvent): boolean => {
    if (params.res.destroyed || params.res.writableEnded) return false;
    return params.res.write(`${JSON.stringify(event)}\n`);
  };
  const automationLogger: BrowserLogger = ((message?: string) => {
    if (typeof message === "string") sendEvent({ type: "log", message });
  }) as BrowserLogger;
  automationLogger.verbose = Boolean(payload.options.verbose);
  const persistExactStagedCapture = async (
    result: BrowserRunResult,
    runtime: BrowserRuntimeMetadata,
  ): Promise<RemoteTransactionRecord> => {
    assertCapturedPromptIdentity(
      requestIdentity,
      { ...result, conversationId: runtime.conversationId },
      runtime,
    );
    let stagedRecord = await params.transactionStore.stageCapture({
      transactionToken: params.transactionToken,
      runId,
      result: projectRemotePublicResult(result),
      runtime,
      modelSelection: result.modelSelection,
    });
    const fileArtifacts: SessionArtifact[] = [
      ...(result.savedFiles ?? []),
      ...(result.artifacts ?? []).filter((artifact) => artifact.kind === "file"),
    ];
    let stagedResult = result;
    let registrations: DurableRemoteArtifactRegistration[] = [];
    try {
      registrations = await params.artifactStore.prepareRequiredArtifacts({
        transactionToken: params.transactionToken,
        runId,
        artifacts: fileArtifacts,
      });
    } catch (artifactError) {
      const artifactMessage =
        artifactError instanceof Error ? artifactError.message : String(artifactError);
      stagedResult = {
        ...result,
        warnings: [
          ...(result.warnings ?? []),
          {
            code: "remote-artifact-preparation-pending",
            severity: "warning",
            message: `The captured answer was preserved without remote artifact transfer: ${artifactMessage}`,
            details: { stage: "remote-artifact-preparation" },
          },
        ],
      };
      sendEvent({
        type: "log",
        message: `[browser] Answer captured; remote artifact transfer remains unavailable: ${artifactMessage}`,
      });
      params.logger(
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
      params.logger(
        `[serve] Run ${runId} retained its exact staged answer without artifact enrichment: ${enrichmentError instanceof Error ? enrichmentError.message : String(enrichmentError)}`,
      );
    }
    return stagedRecord;
  };

  let capture: BrowserRunTransaction | null = null;
  let durableCapture = false;
  try {
    runDir = await mkdtemp(path.join(tmpdir(), `oracle-serve-${runId}-`));
    const attachmentDir = path.join(runDir, "attachments");
    await mkdir(attachmentDir, { recursive: true });
    const attachments = await materializeRemoteAttachments(
      payload.attachments,
      attachmentDir,
      "attachment",
    );
    let fallbackSubmission:
      | {
          prompt: string;
          attachments: BrowserAttachment[];
        }
      | undefined;
    if (payload.fallbackSubmission) {
      const fallbackDir = path.join(runDir, "fallback-attachments");
      await mkdir(fallbackDir, { recursive: true });
      fallbackSubmission = {
        prompt: payload.fallbackSubmission.prompt,
        attachments: await materializeRemoteAttachments(
          payload.fallbackSubmission.attachments,
          fallbackDir,
          "fallback-attachment",
        ),
      };
    }

    if (params.verbose && params.options.manualLoginDefault) {
      params.logger(
        `[serve] Enforcing manual-login profile at ${params.options.manualLoginProfileDir ?? "default"} for remote run ${runId}`,
      );
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
      sessionId: payload.options.sessionId,
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
    if (!stagedRecord?.stagedCapture) {
      stagedRecord = await persistExactStagedCapture(result, capturedTransaction.runtime);
    }
    const stagedCapture = stagedRecord.stagedCapture;
    if (!stagedCapture) {
      throw new Error("Remote transaction lost its exact pre-archive staged capture");
    }
    const registrations = stagedCapture.artifacts ?? [];
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
      params.logger(
        `[serve] Run ${runId} recovered publication from its durable pre-archive capture: ${publicationError instanceof Error ? publicationError.message : String(publicationError)}`,
      );
    }
    durableCapture = true;
    params.transactionCoordinator.registerActive(params.transactionToken, capturedTransaction);

    if (registrations.length > 0) {
      sendEvent({
        type: "log",
        message: `[browser] ${registrations.length} required artifact(s) are ready for verified bridge transfer.`,
      });
    }
    sendEvent({ type: "transaction", transaction: remoteTransactionPayload(record) });
    params.logger(
      `[serve] Run ${runId} captured durably in ${Date.now() - runStartedAt}ms; awaiting client publication acknowledgement`,
    );
  } catch (rawError) {
    if (durableCapture) {
      params.logger(
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
    const durableError = serializeDurableBrowserAutomationError(error, Boolean(recoverableRuntime));
    let record = abortWorthyMismatch
      ? await params.transactionStore.invalidateStagedCapture({
          transactionToken: params.transactionToken,
          runtime: recoverableRuntime,
          error: durableError,
        })
      : await params.transactionStore.recordRecoverableFailure({
          transactionToken: params.transactionToken,
          runtime: recoverableRuntime,
          error: durableError,
        });
    const stagedCaptureRetained = Boolean(record.stagedCapture);
    if (failedCapture || stagedCaptureRetained) {
      params.logger(
        `[serve] Run ${runId} retained its exact staged answer after durable publication failed.`,
      );
    }
    const cleanupRequired =
      abortWorthyMismatch ||
      (!stagedCaptureRetained &&
        !failedCapture &&
        Boolean(recoverableRuntime) &&
        error.details?.recoverableDisconnect !== true);
    if (cleanupRequired && recoverableRuntime) {
      record = (
        await params.transactionCoordinator.settle({
          transactionToken: params.transactionToken,
          mode: "abort",
          durablePublication: false,
        })
      ).record;
    }
    sendEvent({ type: "error", error: remoteBrowserAutomationError(record) });
    params.logger(
      `[serve] Run ${runId} failed after ${Date.now() - runStartedAt}ms: ${error.message}`,
    );
  } finally {
    if (runDir) await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    if (!params.res.destroyed && !params.res.writableEnded) params.res.end();
  }
}

function validateRemoteRunPayload(value: unknown): RemoteRunPayload {
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
): Promise<BrowserAttachment[]> {
  const materialized: BrowserAttachment[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const safeName = sanitizeName(attachment.fileName || `${fallbackName}-${index + 1}`);
    const filePath = path.join(directory, `${index + 1}-${safeName}`);
    const payload = Buffer.from(attachment.contentBase64, "base64");
    await writeFile(filePath, payload, { mode: 0o600 });
    materialized.push({
      path: filePath,
      displayPath: attachment.displayPath,
      sizeBytes: payload.byteLength,
    });
  }
  return materialized;
}
