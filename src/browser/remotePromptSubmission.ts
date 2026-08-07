import path from "node:path";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  clearPromptComposer,
  clearComposerAttachments,
  ensurePromptReady,
  readAssistantSnapshot,
  waitForAttachmentCompletion,
} from "./pageActions.js";
import { uploadAttachmentViaDataTransfer } from "./actions/remoteFileTransfer.js";
import { activateDeepResearch } from "./actions/deepResearch.js";
import { delay, withRetries } from "./utils.js";
import { runProviderSubmissionFlow } from "./providerDomFlow.js";
import { chatgptDomProvider, createChatgptDomProviderState } from "./providers/index.js";
import { readConversationTurnCount } from "./responseCaptureCoordinator.js";
import { captureDeepResearchTargetBaseline } from "./promptSubmissionCoordinator.js";
import { requireCommittedPromptLocator } from "./archiveSettlementCoordinator.js";
import type { BrowserSubmissionResult } from "./archiveSettlementCoordinator.js";
import type { BrowserAttachment } from "./types.js";
import type { RemoteBrowserExecutionContext } from "./remoteExecutionContext.js";
import type { RemoteBrowserTarget } from "./remoteTargetAcquisition.js";

export async function submitRemotePromptOnce(
  context: RemoteBrowserExecutionContext,
  target: RemoteBrowserTarget,
  prompt: string,
  submissionAttachments: BrowserAttachment[],
  followUpOrdinal: number,
  remainingFollowUps: number,
  deepResearch: boolean,
): Promise<BrowserSubmissionResult> {
  const { config, logger, options, lifecycle } = context;
  const { Runtime, Input, DOM, client } = target;
  await lifecycle.resetPrompt();
  const baselineSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);
  const baselineAssistantText =
    typeof baselineSnapshot?.text === "string" ? baselineSnapshot.text.trim() : "";
  const dispatchBaselineTurns = await readConversationTurnCount(Runtime, logger);
  if (dispatchBaselineTurns === null) {
    throw new BrowserAutomationError(
      "Unable to capture the pre-dispatch conversation baseline; refusing to submit the prompt.",
      { stage: "submit-prompt", code: "prompt-baseline-unavailable" },
    );
  }
  const promptEpochIdentity = await lifecycle.beginPromptDispatch(
    prompt,
    dispatchBaselineTurns,
    followUpOrdinal,
    remainingFollowUps,
  );
  let baselineTurns = dispatchBaselineTurns;
  const attachmentNames = submissionAttachments.map((attachment) => path.basename(attachment.path));
  const attachmentExpectations = submissionAttachments.map((attachment) => ({
    name: path.basename(attachment.path),
    generatedBundle: attachment.generatedBundle === true,
  }));
  await clearPromptComposer(Runtime, logger);
  await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
  if (submissionAttachments.length > 0) {
    if (!DOM) {
      throw new Error("Chrome DOM domain unavailable while uploading attachments.");
    }
    await clearComposerAttachments(Runtime, 5_000, logger);
    for (const attachment of submissionAttachments) {
      logger(`Uploading attachment: ${attachment.displayPath}`);
      await uploadAttachmentViaDataTransfer({ runtime: Runtime, dom: DOM }, attachment, logger);
      await delay(500);
    }
    const baseTimeout = config.inputTimeoutMs ?? 30_000;
    const perFileTimeout = 15_000;
    const waitBudget =
      Math.max(baseTimeout, 30_000) + (submissionAttachments.length - 1) * perFileTimeout;
    const attachmentWaitBudget = Math.max(config.attachmentTimeoutMs ?? 0, waitBudget);
    await waitForAttachmentCompletion(Runtime, attachmentWaitBudget, attachmentNames, logger);
    logger("All attachments uploaded");
  }
  if (deepResearch) {
    await withRetries(() => activateDeepResearch(Runtime, Input, logger), {
      retries: 2,
      delayMs: 500,
      onRetry: (attempt, error) => {
        if (options.verbose) {
          logger(
            `[retry] Deep Research activation attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
          );
        }
      },
    });
    await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
    logger(
      `Prompt textarea ready (after Deep Research activation, ${prompt.length.toLocaleString()} chars queued)`,
    );
  }
  const providerState = createChatgptDomProviderState({
    runtime: Runtime,
    input: Input,
    logger,
    timeoutMs: config.timeoutMs,
    inputTimeoutMs: config.inputTimeoutMs ?? undefined,
    attachmentTimeoutMs: config.attachmentTimeoutMs ?? undefined,
    baselineTurns: dispatchBaselineTurns,
    attachmentNames: attachmentExpectations,
  });
  const deepResearchTargetBaseline = deepResearch
    ? await captureDeepResearchTargetBaseline(client, logger)
    : undefined;
  const commitEvidence = await Promise.race([
    runProviderSubmissionFlow(chatgptDomProvider, {
      prompt,
      evaluate: async () => undefined,
      delay,
      log: logger,
      state: providerState,
    }),
    context.disconnectPromise,
  ]);
  await lifecycle.recordPromptCommitEvidence(commitEvidence, promptEpochIdentity);
  const promptLocator = requireCommittedPromptLocator(lifecycle);
  const providerBaselineTurns = providerState.baselineTurns;
  if (typeof providerBaselineTurns === "number" && Number.isFinite(providerBaselineTurns)) {
    baselineTurns = providerBaselineTurns;
  }
  return {
    promptLocator,
    baselineTurns,
    baselineAssistantText,
    deepResearchTargetKeys: deepResearchTargetBaseline?.targetKeys,
    deepResearchTargetBaselineCaptured: deepResearchTargetBaseline?.captured,
  };
}
