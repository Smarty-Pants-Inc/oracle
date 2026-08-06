import { appendArtifacts } from "../browser/artifacts.js";
import { asOracleUserError, OracleResponseError, OracleTransportError } from "../oracle.js";
import type { OracleUserError } from "../oracle/errors.js";
import type {
  BrowserRuntimeMetadata,
  SessionMetadata,
  SessionTransportMetadata,
  SessionUserErrorMetadata,
} from "../sessionStore.js";
import { commitSessionModelProjection } from "../sessionStore.js";
import { autoReattachUntilComplete } from "./autoReattachController.js";
import type {
  BrowserOutcomeModelProjection,
  BrowserSessionOutcome,
} from "./browserSessionOutcome.js";
import { persistBrowserSessionOutcome } from "./browserSessionOutcome.js";
import {
  hasBrowserRecoveryAuthority,
  hasRemoteRecoveryAuthority,
  hasResumableBrowserAuthority,
} from "./browserRuntimeAuthority.js";
import {
  journalHasFinalizeAuthorityForReceipt,
  readBrowserCapturePublicationJournal,
} from "./browserPublicationJournal.js";
import {
  runtimeFromBrowserError,
  verifiedDurableBrowserAnswerReceiptFromError,
} from "./durableAnswer.js";
import { formatError, markErrorLogged } from "./errorUtils.js";
import { formatBrowserReattachGuidance } from "./reattachGuidance.js";
import { formatResponseMetadata, formatTransportMetadata } from "./sessionDisplay.js";
import { dim, writeAssistantOutput } from "./sessionRunSupport.js";
import type { SessionRunContext, SessionRunState } from "./sessionRunTypes.js";

type BrowserFailureOutcomeSpec =
  | {
      kind: "recovery-running";
      runtime: BrowserRuntimeMetadata;
      response: NonNullable<SessionMetadata["response"]>;
      errorMetadata?: SessionUserErrorMetadata;
      transportMetadata?: SessionTransportMetadata;
      modelUpdates?: BrowserOutcomeModelProjection["updates"];
    }
  | {
      kind: "cleanup-pending";
      runtime: BrowserRuntimeMetadata;
      response?: SessionMetadata["response"];
      errorMetadata?: SessionUserErrorMetadata;
      transportMetadata?: SessionTransportMetadata;
      modelUpdates?: BrowserOutcomeModelProjection["updates"];
    }
  | {
      kind: "terminal-error";
      runtime?: BrowserRuntimeMetadata;
      response?: SessionMetadata["response"];
      errorMetadata?: SessionUserErrorMetadata;
      transportMetadata?: SessionTransportMetadata;
      modelUpdates?: BrowserOutcomeModelProjection["updates"];
    };

interface ReducedBrowserFailure {
  message: string;
  userError: OracleUserError | null;
  connectionLost: boolean;
  assistantTimeout: boolean;
  geminiResponseCaptureFailure: boolean;
  geminiCaptureFailure: boolean;
  reattachExplicitlyUnavailable: boolean;
  cloudflareChallenge: boolean;
  errorBrowserRuntime: BrowserRuntimeMetadata | undefined;
  authoritativeErrorDetails: Record<string, unknown> | undefined;
  browserCanReattach: boolean;
}

