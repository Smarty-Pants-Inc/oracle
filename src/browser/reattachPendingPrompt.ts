import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import { promptIdentitySha256 } from "./actions/committedPrompt.js";
import { clearPromptComposer } from "./pageActions.js";
import { geminiDeepThinkDomProvider } from "./providers/geminiDeepThinkDomProvider.js";
import { chatgptDomProvider } from "./providers/chatgptDomProvider.js";
import { runProviderSubmissionFlow } from "./providerDomFlow.js";
import { finalizeRecoveredRuntime } from "./reattachCleanup.js";
import type { ReattachDeps } from "./reattachContracts.js";
import { pendingPromptRecoveryError, reattachPlanPromptLocator } from "./reattachPlan.js";
import type { ReattachPlan } from "./reattachPlan.js";
import type { CommittedPromptEpochLocator } from "./reattachability.js";
import { BrowserRunLifecycleController } from "./runLifecycle.js";
import type { SessionBoundChromeClient } from "./chromeSessionTransport.js";
import type { BrowserLogger } from "./types.js";
import { delay } from "./utils.js";

export interface PendingPromptReconciliation {
  runtime: BrowserRuntimeMetadata;
  promptLocator: CommittedPromptEpochLocator;
  promptCommitPersistencePending: boolean;
}

export async function reconcilePendingReattachPrompt(
  plan: Extract<ReattachPlan, { kind: "pending-prompt" }>,
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  client: SessionBoundChromeClient,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<PendingPromptReconciliation> {
  const { Runtime, Input } = client;
  const replayPrompt =
    deps.pendingPromptCandidates?.find(
      (candidate) => promptIdentitySha256(candidate) === plan.authority.epoch.promptSha256,
    ) ?? null;
  const hashAuthorized =
    replayPrompt !== null ||
    deps.pendingPromptSha256Authorities?.includes(plan.authority.epoch.promptSha256) === true;
  if (!hashAuthorized) {
    throw pendingPromptRecoveryError(
      runtime,
      "the persisted prompt hash is not authorized by the recovering session request",
    );
  }
  if (!deps.runtimeHintCb) {
    throw pendingPromptRecoveryError(
      runtime,
      "no durable runtime writer is available for committed authority promotion",
    );
  }
  const provider =
    deps.pendingPromptProvider ??
    (plan.capture === "gemini" ? geminiDeepThinkDomProvider : chatgptDomProvider);
  if (!provider.reconcilePendingPrompt) {
    throw pendingPromptRecoveryError(
      runtime,
      `${provider.providerName} does not expose pending prompt reconciliation`,
    );
  }
  const providerState: Record<string, unknown> =
    plan.capture === "gemini"
      ? {
          inputTimeoutMs: config?.inputTimeoutMs,
          timeoutMs: config?.timeoutMs,
          geminiConversationId: plan.authority.targetId,
        }
      : {
          runtime: Runtime,
          input: Input,
          logger,
          timeoutMs: config?.timeoutMs ?? 120_000,
          inputTimeoutMs: config?.inputTimeoutMs,
          attachmentTimeoutMs: config?.attachmentTimeoutMs,
          baselineTurns: plan.authority.epoch.baselineTurns,
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
      promptSha256: plan.authority.epoch.promptSha256,
      baselineTurns: plan.authority.epoch.baselineTurns,
      ...(plan.capture === "gemini"
        ? { conversationId: plan.authority.targetId }
        : plan.authority.conversationId
          ? { conversationId: plan.authority.conversationId }
          : {}),
    },
  );
  if (reconciliation.status === "ambiguous") {
    throw pendingPromptRecoveryError(runtime, reconciliation.reason);
  }
  const recoveredPrompt =
    reconciliation.status === "committed" ? reconciliation.prompt : replayPrompt;
  if (!recoveredPrompt) {
    throw pendingPromptRecoveryError(
      runtime,
      "non-commit was proven but the exact session prompt is unavailable for replay",
    );
  }

  let liveRuntime = runtime;
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
    await lifecycle.recordPromptCommitVerification(reconciliation.verification, epochIdentity);
  } else {
    logger("Pending prompt epoch was definitively not submitted; replaying it once.");
    if (provider === chatgptDomProvider) await clearPromptComposer(Runtime, logger);
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
  const promptCommitPersistencePending = lifecycle.hasPendingPromptAuthorityJournal();
  liveRuntime = lifecycle.runtime(liveRuntime);
  return {
    runtime: liveRuntime,
    promptLocator: reattachPlanPromptLocator(liveRuntime, config, plan.capture),
    promptCommitPersistencePending,
  };
}
