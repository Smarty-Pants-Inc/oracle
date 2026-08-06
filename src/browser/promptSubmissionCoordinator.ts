import net from "node:net";
import path from "node:path";
import type { BrowserModelSelectionEvidence } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { captureDeepResearchTargetKeys } from "./actions/deepResearch.js";
import { resolveBrowserConfig } from "./config.js";
import type { BrowserAttachment, BrowserLogger, ChromeClient } from "./types.js";
import type { SessionBoundChromeClient } from "./chromeSessionTransport.js";
import type { BrowserSubmissionResult } from "./archiveSettlementCoordinator.js";
import { hasBrowserErrorCode } from "./coordinatorPolicy.js";
// Browser prompt submission, target baseline, and lane policy helpers.
export async function captureDeepResearchTargetBaseline(
  client: SessionBoundChromeClient,
  logger: BrowserLogger,
): Promise<{ targetKeys: string[]; captured: boolean }> {
  try {
    return { targetKeys: await captureDeepResearchTargetKeys(client), captured: true };
  } catch {
    logger(
      "[browser] Deep Research target baseline unavailable; retaining conversation-turn owner scoping.",
    );
    return { targetKeys: [], captured: false };
  }
}

export type BrowserSubmissionFallback = {
  prompt: string;
  attachments: BrowserAttachment[];
};

export async function runSubmissionWithRecovery({
  prompt,
  attachments,
  fallbackSubmission,
  submit,
  reloadPromptComposer,
  prepareFallbackSubmission,
  logger,
}: {
  prompt: string;
  attachments: BrowserAttachment[];
  fallbackSubmission?: BrowserSubmissionFallback;
  submit: (prompt: string, attachments: BrowserAttachment[]) => Promise<BrowserSubmissionResult>;
  reloadPromptComposer: () => Promise<void>;
  prepareFallbackSubmission: () => Promise<void>;
  logger: BrowserLogger;
}): Promise<BrowserSubmissionResult> {
  let currentPrompt = prompt;
  let currentAttachments = attachments;
  let retriedDeadComposer = false;
  let usedFallbackSubmission = false;

  while (true) {
    try {
      return await submit(currentPrompt, currentAttachments);
    } catch (error) {
      const isDeadComposer = hasBrowserErrorCode(error, "dead-composer");
      if (isDeadComposer && !retriedDeadComposer) {
        retriedDeadComposer = true;
        await reloadPromptComposer();
        continue;
      }

      const isPromptTooLarge =
        hasBrowserErrorCode(error, "prompt-too-large") &&
        error instanceof BrowserAutomationError &&
        error.details?.promptSubmissionRejected === true;
      if (fallbackSubmission && isPromptTooLarge && !usedFallbackSubmission) {
        usedFallbackSubmission = true;
        logger("[browser] Inline prompt too large; retrying with file uploads.");
        await prepareFallbackSubmission();
        currentPrompt = fallbackSubmission.prompt;
        currentAttachments = fallbackSubmission.attachments;
        continue;
      }

      throw error;
    }
  }
}

export async function runSubmissionWithRecoveryForTest(args: {
  prompt: string;
  attachments: BrowserAttachment[];
  fallbackSubmission?: BrowserSubmissionFallback;
  submit: (prompt: string, attachments: BrowserAttachment[]) => Promise<BrowserSubmissionResult>;
  reloadPromptComposer: () => Promise<void>;
  prepareFallbackSubmission: () => Promise<void>;
  logger: BrowserLogger;
}): Promise<BrowserSubmissionResult> {
  return runSubmissionWithRecovery(args);
}

export function resolveRemoteTabLeaseProfileDir(
  config: ReturnType<typeof resolveBrowserConfig>,
): string | null {
  if (!config.remoteChrome || !config.manualLogin || !config.manualLoginProfileDir) {
    return null;
  }
  return path.resolve(config.manualLoginProfileDir);
}

