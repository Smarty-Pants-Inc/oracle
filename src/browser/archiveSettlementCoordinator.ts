import type { BrowserModelSelectionEvidence } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  archiveChatGptConversation,
  resolveBrowserArchiveDecision,
} from "./actions/archiveConversation.js";
import { readAssistantSnapshot, verifyCommittedPromptTurn } from "./pageActions.js";
import { isStableConversationUrl as isConversationUrl } from "./conversationUrl.js";
import {
  resolveCommittedPromptEpochLocator,
  type CommittedPromptEpochLocator,
} from "./reattachability.js";
import { BrowserRunLifecycleController } from "./runLifecycle.js";
import type {
  BrowserArchiveResult,
  BrowserCaptureFinalizationResult,
  BrowserLogger,
  BrowserRunOptions,
  ChromeClient,
  ResolvedBrowserConfig,
} from "./types.js";
// Browser archive, prompt identity, and unpublished settlement helpers.
export async function readConversationUrl(
  Runtime: ChromeClient["Runtime"],
): Promise<string | null> {
  try {
    const currentUrl = await Runtime.evaluate({ expression: "location.href", returnByValue: true });
    return typeof currentUrl.result?.value === "string" ? currentUrl.result.value : null;
  } catch {
    return null;
  }
}
export async function maybeArchiveCompletedConversation({
  Runtime,
  logger,
  config,
  conversationUrl,
  followUpCount,
  requiredArtifactsSaved,
}: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  config: ResolvedBrowserConfig;
  conversationUrl?: string | null;
  followUpCount: number;
  requiredArtifactsSaved: boolean;
}): Promise<BrowserArchiveResult> {
  const decision = resolveBrowserArchiveDecision({
    mode: config.archiveConversations,
    chatgptUrl: config.chatgptUrl ?? config.url,
    conversationUrl,
    researchMode: config.researchMode,
    followUpCount,
  });
  if (!decision.shouldArchive) {
    logger(`[browser] ChatGPT archive skipped (${decision.reason}).`);
    return {
      mode: decision.mode,
      attempted: false,
      archived: false,
      reason: decision.reason,
      conversationUrl: conversationUrl ?? undefined,
    };
  }
  if (!requiredArtifactsSaved) {
    logger("[browser] ChatGPT archive skipped (artifact-save-failed).");
    return {
      mode: decision.mode,
      attempted: false,
      archived: false,
      reason: "artifact-save-failed",
      conversationUrl: conversationUrl ?? undefined,
    };
  }
  return runChatGptArchive({
    Runtime,
    logger,
    mode: decision.mode,
    conversationUrl,
  });
}

export async function maybeArchiveInterruptedConversation({
  Runtime,
  logger,
  config,
  conversationUrl,
  followUpCount,
}: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  config: ResolvedBrowserConfig;
  conversationUrl?: string | null;
  followUpCount: number;
}): Promise<BrowserArchiveResult | null> {
  const currentUrl = await readConversationUrl(Runtime);
  const resolvedUrl = currentUrl && isConversationUrl(currentUrl) ? currentUrl : conversationUrl;
  if (!resolvedUrl || !isConversationUrl(resolvedUrl)) {
    return null;
  }
  const decision = resolveBrowserArchiveDecision({
    mode: config.archiveConversations,
    chatgptUrl: config.chatgptUrl ?? config.url,
    conversationUrl: resolvedUrl,
    researchMode: config.researchMode,
    followUpCount,
  });
  if (!decision.shouldArchive) {
    logger(`[browser] ChatGPT archive skipped after interrupted run (${decision.reason}).`);
    return {
      mode: decision.mode,
      attempted: false,
      archived: false,
      reason: decision.reason,
      conversationUrl: resolvedUrl,
    };
  }
  logger("[browser] Attempting to archive interrupted ChatGPT conversation.");
  return runChatGptArchive({
    Runtime,
    logger,
    mode: decision.mode,
    conversationUrl: resolvedUrl,
  });
}

