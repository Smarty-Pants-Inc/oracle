import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import {
  captureAssistantMarkdown,
  waitForAssistantResponse,
  waitForResumedConversationHydration,
  verifyCommittedPromptTurn,
} from "./pageActions.js";
import { waitForDeepResearchCompletion } from "./actions/deepResearch.js";
import { resolveBrowserConfig } from "./config.js";
import { buildCommittedConversationUrl } from "./reattachAcquisition.js";
import type { ReattachCapture, ReattachDeps } from "./reattachContracts.js";
import { classifyReattachFailure } from "./reattachPlan.js";
import type { CommittedPromptEpochLocator } from "./reattachability.js";
import { extractRecoverableConversationId } from "./reattachTargetSelection.js";
import {
  openConversationFromSidebarWithRetry,
  waitForLocationChange,
  withTimeout,
} from "./reattachHelpers.js";
import type { SessionBoundChromeClient } from "./chromeSessionTransport.js";
import type { BrowserLogger } from "./types.js";

export async function captureCommittedChatGptReattach(
  runtime: BrowserRuntimeMetadata,
  sourceRuntime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  client: SessionBoundChromeClient,
  promptLocator: CommittedPromptEpochLocator,
  targetId: string,
  logger: BrowserLogger,
  deps: ReattachDeps,
  warnings?: ReattachCapture["warnings"],
): Promise<ReattachCapture> {
  const { Runtime, Page } = client;
  const timeoutMs = config?.timeoutMs ?? 120_000;
  const minAssistantTurnIndex = promptLocator.verifiedUserTurnIndex + 1;
  const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
  await classifyReattachFailure(
    "recoverable-transport",
    `Chrome target ${targetId} did not respond to the reattach probe.`,
    async () =>
      withTimeout(
        Runtime.evaluate({ expression: "1+1", returnByValue: true }),
        pingTimeoutMs,
        "Reattach target did not respond",
      ),
  );
  await classifyReattachFailure(
    "stale-runtime",
    `Chrome target ${targetId} no longer exposes the committed conversation.`,
    async () => {
      const { result } = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      const href = typeof result?.value === "string" ? result.value : "";
      if (extractRecoverableConversationId(href) === promptLocator.conversationId) return;
      const opened = await openConversationFromSidebarWithRetry(
        Runtime,
        { conversationId: promptLocator.conversationId, preferProjects: true },
        15_000,
      );
      if (!opened) throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
      await waitForLocationChange(Runtime, 15_000);
    },
  );
  const waitForHydration = deps.waitForConversationHydration ?? waitForResumedConversationHydration;
  const expectedConversationUrl = buildCommittedConversationUrl(
    sourceRuntime,
    resolveBrowserConfig(config ?? {}).url,
    promptLocator.conversationId,
  );
  await classifyReattachFailure(
    "stale-runtime",
    `Chrome target ${targetId} did not hydrate the committed conversation.`,
    async () =>
      waitForHydration(Runtime, timeoutMs, logger, {
        requirePriorTurns: true,
        requirePromptReady: false,
        expectedConversationUrl: expectedConversationUrl ?? undefined,
      }),
  );
  await (deps.verifyCommittedPromptTurn ?? verifyCommittedPromptTurn)(Runtime, promptLocator);

  if (config?.researchMode === "deep") {
    const researchResult = await withTimeout(
      (deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion)(
        Runtime,
        logger,
        timeoutMs,
        minAssistantTurnIndex,
        Page,
        client,
        {
          requireScopedTargetOwner: true,
          expectedConversationId: promptLocator.conversationId,
          expectedPromptTurn: promptLocator,
        },
      ),
      timeoutMs + 5_000,
      "Reattach Deep Research response timed out",
    );
    return {
      answerText: researchResult.text,
      answerMarkdown: researchResult.text,
      runtime,
      ...(warnings ? { warnings } : {}),
    };
  }

  const answer = await withTimeout(
    (deps.waitForAssistantResponse ?? waitForAssistantResponse)(
      Runtime,
      timeoutMs,
      logger,
      minAssistantTurnIndex,
      promptLocator.conversationId,
      promptLocator,
    ),
    timeoutMs + 5_000,
    "Reattach response timed out",
  );
  const markdown =
    (await withTimeout(
      (deps.captureAssistantMarkdown ?? captureAssistantMarkdown)(
        Runtime,
        answer.meta,
        logger,
        promptLocator.conversationId,
        promptLocator,
      ),
      15_000,
      "Reattach markdown capture timed out",
    )) ?? answer.text;
  return {
    answerText: answer.text,
    answerMarkdown: markdown,
    runtime,
    ...(warnings ? { warnings } : {}),
  };
}
