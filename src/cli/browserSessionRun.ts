import path from "node:path";

import { appendArtifacts } from "../browser/artifacts.js";
import { retainChromeEndpointAuthority } from "../browser/chromeLifecycle.js";
import { isProcessAlive } from "../browser/chromeProcessIdentity.js";
import { settleBrowserRecoveryCleanup } from "../browser/reattach.js";
import {
  hasExactPendingChromeAcquisitionAuthority,
  hasPendingChromeAcquisitionIntent,
} from "../browser/reattachability.js";
import {
  ensureSessionArtifacts,
  runBrowserSessionExecution,
  type BrowserPreArchiveCapture,
} from "../browser/sessionRunner.js";
import type { BrowserCaptureFinalizationResult, BrowserLogger } from "../browser/types.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserModelSelectionEvidence, BrowserRuntimeMetadata } from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";
import { hasBrowserRecoveryAuthority } from "./browserRuntimeAuthority.js";
import {
  BrowserPublicationTransaction,
  persistDurableBrowserAnswer,
  publishCompletedBrowserCapture,
} from "./durableAnswer.js";
import { formatError } from "./errorUtils.js";
import { sendSessionNotification } from "./notifier.js";
import { createBrowserLogger, dim, writeAssistantOutput } from "./sessionRunSupport.js";
import type { SessionRunContext, SessionRunState } from "./sessionRunTypes.js";

export async function runBrowserSession(
  context: SessionRunContext,
  state: SessionRunState,
): Promise<void> {
  const { sessionMeta, runOptions, browserConfig, cwd, log, notificationSettings, browserDeps } =
    context;
  await settleCleanupOnlyRestart(context, state);
  if (!browserConfig) {
    throw new Error("Missing browser configuration for session.");
  }
  const modelForStatus = context.modelForStatus;
  if (modelForStatus) {
    await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
      status: "running",
      startedAt: new Date().toISOString(),
    });
  }
  const publicationTransaction = new BrowserPublicationTransaction();
  const runnerDeps = {
    ...browserDeps,
    persistRuntimeHint: async (
      runtime: BrowserRuntimeMetadata,
      modelSelection?: BrowserModelSelectionEvidence,
    ) => {
      const authoritativeRuntime = state.runtimeAuthority.observeHint(runtime);
      const browser = {
        config: browserConfig,
        runtime: authoritativeRuntime,
        ...(modelSelection ? { modelSelection } : {}),
      };
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        browser,
      });
      state.currentBrowser = browser;
    },
    persistPreArchiveCapture: async ({ result, runtime, usage }: BrowserPreArchiveCapture) => {
      const authoritativeRuntime = state.runtimeAuthority.observeHint(runtime);
      const browser = {
        config: browserConfig,
        runtime: authoritativeRuntime,
        ...(result.modelSelection ? { modelSelection: result.modelSelection } : {}),
      };
      const receipt = await publicationTransaction.prepareDurableCapture({
        answer: {
          sessionId: sessionMeta.id,
          answer: result.answerMarkdown || result.answerText,
        },
        runtime: authoritativeRuntime,
        browser,
        existingArtifacts: appendArtifacts(sessionMeta.artifacts, result.artifacts ?? []),
        usage,
        elapsedMs: result.tookMs,
        response: { status: "completed" },
        model: modelForStatus,
        persistAnswer: persistDurableBrowserAnswer,
        projectRuntime: (candidate) => state.runtimeAuthority.observeHint(candidate),
      });
      state.currentBrowser = browser;
      state.durableAnswerReceipt = receipt;
    },
  };
  const result = await runBrowserSessionExecution(
    {
      runOptions: { ...runOptions, sessionId: runOptions.sessionId ?? sessionMeta.id },
      browserConfig,
      cwd,
      log,
    },
    runnerDeps,
  );
  const resultRuntime = state.runtimeAuthority.observeHint(result.runtime);
  state.currentBrowser = {
    config: browserConfig,
    runtime: resultRuntime,
    archive: result.archive,
    modelSelection: result.modelSelection,
    warnings: result.warnings,
  };
  const publication = await publishCompletedBrowserCapture({
    answer: {
      sessionId: sessionMeta.id,
      answer: result.answerText,
    },
    transaction: result,
    browser: state.currentBrowser ?? {
      config: browserConfig,
      runtime: resultRuntime,
    },
    existingArtifacts: sessionMeta.artifacts,
    prepareArtifacts: async () =>
      ensureSessionArtifacts({
        sessionId: sessionMeta.id,
        prompt: result.promptText ?? runOptions.prompt,
        answerMarkdown: result.answerText,
        conversationUrl: resultRuntime.tabUrl,
        browserConfig,
        existingArtifacts: appendArtifacts(sessionMeta.artifacts, result.artifacts ?? []),
        logger: createBrowserLogger(log),
      }),
    usage: result.usage,
    response: { status: "completed" },
    elapsedMs: result.elapsedMs,
    model: modelForStatus,
    label: "Browser answer",
    log: (message) => log(dim(message)),
    persistAnswer: persistDurableBrowserAnswer,
    projectRuntime: (runtime) => {
      const authoritativeRuntime = state.runtimeAuthority.observeHint(runtime);
      state.currentBrowser = {
        ...(state.currentBrowser ?? { config: browserConfig }),
        config: browserConfig,
        runtime: authoritativeRuntime,
      };
      return authoritativeRuntime;
    },
    publication: publicationTransaction,
  });

  state.durableAnswerReceipt = publication.receipt;
  state.currentBrowser = {
    ...(state.currentBrowser ?? { config: browserConfig }),
    config: browserConfig,
    runtime: publication.finalization.runtime,
  };
  state.browserPublicationCompleted = true;
  if (publication.projection.status === "pending") {
    log(
      dim(
        `Browser answer is durable; terminal session/model projection remains pending for retry: ${publication.projection.error}`,
      ),
    );
  } else if (publication.finalization.status === "pending") {
    log(dim("Browser cleanup remains pending; saved the answer and cleanup authority for retry."));
  } else if (publication.finalizationPersistence.status === "pending") {
    log(
      dim(
        `Browser answer is published; cleanup authority projection remains pending for retry: ${publication.finalizationPersistence.error}`,
      ),
    );
  }
  await writeAssistantOutput(runOptions.writeOutputPath, result.answerText, log);
  await sendSessionNotification(
    {
      sessionId: sessionMeta.id,
      sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
      mode: context.mode,
      model: sessionMeta.model ?? runOptions.model,
      usage: result.usage,
      characters: result.answerText.length,
    },
    notificationSettings,
    log,
    result.answerText.slice(0, 140),
  ).catch((error) => {
    log(dim(`Browser answer published; notification failed: ${formatError(error)}`));
  });
}

