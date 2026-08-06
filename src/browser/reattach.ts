import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { loadUserConfig } from "../config.js";
import { resumeRemoteBrowserTransaction } from "../remote/client.js";
import { resolveRemoteServiceConfig } from "../remote/remoteServiceConfig.js";
import {
  waitForAssistantResponse,
  captureAssistantMarkdown,
  clearPromptComposer,
  waitForResumedConversationHydration,
  verifyCommittedPromptTurn,
} from "./pageActions.js";
import {
  geminiDeepThinkDomProvider,
  recoverCommittedGeminiDeepThinkResponse,
} from "./providers/geminiDeepThinkDomProvider.js";
import { chatgptDomProvider } from "./providers/chatgptDomProvider.js";
import type { BrowserLogger } from "./types.js";
import {
  adaptDirectTargetChromeClient,
  type SessionBoundChromeClient,
} from "./chromeSessionTransport.js";
import { connectToRemoteChromeTarget, listRemoteChromeTargets } from "./chromeLifecycle.js";
import { resolveBrowserConfig } from "./config.js";
import { resolveGeminiWebModel } from "../gemini-web/models.js";
import { acquireReattachRecoveryLock, type ReattachRecoveryLock } from "./reattachLock.js";
import {
  extractConversationIdFromUrl,
  buildConversationUrl,
  withTimeout,
  openConversationFromSidebar,
  openConversationFromSidebarWithRetry,
  waitForLocationChange,
  type TargetInfoLite,
} from "./reattachHelpers.js";
import { delay } from "./utils.js";
import { BrowserRunLifecycleController } from "./runLifecycle.js";
import { promptIdentitySha256 } from "./actions/committedPrompt.js";
import { runProviderSubmissionFlow } from "./providerDomFlow.js";
import { waitForDeepResearchCompletion } from "./actions/deepResearch.js";
import {
  defaultRecoveryLockPath,
  finalizeRecoveredRuntime,
  recoveryCleanupGroupKey,
} from "./reattachCleanup.js";
import { inferPortFromBrowserWSEndpoint } from "./reattachRuntime.js";
import {
  findRemoteRecoveryAuthority,
  hasPendingPromptEpoch,
  resolveCommittedGeminiPromptEpochLocator,
  resolvePendingPromptEpochAuthority,
  type CommittedPromptEpochLocator,
  type PendingPromptEpochAuthority,
} from "./reattachability.js";
export type { ReattachCleanupDeps, ReattachFinalizationResult } from "./reattachCleanup.js";
import {
  assertSameCommittedPromptEpoch,
  buildCommittedConversationUrl,
  createOwnedRecoveryTargetConnection,
  requireCommittedPromptEpochLocator,
  resumeBrowserSessionViaNewChrome,
} from "./reattachAcquisition.js";
import type { ReattachCapture, ReattachDeps, ReattachResult } from "./reattachContracts.js";
export type { ReattachCapture, ReattachDeps, ReattachResult } from "./reattachContracts.js";
import {
  extractRecoverableConversationId,
  selectPendingPromptTarget,
  selectTarget,
  type ExplicitTargetSelectionFailure,
  type TargetSelection,
} from "./reattachTargetSelection.js";
import { bindReattachTarget, refreshAttachRuntime } from "./reattachTargetAuthority.js";
import { createReattachSettlement } from "./reattachSettlement.js";
export {
  retryBrowserRecoveryCleanup,
  settleBrowserRecoveryCleanup,
  bindCurrentBrowserRecoveryRuntime,
  type BrowserRecoverySettlementOutcome,
  type BrowserRecoverySettlementDeps,
  type BrowserRecoverySettlementMode,
} from "./reattachSettlement.js";

type ReattachRecoveryClassification = "stale-runtime" | "recoverable-transport";

class ClassifiedReattachError extends Error {
  readonly classification: ReattachRecoveryClassification;

  constructor(classification: ReattachRecoveryClassification, message: string, cause?: unknown) {
    super(message);
    this.name = "ClassifiedReattachError";
    this.classification = classification;
    if (cause) (this as Error & { cause?: unknown }).cause = cause;
  }
}

