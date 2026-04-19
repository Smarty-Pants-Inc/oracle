import { mkdtemp, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { normalizeLocalChromeLaunchConfig, resolveBrowserConfig } from "./config.js";
import type {
  BrowserRunOptions,
  BrowserRunResult,
  BrowserLogger,
  ChromeClient,
  BrowserAttachment,
  ResolvedBrowserConfig,
} from "./types.js";
import { reportBrowserProgress } from "./types.js";
import {
  launchChrome,
  registerTerminationHooks,
  hideChromeWindow,
  captureFrontmostProcess,
  startChromeFocusGuard,
  finalizeChromeFocusProtection,
  connectToRemoteChrome,
  connectWithNewTab,
  closeTab,
} from "./chromeLifecycle.js";
import { syncCookies } from "./cookies.js";
import {
  navigateToChatGPT,
  navigateToPromptReadyWithFallback,
  ensureNotBlocked,
  ensureLoggedIn,
  ensureBackendApiReachable,
  ensurePromptReady,
  installJavaScriptDialogAutoDismissal,
  ensureModelSelection,
  clearPromptComposer,
  waitForAssistantResponse,
  isAssistantRateLimitError,
  captureAssistantMarkdown,
  clearComposerAttachments,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  waitForUserTurnAttachments,
  readAssistantSnapshot,
} from "./pageActions.js";
import { INPUT_SELECTORS } from "./constants.js";
import { uploadAttachmentViaDataTransfer } from "./actions/remoteFileTransfer.js";
import { ensureThinkingTime } from "./actions/thinkingTime.js";
import { estimateTokenCount, withRetries, delay } from "./utils.js";
import { formatElapsed } from "../oracle/format.js";
import { CHATGPT_URL, DEFAULT_MODEL_STRATEGY } from "./constants.js";
import { captureAssistantDownloads } from "./playwrightDownloads.js";
import type { LaunchedChrome } from "chrome-launcher";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  alignPromptEchoPair,
  buildPromptEchoMatcher,
  type AssistantPayload,
} from "./reattachHelpers.js";
import type { ProfileRunLock } from "./profileState.js";
import {
  cleanupStaleProfileState,
  acquireProfileRunLock,
  isProcessAlive,
  readChromePid,
  readDevToolsPort,
  shouldCleanupManualLoginProfileState,
  verifyDevToolsReachable,
  writeChromePid,
  writeDevToolsActivePort,
} from "./profileState.js";
import { runProviderSubmissionFlow } from "./providerDomFlow.js";
import { chatgptDomProvider } from "./providers/index.js";
import { resolveAttachRunningConnection } from "./attachRunning.js";
import { buildThreadIntrospectionHelpers } from "./threadIntrospection.js";

export type { BrowserAutomationConfig, BrowserRunOptions, BrowserRunResult } from "./types.js";
export { CHATGPT_URL, DEFAULT_MODEL_STRATEGY, DEFAULT_MODEL_TARGET } from "./constants.js";
export {
  parseDuration,
  delay,
  isProjectScopedChatgptUrl,
  isRootChatgptUrl,
  isSupervisorScopedChatgptUrl,
  normalizeChatgptUrl,
  normalizeProjectScopedChatgptUrl,
  isTemporaryChatUrl,
} from "./utils.js";

function isCloudflareChallengeError(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) return false;
  return (error.details as { stage?: string } | undefined)?.stage === "cloudflare-challenge";
}

function shouldPreserveBrowserOnError(error: unknown, headless: boolean): boolean {
  return !headless && isCloudflareChallengeError(error);
}

export function shouldPreserveBrowserOnErrorForTest(error: unknown, headless: boolean): boolean {
  return shouldPreserveBrowserOnError(error, headless);
}

async function ensureConversationIdentityHint(
  getCurrentUrl: () => string | undefined,
  startHint: (label: string, timeoutMs?: number) => Promise<boolean>,
  label: string,
  timeoutMs: number,
): Promise<boolean> {
  if (extractConversationIdFromUrl(getCurrentUrl() ?? "")) {
    return true;
  }
  try {
    return Boolean(
      (await startHint(label, timeoutMs)) || extractConversationIdFromUrl(getCurrentUrl() ?? ""),
    );
  } catch {
    return Boolean(extractConversationIdFromUrl(getCurrentUrl() ?? ""));
  }
}

function attachBrowserRuntimeIfMissing(error: Error, runtime: Record<string, unknown>): Error {
  if (!(error instanceof BrowserAutomationError)) {
    return error;
  }
  const details = ((error.details as Record<string, unknown> | undefined) ?? {}) as Record<
    string,
    unknown
  >;
  if (details.runtime) {
    return error;
  }
  return new BrowserAutomationError(
    error.message,
    {
      ...details,
      runtime,
    },
    (error as Error & { cause?: unknown }).cause,
  );
}

function listIgnoredRemoteChromeFlags(config: {
  attachRunning?: ResolvedBrowserConfig["attachRunning"];
  headless?: ResolvedBrowserConfig["headless"];
  hideWindow?: ResolvedBrowserConfig["hideWindow"];
  keepBrowser?: ResolvedBrowserConfig["keepBrowser"];
  chromePath?: ResolvedBrowserConfig["chromePath"];
  manualLogin?: ResolvedBrowserConfig["manualLogin"];
  manualLoginProfileDir?: ResolvedBrowserConfig["manualLoginProfileDir"];
}): string[] {
  return [
    config.headless ? "--browser-headless" : null,
    config.hideWindow ? "--browser-hide-window" : null,
    config.keepBrowser ? "--browser-keep-browser" : null,
    !config.attachRunning && config.chromePath ? "--browser-chrome-path" : null,
    !config.attachRunning && config.manualLogin ? "--browser-manual-login" : null,
    !config.attachRunning && config.manualLoginProfileDir
      ? "--browser-manual-login-profile-dir"
      : null,
  ].filter((value): value is string => Boolean(value));
}