async function runChatGptArchive({
  Runtime,
  logger,
  mode,
  conversationUrl,
}: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  mode: BrowserArchiveResult["mode"];
  conversationUrl?: string | null;
}): Promise<BrowserArchiveResult> {
  return archiveChatGptConversation(Runtime, logger, {
    mode,
    conversationUrl,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] ChatGPT archive failed (${message}).`);
    return {
      mode,
      attempted: true,
      archived: false,
      reason: "archive-failed",
      conversationUrl: conversationUrl ?? undefined,
      error: message,
    };
  });
}

export function withInterruptedArchiveDetails(
  error: Error,
  archive: BrowserArchiveResult | null,
): Error {
  if (!archive || !(error instanceof BrowserAutomationError)) {
    return error;
  }
  return new BrowserAutomationError(
    error.message,
    {
      ...(error.details ?? {}),
      archive,
    },
    error,
  );
}

export function unpublishedCleanupPendingError(
  finalization: Extract<BrowserCaptureFinalizationResult, { status: "pending" }>,
  cause?: unknown,
): BrowserAutomationError {
  return new BrowserAutomationError(
    `Browser cleanup remains pending: ${finalization.error}`,
    {
      stage: "browser-capture-finalization",
      code: "unpublished-cleanup-pending",
      runtime: finalization.runtime,
      cleanupError: finalization.error,
    },
    cause,
  );
}

export type BrowserAcquisitionPendingResource = "tab-lease" | "chrome-process" | "chrome-target";

export async function persistCompletedUnpublishedFinalization(
  finalization: BrowserCaptureFinalizationResult | null | undefined,
  runtimeHintCb: BrowserRunOptions["runtimeHintCb"],
  modelSelectionEvidence: BrowserModelSelectionEvidence | undefined,
  escapingFailure?: unknown,
): Promise<void> {
  if (finalization?.status !== "completed" || !runtimeHintCb) return;
  try {
    await runtimeHintCb(finalization.runtime, modelSelectionEvidence);
  } catch (error) {
    const persistenceError = error instanceof Error ? error.message : String(error);
    throw new BrowserAutomationError(
      `Browser cleanup completed, but its final runtime could not be persisted: ${persistenceError}`,
      {
        stage: "browser-capture-finalization",
        code: "completed-cleanup-persistence-failed",
        runtime: finalization.runtime,
        persistenceError,
      },
      escapingFailure ?? error,
    );
  }
}

export function maybeArchiveCompletedConversationForTest(
  args: Parameters<typeof maybeArchiveCompletedConversation>[0],
): Promise<BrowserArchiveResult> {
  return maybeArchiveCompletedConversation(args);
}

export function maybeArchiveInterruptedConversationForTest(
  args: Parameters<typeof maybeArchiveInterruptedConversation>[0],
): Promise<BrowserArchiveResult | null> {
  return maybeArchiveInterruptedConversation(args);
}

export type BrowserSubmissionResult = {
  baselineTurns: number | null;
  promptLocator: CommittedPromptEpochLocator;
  baselineAssistantText: string | null;
  deepResearchTargetKeys?: string[];
  deepResearchTargetBaselineCaptured?: boolean;
};

export function requireCommittedPromptLocator(
  lifecycle: BrowserRunLifecycleController,
): CommittedPromptEpochLocator {
  const epoch = lifecycle.promptEpoch();
  const locator = resolveCommittedPromptEpochLocator({
    promptEpoch: epoch,
    conversationId: epoch?.status === "committed" ? epoch.conversationId : undefined,
  });
  if (!locator) {
    throw new BrowserAutomationError(
      "Prompt commit evidence did not produce a valid committed prompt epoch locator.",
      { stage: "prompt-epoch", code: "prompt-epoch-evidence-missing" },
    );
  }
  return locator;
}

export async function assertCommittedPromptEpochCurrent(
  Runtime: ChromeClient["Runtime"],
  locator: CommittedPromptEpochLocator,
) {
  await verifyCommittedPromptTurn(Runtime, locator);
  const snapshot = await readAssistantSnapshot(
    Runtime,
    locator.verifiedUserTurnIndex + 1,
    locator.conversationId,
    locator,
  );
  if (!snapshot) {
    throw new BrowserAutomationError(
      "Assistant response no longer belongs to the committed prompt epoch.",
      { stage: "prompt-epoch", code: "committed-prompt-identity-mismatch" },
    );
  }
  return snapshot;
}

/**
 * An archive confirmation may deliberately navigate the controlled tab away
 * from its conversation. In that one confirmed case, the exact answer was
 * already verified before archiving and its source is no longer inspectable.
 * A conversation route, including a different conversation, remains subject
 * to the full committed-turn proof.
 */
export async function assertPostArchivePromptEpochCurrent(
  Runtime: ChromeClient["Runtime"],
  locator: CommittedPromptEpochLocator,
  archive: BrowserArchiveResult,
): Promise<void> {
  if (archive.archived) {
    const postArchiveUrl = await readConversationUrl(Runtime);
    if (postArchiveUrl && !isConversationUrl(postArchiveUrl)) return;
  }
  await assertCommittedPromptEpochCurrent(Runtime, locator);
}

export function createPromptEpochGuardedRuntime(
  Runtime: ChromeClient["Runtime"],
  locator: CommittedPromptEpochLocator,
): ChromeClient["Runtime"] {
  const evaluate: ChromeClient["Runtime"]["evaluate"] = async (params) => {
    await assertCommittedPromptEpochCurrent(Runtime, locator);
    const result = await Runtime.evaluate(params);
    await assertCommittedPromptEpochCurrent(Runtime, locator);
    return result;
  };
  return { evaluate } as ChromeClient["Runtime"];
}
