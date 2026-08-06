import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import {
  publishCapturedBrowserResult,
  type CapturedResultPublicationAdapters,
} from "./capturedResultPublicationCoordinator.js";
import type { LocalBrowserAcquisition } from "./localAcquisition.js";
import type { LocalPromptExecutionResult } from "./localPromptExecution.js";
import type { LocalCapturedResponse } from "./localResponseExecution.js";
import type { LocalBrowserRunState } from "./localRunState.js";
import type { BrowserRunLifecycleController } from "./runLifecycle.js";
import type { BrowserLogger, BrowserRunOptions, BrowserRunTransaction } from "./types.js";

export interface LocalResultPublicationContext {
  acquisition: LocalBrowserAcquisition;
  state: LocalBrowserRunState;
  lifecycle: BrowserRunLifecycleController;
  prompt: LocalPromptExecutionResult;
  captured: LocalCapturedResponse;
  options: BrowserRunOptions;
  promptText: string;
  followUpPrompts: string[];
  logger: BrowserLogger;
  startedAt: number;
  buildRuntimeMetadata: (tabUrl?: string) => BrowserRuntimeMetadata;
}

function createLocalPublicationAdapters({
  state,
  prompt,
  options,
}: LocalResultPublicationContext): CapturedResultPublicationAdapters {
  const downloadAuthority = { Page: prompt.Page };
  return {
    artifactWriteAuthority: options.artifactWriteAuthority,
    imageDownloadAuthority: downloadAuthority,
    fileDownloadAuthority: downloadAuthority,
    setPendingWork: (work) => {
      state.postCapturePendingWork = work;
    },
    assertFinalLiveness: () => {
      if (state.connectionClosedUnexpectedly) {
        throw new Error("Chrome disconnected after complete answer capture");
      }
    },
  };
}

export async function publishLocalBrowserResult(
  context: LocalResultPublicationContext,
): Promise<BrowserRunTransaction> {
  const { acquisition, state, lifecycle, prompt, captured, options } = context;
  return publishCapturedBrowserResult({
    captured:
      captured.kind === "deep-research"
        ? captured
        : {
            ...captured,
            kind: "conversation",
            followUpCount: context.followUpPrompts.length,
          },
    state,
    lifecycle,
    Network: prompt.Network,
    Runtime: prompt.Runtime,
    options,
    config: acquisition.config,
    promptText: context.promptText,
    conversationUrl: state.lastUrl,
    modelSelection: state.modelSelectionEvidence,
    logger: context.logger,
    startedAt: context.startedAt,
    buildRuntimeMetadata: context.buildRuntimeMetadata,
    adapters: createLocalPublicationAdapters(context),
  });
}
