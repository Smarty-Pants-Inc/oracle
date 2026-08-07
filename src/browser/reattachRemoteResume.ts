import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { loadUserConfig } from "../config.js";
import { resumeRemoteBrowserTransaction } from "../remote/client.js";
import { resolveRemoteServiceConfig } from "../remote/remoteServiceConfig.js";
import type { BrowserLogger } from "./types.js";
import type { ReattachCapture, ReattachDeps } from "./reattachContracts.js";

export interface RemoteReattachCapture {
  capture: ReattachCapture;
  runtime: BrowserRuntimeMetadata;
}

/** Resumes the remote transaction only; settlement stays with the reattach owner. */
export async function resumeRemoteReattach(
  runtime: BrowserRuntimeMetadata,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<RemoteReattachCapture> {
  const configured = deps.recoveryCleanup?.resolveRemoteRecoveryConfig
    ? await deps.recoveryCleanup.resolveRemoteRecoveryConfig()
    : resolveRemoteServiceConfig({
        userConfig: (await loadUserConfig({ includeProject: false })).config,
        env: process.env,
      });
  const transaction = await (deps.resumeRemoteBrowserTransaction ?? resumeRemoteBrowserTransaction)(
    {
      runtime,
      configuredHost: configured.host ?? "",
      authToken: configured.token,
      sessionId: deps.sessionId,
      log: logger,
      runtimeHintCb: deps.runtimeHintCb,
    },
  );
  return {
    capture: {
      ...transaction,
      finalizeResources: transaction.finalize,
      abortResources: transaction.abort,
    },
    runtime: transaction.runtime,
  };
}