async function settleCleanupOnlyRestart(
  context: SessionRunContext,
  state: SessionRunState,
): Promise<void> {
  const { sessionMeta, browserConfig, log } = context;
  const restartRuntime = state.restartCandidateRuntime;
  const restartControllerAlive = restartRuntime?.controllerPid
    ? isProcessAlive(restartRuntime.controllerPid)
    : false;
  const restartWorkerAlive = sessionMeta.lifecycle?.workerPid
    ? isProcessAlive(sessionMeta.lifecycle.workerPid)
    : false;
  const staleRestartLifecycle =
    (sessionMeta.status === "running" || sessionMeta.status === "error") &&
    !restartControllerAlive &&
    !restartWorkerAlive;
  const hasCleanupOnlyRestart =
    staleRestartLifecycle &&
    Boolean(
      restartRuntime?.recoveryCleanupResources?.length && restartRuntime.recoveryCleanupResult,
    ) &&
    !hasBrowserRecoveryAuthority(restartRuntime, browserConfig);
  if (!hasCleanupOnlyRestart || !restartRuntime) return;
  if (
    hasPendingChromeAcquisitionIntent(restartRuntime) &&
    !hasExactPendingChromeAcquisitionAuthority(restartRuntime)
  ) {
    throw new BrowserAutomationError(
      "Refusing browser restart because pending Chrome acquisition authority is incomplete or malformed.",
      {
        stage: "browser-acquisition-recovery",
        code: "browser-acquisition-authority-invalid",
        runtime: restartRuntime,
      },
    );
  }
  const recoveryLogger = Object.assign(
    ((message?: string) => {
      if (message) log(dim(message));
    }) as BrowserLogger,
    { verbose: true },
  );
  const sessionPaths = await sessionStore.getPaths(sessionMeta.id);
  const recoveryMode = restartRuntime.recoveryCleanupResult?.settlementMode ?? "abort";
  const persistRecovery = async (result: BrowserCaptureFinalizationResult) => {
    await sessionStore.updateSession(sessionMeta.id, {
      browser: {
        ...state.currentBrowser,
        ...(browserConfig ? { config: browserConfig } : {}),
        runtime: result.runtime,
      },
    });
    return result;
  };
  const recovery = await settleBrowserRecoveryCleanup(
    restartRuntime,
    recoveryLogger,
    {
      ownerId: sessionMeta.id,
      recoveryLockPath: path.join(sessionPaths.dir, "browser-recovery.lock"),
      recoveryCleanup: {
        retainChromeEndpointAuthority,
        resolveRemoteRecoveryConfig: context.browserDeps?.resolveRemoteRecoveryConfig,
      },
      isRemotePublicationAcknowledged: () => false,
      loadRuntimeUnderLock: async () =>
        (await sessionStore.readSession(sessionMeta.id))?.browser?.runtime ?? restartRuntime,
      persistFinalizationResult: persistRecovery,
      completeFinalizationAfterLockRelease: persistRecovery,
    },
    recoveryMode,
  );
  const recoveryRuntime =
    recovery.persistence.status === "pending"
      ? recovery.persistence.runtime
      : recovery.finalization.runtime;
  const recoveredRuntime =
    state.runtimeAuthority.observeTerminal(recoveryRuntime) ?? recoveryRuntime;
  state.currentBrowser = {
    ...state.currentBrowser,
    ...(browserConfig ? { config: browserConfig } : {}),
    runtime: recoveredRuntime,
  };
  if (recovery.persistence.status === "pending") {
    throw new BrowserAutomationError(
      `Browser acquisition cleanup remains pending: ${recovery.persistence.error}`,
      {
        stage: "browser-acquisition-recovery",
        code: "browser-acquisition-cleanup-pending",
        runtime: recoveredRuntime,
      },
    );
  }
  if (recovery.finalization.status === "pending") {
    throw new BrowserAutomationError(
      `Browser acquisition cleanup remains pending: ${recovery.finalization.error}`,
      {
        stage: "browser-acquisition-recovery",
        code: "browser-acquisition-cleanup-pending",
        runtime: recoveredRuntime,
      },
    );
  }
}