export async function runBrowserMode(options: BrowserRunOptions): Promise<BrowserRunResult> {
  const promptText = options.prompt?.trim();
  if (!promptText) {
    throw new Error("Prompt text is required when using browser mode.");
  }

  const attachments: BrowserAttachment[] = options.attachments ?? [];
  const fallbackSubmission = options.fallbackSubmission;

  let config = normalizeLocalChromeLaunchConfig(resolveBrowserConfig(options.config));
  const logger: BrowserLogger = options.log ?? ((_message: string) => {});
  if (logger.verbose === undefined) {
    logger.verbose = Boolean(config.debug);
  }
  if (logger.sessionLog === undefined && options.log?.sessionLog) {
    logger.sessionLog = options.log.sessionLog;
  }
  const runtimeHintCb = options.runtimeHintCb;
  let lastTargetId: string | undefined;
  let lastUrl: string | undefined;
  let chromeBrowserWSEndpoint: string | undefined;
  let conversationHintInFlight: Promise<boolean> | null = null;
  let startConversationHint = async (_label: string, _timeoutMs?: number): Promise<boolean> =>
    false;
  const emitRuntimeHint = async (): Promise<void> => {
    if (!runtimeHintCb || !chrome?.port) {
      return;
    }
    const conversationId = lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined;
    const hint = {
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      chromeBrowserWSEndpoint,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      conversationId,
      userDataDir,
      controllerPid: process.pid,
    };
    try {
      await runtimeHintCb(hint);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
    }
  };
  if (config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") {
    logger(
      `[browser-mode] config: ${JSON.stringify({
        ...config,
        promptLength: promptText.length,
      })}`,
    );
  }

  let attachRunningChromePid: number | undefined;
  if (config.attachRunning) {
    const attached = await resolveAttachRunningConnection(config, logger);
    attachRunningChromePid = attached.chromePid ?? undefined;
    config = {
      ...config,
      remoteChrome: { host: attached.host, port: attached.port },
      remoteChromeBrowserWSEndpoint: attached.browserWSEndpoint,
      remoteChromeProfileRoot: attached.profileRoot,
    };
  }

  if (!config.remoteChrome && !config.manualLogin) {
    const preferredPort = config.debugPort ?? DEFAULT_DEBUG_PORT;
    const availablePort = await pickAvailableDebugPort(preferredPort, logger);
    if (availablePort !== preferredPort) {
      logger(
        `DevTools port ${preferredPort} busy; using ${availablePort} to avoid attaching to stray Chrome.`,
      );
    }
    config = { ...config, debugPort: availablePort };
  }

  // Remote Chrome mode - connect to existing browser
  if (config.remoteChrome) {
    // Warn about ignored local-only options
    const ignoredFlags = listIgnoredRemoteChromeFlags(config);
    if (ignoredFlags.length > 0) {
      logger(`Note: --remote-chrome ignores local Chrome flags (${ignoredFlags.join(", ")}).`);
    }

    const result = await runRemoteBrowserMode(promptText, attachments, config, logger, options);
    if (attachRunningChromePid && !result.chromePid) {
      return {
        ...result,
        chromePid: attachRunningChromePid,
      };
    }
    return result;
  }

  const manualLogin = Boolean(config.manualLogin) && config.launcher !== "carbonyl";
  const manualProfileDir = config.manualLoginProfileDir
    ? path.resolve(config.manualLoginProfileDir)
    : path.join(os.homedir(), ".oracle", "browser-profile");
  const userDataDir = manualLogin
    ? manualProfileDir
    : await mkdtemp(path.join(await resolveUserDataBaseDir(), "oracle-browser-"));
  if (manualLogin) {
    // Learned: manual login reuses a persistent profile so cookies/SSO survive.
    await mkdir(userDataDir, { recursive: true });
    logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
  } else {
    logger(`Created temporary Chrome profile at ${userDataDir}`);
  }

  const shouldHideChromeWindow =
    config.launcher !== "carbonyl" && !config.headless && config.hideWindow;
  const frontmostTarget = shouldHideChromeWindow ? await captureFrontmostProcess(logger) : null;

  const effectiveKeepBrowser = Boolean(config.keepBrowser);
  const reusedChrome = manualLogin
    ? await maybeReuseRunningChrome(userDataDir, logger, {
        waitForPortMs: config.reuseChromeWaitMs,
        failOnLiveChromeWithoutDevtools: true,
      })
    : null;
  const chrome =
    reusedChrome ??
    (await launchChrome(
      {
        ...config,
        remoteChrome: config.remoteChrome,
      },
      userDataDir,
      logger,
    ));
  const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
  // Persist profile state so future manual-login runs can reuse this Chrome.
  if (manualLogin && chrome.port) {
    await writeDevToolsActivePort(userDataDir, chrome.port);
    if (!reusedChrome && chrome.pid) {
      await writeChromePid(userDataDir, chrome.pid);
    }
  }
  let removeTerminationHooks: (() => void) | null = null;
  try {
    removeTerminationHooks = registerTerminationHooks(
      chrome,
      userDataDir,
      effectiveKeepBrowser,
      logger,
      {
        isInFlight: () => runStatus !== "complete",
        emitRuntimeHint: async () => {
          await ensureConversationIdentityHint(
            () => lastUrl,
            startConversationHint,
            "shutdown",
            10_000,
          );
          await emitRuntimeHint();
        },
        preserveUserDataDir: manualLogin,
      },
    );
  } catch {
    // ignore failure; cleanup still happens below
  }

  let client: ChromeClient | null = null;
  let isolatedTargetId: string | null = null;
  const startedAt = Date.now();
  let answerText = "";
  let answerMarkdown = "";
  let answerHtml = "";
  let answerMeta: { turnId?: string | null; messageId?: string | null } = {};
  let runStatus: "attempted" | "complete" = "attempted";
  let connectionClosedUnexpectedly = false;
  let stopThinkingMonitor: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let appliedCookies = 0;
  let preserveBrowserOnError = false;
  let browserReadyProgressSent = false;
  let lastBoundConversationUrl: string | undefined;
  let stopChromeFocusGuard: (() => void) | null = null;
  const currentRuntimeHint = () => ({
    chromePid: chrome.pid,
    chromePort: chrome.port,
    chromeHost,
    chromeBrowserWSEndpoint,
    chromeTargetId: lastTargetId,
    tabUrl: lastUrl,
    conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
    userDataDir,
    controllerPid: process.pid,
  });
  if (shouldHideChromeWindow) {
    stopChromeFocusGuard = startChromeFocusGuard(chrome, logger, frontmostTarget);
    await hideChromeWindow(chrome, logger, frontmostTarget);
  }

  try {
    try {
      const strictTabIsolation = Boolean(manualLogin && reusedChrome);
      const requireHiddenTarget = Boolean(shouldHideChromeWindow);
      const connection = await connectWithNewTab(chrome.port, logger, undefined, chromeHost, {
        fallbackToDefault: !strictTabIsolation && !requireHiddenTarget,
        preferDefaultTarget: config.launcher === "carbonyl",
        hiddenTarget: requireHiddenTarget,
        closeTargetOnDispose: !effectiveKeepBrowser,
        retries: strictTabIsolation ? 3 : 0,
        retryDelayMs: 500,
      });
      client = connection.client;
      isolatedTargetId = connection.targetId ?? null;
      chromeBrowserWSEndpoint = connection.browserWSEndpoint ?? undefined;
    } catch (error) {
      const hint = describeDevtoolsFirewallHint(chromeHost, chrome.port);
      if (hint) {
        logger(hint);
      }
      throw error;
    }
    const disconnectPromise = new Promise<never>((_, reject) => {
      client?.on("disconnect", () => {
        connectionClosedUnexpectedly = true;
        logger("Chrome window closed; attempting to abort run.");
        reject(
          new Error(
            "Chrome window closed before oracle finished. Please keep it open until completion.",
          ),
        );
      });
    });
    const raceWithDisconnect = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, disconnectPromise]);
    const { Network, Page, Runtime, Input, DOM } = client;

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);
    if (!manualLogin) {
      await Network.clearBrowserCookies();
    }

    const manualLoginCookieSync =
      manualLogin && Boolean(config.manualLoginCookieSync) && !reusedChrome;
    const cookieSyncEnabled = config.cookieSync && (!manualLogin || manualLoginCookieSync);
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
      // Learned: always sync cookies before the first navigation so /backend-api/me succeeds.
      const cookieCount = await syncCookies(Network, config.url, config.chromeProfile, logger, {
        allowErrors: config.allowCookieErrors ?? false,
        filterNames: config.cookieNames ?? undefined,
        inlineCookies: config.inlineCookies ?? undefined,
        cookiePath: config.chromeCookiePath ?? undefined,
        waitMs: config.cookieSyncWaitMs ?? 0,
      });
      appliedCookies = cookieCount;
      if (config.inlineCookies && cookieCount === 0) {
        throw new Error("No inline cookies were applied; aborting before navigation.");
      }
      logger(
        cookieCount > 0
          ? config.inlineCookies
            ? `Applied ${cookieCount} inline cookies`
            : `Copied ${cookieCount} cookies from Chrome profile ${config.chromeProfile ?? "Default"}`
          : config.inlineCookies
            ? "No inline cookies applied; continuing without session reuse"
            : "No Chrome cookies found; continuing without session reuse",
      );
    } else {
      logger(
        manualLogin && reusedChrome
          ? "Manual login mode: reusing a running persistent Chrome profile; skipping cookie sync."
          : manualLogin
            ? "Skipping Chrome cookie sync (--browser-manual-login enabled); reuse the opened profile after signing in."
            : "Skipping Chrome cookie sync (--browser-no-cookie-sync)",
      );
    }

    if (cookieSyncEnabled && !manualLogin && (appliedCookies ?? 0) === 0 && !config.inlineCookies) {
      // Learned: if the profile has no ChatGPT cookies, browser mode will just bounce to login.
      // Fail early so the user knows to sign in.
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

    const baseUrl = CHATGPT_URL;
    // First load the base ChatGPT homepage to satisfy potential interstitials,
    // then hop to the requested URL if it differs.
    await raceWithDisconnect(navigateToChatGPT(Page, Runtime, baseUrl, logger));
    await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
    // Learned: login checks must happen on the base domain before jumping into project URLs.
    await raceWithDisconnect(
      waitForLogin({
        runtime: Runtime,
        logger,
        appliedCookies,
        manualLogin,
        timeoutMs: config.timeoutMs,
      }),
    );

    if (config.url !== baseUrl) {
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
    logger(
      `Prompt textarea ready (initial focus, ${promptText.length.toLocaleString()} chars queued)`,
    );
    const captureRuntimeSnapshot = async () => {
      try {
        if (client?.Target?.getTargetInfo) {
          const info = await client.Target.getTargetInfo({});
          lastTargetId = info?.targetInfo?.targetId ?? lastTargetId;
          lastUrl = info?.targetInfo?.url ?? lastUrl;
        }
      } catch {
        // ignore
      }
      try {
        const { result } = await Runtime.evaluate({
          expression: "location.href",
          returnByValue: true,
        });
        if (typeof result?.value === "string") {
          lastUrl = result.value;
        }
      } catch {
        // ignore
      }
      if (lastUrl) {
        logger(`[browser] url = ${lastUrl}`);
      }
      if (chrome?.port) {
        const suffix = lastTargetId ? ` target=${lastTargetId}` : "";
        if (lastUrl) {
          logger(
            `[reattach] chrome port=${chrome.port} host=${chromeHost} url=${lastUrl}${suffix}`,
          );
        } else {
          logger(`[reattach] chrome port=${chrome.port} host=${chromeHost}${suffix}`);
        }
        await emitRuntimeHint();
        if (!browserReadyProgressSent) {
          browserReadyProgressSent = true;
          await reportBrowserProgress(logger, {
            stage: "browser-ready",
            message: "Connected to the ChatGPT browser runtime.",
            runtime: currentRuntimeHint(),
          });
        }
      }
    };
    const updateConversationHint = async (label: string, timeoutMs = 10_000): Promise<boolean> => {
      if (!chrome?.port) {
        return false;
      }
      const conversationUrl = await waitForConversationUrlHint(Runtime, timeoutMs);
      if (conversationUrl) {
        lastUrl = conversationUrl;
        logger(`[browser] conversation url (${label}) = ${lastUrl}`);
        await emitRuntimeHint();
        if (conversationUrl !== lastBoundConversationUrl) {
          lastBoundConversationUrl = conversationUrl;
          await reportBrowserProgress(logger, {
            stage: "thread-bound",
            message: `Bound to ChatGPT conversation ${extractConversationIdFromUrl(conversationUrl) ?? conversationUrl}.`,
            runtime: currentRuntimeHint(),
          });
        }
        return true;
      }
      return false;
    };
    startConversationHint = async (label: string, timeoutMs = 10_000): Promise<boolean> => {
      if (conversationHintInFlight) {
        return await conversationHintInFlight;
      }
      conversationHintInFlight = updateConversationHint(label, timeoutMs)
        .catch(() => false)
        .finally(() => {
          conversationHintInFlight = null;
        });
      return await conversationHintInFlight;
    };
    const scheduleConversationHint = (label: string, timeoutMs?: number): void => {
      // Learned: the /c/ URL can update after the answer; emit hints in the background.
      // Run in the background so prompt submission/streaming isn't blocked by slow URL updates.
      void startConversationHint(label, timeoutMs);
    };
    await captureRuntimeSnapshot();
    const modelStrategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
    if (config.desiredModel && modelStrategy !== "ignore") {
      await raceWithDisconnect(
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
        const base = error instanceof Error ? error.message : String(error);
        const hint =
          appliedCookies === 0
            ? " No cookies were applied; log in to ChatGPT in Chrome or provide inline cookies (--browser-inline-cookies[(-file)] or ORACLE_BROWSER_COOKIES_JSON)."
            : "";
        throw new Error(`${base}${hint}`);
      });
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      logger(
        `Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`,
      );
    } else if (modelStrategy === "ignore") {
      logger("Model picker: skipped (strategy=ignore)");
    }
    // Handle thinking time selection if specified
    const thinkingTime = config.thinkingTime;
    if (thinkingTime) {
      await raceWithDisconnect(
        withRetries(() => ensureThinkingTime(Runtime, thinkingTime, logger), {
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
    const submitOnce = async (prompt: string, submissionAttachments: BrowserAttachment[]) => {
      const baselineSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);
      const baselineAssistantText =
        typeof baselineSnapshot?.text === "string" ? baselineSnapshot.text.trim() : "";
      const attachmentNames = submissionAttachments.map((a) => path.basename(a.path));
      await ensureBackendApiReachable(Runtime, logger);
      await clearPromptComposer(Runtime, logger);
      let attachmentWaitTimedOut = false;
      let inputOnlyAttachments = false;
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
            inputOnlyAttachments = true;
          }
          await delay(500);
        }
        // Scale timeout based on number of files: base 45s + 20s per additional file.
        const baseTimeout = config.inputTimeoutMs ?? 30_000;
        const perFileTimeout = 20_000;
        const waitBudget =
          Math.max(baseTimeout, 45_000) + (submissionAttachments.length - 1) * perFileTimeout;
        try {
          await waitForAttachmentCompletion(Runtime, waitBudget, attachmentNames, logger);
          logger("All attachments uploaded");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/Attachments did not finish uploading before timeout/i.test(message)) {
            attachmentWaitTimedOut = true;
            logger(
              `[browser] Attachment upload timed out after ${Math.round(waitBudget / 1000)}s; continuing without confirmation.`,
            );
          } else {
            throw error;
          }
        }
      }
      let baselineTurns = await readConversationTurnCount(Runtime, logger);
      // Learned: return baselineTurns so assistant polling can ignore earlier content.
      const sendAttachmentNames = attachmentWaitTimedOut ? [] : attachmentNames;
      const providerState: Record<string, unknown> = {
        runtime: Runtime,
        input: Input,
        logger,
        timeoutMs: config.timeoutMs,
        inputTimeoutMs: config.inputTimeoutMs ?? undefined,
        baselineTurns: baselineTurns ?? undefined,
        attachmentNames: sendAttachmentNames,
      };
      await runProviderSubmissionFlow(chatgptDomProvider, {
        prompt,
        evaluate: async () => undefined,
        delay,
        log: logger,
        state: providerState,
      });
      const providerBaselineTurns = providerState.baselineTurns;
      if (typeof providerBaselineTurns === "number" && Number.isFinite(providerBaselineTurns)) {
        baselineTurns = providerBaselineTurns;
      }
      if (attachmentNames.length > 0) {
        await verifySubmittedUserTurnAttachments({
          runtime: Runtime,
          attachmentNames,
          attachmentWaitTimedOut,
          skipUiVerification: inputOnlyAttachments,
          logger,
        });
      }
      await reportBrowserProgress(logger, {
        stage: "prompt-committed",
        message:
          submissionAttachments.length > 0
            ? `Committed the prompt to the ChatGPT conversation with ${submissionAttachments.length} attachment${submissionAttachments.length === 1 ? "" : "s"}.`
            : "Committed the prompt to the ChatGPT conversation.",
        runtime: currentRuntimeHint(),
      });
      const immediateConversationHintTimeoutMs = Math.max(
        2_000,
        Math.min(config.timeoutMs ?? 120_000, 10_000),
      );
      const hintedConversation = await ensureConversationIdentityHint(
        () => lastUrl,
        startConversationHint,
        "post-submit-prime",
        immediateConversationHintTimeoutMs,
      );
      if (!hintedConversation) {
        logger(
          "[browser] ChatGPT did not expose a conversation URL immediately after send; keeping background identity watcher alive.",
        );
        scheduleConversationHint("post-submit", 15_000);
      } else {
        await emitRuntimeHint();
      }
      return { baselineTurns, baselineAssistantText };
    };

    let baselineTurns: number | null = null;
    let baselineAssistantText: string | null = null;
    await acquireProfileLockIfNeeded();
    try {
      try {
        const submission = await raceWithDisconnect(submitOnce(promptText, attachments));
        baselineTurns = submission.baselineTurns;
        baselineAssistantText = submission.baselineAssistantText;
      } catch (error) {
        const isPromptTooLarge =
          error instanceof BrowserAutomationError &&
          (error.details as { code?: string } | undefined)?.code === "prompt-too-large";
        if (fallbackSubmission && isPromptTooLarge) {
          // Learned: when prompts truncate, retry with file uploads so the UI receives the full content.
          logger("[browser] Inline prompt too large; retrying with file uploads.");
          await raceWithDisconnect(clearPromptComposer(Runtime, logger));
          await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
          const submission = await raceWithDisconnect(
            submitOnce(fallbackSubmission.prompt, fallbackSubmission.attachments),
          );
          baselineTurns = submission.baselineTurns;
          baselineAssistantText = submission.baselineAssistantText;
        } else {
          throw error;
        }
      }
    } finally {
      await releaseProfileLockIfHeld();
    }
    stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, options.verbose ?? false);
    await reportBrowserProgress(logger, {
      stage: "assistant-generating",
      message: "Waiting for ChatGPT to finish the assistant response.",
      runtime: currentRuntimeHint(),
    });
    let answer: AssistantPayload;
    const recheckDelayMs = Math.max(0, config.assistantRecheckDelayMs ?? 0);
    const recheckTimeoutMs = Math.max(0, config.assistantRecheckTimeoutMs ?? 0);
    const attemptAssistantRecheck = async () => {
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
        await raceWithDisconnect(delay(1000));
      }
      // Validate session before attempting recheck - sessions can expire during the delay
      const sessionValid = await validateChatGPTSession(Runtime, logger);
      if (!sessionValid.valid) {
        logger(`[browser] Session validation failed: ${sessionValid.reason}`);
        // Update session metadata to indicate login is needed
        await emitRuntimeHint();
        throw new BrowserAutomationError(
          `ChatGPT session expired during recheck: ${sessionValid.reason}. ` +
            `Conversation URL: ${conversationUrl || lastUrl || "unknown"}. ` +
            `Please sign in and retry.`,
          {
            stage: "assistant-recheck",
            details: {
              conversationUrl: conversationUrl || lastUrl || null,
              sessionStatus: "needs_login",
              validationReason: sessionValid.reason,
            },
            runtime: {
              chromePid: chrome.pid,
              chromePort: chrome.port,
              chromeHost,
              chromeBrowserWSEndpoint,
              userDataDir,
              chromeTargetId: lastTargetId,
              tabUrl: lastUrl,
              conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
              controllerPid: process.pid,
            },
          },
        );
      }
      const timeoutMs = recheckTimeoutMs > 0 ? recheckTimeoutMs : config.timeoutMs;
      const rechecked = await raceWithDisconnect(
        waitForAssistantResponseWithReload(
          Runtime,
          Page,
          timeoutMs,
          logger,
          baselineTurns ?? undefined,
        ),
      );
      logger("Recovered assistant response after delayed recheck");
      return rechecked;
    };
    try {
      answer = await raceWithDisconnect(
        waitForAssistantResponseWithReload(
          Runtime,
          Page,
          config.timeoutMs,
          logger,
          baselineTurns ?? undefined,
        ),
      );
    } catch (error) {
      if (isAssistantRateLimitError(error)) {
        await updateConversationHint("assistant-rate-limit", 15_000).catch(() => false);
        await captureRuntimeSnapshot().catch(() => undefined);
        const runtime = {
          chromePid: chrome.pid,
          chromePort: chrome.port,
          chromeHost,
          chromeBrowserWSEndpoint,
          userDataDir,
          chromeTargetId: lastTargetId,
          tabUrl: lastUrl,
          conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
          controllerPid: process.pid,
        };
        throw new BrowserAutomationError(
          "ChatGPT temporarily limited this browser profile after too many requests. Wait a few minutes before retrying.",
          { stage: "assistant-rate-limit", runtime },
          error,
        );
      }
      if (isAssistantResponseTimeoutError(error)) {
        const rechecked = await attemptAssistantRecheck().catch(() => null);
        if (rechecked) {
          answer = rechecked;
        } else {
          await updateConversationHint("assistant-timeout", 15_000).catch(() => false);
          await captureRuntimeSnapshot().catch(() => undefined);
          const runtime = {
            chromePid: chrome.pid,
            chromePort: chrome.port,
            chromeHost,
            chromeBrowserWSEndpoint,
            userDataDir,
            chromeTargetId: lastTargetId,
            tabUrl: lastUrl,
            conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
            controllerPid: process.pid,
          };
          throw new BrowserAutomationError(
            "Assistant response timed out before completion; reattach later to capture the answer.",
            { stage: "assistant-timeout", runtime },
            error,
          );
        }
      } else {
        throw error;
      }
    }
    // Ensure we store the final conversation URL even if the UI updated late.
    await updateConversationHint("post-response", 15_000);
    ({
      answerText,
      answerMarkdown,
      answerHtml,
      meta: answerMeta,
    } = await finalizeAssistantResponseCapture({
      runtime: Runtime,
      promptText,
      baselineTurns,
      baselineAssistantText,
      answer,
      logger,
      captureMarkdown: async () =>
        await raceWithDisconnect(
          withRetries(
            async () => {
              const attempt = await captureAssistantMarkdown(Runtime, answer.meta, logger);
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
        ).catch(() => null),
    }));
    await reportBrowserProgress(logger, {
      stage: "assistant-completed",
      message: "Captured the assistant response from ChatGPT.",
      runtime: currentRuntimeHint(),
    });
    if (connectionClosedUnexpectedly) {
      // Bail out on mid-run disconnects so the session stays reattachable.
      throw new Error("Chrome disconnected before completion");
    }
    stopThinkingMonitor?.();
    runStatus = "complete";
    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);
    const downloads = await captureAssistantDownloads({
      browserWSEndpoint: chromeBrowserWSEndpoint,
      chromeHost,
      chromePort: chrome.port,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
      downloadsDir: options.downloadsDir,
      meta: answerMeta,
      logger,
    }).catch((error) => {
      logger.sessionLog?.(
        `[browser-downloads] skipped during browser run: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    });
    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      downloads,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      chromeBrowserWSEndpoint,
      userDataDir,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
      controllerPid: process.pid,
    };
  } catch (error) {
    const runtime = {
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      chromeBrowserWSEndpoint,
      userDataDir,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
      controllerPid: process.pid,
    };
    const normalizedError = attachBrowserRuntimeIfMissing(
      error instanceof Error ? error : new Error(String(error)),
      runtime,
    );
    stopThinkingMonitor?.();
    const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
    connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;
    if (shouldPreserveBrowserOnError(normalizedError, config.headless)) {
      preserveBrowserOnError = true;
      const reuseProfileHint =
        `oracle --engine browser --browser-manual-login ` +
        `--browser-manual-login-profile-dir ${JSON.stringify(userDataDir)}`;
      await emitRuntimeHint();
      logger("Cloudflare challenge detected; leaving browser open so you can complete the check.");
      logger(`Reuse this browser profile with: ${reuseProfileHint}`);
      throw new BrowserAutomationError(
        "Cloudflare challenge detected. Complete the “Just a moment…” check in the open browser, then rerun.",
        {
          stage: "cloudflare-challenge",
          runtime,
          reuseProfileHint,
        },
        normalizedError,
      );
    }
    if (!socketClosed) {
      logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
      if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
        logger(normalizedError.stack);
      }
      throw normalizedError;
    }
    if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
      logger(`Chrome window closed before completion: ${normalizedError.message}`);
      logger(normalizedError.stack);
    }
    await emitRuntimeHint();
    throw new BrowserAutomationError(
      "Chrome window closed before oracle finished. Please keep it open until completion.",
      {
        stage: "connection-lost",
        runtime: {
          chromePid: chrome.pid,
          chromePort: chrome.port,
          chromeHost,
          chromeBrowserWSEndpoint,
          userDataDir,
          chromeTargetId: lastTargetId,
          tabUrl: lastUrl,
          controllerPid: process.pid,
        },
      },
      normalizedError,
    );
  } finally {
    try {
      if (!connectionClosedUnexpectedly) {
        await client?.close();
      }
    } catch {
      // ignore
    }
    // Close the isolated tab once the response has been fully captured to prevent
    // tab accumulation across repeated runs. Keep the tab open on incomplete runs
    // so reattach can recover the response.
    if (runStatus === "complete" && isolatedTargetId && chrome?.port && !effectiveKeepBrowser) {
      await closeTab(chrome.port, isolatedTargetId, logger, chromeHost).catch(() => undefined);
    }
    removeDialogHandler?.();
    if (shouldHideChromeWindow) {
      await finalizeChromeFocusProtection(chrome, logger, stopChromeFocusGuard, frontmostTarget);
      stopChromeFocusGuard = null;
    }
    removeTerminationHooks?.();
    const keepBrowserOpen = effectiveKeepBrowser || preserveBrowserOnError;
    if (!keepBrowserOpen) {
      if (!connectionClosedUnexpectedly) {
        try {
          await chrome.kill();
        } catch {
          // ignore kill failures
        }
      }
      if (manualLogin) {
        const shouldCleanup = await shouldCleanupManualLoginProfileState(
          userDataDir,
          logger.verbose ? logger : undefined,
          {
            connectionClosedUnexpectedly,
            host: chromeHost,
          },
        );
        if (shouldCleanup) {
          // Preserve the persistent manual-login profile, but clear stale reattach hints.
          await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
            () => undefined,
          );
        }
      } else {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (!connectionClosedUnexpectedly) {
        const totalSeconds = (Date.now() - startedAt) / 1000;
        logger(`Cleanup ${runStatus} • ${totalSeconds.toFixed(1)}s total`);
      }
    } else if (!connectionClosedUnexpectedly) {
      logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
    }
  }
}

const DEFAULT_DEBUG_PORT = 9222;

async function pickAvailableDebugPort(
  preferredPort: number,
  logger: BrowserLogger,
): Promise<number> {
  const start =
    Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : DEFAULT_DEBUG_PORT;
  for (let offset = 0; offset < 10; offset++) {
    const candidate = start + offset;
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  const fallback = await findEphemeralPort();
  logger(`DevTools ports ${start}-${start + 9} are occupied; falling back to ${fallback}.`);
  return fallback;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      server.close();
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to acquire ephemeral port")));
      }
    });
  });
}

async function waitForLogin({
  runtime,
  logger,
  appliedCookies,
  manualLogin,
  timeoutMs,
}: {
  runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  appliedCookies: number;
  manualLogin: boolean;
  timeoutMs: number;
}): Promise<void> {
  if (!manualLogin) {
    await ensureLoggedIn(runtime, logger, { appliedCookies });
    return;
  }
  const deadline = Date.now() + Math.min(timeoutMs ?? 1_200_000, 20 * 60_000);
  let lastNotice = 0;
  while (Date.now() < deadline) {
    try {
      await ensureLoggedIn(runtime, logger, { appliedCookies });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const loginDetected = message?.toLowerCase().includes("login button");
      const sessionMissing = message?.toLowerCase().includes("session not detected");
      if (!loginDetected && !sessionMissing) {
        throw error;
      }
      const now = Date.now();
      if (now - lastNotice > 5000) {
        logger(
          "Manual login mode: please sign into chatgpt.com in the opened Chrome window; waiting for session to appear...",
        );
        lastNotice = now;
      }
      await delay(1000);
    }
  }
  throw new Error(
    "Manual login mode timed out waiting for ChatGPT session; please sign in and retry.",
  );
}

async function maybeRecoverLongAssistantResponse({
  runtime,
  baselineTurns,
  answerText,
  answerMarkdown,
  logger,
  allowMarkdownUpdate,
}: {
  runtime: ChromeClient["Runtime"];
  baselineTurns: number | null;
  answerText: string;
  answerMarkdown: string;
  logger: BrowserLogger;
  allowMarkdownUpdate: boolean;
}): Promise<{ answerText: string; answerMarkdown: string }> {
  // Learned: long streaming responses can still be rendering after initial capture.
  // Add a brief delay and re-poll to catch any additional content (#71).
  const capturedLength = answerText.trim().length;
  if (capturedLength <= 500) {
    return { answerText, answerMarkdown };
  }

  await delay(1500);
  let bestLength = capturedLength;
  let bestText = answerText;
  for (let i = 0; i < 5; i++) {
    const laterSnapshot = await readAssistantSnapshot(runtime, baselineTurns ?? undefined).catch(
      () => null,
    );
    const laterText = typeof laterSnapshot?.text === "string" ? laterSnapshot.text.trim() : "";
    if (laterText.length > bestLength) {
      bestLength = laterText.length;
      bestText = laterText;
      await delay(800); // More content appeared, keep waiting
    } else {
      break; // Stable, stop polling
    }
  }
  if (bestLength > capturedLength) {
    logger(`Recovered ${bestLength - capturedLength} additional chars via delayed re-read`);
    return {
      answerText: bestText,
      answerMarkdown: allowMarkdownUpdate ? bestText : answerMarkdown,
    };
  }
  return { answerText, answerMarkdown };
}

function normalizeForComparison(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function matchesBaselineAssistantResponse(text: string, baselineNormalized: string): boolean {
  const baselinePrefix =
    baselineNormalized.length >= 80
      ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
      : "";
  const normalized = normalizeForComparison(text);
  return (
    normalized === baselineNormalized ||
    (baselinePrefix.length > 0 && normalized.startsWith(baselinePrefix))
  );
}

async function waitForFreshAssistantResponse({
  runtime,
  baselineTurns,
  baselineNormalized,
  timeoutMs,
}: {
  runtime: ChromeClient["Runtime"];
  baselineTurns: number | null;
  baselineNormalized: string;
  timeoutMs: number;
}): Promise<AssistantPayload | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await readAssistantSnapshot(runtime, baselineTurns ?? undefined).catch(
      () => null,
    );
    const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
    if (text && !matchesBaselineAssistantResponse(text, baselineNormalized)) {
      return {
        text,
        html: snapshot?.html ?? undefined,
        meta: {
          turnId: snapshot?.turnId ?? undefined,
          messageId: snapshot?.messageId ?? undefined,
        },
      };
    }
    await delay(350);
  }
  return null;
}

function shouldReplaceAssistantCaptureWithDomSnapshot({
  promptText,
  currentMarkdown,
  copiedMarkdown,
  finalText,
}: {
  promptText: string;
  currentMarkdown: string;
  copiedMarkdown: string | null;
  finalText: string;
}): boolean {
  if (!finalText || finalText === promptText.trim()) {
    return false;
  }
  const promptEchoMatcher = buildPromptEchoMatcher(promptText);
  if (promptEchoMatcher?.isEcho(finalText)) {
    return false;
  }
  const trimmedMarkdown = currentMarkdown.trim();
  const lengthDelta = finalText.length - trimmedMarkdown.length;
  const missingCopy = !copiedMarkdown && lengthDelta >= 0;
  const likelyTruncatedCopy =
    Boolean(copiedMarkdown) &&
    trimmedMarkdown.length > 0 &&
    lengthDelta >= Math.max(12, Math.floor(trimmedMarkdown.length * 0.75));
  return (missingCopy || likelyTruncatedCopy) && finalText !== trimmedMarkdown;
}

async function recoverPromptEchoText({
  runtime,
  baselineTurns,
  promptText,
}: {
  runtime: ChromeClient["Runtime"];
  baselineTurns: number | null;
  promptText: string;
}): Promise<string | null> {
  const promptEchoMatcher = buildPromptEchoMatcher(promptText);
  if (!promptEchoMatcher) {
    return null;
  }
  const deadline = Date.now() + 15_000;
  let bestText: string | null = null;
  let stableCount = 0;
  while (Date.now() < deadline) {
    const snapshot = await readAssistantSnapshot(runtime, baselineTurns ?? undefined).catch(
      () => null,
    );
    const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
    const isStillEcho = !text || promptEchoMatcher.isEcho(text);
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
  return bestText;
}

async function recoverShortAssistantText({
  runtime,
  baselineTurns,
  answerText,
  minAnswerChars = 16,
}: {
  runtime: ChromeClient["Runtime"];
  baselineTurns: number | null;
  answerText: string;
  minAnswerChars?: number;
}): Promise<string | null> {
  const trimmed = answerText.trim();
  if (!trimmed || trimmed.length >= minAnswerChars) {
    return null;
  }
  const deadline = Date.now() + 12_000;
  let bestText = trimmed;
  let stableCycles = 0;
  while (Date.now() < deadline) {
    const snapshot = await readAssistantSnapshot(runtime, baselineTurns ?? undefined).catch(
      () => null,
    );
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
  return bestText.length > trimmed.length ? bestText : null;
}

async function finalizeAssistantResponseCapture({
  runtime,
  promptText,
  baselineTurns,
  baselineAssistantText,
  answer,
  logger,
  captureMarkdown,
}: {
  runtime: ChromeClient["Runtime"];
  promptText: string;
  baselineTurns: number | null;
  baselineAssistantText: string | null;
  answer: AssistantPayload;
  logger: BrowserLogger;
  captureMarkdown: () => Promise<string | null>;
}): Promise<{
  answerText: string;
  answerMarkdown: string;
  answerHtml: string;
  meta: { turnId?: string | null; messageId?: string | null };
}> {
  const baselineNormalized = baselineAssistantText
    ? normalizeForComparison(baselineAssistantText)
    : "";
  if (
    baselineNormalized &&
    matchesBaselineAssistantResponse(answer.text ?? "", baselineNormalized)
  ) {
    logger("Detected stale assistant response; waiting for new response...");
    const refreshed = await waitForFreshAssistantResponse({
      runtime,
      baselineTurns,
      baselineNormalized,
      timeoutMs: 15_000,
    });
    if (refreshed) {
      answer = refreshed;
    }
  }

  let answerText = answer.text;
  const answerHtml = answer.html ?? "";
  const copiedMarkdown = await captureMarkdown().catch(() => null);
  let answerMarkdown = copiedMarkdown ?? answerText;

  ({ answerText, answerMarkdown } = await maybeRecoverLongAssistantResponse({
    runtime,
    baselineTurns,
    answerText,
    answerMarkdown,
    logger,
    allowMarkdownUpdate: !copiedMarkdown,
  }));

  const finalSnapshot = await readAssistantSnapshot(runtime, baselineTurns ?? undefined).catch(
    () => null,
  );
  const answerMeta = {
    turnId: answer.meta?.turnId ?? finalSnapshot?.turnId ?? undefined,
    messageId: answer.meta?.messageId ?? finalSnapshot?.messageId ?? undefined,
  };
  const finalText = typeof finalSnapshot?.text === "string" ? finalSnapshot.text.trim() : "";
  if (
    shouldReplaceAssistantCaptureWithDomSnapshot({
      promptText,
      currentMarkdown: answerMarkdown,
      copiedMarkdown,
      finalText,
    })
  ) {
    logger("Refreshed assistant response via final DOM snapshot");
    answerText = finalText;
    answerMarkdown = finalText;
  }

  const promptEchoMatcher = buildPromptEchoMatcher(promptText);
  const alignedEcho = alignPromptEchoPair(
    answerText,
    answerMarkdown,
    promptEchoMatcher,
    copiedMarkdown ? logger : undefined,
    {
      text: "Aligned assistant response text to copied markdown after prompt echo",
      markdown: "Aligned assistant markdown to response text after prompt echo",
    },
  );
  answerText = alignedEcho.answerText;
  answerMarkdown = alignedEcho.answerMarkdown;

  if (alignedEcho.isEcho) {
    logger("Detected prompt echo in response; waiting for actual assistant response...");
    const recovered = await recoverPromptEchoText({
      runtime,
      baselineTurns,
      promptText,
    });
    if (recovered) {
      logger("Recovered assistant response after detecting prompt echo");
      answerText = recovered;
      answerMarkdown = recovered;
    }
  }

  const recoveredShortText = await recoverShortAssistantText({
    runtime,
    baselineTurns,
    answerText,
  });
  if (recoveredShortText) {
    logger("Refreshed short assistant response from latest DOM snapshot");
    answerText = recoveredShortText;
    answerMarkdown = recoveredShortText;
  }

  return {
    answerText,
    answerMarkdown,
    answerHtml,
    meta: answerMeta,
  };
}

async function verifySubmittedUserTurnAttachments({
  runtime,
  attachmentNames,
  attachmentWaitTimedOut,
  skipUiVerification,
  logger,
}: {
  runtime: ChromeClient["Runtime"];
  attachmentNames: string[];
  attachmentWaitTimedOut: boolean;
  skipUiVerification: boolean;
  logger: BrowserLogger;
}): Promise<void> {
  if (attachmentNames.length === 0) {
    return;
  }
  if (attachmentWaitTimedOut) {
    logger("Attachment confirmation timed out; skipping user-turn attachment verification.");
    return;
  }
  if (skipUiVerification) {
    logger("Attachment UI did not render before send; skipping user-turn attachment verification.");
    return;
  }
  const verified = await waitForUserTurnAttachments(runtime, attachmentNames, 20_000, logger);
  if (!verified) {
    throw new Error("Sent user message did not expose attachment UI after upload.");
  }
  logger("Verified attachments present on sent user message");
}

async function waitForConversationUrlHint(
  runtime: ChromeClient["Runtime"],
  timeoutMs = 10_000,
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const currentUrl = await readConversationUrl(runtime);
    if (currentUrl?.includes("/c/")) {
      return currentUrl;
    }
    await delay(250);
  }
  return null;
}

async function _assertNavigatedToHttp(
  runtime: ChromeClient["Runtime"],
  _logger: BrowserLogger,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = "";
  while (Date.now() < deadline) {
    const { result } = await runtime.evaluate({
      expression: 'typeof location === "object" && location.href ? location.href : ""',
      returnByValue: true,
    });
    const url = typeof result?.value === "string" ? result.value : "";
    lastUrl = url;
    if (/^https?:\/\//i.test(url)) {
      return url;
    }
    await delay(250);
  }
  throw new BrowserAutomationError("ChatGPT session not detected; page never left new tab.", {
    stage: "execute-browser",
    details: { url: lastUrl || "(empty)" },
  });
}

export async function maybeReuseRunningChrome(
  userDataDir: string,
  logger: BrowserLogger,
  options: {
    waitForPortMs?: number;
    probe?: typeof verifyDevToolsReachable;
    failOnLiveChromeWithoutDevtools?: boolean;
  } = {},
): Promise<LaunchedChrome | null> {
  const waitForPortMs = Math.max(0, options.waitForPortMs ?? 0);
  let port = await readDevToolsPort(userDataDir);
  let pid = await readChromePid(userDataDir);
  const hasLiveChromePid = () => Boolean(pid && isProcessAlive(pid));
  if (!port && waitForPortMs > 0) {
    const deadline = Date.now() + waitForPortMs;
    logger(
      hasLiveChromePid()
        ? `Chrome pid ${pid} is already alive for ${userDataDir}; waiting up to ${formatElapsed(waitForPortMs)} for DevTools to appear...`
        : `Waiting up to ${formatElapsed(waitForPortMs)} for shared Chrome to appear...`,
    );
    while (!port && Date.now() < deadline) {
      await delay(250);
      port = await readDevToolsPort(userDataDir);
      pid = await readChromePid(userDataDir);
    }
  }
  if (!port) return null;

  const probeDevTools = options.probe ?? verifyDevToolsReachable;
  let probe = await probeDevTools({ port });
  if (!probe.ok && waitForPortMs > 0 && hasLiveChromePid()) {
    const deadline = Date.now() + waitForPortMs;
    logger(
      `DevToolsActivePort found for ${userDataDir} but unreachable (${probe.error}); Chrome pid ${pid} is still alive, waiting for DevTools to recover...`,
    );
    while (Date.now() < deadline) {
      await delay(500);
      port = await readDevToolsPort(userDataDir);
      pid = await readChromePid(userDataDir);
      if (!port) {
        continue;
      }
      probe = await probeDevTools({ port });
      if (probe.ok) {
        break;
      }
      if (!hasLiveChromePid()) {
        break;
      }
    }
  }
  if (!probe.ok) {
    if (options.failOnLiveChromeWithoutDevtools && hasLiveChromePid()) {
      throw new BrowserAutomationError(
        `A Chrome process is already using the shared Oracle profile (${userDataDir}), but DevTools is still unreachable after waiting ${formatElapsed(waitForPortMs)}. Refusing to launch a second Chrome instance for that profile.`,
        {
          stage: "manual-login-devtools-unreachable",
          userDataDir,
          chromePid: pid ?? null,
          waitForPortMs,
          probeError: probe.error,
        },
      );
    }
    logger(
      `DevToolsActivePort found for ${userDataDir} but unreachable (${probe.error}); launching new Chrome.`,
    );
    // Safe cleanup: remove stale DevToolsActivePort; only remove lock files if this was an Oracle-owned pid that died.
    await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "if_oracle_pid_dead" });
    return null;
  }

  logger(
    `Found running Chrome for ${userDataDir}; reusing (DevTools port ${port}${pid ? `, pid ${pid}` : ""})`,
  );
  return {
    port,
    pid: pid ?? undefined,
    kill: async () => {},
    process: undefined,
  } as unknown as LaunchedChrome;
}

async function runRemoteBrowserMode(
  promptText: string,
  attachments: BrowserAttachment[],
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
  options: BrowserRunOptions,
): Promise<BrowserRunResult> {
  const remoteChromeConfig = config.remoteChrome;
  if (!remoteChromeConfig) {
    throw new Error(
      "Remote Chrome configuration missing. Pass --remote-chrome <host:port> to use this mode.",
    );
  }
  const { host, port } = remoteChromeConfig;
  logger(`Connecting to remote Chrome at ${host}:${port}`);

  let client: ChromeClient | null = null;
  let remoteTargetId: string | null = null;
  let lastUrl: string | undefined;
  let conversationHintInFlight: Promise<boolean> | null = null;
  const runtimeHintCb = options.runtimeHintCb;
  const emitRuntimeHint = async () => {
    if (!runtimeHintCb) return;
    try {
      await runtimeHintCb({
        chromePort: port,
        chromeHost: host,
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chromeProfileRoot,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: lastUrl,
        conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
        controllerPid: process.pid,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
    }
  };
  const startedAt = Date.now();
  let answerText = "";
  let answerMarkdown = "";
  let answerHtml = "";
  let answerMeta: { turnId?: string | null; messageId?: string | null } = {};
  let connectionClosedUnexpectedly = false;
  let stopThinkingMonitor: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let connection: Awaited<ReturnType<typeof connectToRemoteChrome>> | null = null;
  const browserWSEndpoint = config.remoteChromeBrowserWSEndpoint ?? undefined;
  const chromeProfileRoot = config.remoteChromeProfileRoot ?? undefined;
  const preserveRemoteTarget = Boolean(config.keepBrowser);

  try {
    connection = await connectToRemoteChrome(host, port, logger, config.url, browserWSEndpoint, {
      approvalWaitMs: config.attachRunning && browserWSEndpoint ? 20_000 : undefined,
      closeTargetOnDispose: !preserveRemoteTarget,
    });
    client = connection.client;
    remoteTargetId = connection.targetId ?? null;
    await emitRuntimeHint();
    const markConnectionLost = () => {
      connectionClosedUnexpectedly = true;
    };
    client.on("disconnect", markConnectionLost);
    const { Network, Page, Runtime, Input, DOM } = client;

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);

    // Skip cookie sync for remote Chrome - it already has cookies
    logger("Skipping cookie sync for remote Chrome (using existing session)");

    const baseUrl = CHATGPT_URL;
    await navigateToChatGPT(Page, Runtime, baseUrl, logger);
    await ensureNotBlocked(Runtime, config.headless, logger);
    await ensureLoggedIn(Runtime, logger, { remoteSession: true });
    if (config.url !== baseUrl) {
      await navigateToPromptReadyWithFallback(Page, Runtime, {
        url: config.url,
        fallbackUrl: baseUrl,
        timeoutMs: config.inputTimeoutMs,
        headless: config.headless,
        logger,
      });
    } else {
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
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
        lastUrl = result.value;
      }
      await emitRuntimeHint();
    } catch {
      // ignore
    }
    const updateConversationHint = async (label: string, timeoutMs = 10_000): Promise<boolean> => {
      const conversationUrl = await waitForConversationUrlHint(Runtime, timeoutMs);
      if (conversationUrl) {
        lastUrl = conversationUrl;
        logger(`[browser] conversation url (${label}) = ${lastUrl}`);
        await emitRuntimeHint();
        return true;
      }
      return false;
    };
    const startConversationHint = async (label: string, timeoutMs = 10_000): Promise<boolean> => {
      if (conversationHintInFlight) {
        return await conversationHintInFlight;
      }
      conversationHintInFlight = updateConversationHint(label, timeoutMs)
        .catch(() => false)
        .finally(() => {
          conversationHintInFlight = null;
        });
      return await conversationHintInFlight;
    };
    const scheduleConversationHint = (label: string, timeoutMs?: number): void => {
      void startConversationHint(label, timeoutMs);
    };

    const modelStrategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
    if (config.desiredModel && modelStrategy !== "ignore") {
      await withRetries(
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
    } else if (modelStrategy === "ignore") {
      logger("Model picker: skipped (strategy=ignore)");
    }
    // Handle thinking time selection if specified
    const thinkingTime = config.thinkingTime;
    if (thinkingTime) {
      await withRetries(() => ensureThinkingTime(Runtime, thinkingTime, logger), {
        retries: 2,
        delayMs: 300,
        onRetry: (attempt, error) => {
          if (options.verbose) {
            logger(
              `[retry] Thinking time (${thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
            );
          }
        },
      });
    }

    const submitOnce = async (prompt: string, submissionAttachments: BrowserAttachment[]) => {
      const baselineSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);
      const baselineAssistantText =
        typeof baselineSnapshot?.text === "string" ? baselineSnapshot.text.trim() : "";
      const attachmentNames = submissionAttachments.map((a) => path.basename(a.path));
      await ensureBackendApiReachable(Runtime, logger);
      await clearPromptComposer(Runtime, logger);
      let attachmentWaitTimedOut = false;
      if (submissionAttachments.length > 0) {
        if (!DOM) {
          throw new Error("Chrome DOM domain unavailable while uploading attachments.");
        }
        await clearComposerAttachments(Runtime, 5_000, logger);
        // Use remote file transfer for remote Chrome (reads local files and injects via CDP)
        for (const attachment of submissionAttachments) {
          logger(`Uploading attachment: ${attachment.displayPath}`);
          await uploadAttachmentViaDataTransfer({ runtime: Runtime, dom: DOM }, attachment, logger);
          await delay(500);
        }
        // Scale timeout based on number of files: base 30s + 15s per additional file
        const baseTimeout = config.inputTimeoutMs ?? 30_000;
        const perFileTimeout = 15_000;
        const waitBudget =
          Math.max(baseTimeout, 30_000) + (submissionAttachments.length - 1) * perFileTimeout;
        try {
          await waitForAttachmentCompletion(Runtime, waitBudget, attachmentNames, logger);
          logger("All attachments uploaded");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/Attachments did not finish uploading before timeout/i.test(message)) {
            attachmentWaitTimedOut = true;
            logger(
              `[browser] Attachment upload timed out after ${Math.round(waitBudget / 1000)}s; continuing without confirmation.`,
            );
          } else {
            throw error;
          }
        }
      }
      let baselineTurns = await readConversationTurnCount(Runtime, logger);
      const sendAttachmentNames = attachmentWaitTimedOut ? [] : attachmentNames;
      const providerState: Record<string, unknown> = {
        runtime: Runtime,
        input: Input,
        logger,
        timeoutMs: config.timeoutMs,
        inputTimeoutMs: config.inputTimeoutMs ?? undefined,
        baselineTurns: baselineTurns ?? undefined,
        attachmentNames: sendAttachmentNames,
      };
      await runProviderSubmissionFlow(chatgptDomProvider, {
        prompt,
        evaluate: async () => undefined,
        delay,
        log: logger,
        state: providerState,
      });
      const providerBaselineTurns = providerState.baselineTurns;
      if (typeof providerBaselineTurns === "number" && Number.isFinite(providerBaselineTurns)) {
        baselineTurns = providerBaselineTurns;
      }
      await verifySubmittedUserTurnAttachments({
        runtime: Runtime,
        attachmentNames,
        attachmentWaitTimedOut,
        skipUiVerification: false,
        logger,
      });
      const immediateConversationHintTimeoutMs = Math.max(
        2_000,
        Math.min(config.timeoutMs ?? 120_000, 10_000),
      );
      const hintedConversation = await ensureConversationIdentityHint(
        () => lastUrl,
        startConversationHint,
        "post-submit-prime",
        immediateConversationHintTimeoutMs,
      );
      if (!hintedConversation) {
        logger(
          "[browser] ChatGPT did not expose a conversation URL immediately after send; keeping background identity watcher alive.",
        );
        scheduleConversationHint("post-submit", 15_000);
      } else {
        await emitRuntimeHint();
      }
      return { baselineTurns, baselineAssistantText };
    };

    let baselineTurns: number | null = null;
    let baselineAssistantText: string | null = null;
    try {
      const submission = await submitOnce(promptText, attachments);
      baselineTurns = submission.baselineTurns;
      baselineAssistantText = submission.baselineAssistantText;
    } catch (error) {
      const isPromptTooLarge =
        error instanceof BrowserAutomationError &&
        (error.details as { code?: string } | undefined)?.code === "prompt-too-large";
      if (options.fallbackSubmission && isPromptTooLarge) {
        logger("[browser] Inline prompt too large; retrying with file uploads.");
        await clearPromptComposer(Runtime, logger);
        await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
        const submission = await submitOnce(
          options.fallbackSubmission.prompt,
          options.fallbackSubmission.attachments,
        );
        baselineTurns = submission.baselineTurns;
        baselineAssistantText = submission.baselineAssistantText;
      } else {
        throw error;
      }
    }
    stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, options.verbose ?? false);
    let answer: AssistantPayload;
    const recheckDelayMs = Math.max(0, config.assistantRecheckDelayMs ?? 0);
    const recheckTimeoutMs = Math.max(0, config.assistantRecheckTimeoutMs ?? 0);
    const attemptAssistantRecheck = async () => {
      if (!recheckDelayMs) return null;
      logger(
        `[browser] Assistant response timed out; waiting ${formatElapsed(recheckDelayMs)} before rechecking conversation.`,
      );
      await delay(recheckDelayMs);
      const conversationUrl = await readConversationUrl(Runtime);
      if (conversationUrl && isConversationUrl(conversationUrl)) {
        lastUrl = conversationUrl;
        logger(`[browser] Rechecking assistant response at ${conversationUrl}`);
        await Page.navigate({ url: conversationUrl });
        await delay(1000);
      }
      // Validate session before attempting recheck - sessions can expire during the delay
      const sessionValid = await validateChatGPTSession(Runtime, logger);
      if (!sessionValid.valid) {
        logger(`[browser] Session validation failed: ${sessionValid.reason}`);
        // Update session metadata to indicate login is needed
        await emitRuntimeHint();
        throw new BrowserAutomationError(
          `ChatGPT session expired during recheck: ${sessionValid.reason}. ` +
            `Conversation URL: ${conversationUrl || lastUrl || "unknown"}. ` +
            `Please sign in and retry.`,
          {
            stage: "assistant-recheck",
            details: {
              conversationUrl: conversationUrl || lastUrl || null,
              sessionStatus: "needs_login",
              validationReason: sessionValid.reason,
            },
            runtime: {
              chromeHost: host,
              chromePort: port,
              chromeBrowserWSEndpoint: browserWSEndpoint,
              chromeProfileRoot,
              chromeTargetId: remoteTargetId ?? undefined,
              tabUrl: lastUrl,
              conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
              controllerPid: process.pid,
            },
          },
        );
      }
      await emitRuntimeHint();
      const timeoutMs = recheckTimeoutMs > 0 ? recheckTimeoutMs : config.timeoutMs;
      const rechecked = await waitForAssistantResponseWithReload(
        Runtime,
        Page,
        timeoutMs,
        logger,
        baselineTurns ?? undefined,
      );
      logger("Recovered assistant response after delayed recheck");
      return rechecked;
    };
    try {
      answer = await waitForAssistantResponseWithReload(
        Runtime,
        Page,
        config.timeoutMs,
        logger,
        baselineTurns ?? undefined,
      );
    } catch (error) {
      if (isAssistantRateLimitError(error)) {
        try {
          const conversationUrl = await readConversationUrl(Runtime);
          if (conversationUrl) {
            lastUrl = conversationUrl;
          }
        } catch {
          // ignore
        }
        await emitRuntimeHint();
        const runtime = {
          chromePort: port,
          chromeHost: host,
          chromeBrowserWSEndpoint: browserWSEndpoint,
          chromeProfileRoot,
          chromeTargetId: remoteTargetId ?? undefined,
          tabUrl: lastUrl,
          conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
          controllerPid: process.pid,
        };
        throw new BrowserAutomationError(
          "ChatGPT temporarily limited this browser profile after too many requests. Wait a few minutes before retrying.",
          { stage: "assistant-rate-limit", runtime },
          error,
        );
      }
      if (isAssistantResponseTimeoutError(error)) {
        const rechecked = await attemptAssistantRecheck().catch(() => null);
        if (rechecked) {
          answer = rechecked;
        } else {
          try {
            const conversationUrl = await readConversationUrl(Runtime);
            if (conversationUrl) {
              lastUrl = conversationUrl;
            }
          } catch {
            // ignore
          }
          await emitRuntimeHint();
          const runtime = {
            chromePort: port,
            chromeHost: host,
            chromeBrowserWSEndpoint: browserWSEndpoint,
            chromeProfileRoot,
            chromeTargetId: remoteTargetId ?? undefined,
            tabUrl: lastUrl,
            conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
            controllerPid: process.pid,
          };
          throw new BrowserAutomationError(
            "Assistant response timed out before completion; reattach later to capture the answer.",
            { stage: "assistant-timeout", runtime },
            error,
          );
        }
      } else {
        throw error;
      }
    }
    ({
      answerText,
      answerMarkdown,
      answerHtml,
      meta: answerMeta,
    } = await finalizeAssistantResponseCapture({
      runtime: Runtime,
      promptText,
      baselineTurns,
      baselineAssistantText,
      answer,
      logger,
      captureMarkdown: async () =>
        await withRetries(
          async () => {
            const attempt = await captureAssistantMarkdown(Runtime, answer.meta, logger);
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
        ).catch(() => null),
    }));
    await updateConversationHint("post-response", 15_000).catch(() => false);
    await emitRuntimeHint();
    stopThinkingMonitor?.();

    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);
    const downloads = await captureAssistantDownloads({
      browserWSEndpoint: browserWSEndpoint,
      chromeHost: host,
      chromePort: port,
      chromeTargetId: remoteTargetId ?? undefined,
      tabUrl: lastUrl,
      conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
      downloadsDir: options.downloadsDir,
      meta: answerMeta,
      logger,
    }).catch((error) => {
      logger.sessionLog?.(
        `[browser-downloads] skipped during remote browser run: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    });

    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      downloads,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      browserTransport: "cdp",
      chromePid: undefined,
      chromePort: port,
      chromeHost: host,
      chromeBrowserWSEndpoint: browserWSEndpoint,
      chromeProfileRoot,
      userDataDir: undefined,
      chromeTargetId: remoteTargetId ?? undefined,
      tabUrl: lastUrl,
      conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
      controllerPid: process.pid,
    };
  } catch (error) {
    const runtime = {
      chromeHost: host,
      chromePort: port,
      chromeBrowserWSEndpoint: browserWSEndpoint,
      chromeProfileRoot,
      chromeTargetId: remoteTargetId ?? undefined,
      tabUrl: lastUrl,
      conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
      controllerPid: process.pid,
    };
    const normalizedError = attachBrowserRuntimeIfMissing(
      error instanceof Error ? error : new Error(String(error)),
      runtime,
    );
    stopThinkingMonitor?.();
    const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
    connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;

    if (!socketClosed) {
      logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
      if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
        logger(normalizedError.stack);
      }
      throw normalizedError;
    }

    throw new BrowserAutomationError("Remote Chrome connection lost before Oracle finished.", {
      stage: "connection-lost",
      runtime,
    });
  } finally {
    try {
      if (!connectionClosedUnexpectedly && connection) {
        await connection.close();
      }
    } catch {
      // ignore
    }
    removeDialogHandler?.();
    // Don't kill remote Chrome - it's not ours to manage
    const totalSeconds = (Date.now() - startedAt) / 1000;
    logger(`Remote session complete • ${totalSeconds.toFixed(1)}s total`);
  }
}

export { estimateTokenCount } from "./utils.js";
export { resolveBrowserConfig, DEFAULT_BROWSER_CONFIG } from "./config.js";

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  listIgnoredRemoteChromeFlags,
  shouldReloadAfterAssistantError,
  isAssistantResponseTimeoutError,
  shouldReplaceAssistantCaptureWithDomSnapshot,
  ensureConversationIdentityHint,
};
export { syncCookies } from "./cookies.js";
export {
  navigateToChatGPT,
  ensureNotBlocked,
  ensurePromptReady,
  ensureModelSelection,
  submitPrompt,
  waitForAssistantResponse,
  captureAssistantMarkdown,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
} from "./pageActions.js";

export async function maybeReuseRunningChromeForTest(
  userDataDir: string,
  logger: BrowserLogger,
  options: {
    waitForPortMs?: number;
    probe?: typeof verifyDevToolsReachable;
    failOnLiveChromeWithoutDevtools?: boolean;
  } = {},
): Promise<LaunchedChrome | null> {
  return maybeReuseRunningChrome(userDataDir, logger, options);
}

export function isWebSocketClosureError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("websocket connection closed") ||
    message.includes("websocket is closed") ||
    message.includes("websocket error") ||
    message.includes("inspected target navigated or closed") ||
    message.includes("target closed")
  );
}

export function formatThinkingLog(
  startedAt: number,
  now: number,
  message: string,
  locatorSuffix: string,
): string {
  const elapsedMs = now - startedAt;
  const elapsedText = formatElapsed(elapsedMs);
  const progress = Math.min(1, elapsedMs / 600_000); // soft target: 10 minutes
  const pct = Math.round(progress * 100)
    .toString()
    .padStart(3, " ");
  const statusLabel = message ? ` — ${message}` : "";
  return `${pct}% [${elapsedText} / ~10m]${statusLabel}${locatorSuffix}`;
}

async function waitForAssistantResponseWithReload(
  Runtime: ChromeClient["Runtime"],
  Page: ChromeClient["Page"],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
) {
  try {
    return await waitForAssistantResponse(Runtime, timeoutMs, logger, minTurnIndex);
  } catch (error) {
    if (!shouldReloadAfterAssistantError(error)) {
      throw error;
    }
    const conversationUrl = await readConversationUrl(Runtime);
    if (!conversationUrl || !isConversationUrl(conversationUrl)) {
      throw error;
    }
    logger("Assistant response stalled; reloading conversation and retrying once");
    await Page.navigate({ url: conversationUrl });
    await delay(1000);
    return await waitForAssistantResponse(Runtime, timeoutMs, logger, minTurnIndex);
  }
}

function isAssistantEmptyResponseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.toLowerCase().includes("assistant-response-empty-turn");
}

function shouldReloadAfterAssistantError(error: unknown): boolean {
  if (isAssistantEmptyResponseError(error)) {
    return false;
  }
  if (isAssistantRateLimitError(error)) {
    return false;
  }
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("assistant-response") ||
    message.includes("watchdog") ||
    message.includes("timeout") ||
    message.includes("capture assistant response")
  );
}

function isAssistantResponseTimeoutError(error: unknown): boolean {
  if (isAssistantEmptyResponseError(error)) {
    return false;
  }
  if (isAssistantRateLimitError(error)) {
    return false;
  }
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (!message) return false;
  return (
    message.includes("assistant-response") ||
    message.includes("assistant response") ||
    message.includes("watchdog") ||
    message.includes("capture assistant response")
  );
}

async function readConversationUrl(Runtime: ChromeClient["Runtime"]): Promise<string | null> {
  try {
    const currentUrl = await Runtime.evaluate({ expression: "location.href", returnByValue: true });
    return typeof currentUrl.result?.value === "string" ? currentUrl.result.value : null;
  } catch {
    return null;
  }
}

interface SessionValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates that the ChatGPT session is still active by checking for login CTAs
 * and textarea availability. Sessions can expire during long delays (e.g., recheck).
 *
 * @param Runtime - Chrome Runtime client
 * @param logger - Browser logger for diagnostics
 * @returns SessionValidationResult indicating if session is valid and reason if not
 */
async function validateChatGPTSession(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<SessionValidationResult> {
  try {
    const outcome = await Runtime.evaluate({
      expression: buildSessionValidationExpression(),
      awaitPromise: true,
      returnByValue: true,
    });

    const result = outcome.result?.value as
      | {
          valid: boolean;
          hasLoginCta: boolean;
          hasTextarea: boolean;
          onAuthPage: boolean;
          pageUrl: string | null;
        }
      | undefined;

    if (!result) {
      return { valid: false, reason: "Failed to evaluate session state" };
    }

    if (result.onAuthPage) {
      return { valid: false, reason: "Redirected to auth page" };
    }

    if (result.hasLoginCta) {
      return { valid: false, reason: "Login button detected on page" };
    }

    if (!result.hasTextarea) {
      return { valid: false, reason: "Prompt textarea not available" };
    }

    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Session validation error: ${message}`);
    return { valid: false, reason: `Validation error: ${message}` };
  }
}