function explicitTargetAuthorityError(
  browserTabRef: string,
  failure: ExplicitTargetSelectionFailure | "runtime-unavailable" | "attach-failed",
  message: string,
  cause?: unknown,
): BrowserAutomationError {
  return new BrowserAutomationError(
    message,
    {
      stage: "browser-reattach-explicit-target",
      code: `explicit-browser-tab-${failure}`,
      browserTabRef,
      reattachClassification: "explicit-selector-terminal",
    },
    cause,
  );
}

function isExplicitTargetAuthorityError(error: unknown): error is BrowserAutomationError {
  return (
    error instanceof BrowserAutomationError &&
    error.details?.reattachClassification === "explicit-selector-terminal"
  );
}

async function classifyReattachFailure<T>(
  classification: ReattachRecoveryClassification,
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BrowserAutomationError || error instanceof ClassifiedReattachError) {
      throw error;
    }
    throw new ClassifiedReattachError(classification, message, error);
  }
}

function isGeminiAppUrl(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  try {
    const url = new URL(candidate);
    return (
      url.protocol === "https:" &&
      !url.port &&
      url.hostname === "gemini.google.com" &&
      (url.pathname === "/app" || url.pathname.startsWith("/app/"))
    );
  } catch {
    return false;
  }
}

function selectGeminiRecoveryTarget(
  targets: TargetInfoLite[],
  runtime: BrowserRuntimeMetadata,
  browserTabRef?: string,
): TargetSelection {
  const targetIds = new Set(
    [
      runtime.chromeTargetId,
      ...(runtime.recoveryCleanupResources ?? []).map((resource) => resource.chromeTargetId),
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0),
  );
  if (targetIds.size !== 1) {
    return { status: targetIds.size > 1 ? "ambiguous" : "missing" };
  }
  const targetId = targetIds.values().next().value;
  if (!targetId) return { status: "missing" };
  if (
    runtime.promptEpoch?.status !== "committed" ||
    runtime.promptEpoch.conversationId !== targetId
  ) {
    return { status: "mismatched" };
  }
  const exactTargets = targets.filter((target) => (target.targetId ?? target.id) === targetId);
  if (exactTargets.length !== 1) {
    return { status: exactTargets.length > 1 ? "ambiguous" : "missing" };
  }
  const target = exactTargets[0];
  if (target.type && target.type !== "page") return { status: "mismatched" };
  if (!isGeminiAppUrl(target.url)) return { status: "mismatched" };
  if (browserTabRef) {
    if (browserTabRef.toLowerCase() === "current") return { status: "unsupported" };
    if (browserTabRef !== targetId && browserTabRef !== target.url) return { status: "mismatched" };
  }
  return { status: "selected", target, targetId };
}

function pendingPromptRecoveryError(
  runtime: BrowserRuntimeMetadata,
  reason: string,
): BrowserAutomationError {
  return new BrowserAutomationError(`Pending prompt epoch recovery remains ambiguous: ${reason}`, {
    stage: "prompt-epoch-reconciliation",
    code: "pending-prompt-epoch-ambiguous",
    reattachable: true,
    recoverableDisconnect: true,
    runtime,
  });
}

function assertSamePendingPromptAuthority(
  expected: PendingPromptEpochAuthority,
  actual: PendingPromptEpochAuthority | null,
  runtime: BrowserRuntimeMetadata,
): asserts actual is PendingPromptEpochAuthority {
  if (
    !actual ||
    actual.targetId !== expected.targetId ||
    actual.epoch.epochId !== expected.epoch.epochId ||
    actual.epoch.promptSha256 !== expected.epoch.promptSha256 ||
    actual.epoch.baselineTurns !== expected.epoch.baselineTurns ||
    actual.epoch.followUpOrdinal !== expected.epoch.followUpOrdinal ||
    actual.epoch.remainingFollowUps !== expected.epoch.remainingFollowUps ||
    actual.conversationId !== expected.conversationId ||
    actual.resourceKey !== expected.resourceKey
  ) {
    throw pendingPromptRecoveryError(runtime, "persisted target or prompt authority changed");
  }
}

