import { BrowserAutomationError } from "../oracle/errors.js";
import {
  waitForDeepResearchCompletion,
  waitForResearchPlanAutoConfirm,
} from "./actions/deepResearch.js";
import { ensurePromptReady } from "./pageActions.js";
import { assertCommittedPromptEpochCurrent } from "./archiveSettlementCoordinator.js";
import {
  formatBrowserTurnTranscript,
  type BrowserConversationTurn,
} from "./responseCaptureCoordinator.js";
import { runSubmissionWithRecovery } from "./promptSubmissionCoordinator.js";
import { submitRemotePromptOnce } from "./remotePromptSubmission.js";
import { captureRemoteAssistantTurn } from "./remoteResponseCapture.js";
import {
  publishRemoteConversationCapture,
  publishRemoteDeepResearchCapture,
} from "./remoteCapturePublication.js";
import type { CommittedPromptEpochLocator } from "./reattachability.js";
import type { BrowserRunTransaction } from "./types.js";
import type { RemoteBrowserExecutionContext } from "./remoteExecutionContext.js";
import type { RemoteBrowserTarget } from "./remoteTargetAcquisition.js";

export async function runRemotePromptLoop(
  context: RemoteBrowserExecutionContext,
  target: RemoteBrowserTarget,
): Promise<BrowserRunTransaction> {
  const { config, logger, options, lifecycle, promptText, attachments, followUpPrompts } = context;
  const { Runtime, Page, activeConversationUrlMonitor } = target;
  const deepResearch = config.researchMode === "deep";
  const reloadPromptComposer = async () => {
    await lifecycle.resetPrompt();
    logger("[browser] Composer became unresponsive; reloading page and retrying once.");
    await Page.reload({ ignoreCache: true });
    await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
  };

  let baselineAssistantText: string | null = null;
  let promptLocator: CommittedPromptEpochLocator | null = null;
  const submission = await runSubmissionWithRecovery({
    prompt: promptText,
    attachments,
    fallbackSubmission: options.fallbackSubmission,
    submit: (submissionPrompt, submissionAttachments) =>
      submitRemotePromptOnce(
        context,
        target,
        submissionPrompt,
        submissionAttachments,
        0,
        followUpPrompts.length,
        deepResearch,
      ),
    reloadPromptComposer,
    prepareFallbackSubmission: () => lifecycle.resetPrompt(),
    logger,
  });
  baselineAssistantText = submission.baselineAssistantText;
  promptLocator = submission.promptLocator;

  if (deepResearch) {
    await waitForResearchPlanAutoConfirm(Runtime, logger);
    const expectedPromptTurn = promptLocator;
    if (!expectedPromptTurn) {
      throw new BrowserAutomationError("Deep Research prompt authority is unavailable.", {
        stage: "prompt-epoch",
        code: "prompt-epoch-evidence-missing",
      });
    }
    const researchResult = await waitForDeepResearchCompletion(
      Runtime,
      logger,
      config.timeoutMs,
      expectedPromptTurn.verifiedUserTurnIndex + 1,
      Page,
      target.client,
      {
        ignoredTargetKeys: submission.deepResearchTargetKeys ?? [],
        targetBaselineCaptured: submission.deepResearchTargetBaselineCaptured ?? false,
        expectedConversationId: expectedPromptTurn.conversationId,
        expectedPromptTurn,
      },
    );
    await activeConversationUrlMonitor.update("post-deep-research", 15_000).catch(() => false);
    await assertCommittedPromptEpochCurrent(Runtime, expectedPromptTurn);
    return publishRemoteDeepResearchCapture(context, target, expectedPromptTurn, researchResult);
  }

  const legacyGenerateImage =
    "generateImage" in options && typeof options.generateImage === "string"
      ? options.generateImage
      : undefined;
  const imageOutputRequested = Boolean(
    options.generateImagePath || options.outputPath || legacyGenerateImage,
  );
  const turns: BrowserConversationTurn[] = [];
  let remainingFollowUpsToCapture = followUpPrompts.length;
  const initialTurn = await captureRemoteAssistantTurn(
    context,
    target,
    promptText,
    "Initial response",
    promptLocator,
    baselineAssistantText,
    imageOutputRequested,
  );
  turns.push(initialTurn);
  let answerText = initialTurn.answerText;
  let answerMarkdown = initialTurn.answerMarkdown;
  let answerHtml = initialTurn.answerHtml;

  for (let index = 0; index < followUpPrompts.length; index += 1) {
    const followUpPrompt = followUpPrompts[index];
    logger(`[browser] Sending follow-up ${index + 1}/${followUpPrompts.length}`);
    const followUpSubmission = await runSubmissionWithRecovery({
      prompt: followUpPrompt,
      attachments: [],
      submit: (submissionPrompt, submissionAttachments) =>
        submitRemotePromptOnce(
          context,
          target,
          submissionPrompt,
          submissionAttachments,
          index + 1,
          followUpPrompts.length - index - 1,
          false,
        ),
      reloadPromptComposer,
      prepareFallbackSubmission: () => lifecycle.resetPrompt(),
      logger,
    });
    promptLocator = followUpSubmission.promptLocator;
    baselineAssistantText = followUpSubmission.baselineAssistantText;
    const turn = await captureRemoteAssistantTurn(
      context,
      target,
      followUpPrompt,
      `Follow-up ${index + 1}`,
      promptLocator,
      baselineAssistantText,
      imageOutputRequested,
    );
    remainingFollowUpsToCapture -= 1;
    turns.push({ ...turn, prompt: followUpPrompt });
    answerText = turn.answerText;
    answerMarkdown = turn.answerMarkdown;
    answerHtml = turn.answerHtml;
  }
  if (remainingFollowUpsToCapture !== 0) {
    throw new BrowserAutomationError(
      "Browser run cannot complete before every configured follow-up answer is captured.",
      {
        stage: "browser-follow-ups",
        code: "browser-follow-ups-incomplete",
        details: { remainingFollowUps: remainingFollowUpsToCapture },
      },
    );
  }

  if (turns.length > 1) {
    const formatted = formatBrowserTurnTranscript(turns);
    answerText = formatted.answerText;
    answerMarkdown = formatted.answerMarkdown;
    answerHtml = "";
  }
  if (!promptLocator) {
    throw new BrowserAutomationError("Artifact prompt authority is unavailable.", {
      stage: "prompt-epoch",
      code: "prompt-epoch-evidence-missing",
    });
  }
  return publishRemoteConversationCapture(context, target, {
    answerText,
    answerMarkdown,
    answerHtml,
    promptLocator,
  });
}
