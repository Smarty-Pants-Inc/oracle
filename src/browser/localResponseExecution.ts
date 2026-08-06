import { BrowserAutomationError } from "../oracle/errors.js";
import { formatElapsed } from "../oracle/format.js";
import {
  waitForDeepResearchCompletion,
  waitForResearchPlanAutoConfirm,
} from "./actions/deepResearch.js";
import { startThinkingStatusMonitor } from "./actions/thinkingStatus.js";
import {
  captureAssistantMarkdown,
  readAssistantSnapshot,
  waitForResumedConversationHydration,
} from "./pageActions.js";
import { captureBrowserDiagnostics } from "./domDebug.js";
import { alignPromptEchoPair, buildPromptEchoMatcher } from "./reattachHelpers.js";
import {
  assertCommittedPromptEpochCurrent,
  readConversationUrl,
} from "./archiveSettlementCoordinator.js";
import {
  attemptAssistantRecheckOrRethrow,
  formatBrowserTurnTranscript,
  isAssistantResponseTimeoutError,
  maybeRecoverLongAssistantResponse,
  normalizeForComparison,
  validateChatGPTSession,
  waitForAssistantOrGeneratedImageResponse,
  waitForAssistantResponseWithReload,
  waitForFreshAssistantResponse,
  type AssistantAnswer,
  type BrowserConversationTurn,
} from "./responseCaptureCoordinator.js";
import { createAssistantTimeoutError } from "./browserFailureProjection.js";
import { isStableConversationUrl as isConversationUrl } from "./conversationUrl.js";
import { runSubmissionWithRecovery } from "./promptSubmissionCoordinator.js";
import { delay, withRetries } from "./utils.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import type { CommittedPromptEpochLocator } from "./reattachability.js";
import type { LocalPromptExecutionResult } from "./localPromptExecution.js";
import type { LocalBrowserAcquisition } from "./localAcquisition.js";
import type { LocalBrowserRunState } from "./localRunState.js";
import type { BrowserRunLifecycleController } from "./runLifecycle.js";
import type { BrowserLogger, BrowserRunOptions } from "./types.js";

export type LocalCapturedResponse =
  | {
      kind: "deep-research";
      promptLocator: CommittedPromptEpochLocator;
      answerText: string;
      answerMarkdown: string;
      answerHtml: string | undefined;
    }
  | {
      kind: "standard";
      promptLocator: CommittedPromptEpochLocator;
      answerText: string;
      answerMarkdown: string;
      answerHtml: string;
    };

export interface LocalResponseExecutionContext {
  acquisition: LocalBrowserAcquisition;
  state: LocalBrowserRunState;
  lifecycle: BrowserRunLifecycleController;
  prompt: LocalPromptExecutionResult;
  options: BrowserRunOptions;
  promptText: string;
  followUpPrompts: string[];
  logger: BrowserLogger;
  buildRuntimeMetadata: (tabUrl?: string) => BrowserRuntimeMetadata;
  emitRuntimeHint: () => Promise<void>;
}

