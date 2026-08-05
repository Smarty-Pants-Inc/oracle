import { mkdir } from "node:fs/promises";
import { connectToRemoteChrome } from "./chromeLifecycle.js";
import { clearStaleChatGptConversationCookies } from "./cookies.js";
import {
  navigateToChatGPT,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
  ensureChatMode,
  waitForResumedConversationHydration,
  ensureChatGptScopeRetained,
  installJavaScriptDialogAutoDismissal,
  ensureModelSelection,
} from "./pageActions.js";
import { ensureThinkingTime } from "./actions/thinkingTime.js";
import { withRetries } from "./utils.js";
import { DEFAULT_MODEL_STRATEGY } from "./constants.js";
import { captureProfileDirectoryIdentity } from "./profileState.js";
import { acquireBrowserTabLease } from "./tabLeaseRegistry.js";
import { connectToExistingChatGptTab } from "./liveTabs.js";
import {
  createConversationUrlMonitor,
  type ConversationUrlMonitor,
} from "./conversationUrlMonitor.js";
import { extractStableConversationIdFromUrl as extractConversationIdFromUrl } from "./conversationUrl.js";
import { buildSkippedModelSelectionEvidence } from "./promptSubmissionCoordinator.js";
import { enableFocusEmulation } from "./coordinatorPolicy.js";
import { installRemoteDisconnectHandler } from "./remoteDisconnectSettlement.js";
import type { ChromeClient } from "./types.js";
import type { RemoteBrowserExecutionContext } from "./remoteExecutionContext.js";

export interface RemoteBrowserTarget {
  client: ChromeClient;
  Network: ChromeClient["Network"];
  Page: ChromeClient["Page"];
  Runtime: ChromeClient["Runtime"];
  Input: ChromeClient["Input"];
  DOM: ChromeClient["DOM"];
  Target: ChromeClient["Target"];
  activeConversationUrlMonitor: ConversationUrlMonitor;
}