function pendingReplayPrompt(
  authority: PendingPromptEpochAuthority,
  candidates: readonly string[] | undefined,
): string | null {
  return (
    candidates?.find(
      (candidate) => promptIdentitySha256(candidate) === authority.epoch.promptSha256,
    ) ?? null
  );
}

export async function resumeBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps = {},
): Promise<ReattachResult> {
  const explicitTabRef = config?.browserTabRef?.trim() || undefined;
  const geminiDeepThinkRecovery =
    resolveGeminiWebModel(config?.desiredModel) === "gemini-3-pro-deep-think";
  const requireRecoveryPromptLocator = (
    candidate: BrowserRuntimeMetadata,
  ): CommittedPromptEpochLocator => {
    if (!geminiDeepThinkRecovery) return requireCommittedPromptEpochLocator(candidate);
    const locator = resolveCommittedGeminiPromptEpochLocator(candidate, config);
    if (locator) return locator;
    throw new BrowserAutomationError(
      "Gemini reattach requires immutable committed-prompt identity and an exact retained target binding.",
      {
        stage: "gemini-response-capture",
        code: "gemini-reattach-authority-unavailable",
        reattachable: false,
        runtime: candidate,
      },
    );
  };
  const initialRemoteRecovery = findRemoteRecoveryAuthority(runtime);
  if (initialRemoteRecovery && explicitTabRef) {
    throw explicitTargetAuthorityError(
      explicitTabRef,
      "unsupported",
      `Explicit browser tab ${explicitTabRef} cannot be combined with remote transaction recovery because the remote protocol cannot carry exact tab authority.`,
    );
  }
  if (!initialRemoteRecovery && hasPendingPromptEpoch(runtime) && !deps.sessionId?.trim()) {
    throw pendingPromptRecoveryError(runtime, "the exact recovering session owner is unavailable");
  }
  let pendingPromptAuthority = initialRemoteRecovery
    ? null
    : resolvePendingPromptEpochAuthority(runtime, deps.sessionId?.trim());
  let promptLocator =
    initialRemoteRecovery && !runtime.promptEpoch
      ? null
      : runtime.promptEpoch?.status === "committed"
        ? requireRecoveryPromptLocator(runtime)
        : null;
  const lockPath = deps.recoveryLockPath ?? defaultRecoveryLockPath(runtime);
  const acquireRecoveryLock = deps.acquireRecoveryLock ?? acquireReattachRecoveryLock;
  let recoveryLock: ReattachRecoveryLock | null = await acquireRecoveryLock(lockPath);
  const ensureRecoveryLock = async (): Promise<void> => {
    if (recoveryLock) return;
    recoveryLock = await acquireRecoveryLock(lockPath);
  };
  const releaseRecoveryLock = async (finalize?: () => Promise<void>): Promise<void> => {
    const heldLock = recoveryLock;
    if (!heldLock) {
      await finalize?.();
      return;
    }
    await heldLock.release(finalize);
    if (recoveryLock === heldLock) recoveryLock = null;
  };
  const recoverSession =
    deps.recoverSession ??
    (async (runtimeMeta, configMeta) =>
      resumeBrowserSessionViaNewChrome(runtimeMeta, configMeta, logger, deps));
  let closeAttachedConnection: (() => Promise<void>) | null = null;
  const closeAttached = async (): Promise<void> => {
    const close = closeAttachedConnection;
    closeAttachedConnection = null;
    await close?.().catch(() => undefined);
  };

  const buildResult = (
    capture: ReattachCapture,
    authoritativeRuntime: BrowserRuntimeMetadata = runtime,
  ): ReattachResult =>
    createReattachSettlement(
      capture,
      authoritativeRuntime,
      promptLocator,
      logger,
      deps,
      {
        ensure: ensureRecoveryLock,
        release: releaseRecoveryLock,
      },
      requireRecoveryPromptLocator,
    );

  const recover = async (
    classification: ReattachRecoveryClassification,
    reason: string,
    authoritativeRuntime: BrowserRuntimeMetadata = runtime,
  ): Promise<ReattachResult> => {
    if (pendingPromptAuthority) {
      throw pendingPromptRecoveryError(
        authoritativeRuntime,
        `the exact retained target cannot be replaced after ${classification}: ${reason}`,
      );
    }
    if (geminiDeepThinkRecovery) {
      throw new BrowserAutomationError(
        `Exact Gemini reattach cannot reopen or resubmit the accepted prompt after ${classification}: ${reason}`,
        {
          stage: "gemini-response-capture",
          code: "gemini-reattach-authority-unavailable",
          reattachable: classification === "recoverable-transport",
          runtime: authoritativeRuntime,
        },
      );
    }
    if (explicitTabRef) {
      throw explicitTargetAuthorityError(
        explicitTabRef,
        "attach-failed",
        `Explicit browser tab ${explicitTabRef} cannot be replaced after ${classification}: ${reason}`,
      );
    }
    logger(
      `Existing Chrome reattach requires ${classification} recovery (${reason}); reopening browser to locate the session.`,
    );
    const capture = await recoverSession(authoritativeRuntime, config);
    return buildResult(capture, authoritativeRuntime);
  };

  try {
    if (initialRemoteRecovery) {
      const configured = deps.recoveryCleanup?.resolveRemoteRecoveryConfig
        ? await deps.recoveryCleanup.resolveRemoteRecoveryConfig()
        : resolveRemoteServiceConfig({
            userConfig: (await loadUserConfig({ includeProject: false })).config,
            env: process.env,
          });
      const transaction = await (
        deps.resumeRemoteBrowserTransaction ?? resumeRemoteBrowserTransaction
      )({
        runtime,
        configuredHost: configured.host ?? "",
        authToken: configured.token,
        sessionId: deps.sessionId,
        log: logger,
        runtimeHintCb: deps.runtimeHintCb,
      });
      return buildResult(
        {
          ...transaction,
          finalizeResources: transaction.finalize,
          abortResources: transaction.abort,
        },
        transaction.runtime,
      );
    }
    if (!promptLocator && !pendingPromptAuthority) {
      if (hasPendingPromptEpoch(runtime)) {
        throw pendingPromptRecoveryError(
          runtime,
          "the persisted pending epoch lacks exact retained target authority",
        );
      }
      throw new BrowserAutomationError(
        "Local browser reattach requires a committed prompt epoch.",
        { stage: "prompt-epoch", code: "committed-prompt-identity-mismatch" },
      );
    }
    let promptEpoch = promptLocator?.epoch;
    let minAssistantTurnIndex = promptLocator ? promptLocator.verifiedUserTurnIndex + 1 : undefined;
    if (!runtime.chromePort && !runtime.chromeBrowserWSEndpoint) {
      const reason = "No running Chrome endpoint is recorded.";
      if (explicitTabRef) {
        throw explicitTargetAuthorityError(
          explicitTabRef,
          "runtime-unavailable",
          `Explicit browser tab ${explicitTabRef} cannot be attached because no running Chrome endpoint is available.`,
        );
      }
      return await recover("stale-runtime", reason);
    }

    let liveRuntime = runtime;
    try {
      if (!deps.listTargets) {
        const refreshedRuntime = await classifyReattachFailure(
          "stale-runtime",
          "Recorded Chrome endpoint could not be bound to its exact process generation.",
          () => refreshAttachRuntime(runtime),
        );
        if (!refreshedRuntime) {
          throw new ClassifiedReattachError(
            "stale-runtime",
            "The recorded Chrome process generation has exited.",
          );
        }
        liveRuntime = refreshedRuntime;
      }
      if (pendingPromptAuthority) {
        assertSamePendingPromptAuthority(
          pendingPromptAuthority,
          resolvePendingPromptEpochAuthority(liveRuntime, deps.sessionId?.trim()),
          liveRuntime,
        );
      } else if (promptLocator) {
        const livePromptLocator = requireRecoveryPromptLocator(liveRuntime);
        assertSameCommittedPromptEpoch(promptLocator, livePromptLocator);
      }
      const host = liveRuntime.chromeHost ?? "127.0.0.1";
      const port =
        liveRuntime.chromePort ??
        inferPortFromBrowserWSEndpoint(liveRuntime.chromeBrowserWSEndpoint);
      const browserWSEndpoint = liveRuntime.chromeBrowserWSEndpoint ?? undefined;
      const listTargets =
        deps.listTargets ??
        (async () =>
          (await listRemoteChromeTargets({
            host,
            port: port ?? 9222,
            browserWSEndpoint,
          })) as TargetInfoLite[]);
      const targetList = await classifyReattachFailure(
        "recoverable-transport",
        "Unable to list targets from the recorded Chrome endpoint.",
        listTargets,
      );
      const selection = pendingPromptAuthority
        ? selectPendingPromptTarget(targetList, pendingPromptAuthority.targetId, explicitTabRef)
        : geminiDeepThinkRecovery
          ? selectGeminiRecoveryTarget(targetList, liveRuntime, explicitTabRef)
          : selectTarget(targetList, liveRuntime, explicitTabRef);
      if (
        selection.status === "selected" &&
        pendingPromptAuthority &&
        geminiDeepThinkRecovery &&
        !isGeminiAppUrl(selection.target.url)
      ) {
        throw pendingPromptRecoveryError(
          liveRuntime,
          "the exact retained Gemini target no longer exposes the Gemini application",
        );
      }
      if (selection.status !== "selected") {
        if (explicitTabRef) {
          const descriptions: Record<ExplicitTargetSelectionFailure, string> = {
            missing: "is missing",
            ambiguous: "matches multiple browser targets",
            mismatched: "does not belong to the committed conversation",
            unsupported: "cannot be resolved deterministically during reattach",
          };
          throw explicitTargetAuthorityError(
            explicitTabRef,
            selection.status,
            `Explicit browser tab ${explicitTabRef} ${descriptions[selection.status]}.`,
          );
        }
        if (pendingPromptAuthority) {
          throw pendingPromptRecoveryError(
            liveRuntime,
            `the exact retained target is ${selection.status}`,
          );
        }
        if (geminiDeepThinkRecovery) {
          throw new BrowserAutomationError(
            "The exact Gemini target is unavailable or no longer belongs to the committed prompt authority.",
            {
              stage: "gemini-response-capture",
              code: "gemini-reattach-target-mismatch",
              reattachable: selection.status === "missing",
              runtime: liveRuntime,
            },
          );
        }
        liveRuntime = { ...liveRuntime, chromeTargetId: undefined };
        throw new ClassifiedReattachError(
          "stale-runtime",
          "Stored Chrome target is unavailable or no longer matches the committed conversation.",
        );
      }
      const targetId = selection.targetId;
      liveRuntime = bindReattachTarget(liveRuntime, targetId);
      const connection = await classifyReattachFailure(
        "recoverable-transport",
        `Unable to connect to Chrome target ${targetId}.`,
        async () =>
          deps.connect
            ? await (async () => {
                const client = await deps.connect?.(
                  browserWSEndpoint
                    ? { target: browserWSEndpoint, local: true, targetId }
                    : { host, port, target: targetId },
                );
                if (!client) throw new Error("Chrome target connection returned no client.");
                const attachment = adaptDirectTargetChromeClient(client);
                return { ...attachment, close: () => attachment.client.close() };
              })()
            : await connectToRemoteChromeTarget(host, port ?? 9222, logger, {
                browserWSEndpoint,
                targetId,
                closeTargetOnDispose: false,
              }),
      );
      closeAttachedConnection = () => connection.close();

      const client: SessionBoundChromeClient = connection.client;
      const { Runtime, DOM, Page, Input } = client;
      await classifyReattachFailure(
        "recoverable-transport",
        `Chrome target ${targetId} disconnected while enabling DevTools domains.`,
        async () => {
          if (Runtime?.enable) await Runtime.enable();
          if (DOM && typeof DOM.enable === "function") await DOM.enable();
          if (Page && typeof Page.enable === "function") await Page.enable();
        },
      );
      let promptCommitPersistencePending = false;
      if (pendingPromptAuthority) {
        const replayPrompt = pendingReplayPrompt(
          pendingPromptAuthority,
          deps.pendingPromptCandidates,
        );
        const hashAuthorized =
          replayPrompt !== null ||
          deps.pendingPromptSha256Authorities?.includes(
            pendingPromptAuthority.epoch.promptSha256,
          ) === true;
        if (!hashAuthorized) {
          throw pendingPromptRecoveryError(
            liveRuntime,
            "the persisted prompt hash is not authorized by the recovering session request",
          );
        }
        if (!deps.runtimeHintCb) {
          throw pendingPromptRecoveryError(
            liveRuntime,
            "no durable runtime writer is available for committed authority promotion",
          );
        }
        const provider =
          deps.pendingPromptProvider ??
          (geminiDeepThinkRecovery ? geminiDeepThinkDomProvider : chatgptDomProvider);
        if (!provider.reconcilePendingPrompt) {
          throw pendingPromptRecoveryError(
            liveRuntime,
            `${provider.providerName} does not expose pending prompt reconciliation`,
          );
        }
        const providerState: Record<string, unknown> = geminiDeepThinkRecovery
          ? {
              inputTimeoutMs: config?.inputTimeoutMs,
              timeoutMs: config?.timeoutMs,
              geminiConversationId: targetId,
            }
          : {
              runtime: Runtime,
              input: Input,
              logger,
              timeoutMs: config?.timeoutMs ?? 120_000,
              inputTimeoutMs: config?.inputTimeoutMs,
              attachmentTimeoutMs: config?.attachmentTimeoutMs,
              baselineTurns: pendingPromptAuthority.epoch.baselineTurns,
            };
        const evaluate = async <T>(expression: string): Promise<T | undefined> => {
          const evaluation = await Runtime.evaluate({
            expression,
            returnByValue: true,
            awaitPromise: true,
          });
          if (evaluation.exceptionDetails) {
            const detail =
              evaluation.exceptionDetails.exception?.description ??
              evaluation.exceptionDetails.text ??
              "unknown exception";
            throw new Error(`Pending prompt DOM evaluation failed: ${detail}`);
          }
          return evaluation.result?.value as T | undefined;
        };
        const reconciliation = await provider.reconcilePendingPrompt(
          { evaluate, delay, log: logger, state: providerState },
          {
            promptSha256: pendingPromptAuthority.epoch.promptSha256,
            baselineTurns: pendingPromptAuthority.epoch.baselineTurns,
            ...(geminiDeepThinkRecovery
              ? { conversationId: targetId }
              : pendingPromptAuthority.conversationId
                ? { conversationId: pendingPromptAuthority.conversationId }
                : {}),
          },
        );
        if (reconciliation.status === "ambiguous") {
          throw pendingPromptRecoveryError(liveRuntime, reconciliation.reason);
        }
        const recoveredPrompt =
          reconciliation.status === "committed" ? reconciliation.prompt : replayPrompt;
        if (!recoveredPrompt) {
          throw pendingPromptRecoveryError(
            liveRuntime,
            "non-commit was proven but the exact session prompt is unavailable for replay",
          );
        }
        const lifecycle = new BrowserRunLifecycleController({
          ownerId: deps.sessionId,
          getRuntime: () => liveRuntime,
          persistRuntime: async (nextRuntime) => {
            liveRuntime = nextRuntime;
            await deps.runtimeHintCb?.(nextRuntime);
          },
          settleResources: (mode, pendingRuntime) =>
            finalizeRecoveredRuntime(
              pendingRuntime,
              logger,
              { ...deps.recoveryCleanup, ownerId: deps.sessionId },
              mode,
            ),
        });
        const epochIdentity = lifecycle.restorePendingPromptDispatch(recoveredPrompt, liveRuntime);
        if (reconciliation.status === "committed") {
          await lifecycle.recordPromptCommitVerification(
            reconciliation.verification,
            epochIdentity,
          );
        } else {
          logger("Pending prompt epoch was definitively not submitted; replaying it once.");
          if (provider === chatgptDomProvider) {
            await clearPromptComposer(Runtime, logger);
          }
          const evidence = await runProviderSubmissionFlow(provider, {
            prompt: recoveredPrompt,
            evaluate,
            delay,
            log: logger,
            state: providerState,
          });
          await lifecycle.recordPromptCommitEvidence(evidence, epochIdentity);
          if (!lifecycle.isPromptCommitted()) {
            throw pendingPromptRecoveryError(
              lifecycle.runtime(liveRuntime),
              "the provider replay did not produce exact committed prompt evidence",
            );
          }
        }
        promptCommitPersistencePending = lifecycle.hasPendingPromptAuthorityJournal();
        liveRuntime = lifecycle.runtime(liveRuntime);
        pendingPromptAuthority = null;
        promptLocator = requireRecoveryPromptLocator(liveRuntime);
        promptEpoch = promptLocator.epoch;
        minAssistantTurnIndex = promptLocator.verifiedUserTurnIndex + 1;
      }
      if (!promptLocator || !promptEpoch || minAssistantTurnIndex === undefined) {
        throw pendingPromptRecoveryError(
          liveRuntime,
          "reconciliation did not produce committed prompt authority",
        );
      }
      const committedPromptLocator = promptLocator;
      const committedPromptEpoch = promptEpoch;
      const recoveryWarnings = promptCommitPersistencePending
        ? [
            {
              code: "prompt-commit-journal-pending",
              severity: "warning" as const,
              message:
                "The recovered prompt commit could not yet be durably journaled; exact in-memory authority was used to capture the original answer.",
            },
          ]
        : undefined;
      if (geminiDeepThinkRecovery) {
        const timeoutMs = config?.timeoutMs ?? 120_000;
        const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
        await classifyReattachFailure(
          "recoverable-transport",
          `Gemini target ${targetId} did not respond to the reattach probe.`,
          async () =>
            withTimeout(
              Runtime.evaluate({ expression: "1+1", returnByValue: true }),
              pingTimeoutMs,
              "Gemini reattach target did not respond",
            ),
        );
        let answer: { text: string };
        try {
          answer = await recoverCommittedGeminiDeepThinkResponse(
            {
              evaluate: async <T>(expression: string): Promise<T | undefined> => {
                const evaluation = await Runtime.evaluate({
                  expression,
                  returnByValue: true,
                  awaitPromise: true,
                });
                if (evaluation.exceptionDetails) {
                  const detail =
                    evaluation.exceptionDetails.exception?.description ??
                    evaluation.exceptionDetails.text ??
                    "unknown exception";
                  throw new Error(`Gemini reattach DOM evaluation failed: ${detail}`);
                }
                return evaluation.result?.value as T | undefined;
              },
              delay,
              log: logger,
            },
            committedPromptLocator,
            timeoutMs,
          );
        } catch (error) {
          if (error instanceof BrowserAutomationError) {
            throw new BrowserAutomationError(
              error.message,
              { ...error.details, runtime: liveRuntime },
              error,
            );
          }
          throw new BrowserAutomationError(
            error instanceof Error ? error.message : String(error),
            {
              stage: "gemini-response-capture",
              code: "gemini-reattach-capture-pending",
              reattachable: true,
              runtime: liveRuntime,
            },
            error,
          );
        }
        await closeAttached();
        return buildResult(
          {
            answerText: answer.text,
            answerMarkdown: answer.text,
            runtime: liveRuntime,
            ...(recoveryWarnings ? { warnings: recoveryWarnings } : {}),
          },
          liveRuntime,
        );
      }

      const ensureConversationOpen = async () => {
        const { result } = await Runtime.evaluate({
          expression: "location.href",
          returnByValue: true,
        });
        const href = typeof result?.value === "string" ? result.value : "";
        if (extractRecoverableConversationId(href) === committedPromptEpoch.conversationId) return;
        const opened = await openConversationFromSidebarWithRetry(
          Runtime,
          {
            conversationId: committedPromptEpoch.conversationId,
            preferProjects: true,
          },
          15_000,
        );
        if (!opened) throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
        await waitForLocationChange(Runtime, 15_000);
      };

      const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
      const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
      const timeoutMs = config?.timeoutMs ?? 120_000;
      const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
      await classifyReattachFailure(
        "recoverable-transport",
        `Chrome target ${targetId} did not respond to the reattach probe.`,
        async () =>
          withTimeout(
            Runtime.evaluate({ expression: "1+1", returnByValue: true }),
            pingTimeoutMs,
            "Reattach target did not respond",
          ),
      );
      await classifyReattachFailure(
        "stale-runtime",
        `Chrome target ${targetId} no longer exposes the committed conversation.`,
        ensureConversationOpen,
      );
      const waitForHydration =
        deps.waitForConversationHydration ?? waitForResumedConversationHydration;
      const expectedConversationUrl = buildCommittedConversationUrl(
        runtime,
        resolveBrowserConfig(config ?? {}).url,
        committedPromptEpoch.conversationId,
      );
      await classifyReattachFailure(
        "stale-runtime",
        `Chrome target ${targetId} did not hydrate the committed conversation.`,
        async () =>
          waitForHydration(Runtime, timeoutMs, logger, {
            requirePriorTurns: true,
            requirePromptReady: false,
            expectedConversationUrl: expectedConversationUrl ?? undefined,
          }),
      );
      const verifyPromptTurn = deps.verifyCommittedPromptTurn ?? verifyCommittedPromptTurn;
      await verifyPromptTurn(Runtime, committedPromptLocator);
      const minTurnIndex = minAssistantTurnIndex;
      if (config?.researchMode === "deep") {
        const waitForDeepResearch =
          deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
        const researchResult = await withTimeout(
          waitForDeepResearch(Runtime, logger, timeoutMs, minTurnIndex, Page, client, {
            requireScopedTargetOwner: true,
            expectedConversationId: committedPromptLocator.conversationId,
            expectedPromptTurn: committedPromptLocator,
          }),
          timeoutMs + 5_000,
          "Reattach Deep Research response timed out",
        );
        await closeAttached();
        return buildResult({
          answerText: researchResult.text,
          answerMarkdown: researchResult.text,
          runtime: liveRuntime,
          ...(recoveryWarnings ? { warnings: recoveryWarnings } : {}),
        });
      }
      const answer = await withTimeout(
        waitForResponse(
          Runtime,
          timeoutMs,
          logger,
          minTurnIndex,
          committedPromptLocator.conversationId,
          committedPromptLocator,
        ),
        timeoutMs + 5_000,
        "Reattach response timed out",
      );
      const markdown =
        (await withTimeout(
          captureMarkdown(
            Runtime,
            answer.meta,
            logger,
            committedPromptLocator.conversationId,
            committedPromptLocator,
          ),
          15_000,
          "Reattach markdown capture timed out",
        )) ?? answer.text;
      await closeAttached();
      return buildResult({
        answerText: answer.text,
        answerMarkdown: markdown,
        runtime: liveRuntime,
        ...(recoveryWarnings ? { warnings: recoveryWarnings } : {}),
      });
    } catch (error) {
      await closeAttached();
      if (
        isExplicitTargetAuthorityError(error) ||
        (error instanceof BrowserAutomationError &&
          error.details?.code === "committed-prompt-identity-mismatch")
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (explicitTabRef) {
        throw explicitTargetAuthorityError(
          explicitTabRef,
          "attach-failed",
          `Explicit browser tab ${explicitTabRef} could not be attached: ${message}`,
          error,
        );
      }
      if (!(error instanceof ClassifiedReattachError)) throw error;
      return await recover(error.classification, message, liveRuntime);
    }
  } catch (error) {
    await releaseRecoveryLock().catch((lockError) => {
      logger(
        `Failed to release recovery lock after reattach error: ${lockError instanceof Error ? lockError.message : String(lockError)}`,
      );
    });
    throw error;
  }
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  extractConversationIdFromUrl,
  buildConversationUrl,
  openConversationFromSidebar,
  finalizeRecoveredRuntime,
  refreshAttachRuntime,
  bindReattachTarget,
  recoveryCleanupGroupKey,
  defaultRecoveryLockPath,
  createOwnedRecoveryTargetConnection,
};
