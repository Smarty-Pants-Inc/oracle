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
import type { BrowserLogger, ChromeClient } from "./types.js";
import { connectToRemoteChromeTarget, listRemoteChromeTargets } from "./chromeLifecycle.js";
import { resolveBrowserConfig } from "./config.js";
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
} from "./reattachTargetSelection.js";
import {
  exactOwnedTargetGeneration,
  reconcileReattachTargetAuthority,
  refreshAttachRuntime,
} from "./reattachTargetAuthority.js";
import { createReattachSettlement } from "./reattachSettlement.js";
export { retryBrowserRecoveryCleanup } from "./reattachSettlement.js";

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

export async function resumeBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps = {},
): Promise<ReattachResult> {
  const explicitTabRef = config?.browserTabRef?.trim() || undefined;
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
  const releaseRecoveryLock = async (): Promise<void> => {
    const heldLock = recoveryLock;
    if (!heldLock) return;
    await heldLock.release();
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
      const selection = selectTarget(targetList, liveRuntime, explicitTabRef);
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
