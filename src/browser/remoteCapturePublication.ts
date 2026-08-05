import { estimateTokenCount } from "./utils.js";
import {
  appendArtifacts,
  saveBrowserTranscriptArtifact,
  saveDeepResearchReportArtifact,
} from "./artifacts.js";
import { collectGeneratedImageArtifacts } from "./chatgptImages.js";
import { collectChatGptFileArtifacts } from "./chatgptFiles.js";
import { throwChatGptUiWarningIfPresent } from "./browserFailureProjection.js";
import {
  assertCommittedPromptEpochCurrent,
  assertPostArchivePromptEpochCurrent,
  createPromptEpochGuardedRuntime,
  maybeArchiveCompletedConversation,
} from "./archiveSettlementCoordinator.js";
import {
  persistPreArchiveCapture,
  saveOptionalArtifact,
} from "./publicationSettlementCoordinator.js";
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

async function settlePublishedRemoteCapture(
  context: RemoteBrowserExecutionContext,
  target: RemoteBrowserTarget,
  promptLocator: CommittedPromptEpochLocator,
  followUpCount: number,
  requiredArtifactsSaved: boolean,
): Promise<BrowserRunTransaction> {
  const capture = context.publishableCapture;
  if (!capture) {
    throw new Error("Remote browser capture is unavailable for publication.");
  }
  await persistPreArchiveCapture(
    context.options.preArchiveCaptureCb,
    capture,
    context.lifecycle.runtime(),
  );
  context.postCapturePendingWork = {
    code: "browser-archive-pending",
    context: "ChatGPT conversation archive",
  };
  capture.archive = await maybeArchiveCompletedConversation({
    Runtime: target.Runtime,
    logger: context.logger,
    config: context.config,
    conversationUrl: context.lastUrl,
    followUpCount,
    requiredArtifactsSaved,
  });
  capture.tookMs = Date.now() - context.startedAt;
  context.postCapturePendingWork = {
    code: "browser-final-identity-verification-pending",
    context: "final committed-turn identity verification",
  };
  await assertPostArchivePromptEpochCurrent(target.Runtime, promptLocator, capture.archive);
  context.postCapturePendingWork = {
    code: "browser-final-target-liveness-pending",
    context: "final Chrome target liveness confirmation",
  };
  if (context.connectionClosedUnexpectedly) {
    throw new Error("Remote Chrome disconnected after complete answer capture");
  }
  const transaction = context.lifecycle.issueCapture(capture);
  context.retainRemoteConnectionForSettlement =
    context.lifecycle.hasPendingPromptAuthorityJournal();
  return transaction;
}

export async function publishRemoteDeepResearchCapture(
  context: RemoteBrowserExecutionContext,
  target: RemoteBrowserTarget,
  expectedPromptTurn: CommittedPromptEpochLocator,
  researchResult: RemoteDeepResearchCapture,
): Promise<BrowserRunTransaction> {
  const { Runtime } = target;
  const { logger, options } = context;
  const reportArtifact = await saveOptionalArtifact(
    () =>
      saveDeepResearchReportArtifact({
        sessionId: options.sessionId,
        reportMarkdown: researchResult.text,
        conversationUrl: context.lastUrl,
        logger,
      }),
    logger,
  );
  const transcriptArtifact = await saveOptionalArtifact(
    () =>
      saveBrowserTranscriptArtifact({
        sessionId: options.sessionId,
        prompt: context.promptText,
        answerMarkdown: researchResult.text,
        conversationUrl: context.lastUrl,
        artifacts: appendArtifacts(undefined, [reportArtifact]),
        logger,
      }),
    logger,
  );
  await assertCommittedPromptEpochCurrent(Runtime, expectedPromptTurn);
  context.runStatus = "complete";
  context.publishableCapture = {
    answerText: researchResult.text,
    answerMarkdown: researchResult.text,
    answerHtml: researchResult.html,
    artifacts: appendArtifacts(undefined, [reportArtifact, transcriptArtifact]),
    modelSelection: context.modelSelectionEvidence,
    tookMs: Date.now() - context.startedAt,
    answerTokens: estimateTokenCount(researchResult.text),
    answerChars: researchResult.text.length,
  };
  return settlePublishedRemoteCapture(
    context,
    target,
    expectedPromptTurn,
    0,
    Boolean(reportArtifact && transcriptArtifact),
  );
}

