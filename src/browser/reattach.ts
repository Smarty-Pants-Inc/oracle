import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserLogger } from "./types.js";
import { adaptDirectTargetChromeClient } from "./chromeSessionTransport.js";
import type { SessionBoundChromeClient } from "./chromeSessionTransport.js";
import { connectToRemoteChromeTarget, listRemoteChromeTargets } from "./chromeLifecycle.js";
import { acquireReattachRecoveryLock } from "./reattachLock.js";
import type { ReattachRecoveryLock } from "./reattachLock.js";
import {
  defaultRecoveryLockPath,
  finalizeRecoveredRuntime,
  recoveryCleanupGroupKey,
} from "./reattachCleanup.js";
export type { ReattachCleanupDeps, ReattachFinalizationResult } from "./reattachCleanup.js";
import { inferPortFromBrowserWSEndpoint } from "./reattachRuntime.js";
import {
  assertSameCommittedPromptEpoch,
  createOwnedRecoveryTargetConnection,
  resumeBrowserSessionViaNewChrome,
} from "./reattachAcquisition.js";
import type { ReattachCapture, ReattachDeps, ReattachResult } from "./reattachContracts.js";
export type { ReattachCapture, ReattachDeps, ReattachResult } from "./reattachContracts.js";
import type { ExplicitTargetSelectionFailure } from "./reattachTargetSelection.js";
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
import {
  buildConversationUrl,
  extractConversationIdFromUrl,
  openConversationFromSidebar,
} from "./reattachHelpers.js";
import type { TargetInfoLite } from "./reattachHelpers.js";
import { resolvePendingPromptEpochAuthority } from "./reattachability.js";
import { captureCommittedChatGptReattach } from "./reattachChatGptCapture.js";
import { captureCommittedGeminiReattach } from "./reattachGeminiCapture.js";
import { reconcilePendingReattachPrompt } from "./reattachPendingPrompt.js";
import {
  assertSamePendingPromptAuthority,
  ClassifiedReattachError,
  classifyReattachFailure,
  createCommittedReattachPlan,
  createReattachPlan,
  explicitTargetAuthorityError,
  isExplicitTargetAuthorityError,
  isGeminiAppUrl,
  pendingPromptRecoveryError,
  reattachCaptureKind,
  reattachPlanPromptLocator,
  selectReattachPlanTarget,
} from "./reattachPlan.js";
import type { ReattachPlan, ReattachRecoveryClassification } from "./reattachPlan.js";
import { resumeRemoteReattach } from "./reattachRemoteResume.js";

export async function resumeBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps = {},
): Promise<ReattachResult> {
  const explicitTabRef = config?.browserTabRef?.trim() || undefined;
  const captureKind = reattachCaptureKind(config);
  let plan: ReattachPlan = createReattachPlan(runtime, config, deps.sessionId, captureKind);
  let promptLocator =
    plan.kind === "remote" || plan.kind === "committed-gemini" || plan.kind === "committed-chatgpt"
      ? plan.promptLocator
      : null;
  const lockPath = deps.recoveryLockPath ?? (await defaultRecoveryLockPath(runtime));
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
      { ensure: ensureRecoveryLock, release: releaseRecoveryLock },
      (candidate) => reattachPlanPromptLocator(candidate, config, captureKind),
    );
  const recover = async (
    classification: ReattachRecoveryClassification,
    reason: string,
    authoritativeRuntime: BrowserRuntimeMetadata = runtime,
  ): Promise<ReattachResult> => {
    if (plan.kind === "pending-prompt") {
      throw pendingPromptRecoveryError(
        authoritativeRuntime,
        `the exact retained target cannot be replaced after ${classification}: ${reason}`,
      );
    }
    if (captureKind === "gemini") {
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
    return buildResult(await recoverSession(authoritativeRuntime, config), authoritativeRuntime);
  };

  try {
    if (plan.kind === "remote") {
      const remote = await resumeRemoteReattach(runtime, logger, deps);
      return buildResult(remote.capture, remote.runtime);
    }
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
      if (plan.kind === "pending-prompt") {
        assertSamePendingPromptAuthority(
          plan.authority,
          resolvePendingPromptEpochAuthority(liveRuntime, deps.sessionId?.trim()),
          liveRuntime,
        );
      } else if (promptLocator) {
        assertSameCommittedPromptEpoch(
          promptLocator,
          reattachPlanPromptLocator(liveRuntime, config, captureKind),
        );
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
      const selection = selectReattachPlanTarget(plan, targetList, liveRuntime, explicitTabRef);
      if (
        selection.status === "selected" &&
        plan.kind === "pending-prompt" &&
        plan.capture === "gemini" &&
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
        if (plan.kind === "pending-prompt") {
          throw pendingPromptRecoveryError(
            liveRuntime,
            `the exact retained target is ${selection.status}`,
          );
        }
        if (plan.kind === "committed-gemini") {
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
      let promptCommitPersistencePending = false;
      if (plan.kind === "pending-prompt") {
        const reconciliation = await reconcilePendingReattachPrompt(
          plan,
          liveRuntime,
          config,
          client,
          logger,
          deps,
        );
        liveRuntime = reconciliation.runtime;
        promptLocator = reconciliation.promptLocator;
        promptCommitPersistencePending = reconciliation.promptCommitPersistencePending;
        plan = createCommittedReattachPlan(plan.capture, promptLocator);
      }
      if (!promptLocator) {
        throw pendingPromptRecoveryError(
          liveRuntime,
          "reconciliation did not produce committed prompt authority",
        );
      }
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
      const capture =
        plan.kind === "committed-gemini"
          ? await captureCommittedGeminiReattach(
              liveRuntime,
              config,
              client,
              promptLocator,
              targetId,
              logger,
              recoveryWarnings,
            )
          : await captureCommittedChatGptReattach(
              liveRuntime,
              runtime,
              config,
              client,
              promptLocator,
              targetId,
              logger,
              deps,
              recoveryWarnings,
            );
      await closeAttached();
      return buildResult(capture, liveRuntime);
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