function buildSessionValidationExpression(): string {
  const selectorLiteral = JSON.stringify(INPUT_SELECTORS);
  return `(async () => {
    const pageUrl = typeof location === 'object' && location?.href ? location.href : null;
    const onAuthPage =
      typeof location === 'object' &&
      typeof location.pathname === 'string' &&
      /^\\/(auth|login|signin)/i.test(location.pathname);

    // Check for login CTAs (similar to ensureLoggedIn logic)
    const hasLoginCta = (() => {
      const candidates = Array.from(
        document.querySelectorAll(
          [
            'a[href*="/auth/login"]',
            'a[href*="/auth/signin"]',
            'button[type="submit"]',
            'button[data-testid*="login"]',
            'button[data-testid*="log-in"]',
            'button[data-testid*="sign-in"]',
            'button[data-testid*="signin"]',
            'button',
            'a',
          ].join(','),
        ),
      );
      const textMatches = (text) => {
        if (!text) return false;
        const normalized = text.toLowerCase().trim();
        return ['log in', 'login', 'sign in', 'signin', 'continue with'].some((needle) =>
          normalized.startsWith(needle),
        );
      };
      for (const node of candidates) {
        if (!(node instanceof HTMLElement)) continue;
        const label =
          node.textContent?.trim() ||
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          '';
        if (textMatches(label)) {
          return true;
        }
      }
      return false;
    })();

    // Check for textarea availability
    const hasTextarea = (() => {
      const selectors = ${selectorLiteral};
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node) {
          return true;
        }
      }
      return false;
    })();

    return {
      valid: !onAuthPage && !hasLoginCta && hasTextarea,
      hasLoginCta,
      hasTextarea,
      onAuthPage,
      pageUrl,
    };
  })()`;
}

