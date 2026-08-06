import {
  publishCapturedBrowserResult,
  type CapturedBrowserResult,
  type CapturedResultPublicationAdapters,
} from "./capturedResultPublicationCoordinator.js";
import { isLocalChromeHost } from "./promptSubmissionCoordinator.js";
import type { CommittedPromptEpochLocator } from "./reattachability.js";
import type { BrowserRunTransaction } from "./types.js";
import type { RemoteBrowserExecutionContext } from "./remoteExecutionContext.js";
import type { RemoteBrowserTarget } from "./remoteTargetAcquisition.js";

export interface RemoteDeepResearchCapture {
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
}

export interface RemoteConversationCapture {
  answerText: string;
  answerMarkdown: string;
  answerHtml: string;
  promptLocator: CommittedPromptEpochLocator;
}

function createRemotePublicationAdapters(
  context: RemoteBrowserExecutionContext,
  target: RemoteBrowserTarget,
): CapturedResultPublicationAdapters {
  const downloadAuthority = { Page: target.Page };
  return {
    artifactWriteAuthority: undefined,
    imageDownloadAuthority: isLocalChromeHost(context.host) ? downloadAuthority : null,
    fileDownloadAuthority: downloadAuthority,
    setPendingWork: (work) => {
      context.postCapturePendingWork = work;
    },
    assertFinalLiveness: () => {
      if (context.connectionClosedUnexpectedly) {
        throw new Error("Remote Chrome disconnected after complete answer capture");
      }
    },
  };
}

async function publishRemoteCapturedBrowserResult(
  context: RemoteBrowserExecutionContext,
  target: RemoteBrowserTarget,
  captured: CapturedBrowserResult,
): Promise<BrowserRunTransaction> {
  const transaction = await publishCapturedBrowserResult({
    captured,
    state: context,
    lifecycle: context.lifecycle,
    Network: target.Network,
    Runtime: target.Runtime,
    options: context.options,
    config: context.config,
    promptText: context.promptText,
    conversationUrl: context.lastUrl,
    modelSelection: context.modelSelectionEvidence,
    logger: context.logger,
    startedAt: context.startedAt,
    buildRuntimeMetadata: context.buildRuntimeMetadata,
    adapters: createRemotePublicationAdapters(context, target),
  });
  context.retainRemoteConnectionForSettlement =
    context.lifecycle.hasPendingPromptAuthorityJournal();
  return transaction;
}

export function publishRemoteDeepResearchCapture(
  context: RemoteBrowserExecutionContext,
  target: RemoteBrowserTarget,
  expectedPromptTurn: CommittedPromptEpochLocator,
  researchResult: RemoteDeepResearchCapture,
): Promise<BrowserRunTransaction> {
  return publishRemoteCapturedBrowserResult(context, target, {
    kind: "deep-research",
    promptLocator: expectedPromptTurn,
    answerText: researchResult.text,
    answerMarkdown: researchResult.text,
    answerHtml: researchResult.html,
  });
}

export function publishRemoteConversationCapture(
  context: RemoteBrowserExecutionContext,
  target: RemoteBrowserTarget,
  capture: RemoteConversationCapture,
): Promise<BrowserRunTransaction> {
  return publishRemoteCapturedBrowserResult(context, target, {
    kind: "conversation",
    ...capture,
    followUpCount: context.followUpPrompts.length,
  });
}
