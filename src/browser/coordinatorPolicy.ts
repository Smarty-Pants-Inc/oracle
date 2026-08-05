import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { connectToRemoteChromeTarget } from "./chromeLifecycle.js";
import type { ManualChromeOwner } from "./manualChromeOwner.js";
import { verifyPromptCommitted } from "./pageActions.js";
import type { PromptCommitVerification } from "./actions/promptComposer.js";
import {
  connectionLostUserMessage,
  isRecoverableChromeDisconnect,
  probeChromeTargetLiveness,
} from "./cdpLiveness.js";
import { BrowserRunLifecycleController } from "./runLifecycle.js";
import type { BrowserLogger, ChromeClient, ResolvedBrowserConfig } from "./types.js";
// Browser coordinator error, warning, and connection policy.
export function redactBrowserConfigForDebugLog(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const redacted = { ...config };
  if (Array.isArray(config.inlineCookies)) {
    redacted.inlineCookies = `[redacted:${config.inlineCookies.length} cookies]`;
    redacted.inlineCookieCount = config.inlineCookies.length;
  }
  return redacted;
}

export function redactBrowserConfigForDebugLogForTest(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return redactBrowserConfigForDebugLog(config);
}

function isCloudflareChallengeError(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) return false;
  return (error.details as { stage?: string } | undefined)?.stage === "cloudflare-challenge";
}

function isReattachableCaptureError(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) return false;
  const stage = (error.details as { stage?: string } | undefined)?.stage;
  return stage === "assistant-timeout" || stage === "assistant-recheck";
}

export type PreservedBrowserErrorKind = "cloudflare-challenge" | "reattachable-capture";

export function classifyPreservedBrowserError(
  error: unknown,
  headless: boolean,
): PreservedBrowserErrorKind | null {
  if (headless) return null;
  if (isCloudflareChallengeError(error)) return "cloudflare-challenge";
  if (isReattachableCaptureError(error)) return "reattachable-capture";
  return null;
}

function shouldPreserveBrowserOnError(error: unknown, headless: boolean): boolean {
  return classifyPreservedBrowserError(error, headless) !== null;
}

export function normalizeAuthenticatedModelSelectionError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function shouldKeepLocalBrowserOpen(options: {
  effectiveKeepBrowser: boolean;
  preserveBrowserOnError: boolean;
  usingCopiedProfile: boolean;
}): boolean {
  if (options.usingCopiedProfile) return false;
  return options.effectiveKeepBrowser || options.preserveBrowserOnError;
}

export function shouldPreserveLocalOwnerForRecovery(options: {
  effectiveKeepBrowser: boolean;
  manualLogin: boolean;
  ownerDisposition: ManualChromeOwner["disposition"];
}): boolean {
  return (
    options.effectiveKeepBrowser || (options.manualLogin && options.ownerDisposition === "preserve")
  );
}

export type ChromeDisconnectAssessment = {
  liveness: Awaited<ReturnType<typeof probeChromeTargetLiveness>>;
  targetReachable: boolean;
  promptCommitted: boolean;
  recoverable: boolean;
};