async function readConversationTurnCount(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
): Promise<number | null> {
  const attempts = 24;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { result } = await Runtime.evaluate({
        expression: `(() => {
          ${buildThreadIntrospectionHelpers()}
          const href = typeof location === 'object' && location.href ? location.href : '';
          const inConversation = /\\/c\\/[a-z0-9-]+/i.test(href);
          const entries = __oracleCollectThreadEntries(__oraclePickThreadRoot());
          const turns = entries.filter((entry) => entry.role === 'user' || entry.role === 'assistant');
          return {
            href,
            inConversation,
            turnCount: turns.length,
          };
        })()`,
        returnByValue: true,
      });
      const payload = result?.value as { inConversation?: boolean; turnCount?: number } | undefined;
      const raw =
        typeof payload?.turnCount === "number" ? payload.turnCount : Number(payload?.turnCount);
      if (!Number.isFinite(raw)) {
        throw new Error("Turn count not numeric");
      }
      const turnCount = Math.max(0, Math.floor(raw));
      if (payload?.inConversation && turnCount === 0 && attempt < attempts - 1) {
        await delay(attempt < 8 ? 250 : 500);
        continue;
      }
      return turnCount;
    } catch (error) {
      if (attempt < attempts - 1) {
        await delay(attempt < 8 ? 250 : 500);
        continue;
      }
      if (logger?.verbose) {
        logger(
          `Failed to read conversation turn count: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    }
  }
  return null;
}

function isConversationUrl(url: string): boolean {
  return /\/c\/[a-z0-9-]+/i.test(url);
}

function startThinkingStatusMonitor(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  includeDiagnostics = false,
): () => void {
  let stopped = false;
  let pending = false;
  let lastMessage: string | null = null;
  const startedAt = Date.now();
  const interval = setInterval(async () => {
    // stop flag flips asynchronously
    if (stopped || pending) {
      return;
    }
    pending = true;
    try {
      const nextMessage = await readThinkingStatus(Runtime);
      if (nextMessage && nextMessage !== lastMessage) {
        lastMessage = nextMessage;
        let locatorSuffix = "";
        if (includeDiagnostics) {
          try {
            const snapshot = await readAssistantSnapshot(Runtime);
            locatorSuffix = ` | assistant-turn=${snapshot ? "present" : "missing"}`;
          } catch {
            locatorSuffix = " | assistant-turn=error";
          }
        }
        logger(formatThinkingLog(startedAt, Date.now(), nextMessage, locatorSuffix));
      }
    } catch {
      // ignore DOM polling errors
    } finally {
      pending = false;
    }
  }, 1500);
  interval.unref?.();
  return () => {
    // multiple callers may race to stop
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(interval);
  };
}

async function readThinkingStatus(Runtime: ChromeClient["Runtime"]): Promise<string | null> {
  const expression = buildThinkingStatusExpression();
  try {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    const value = typeof result.value === "string" ? result.value.trim() : "";
    const sanitized = sanitizeThinkingText(value);
    return sanitized || null;
  } catch {
    return null;
  }
}

function sanitizeThinkingText(raw: string): string {
  if (!raw) {
    return "";
  }
  const trimmed = raw.trim();
  const prefixPattern = /^(pro thinking)\s*[•:\-–—]*\s*/i;
  if (prefixPattern.test(trimmed)) {
    return trimmed.replace(prefixPattern, "").trim();
  }
  return trimmed;
}

function describeDevtoolsFirewallHint(host: string, port: number): string | null {
  if (!isWsl()) return null;
  return [
    `DevTools port ${host}:${port} is blocked from WSL.`,
    "",
    "PowerShell (admin):",
    `New-NetFirewallRule -DisplayName 'Chrome DevTools ${port}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port}`,
    "New-NetFirewallRule -DisplayName 'Chrome DevTools (chrome.exe)' -Direction Inbound -Action Allow -Program 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' -Protocol TCP",
    "",
    "Re-run the same oracle command after adding the rule.",
  ].join("\n");
}

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  return os.release().toLowerCase().includes("microsoft");
}

