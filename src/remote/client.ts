import http from "node:http";
import { createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import type { BrowserRunOptions, BrowserRunResult } from "../browserMode.js";
import type {
  BrowserAttachment,
  BrowserCaptureFinalizationResult,
  BrowserRunTransaction,
  SavedBrowserFile,
} from "../browser/types.js";
import type { BrowserRuntimeMetadata } from "../sessionManager.js";
import {
  appendArtifacts,
  computeFileSha256,
  resolveSessionArtifactsDir,
  resolveUniqueArtifactPath,
  sanitizeArtifactFilename,
  sanitizeArtifactMimeType,
  validateArtifactFile,
} from "../browser/artifacts.js";
import {
  MAX_REMOTE_ARTIFACT_BYTES,
  MAX_REMOTE_ATTACHMENT_BYTES,
  MAX_REMOTE_ATTACHMENTS,
  MAX_REMOTE_PROMPT_CHARS,
  MAX_REMOTE_REQUEST_BYTES,
  MAX_REMOTE_TOTAL_ATTACHMENT_BYTES,
  REMOTE_TRANSACTION_PROTOCOL_VERSION,
  type RemoteArtifactDescriptor,
  type RemoteAttachmentPayload,
  type RemoteBrowserAutomationErrorPayload,
  type RemoteRecoverySettlementOptions,
  type RemoteBrowserRunConfig,
  type RemoteRunEvent,
  type RemoteRunPayload,
  type RemoteRunTransactionPayload,
  type RemoteTransactionRetryResponse,
  type RemoteTransactionSettlementResponse,
} from "./types.js";
import { parseHostPort } from "../bridge/connection.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { z } from "zod";
import { delay } from "../browser/utils.js";

interface RemoteExecutorOptions {
  host: string;
  token?: string;
}

interface RemoteAttachmentBudget {
  count: number;
  bytes: number;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const MAX_REMOTE_EVENT_BYTES = 16 * 1024 * 1024;

const BrowserRuntimeMetadataSchema = z.object({}).passthrough();
const BrowserRunResultSchema = z
  .object({
    answerText: z.string(),
    answerMarkdown: z.string(),
    tookMs: z.number(),
    answerTokens: z.number(),
    answerChars: z.number(),
  })
  .passthrough();
const RemoteArtifactDescriptorSchema = z.object({
  artifactId: z.string(),
  runId: z.string(),
  kind: z.literal("file"),
  filename: z.string(),
  mimeType: z.string().optional(),
  byteSize: z.number(),
  sha256: z.string(),
  validation: z.object({}).passthrough().optional(),
  sourceUrlKind: z.enum(["sandbox", "chatgpt-file-endpoint", "browser-download"]),
  transferStatus: z.enum(["ready", "streaming", "completed", "failed", "skipped"]),
});
const BrowserCaptureFinalizationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), runtime: BrowserRuntimeMetadataSchema }),
  z.object({
    status: z.literal("pending"),
    runtime: BrowserRuntimeMetadataSchema,
    error: z.string(),
  }),
]);
const RemoteTransactionPayloadSchema = z.object({
  protocolVersion: z.literal(REMOTE_TRANSACTION_PROTOCOL_VERSION),
  transactionToken: z.string().regex(/^[a-f0-9]{64}$/),
  runId: z.string(),
  result: BrowserRunResultSchema,
  runtime: BrowserRuntimeMetadataSchema,
  artifacts: z.array(RemoteArtifactDescriptorSchema),
  state: z.enum(["pending", "finalized", "aborted"]),
  finalization: BrowserCaptureFinalizationSchema.optional(),
});
const RemoteBrowserAutomationErrorSchema = z.object({
  name: z.literal("BrowserAutomationError"),
  category: z.literal("browser-automation"),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  stage: z.string().optional(),
  recoverableDisconnect: z.boolean(),
  recoveryToken: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  runtime: BrowserRuntimeMetadataSchema.optional(),
});
const RemoteRunEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("log"), message: z.string() }),
  z.object({
    type: z.literal("artifact-progress"),
    artifactId: z.string(),
    receivedBytes: z.number().optional(),
    totalBytes: z.number().optional(),
    phase: z.enum(["download", "transfer", "validate"]),
  }),
  z.object({ type: z.literal("transaction"), transaction: RemoteTransactionPayloadSchema }),
  z.object({ type: z.literal("error"), error: RemoteBrowserAutomationErrorSchema }),
]);
const RemoteRetryResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("running") }),
  z.object({ status: z.literal("transaction"), transaction: RemoteTransactionPayloadSchema }),
  z.object({ status: z.literal("error"), error: RemoteBrowserAutomationErrorSchema }),
]);
const RemoteSettlementResponseSchema = z.object({
  transactionToken: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["pending", "finalized", "aborted"]),
  finalization: BrowserCaptureFinalizationSchema,
});

