import path from "node:path";
import { BrowserAutomationError } from "../oracle/errors.js";
import { DEFAULT_MODEL_STRATEGY, CHATGPT_URL } from "./constants.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import {
  clearComposerAttachments,
  clearPromptComposer,
  ensureChatMode,
  ensureLoggedIn,
  ensureModelSelection,
  ensureNotBlocked,
  ensurePromptReady,
  installJavaScriptDialogAutoDismissal,
  navigateToChatGPT,
  navigateToPromptReadyWithFallback,
  readAssistantSnapshot,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  waitForResumedConversationHydration,
  waitForUserTurnAttachments,
} from "./pageActions.js";
import { ensureThinkingTime } from "./actions/thinkingTime.js";
import { activateDeepResearch } from "./actions/deepResearch.js";
import { acquireProfileRunLock, type ProfileRunLock } from "./profileState.js";
import { runProviderSubmissionFlow } from "./providerDomFlow.js";
import { chatgptDomProvider, createChatgptDomProviderState } from "./providers/index.js";
import { createConversationUrlMonitor } from "./conversationUrlMonitor.js";
import { extractStableConversationIdFromUrl as extractConversationIdFromUrl } from "./conversationUrl.js";
import {
  buildSkippedModelSelectionEvidence,
  captureDeepResearchTargetBaseline,
  runSubmissionWithRecovery,
} from "./promptSubmissionCoordinator.js";
import {
  enableFocusEmulation,
  normalizeAuthenticatedModelSelectionError,
} from "./coordinatorPolicy.js";
import { readConversationTurnCount } from "./responseCaptureCoordinator.js";
import {
  requireCommittedPromptLocator,
  type BrowserSubmissionResult,
} from "./archiveSettlementCoordinator.js";
import { positionChromeWindowOffscreen } from "./chromeLifecycle.js";
import { waitForLogin } from "./localExecutionContext.js";
import { delay, withRetries } from "./utils.js";
import type { CommittedPromptEpochLocator } from "./reattachability.js";
import type { LocalBrowserAcquisition } from "./localAcquisition.js";
import type { LocalDisconnectCoordinator } from "./localDisconnectRecovery.js";
import type { LocalBrowserRunState } from "./localRunState.js";
import type { BrowserRunLifecycleController } from "./runLifecycle.js";
import type { BrowserAttachment, BrowserLogger, BrowserRunOptions } from "./types.js";
import type { SessionBoundChromeClient } from "./chromeSessionTransport.js";

export type LocalDisconnectRace = <T>(promise: Promise<T>) => Promise<T>;

export interface LocalPromptSubmissionResult extends BrowserSubmissionResult {
  baselineTurns: number;
  deepResearchTargetKeys?: string[];
  deepResearchTargetBaselineCaptured?: boolean;
}

export interface LocalPromptExecutionContext {
  acquisition: LocalBrowserAcquisition;
  state: LocalBrowserRunState;
  lifecycle: BrowserRunLifecycleController;
  disconnect: LocalDisconnectCoordinator;
  options: BrowserRunOptions;
  promptText: string;
  attachments: BrowserAttachment[];
  logger: BrowserLogger;
  isResumingConversation: boolean;
  followUpPrompts: string[];
  emitRuntimeHint: () => Promise<void>;
}

export interface LocalPromptExecutionResult {
  client: SessionBoundChromeClient;
  Network: SessionBoundChromeClient["Network"];
  Page: SessionBoundChromeClient["Page"];
  Runtime: SessionBoundChromeClient["Runtime"];
  Input: SessionBoundChromeClient["Input"];
  DOM: SessionBoundChromeClient["DOM"];
  raceWithDisconnect: LocalDisconnectRace;
  captureRuntimeSnapshot: () => Promise<void>;
  updateConversationHint: (label: string, timeoutMs?: number) => Promise<boolean>;
  acquireProfileLockIfNeeded: () => Promise<void>;
  releaseProfileLockIfHeld: () => Promise<void>;
  submitOnce: (
    prompt: string,
    attachments: BrowserAttachment[],
    followUpOrdinal: number,
    remainingFollowUps: number,
  ) => Promise<LocalPromptSubmissionResult>;
  reloadPromptComposer: () => Promise<void>;
  promptLocator: CommittedPromptEpochLocator;
  baselineAssistantText: string | null;
  deepResearch: boolean;
  deepResearchTargetKeys: string[];
  deepResearchTargetBaselineCaptured: boolean;
}