export async function handleSessionRunFailure(
  context: SessionRunContext,
  state: SessionRunState,
  error: unknown,
): Promise<void> {
  const { sessionMeta, browserConfig, runOptions, log, notificationSettings } = context;
  state.durableAnswerReceipt ??= await verifiedDurableBrowserAnswerReceiptFromError(error);
  const message = formatError(error);
  if (state.browserPublicationCompleted) {
    log(dim(`Browser answer is published; post-publication work remains retryable: ${message}`));
    return;
  }
  if (context.mode === "browser" && state.durableAnswerReceipt) {
    const publicationJournal = await readBrowserCapturePublicationJournal(sessionMeta.id).catch(
      () => null,
    );
    if (journalHasFinalizeAuthorityForReceipt(publicationJournal, state.durableAnswerReceipt)) {
      log(
        dim(
          `Browser answer is durable under FINALIZE authority; terminal projection/finalization remains retryable: ${message}`,
        ),
      );
      return;
    }
  }
  log(`ERROR: ${message}`);
  markErrorLogged(error);
  const failure = reduceBrowserFailure(context, state, error, message);
  let reattachGuidanceLogged = false;
  const logBrowserReattachGuidance = (runtime: BrowserRuntimeMetadata | null | undefined): void => {
    if (reattachGuidanceLogged || context.mode !== "browser") return;
    if (failure.reattachExplicitlyUnavailable) {
      if (!runtime?.recoveryCleanupResources?.length || !runtime.recoveryCleanupResult) return;
      reattachGuidanceLogged = true;
      log(
        dim(
          `Exact browser response recovery is unavailable; run "oracle session ${sessionMeta.id}" to retry owned browser cleanup without resubmitting.`,
        ),
      );
      return;
    }
    if (!hasBrowserRecoveryAuthority(runtime, browserConfig)) return;
    reattachGuidanceLogged = true;
    log(formatBrowserReattachGuidance(sessionMeta.id));
  };

  if (
    (failure.connectionLost || failure.geminiCaptureFailure) &&
    context.mode === "browser" &&
    failure.browserCanReattach
  ) {
    const recoverableRuntime = failure.errorBrowserRuntime ?? state.currentBrowser?.runtime;
    const recoveryAuthorized = failure.geminiCaptureFailure
      ? failure.userError?.details?.reattachable === true
      : failure.userError?.details?.recoverableDisconnect === true;
    const hasRecoveryAuthority = hasResumableBrowserAuthority(recoverableRuntime, browserConfig);
    if (!recoveryAuthorized || !hasRecoveryAuthority || !recoverableRuntime) {
      log(
        dim(
          failure.geminiCaptureFailure
            ? "Gemini capture failed without resumable committed-prompt authority; marking session error."
            : "Chrome disconnected without recoverable current-prompt commit authority; marking session error.",
        ),
      );
      const incompleteReason = failure.geminiCaptureFailure
        ? "incomplete-capture"
        : "chrome-disconnected";
      const response = { status: "error", incompleteReason };
      const errorMetadata = userErrorMetadata(failure);
      await persistBrowserFailureOutcome(context, state, failure, {
        kind: "terminal-error",
        runtime: recoverableRuntime,
        response,
        errorMetadata,
        modelUpdates: { response, error: errorMetadata },
      });
      throw error;
    }
    log(
      dim(
        failure.geminiCaptureFailure
          ? "Gemini response capture remains incomplete; keeping session running for exact reattach."
          : "Chrome disconnected before completion; keeping session running for reattach.",
      ),
    );
    const recoveryRuntime = recoverableRuntime;
    const recoveryResponse = {
      status: "running",
      incompleteReason: failure.geminiCaptureFailure ? "incomplete-capture" : "chrome-disconnected",
    };
    await persistBrowserFailureOutcome(context, state, failure, {
      kind: "recovery-running",
      runtime: recoveryRuntime,
      response: recoveryResponse,
    });
    logBrowserReattachGuidance(recoverableRuntime);
    const configuredIntervalMs = browserConfig?.autoReattachIntervalMs ?? 0;
    const recoveryIntervalMs =
      configuredIntervalMs > 0
        ? configuredIntervalMs
        : Math.max(1_000, Math.min(browserConfig?.timeoutMs ?? 30_000, 30_000));
    const reattach = await autoReattachUntilComplete({
      sessionMeta,
      runtime: recoveryRuntime,
      browserConfig: {
        ...browserConfig,
        autoReattachIntervalMs: recoveryIntervalMs,
        autoReattachDelayMs: browserConfig?.autoReattachDelayMs ?? 0,
        autoReattachTimeoutMs:
          browserConfig?.autoReattachTimeoutMs ?? browserConfig?.timeoutMs ?? 120_000,
      },
      browserMetadata: state.currentBrowser,
      runOptions,
      modelForStatus: context.modelForStatus,
      notificationSettings,
      log,
      writeAssistantOutput,
      maxAttempts: configuredIntervalMs > 0 ? undefined : 1,
      resolveRemoteRecoveryConfig: context.browserDeps?.resolveRemoteRecoveryConfig,
    });
    if (reattach.outcome === "exhausted") {
      const exhaustedRuntime = reattach.runtime ?? recoveryRuntime;
      state.currentBrowser = {
        ...state.currentBrowser,
        config: browserConfig,
        runtime: exhaustedRuntime,
      };
      await persistBrowserFailureOutcome(context, state, failure, {
        kind: "recovery-running",
        runtime: exhaustedRuntime,
        response: recoveryResponse,
      });
    }
    return;
  }

  if (failure.assistantTimeout && context.mode === "browser" && failure.browserCanReattach) {
    log(dim("Assistant response timed out; marking capture incomplete for reattach."));
    const timeoutResponse = {
      status: "incomplete",
      incompleteReason: "incomplete-capture",
    } as const;
    const timeoutError = userErrorMetadata(failure);
    const autoReattachIntervalMs = browserConfig?.autoReattachIntervalMs ?? 0;
    let autoRuntime = failure.errorBrowserRuntime ?? state.currentBrowser?.runtime;
    if (
      autoReattachIntervalMs > 0 &&
      autoRuntime &&
      hasResumableBrowserAuthority(autoRuntime, browserConfig)
    ) {
      const timeoutRecoveryRuntime = autoRuntime;
      await persistBrowserFailureOutcome(context, state, failure, {
        kind: "recovery-running",
        runtime: timeoutRecoveryRuntime,
        response: timeoutResponse,
        errorMetadata: timeoutError,
        modelUpdates: { response: timeoutResponse, error: timeoutError },
      });
      const reattach = await autoReattachUntilComplete({
        sessionMeta,
        runtime: timeoutRecoveryRuntime,
        browserConfig,
        browserMetadata: state.currentBrowser,
        runOptions,
        modelForStatus: context.modelForStatus,
        notificationSettings,
        log,
        writeAssistantOutput,
        resolveRemoteRecoveryConfig: context.browserDeps?.resolveRemoteRecoveryConfig,
      });
      if (reattach.outcome !== "exhausted") {
        return;
      }
      autoRuntime = reattach.runtime ?? autoRuntime;
    }
    await persistBrowserFailureOutcome(context, state, failure, {
      kind: "terminal-error",
      runtime: autoRuntime,
      response: timeoutResponse,
      errorMetadata: timeoutError,
      modelUpdates: { response: timeoutResponse, error: timeoutError },
    });
    logBrowserReattachGuidance(autoRuntime);
    return;
  }

  if (failure.cloudflareChallenge && context.mode === "browser") {
    const reuseProfileHint = failure.userError?.details?.reuseProfileHint;
    if (failure.browserCanReattach) {
      log(
        dim("Cloudflare challenge detected; browser left running so you can complete the check."),
      );
      if (typeof reuseProfileHint === "string") {
        log(dim(`Reuse this browser profile with: ${reuseProfileHint}`));
      }
    } else {
      log(dim("Cloudflare challenge detected; copied profile closed and removed."));
    }
  }
  if (failure.userError) {
    log(dim(`User error (${failure.userError.category}): ${failure.userError.message}`));
  }
  const responseMetadata =
    error instanceof OracleResponseError
      ? error.metadata
      : failure.geminiResponseCaptureFailure
        ? ({ status: "error", incompleteReason: "incomplete-capture" } as const)
        : undefined;
  const metadataLine = formatResponseMetadata(responseMetadata);
  if (metadataLine) {
    log(dim(`Response metadata: ${metadataLine}`));
  }
  const transportMetadata =
    error instanceof OracleTransportError ? { reason: error.reason } : undefined;
  const transportLine = formatTransportMetadata(transportMetadata);
  if (transportLine) {
    log(dim(`Transport: ${transportLine}`));
  }
  const cleanupErrorRuntime =
    failure.errorBrowserRuntime?.recoveryCleanupResources?.length &&
    failure.errorBrowserRuntime.recoveryCleanupResult
      ? failure.errorBrowserRuntime
      : undefined;
  const clearCopiedProfileRuntime =
    context.mode === "browser" &&
    Boolean(browserConfig?.copyProfileSource) &&
    !cleanupErrorRuntime &&
    !hasRemoteRecoveryAuthority(failure.errorBrowserRuntime);
  const browserRuntime =
    context.mode === "browser" && !clearCopiedProfileRuntime
      ? (failure.errorBrowserRuntime ?? state.currentBrowser?.runtime)
      : undefined;
  if (
    !failure.cloudflareChallenge &&
    (failure.browserCanReattach || failure.reattachExplicitlyUnavailable)
  ) {
    logBrowserReattachGuidance(browserRuntime ?? state.currentBrowser?.runtime);
  }
  const errorMetadata = failure.userError ? userErrorMetadata(failure) : undefined;
  const modelUpdates = failure.geminiResponseCaptureFailure
    ? { response: responseMetadata, error: errorMetadata }
    : {};
  if (context.mode === "browser") {
    await persistBrowserFailureOutcome(
      context,
      state,
      failure,
      cleanupErrorRuntime
        ? {
            kind: "cleanup-pending",
            runtime: cleanupErrorRuntime,
            response: responseMetadata,
            errorMetadata,
            transportMetadata,
            modelUpdates,
          }
        : {
            kind: "terminal-error",
            runtime: browserRuntime,
            response: responseMetadata,
            errorMetadata,
            transportMetadata,
            modelUpdates,
          },
    );
  } else {
    const completedAt = new Date().toISOString();
    await commitSessionModelProjection(sessionMeta.id, {
      session: {
        status: "error",
        completedAt,
        errorMessage: failure.message,
        mode: context.mode,
        browser: browserConfig
          ? {
              ...state.currentBrowser,
              config: browserConfig,
              runtime: browserRuntime,
            }
          : undefined,
        ...(state.durableAnswerReceipt
          ? {
              artifacts: appendArtifacts(sessionMeta.artifacts, [
                state.durableAnswerReceipt.artifact,
              ]),
            }
          : {}),
        response: responseMetadata,
        transport: transportMetadata,
        error: errorMetadata,
      },
      ...(context.modelForStatus
        ? {
            model: {
              model: context.modelForStatus,
              updates: {
                status: "error",
                completedAt,
                ...(failure.geminiResponseCaptureFailure
                  ? { response: responseMetadata, error: errorMetadata }
                  : {}),
              },
            },
          }
        : {}),
    });
  }
  throw error;
}

