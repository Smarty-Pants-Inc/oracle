import { BrowserAutomationError } from "../oracle/errors.js";
import { resolveAttachRunningConnection } from "./attachRunning.js";
import { resolveBrowserConfig } from "./config.js";
import { describeBrowserControlPlan, formatBrowserControlPlan } from "./controlPlan.js";
import {
  listIgnoredRemoteChromeFlags,
  redactBrowserConfigForDebugLog,
} from "./coordinatorPolicy.js";
import { DEFAULT_DEBUG_PORT, pickAvailableDebugPort } from "./localExecutionContext.js";
import { runLocalBrowserMode } from "./localBrowserCoordinator.js";
import { runRemoteBrowserMode } from "./remoteBrowserCoordinator.js";
import { normalizeBrowserFollowUpPrompts } from "./responseCaptureCoordinator.js";
import type {
  BrowserAttachment,
  BrowserCaptureFinalizationResult,
  BrowserLogger,
  BrowserRunOptions,
  BrowserRunResult,
  BrowserRunTransaction,
} from "./types.js";

export async function runBrowserModeTransaction(
  options: BrowserRunOptions,
): Promise<BrowserRunTransaction> {
  const promptText = options.prompt?.trim();
  if (!promptText) {
    throw new Error("Prompt text is required when using browser mode.");
  }

  const attachments: BrowserAttachment[] = options.attachments ?? [];
  let config = resolveBrowserConfig(options.config);
  const usingCopiedProfile = Boolean(config.copyProfileSource);
  if (usingCopiedProfile && (config.attachRunning || config.remoteChrome)) {
    throw new BrowserAutomationError(
      "--copy-profile requires a locally launched Chrome instance and cannot be combined with attach-running or remote Chrome.",
      { stage: "profile-config" },
    );
  }
  if (config.attachRunning) {
    throw new BrowserAutomationError(
      "--browser-attach-running is disabled by Oracle's background-only policy; use --remote-chrome with a dedicated background browser instead.",
      { stage: "background-browser-policy" },
    );
  }
  const isResumingConversation = Boolean(config.resumeConversationUrl);
  const followUpPrompts = normalizeBrowserFollowUpPrompts(options.followUpPrompts);
  if (config.researchMode === "deep" && followUpPrompts.length > 0) {
    throw new BrowserAutomationError(
      "Browser follow-ups are not supported with Deep Research mode. Put the full research plan into the initial prompt or run a normal browser consult for multi-turn review.",
      {
        stage: "browser-follow-ups",
        details: { researchMode: "deep", followUps: followUpPrompts.length },
      },
    );
  }
  const logger: BrowserLogger = options.log ?? ((_message: string) => {});
  if (logger.verbose === undefined) {
    logger.verbose = Boolean(config.debug);
  }
  if (logger.sessionLog === undefined && options.log?.sessionLog) {
    logger.sessionLog = options.log.sessionLog;
  }
  if (config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") {
    logger(
      `[browser-mode] config: ${JSON.stringify({
        ...redactBrowserConfigForDebugLog(config),
        promptLength: promptText.length,
      })}`,
    );
  }
  for (const line of formatBrowserControlPlan(describeBrowserControlPlan(config), "browser")) {
    logger(line);
  }

  if (config.attachRunning) {
    const attached = await resolveAttachRunningConnection(config, logger);
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

  if (config.remoteChrome) {
    const ignoredFlags = listIgnoredRemoteChromeFlags(config);
    if (ignoredFlags.length > 0) {
      logger(`Note: --remote-chrome ignores local Chrome flags (${ignoredFlags.join(", ")}).`);
    }
    return runRemoteBrowserMode(promptText, attachments, config, logger, options);
  }

  return runLocalBrowserMode({
    options,
    promptText,
    attachments,
    config,
    logger,
    usingCopiedProfile,
    isResumingConversation,
    followUpPrompts,
  });
}

function projectPublicBrowserRunResult(transaction: BrowserRunTransaction): BrowserRunResult {
  const {
    runtime: _runtime,
    bindSettlement: _bindSettlement,
    finalize: _finalize,
    abort: _abort,
    chromePid: _chromePid,
    chromeProcessIdentity: _chromeProcessIdentity,
    chromePort: _chromePort,
    chromeHost: _chromeHost,
    chromeBrowserWSEndpoint: _chromeBrowserWSEndpoint,
    chromeProfileRoot: _chromeProfileRoot,
    userDataDir: _userDataDir,
    chromeTargetId: _chromeTargetId,
    tabUrl: _tabUrl,
    controllerPid: _controllerPid,
    ...result
  } = transaction;
  return result;
}

export async function runBrowserMode(options: BrowserRunOptions): Promise<
  BrowserRunResult & {
    readonly retryCleanup?: () => Promise<BrowserCaptureFinalizationResult["status"]>;
  }
> {
  const transaction = await runBrowserModeTransaction(options);
  const finalization = await transaction.finalize();
  const result = projectPublicBrowserRunResult(transaction);
  if (finalization.status === "pending") {
    Object.defineProperty(result, "retryCleanup", {
      configurable: false,
      enumerable: false,
      value: async () => (await transaction.finalize()).status,
      writable: false,
    });
    result.warnings = [
      ...(result.warnings ?? []),
      {
        code: "direct-finalize-cleanup-pending",
        severity: "warning",
        message: "The assistant answer is complete, but internal browser cleanup remains pending.",
        details: { stage: "browser-capture-finalization" },
      },
    ];
  }
  return result;
}
