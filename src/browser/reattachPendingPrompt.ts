import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import { promptIdentitySha256 } from "./actions/committedPrompt.js";
import { clearPromptComposer } from "./pageActions.js";
import {
  createGeminiDeepThinkDomProviderState,
  geminiDeepThinkDomProvider,
} from "./providers/geminiDeepThinkDomProvider.js";
import {
  chatgptDomProvider,
  createChatgptDomProviderState,
} from "./providers/chatgptDomProvider.js";
import {
  runProviderSubmissionFlow,
  type ProviderDomAdapter,
  type ProviderDomProviderId,
  type ProviderDomResponse,
  type ProviderDomState,
} from "./providerDomFlow.js";
import { finalizeRecoveredRuntime } from "./reattachCleanup.js";
import type { ReattachDeps } from "./reattachContracts.js";
import { pendingPromptRecoveryError, reattachPlanPromptLocator } from "./reattachPlan.js";
import type { PendingPromptReattachPlan } from "./reattachPlan.js";
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

interface PendingProviderBinding<
  Provider extends ProviderDomProviderId,
  State extends ProviderDomState<Provider>,
  Response extends ProviderDomResponse,
> {
  capture: Provider;
  adapter: ProviderDomAdapter<State, Response>;
  state: State;
  prepareReplay?: () => Promise<void>;
}

async function reconcileWithPendingProvider<
  Provider extends ProviderDomProviderId,
  State extends ProviderDomState<Provider>,
  Response extends ProviderDomResponse,
>(
  plan: Extract<PendingPromptReattachPlan, { capture: Provider }>,
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps,
  replayPrompt: string | null,
  evaluate: <T>(expression: string) => Promise<T | undefined>,
  binding: PendingProviderBinding<Provider, State, Response>,
): Promise<PendingPromptReconciliation> {
  const provider = binding.adapter;
  if (provider.provider !== binding.capture || binding.state.provider !== binding.capture) {
    throw pendingPromptRecoveryError(
      runtime,
      `${provider.providerName} is not bound to ${binding.capture} recovery state`,
    );
  }
  if (!provider.reconcilePendingPrompt) {
    throw pendingPromptRecoveryError(
      runtime,
      `${provider.providerName} does not expose pending prompt reconciliation`,
    );
  }
  const reconciliation = await provider.reconcilePendingPrompt(
    { evaluate, delay, log: logger, state: binding.state },
    {
      promptSha256: plan.authority.epoch.promptSha256,
      baselineTurns: plan.authority.epoch.baselineTurns,
      ...(binding.capture === "gemini"
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
    await binding.prepareReplay?.();
    const evidence = await runProviderSubmissionFlow(provider, {
      prompt: recoveredPrompt,
      evaluate,
      delay,
      log: logger,
      state: binding.state,
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
    promptLocator: reattachPlanPromptLocator(liveRuntime, config, binding.capture),
    promptCommitPersistencePending,
  };
}

export async function reconcilePendingReattachPrompt(
  plan: PendingPromptReattachPlan,
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

  if (plan.capture === "gemini") {
    return await reconcileWithPendingProvider(
      plan,
      runtime,
      config,
      logger,
      deps,
      replayPrompt,
      evaluate,
      {
        capture: "gemini",
        adapter: deps.pendingPromptProviders?.gemini ?? geminiDeepThinkDomProvider,
        state: createGeminiDeepThinkDomProviderState({
          inputTimeoutMs: config?.inputTimeoutMs,
          timeoutMs: config?.timeoutMs,
          geminiConversationId: plan.authority.targetId,
        }),
      },
    );
  }

  return await reconcileWithPendingProvider(
    plan,
    runtime,
    config,
    logger,
    deps,
    replayPrompt,
    evaluate,
    {
      capture: "chatgpt",
      adapter: deps.pendingPromptProviders?.chatgpt ?? chatgptDomProvider,
      state: createChatgptDomProviderState({
        runtime: Runtime,
        input: Input,
        logger,
        timeoutMs: config?.timeoutMs ?? 120_000,
        inputTimeoutMs: config?.inputTimeoutMs,
        attachmentTimeoutMs: config?.attachmentTimeoutMs,
        baselineTurns: plan.authority.epoch.baselineTurns,
      }),
      prepareReplay: () => clearPromptComposer(Runtime, logger),
    },
  );
}