function reduceBrowserFailure(
  context: SessionRunContext,
  state: SessionRunState,
  error: unknown,
  message: string,
): ReducedBrowserFailure {
  const userError = asOracleUserError(error);
  const stage = userError?.details?.stage;
  const connectionLost =
    userError?.category === "browser-automation" && stage === "connection-lost";
  const assistantTimeout =
    userError?.category === "browser-automation" && stage === "assistant-timeout";
  const geminiResponseCaptureFailure =
    userError?.category === "browser-automation" && stage === "gemini-response-capture";
  const geminiCaptureFailure =
    geminiResponseCaptureFailure && userError?.details?.reattachable === true;
  const reattachExplicitlyUnavailable =
    userError?.category === "browser-automation" && userError.details?.reattachable === false;
  const cloudflareChallenge =
    userError?.category === "browser-automation" && stage === "cloudflare-challenge";
  const capturedErrorRuntime = runtimeFromBrowserError(error);
  const errorBrowserRuntime = state.runtimeAuthority.observeError(capturedErrorRuntime);
  const cleanupCompletedAfterCapturedError =
    state.runtimeAuthority.didTerminalCleanupSupersedeError();
  if (errorBrowserRuntime) {
    state.currentBrowser = { ...state.currentBrowser, runtime: errorBrowserRuntime };
  }
  const authoritativeErrorDetails =
    userError?.details && capturedErrorRuntime
      ? { ...userError.details, runtime: errorBrowserRuntime }
      : userError?.details;
  const browserCanReattach =
    !cleanupCompletedAfterCapturedError &&
    (!context.browserConfig?.copyProfileSource || hasRemoteRecoveryAuthority(errorBrowserRuntime));
  return {
    message,
    userError,
    connectionLost,
    assistantTimeout,
    geminiResponseCaptureFailure,
    geminiCaptureFailure,
    reattachExplicitlyUnavailable,
    cloudflareChallenge,
    errorBrowserRuntime,
    authoritativeErrorDetails,
    browserCanReattach,
  };
}