function extractConversationIdFromUrl(url: string): string | undefined {
  const match = url.match(/\/c\/([a-zA-Z0-9-]+)/);
  return match?.[1];
}

async function resolveUserDataBaseDir(): Promise<string> {
  // On WSL, Chrome launched via Windows can choke on UNC paths; prefer a Windows-backed temp folder.
  if (isWsl()) {
    const candidates = [
      "/mnt/c/Users/Public/AppData/Local/Temp",
      "/mnt/c/Temp",
      "/mnt/c/Windows/Temp",
    ];
    for (const candidate of candidates) {
      try {
        await mkdir(candidate, { recursive: true });
        return candidate;
      } catch {
        // try next
      }
    }
  }
  return os.tmpdir();
}

function buildThinkingStatusExpression(): string {
  const selectors = [
    "span.loading-shimmer",
    "span.flex.items-center.gap-1.truncate.text-start.align-middle.text-token-text-tertiary",
    '[data-testid*="thinking"]',
    '[data-testid*="reasoning"]',
    '[role="status"]',
    '[aria-live="polite"]',
  ];
  const keywords = [
    "pro thinking",
    "thinking",
    "reasoning",
    "clarifying",
    "planning",
    "drafting",
    "summarizing",
  ];
  const selectorLiteral = JSON.stringify(selectors);
  const keywordsLiteral = JSON.stringify(keywords);
  return `(() => {
    const selectors = ${selectorLiteral};
    const keywords = ${keywordsLiteral};
    const nodes = new Set();
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => nodes.add(node));
    }
    document.querySelectorAll('[data-testid]').forEach((node) => nodes.add(node));
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      const text = node.textContent?.trim();
      if (!text) {
        continue;
      }
      const classLabel = (node.className || '').toLowerCase();
      const dataLabel = ((node.getAttribute('data-testid') || '') + ' ' + (node.getAttribute('aria-label') || ''))
        .toLowerCase();
      const normalizedText = text.toLowerCase();
      const matches = keywords.some((keyword) =>
        normalizedText.includes(keyword) || classLabel.includes(keyword) || dataLabel.includes(keyword)
      );
      if (matches) {
        const shimmerChild = node.querySelector(
          'span.flex.items-center.gap-1.truncate.text-start.align-middle.text-token-text-tertiary',
        );
        if (shimmerChild?.textContent?.trim()) {
          return shimmerChild.textContent.trim();
        }
        return text.trim();
      }
    }
    return null;
  })()`;
}