class RemoteTransportInterruption extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RemoteTransportInterruption";
  }
}

export function createRemoteBrowserExecutor({ host, token }: RemoteExecutorOptions) {
  return async function remoteBrowserExecutor(
    options: BrowserRunOptions,
  ): Promise<BrowserRunTransaction> {
    if (options.prompt.length > MAX_REMOTE_PROMPT_CHARS) {
      throw new BrowserAutomationError("Remote browser prompt exceeds the protocol size limit.", {
        stage: "remote-request",
      });
    }
    if (
      options.fallbackSubmission &&
      options.fallbackSubmission.prompt.length > MAX_REMOTE_PROMPT_CHARS
    ) {
      throw new BrowserAutomationError(
        "Remote fallback browser prompt exceeds the protocol size limit.",
        { stage: "remote-request" },
      );
    }
    const attachmentBudget: RemoteAttachmentBudget = { count: 0, bytes: 0 };
    const attachments = await serializeAttachments(options.attachments ?? [], attachmentBudget);
    const fallbackAttachments = options.fallbackSubmission
      ? await serializeAttachments(options.fallbackSubmission.attachments ?? [], attachmentBudget)
      : undefined;
    const transactionToken = randomBytes(32).toString("hex");
    const payload: RemoteRunPayload = {
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      transactionToken,
      prompt: options.prompt,
      attachments,
      fallbackSubmission: options.fallbackSubmission
        ? {
            prompt: options.fallbackSubmission.prompt,
            attachments: fallbackAttachments ?? [],
          }
        : undefined,
      browserConfig: projectRemoteBrowserRunConfig(options),
      options: {
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        verbose: options.verbose,
        sessionId: options.sessionId,
        followUpPrompts: options.followUpPrompts,
        keepConversationTab: options.config?.keepBrowser === true,
      },
    };
    const { hostname, port } = parseHost(host);
    let receipt: RemoteRunTransactionPayload;
    try {
      receipt = await streamRemoteRun({ hostname, port, token, payload, options, host });
    } catch (error) {
      if (error instanceof RemoteTransportInterruption) {
        receipt = await recoverRemoteRunTransaction({
          hostname,
          port,
          token,
          transactionToken,
          options,
          host,
          interruption: error,
        });
      } else if (
        error instanceof BrowserAutomationError &&
        error.details?.stage === "remote-protocol" &&
        !error.details.runtime
      ) {
        throw new BrowserAutomationError(
          error.message,
          {
            ...error.details,
            recoverableDisconnect: true,
            runtime: unresolvedRemoteTransactionRuntime(host, transactionToken, error.message),
          },
          error,
        );
      } else {
        throw error;
      }
    }
    return await buildRemoteBrowserTransaction({
      receipt,
      hostname,
      port,
      token,
      host,
      options,
    });
  };
}

export async function settleRemoteBrowserRecovery(
  params: RemoteRecoverySettlementOptions,
): Promise<BrowserCaptureFinalizationResult> {
  const authority = params.runtime.remoteRecovery;
  const pending = (message: string): BrowserCaptureFinalizationResult => ({
    status: "pending",
    runtime: {
      ...params.runtime,
      recoveryCleanupResult: { status: "failed", error: message },
    },
    error: message,
  });
  if (!authority || authority.protocolVersion !== REMOTE_TRANSACTION_PROTOCOL_VERSION) {
    return pending("Remote cleanup authority is missing or uses an unsupported protocol version.");
  }
  if (!params.authToken?.trim()) {
    return pending("Remote cleanup authentication is unavailable; configure ORACLE_REMOTE_TOKEN.");
  }
  if (authority.host !== params.configuredHost) {
    return pending(
      `Remote cleanup host mismatch; refusing to send credentials to ${authority.host}.`,
    );
  }
  let endpoint: { hostname: string; port: number };
  try {
    endpoint = parseHost(params.configuredHost);
  } catch (error) {
    return pending(error instanceof Error ? error.message : String(error));
  }
  return await settleRemoteBrowserTransaction({
    ...endpoint,
    token: params.authToken,
    host: authority.host,
    transactionToken: authority.transactionToken,
    recoveryState: authority.state,
    mode: params.mode ?? (authority.state === "recoverable-error" ? "abort" : "finalize"),
    runtime: params.runtime,
  });
}