export async function assessChromeDisconnect(options: {
  host: string;
  port: number;
  targetId?: string | null;
  browserWSEndpoint?: string;
  lifecycle: BrowserRunLifecycleController;
  recoveryAllowed: boolean;
  commitTimeoutMs?: number;
  logger: BrowserLogger;
}): Promise<ChromeDisconnectAssessment> {
  const dispatch = options.lifecycle.promptDispatch();
  const liveness: Awaited<ReturnType<typeof probeChromeTargetLiveness>> =
    await probeChromeTargetLiveness({
      host: options.host,
      port: options.port,
      targetId: options.targetId,
      browserWSEndpoint: options.browserWSEndpoint,
    }).catch((error) => ({
      endpointReachable: false,
      targetFound: null,
      error: error instanceof Error ? error.message : String(error),
    }));
  const targetId = options.targetId?.trim();
  const targetReachable = Boolean(targetId) && isRecoverableChromeDisconnect(liveness);
  let promptCommitted = dispatch.status === "committed";

  if (targetReachable && dispatch.status === "pending" && targetId) {
    let connection: Awaited<ReturnType<typeof connectToRemoteChromeTarget>> | null = null;
    let verification: PromptCommitVerification | null = null;
    try {
      connection = await connectToRemoteChromeTarget(options.host, options.port, options.logger, {
        targetId,
        browserWSEndpoint: options.browserWSEndpoint,
        closeTargetOnDispose: false,
      });
      await connection.client.Runtime.enable();
      verification = await verifyPromptCommitted(
        connection.client.Runtime,
        dispatch.prompt,
        Math.max(60_000, options.commitTimeoutMs ?? 0),
        options.logger,
        dispatch.baselineTurns,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger(`[browser] Could not verify prompt commit after disconnect: ${message}`);
    } finally {
      await connection?.close().catch(() => undefined);
    }
    if (verification) {
      await options.lifecycle.recordPromptCommitVerification(verification, {
        epochId: dispatch.epochId,
        promptSha256: dispatch.promptSha256,
      });
      promptCommitted = true;
    }
  }

  return {
    liveness,
    targetReachable,
    promptCommitted,
    recoverable: targetReachable && promptCommitted && options.recoveryAllowed,
  };
}

export function connectionLostMessage(options: {
  assessment: ChromeDisconnectAssessment;
  remote?: boolean;
  copiedProfile?: boolean;
}): string {
  if (options.assessment.recoverable) {
    return connectionLostUserMessage({ recoverable: true, remote: options.remote });
  }
  if (options.assessment.targetReachable) {
    if (options.copiedProfile) {
      return "Chrome DevTools disconnected after prompt dispatch; copy-profile runs cannot be reattached, so Oracle is closing the owned browser and removing the copied profile.";
    }
    if (!options.assessment.promptCommitted) {
      return `${options.remote ? "Remote Chrome" : "Chrome"} DevTools disconnected before Oracle could verify that the current prompt was committed; the target will not be retained.`;
    }
  }
  return connectionLostUserMessage({ recoverable: false, remote: options.remote });
}

export function connectionLostCause(
  assessment: ChromeDisconnectAssessment,
  copiedProfile = false,
):
  | "cdp-client-disconnect"
  | "chrome-closed"
  | "prompt-commit-unverified"
  | "copied-profile-not-reattachable" {
  if (!assessment.targetReachable) return "chrome-closed";
  if (copiedProfile) return "copied-profile-not-reattachable";
  if (!assessment.promptCommitted) return "prompt-commit-unverified";
  return "cdp-client-disconnect";
}

export function runtimeFromBrowserAutomationError(
  error: unknown,
): BrowserRuntimeMetadata | undefined {
  if (!(error instanceof BrowserAutomationError)) return undefined;
  return (error.details as { runtime?: BrowserRuntimeMetadata } | undefined)?.runtime;
}

export function disconnectAssessmentFailureError(options: {
  error: unknown;
  runtime: BrowserRuntimeMetadata;
  remote?: boolean;
}): BrowserAutomationError {
  const message = options.error instanceof Error ? options.error.message : String(options.error);
  const promptCommitted = options.runtime.promptEpoch?.status === "committed";
  return new BrowserAutomationError(
    `${options.remote ? "Remote Chrome" : "Chrome"} disconnected, but Oracle could not durably record the verified recovery authority: ${message}`,
    {
      stage: "connection-lost",
      code: "disconnect-assessment-failed",
      recoverableDisconnect: promptCommitted,
      disconnectCause: promptCommitted ? "cdp-client-disconnect" : "prompt-commit-unverified",
      runtime: options.runtime,
      assessmentError: message,
    },
    options.error,
  );
}

export type RecoverableDisconnectDetails = {
  stage?: string;
  recoverableDisconnect?: boolean;
  runtime?: BrowserRuntimeMetadata;
};

export function shouldPreserveBrowserOnErrorForTest(error: unknown, headless: boolean): boolean {
  return shouldPreserveBrowserOnError(error, headless);
}

export function classifyPreservedBrowserErrorForTest(
  error: unknown,
  headless: boolean,
): PreservedBrowserErrorKind | null {
  return classifyPreservedBrowserError(error, headless);
}

/**
 * Make the page behave like a focused foreground tab.
 *
 * The send button is activated with trusted CDP input events dispatched at
 * viewport coordinates. Chrome delivers those only to a window that is being
 * composited, so a hidden (`--browser-hide-window`), minimized, or occluded
 * window swallows the click while the automation still believes it clicked.
 * Soft-fails: focus emulation is an optimization, never a hard requirement.
 */
export async function enableFocusEmulation(
  client: ChromeClient,
  logger: BrowserLogger,
  label: string,
): Promise<void> {
  try {
    await client.Emulation.setFocusEmulationEnabled({ enabled: true });
    logger(`[browser] Focus emulation enabled for ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Focus emulation unavailable: ${message}`);
  }
}

export function listIgnoredRemoteChromeFlags(config: {
  attachRunning?: ResolvedBrowserConfig["attachRunning"];
  headless?: ResolvedBrowserConfig["headless"];
  hideWindow?: ResolvedBrowserConfig["hideWindow"];
  keepBrowser?: ResolvedBrowserConfig["keepBrowser"];
  chromePath?: ResolvedBrowserConfig["chromePath"];
}): string[] {
  return [
    config.headless ? "--browser-headless" : null,
    config.hideWindow ? "--browser-hide-window" : null,
    config.keepBrowser ? "--browser-keep-browser" : null,
    !config.attachRunning && config.chromePath ? "--browser-chrome-path" : null,
  ].filter((value): value is string => Boolean(value));
}

export function hasBrowserErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof BrowserAutomationError &&
    (error.details as { code?: string } | undefined)?.code === code
  );
}
