import { BrowserAutomationError } from "../oracle/errors.js";
import { formatElapsed } from "../oracle/format.js";
import { startThinkingStatusMonitor } from "./actions/thinkingStatus.js";
import {
  captureAssistantMarkdown,
  readAssistantSnapshot,
  waitForResumedConversationHydration,
} from "./pageActions.js";
import { captureBrowserDiagnostics } from "./domDebug.js";
import { delay, withRetries } from "./utils.js";
import { alignPromptEchoPair, buildPromptEchoMatcher } from "./reattachHelpers.js";
import { isStableConversationUrl as isConversationUrl } from "./conversationUrl.js";
import {
  assertCommittedPromptEpochCurrent,
  readConversationUrl,
} from "./archiveSettlementCoordinator.js";
import { createAssistantTimeoutError } from "./browserFailureProjection.js";
import {
  attemptAssistantRecheckOrRethrow,
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
import type { CommittedPromptEpochLocator } from "./reattachability.js";
import type { RemoteBrowserExecutionContext } from "./remoteExecutionContext.js";
import type { RemoteBrowserTarget } from "./remoteTargetAcquisition.js";

export interface RemoteCapturedAssistantTurn extends BrowserConversationTurn {
  answerHtml: string;
}

async function waitWithThinkingMonitor<T>(
  context: RemoteBrowserExecutionContext,
  target: RemoteBrowserTarget,
  operation: () => Promise<T>,
): Promise<T> {
  context.stopThinkingMonitor?.();
  context.stopThinkingMonitor = startThinkingStatusMonitor(target.Runtime, context.logger, {
    intervalMs: context.options.heartbeatIntervalMs,
  });
  try {
    return await operation();
  } finally {
    context.stopThinkingMonitor?.();
    context.stopThinkingMonitor = null;
  }
}

async function attemptRemoteAssistantRecheck(
  context: RemoteBrowserExecutionContext,
  target: RemoteBrowserTarget,
  expectedPromptTurn: CommittedPromptEpochLocator,
  imageOutputRequested: boolean,
): Promise<AssistantAnswer | null> {
  const { config, logger } = context;
  const { Runtime, Page } = target;
  const recheckDelayMs = Math.max(0, config.assistantRecheckDelayMs ?? 0);
  const recheckTimeoutMs = Math.max(0, config.assistantRecheckTimeoutMs ?? 0);
  if (!recheckDelayMs) return null;
  logger(
    `[browser] Assistant response timed out; waiting ${formatElapsed(recheckDelayMs)} before rechecking conversation.`,
  );
  await delay(recheckDelayMs);
  const conversationUrl = await readConversationUrl(Runtime);
  if (conversationUrl && isConversationUrl(conversationUrl)) {
    context.lastUrl = conversationUrl;
    logger(`[browser] Rechecking assistant response at ${conversationUrl}`);
    await Page.navigate({ url: conversationUrl });
    await waitForResumedConversationHydration(Runtime, recheckTimeoutMs || 30_000, logger, {
      requirePriorTurns: true,
      requirePromptReady: false,
      expectedConversationUrl: conversationUrl,
    });
  }
  const sessionValid = await validateChatGPTSession(Runtime, logger);
  if (!sessionValid.valid) {
    logger(`[browser] Session validation failed: ${sessionValid.reason}`);
    await context.emitRuntimeHint();
    throw new BrowserAutomationError(
      `ChatGPT session expired during recheck: ${sessionValid.reason}. ` +
        `Conversation URL: ${conversationUrl || context.lastUrl || "unknown"}. ` +
        "Please sign in and retry.",
      {
        stage: "assistant-recheck",
        details: {
          conversationUrl: conversationUrl || context.lastUrl || null,
          sessionStatus: "needs_login",
          validationReason: sessionValid.reason,
        },
        runtime: context.buildRuntimeMetadata(),
      },
    );
  }
  await context.emitRuntimeHint();
  const timeoutMs = recheckTimeoutMs > 0 ? recheckTimeoutMs : config.timeoutMs;
  const rechecked = await waitWithThinkingMonitor(context, target, () =>
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
  );
  logger("Recovered assistant response after delayed recheck");
  return rechecked;
}

export async function captureRemoteAssistantTurn(
  context: RemoteBrowserExecutionContext,
  target: RemoteBrowserTarget,
  turnPrompt: string,
  label: string,
  expectedPromptTurn: CommittedPromptEpochLocator,
  baselineAssistantText: string | null,
  imageOutputRequested: boolean,
): Promise<RemoteCapturedAssistantTurn> {
  const { Runtime, Page, activeConversationUrlMonitor } = target;
  const { config, logger, options } = context;
  let turnAnswer: AssistantAnswer;
  try {
    await activeConversationUrlMonitor.update("assistant-wait", 15_000).catch(() => false);
    turnAnswer = await waitWithThinkingMonitor(context, target, () =>
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
    );
  } catch (error) {
    if (isAssistantResponseTimeoutError(error)) {
      const rechecked = await attemptAssistantRecheckOrRethrow(() =>
        attemptRemoteAssistantRecheck(context, target, expectedPromptTurn, imageOutputRequested),
      );
      if (rechecked) {
        turnAnswer = rechecked;
      } else {
        await activeConversationUrlMonitor.update("assistant-timeout", 15_000).catch(() => false);
        const diagnostics = await captureBrowserDiagnostics(Runtime, logger, "assistant-timeout", {
          Page,
          sessionId: options.sessionId,
        }).catch(() => undefined);
        const runtime = context.buildRuntimeMetadata();
        throw await createAssistantTimeoutError({
          Runtime,
          logger,
          runtime,
          diagnostics,
          cause: error,
        });
      }
    } else {
      throw error;
    }
  }
  await activeConversationUrlMonitor.update("post-response", 15_000).catch(() => false);
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
  const copiedMarkdown = await withRetries(
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
  await assertCommittedPromptEpochCurrent(Runtime, expectedPromptTurn);
  return {
    label,
    answerText: turnAnswerText,
    answerMarkdown: turnAnswerMarkdown,
    answerHtml: turnAnswerHtml,
  };
}