function projectRemoteBrowserRunConfig(options: BrowserRunOptions): RemoteBrowserRunConfig {
  const config = options.config ?? {};
  return {
    chatgptUrl: config.chatgptUrl ?? config.url,
    timeoutMs: config.timeoutMs,
    inputTimeoutMs: config.inputTimeoutMs,
    attachmentTimeoutMs: config.attachmentTimeoutMs,
    assistantRecheckDelayMs: config.assistantRecheckDelayMs,
    assistantRecheckTimeoutMs: config.assistantRecheckTimeoutMs,
    desiredModel: config.desiredModel,
    modelStrategy: config.modelStrategy,
    thinkingTime: config.thinkingTime,
    researchMode: config.researchMode,
    archiveConversations: config.archiveConversations,
    resumeConversationUrl: config.resumeConversationUrl,
  };
}

async function serializeAttachments(
  attachments: BrowserAttachment[],
  budget: RemoteAttachmentBudget,
): Promise<RemoteAttachmentPayload[]> {
  if (budget.count + attachments.length > MAX_REMOTE_ATTACHMENTS) {
    throw new BrowserAutomationError(
      "Remote browser attachment count exceeds the protocol limit.",
      {
        stage: "remote-request",
      },
    );
  }
  const serialized: RemoteAttachmentPayload[] = [];
  for (const attachment of attachments) {
    const fileStat = await stat(attachment.path).catch((error) => {
      throw new BrowserAutomationError(
        `Unable to inspect remote browser attachment ${attachment.displayPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { stage: "remote-request", attachment: attachment.displayPath },
        error,
      );
    });
    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > MAX_REMOTE_ATTACHMENT_BYTES) {
      throw new BrowserAutomationError(
        `Remote browser attachment exceeds the ${MAX_REMOTE_ATTACHMENT_BYTES}-byte per-file limit: ${attachment.displayPath}`,
        { stage: "remote-request", attachment: attachment.displayPath },
      );
    }
    if (budget.bytes + fileStat.size > MAX_REMOTE_TOTAL_ATTACHMENT_BYTES) {
      throw new BrowserAutomationError(
        "Remote browser attachments exceed the aggregate protocol size limit.",
        { stage: "remote-request" },
      );
    }
    budget.count += 1;
    budget.bytes += fileStat.size;
    const content = await readFile(attachment.path).catch((error) => {
      throw new BrowserAutomationError(
        `Unable to read remote browser attachment ${attachment.displayPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { stage: "remote-request", attachment: attachment.displayPath },
        error,
      );
    });
    if (content.byteLength !== fileStat.size) {
      throw new BrowserAutomationError(
        `Remote browser attachment changed while it was being read: ${attachment.displayPath}`,
        { stage: "remote-request", attachment: attachment.displayPath },
      );
    }
    serialized.push({
      fileName: path.basename(attachment.path),
      displayPath: attachment.displayPath,
      sizeBytes: content.byteLength,
      contentBase64: content.toString("base64"),
    });
  }
  return serialized;
}

function parseHost(input: string): { hostname: string; port: number } {
  try {
    return parseHostPort(input);
  } catch (error) {
    throw new BrowserAutomationError(
      `Invalid remote host: ${input} (${error instanceof Error ? error.message : String(error)})`,
      { stage: "remote-connection" },
      error,
    );
  }
}

async function streamRemoteRun(params: {
  hostname: string;
  port: number;
  token?: string;
  payload: RemoteRunPayload;
  options: BrowserRunOptions;
  host: string;
}): Promise<RemoteRunTransactionPayload> {
  const body = Buffer.from(JSON.stringify(params.payload));
  if (body.byteLength > MAX_REMOTE_REQUEST_BYTES) {
    throw new BrowserAutomationError("Remote browser request exceeds the protocol size limit.", {
      stage: "remote-request",
      transactionToken: params.payload.transactionToken,
    });
  }
  const deferred = createDeferred<RemoteRunTransactionPayload>();
  let settled = false;
  let receipt: RemoteRunTransactionPayload | null = null;
  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true;
    if (receipt) {
      deferred.resolve(receipt);
      return;
    }
    deferred.reject(
      error instanceof BrowserAutomationError
        ? error
        : new RemoteTransportInterruption(
            error instanceof Error
              ? error.message
              : "Remote browser stream ended before the durable transaction receipt.",
            error,
          ),
    );
  };
  const req = http.request(
    {
      hostname: params.hostname,
      port: params.port,
      path: "/runs",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
      },
    },
    (res) => {
      if (res.statusCode !== 200) {
        collectError(res)
          .then((message) =>
            finish(
              new BrowserAutomationError(message, {
                stage: "remote-http",
                statusCode: res.statusCode,
                transactionToken: params.payload.transactionToken,
              }),
            ),
          )
          .catch(finish);
        return;
      }
      res.setEncoding("utf8");
      let buffer = "";
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (Buffer.byteLength(line, "utf8") > MAX_REMOTE_EVENT_BYTES) {
            res.destroy();
            finish(
              new BrowserAutomationError(
                "Remote transaction event exceeded the protocol size limit.",
                { stage: "remote-protocol" },
              ),
            );
            return;
          }
          if (line) {
            try {
              const event = RemoteRunEventSchema.parse(JSON.parse(line)) as RemoteRunEvent;
              if (event.type === "log") {
                params.options.log?.(event.message);
              } else if (event.type === "artifact-progress") {
                if (params.options.verbose) {
                  params.options.log?.(
                    `[browser] Artifact ${event.artifactId} ${event.phase}${
                      event.receivedBytes !== undefined && event.totalBytes !== undefined
                        ? ` ${event.receivedBytes}/${event.totalBytes} bytes`
                        : ""
                    }`,
                  );
                }
              } else if (event.type === "transaction") {
                assertRemoteTransactionOwnership(
                  event.transaction,
                  params.payload.transactionToken,
                );
                receipt = event.transaction;
              } else {
                finish(
                  rehydrateRemoteBrowserError(
                    event.error,
                    params.host,
                    params.payload.transactionToken,
                  ),
                );
              }
            } catch (error) {
              finish(
                new BrowserAutomationError(
                  `Invalid remote transaction event: ${error instanceof Error ? error.message : String(error)}`,
                  { stage: "remote-protocol" },
                  error,
                ),
              );
              return;
            }
          }
          newlineIndex = buffer.indexOf("\n");
        }
        if (Buffer.byteLength(buffer, "utf8") > MAX_REMOTE_EVENT_BYTES) {
          res.destroy();
          finish(
            new BrowserAutomationError(
              "Remote transaction event exceeded the protocol size limit.",
              {
                stage: "remote-protocol",
              },
            ),
          );
        }
      });
      res.on("end", () => finish());
      res.on("aborted", () => finish(new Error("Remote response aborted")));
      res.on("error", finish);
    },
  );
  req.on("error", finish);
  req.end(body);
  return await deferred.promise;
}