export async function executeLocalPrompt({
  acquisition,
  state,
  lifecycle,
  disconnect,
  options,
  promptText,
  attachments,
  logger,
  isResumingConversation,
  followUpPrompts,
  emitRuntimeHint,
}: LocalPromptExecutionContext): Promise<LocalPromptExecutionResult> {
  const {
    chrome,
    chromeHost,
    config,
    manualLogin,
    profileIsPreSigned,
    userDataDir,
    effectiveKeepBrowser,
  } = acquisition;
  const client = state.client;
  const browserClient = state.browserClient;
  if (!client || !browserClient) {
    throw new Error("Local Chrome target acquisition completed without its CDP clients.");
  }
  const raceWithDisconnect = disconnect.race;
  const { Network, Page, Runtime, Input, DOM } = client;

  const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
  if (DOM && typeof DOM.enable === "function") {
    domainEnablers.push(DOM.enable());
  }
  await raceWithDisconnect(Promise.all(domainEnablers));
  lifecycle.markAcquired();
  if (!config.headless && config.hideWindow) {
    await positionChromeWindowOffscreen(browserClient, logger);
  }
  // Trusted CDP input is ignored by ChatGPT when the window is hidden or occluded.
  await enableFocusEmulation(client, logger, "local target");
  state.removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);
  if (!profileIsPreSigned) {
    await Network.clearBrowserCookies();
  }

  let appliedCookies = 0;
  const manualLoginCookieSync = manualLogin && Boolean(config.manualLoginCookieSync);
  const cookieSyncEnabled = config.cookieSync && (!profileIsPreSigned || manualLoginCookieSync);
  if (cookieSyncEnabled) {
    if (manualLoginCookieSync) {
      logger(
        "Manual login mode: seeding persistent profile with cookies from your Chrome profile.",
      );
    }
    if (!config.inlineCookies) {
      logger(
        "Heads-up: macOS may prompt for your Keychain password to read Chrome cookies; use --copy or --render for manual flow.",
      );
    } else {
      logger("Applying inline cookies (skipping Chrome profile read and Keychain prompt)");
    }
    appliedCookies = await syncCookies(Network, config.url, config.chromeProfile, logger, {
      allowErrors: config.allowCookieErrors ?? false,
      filterNames: config.cookieNames ?? undefined,
      inlineCookies: config.inlineCookies ?? undefined,
      cookiePath: config.chromeCookiePath ?? undefined,
      waitMs: config.cookieSyncWaitMs ?? 0,
    });
    if (config.inlineCookies && appliedCookies === 0) {
      throw new Error("No inline cookies were applied; aborting before navigation.");
    }
    logger(
      appliedCookies > 0
        ? config.inlineCookies
          ? `Applied ${appliedCookies} inline cookies`
          : `Copied ${appliedCookies} cookies from Chrome profile ${config.chromeProfile ?? "Default"}`
        : config.inlineCookies
          ? "No inline cookies applied; continuing without session reuse"
          : "No Chrome cookies found; continuing without session reuse",
    );
  } else {
    logger(
      manualLogin
        ? "Skipping Chrome cookie sync (--browser-manual-login enabled); reuse the opened profile after signing in."
        : "Skipping Chrome cookie sync (--browser-no-cookie-sync)",
    );
  }
  await clearStaleChatGptConversationCookies(Network, browserClient.Target, logger, {
    preserveConversationIds: [
      extractConversationIdFromUrl(config.resumeConversationUrl ?? ""),
      extractConversationIdFromUrl(state.lastUrl ?? ""),
    ],
  });

  if (cookieSyncEnabled && !manualLogin && appliedCookies === 0 && !config.inlineCookies) {
    throw new BrowserAutomationError(
      "No ChatGPT cookies were applied from your Chrome profile; cannot proceed in browser mode. " +
        "Make sure ChatGPT is signed in in the selected profile, use --browser-manual-login / inline cookies, " +
        "or retry with --browser-cookie-wait 5s if Keychain prompts are slow.",
      {
        stage: "execute-browser",
        details: {
          profile: config.chromeProfile ?? "Default",
          cookiePath: config.chromeCookiePath ?? null,
          hint: "If macOS Keychain prompts or denies access, run oracle from a GUI session or use --copy/--render for the manual flow.",
        },
      },
    );
  }

  if (config.browserTabRef) {
    if (isResumingConversation) {
      await raceWithDisconnect(
        navigateToChatGPT(Page, Runtime, config.resumeConversationUrl as string, logger),
      );
    }
    await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
    await raceWithDisconnect(ensureLoggedIn(Runtime, logger));
    await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    if (isResumingConversation) {
      await raceWithDisconnect(
        waitForResumedConversationHydration(Runtime, config.inputTimeoutMs, logger, {
          requirePriorTurns: true,
          requirePromptReady: false,
          expectedConversationUrl: config.resumeConversationUrl as string,
        }),
      );
    }
  } else {
    const baseUrl = CHATGPT_URL;
    await raceWithDisconnect(navigateToChatGPT(Page, Runtime, baseUrl, logger));
    await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
    await raceWithDisconnect(
      waitForLogin({
        runtime: Runtime,
        logger,
        appliedCookies,
        manualLogin,
        failFastOnLoginCta: config.hideWindow,
        timeoutMs: config.timeoutMs,
        profileDir: userDataDir,
        keepBrowser: effectiveKeepBrowser,
      }),
    );

    if (isResumingConversation) {
      await raceWithDisconnect(
        navigateToChatGPT(Page, Runtime, config.resumeConversationUrl as string, logger),
      );
      await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    } else if (config.url !== baseUrl) {
      await raceWithDisconnect(
        navigateToPromptReadyWithFallback(Page, Runtime, {
          url: config.url,
          fallbackUrl: baseUrl,
          timeoutMs: config.inputTimeoutMs,
          headless: config.headless,
          logger,
        }),
      );
    } else {
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    }
    if (isResumingConversation) {
      await raceWithDisconnect(
        waitForResumedConversationHydration(Runtime, config.inputTimeoutMs, logger, {
          requirePriorTurns: true,
          expectedConversationUrl: config.resumeConversationUrl as string,
        }),
      );
    }
  }
  const chatMode = await raceWithDisconnect(
    ensureChatMode(Runtime, Input, config.inputTimeoutMs, logger, {
      resetWorkConversation:
        config.browserTabRef && !isResumingConversation
          ? async () => {
              await navigateToChatGPT(Page, Runtime, config.url, logger);
              await ensureNotBlocked(Runtime, config.headless, logger);
              await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
            }
          : undefined,
    }),
  );
  if (chatMode === "switched") {
    await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
  }
  logger(
    `Prompt textarea ready (initial focus, ${promptText.length.toLocaleString()} chars queued)`,
  );

  const captureRuntimeSnapshot = async () => {
    try {
      const info = await browserClient.Target.getTargetInfo({});
      state.lastTargetId = info?.targetInfo?.targetId ?? state.lastTargetId;
      state.lastUrl = info?.targetInfo?.url ?? state.lastUrl;
    } catch {
      // ignore
    }
    try {
      const { result } = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      if (typeof result?.value === "string") {
        state.lastUrl = result.value;
      }
    } catch {
      // ignore
    }
    if (state.lastUrl) {
      logger(`[browser] url = ${state.lastUrl}`);
    }
    if (chrome.port) {
      const suffix = state.lastTargetId ? ` target=${state.lastTargetId}` : "";
      if (state.lastUrl) {
        logger(
          `[reattach] chrome port=${chrome.port} host=${chromeHost} url=${state.lastUrl}${suffix}`,
        );
      } else {
        logger(`[reattach] chrome port=${chrome.port} host=${chromeHost}${suffix}`);
      }
      await emitRuntimeHint();
    }
  };
  const activeConversationUrlMonitor = createConversationUrlMonitor({
    readUrl: async () => {
      const { result } = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      return typeof result?.value === "string" ? result.value : null;
    },
    persistUrl: async (url) => {
      state.lastUrl = url;
      await emitRuntimeHint();
    },
    logger,
  });
  state.conversationUrlMonitor = activeConversationUrlMonitor;
  const updateConversationHint = activeConversationUrlMonitor.update;
  await captureRuntimeSnapshot();

  const modelStrategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
  if (config.desiredModel && modelStrategy !== "ignore" && !isResumingConversation) {
    state.modelSelectionEvidence = await raceWithDisconnect(
      withRetries(
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
      ),
    ).catch((error) => {
      throw normalizeAuthenticatedModelSelectionError(error);
    });
    await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    logger(
      `Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`,
    );
  } else if (modelStrategy === "ignore" || isResumingConversation) {
    state.modelSelectionEvidence = buildSkippedModelSelectionEvidence(
      config.desiredModel,
      modelStrategy,
    );
    logger(
      isResumingConversation
        ? "Model picker: skipped (resumed conversation)"
        : "Model picker: skipped (strategy=ignore)",
    );
  }
  const deepResearch = config.researchMode === "deep";
  const thinkingTime = config.thinkingTime;
  if (thinkingTime && !deepResearch) {
    const thinkingTargetModel = modelStrategy === "select" ? config.desiredModel : null;
    await raceWithDisconnect(
      withRetries(() => ensureThinkingTime(Runtime, thinkingTime, logger, thinkingTargetModel), {
        retries: 2,
        delayMs: 300,
        onRetry: (attempt, error) => {
          if (options.verbose) {
            logger(
              `[retry] Thinking time (${thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
            );
          }
        },
      }),
    );
  }

  const profileLockTimeoutMs = manualLogin ? (config.profileLockTimeoutMs ?? 0) : 0;
  let profileLock: ProfileRunLock | null = null;
  const acquireProfileLockIfNeeded = async () => {
    if (profileLockTimeoutMs <= 0) return;
    profileLock = await acquireProfileRunLock(userDataDir, {
      timeoutMs: profileLockTimeoutMs,
      logger,
    });
  };
  const releaseProfileLockIfHeld = async () => {
    if (!profileLock) return;
    const handle = profileLock;
    profileLock = null;
    await handle.release().catch(() => undefined);
  };
  const submitOnce = async (
    prompt: string,
    submissionAttachments: BrowserAttachment[],
    followUpOrdinal: number,
    remainingFollowUps: number,
  ): Promise<LocalPromptSubmissionResult> => {
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
    const attachmentNames = submissionAttachments.map((attachment) =>
      path.basename(attachment.path),
    );
    const attachmentExpectations = submissionAttachments.map((attachment) => ({
      name: path.basename(attachment.path),
      generatedBundle: attachment.generatedBundle === true,
    }));
    await raceWithDisconnect(clearPromptComposer(Runtime, logger));
    await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    if (submissionAttachments.length > 0) {
      if (!DOM) {
        throw new Error("Chrome DOM domain unavailable while uploading attachments.");
      }
      await clearComposerAttachments(Runtime, 5_000, logger);
      for (
        let attachmentIndex = 0;
        attachmentIndex < submissionAttachments.length;
        attachmentIndex += 1
      ) {
        const attachment = submissionAttachments[attachmentIndex];
        logger(`Uploading attachment: ${attachment.displayPath}`);
        const uiConfirmed = await uploadAttachmentFile(
          { runtime: Runtime, dom: DOM, input: Input },
          attachment,
          logger,
          { expectedCount: attachmentIndex + 1 },
        );
        if (!uiConfirmed) {
          throw new BrowserAutomationError(
            `Attachment ${JSON.stringify(attachment.displayPath)} was accepted by the file input but not confirmed by the ChatGPT composer.`,
            {
              stage: "attachment-upload",
              code: "attachment-ui-unconfirmed",
              attachmentName: path.basename(attachment.path),
            },
          );
        }
        await delay(500);
      }
      const baseTimeout = config.inputTimeoutMs ?? 30_000;
      const perFileTimeout = 20_000;
      const waitBudget =
        Math.max(baseTimeout, 45_000) + (submissionAttachments.length - 1) * perFileTimeout;
      const attachmentWaitBudget = Math.max(config.attachmentTimeoutMs ?? 0, waitBudget);
      await waitForAttachmentCompletion(Runtime, attachmentWaitBudget, attachmentNames, logger);
      logger("All attachments uploaded");
    }
    if (deepResearch) {
      await raceWithDisconnect(
        withRetries(() => activateDeepResearch(Runtime, Input, logger), {
          retries: 2,
          delayMs: 500,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Deep Research activation attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        }),
      );
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
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
    const deepResearchTargetBaseline =
      deepResearch && client ? await captureDeepResearchTargetBaseline(client, logger) : undefined;
    const commitEvidence = await raceWithDisconnect(
      runProviderSubmissionFlow(chatgptDomProvider, {
        prompt,
        evaluate: async () => undefined,
        delay,
        log: logger,
        state: providerState,
      }),
    );
    await lifecycle.recordPromptCommitEvidence(commitEvidence, promptEpochIdentity);
    const promptLocator = requireCommittedPromptLocator(lifecycle);
    const providerBaselineTurns = providerState.baselineTurns;
    if (typeof providerBaselineTurns === "number" && Number.isFinite(providerBaselineTurns)) {
      baselineTurns = providerBaselineTurns;
    }
    if (attachmentNames.length > 0) {
      const verified = await waitForUserTurnAttachments(Runtime, attachmentNames, 20_000, logger, {
        minTurnIndex: baselineTurns ?? undefined,
        expectedPrompt: prompt,
        expectedConversationId: state.lastUrl
          ? extractConversationIdFromUrl(state.lastUrl)
          : undefined,
      }).catch((error) => {
        throw new BrowserAutomationError(
          "Attachment could not be verified on the sent ChatGPT user turn.",
          {
            stage: "attachment-verification",
            code: "attachment-missing-user-turn",
            attachmentNames,
          },
          error,
        );
      });
      if (!verified) {
        throw new BrowserAutomationError(
          "The newly sent ChatGPT user turn could not be found for attachment verification.",
          {
            stage: "attachment-verification",
            code: "attachment-user-turn-not-found",
            attachmentNames,
          },
        );
      }
      logger("Verified attachments present on sent user message");
    }
    return {
      promptLocator,
      baselineTurns,
      baselineAssistantText,
      deepResearchTargetKeys: deepResearchTargetBaseline?.targetKeys,
      deepResearchTargetBaselineCaptured: deepResearchTargetBaseline?.captured,
    };
  };
  const reloadPromptComposer = async () => {
    await lifecycle.resetPrompt();
    logger("[browser] Composer became unresponsive; reloading page and retrying once.");
    await raceWithDisconnect(Page.reload({ ignoreCache: true }));
    await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
  };

  let initialSubmission: BrowserSubmissionResult;
  await acquireProfileLockIfNeeded();
  try {
    initialSubmission = await runSubmissionWithRecovery({
      prompt: promptText,
      attachments,
      fallbackSubmission: options.fallbackSubmission,
      submit: (submissionPrompt, submissionAttachments) =>
        raceWithDisconnect(
          submitOnce(submissionPrompt, submissionAttachments, 0, followUpPrompts.length),
        ),
      reloadPromptComposer,
      prepareFallbackSubmission: () => lifecycle.resetPrompt(),
      logger,
    });
  } finally {
    await releaseProfileLockIfHeld();
  }

  return {
    client,
    Network,
    Page,
    Runtime,
    Input,
    DOM,
    raceWithDisconnect,
    captureRuntimeSnapshot,
    updateConversationHint,
    acquireProfileLockIfNeeded,
    releaseProfileLockIfHeld,
    submitOnce,
    reloadPromptComposer,
    promptLocator: initialSubmission.promptLocator,
    baselineAssistantText: initialSubmission.baselineAssistantText,
    deepResearch,
    deepResearchTargetKeys: initialSubmission.deepResearchTargetKeys ?? [],
    deepResearchTargetBaselineCaptured:
      initialSubmission.deepResearchTargetBaselineCaptured ?? false,
  };
}
