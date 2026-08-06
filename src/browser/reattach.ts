import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { loadUserConfig } from "../config.js";
import { resumeRemoteBrowserTransaction } from "../remote/client.js";
import { resolveRemoteServiceConfig } from "../remote/remoteServiceConfig.js";
import {
  waitForAssistantResponse,
  captureAssistantMarkdown,
  waitForResumedConversationHydration,
  verifyCommittedPromptTurn,
} from "./pageActions.js";
import { recoverCommittedGeminiDeepThinkResponse } from "./providers/geminiDeepThinkDomProvider.js";
import type { BrowserLogger, ChromeClient } from "./types.js";
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
import { waitForDeepResearchCompletion } from "./actions/deepResearch.js";
import {
  defaultRecoveryLockPath,
  finalizeRecoveredRuntime,
  recoveryCleanupGroupKey,
} from "./reattachCleanup.js";
import { inferPortFromBrowserWSEndpoint } from "./reattachRuntime.js";
import { findRemoteRecoveryAuthority } from "./reattachability.js";
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
  pickTarget,
  selectTarget,
  type ExplicitTargetSelectionFailure,
  type TargetSelection,
} from "./reattachTargetSelection.js";
import {
  exactOwnedTargetGeneration,
  reconcileReattachTargetAuthority,
  refreshAttachRuntime,
} from "./reattachTargetAuthority.js";
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

export async function resumeBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps = {},
): Promise<ReattachResult> {
  const explicitTabRef = config?.browserTabRef?.trim() || undefined;
  const geminiDeepThinkRecovery =
    resolveGeminiWebModel(config?.desiredModel) === "gemini-3-pro-deep-think";
  const initialRemoteRecovery = findRemoteRecoveryAuthority(runtime);
  if (initialRemoteRecovery && explicitTabRef) {
    throw explicitTargetAuthorityError(
      explicitTabRef,
      "unsupported",
      `Explicit browser tab ${explicitTabRef} cannot be combined with remote transaction recovery because the remote protocol cannot carry exact tab authority.`,
    );
  }
  const promptLocator =
    initialRemoteRecovery && !runtime.promptEpoch
      ? null
      : requireCommittedPromptEpochLocator(runtime);
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
    createReattachSettlement(capture, authoritativeRuntime, promptLocator, logger, deps, {
      ensure: ensureRecoveryLock,
      release: releaseRecoveryLock,
    });

  const recover = async (
    classification: ReattachRecoveryClassification,
    reason: string,
    authoritativeRuntime: BrowserRuntimeMetadata = runtime,
  ): Promise<ReattachResult> => {
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
        log: logger,
        runtimeHintCb: deps.runtimeHintCb,
      });
      return buildResult(
        {
          answerText: transaction.answerText,
          answerMarkdown: transaction.answerMarkdown,
          runtime: transaction.runtime,
          finalizeResources: transaction.finalize,
          abortResources: transaction.abort,
        },
        transaction.runtime,
      );
    }
    if (!promptLocator) {
      throw new BrowserAutomationError(
        "Local browser reattach requires a committed prompt epoch.",
        { stage: "prompt-epoch", code: "committed-prompt-identity-mismatch" },
      );
    }
    const promptEpoch = promptLocator.epoch;
    const minAssistantTurnIndex = promptLocator.verifiedUserTurnIndex + 1;
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
      const livePromptLocator = requireCommittedPromptEpochLocator(liveRuntime);
      assertSameCommittedPromptEpoch(promptLocator, livePromptLocator);
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
      const selection = geminiDeepThinkRecovery
        ? selectGeminiRecoveryTarget(targetList, liveRuntime, explicitTabRef)
        : selectTarget(targetList, liveRuntime, explicitTabRef);
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
      const reconciledTarget = reconcileReattachTargetAuthority(liveRuntime, targetId);
      liveRuntime = reconciledTarget.runtime;
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
                return { client, close: () => client.close() };
              })()
            : await connectToRemoteChromeTarget(host, port ?? 9222, logger, {
                browserWSEndpoint,
                targetId,
                closeTargetOnDispose: false,
              }),
      );
      closeAttachedConnection = () => connection.close();

      const client: ChromeClient = connection.client;
      const { Runtime, DOM, Page } = client;
      await classifyReattachFailure(
        "recoverable-transport",
        `Chrome target ${targetId} disconnected while enabling DevTools domains.`,
        async () => {
          if (Runtime?.enable) await Runtime.enable();
          if (DOM && typeof DOM.enable === "function") await DOM.enable();
          if (Page && typeof Page.enable === "function") await Page.enable();
        },
      );
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
            promptLocator,
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
        if (extractRecoverableConversationId(href) === promptEpoch.conversationId) return;
        const opened = await openConversationFromSidebarWithRetry(
          Runtime,
          {
            conversationId: promptEpoch.conversationId,
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
        promptEpoch.conversationId,
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
      await verifyPromptTurn(Runtime, promptLocator);
      const minTurnIndex = minAssistantTurnIndex;
      if (config?.researchMode === "deep") {
        const waitForDeepResearch =
          deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
        const researchResult = await withTimeout(
          waitForDeepResearch(Runtime, logger, timeoutMs, minTurnIndex, Page, client, {
            requireScopedTargetOwner: true,
            expectedConversationId: promptLocator.conversationId,
            expectedPromptTurn: promptLocator,
          }),
          timeoutMs + 5_000,
          "Reattach Deep Research response timed out",
        );
        await closeAttached();
        return buildResult({
          answerText: researchResult.text,
          answerMarkdown: researchResult.text,
          runtime: liveRuntime,
        });
      }
      const answer = await withTimeout(
        waitForResponse(
          Runtime,
          timeoutMs,
          logger,
          minTurnIndex,
          promptLocator.conversationId,
          promptLocator,
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
            promptLocator.conversationId,
            promptLocator,
          ),
          15_000,
          "Reattach markdown capture timed out",
        )) ?? answer.text;
      await closeAttached();
      return buildResult({
        answerText: answer.text,
        answerMarkdown: markdown,
        runtime: liveRuntime,
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
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  openConversationFromSidebar,
  finalizeRecoveredRuntime,
  refreshAttachRuntime,
  reconcileReattachTargetAuthority,
  exactOwnedTargetGeneration,
  recoveryCleanupGroupKey,
  defaultRecoveryLockPath,
  createOwnedRecoveryTargetConnection,
};