async function recoverRemoteRunTransaction(params: {
  hostname: string;
  port: number;
  token?: string;
  transactionToken: string;
  options: BrowserRunOptions;
  host: string;
  interruption: RemoteTransportInterruption;
}): Promise<RemoteRunTransactionPayload> {
  const deadline =
    Date.now() + Math.max(params.options.config?.timeoutMs ?? 1_200_000, 30_000) + 120_000;
  let lastReachableAt = Date.now();
  while (Date.now() < deadline) {
    try {
      const response = await postRemoteJson({
        hostname: params.hostname,
        port: params.port,
        path: `/transactions/${params.transactionToken}/retry`,
        token: params.token,
        body: {},
      });
      lastReachableAt = Date.now();
      if (response.statusCode === 202 || response.statusCode === 404) {
        await delay(500);
        continue;
      }
      if (response.statusCode !== 200) {
        throw new BrowserAutomationError(response.errorMessage, {
          stage: "remote-retry",
          statusCode: response.statusCode,
          transactionToken: params.transactionToken,
          recoverableDisconnect: true,
          runtime: unresolvedRemoteTransactionRuntime(
            params.host,
            params.transactionToken,
            response.errorMessage,
          ),
        });
      }
      const retry = RemoteRetryResponseSchema.parse(
        response.json,
      ) as RemoteTransactionRetryResponse;
      if (retry.status === "running") {
        await delay(500);
        continue;
      }
      if (retry.status === "error") {
        throw rehydrateRemoteBrowserError(retry.error, params.host, params.transactionToken);
      }
      assertRemoteTransactionOwnership(retry.transaction, params.transactionToken);
      return retry.transaction;
    } catch (error) {
      if (error instanceof BrowserAutomationError) throw error;
      if (Date.now() - lastReachableAt > 30_000) {
        const message = `Remote transaction recovery failed after the response disconnected: ${
          error instanceof Error ? error.message : String(error)
        }`;
        throw new BrowserAutomationError(
          message,
          {
            stage: "remote-retry",
            transactionToken: params.transactionToken,
            recoverableDisconnect: true,
            runtime: unresolvedRemoteTransactionRuntime(
              params.host,
              params.transactionToken,
              message,
            ),
          },
          params.interruption,
        );
      }
      await delay(500);
    }
  }
  const message = "Remote browser transaction did not become recoverable before its deadline.";
  throw new BrowserAutomationError(
    message,
    {
      stage: "remote-retry",
      transactionToken: params.transactionToken,
      recoverableDisconnect: true,
      runtime: unresolvedRemoteTransactionRuntime(params.host, params.transactionToken, message),
    },
    params.interruption,
  );
}
function unresolvedRemoteTransactionRuntime(
  host: string,
  transactionToken: string,
  error: string,
): BrowserRuntimeMetadata {
  return {
    recoveryCleanup: {
      transport: "remote",
      ownsTarget: false,
      profileKind: "none",
      keepBrowser: false,
    },
    recoveryCleanupResult: { status: "failed", error },
    remoteRecovery: {
      protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
      host,
      transactionToken,
      state: "recoverable-error",
    },
  };
}