function userErrorMetadata(failure: ReducedBrowserFailure): SessionUserErrorMetadata {
  return {
    category: failure.userError?.category,
    message: failure.userError?.message,
    details: failure.authoritativeErrorDetails,
  };
}

async function persistBrowserFailureOutcome(
  context: SessionRunContext,
  state: SessionRunState,
  failure: ReducedBrowserFailure,
  spec: BrowserFailureOutcomeSpec,
): Promise<void> {
  await persistBrowserSessionOutcome(
    context.sessionMeta.id,
    buildBrowserFailureOutcome(context, state, failure, spec),
  );
}

function buildBrowserFailureOutcome(
  context: SessionRunContext,
  state: SessionRunState,
  failure: ReducedBrowserFailure,
  spec: BrowserFailureOutcomeSpec,
): BrowserSessionOutcome {
  const shared = {
    browser: { ...state.currentBrowser, config: context.browserConfig },
    response: spec.response,
    reason: failure.message,
    artifacts: context.sessionMeta.artifacts,
    receipt: state.durableAnswerReceipt,
    errorMetadata: spec.errorMetadata,
    transportMetadata: spec.transportMetadata,
    modelProjection: context.modelForStatus
      ? { model: context.modelForStatus, updates: spec.modelUpdates ?? {} }
      : undefined,
  };
  switch (spec.kind) {
    case "recovery-running":
      return { kind: spec.kind, runtime: spec.runtime, ...shared, response: spec.response };
    case "cleanup-pending":
      return {
        kind: spec.kind,
        publication: "unpublished",
        runtime: spec.runtime,
        ...shared,
      };
    case "terminal-error":
      return { kind: spec.kind, runtime: spec.runtime, ...shared };
  }
}