export async function captureLocalBrowserResponse({
  acquisition,
  state,
  lifecycle,
  prompt,
  options,
  promptText,
  followUpPrompts,
  logger,
  buildRuntimeMetadata,
  emitRuntimeHint,
}: LocalResponseExecutionContext): Promise<LocalCapturedResponse> {
  const { config } = acquisition;
  const {
    client,
    Page,
    Runtime,
    raceWithDisconnect,
    captureRuntimeSnapshot,
    updateConversationHint,
    acquireProfileLockIfNeeded,
    releaseProfileLockIfHeld,
    submitOnce,
    reloadPromptComposer,
    deepResearch,
    deepResearchTargetKeys,
    deepResearchTargetBaselineCaptured,
  } = prompt;
  let promptLocator = prompt.promptLocator;
  let baselineAssistantText = prompt.baselineAssistantText;

  if (deepResearch) {
    await raceWithDisconnect(waitForResearchPlanAutoConfirm(Runtime, logger));
    const expectedPromptTurn = promptLocator;
    const researchResult = await raceWithDisconnect(
      waitForDeepResearchCompletion(
        Runtime,
        logger,
        config.timeoutMs,
        expectedPromptTurn.verifiedUserTurnIndex + 1,
        Page,
        client,
        {
          ignoredTargetKeys: deepResearchTargetKeys,
          targetBaselineCaptured: deepResearchTargetBaselineCaptured,
          expectedConversationId: expectedPromptTurn.conversationId,
          expectedPromptTurn,
        },
      ),
    );
    await updateConversationHint("post-deep-research", 15_000).catch(() => false);
    await assertCommittedPromptEpochCurrent(Runtime, expectedPromptTurn);
    return {
      kind: "deep-research",
      promptLocator: expectedPromptTurn,
      answerText: researchResult.text,
      answerMarkdown: researchResult.text,
      answerHtml: researchResult.html,
    };
  }

  let stopThinkingMonitor: (() => void) | null = null;
  const waitWithThinkingMonitor = async <T>(operation: () => Promise<T>): Promise<T> => {
    stopThinkingMonitor?.();
    stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, {
      intervalMs: options.heartbeatIntervalMs,
    });
    try {
      return await operation();
    } finally {
      stopThinkingMonitor?.();
      stopThinkingMonitor = null;
    }
  };
  const legacyGenerateImage = "generateImage" in options ? options.generateImage : undefined;
  const imageOutputRequested = Boolean(
    options.generateImagePath || options.outputPath || legacyGenerateImage,
  );
  const recheckDelayMs = Math.max(0, config.assistantRecheckDelayMs ?? 0);
  const recheckTimeoutMs = Math.max(0, config.assistantRecheckTimeoutMs ?? 0);
  const attemptAssistantRecheck = async (expectedPromptTurn: CommittedPromptEpochLocator) => {
    if (!recheckDelayMs) return null;
    logger(
      `[browser] Assistant response timed out; waiting ${formatElapsed(recheckDelayMs)} before rechecking conversation.`,
    );
    await raceWithDisconnect(delay(recheckDelayMs));
    await updateConversationHint("assistant-recheck", 15_000).catch(() => false);
    await captureRuntimeSnapshot().catch(() => undefined);
    const conversationUrl = await readConversationUrl(Runtime);
    if (conversationUrl && isConversationUrl(conversationUrl)) {
      logger(`[browser] Rechecking assistant response at ${conversationUrl}`);
      await raceWithDisconnect(Page.navigate({ url: conversationUrl }));
      await raceWithDisconnect(
        waitForResumedConversationHydration(Runtime, recheckTimeoutMs || 30_000, logger, {
          requirePriorTurns: true,
          requirePromptReady: false,
          expectedConversationUrl: conversationUrl,
        }),
      );
    }
    const sessionValid = await validateChatGPTSession(Runtime, logger);
    if (!sessionValid.valid) {
      logger(`[browser] Session validation failed: ${sessionValid.reason}`);
      await emitRuntimeHint();
      throw new BrowserAutomationError(
        `ChatGPT session expired during recheck: ${sessionValid.reason}. ` +
          `Conversation URL: ${conversationUrl || state.lastUrl || "unknown"}. ` +
          `Please sign in and retry.`,
        {
          stage: "assistant-recheck",
          details: {
            conversationUrl: conversationUrl || state.lastUrl || null,
            sessionStatus: "needs_login",
            validationReason: sessionValid.reason,
          },
          runtime: buildRuntimeMetadata(),
        },
      );
    }
    const timeoutMs = recheckTimeoutMs > 0 ? recheckTimeoutMs : config.timeoutMs;
    const rechecked = await waitWithThinkingMonitor(() =>
      raceWithDisconnect(
        waitForAssistantOrGeneratedImageResponse({
          Runtime,
          waitForText: () =>
            waitForAssistantResponseWithReload(
              Runtime,
              Page,
              timeoutMs,
              logger,
              expectedPromptTurn.verifiedUserTurnIndex + 1,
              expectedPromptTurn.conversationId,
              expectedPromptTurn,
            ),
          timeoutMs,
          logger,
          minTurnIndex: expectedPromptTurn.verifiedUserTurnIndex + 1,
          expectedConversationId: expectedPromptTurn.conversationId,
          expectedPromptTurn,
          imageOutputRequested,
        }),
      ),
    );
    logger("Recovered assistant response after delayed recheck");
    return rechecked;
  };

  const captureAssistantTurn = async (
    turnPrompt: string,
    label: string,
  ): Promise<BrowserConversationTurn & { answerHtml: string }> => {
    const expectedPromptTurn = promptLocator;
    let turnAnswer: AssistantAnswer;
    try {
      await updateConversationHint("assistant-wait", 15_000).catch(() => false);
      turnAnswer = await waitWithThinkingMonitor(() =>
        raceWithDisconnect(
          waitForAssistantOrGeneratedImageResponse({
            Runtime,
            waitForText: () =>
              waitForAssistantResponseWithReload(
                Runtime,
                Page,
                config.timeoutMs,
                logger,
                expectedPromptTurn.verifiedUserTurnIndex + 1,
                expectedPromptTurn.conversationId,
                expectedPromptTurn,
              ),
            timeoutMs: config.timeoutMs,
            logger,
            minTurnIndex: expectedPromptTurn.verifiedUserTurnIndex + 1,
            expectedConversationId: expectedPromptTurn.conversationId,
            expectedPromptTurn,
            imageOutputRequested,
          }),
        ),
      );
    } catch (error) {
      if (isAssistantResponseTimeoutError(error)) {
        const rechecked = await attemptAssistantRecheckOrRethrow(() =>
          attemptAssistantRecheck(expectedPromptTurn),
        );
        if (rechecked) {
          turnAnswer = rechecked;
        } else {
          await updateConversationHint("assistant-timeout", 15_000).catch(() => false);
          await captureRuntimeSnapshot().catch(() => undefined);
          const diagnostics = await captureBrowserDiagnostics(
            Runtime,
            logger,
            "assistant-timeout",
            {
              Page,
              sessionId: options.sessionId,
            },
          ).catch(() => undefined);
          throw await createAssistantTimeoutError({
            Runtime,
            logger,
            runtime: buildRuntimeMetadata(),
            diagnostics,
            cause: error,
          });
        }
      } else {
        throw error;
      }
    }
    await updateConversationHint("post-response", 15_000);
    const baselineNormalized = baselineAssistantText
      ? normalizeForComparison(baselineAssistantText)
      : "";
    if (baselineNormalized) {
      const normalizedAnswer = normalizeForComparison(turnAnswer.text ?? "");
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : "";
      const isBaseline =
        normalizedAnswer === baselineNormalized ||
        (baselinePrefix.length > 0 && normalizedAnswer.startsWith(baselinePrefix));
      if (isBaseline) {
        logger("Detected stale assistant response; waiting for new response...");
        const refreshed = await waitForFreshAssistantResponse(
          Runtime,
          baselineNormalized,
          15_000,
          expectedPromptTurn,
        );
        if (refreshed) {
          turnAnswer = refreshed;
        }
      }
    }
    let turnAnswerText = turnAnswer.text;
    const turnAnswerHtml = turnAnswer.html ?? "";
    const copiedMarkdown = await raceWithDisconnect(
      withRetries(
        async () => {
          const attempt = await captureAssistantMarkdown(
            Runtime,
            turnAnswer.meta,
            logger,
            expectedPromptTurn.conversationId,
            expectedPromptTurn,
          );
          if (!attempt) {
            throw new Error("copy-missing");
          }
          return attempt;
        },
        {
          retries: 2,
          delayMs: 350,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Markdown capture attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        },
      ),
    ).catch(() => null);
    let turnAnswerMarkdown = copiedMarkdown ?? turnAnswerText;

    const promptEchoMatcher = buildPromptEchoMatcher(turnPrompt);
    ({ answerText: turnAnswerText, answerMarkdown: turnAnswerMarkdown } =
      await maybeRecoverLongAssistantResponse({
        runtime: Runtime,
        answerText: turnAnswerText,
        answerMarkdown: turnAnswerMarkdown,
        logger,
        allowMarkdownUpdate: !copiedMarkdown,
        expectedPromptTurn,
      }));

    const finalSnapshot = await readAssistantSnapshot(
      Runtime,
      expectedPromptTurn.verifiedUserTurnIndex + 1,
      expectedPromptTurn.conversationId,
      expectedPromptTurn,
    ).catch(() => null);
    const finalText = typeof finalSnapshot?.text === "string" ? finalSnapshot.text.trim() : "";
    if (finalText && finalText !== turnPrompt.trim()) {
      const trimmedMarkdown = turnAnswerMarkdown.trim();
      const finalIsEcho = promptEchoMatcher ? promptEchoMatcher.isEcho(finalText) : false;
      const lengthDelta = finalText.length - trimmedMarkdown.length;
      const missingCopy = !copiedMarkdown && lengthDelta >= 0;
      const likelyTruncatedCopy =
        copiedMarkdown &&
        trimmedMarkdown.length > 0 &&
        lengthDelta >= Math.max(12, Math.floor(trimmedMarkdown.length * 0.75));
      if ((missingCopy || likelyTruncatedCopy) && !finalIsEcho && finalText !== trimmedMarkdown) {
        logger("Refreshed assistant response via final DOM snapshot");
        turnAnswerText = finalText;
        turnAnswerMarkdown = finalText;
      }
    }

    const alignedEcho = alignPromptEchoPair(
      turnAnswerText,
      turnAnswerMarkdown,
      promptEchoMatcher,
      copiedMarkdown ? logger : undefined,
      {
        text: "Aligned assistant response text to copied markdown after prompt echo",
        markdown: "Aligned assistant markdown to response text after prompt echo",
      },
    );
    turnAnswerText = alignedEcho.answerText;
    turnAnswerMarkdown = alignedEcho.answerMarkdown;
    if (alignedEcho.isEcho) {
      logger("Detected prompt echo in response; waiting for actual assistant response...");
      const deadline = Date.now() + 15_000;
      let bestText: string | null = null;
      let stableCount = 0;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(
          Runtime,
          expectedPromptTurn.verifiedUserTurnIndex + 1,
          expectedPromptTurn.conversationId,
          expectedPromptTurn,
        ).catch(() => null);
        const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
        const isStillEcho = !text || Boolean(promptEchoMatcher?.isEcho(text));
        if (!isStillEcho) {
          if (!bestText || text.length > bestText.length) {
            bestText = text;
            stableCount = 0;
          } else if (text === bestText) {
            stableCount += 1;
          }
          if (stableCount >= 2) {
            break;
          }
        }
        await delay(300);
      }
      if (bestText) {
        logger("Recovered assistant response after detecting prompt echo");
        turnAnswerText = bestText;
        turnAnswerMarkdown = bestText;
      }
    }
    const minAnswerChars = 16;
    if (turnAnswerText.trim().length > 0 && turnAnswerText.trim().length < minAnswerChars) {
      const deadline = Date.now() + 12_000;
      let bestText = turnAnswerText.trim();
      let stableCycles = 0;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(
          Runtime,
          expectedPromptTurn.verifiedUserTurnIndex + 1,
          expectedPromptTurn.conversationId,
          expectedPromptTurn,
        ).catch(() => null);
        const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
        if (text && text.length > bestText.length) {
          bestText = text;
          stableCycles = 0;
        } else {
          stableCycles += 1;
        }
        if (stableCycles >= 3 && bestText.length >= minAnswerChars) {
          break;
        }
        await delay(400);
      }
      if (bestText.length > turnAnswerText.trim().length) {
        logger("Refreshed short assistant response from latest DOM snapshot");
        turnAnswerText = bestText;
        turnAnswerMarkdown = bestText;
      }
    }
    await assertCommittedPromptEpochCurrent(Runtime, expectedPromptTurn);
    return {
      label,
      answerText: turnAnswerText,
      answerMarkdown: turnAnswerMarkdown,
      answerHtml: turnAnswerHtml,
    };
  };

  const turns: BrowserConversationTurn[] = [];
  let remainingFollowUpsToCapture = followUpPrompts.length;
  const initialTurn = await captureAssistantTurn(promptText, "Initial response");
  turns.push(initialTurn);
  let answerText = initialTurn.answerText;
  let answerMarkdown = initialTurn.answerMarkdown;
  let answerHtml = initialTurn.answerHtml;

  for (let index = 0; index < followUpPrompts.length; index += 1) {
    const followUpPrompt = followUpPrompts[index];
    logger(`[browser] Sending follow-up ${index + 1}/${followUpPrompts.length}`);
    await acquireProfileLockIfNeeded();
    try {
      const submission = await runSubmissionWithRecovery({
        prompt: followUpPrompt,
        attachments: [],
        submit: (submissionPrompt, submissionAttachments) =>
          raceWithDisconnect(
            submitOnce(
              submissionPrompt,
              submissionAttachments,
              index + 1,
              followUpPrompts.length - index - 1,
            ),
          ),
        reloadPromptComposer,
        prepareFallbackSubmission: () => lifecycle.resetPrompt(),
        logger,
      });
      promptLocator = submission.promptLocator;
      baselineAssistantText = submission.baselineAssistantText;
    } finally {
      await releaseProfileLockIfHeld();
    }
    const turn = await captureAssistantTurn(followUpPrompt, `Follow-up ${index + 1}`);
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
  if (state.connectionClosedUnexpectedly) {
    throw new Error("Chrome disconnected before complete answer capture");
  }
  return {
    kind: "standard",
    promptLocator,
    answerText,
    answerMarkdown,
    answerHtml,
  };
}
