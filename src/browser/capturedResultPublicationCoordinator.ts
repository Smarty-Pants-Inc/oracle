import type { BrowserModelSelectionEvidence, BrowserRuntimeMetadata } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  appendArtifacts,
  saveBrowserTranscriptArtifact,
  saveDeepResearchReportArtifact,
} from "./artifacts.js";
import {
  assertCommittedPromptEpochCurrent,
  assertPostArchivePromptEpochCurrent,
  createPromptEpochGuardedRuntime,
  maybeArchiveCompletedConversation,
} from "./archiveSettlementCoordinator.js";
import { throwChatGptUiWarningIfPresent } from "./browserFailureProjection.js";
import { collectChatGptFileArtifacts } from "./chatgptFiles.js";
import { collectGeneratedImageArtifacts } from "./chatgptImages.js";
import {
  persistPreArchiveCapture,
  saveOptionalArtifact,
  type PostCapturePendingWork,
} from "./publicationSettlementCoordinator.js";
import type { CommittedPromptEpochLocator } from "./reattachability.js";
import type { BrowserRunLifecycleController } from "./runLifecycle.js";
import type { SessionBoundChromeClient } from "./chromeSessionTransport.js";
import type {
  BrowserArtifactWriteAuthority,
  BrowserLogger,
  BrowserRunOptions,
  BrowserRunResult,
  BrowserRunTransaction,
  ResolvedBrowserConfig,
} from "./types.js";
import { estimateTokenCount } from "./utils.js";

export type CapturedBrowserResult =
  | {
      kind: "deep-research";
      promptLocator: CommittedPromptEpochLocator | null | undefined;
      answerText: string;
      answerMarkdown: string;
      answerHtml?: string;
    }
  | {
      kind: "conversation";
      promptLocator: CommittedPromptEpochLocator | null | undefined;
      answerText: string;
      answerMarkdown: string;
      answerHtml: string;
      followUpCount: number;
    };

export interface BrowserArtifactDownloadAuthority {
  Page: SessionBoundChromeClient["Page"];
}

export interface CapturedResultPublicationAdapters {
  artifactWriteAuthority: BrowserArtifactWriteAuthority | undefined;
  imageDownloadAuthority: BrowserArtifactDownloadAuthority | null;
  fileDownloadAuthority: BrowserArtifactDownloadAuthority | null;
  setPendingWork: (work: PostCapturePendingWork) => void;
  assertFinalLiveness: () => void;
}

export interface CapturedResultPublicationState {
  runStatus: "attempted" | "complete";
  publishableCapture: BrowserRunResult | null;
}

export interface CapturedBrowserResultPublicationContext {
  captured: CapturedBrowserResult;
  state: CapturedResultPublicationState;
  lifecycle: BrowserRunLifecycleController;
  Network: SessionBoundChromeClient["Network"];
  Runtime: SessionBoundChromeClient["Runtime"];
  options: BrowserRunOptions;
  config: ResolvedBrowserConfig;
  promptText: string;
  conversationUrl: string | undefined;
  modelSelection: BrowserModelSelectionEvidence | undefined;
  logger: BrowserLogger;
  startedAt: number;
  buildRuntimeMetadata: (tabUrl?: string) => BrowserRuntimeMetadata;
  adapters: CapturedResultPublicationAdapters;
}

type PreparedCapture = {
  capture: BrowserRunResult;
  requiredArtifactsSaved: boolean;
  followUpCount: number;
};

async function prepareDeepResearchCapture(
  context: CapturedBrowserResultPublicationContext,
  promptLocator: CommittedPromptEpochLocator,
): Promise<PreparedCapture> {
  const { captured, options, conversationUrl, promptText, logger, startedAt, modelSelection } =
    context;
  if (captured.kind !== "deep-research") {
    throw new Error("Deep Research publication requires a Deep Research capture.");
  }
  const { artifactWriteAuthority } = context.adapters;
  const reportArtifact = await saveOptionalArtifact(
    () =>
      saveDeepResearchReportArtifact({
        sessionId: options.sessionId,
        artifactWriteAuthority,
        reportMarkdown: captured.answerMarkdown,
        conversationUrl,
        logger,
      }),
    logger,
  );
  const transcriptArtifact = await saveOptionalArtifact(
    () =>
      saveBrowserTranscriptArtifact({
        sessionId: options.sessionId,
        artifactWriteAuthority,
        prompt: promptText,
        answerMarkdown: captured.answerMarkdown,
        conversationUrl,
        artifacts: appendArtifacts(undefined, [reportArtifact]),
        logger,
      }),
    logger,
  );
  await assertCommittedPromptEpochCurrent(context.Runtime, promptLocator);
  return {
    capture: {
      answerText: captured.answerText,
      answerMarkdown: captured.answerMarkdown,
      answerHtml: captured.answerHtml,
      artifacts: appendArtifacts(undefined, [reportArtifact, transcriptArtifact]),
      modelSelection,
      tookMs: Date.now() - startedAt,
      answerTokens: estimateTokenCount(captured.answerMarkdown),
      answerChars: captured.answerText.length,
    },
    requiredArtifactsSaved: Boolean(reportArtifact && transcriptArtifact),
    followUpCount: 0,
  };
}