async function buildRemoteBrowserTransaction(params: {
  receipt: RemoteRunTransactionPayload;
  hostname: string;
  port: number;
  token?: string;
  host: string;
  options: BrowserRunOptions;
}): Promise<BrowserRunTransaction> {
  let runtime = projectRemoteRuntime(
    params.receipt.runtime,
    params.host,
    params.receipt.transactionToken,
    params.receipt.state === "pending" ? "pending" : null,
  );
  await params.options.runtimeHintCb?.(runtime, params.receipt.result.modelSelection);

  const transferredFiles: SavedBrowserFile[] = [];
  const transferFailures: string[] = [];
  for (const descriptor of params.receipt.artifacts) {
    try {
      transferredFiles.push(
        await transferRemoteArtifact({
          hostname: params.hostname,
          port: params.port,
          token: params.token,
          descriptor,
          sessionId: params.options.sessionId,
          log: params.options.log,
        }),
      );
    } catch (error) {
      const filename = sanitizeArtifactFilename(descriptor.filename, "artifact.bin");
      const message = `Oracle captured the browser text response, but bridge artifact transfer failed for ${filename}. Open the ChatGPT browser on the bridge host, download the ZIP/file shown in the current response, and copy it to a cloud-readable path. Reason: ${error instanceof Error ? error.message : String(error)}`;
      params.options.log?.(`[browser] ${message}`);
      transferFailures.push(message);
    }
  }
  const result = mergeTransferredArtifacts(
    params.receipt.result,
    transferredFiles,
    transferFailures,
  );
  const transaction: BrowserRunTransaction = {
    ...result,
    runtime,
    finalize: async () => {
      const finalization = await settleRemoteBrowserTransaction({
        hostname: params.hostname,
        port: params.port,
        token: params.token,
        host: params.host,
        transactionToken: params.receipt.transactionToken,
        recoveryState: "pending",
        mode: "finalize",
        runtime,
      });
      runtime = finalization.runtime;
      transaction.runtime = runtime;
      return finalization;
    },
    abort: async () => {
      const finalization = await settleRemoteBrowserTransaction({
        hostname: params.hostname,
        port: params.port,
        token: params.token,
        host: params.host,
        transactionToken: params.receipt.transactionToken,
        recoveryState: "pending",
        mode: "abort",
        runtime,
      });
      runtime = finalization.runtime;
      transaction.runtime = runtime;
      return finalization;
    },
  };
  return transaction;
}