export async function acquireRemoteBrowserTarget(
  context: RemoteBrowserExecutionContext,
): Promise<RemoteBrowserTarget> {
  const {
    config,
    logger,
    options,
    host,
    port,
    browserWSEndpoint,
    remoteLeaseProfileDir,
    acquisitionLeaseId,
    acquisitionTargetMarkerUrl,
    promptText,
  } = context;

  if (remoteLeaseProfileDir) {
    await mkdir(remoteLeaseProfileDir, { recursive: true });
    context.remoteLeaseProfileIdentity =
      await captureProfileDirectoryIdentity(remoteLeaseProfileDir);
    await context.persistRuntime("tab-lease");
    context.tabLease = await acquireBrowserTabLease(remoteLeaseProfileDir, {
      maxConcurrentTabs: config.maxConcurrentTabs,
      timeoutMs: config.timeoutMs,
      logger,
      sessionId: options.sessionId,
      chromeHost: host,
      chromePort: port,
      leaseId: acquisitionLeaseId,
    });
  }
  if (config.browserTabRef) {
    const attached = await connectToExistingChatGptTab({
      host,
      port,
      ref: config.browserTabRef,
    });
    context.client = attached.client;
    context.remoteTargetId = attached.targetId ?? null;
    context.lastUrl = attached.tab.url || context.lastUrl;
    context.attachedExistingTab = true;
    context.ownsTarget = false;
    logger(
      `Attached to existing remote ChatGPT tab ${attached.targetId}${attached.tab.url ? ` (${attached.tab.url})` : ""}`,
    );
  } else {
    await context.persistRuntime("chrome-target");
    context.connection = await connectToRemoteChrome(
      host,
      port,
      logger,
      acquisitionTargetMarkerUrl,
      browserWSEndpoint,
      {
        approvalWaitMs: config.attachRunning && browserWSEndpoint ? 20_000 : undefined,
      },
    );
    context.client = context.connection.client;
    context.remoteTargetId = context.connection.targetId;
    context.ownsTarget = context.connection.ownership === "created";
    context.attachedExistingTab = context.connection.ownership === "attached";
  }
  await context.persistRuntime();
  if (context.tabLease && context.remoteTargetId) {
    await context.tabLease.update({
      chromeHost: host,
      chromePort: port,
      chromeTargetId: context.remoteTargetId,
    });
  }

  const client = context.client;
  if (!client) {
    throw new Error("Remote Chrome target acquisition did not produce a client.");
  }
  installRemoteDisconnectHandler(context, client);
  const { Network, Page, Runtime, Input, DOM, Target } = client;

  const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
  if (DOM && typeof DOM.enable === "function") {
    domainEnablers.push(DOM.enable());
  }
  await Promise.race([Promise.all(domainEnablers), context.disconnectPromise]);
  context.lifecycle.markAcquired();
  context.removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);
  await enableFocusEmulation(client, logger, "remote target");

  const activeConversationUrlMonitor = createConversationUrlMonitor({
    readUrl: async () => {
      const { result } = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      return typeof result?.value === "string" ? result.value : null;
    },
    persistUrl: async (url) => {
      context.lastUrl = url;
      await context.emitRuntimeHint();
    },
    logger,
  });
  context.conversationUrlMonitor = activeConversationUrlMonitor;

  logger("Skipping cookie sync for remote Chrome (using existing session)");
  await clearStaleChatGptConversationCookies(Network, Target, logger, {
    preserveConversationIds: [
      extractConversationIdFromUrl(config.resumeConversationUrl ?? ""),
      extractConversationIdFromUrl(context.lastUrl ?? ""),
    ],
  });

  if (config.resumeConversationUrl) {
    await navigateToChatGPT(Page, Runtime, config.resumeConversationUrl, logger);
  } else if (!context.attachedExistingTab) {
    await navigateToChatGPT(Page, Runtime, config.url, logger);
  }
  await ensureNotBlocked(Runtime, config.headless, logger);
  await ensureLoggedIn(Runtime, logger, { remoteSession: true });
  await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
  if (config.resumeConversationUrl) {
    await waitForResumedConversationHydration(Runtime, config.inputTimeoutMs, logger, {
      requirePriorTurns: true,
      expectedConversationUrl: config.resumeConversationUrl,
    });
  }
  const chatMode = await ensureChatMode(Runtime, Input, config.inputTimeoutMs, logger, {
    resetWorkConversation:
      context.attachedExistingTab && !config.resumeConversationUrl
        ? async () => {
            await navigateToChatGPT(Page, Runtime, config.url, logger);
            await ensureNotBlocked(Runtime, config.headless, logger);
            await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
          }
        : undefined,
  });
  if (chatMode === "switched") {
    await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
    await ensureChatGptScopeRetained(Runtime, config.url);
  }
  logger(
    `Prompt textarea ready (initial focus, ${promptText.length.toLocaleString()} chars queued)`,
  );
  try {
    const { result } = await Runtime.evaluate({
      expression: "location.href",
      returnByValue: true,
    });
    if (typeof result?.value === "string") {
      context.lastUrl = result.value;
    }
    await context.emitRuntimeHint();
  } catch {
    // ignore
  }

  const modelStrategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
  if (config.desiredModel && modelStrategy !== "ignore" && !config.resumeConversationUrl) {
    context.modelSelectionEvidence = await withRetries(
      () => ensureModelSelection(Runtime, config.desiredModel as string, logger, modelStrategy),
      {
        retries: 2,
        delayMs: 300,
        onRetry: (attempt, error) => {
          if (options.verbose) {
            logger(
              `[retry] Model picker attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
            );
          }
        },
      },
    );
    await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
    logger(
      `Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`,
    );
  } else if (modelStrategy === "ignore" || config.resumeConversationUrl) {
    context.modelSelectionEvidence = buildSkippedModelSelectionEvidence(
      config.desiredModel,
      modelStrategy,
    );
    logger(
      config.resumeConversationUrl
        ? "Model picker: skipped (resumed conversation)"
        : "Model picker: skipped (strategy=ignore)",
    );
  }
  const deepResearch = config.researchMode === "deep";
  const thinkingTime = config.thinkingTime;
  if (thinkingTime && !deepResearch) {
    const thinkingTargetModel = modelStrategy === "select" ? config.desiredModel : null;
    await withRetries(
      () => ensureThinkingTime(Runtime, thinkingTime, logger, thinkingTargetModel),
      {
        retries: 2,
        delayMs: 300,
        onRetry: (attempt, error) => {
          if (options.verbose) {
            logger(
              `[retry] Thinking time (${thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
            );
          }
        },
      },
    );
  }

  return { client, Network, Page, Runtime, Input, DOM, Target, activeConversationUrlMonitor };
}
