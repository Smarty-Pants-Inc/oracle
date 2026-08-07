import type { BrowserRunResult } from "../browserMode.js";
import type { BrowserRunTransaction } from "../browser/types.js";
import type { ReattachResult } from "../browser/reattach.js";
import { estimateTokenCount } from "../browser/utils.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type {
  BrowserRemotePromptRequestIdentity,
  BrowserRuntimeMetadata,
} from "../sessionManager.js";
import type { DurableRemoteAutomationError } from "./transactionModel.js";
import { RemotePublicRunResultSchema, type RemotePublicRunResult } from "./types.js";

export type RecoveredBrowserRunTransaction = BrowserRunTransaction &
  Pick<ReattachResult, "releaseSettlementLock">;

export function remoteArtifactManualCopyWarning(message: string) {
  return {
    code: "remote-artifact-manual-copy-required",
    severity: "warning" as const,
    message,
  };
}

export function assertBrowserRunTransaction(
  value: unknown,
): asserts value is BrowserRunTransaction {
  if (
    typeof value !== "object" ||
    value === null ||
    !("runtime" in value) ||
    typeof value.runtime !== "object" ||
    value.runtime === null ||
    !("bindSettlement" in value) ||
    typeof value.bindSettlement !== "function" ||
    !("finalize" in value) ||
    typeof value.finalize !== "function" ||
    !("abort" in value) ||
    typeof value.abort !== "function"
  ) {
    throw new BrowserAutomationError(
      "Remote browser host returned a legacy bare result instead of a capture transaction.",
      { stage: "remote-transaction-protocol", code: "legacy-result-rejected" },
    );
  }
}

export function browserRunResultFromTransaction(
  transaction: BrowserRunTransaction,
): BrowserRunResult {
  const {
    runtime,
    bindSettlement: _bindSettlement,
    releaseSettlementLock: _releaseSettlementLock,
    finalize: _finalize,
    abort: _abort,
    ...result
  } = transaction as BrowserRunTransaction & Partial<Pick<ReattachResult, "releaseSettlementLock">>;
  return {
    ...result,
    promptSubmitted: runtime.promptEpoch?.status === "committed",
  };
}

export function browserTransactionFromRecoveredSession(
  recovered: ReattachResult,
  tookMs: number,
): RecoveredBrowserRunTransaction {
  const extended = recovered as ReattachResult & Partial<BrowserRunResult>;
  return {
    ...extended,
    answerText: recovered.answerText,
    answerMarkdown: recovered.answerMarkdown,
    tookMs:
      typeof extended.tookMs === "number" && Number.isFinite(extended.tookMs)
        ? extended.tookMs
        : Math.max(0, tookMs),
    answerTokens:
      typeof extended.answerTokens === "number" && Number.isSafeInteger(extended.answerTokens)
        ? extended.answerTokens
        : estimateTokenCount(recovered.answerMarkdown || recovered.answerText),
    answerChars: recovered.answerText.length,
    conversationId: recovered.runtime.conversationId,
    runtime: recovered.runtime,
    bindSettlement: recovered.bindSettlement,
    releaseSettlementLock: recovered.releaseSettlementLock,
    finalize: recovered.finalize,
    abort: recovered.abort,
  };
}

export function assertCapturedPromptIdentity(
  requestIdentity: BrowserRemotePromptRequestIdentity,
  result: BrowserRunResult,
  runtime: BrowserRuntimeMetadata,
): void {
  const epoch = runtime.promptEpoch;
  // Transaction runtime is the canonical capture authority; the flattened result is optional.
  const conversationId = result.conversationId?.trim() ?? runtime.conversationId?.trim();
  if (
    epoch?.status !== "committed" ||
    !requestIdentity.acceptedPromptSha256.includes(epoch.promptSha256) ||
    epoch.followUpOrdinal !== requestIdentity.followUpOrdinal ||
    epoch.remainingFollowUps !== requestIdentity.remainingFollowUps ||
    !conversationId ||
    conversationId !== epoch.conversationId ||
    runtime.conversationId !== epoch.conversationId
  ) {
    throw new BrowserAutomationError(
      "Remote capture does not match the exact committed prompt and conversation identity.",
      {
        stage: "remote-prompt-authority",
        code: "remote-prompt-authority-mismatch",
      },
    );
  }
}

export function browserRuntimeFromError(
  error: BrowserAutomationError,
): BrowserRuntimeMetadata | undefined {
  const candidate = error.details?.runtime;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const runtime = candidate as BrowserRuntimeMetadata;
  return runtime;
}
export function isRecoverableRemoteBrowserAutomationError(error: BrowserAutomationError): boolean {
  return error.details?.recoverableDisconnect === true && error.details?.reattachable !== false;
}

export function hasBrowserCleanupAuthority(
  runtime: BrowserRuntimeMetadata | undefined,
): runtime is BrowserRuntimeMetadata {
  return Boolean(runtime?.recoveryCleanupResources?.length || runtime?.recoveryCleanupResult);
}

export function serializeDurableBrowserAutomationError(
  error: BrowserAutomationError,
  recoverableDisconnect: boolean,
): DurableRemoteAutomationError {
  const code = typeof error.details?.code === "string" ? error.details.code : undefined;
  const stage = typeof error.details?.stage === "string" ? error.details.stage : undefined;
  return {
    name: "BrowserAutomationError",
    category: "browser-automation",
    message: error.message,
    code,
    stage,
    recoverableDisconnect,
  };
}

export function projectRemotePublicResult(result: BrowserRunResult): RemotePublicRunResult {
  return RemotePublicRunResultSchema.parse({
    answerText: result.answerText,
    answerMarkdown: result.answerMarkdown,
    answerHtml: result.answerHtml,
    archive: result.archive
      ? {
          mode: result.archive.mode,
          attempted: result.archive.attempted,
          archived: result.archive.archived,
          conversationUrl: result.archive.conversationUrl,
        }
      : undefined,
    modelSelection: result.modelSelection,
    warnings: result.warnings?.map((warning) => ({
      code:
        warning.code && /^[A-Za-z0-9_-]{1,128}$/u.test(warning.code)
          ? warning.code
          : "remote-host-warning",
      severity: warning.severity,
      message: "Remote browser host reported a warning.",
    })),
    tookMs: result.tookMs,
    answerTokens: result.answerTokens,
    answerChars: result.answerText.length,
    promptSubmitted: result.promptSubmitted,
  });
}