async function settleRemoteBrowserTransaction(params: {
  transactionToken: string;
  recoveryState: "pending" | "recoverable-error";
  hostname: string;
  port: number;
  token?: string;
  host: string;
  mode: "finalize" | "abort";
  runtime: BrowserRuntimeMetadata;
}): Promise<BrowserCaptureFinalizationResult> {
  try {
    const response = await postRemoteJson({
      hostname: params.hostname,
      port: params.port,
      path: `/transactions/${params.transactionToken}/${params.mode}`,
      token: params.token,
      body: { durablePublication: params.mode === "finalize" },
    });
    if (response.statusCode !== 200) {
      throw new BrowserAutomationError(response.errorMessage, {
        stage: `remote-${params.mode}`,
        statusCode: response.statusCode,
        transactionToken: params.transactionToken,
      });
    }
    const settlement = RemoteSettlementResponseSchema.parse(
      response.json,
    ) as RemoteTransactionSettlementResponse;
    if (settlement.transactionToken !== params.transactionToken) {
      throw new BrowserAutomationError("Remote settlement token did not match the request.", {
        stage: "remote-protocol",
        transactionToken: params.transactionToken,
      });
    }
    const expectedTerminalState = params.mode === "finalize" ? "finalized" : "aborted";
    if (
      (settlement.finalization.status === "pending" && settlement.state !== "pending") ||
      (settlement.finalization.status === "completed" && settlement.state !== expectedTerminalState)
    ) {
      throw new BrowserAutomationError(
        `Remote settlement state ${settlement.state} is inconsistent with ${params.mode}.`,
        { stage: "remote-protocol", transactionToken: params.transactionToken },
      );
    }
    const keepRecovery = settlement.finalization.status === "pending";
    return {
      ...settlement.finalization,
      runtime: projectRemoteRuntime(
        settlement.finalization.runtime,
        params.host,
        params.transactionToken,
        keepRecovery ? params.recoveryState : null,
      ),
    };
  } catch (error) {
    const message = `Remote ${params.mode} remains retryable: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return {
      status: "pending",
      runtime: {
        ...params.runtime,
        recoveryCleanupResult: { status: "failed", error: message },
        remoteRecovery: {
          protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
          host: params.host,
          transactionToken: params.transactionToken,
          state: params.recoveryState,
        },
      },
      error: message,
    };
  }
}

function projectRemoteRuntime(
  runtime: BrowserRuntimeMetadata,
  host: string,
  transactionToken: string,
  state: "pending" | "recoverable-error" | null,
): BrowserRuntimeMetadata {
  const remoteRecovery = state
    ? {
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        host,
        transactionToken,
        state,
      }
    : undefined;
  return {
    ...runtime,
    recoveryCleanup:
      state && runtime.recoveryCleanup
        ? { ...runtime.recoveryCleanup, transport: "remote" }
        : undefined,
    recoveryCleanupBacklog: state
      ? runtime.recoveryCleanupBacklog?.map((resource) => ({
          ...resource,
          remoteRecovery,
          recoveryCleanup: { ...resource.recoveryCleanup, transport: "remote" },
        }))
      : undefined,
    remoteRecovery,
  };
}

function assertRemoteTransactionOwnership(
  transaction: RemoteRunTransactionPayload,
  expectedTransactionToken: string,
): void {
  if (transaction.transactionToken !== expectedTransactionToken) {
    throw new BrowserAutomationError("Remote transaction token did not match the request.", {
      stage: "remote-protocol",
      transactionToken: expectedTransactionToken,
    });
  }
  if (
    (transaction.state === "pending" && transaction.finalization?.status === "completed") ||
    (transaction.state !== "pending" && transaction.finalization?.status !== "completed")
  ) {
    throw new BrowserAutomationError("Remote transaction state is internally inconsistent.", {
      stage: "remote-protocol",
      transactionToken: expectedTransactionToken,
    });
  }
  if (transaction.artifacts.some((artifact) => artifact.runId !== transaction.runId)) {
    throw new BrowserAutomationError("Remote artifact ownership did not match the transaction.", {
      stage: "remote-protocol",
      transactionToken: expectedTransactionToken,
    });
  }
}

function rehydrateRemoteBrowserError(
  error: RemoteBrowserAutomationErrorPayload,
  host: string,
  expectedTransactionToken?: string,
): BrowserAutomationError {
  if (
    expectedTransactionToken &&
    error.recoveryToken &&
    error.recoveryToken !== expectedTransactionToken
  ) {
    return new BrowserAutomationError("Remote recovery token did not match the request.", {
      stage: "remote-protocol",
      transactionToken: expectedTransactionToken,
    });
  }
  if (
    (error.recoverableDisconnect && (!error.recoveryToken || !error.runtime)) ||
    (!error.recoverableDisconnect && error.recoveryToken) ||
    (error.recoveryToken && !error.runtime)
  ) {
    return new BrowserAutomationError(
      "Remote recovery error authority is internally inconsistent.",
      {
        stage: "remote-protocol",
        transactionToken: expectedTransactionToken,
      },
    );
  }
  const remoteRecovery = error.recoveryToken
    ? {
        protocolVersion: REMOTE_TRANSACTION_PROTOCOL_VERSION,
        host,
        transactionToken: error.recoveryToken,
        state: "recoverable-error" as const,
      }
    : undefined;
  const runtime =
    error.runtime && error.recoveryToken
      ? projectRemoteRuntime(error.runtime, host, error.recoveryToken, "recoverable-error")
      : error.runtime;
  return new BrowserAutomationError(error.message, {
    ...(error.details ?? {}),
    stage: error.stage,
    recoverableDisconnect: error.recoverableDisconnect,
    remoteRecovery,
    runtime,
  });
}

interface RemoteJsonResponse {
  statusCode: number;
  json: unknown;
  errorMessage: string;
}

async function postRemoteJson(params: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  body: unknown;
}): Promise<RemoteJsonResponse> {
  const body = Buffer.from(JSON.stringify(params.body));
  const deferred = createDeferred<RemoteJsonResponse>();
  const req = http.request(
    {
      hostname: params.hostname,
      port: params.port,
      path: params.path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
      },
    },
    (res) => {
      collectResponseBody(res, 16 * 1024 * 1024)
        .then((raw) => {
          let json: unknown = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            // The status and raw body still produce a typed protocol error at the caller.
          }
          const errorMessage =
            json &&
            typeof json === "object" &&
            "message" in json &&
            typeof json.message === "string"
              ? json.message
              : raw || `Remote host responded with status ${res.statusCode}`;
          deferred.resolve({ statusCode: res.statusCode ?? 0, json, errorMessage });
        })
        .catch(deferred.reject);
    },
  );
  req.on("error", deferred.reject);
  req.end(body);
  return await deferred.promise;
}

async function collectResponseBody(
  res: http.IncomingMessage,
  maximumBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of res) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    receivedBytes += buffer.byteLength;
    if (receivedBytes > maximumBytes) throw new Error("Remote response exceeded size limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, receivedBytes).toString("utf8");
}

async function transferRemoteArtifact(params: {
  hostname: string;
  port: number;
  token?: string;
  descriptor: RemoteArtifactDescriptor;
  sessionId?: string;
  log?: BrowserRunOptions["log"];
}): Promise<SavedBrowserFile> {
  validateRemoteArtifactDescriptor(params.descriptor);
  const sessionId = params.sessionId ?? params.descriptor.runId;
  const artifactsDir = resolveSessionArtifactsDir(sessionId);
  await mkdir(artifactsDir, { recursive: true });
  const filename = sanitizeArtifactFilename(
    params.descriptor.filename,
    `artifact-${params.descriptor.artifactId}.bin`,
  );
  const finalPath = await resolveUniqueArtifactPath(path.join(artifactsDir, filename));
  const partPath = `${finalPath}.part-${params.descriptor.artifactId}`;
  const artifactPath = `/runs/${encodeURIComponent(params.descriptor.runId)}/artifacts/${encodeURIComponent(
    params.descriptor.artifactId,
  )}`;

  params.log?.(`[browser] Transferring artifact ${filename} from bridge host...`);
  await downloadArtifactToFile({
    hostname: params.hostname,
    port: params.port,
    path: artifactPath,
    token: params.token,
    targetPath: partPath,
    descriptor: params.descriptor,
  }).catch(async (error) => {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw error;
  });

  const fileStat = await stat(partPath);
  if (fileStat.size !== params.descriptor.byteSize) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw new Error(`size mismatch (${fileStat.size} != ${params.descriptor.byteSize})`);
  }
  const sha256 = await computeFileSha256(partPath);
  if (sha256 !== params.descriptor.sha256) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw new Error("sha256 mismatch");
  }
  const validation = await validateArtifactFile({
    path: partPath,
    filename,
    mimeType: sanitizeArtifactMimeType(params.descriptor.mimeType),
  });
  if (!validation.ok) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw new Error(`${validation.type} validation failed: ${validation.error ?? "invalid"}`);
  }

  await rename(partPath, finalPath);
  params.log?.(`[browser] Transferred artifact to ${finalPath}`);
  const publishedFilename = path.basename(finalPath);
  return {
    kind: "file",
    path: finalPath,
    label: publishedFilename,
    mimeType: sanitizeArtifactMimeType(params.descriptor.mimeType),
    sizeBytes: fileStat.size,
    sourceUrl: "bridge-artifact",
    sha256,
    validation,
    transfer: { status: "completed", bytes: fileStat.size },
    origin: { mode: "bridge" },
    url: "bridge-artifact",
    finalUrl: "bridge-artifact",
    filename: publishedFilename,
  };
}

async function downloadArtifactToFile(params: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  targetPath: string;
  descriptor: RemoteArtifactDescriptor;
}): Promise<void> {
  const deferred = createDeferred<void>();
  const req = http.request(
    {
      hostname: params.hostname,
      port: params.port,
      path: params.path,
      method: "GET",
      headers: params.token ? { authorization: `Bearer ${params.token}` } : undefined,
    },
    (res) => {
      if (res.statusCode !== 200) {
        collectError(res)
          .then((message) => deferred.reject(new Error(message)))
          .catch(deferred.reject);
        return;
      }
      const headerSha = String(res.headers["x-oracle-artifact-sha256"] ?? "");
      if (headerSha && headerSha !== params.descriptor.sha256) {
        res.resume();
        deferred.reject(new Error("artifact sha256 header mismatch"));
        return;
      }
      const contentLengthHeader = res.headers["content-length"];
      const contentLength =
        typeof contentLengthHeader === "string" ? Number(contentLengthHeader) : undefined;
      if (
        contentLength !== undefined &&
        (!Number.isSafeInteger(contentLength) ||
          contentLength <= 0 ||
          contentLength > MAX_REMOTE_ARTIFACT_BYTES ||
          contentLength !== params.descriptor.byteSize)
      ) {
        res.resume();
        deferred.reject(new Error("artifact content-length mismatch"));
        return;
      }
      const output = createWriteStream(params.targetPath, { flags: "wx" });
      let receivedBytes = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          receivedBytes += chunk.length;
          if (
            receivedBytes > params.descriptor.byteSize ||
            receivedBytes > MAX_REMOTE_ARTIFACT_BYTES
          ) {
            callback(new Error("artifact exceeded declared size"));
            return;
          }
          callback(null, chunk);
        },
      });
      void pipeline(res, limiter, output).then(deferred.resolve, deferred.reject);
    },
  );
  req.on("error", deferred.reject);
  req.end();
  await deferred.promise;
}

function validateRemoteArtifactDescriptor(descriptor: RemoteArtifactDescriptor): void {
  if (
    !descriptor ||
    typeof descriptor !== "object" ||
    descriptor.kind !== "file" ||
    typeof descriptor.runId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(descriptor.runId) ||
    typeof descriptor.artifactId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(descriptor.artifactId) ||
    typeof descriptor.filename !== "string" ||
    !Number.isSafeInteger(descriptor.byteSize) ||
    descriptor.byteSize <= 0 ||
    descriptor.byteSize > MAX_REMOTE_ARTIFACT_BYTES ||
    typeof descriptor.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(descriptor.sha256)
  ) {
    throw new Error("invalid bridge artifact descriptor");
  }
}

function mergeTransferredArtifacts(
  result: BrowserRunResult,
  transferredFiles: SavedBrowserFile[],
  transferFailures: string[],
): BrowserRunResult {
  const artifacts = appendArtifacts(result.artifacts, transferredFiles);
  const savedFiles = appendSavedFiles(result.savedFiles, transferredFiles);
  const warnings = [
    ...(result.warnings ?? []),
    ...transferFailures.map((message) => ({
      code: "remote-artifact-transfer-failed",
      severity: "warning" as const,
      message,
    })),
  ];
  return {
    ...result,
    artifacts,
    savedFiles,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function appendSavedFiles(
  existing: SavedBrowserFile[] | undefined,
  additions: SavedBrowserFile[],
): SavedBrowserFile[] | undefined {
  const merged = new Map<string, SavedBrowserFile>();
  for (const artifact of existing ?? []) {
    merged.set(artifact.path, artifact);
  }
  for (const artifact of additions) {
    merged.set(artifact.path, artifact);
  }
  const values = Array.from(merged.values());
  return values.length > 0 ? values : undefined;
}

async function collectError(res: http.IncomingMessage): Promise<string> {
  const raw = await collectResponseBody(res, 1024 * 1024);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      if ("message" in parsed && typeof parsed.message === "string") return parsed.message;
      if ("error" in parsed && typeof parsed.error === "string") return parsed.error;
    }
  } catch {
    // Fall through to the bounded raw response.
  }
  return raw || `Remote host responded with status ${res.statusCode}`;
}
