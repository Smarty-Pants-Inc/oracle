import { runApiSession } from "./apiSessionRun.js";
import { runBrowserSession } from "./browserSessionRun.js";
import {
  MonotonicBrowserRuntimeAuthority,
  retryableInitialBrowserRuntime,
} from "./browserRuntimeAuthority.js";
import { runMultiModelSession } from "./multiModelSessionRun.js";
import { deriveNotificationSettingsFromMetadata } from "./notifier.js";
import { handleSessionRunFailure } from "./sessionRunFailure.js";
import type { SessionRunContext, SessionRunParams, SessionRunState } from "./sessionRunTypes.js";
import { sessionStore } from "../sessionStore.js";

export async function performSessionRun(params: SessionRunParams): Promise<void> {
  const {
    sessionMeta,
    runOptions,
    mode,
    browserConfig,
    cwd,
    log,
    write,
    version,
    notifications,
    browserDeps,
    muteStdout = false,
  } = params;
  const restartCandidateRuntime = sessionMeta.browser?.runtime;
  const retainedInitialRuntime = browserConfig
    ? retryableInitialBrowserRuntime(restartCandidateRuntime, browserConfig)
    : undefined;
  const state: SessionRunState = {
    currentBrowser: browserConfig
      ? {
          config: browserConfig,
          ...(retainedInitialRuntime ? { runtime: retainedInitialRuntime } : {}),
        }
      : sessionMeta.browser,
    runtimeAuthority: new MonotonicBrowserRuntimeAuthority(retainedInitialRuntime, browserConfig),
    durableAnswerReceipt: undefined,
    browserPublicationCompleted: false,
    restartCandidateRuntime,
  };
  await sessionStore.updateSession(sessionMeta.id, {
    status: "running",
    startedAt: new Date().toISOString(),
    mode,
    ...(browserConfig ? { browser: state.currentBrowser } : {}),
  });
  const context: SessionRunContext = {
    sessionMeta,
    runOptions,
    mode,
    browserConfig,
    cwd,
    log,
    write,
    version,
    browserDeps,
    muteStdout,
    notificationSettings:
      notifications ?? deriveNotificationSettingsFromMetadata(sessionMeta, process.env),
    modelForStatus: runOptions.model ?? sessionMeta.model,
  };

  try {
    if (mode === "browser") {
      return await runBrowserSession(context, state);
    }
    const multiModels = Array.isArray(runOptions.models) ? runOptions.models.filter(Boolean) : [];
    if (multiModels.length > 1) {
      return await runMultiModelSession(context, multiModels);
    }
    return await runApiSession(context, multiModels[0]);
  } catch (error) {
    return await handleSessionRunFailure(context, state, error);
  }
}