async function prepareConversationCapture(
  context: CapturedBrowserResultPublicationContext,
  promptLocator: CommittedPromptEpochLocator,
): Promise<PreparedCapture> {
  const {
    captured,
    Network,
    Runtime,
    options,
    promptText,
    conversationUrl,
    modelSelection,
    logger,
    startedAt,
    buildRuntimeMetadata,
    adapters,
  } = context;
  if (captured.kind !== "conversation") {
    throw new Error("Conversation publication requires a conversation capture.");
  }
  let { answerText, answerMarkdown } = captured;
  const { answerHtml } = captured;
  const artifactMinTurnIndex = promptLocator.verifiedUserTurnIndex + 1;
  await assertCommittedPromptEpochCurrent(Runtime, promptLocator);
  const artifactRuntime = createPromptEpochGuardedRuntime(Runtime, promptLocator);
  const imageArtifacts = await collectGeneratedImageArtifacts({
    ...(adapters.imageDownloadAuthority ?? {}),
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
        runtime: buildRuntimeMetadata(),
      });
    },
  });
  await assertCommittedPromptEpochCurrent(Runtime, promptLocator);
  answerText = imageArtifacts.answerText || answerText;
  if (imageArtifacts.markdownSuffix) {
    answerMarkdown += imageArtifacts.markdownSuffix;
  }
  const fileArtifacts = await collectChatGptFileArtifacts({
    ...(adapters.fileDownloadAuthority ?? {}),
    Runtime: artifactRuntime,
    Network,
    answerText: [answerText, answerMarkdown, answerHtml].filter(Boolean).join("\n"),
    logger,
    minTurnIndex: artifactMinTurnIndex,
    sessionId: options.sessionId,
    artifactWriteAuthority: adapters.artifactWriteAuthority,
  });
  await assertCommittedPromptEpochCurrent(Runtime, promptLocator);
  const savedImageArtifacts = appendArtifacts(undefined, imageArtifacts.savedImages);
  const savedBrowserArtifacts = appendArtifacts(savedImageArtifacts, fileArtifacts.savedFiles);
  const transcriptArtifact = await saveOptionalArtifact(
    () =>
      saveBrowserTranscriptArtifact({
        sessionId: options.sessionId,
        artifactWriteAuthority: adapters.artifactWriteAuthority,
        prompt: promptText,
        answerMarkdown,
        conversationUrl,
        artifacts: savedBrowserArtifacts,
        logger,
      }),
    logger,
  );
  await assertCommittedPromptEpochCurrent(Runtime, promptLocator);
  return {
    capture: {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      artifacts: appendArtifacts(savedBrowserArtifacts, [transcriptArtifact]),
      generatedImages: imageArtifacts.generatedImages,
      savedImages: imageArtifacts.savedImages,
      downloadableFiles: fileArtifacts.files,
      savedFiles: fileArtifacts.savedFiles,
      modelSelection,
      tookMs: Date.now() - startedAt,
      answerTokens: estimateTokenCount(answerMarkdown),
      answerChars: answerText.length,
    },
    requiredArtifactsSaved:
      Boolean(transcriptArtifact) &&
      imageArtifacts.savedImages.length === imageArtifacts.imageCount &&
      fileArtifacts.savedFiles.length === fileArtifacts.fileCount,
    followUpCount: captured.followUpCount,
  };
}

export async function publishCapturedBrowserResult(
  context: CapturedBrowserResultPublicationContext,
): Promise<BrowserRunTransaction> {
  const promptLocator = context.captured.promptLocator;
  if (!promptLocator) {
    throw new BrowserAutomationError("Artifact prompt authority is unavailable.", {
      stage: "prompt-epoch",
      code: "prompt-epoch-evidence-missing",
    });
  }
  const prepared =
    context.captured.kind === "deep-research"
      ? await prepareDeepResearchCapture(context, promptLocator)
      : await prepareConversationCapture(context, promptLocator);

  context.state.runStatus = "complete";
  context.state.publishableCapture = prepared.capture;
  await persistPreArchiveCapture(
    context.options.preArchiveCaptureCb,
    prepared.capture,
    context.lifecycle.runtime(),
  );
  context.adapters.setPendingWork({
    code: "browser-archive-pending",
    context: "ChatGPT conversation archive",
  });
  const archive = await maybeArchiveCompletedConversation({
    Runtime: context.Runtime,
    logger: context.logger,
    config: context.config,
    conversationUrl: context.conversationUrl,
    promptLocator,
    followUpCount: prepared.followUpCount,
    requiredArtifactsSaved: prepared.requiredArtifactsSaved,
  });
  const capture = {
    ...prepared.capture,
    archive,
    tookMs: Date.now() - context.startedAt,
  };
  context.state.publishableCapture = capture;
  context.adapters.setPendingWork({
    code: "browser-final-identity-verification-pending",
    context: "final committed-turn identity verification",
  });
  await assertPostArchivePromptEpochCurrent(context.Runtime, promptLocator, archive);
  context.adapters.setPendingWork({
    code: "browser-final-target-liveness-pending",
    context: "final Chrome target liveness confirmation",
  });
  context.adapters.assertFinalLiveness();
  return context.lifecycle.issueCapture(capture);
}
