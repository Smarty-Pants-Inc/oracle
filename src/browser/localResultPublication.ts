import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  appendArtifacts,
  saveBrowserTranscriptArtifact,
  saveDeepResearchReportArtifact,
} from "./artifacts.js";
import { collectChatGptFileArtifacts } from "./chatgptFiles.js";
import { collectGeneratedImageArtifacts } from "./chatgptImages.js";
import {
  assertCommittedPromptEpochCurrent,
  assertPostArchivePromptEpochCurrent,
  createPromptEpochGuardedRuntime,
  maybeArchiveCompletedConversation,
} from "./archiveSettlementCoordinator.js";
import { throwChatGptUiWarningIfPresent } from "./browserFailureProjection.js";
import {
  persistPreArchiveCapture,
  saveOptionalArtifact,
} from "./publicationSettlementCoordinator.js";
import { estimateTokenCount } from "./utils.js";
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

async function settlePublishedLocalCapture(
  { acquisition, state, lifecycle, options, logger, startedAt }: LocalResultPublicationContext,
  Runtime: LocalPromptExecutionResult["Runtime"],
  promptLocator: NonNullable<LocalCapturedResponse["promptLocator"]>,
  capture: NonNullable<LocalBrowserRunState["publishableCapture"]>,
  followUpCount: number,
  requiredArtifactsSaved: boolean,
): Promise<BrowserRunTransaction> {
  await persistPreArchiveCapture(options.preArchiveCaptureCb, capture, lifecycle.runtime());
  state.postCapturePendingWork = {
    code: "browser-archive-pending",
    context: "ChatGPT conversation archive",
  };
  capture.archive = await maybeArchiveCompletedConversation({
    Runtime,
    logger,
    config: acquisition.config,
    conversationUrl: state.lastUrl,
    promptLocator,
    followUpCount,
    requiredArtifactsSaved,
  });
  capture.tookMs = Date.now() - startedAt;
  state.postCapturePendingWork = {
    code: "browser-final-identity-verification-pending",
    context: "final committed-turn identity verification",
  };
  await assertPostArchivePromptEpochCurrent(Runtime, promptLocator, capture.archive);
  state.postCapturePendingWork = {
    code: "browser-final-target-liveness-pending",
    context: "final Chrome target liveness confirmation",
  };
  if (state.connectionClosedUnexpectedly) {
    throw new Error("Chrome disconnected after complete answer capture");
  }
  return lifecycle.issueCapture(capture);
}

export async function publishLocalBrowserResult(
  context: LocalResultPublicationContext,
): Promise<BrowserRunTransaction> {
  const {
    state,
    prompt,
    captured,
    options,
    promptText,
    followUpPrompts,
    logger,
    startedAt,
    buildRuntimeMetadata,
  } = context;
  const { client, Network, Page, Runtime } = prompt;
  const artifactPromptLocator = captured.promptLocator;
  if (!artifactPromptLocator) {
    throw new BrowserAutomationError("Artifact prompt authority is unavailable.", {
      stage: "prompt-epoch",
      code: "prompt-epoch-evidence-missing",
    });
  }

  if (captured.kind === "deep-research") {
    const reportArtifact = await saveOptionalArtifact(
      () =>
        saveDeepResearchReportArtifact({
          sessionId: options.sessionId,
          reportMarkdown: captured.answerMarkdown,
          conversationUrl: state.lastUrl,
          logger,
        }),
      logger,
    );
    const transcriptArtifact = await saveOptionalArtifact(
      () =>
        saveBrowserTranscriptArtifact({
          sessionId: options.sessionId,
          prompt: promptText,
          answerMarkdown: captured.answerMarkdown,
          conversationUrl: state.lastUrl,
          artifacts: appendArtifacts(undefined, [reportArtifact]),
          logger,
        }),
      logger,
    );
    await assertCommittedPromptEpochCurrent(Runtime, artifactPromptLocator);
    state.runStatus = "complete";
    state.publishableCapture = {
      answerText: captured.answerText,
      answerMarkdown: captured.answerMarkdown,
      answerHtml: captured.answerHtml,
      artifacts: appendArtifacts(undefined, [reportArtifact, transcriptArtifact]),
      modelSelection: state.modelSelectionEvidence,
      tookMs: Date.now() - startedAt,
      answerTokens: estimateTokenCount(captured.answerMarkdown),
      answerChars: captured.answerText.length,
    };
    return settlePublishedLocalCapture(
      context,
      Runtime,
      artifactPromptLocator,
      state.publishableCapture,
      0,
      Boolean(reportArtifact && transcriptArtifact),
    );
  }

  let answerText = captured.answerText;
  let answerMarkdown = captured.answerMarkdown;
  const answerHtml = captured.answerHtml;
  const artifactMinTurnIndex = artifactPromptLocator.verifiedUserTurnIndex + 1;
  await assertCommittedPromptEpochCurrent(Runtime, artifactPromptLocator);
  const artifactRuntime = createPromptEpochGuardedRuntime(Runtime, artifactPromptLocator);
  const imageArtifacts = await collectGeneratedImageArtifacts({
    Browser: client.Browser,
    Client: client,
    Page,
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
      await assertCommittedPromptEpochCurrent(Runtime, artifactPromptLocator);
      await throwChatGptUiWarningIfPresent({
        Runtime,
        logger,
        stage: "image-artifact-wait",
        waitTarget: "generated image artifacts",
        runtime: buildRuntimeMetadata(),
      });
    },
  });
  await assertCommittedPromptEpochCurrent(Runtime, artifactPromptLocator);
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
  await assertCommittedPromptEpochCurrent(Runtime, artifactPromptLocator);
  const savedImageArtifacts = appendArtifacts(undefined, imageArtifacts.savedImages);
  const savedBrowserArtifacts = appendArtifacts(savedImageArtifacts, fileArtifacts.savedFiles);
  const transcriptArtifact = await saveOptionalArtifact(
    () =>
      saveBrowserTranscriptArtifact({
        sessionId: options.sessionId,
        prompt: promptText,
        answerMarkdown,
        conversationUrl: state.lastUrl,
        artifacts: savedBrowserArtifacts,
        logger,
      }),
    logger,
  );
  await assertCommittedPromptEpochCurrent(Runtime, artifactPromptLocator);
  state.runStatus = "complete";
  state.publishableCapture = {
    answerText,
    answerMarkdown,
    answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
    artifacts: appendArtifacts(savedBrowserArtifacts, [transcriptArtifact]),
    generatedImages: imageArtifacts.generatedImages,
    savedImages: imageArtifacts.savedImages,
    downloadableFiles: fileArtifacts.files,
    savedFiles: fileArtifacts.savedFiles,
    modelSelection: state.modelSelectionEvidence,
    tookMs: Date.now() - startedAt,
    answerTokens: estimateTokenCount(answerMarkdown),
    answerChars: answerText.length,
  };
  return settlePublishedLocalCapture(
    context,
    Runtime,
    artifactPromptLocator,
    state.publishableCapture,
    followUpPrompts.length,
    Boolean(transcriptArtifact) &&
      imageArtifacts.savedImages.length === imageArtifacts.imageCount &&
      fileArtifacts.savedFiles.length === fileArtifacts.fileCount,
  );
}