export async function publishRemoteConversationCapture(
  context: RemoteBrowserExecutionContext,
  target: RemoteBrowserTarget,
  capture: RemoteConversationCapture,
): Promise<BrowserRunTransaction> {
  const { client, Network, Page, Runtime } = target;
  const { logger, options } = context;
  const { promptLocator } = capture;
  let { answerText, answerMarkdown, answerHtml } = capture;

  if (context.connectionClosedUnexpectedly) {
    throw new Error("Remote Chrome disconnected before complete answer capture");
  }
  const canSaveBrowserDownloadsLocally = isLocalChromeHost(context.host);
  const artifactMinTurnIndex = promptLocator.verifiedUserTurnIndex + 1;
  await assertCommittedPromptEpochCurrent(Runtime, promptLocator);
  const artifactRuntime = createPromptEpochGuardedRuntime(Runtime, promptLocator);
  const imageArtifacts = await collectGeneratedImageArtifacts({
    Browser: canSaveBrowserDownloadsLocally ? client.Browser : undefined,
    Client: canSaveBrowserDownloadsLocally ? client : undefined,
    Page: canSaveBrowserDownloadsLocally ? Page : undefined,
    Runtime: artifactRuntime,
    Network,
    logger,
    minTurnIndex: artifactMinTurnIndex,
    sessionId: options.sessionId,
    generateImagePath: options.generateImagePath,
    outputPath: options.outputPath,
    answerText,
    waitTimeoutMs: options.config?.timeoutMs,
    checkBlockingUiWarning: async () => {
      await assertCommittedPromptEpochCurrent(Runtime, promptLocator);
      await throwChatGptUiWarningIfPresent({
        Runtime,
        logger,
        stage: "image-artifact-wait",
        waitTarget: "generated image artifacts",
        runtime: context.buildRuntimeMetadata(),
      });
    },
  });
  await assertCommittedPromptEpochCurrent(Runtime, promptLocator);
  answerText = imageArtifacts.answerText || answerText;
  if (imageArtifacts.markdownSuffix) {
    answerMarkdown += imageArtifacts.markdownSuffix;
  }
  const fileArtifacts = await collectChatGptFileArtifacts({
    Browser: client.Browser,
    Client: client,
    Page,
    Runtime: artifactRuntime,
    Network,
    answerText: [answerText, answerMarkdown, answerHtml].filter(Boolean).join("\n"),
    logger,
    minTurnIndex: artifactMinTurnIndex,
    sessionId: options.sessionId,
  });
  await assertCommittedPromptEpochCurrent(Runtime, promptLocator);
  const savedImageArtifacts = appendArtifacts(undefined, imageArtifacts.savedImages);
  const savedBrowserArtifacts = appendArtifacts(savedImageArtifacts, fileArtifacts.savedFiles);
  const transcriptArtifact = await saveOptionalArtifact(
    () =>
      saveBrowserTranscriptArtifact({
        sessionId: options.sessionId,
        prompt: context.promptText,
        answerMarkdown,
        conversationUrl: context.lastUrl,
        artifacts: savedBrowserArtifacts,
        logger,
      }),
    logger,
  );
  await assertCommittedPromptEpochCurrent(Runtime, promptLocator);
  context.runStatus = "complete";
  context.publishableCapture = {
    answerText,
    answerMarkdown,
    answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
    artifacts: appendArtifacts(savedBrowserArtifacts, [transcriptArtifact]),
    generatedImages: imageArtifacts.generatedImages,
    savedImages: imageArtifacts.savedImages,
    downloadableFiles: fileArtifacts.files,
    savedFiles: fileArtifacts.savedFiles,
    modelSelection: context.modelSelectionEvidence,
    tookMs: Date.now() - context.startedAt,
    answerTokens: estimateTokenCount(answerMarkdown),
    answerChars: answerText.length,
  };
  return settlePublishedRemoteCapture(
    context,
    target,
    promptLocator,
    context.followUpPrompts.length,
    Boolean(transcriptArtifact) &&
      imageArtifacts.savedImages.length === imageArtifacts.imageCount &&
      fileArtifacts.savedFiles.length === fileArtifacts.fileCount,
  );
}