export function resolveRemoteTabLeaseProfileDirForTest(
  config: ReturnType<typeof resolveBrowserConfig>,
): string | null {
  return resolveRemoteTabLeaseProfileDir(config);
}

export function isLocalChromeHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  return net.isIPv4(normalized) && normalized.startsWith("127.");
}

export function isLocalChromeHostForTest(host: string): boolean {
  return isLocalChromeHost(host);
}

export async function closeRemoteConnectionAfterRun(options: {
  connectionClosedUnexpectedly: boolean;
  connection: { close: () => Promise<void> } | null;
  client: Pick<ChromeClient, "close"> | null;
  runStatus: "attempted" | "complete";
}): Promise<void> {
  if (options.connectionClosedUnexpectedly) {
    return;
  }
  if (!options.connection) {
    await options.client?.close();
    return;
  }
  if (options.runStatus === "complete") {
    await options.connection.close();
  } else {
    await options.client?.close();
  }
}

export function shouldCloseOwnedRunTargetAfterRun(options: {
  runStatus: "attempted" | "complete";
  ownsTarget: boolean;
  keepBrowser: boolean;
  closeOwnedTabOnComplete?: boolean;
  preserveForRecovery?: boolean;
}): boolean {
  return (
    options.ownsTarget &&
    !(options.runStatus === "attempted" && options.preserveForRecovery) &&
    (Boolean(options.closeOwnedTabOnComplete) || !options.keepBrowser)
  );
}

export function shouldCleanupBlankTabsAfterLastLease(options: {
  runStatus: "attempted" | "complete";
  ownsTarget: boolean;
  connectionClosedUnexpectedly: boolean;
  manualLogin: boolean;
  keepBrowser: boolean;
  chromePort?: number;
}): boolean {
  return (
    options.runStatus === "complete" &&
    options.ownsTarget &&
    !options.connectionClosedUnexpectedly &&
    options.manualLogin &&
    options.keepBrowser &&
    Boolean(options.chromePort)
  );
}

export function buildSkippedModelSelectionEvidence(
  desiredModel: string | null | undefined,
  strategy: BrowserModelSelectionEvidence["strategy"],
): BrowserModelSelectionEvidence {
  return {
    requestedModel: desiredModel ?? null,
    resolvedLabel: null,
    strategy,
    status: "skipped",
    verified: false,
    source: "config",
    capturedAt: new Date().toISOString(),
  };
}

const ATTACHMENT_UPLOAD_BASE_TIMEOUT_MS = 45_000;
const ATTACHMENT_UPLOAD_PER_FILE_MS = 20_000;
const ATTACHMENT_UPLOAD_PER_MIB_MS = 2_000;
const ATTACHMENT_UPLOAD_MAX_TIMEOUT_MS = 180_000;

export function resolveAttachmentUploadTimeoutMs(
  attachments: BrowserAttachment[],
  inputTimeoutMs?: number,
): number {
  const inputFloorMs =
    typeof inputTimeoutMs === "number" && Number.isFinite(inputTimeoutMs)
      ? Math.max(0, inputTimeoutMs)
      : 0;
  const knownBytes = attachments.reduce(
    (total, attachment) =>
      total +
      (typeof attachment.sizeBytes === "number" && Number.isFinite(attachment.sizeBytes)
        ? Math.max(0, attachment.sizeBytes)
        : 0),
    0,
  );
  // 45s baseline (including unknown sizes), +20s per extra file and +2s/MiB.
  // Cap automatic scaling at 3m, but preserve a larger explicit input-timeout override.
  const automaticTimeoutMs =
    ATTACHMENT_UPLOAD_BASE_TIMEOUT_MS +
    Math.max(0, attachments.length - 1) * ATTACHMENT_UPLOAD_PER_FILE_MS +
    Math.ceil(knownBytes / (1024 * 1024)) * ATTACHMENT_UPLOAD_PER_MIB_MS;
  return Math.max(inputFloorMs, Math.min(ATTACHMENT_UPLOAD_MAX_TIMEOUT_MS, automaticTimeoutMs));
}
