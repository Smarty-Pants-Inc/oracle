import { readSubmittedPromptFingerprint, readUserMessageIds } from "./promptFingerprint.js";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { claimBrowserTarget } from "./targetClaim.js";
import { resolveBrowserConfig } from "./config.js";
import { maybeReuseRunningChrome } from "./reuseChrome.js";
import { redactBrowserConfigForDebugLog } from "./configLogging.js";
import { copyChromeProfile } from "./profileCopy.js";
import { BrowserCancellation, withoutBrowserCancellation } from "./cancellation.js";
import type {
  BrowserRunOptions,
  BrowserRunResult,
  BrowserLogger,
  ChromeClient,
  BrowserAttachment,
  BrowserResearchPlanMetadata,
  ResolvedBrowserConfig,
  BrowserArchiveResult,
} from "./types.js";
import {
  launchChrome,
  registerTerminationHooks,
  positionChromeWindowOffscreen,
  positionChromeWindowOnscreen,
  connectToRemoteChrome,
  connectWithNewTab,
  closeTab,
  createChromePageTarget,
  ensureChromePageTargetAfterClose,
  closeBlankChromeTabs,
} from "./chromeLifecycle.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import {
  navigateToChatGPT,
  navigateToPromptReadyWithFallback,
  ensureNotBlocked,
  ensureLoggedIn,
  readChatGptAccountDigest,
  ensurePromptReady,
  ensureChatMode,
  waitForResumedConversationHydration,
  ensureChatGptScopeRetained,
  installJavaScriptDialogAutoDismissal,
  ensureModelSelection,
  clearPromptComposer,
  waitForAssistantResponse,
  captureAssistantMarkdown,
  captureComposerNavigationUrl,
  assertComposerPlusStayedInPlace,
  clearComposerAttachments,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  waitForUserTurnAttachments,
  readAssistantSnapshot,
} from "./pageActions.js";
import {
  assertChatGptAccountEmail,
  normalizeChatGptAccountDigest,
  normalizeChatGptAccountEmail,
} from "./chatgptAccount.js";
import { INPUT_SELECTORS } from "./constants.js";
import { uploadAttachmentViaDataTransfer } from "./actions/remoteFileTransfer.js";
import { ensureThinkingTime } from "./actions/thinkingTime.js";
import { throwIfAssistantUiError } from "./actions/assistantResponse.js";
import {
  finalizeProviderNativeCapture,
  type ProviderNativeCaptureSummary,
} from "./chatgptConversation.js";
import { startThinkingStatusMonitor } from "./actions/thinkingStatus.js";
import {
  classifyChatGptUiWarningText,
  collectChatGptUiWarnings,
  createAssistantTimeoutError,
  throwChatGptUiWarningIfPresent,
} from "./uiWarnings.js";
import {
  activateDeepResearch,
  captureDeepResearchTargetKeys,
  waitForDeepResearchCompletion,
  waitForResearchPlanAutoConfirm,
} from "./actions/deepResearch.js";
import { estimateTokenCount, withRetries, delay } from "./utils.js";
import { formatElapsed } from "../oracle/format.js";
import type {
  BrowserModelSelectionEvidence,
  BrowserThinkingSelectionEvidence,
  SessionArtifact,
} from "../sessionStore.js";
import { CHATGPT_URL, DEFAULT_MODEL_STRATEGY } from "./constants.js";
import type { LaunchedChrome } from "chrome-launcher";
import { BrowserAutomationError, BrowserRunCancelledError } from "../oracle/errors.js";
import {
  buildAttachmentBasenameCollisionDetails,
  findAttachmentBasenameCollisions,
  formatAttachmentBasenameCollisionMessage,
} from "./attachmentValidation.js";
import { alignPromptEchoPair, buildPromptEchoMatcher } from "./reattachHelpers.js";
import { buildConversationTurnCountExpression } from "./conversationTurns.js";
import type { ProfileRunLock } from "./profileState.js";
import {
  cleanupStaleProfileState,
  acquireProfileRunLock,
  shouldCleanupManualLoginProfileState,
  browserIdFromWebSocketEndpoint,
  resolveRemoteChromeBrowserIdentity,
  terminateRecordedChromeForProfile,
  writeChromePid,
  writeDevToolsActivePort,
} from "./profileState.js";
import {
  connectionLostUserMessage,
  isRecoverableChromeDisconnect,
  probeChromeTargetLiveness,
} from "./cdpLiveness.js";
import { acquireBrowserTabLease, type BrowserTabLease } from "./tabLeaseRegistry.js";
import {
  appendArtifacts,
  saveBrowserTranscriptArtifact,
  saveDeepResearchReportArtifact,
} from "./artifacts.js";
import { collectGeneratedImageArtifacts } from "./chatgptImages.js";
import { collectChatGptFileArtifacts } from "./chatgptFiles.js";
import { runProviderSubmissionFlow } from "./providerDomFlow.js";
import { chatgptDomProvider } from "./providers/index.js";
import { resolveAttachRunningConnection } from "./attachRunning.js";
import {
  assertChatGptTabOrigin,
  connectToExistingChatGptTab,
  expectedConversationIdForRef,
} from "./liveTabs.js";
import { captureBrowserDiagnostics } from "./domDebug.js";
import {
  archiveChatGptConversation,
  resolveBrowserArchiveDecision,
} from "./actions/archiveConversation.js";
import {
  assertManualLoginProfileReadyForRun,
  defaultManualLoginProfileDir,
  formatManualLoginSetupCommand,
  isManualLoginProfileInitialized,
  resolveManualLoginWaitMs,
} from "./manualLoginProfile.js";
import { describeBrowserControlPlan, formatBrowserControlPlan } from "./controlPlan.js";
import { CHROME_COOKIE_SYNC_WARNING, shouldSyncBrowserCookies } from "./policies.js";
import {
  createConversationUrlMonitor,
  type ConversationUrlMonitor,
} from "./conversationUrlMonitor.js";
import {
  extractStableConversationIdFromUrl as extractConversationIdFromUrl,
  isSameChatGptConversationUrl,
  isStableConversationUrl as isConversationUrl,
  parseChatGptConversationScope,
} from "./conversationUrl.js";

export type { BrowserAutomationConfig, BrowserRunOptions, BrowserRunResult } from "./types.js";
export { CHATGPT_URL, DEFAULT_MODEL_STRATEGY, DEFAULT_MODEL_TARGET } from "./constants.js";
export { parseDuration, delay, normalizeChatgptUrl, isTemporaryChatUrl } from "./utils.js";
export {
  formatThinkingLog,
  formatThinkingWaitingLog,
  buildThinkingStatusExpressionForTest,
  readThinkingStatusForTest,
  sanitizeThinkingText,
  startThinkingStatusMonitorForTest,
} from "./actions/thinkingStatus.js";
export function redactBrowserConfigForDebugLogForTest(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return redactBrowserConfigForDebugLog(config);
}

function isCloudflareChallengeError(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) return false;
  const details = error.details as { stage?: string; code?: string } | undefined;
  return details?.stage === "cloudflare-challenge" || details?.code === "cloudflare-challenge";
}

function isReattachableCaptureError(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) return false;
  const stage = (error.details as { stage?: string } | undefined)?.stage;
  return (
    stage === "assistant-timeout" ||
    stage === "assistant-recheck" ||
    stage === "attachment-verification" ||
    stage === "assistant-ui-error"
  );
}

type PreservedBrowserErrorKind = "cloudflare-challenge" | "reattachable-capture";

function classifyPreservedBrowserError(
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

function normalizeAuthenticatedModelSelectionError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function shouldKeepLocalBrowserOpen(options: {
  effectiveKeepBrowser: boolean;
  preserveBrowserOnError: boolean;
  usingCopiedProfile: boolean;
}): boolean {
  if (options.usingCopiedProfile) return false;
  return options.effectiveKeepBrowser || options.preserveBrowserOnError;
}

export function shouldPreserveBrowserOnErrorForTest(error: unknown, headless: boolean): boolean {
  return shouldPreserveBrowserOnError(error, headless);
}

export function classifyPreservedBrowserErrorForTest(
  error: unknown,
  headless: boolean,
): PreservedBrowserErrorKind | null {
  return classifyPreservedBrowserError(error, headless);
}

type BrowserConfigWithThinkingTime = Pick<
  ResolvedBrowserConfig,
  "researchMode" | "thinkingTime"
> & {
  thinkingTime: NonNullable<ResolvedBrowserConfig["thinkingTime"]>;
};

function shouldApplyThinkingTimeSelection(
  config: Pick<ResolvedBrowserConfig, "researchMode" | "thinkingTime">,
): config is BrowserConfigWithThinkingTime {
  // Deep Research uses the same effort picker, so research mode must not
  // suppress an explicitly configured thinking-time selection.
  return config.thinkingTime !== undefined;
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
async function enableFocusEmulation(
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

function listIgnoredRemoteChromeFlags(config: {
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

function hasBrowserErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof BrowserAutomationError &&
    (error.details as { code?: string } | undefined)?.code === code
  );
}

function assertUniqueAttachmentBasenames(
  attachments: BrowserAttachment[],
  options: { stage: string; subject: string },
): void {
  const collisions = findAttachmentBasenameCollisions(attachments);
  if (collisions.length === 0) return;

  const collisionDetails = buildAttachmentBasenameCollisionDetails(
    collisions,
    (attachment) => attachment.displayPath || attachment.path,
  );
  throw new BrowserAutomationError(
    formatAttachmentBasenameCollisionMessage(options.subject, collisionDetails.collisions),
    {
      stage: options.stage,
      code: "attachment-basename-collision",
      ...collisionDetails,
    },
  );
}

async function saveOptionalArtifact<T>(
  operation: () => Promise<T | null>,
  logger: BrowserLogger,
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Failed to save session artifact: ${message}`);
    return null;
  }
}

type AssistantAnswer = {
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
};

async function waitForAssistantOrGeneratedImageResponse(params: {
  Runtime: ChromeClient["Runtime"];
  waitForText: () => Promise<AssistantAnswer>;
  timeoutMs: number;
  minTurnIndex?: number;
  expectedConversationId?: string;
  expectedConversationUrl?: string;
  imageOutputRequested: boolean;
  logger: BrowserLogger;
  assertPageAffinity?: (action: string) => Promise<void>;
}): Promise<AssistantAnswer> {
  if (!params.imageOutputRequested) {
    return params.waitForText();
  }

  params.logger("[browser] Waiting for ChatGPT generated image response.");
  const response = await pollGeneratedImageOrTextAssistantResponse(
    params.Runtime,
    params.timeoutMs,
    params.minTurnIndex,
    params.expectedConversationId,
    params.expectedConversationUrl,
    params.assertPageAffinity,
  );
  if (response) {
    if (response.html?.includes("/backend-api/estuary/content?id=file_")) {
      params.logger("[browser] Captured generated image response before text appeared.");
    }
    return response;
  }

  throw new Error("assistant response timeout while waiting for generated image or text");
}

async function attemptAssistantRecheckOrRethrow(
  operation: () => Promise<AssistantAnswer | null>,
): Promise<AssistantAnswer | null> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BrowserAutomationError) {
      throw error;
    }
    return null;
  }
}

async function pollGeneratedImageOrTextAssistantResponse(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  minTurnIndex?: number,
  expectedConversationId?: string,
  expectedConversationUrl?: string,
  assertPageAffinity?: (action: string) => Promise<void>,
): Promise<AssistantAnswer | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await assertPageAffinity?.("generated image response read");
    let snapshot = await readAssistantSnapshot(
      Runtime,
      minTurnIndex,
      expectedConversationId,
      undefined,
      expectedConversationUrl,
    ).catch(() => null);
    throwIfAssistantUiError(snapshot);
    if (!snapshot && typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex)) {
      await assertPageAffinity?.("generated image fallback response read");
      const relaxedSnapshot = await readAssistantSnapshot(
        Runtime,
        undefined,
        expectedConversationId,
        undefined,
        expectedConversationUrl,
      ).catch(() => null);
      const relaxedHtml = typeof relaxedSnapshot?.html === "string" ? relaxedSnapshot.html : "";
      if (
        !relaxedSnapshot?.uiError &&
        relaxedHtml.includes("/backend-api/estuary/content?id=file_")
      ) {
        snapshot = relaxedSnapshot;
      }
    }
    const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
    const html = typeof snapshot?.html === "string" ? snapshot.html : "";
    const hasGeneratedImage = html.includes("/backend-api/estuary/content?id=file_");
    if (text && (hasGeneratedImage || !isImageOnlyUiChromeText(text))) {
      return {
        text,
        html,
        meta: {
          turnId: snapshot?.turnId ?? undefined,
          messageId: snapshot?.messageId ?? undefined,
        },
      };
    }
    await delay(750);
  }
  return null;
}

export function isImageOnlyUiChromeText(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  return (
    normalized.length === 0 ||
    normalized === "edit" ||
    normalized === "stopped thinking" ||
    normalized === "stopped thinking edit" ||
    /^(?:reasoning\s+|pro thinking\s+)?thought for \d+(?:\.\d+)?\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\s+edit$/.test(
      normalized,
    )
  );
}

export interface BrowserConversationTurn {
  label: string;
  prompt?: string;
  answerText: string;
  answerMarkdown: string;
}

function normalizeBrowserFollowUpPrompts(values: string[] | undefined): string[] {
  return (values ?? []).map((entry) => entry.trim()).filter(Boolean);
}

export function formatBrowserTurnTranscript(turns: BrowserConversationTurn[]): {
  answerText: string;
  answerMarkdown: string;
} {
  if (turns.length <= 1) {
    const turn = turns[0];
    return {
      answerText: turn?.answerText ?? "",
      answerMarkdown: turn?.answerMarkdown ?? turn?.answerText ?? "",
    };
  }

  const answerMarkdown = turns
    .map((turn, index) => {
      const label = turn.label.trim() || `Turn ${index + 1}`;
      const prompt = turn.prompt?.trim();
      const promptBlock = prompt ? `\n\n### Prompt\n\n${prompt}` : "";
      const answer = (turn.answerMarkdown || turn.answerText).trim() || "_No text captured._";
      return `## ${label}${promptBlock}\n\n### Answer\n\n${answer}`;
    })
    .join("\n\n")
    .trim();

  return {
    answerText: answerMarkdown,
    answerMarkdown,
  };
}

async function maybeArchiveCompletedConversation({
  Runtime,
  logger,
  config,
  accountDigest,
  conversationUrl,
  followUpCount,
  requiredArtifactsSaved,
}: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  config: ResolvedBrowserConfig;
  accountDigest?: string | null;
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
    accountDigest,
    mode: decision.mode,
    conversationUrl,
  });
}

async function maybeArchiveInterruptedConversation({
  Runtime,
  logger,
  config,
  accountDigest,
  conversationUrl,
  followUpCount,
}: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  config: ResolvedBrowserConfig;
  accountDigest?: string | null;
  conversationUrl?: string | null;
  followUpCount: number;
}): Promise<BrowserArchiveResult | null> {
  if (!conversationUrl || !isConversationUrl(conversationUrl)) {
    return null;
  }
  const decision = resolveBrowserArchiveDecision({
    mode: config.archiveConversations,
    chatgptUrl: config.chatgptUrl ?? config.url,
    conversationUrl,
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
      conversationUrl,
    };
  }
  logger("[browser] Attempting to archive interrupted ChatGPT conversation.");
  return runChatGptArchive({
    Runtime,
    logger,
    accountDigest,
    mode: decision.mode,
    conversationUrl,
  });
}

async function runChatGptArchive({
  Runtime,
  logger,
  accountDigest,
  mode,
  conversationUrl,
}: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  accountDigest?: string | null;
  mode: BrowserArchiveResult["mode"];
  conversationUrl?: string | null;
}): Promise<BrowserArchiveResult> {
  const expectedAccountDigest = accountDigest?.trim();
  if (!expectedAccountDigest || !/^[a-f0-9]{64}$/.test(expectedAccountDigest)) {
    const error = "originating account identity is unavailable";
    logger(`[browser] ChatGPT archive skipped (${error}).`);
    return {
      mode,
      attempted: false,
      archived: false,
      reason: "affinity-mismatch",
      conversationUrl: conversationUrl ?? undefined,
      error,
    };
  }
  return archiveChatGptConversation(Runtime, logger, {
    mode,
    conversationUrl,
    expectedAccountDigest,
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

function withInterruptedArchiveDetails(error: Error, archive: BrowserArchiveResult | null): Error {
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

type BrowserSubmissionResult = {
  baselineTurns: number | null;
  baselineAssistantText: string | null;
  deepResearchTargetKeys?: string[];
  deepResearchTargetBaselineCaptured?: boolean;
};

async function captureDeepResearchTargetBaseline(
  client: ChromeClient,
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

type BrowserSubmissionFallback = {
  prompt: string;
  attachments: BrowserAttachment[];
  prepare?: () => Promise<void>;
};

async function runSubmissionWithRecovery({
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

      const isPromptTooLarge = hasBrowserErrorCode(error, "prompt-too-large");
      if (fallbackSubmission && isPromptTooLarge && !usedFallbackSubmission) {
        usedFallbackSubmission = true;
        logger("[browser] Inline prompt too large; retrying with file uploads.");
        if (fallbackSubmission.prepare) {
          await fallbackSubmission.prepare();
        }
        assertUniqueAttachmentBasenames(fallbackSubmission.attachments, {
          stage: "upload-fallback",
          subject: "The inline prompt was too large, but its upload fallback",
        });
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

function resolveRemoteTabLeaseProfileDir(
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

function isLocalChromeHost(host: string): boolean {
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

function conversationCookieIdsToPreserve(
  config: Pick<ResolvedBrowserConfig, "url" | "resumeConversationUrl">,
  lastUrl: string | null | undefined,
): string[] {
  return [config.resumeConversationUrl, config.url, lastUrl]
    .map((url) => extractConversationIdFromUrl(url ?? ""))
    .filter((id): id is string => Boolean(id));
}

function extractExactChatGptConversationId(url: string | null | undefined): string | undefined {
  return parseChatGptConversationScope(url)?.conversationId;
}

function extractExactChatGptConversationUrl(url: string | null | undefined): string | undefined {
  const scope = parseChatGptConversationScope(url);
  return scope ? `${scope.origin}${scope.pathname}` : undefined;
}

function resolveInitialRunConversationId(
  config: Pick<ResolvedBrowserConfig, "url" | "resumeConversationUrl">,
): string | undefined {
  return extractExactChatGptConversationId(config.resumeConversationUrl ?? config.url);
}

function resolveInitialRunConversationUrl(
  config: Pick<ResolvedBrowserConfig, "url" | "resumeConversationUrl">,
): string | undefined {
  return extractExactChatGptConversationUrl(config.resumeConversationUrl ?? config.url);
}

function assertRunConversationId(
  expectedConversationId: string | undefined,
  expectedConversationUrl: string | undefined,
  url: string,
  action: string,
): void {
  if (expectedConversationUrl) {
    if (!isSameChatGptConversationUrl(url, expectedConversationUrl)) {
      throw new BrowserAutomationError(`ChatGPT conversation changed before ${action}.`, {
        stage: "conversation-affinity",
        code: "conversation-mismatch",
      });
    }
    return;
  }
  if (!expectedConversationId) return;
  if (extractExactChatGptConversationId(url) !== expectedConversationId) {
    throw new BrowserAutomationError(`ChatGPT conversation changed before ${action}.`, {
      stage: "conversation-affinity",
      code: "conversation-mismatch",
    });
  }
}

function latchRunConversationAffinity(
  currentConversationId: string | undefined,
  currentConversationUrl: string | undefined,
  url: string,
  action: string,
): { conversationId: string; conversationUrl: string } {
  const observedScope = parseChatGptConversationScope(url);
  if (!observedScope) {
    throw new BrowserAutomationError(
      `ChatGPT did not establish a stable conversation before ${action}.`,
      { stage: "conversation-affinity", code: "conversation-id-missing" },
    );
  }
  if (currentConversationId || currentConversationUrl) {
    assertRunConversationId(currentConversationId, currentConversationUrl, url, action);
  }
  return {
    conversationId: currentConversationId ?? observedScope.conversationId,
    conversationUrl: currentConversationUrl ?? `${observedScope.origin}${observedScope.pathname}`,
  };
}
async function closeRemoteConnectionAfterRun(options: {
  connectionClosedUnexpectedly: boolean;
  connection: { close: (options?: { preserveTarget?: boolean }) => Promise<void> } | null;
  client: Pick<ChromeClient, "close"> | null;
  preserveTarget: boolean;
}): Promise<void> {
  if (!options.connection) {
    await options.client?.close();
    return;
  }
  await options.connection.close({
    preserveTarget: options.connectionClosedUnexpectedly || options.preserveTarget,
  });
}
function appendBrowserCleanupWarning(
  result: BrowserRunResult | undefined,
  failureCount: number,
): void {
  if (!result || failureCount <= 0) return;
  result.warnings = [
    ...(result.warnings ?? []),
    {
      code: "browser-cleanup-incomplete",
      severity: "warning",
      message:
        "Oracle produced the model result, but browser cleanup could not be fully confirmed.",
      details: { failureCount },
    },
  ];
}

function shouldCloseOwnedRunTargetAfterRun(options: {
  runStatus: "attempted" | "complete" | "cancelled";
  ownsTarget: boolean;
  keepBrowser: boolean;
  closeOwnedTabOnComplete?: boolean;
  preserveForRecovery?: boolean;
  closeOwnedTabOnCancel?: boolean;
}): boolean {
  return (
    options.ownsTarget &&
    !(options.runStatus === "attempted" && options.preserveForRecovery) &&
    (options.runStatus === "cancelled"
      ? (options.closeOwnedTabOnCancel ?? !options.keepBrowser)
      : Boolean(options.closeOwnedTabOnComplete) || !options.keepBrowser)
  );
}

function shouldCleanupBlankTabsAfterLastLease(options: {
  runStatus: "attempted" | "complete" | "cancelled";
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

async function releaseLocalBrowserTabLease(options: {
  lease: BrowserTabLease;
  closeOwnedRunTarget: () => Promise<void>;
  cleanupBlankTabs: () => Promise<void>;
  terminateSharedChrome?: () => Promise<boolean>;
  sessionId?: string;
  chromePid?: number;
  chromePort?: number;
  chromeTargetId?: string | null;
  launchDisposition?: "launched" | "reused";
  logger: BrowserLogger;
}): Promise<{
  keepBrowserOpen: boolean;
  terminationHandled: boolean;
  releaseError?: Error;
}> {
  let decisionObserved = false;
  let keepBrowserOpen = false;
  let terminationHandled = false;
  let otherLeasesRemain = false;
  let releaseError: Error | undefined;

  try {
    await options.lease.release({
      onRelease: async ({ isLastLease }) => {
        decisionObserved = true;
        if (!isLastLease) {
          // Record this before any best-effort tab cleanup so a cleanup failure can
          // never fall through into terminating Chrome used by another lease.
          keepBrowserOpen = true;
          otherLeasesRemain = true;
        }
        await options.closeOwnedRunTarget().catch(() => undefined);
        if (!isLastLease) {
          return;
        }
        await options.cleanupBlankTabs().catch(() => undefined);
        if (options.terminateSharedChrome) {
          options.logger(
            `[browser] ChatGPT browser slot ${options.lease.id.slice(0, 8)} is final; ` +
              `terminating shared Chrome (${formatBrowserLeaseDiagnostics(options)}).`,
          );
          const terminated = await options.terminateSharedChrome().catch(() => false);
          if (terminated) {
            terminationHandled = true;
          } else {
            // A reused Chrome handle may have a no-op kill implementation. Never
            // claim cleanup or fall through into an unverified lock-free kill.
            keepBrowserOpen = true;
            options.logger(
              "[browser] Could not verify shared Chrome termination; leaving it available for reuse.",
            );
          }
        }
      },
    });
  } catch (error) {
    releaseError = error instanceof Error ? error : new Error(String(error));
    if (!terminationHandled) keepBrowserOpen = true;
    options.logger(
      `[browser] Failed to release the ChatGPT browser slot registry lock; restart Oracle/Codex MCP before another browser run: ${releaseError.message}`,
    );
  }

  if (!decisionObserved) {
    options.logger(
      "[browser] Could not verify final ChatGPT tab lease; leaving shared Chrome running.",
    );
    return {
      keepBrowserOpen: true,
      terminationHandled: false,
      ...(releaseError ? { releaseError } : {}),
    };
  }
  if (otherLeasesRemain) {
    options.logger(
      `[browser] Other ChatGPT tab leases still active; leaving shared Chrome running; ` +
        `browser slot ${options.lease.id.slice(0, 8)} is non-final ` +
        `(${formatBrowserLeaseDiagnostics(options)}).`,
    );
  }
  return {
    keepBrowserOpen,
    terminationHandled,
    ...(releaseError ? { releaseError } : {}),
  };
}

function formatBrowserLeaseDiagnostics(options: {
  sessionId?: string;
  chromePid?: number;
  chromePort?: number;
  chromeTargetId?: string | null;
  launchDisposition?: "launched" | "reused";
}): string {
  return [
    `session=${options.sessionId ?? "unknown"}`,
    `controllerPid=${process.pid}`,
    `chromePid=${options.chromePid ?? "unknown"}`,
    `chromePort=${options.chromePort ?? "unknown"}`,
    `target=${options.chromeTargetId ?? "unknown"}`,
    `launch=${options.launchDisposition ?? "unknown"}`,
  ].join("; ");
}

/**
 * Provider-native capture, gated on explicit opt-in.
 *
 * Off by default because it costs two extra authenticated requests per run and
 * only matters when a caller intends to treat the transcript as evidence rather
 * than as an answer. When it is on and it fails, the run is unaffected: the
 * summary records why, and nothing throws.
 */
async function runProviderNativeCapture(params: {
  Runtime: ChromeClient["Runtime"];
  config: ResolvedBrowserConfig;
  conversationUrl?: string | null;
  sessionId?: string;
  answerMarkdown?: string;
  answerMessageId?: string;
  logger: BrowserLogger;
}): Promise<{ summary?: ProviderNativeCaptureSummary; artifacts: SessionArtifact[] }> {
  if (!params.config.captureProviderNative) {
    return { artifacts: [] };
  }
  const conversationId = params.conversationUrl
    ? extractConversationIdFromUrl(params.conversationUrl)
    : undefined;
  return finalizeProviderNativeCapture({
    Runtime: params.Runtime,
    conversationId,
    conversationUrl: params.conversationUrl,
    sessionId: params.sessionId,
    answerMarkdown: params.answerMarkdown,
    answerMessageId: params.answerMessageId,
    logger: params.logger,
  });
}

function buildSkippedModelSelectionEvidence(
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

function resolveAttachmentUploadTimeoutMs(
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

export async function runBrowserMode(options: BrowserRunOptions): Promise<BrowserRunResult> {
  const cancellation = new BrowserCancellation(options.signal, options.log);
  try {
    cancellation.check();
    return await cancellation.run(() => runBrowserModeInternal(options, cancellation));
  } finally {
    cancellation.dispose();
  }
}

async function runBrowserModeInternal(
  options: BrowserRunOptions,
  cancellation: BrowserCancellation,
): Promise<BrowserRunResult> {
  const startedAt = Date.now();
  const attachments: BrowserAttachment[] = options.attachments ?? [];
  assertUniqueAttachmentBasenames(attachments, {
    stage: "upload",
    subject: "Browser upload",
  });

  const promptText = options.prompt?.trim();
  if (!promptText) {
    throw new Error("Prompt text is required when using browser mode.");
  }

  const fallbackSubmission = options.fallbackSubmission;

  let config = resolveBrowserConfig(options.config);
  const rawExpectedAccountDigest = config.expectedAccountDigest;
  const expectedAccountDigest = normalizeChatGptAccountDigest(rawExpectedAccountDigest);
  if (rawExpectedAccountDigest != null && !expectedAccountDigest) {
    throw new BrowserAutomationError("Expected ChatGPT account identity is invalid.", {
      stage: "conversation-affinity",
    });
  }
  if (process.env.ORACLE_WRAPPER_REMOTE_ONLY === "1" && !config.remoteChrome) {
    throw new BrowserAutomationError(
      "The agent wrapper requires a stored or wrapper-selected remote Chrome endpoint; refusing to launch or attach local Chrome.",
      { stage: "background-browser-policy" },
    );
  }
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
  const runtimeHintCb = options.runtimeHintCb;
  let lastTargetId: string | undefined;
  let lastUrl: string | undefined;
  let runConversationId = resolveInitialRunConversationId(config);
  let runConversationUrl = resolveInitialRunConversationUrl(config);
  let postSubmitConversationUrlPromise: Promise<boolean> | null = null;
  let promptSubmitted = false;
  let submittedPromptHash: string | null = null;
  let ownedRecoveryTarget: BrowserRunResult["ownedRecoveryTarget"];
  const targetClaimId = randomUUID();
  let modelSelectionEvidence: BrowserModelSelectionEvidence | undefined;
  let thinkingSelectionEvidence: BrowserThinkingSelectionEvidence | undefined;
  let researchPlan: BrowserResearchPlanMetadata | undefined;
  let tabLease: BrowserTabLease | null = null;
  let conversationUrlMonitor: ConversationUrlMonitor | null = null;
  const emitRuntimeHint = async (): Promise<void> => {
    if (!chrome?.port) {
      return;
    }
    const conversationId =
      runConversationId ?? (lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined);
    const hint = {
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      conversationId,
      promptSubmitted,
      submittedPromptHash,
      ownedRecoveryTarget,
      userDataDir,
      chatGptAccountDigest: chatGptAccountDigest ?? undefined,
      controllerPid: process.pid,
      researchPlan,
    };
    try {
      await runtimeHintCb?.(hint, modelSelectionEvidence);
      await tabLease?.update({
        chromeHost,
        chromePort: chrome.port,
        chromeTargetId: lastTargetId,
        tabUrl: lastUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
    }
  };
  const markPromptSubmitted = async (): Promise<void> => {
    promptSubmitted = true;
    submittedPromptHash = null;
    await emitRuntimeHint();
    postSubmitConversationUrlPromise =
      conversationUrlMonitor?.schedule("post-submit", config.timeoutMs ?? 120_000) ?? null;
  };
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
    const attached = await cancellation.call(() => resolveAttachRunningConnection(config, logger));
    config = {
      ...config,
      remoteChrome: { host: attached.host, port: attached.port },
      remoteChromeBrowserWSEndpoint: attached.browserWSEndpoint,
      remoteChromeProfileRoot: attached.profileRoot,
    };
  }

  if (!config.remoteChrome && !config.manualLogin) {
    const preferredPort = config.debugPort ?? DEFAULT_DEBUG_PORT;
    const availablePort = await cancellation.call(() =>
      pickAvailableDebugPort(preferredPort, logger),
    );
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

    return runRemoteBrowserMode(promptText, attachments, config, logger, options, cancellation);
  }

  const manualLogin = Boolean(config.manualLogin);
  if (manualLogin && usingCopiedProfile) {
    throw new BrowserAutomationError(
      "--copy-profile cannot be combined with --browser-manual-login: choose either a throwaway copied profile or the persistent manual-login profile.",
      { stage: "profile-config" },
    );
  }
  // Manual-login and copy-profile both start from an already-signed-in profile,
  // so neither clears nor syncs cookies.
  const profileIsPreSigned = manualLogin || usingCopiedProfile;
  const manualProfileDir = config.manualLoginProfileDir
    ? path.resolve(config.manualLoginProfileDir)
    : defaultManualLoginProfileDir();
  const userDataDir = manualLogin
    ? manualProfileDir
    : await cancellation.acquire(
        async () => mkdtemp(path.join(await resolveUserDataBaseDir(), "oracle-browser-")),
        (dir) => rm(dir, { recursive: true, force: true }),
      );
  const effectiveKeepBrowser = Boolean(config.keepBrowser);
  try {
    if (manualLogin) {
      // Learned: manual login reuses a persistent profile so cookies/SSO survive.
      await cancellation.call(() => mkdir(userDataDir, { recursive: true }));
      logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
      await cancellation.call(() =>
        assertManualLoginProfileReadyForRun({ userDataDir, keepBrowser: effectiveKeepBrowser }),
      );
    } else if (config.copyProfileSource) {
      const copying = copyChromeProfile(
        config.copyProfileSource,
        userDataDir,
        config.chromeProfile,
      );
      const copiedProfileDirectory = await cancellation.race(
        copying.finally(async () => {
          if (options.signal?.aborted)
            await withoutBrowserCancellation(() =>
              rm(userDataDir, { recursive: true, force: true }),
            );
        }),
      );
      config = { ...config, chromeProfile: copiedProfileDirectory };
      logger(
        `Seeded temporary Chrome profile ${copiedProfileDirectory} from ${config.copyProfileSource} (copy-profile mode; signed-in session reused without manual login)`,
      );
    } else {
      logger(`Created temporary Chrome profile at ${userDataDir}`);
    }
  } catch (error) {
    if (!manualLogin)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  if (manualLogin) {
    tabLease = await cancellation.acquire(
      () =>
        acquireBrowserTabLease(userDataDir, {
          maxConcurrentTabs: config.maxConcurrentTabs,
          timeoutMs: config.timeoutMs,
          logger,
          sessionId: options.sessionId,
          signal: options.signal,
        }),
      (lease) => lease.release(),
    );
  }

  let acquiredChrome: { chrome: BrowserChrome; reusedChrome: LaunchedChrome | null };
  try {
    if (manualLogin) {
      acquiredChrome = await cancellation.acquire(
        () => acquireManualLoginChromeForRun(userDataDir, config, logger, options.sessionId),
        async ({ chrome }) => {
          detachKeptChromeProcess(chrome);
        },
      );
    } else {
      const launched = await cancellation.acquire(
        () => launchChrome({ ...config, remoteChrome: config.remoteChrome }, userDataDir, logger),
        async (chrome) => {
          try {
            await chrome.kill();
          } finally {
            await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          }
        },
      );
      acquiredChrome = { chrome: launched, reusedChrome: null };
    }
  } catch (error) {
    await withoutBrowserCancellation(async () => {
      if (tabLease) {
        const handle = tabLease;
        tabLease = null;
        await handle.release().catch(() => undefined);
      }
      if (!manualLogin)
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    });
    throw error;
  }
  const { chrome, reusedChrome } = acquiredChrome;
  const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
  let removeTerminationHooks: (() => void) | null = null;
  try {
    removeTerminationHooks = registerTerminationHooks(
      chrome,
      userDataDir,
      effectiveKeepBrowser,
      logger,
      {
        isInFlight: () => runStatus !== "complete",
        emitRuntimeHint,
        preserveUserDataDir: manualLogin,
        preserveSharedChromeOnSignal: manualLogin,
        // copy-profile is a throwaway copy of a signed-in profile; never leave it on disk.
        forceProfileCleanup: usingCopiedProfile,
      },
    );
  } catch {
    // ignore failure; cleanup still happens below
  }

  let client: ChromeClient | null = null;
  let browserRuntime: ChromeClient["Runtime"] | null = null;
  let isolatedTargetId: string | null = null;
  let ownsTarget = true;
  const accountAffinityProbeTimeoutMs = () =>
    resolveAccountAffinityProbeTimeoutMs(config.inputTimeoutMs);
  let answerText = "";
  let answerMarkdown = "";
  let answerMessageId: string | undefined;
  let answerHtml = "";
  let runStatus: "attempted" | "complete" | "cancelled" = "attempted";
  let connectionClosedUnexpectedly = false;
  let stopThinkingMonitor: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let appliedCookies = 0;
  let chatGptAccountDigest: string | null = null;
  let preserveBrowserOnError = false;

  try {
    if (tabLease)
      await cancellation.call(() => tabLease!.update({ chromeHost, chromePort: chrome.port }));
    try {
      if (config.browserTabRef) {
        const tabRef = config.browserTabRef;
        const attached = await cancellation.acquire(
          () =>
            connectToExistingChatGptTab({
              host: chromeHost,
              port: chrome.port,
              ref: tabRef,
            }),
          (attached) => attached.client.close(),
        );
        const attachedConversationId = expectedConversationIdForRef(tabRef, attached.tab);
        if (attachedConversationId && attached.tab.url) {
          const affinity = latchRunConversationAffinity(
            runConversationId,
            runConversationUrl,
            attached.tab.url,
            "attached tab selection",
          );
          runConversationId = affinity.conversationId;
          runConversationUrl = affinity.conversationUrl;
        }
        client = cancellation.client(attached.client);
        isolatedTargetId = attached.targetId ?? null;
        lastTargetId = attached.targetId ?? undefined;
        lastUrl = attached.tab.url || lastUrl;
        ownsTarget = false;
        logger("Attached to an existing ChatGPT tab.");
      } else {
        const strictTabIsolation = Boolean(manualLogin && reusedChrome);
        const devtoolsRetries = manualLogin ? 6 : 0;
        const connection = await cancellation.acquire(
          () =>
            connectWithNewTab(chrome.port, logger, "about:blank", chromeHost, {
              fallbackToDefault: !strictTabIsolation,
              retries: devtoolsRetries,
              retryDelayMs: 500,
            }),
          async (connection) => {
            await connection.client.close().catch(() => undefined);
            if (connection.targetId)
              await closeTab(chrome.port, connection.targetId, logger, chromeHost);
          },
        );
        client = cancellation.client(connection.client);
        isolatedTargetId = connection.targetId ?? null;
        ownsTarget = Boolean(connection.targetId);
        if (connection.targetId && (!config.keepBrowser || options.closeOwnedTabOnComplete)) {
          ownedRecoveryTarget = {
            host: chromeHost,
            port: chrome.port,
            targetId: connection.targetId,
            claimId: targetClaimId,
          };
        }
      }
      if (tabLease && isolatedTargetId) {
        await tabLease.update({
          chromeHost,
          chromePort: chrome.port,
          chromeTargetId: isolatedTargetId,
        });
      }
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
        void (async () => {
          const liveness = await probeChromeTargetLiveness({
            host: chromeHost,
            port: chrome.port,
            targetId: lastTargetId ?? isolatedTargetId,
          });
          const recoverable = isRecoverableChromeDisconnect(liveness);
          if (recoverable) {
            logger(
              "CDP client disconnected; Chrome/target still reachable. Leaving run recoverable for reattach.",
            );
          } else {
            logger("Chrome window closed; attempting to abort run.");
          }
          reject(
            new BrowserAutomationError(connectionLostUserMessage({ recoverable }), {
              stage: "connection-lost",
              recoverableDisconnect: recoverable,
              disconnectCause: recoverable ? "cdp-client-disconnect" : "chrome-closed",
              runtime: {
                chromePid: chrome.pid,
                chromePort: chrome.port,
                chromeHost,
                userDataDir,
                chromeTargetId: lastTargetId ?? isolatedTargetId ?? undefined,
                tabUrl: liveness.matchedUrl ?? lastUrl,
                conversationId:
                  (liveness.matchedUrl ?? lastUrl)
                    ? extractConversationIdFromUrl(liveness.matchedUrl ?? lastUrl ?? "")
                    : undefined,
                promptSubmitted,
                submittedPromptHash,
                ownedRecoveryTarget,
                controllerPid: process.pid,
                chatGptAccountDigest: chatGptAccountDigest ?? undefined,
                researchPlan,
              },
            }),
          );
        })();
      });
    });
    const raceWithDisconnect = <T>(promise: Promise<T>): Promise<T> =>
      cancellation.race(Promise.race([promise, disconnectPromise]));
    const { Network, Page, Runtime, Input, DOM, Target } = client;
    const wrapperExpectedEmail = resolveWrapperExpectedAccountEmail();
    const verifyLocalChatGptAccount = async (action: string): Promise<void> => {
      const observedAccountDigest = await raceWithDisconnect(
        wrapperExpectedEmail
          ? assertChatGptAccountEmail(
              Runtime,
              wrapperExpectedEmail,
              action,
              accountAffinityProbeTimeoutMs(),
            )
          : readChatGptAccountDigest(Runtime, accountAffinityProbeTimeoutMs()),
      );
      if (
        (expectedAccountDigest && observedAccountDigest !== expectedAccountDigest) ||
        (chatGptAccountDigest && observedAccountDigest !== chatGptAccountDigest)
      ) {
        throw new BrowserAutomationError(`ChatGPT account identity changed before ${action}.`, {
          stage: "conversation-affinity",
        });
      }
      chatGptAccountDigest = observedAccountDigest;
      config.expectedAccountDigest = observedAccountDigest;
    };

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    if (config.browserTabRef) await claimBrowserTarget(Runtime, targetClaimId);
    if (!config.headless && config.hideWindow) {
      await positionChromeWindowOffscreen(client, userDataDir, logger);
    } else if (!config.headless) {
      // Persistent profiles can retain bounds from a prior hidden run. Visible
      // local runs must actively restore the Oracle-owned Chrome window.
      await positionChromeWindowOnscreen(client, userDataDir, logger);
    }
    // The send button is clicked with trusted CDP input events at viewport
    // coordinates, which ChatGPT silently drops when the window is hidden or
    // occluded. Emulate focus so the page behaves like a foreground tab.
    await enableFocusEmulation(client, logger, "local target");
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);
    if (!profileIsPreSigned) {
      await Network.clearBrowserCookies();
    }

    const manualLoginCookieSync = manualLogin && Boolean(config.manualLoginCookieSync);
    const cookieSyncEnabled = shouldSyncBrowserCookies(config, {
      manualLogin,
      profileIsPreSigned,
    });
    if (cookieSyncEnabled) {
      if (manualLoginCookieSync) {
        logger(
          "Manual login mode: seeding persistent profile with cookies from your Chrome profile.",
        );
      }
      if (!config.inlineCookies) {
        logger(CHROME_COOKIE_SYNC_WARNING);
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
        manualLogin
          ? "Skipping Chrome cookie sync (--browser-manual-login enabled); reuse the opened profile after signing in."
          : "Skipping Chrome cookie copy (disabled by default; use --browser-cookie-sync to opt in).",
      );
    }
    await clearStaleChatGptConversationCookies(Network, Target, logger, {
      preserveConversationIds: conversationCookieIdsToPreserve(config, lastUrl),
    });

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

    if (config.browserTabRef) {
      await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
      await raceWithDisconnect(ensureLoggedIn(Runtime, logger));
      await verifyLocalChatGptAccount("scoped ChatGPT navigation");
      if (isResumingConversation) {
        await raceWithDisconnect(
          navigateToChatGPT(Page, Runtime, config.resumeConversationUrl as string, logger),
        );
        await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
        await raceWithDisconnect(ensureLoggedIn(Runtime, logger));
        await verifyLocalChatGptAccount("resumed conversation preparation");
      }
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      if (isResumingConversation) {
        await raceWithDisconnect(
          waitForResumedConversationHydration(Runtime, config.inputTimeoutMs, logger, {
            requirePriorTurns: true,
            expectedConversationUrl: config.resumeConversationUrl as string,
          }),
        );
      }
    } else {
      const baseUrl = CHATGPT_URL;
      // First load the base ChatGPT homepage to satisfy potential interstitials,
      // then verify the parent account before hopping to a scoped URL.
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
      await verifyLocalChatGptAccount("scoped ChatGPT navigation");

      if (isResumingConversation) {
        await raceWithDisconnect(
          navigateToChatGPT(Page, Runtime, config.resumeConversationUrl as string, logger),
        );
        await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
        await raceWithDisconnect(ensureLoggedIn(Runtime, logger));
        await verifyLocalChatGptAccount("resumed conversation preparation");
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
        await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
        await raceWithDisconnect(ensureLoggedIn(Runtime, logger));
        await verifyLocalChatGptAccount("configured ChatGPT page preparation");
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
                runConversationId = undefined;
                runConversationUrl = undefined;
                await ensureNotBlocked(Runtime, config.headless, logger);
                await ensureLoggedIn(Runtime, logger);
                await verifyLocalChatGptAccount("chat mode reset");
                await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
              }
            : undefined,
      }),
    );
    if (chatMode === "switched") {
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    }
    const assertAttachedConversation = async (action: string): Promise<void> => {
      const url = await raceWithDisconnect(assertChatGptTabOrigin(Runtime, action));
      if (runConversationId || runConversationUrl) {
        assertRunConversationId(runConversationId, runConversationUrl, url, action);
      }
    };
    const assertPageAffinity = async (action: string): Promise<void> => {
      await assertAttachedConversation(action);
      if (wrapperExpectedEmail) {
        await raceWithDisconnect(
          assertChatGptAccountEmail(
            Runtime,
            wrapperExpectedEmail,
            action,
            accountAffinityProbeTimeoutMs(),
          ),
        );
      }
      if (
        !chatGptAccountDigest ||
        (await raceWithDisconnect(
          readChatGptAccountDigest(Runtime, accountAffinityProbeTimeoutMs()),
        )) !== chatGptAccountDigest
      ) {
        throw new BrowserAutomationError(`ChatGPT account identity changed before ${action}.`, {
          stage: "conversation-affinity",
        });
      }
    };
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
      if (chrome?.port) {
        logger(`[reattach] chrome port=${chrome.port} host=${chromeHost}`);
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
        if (runConversationId || runConversationUrl) {
          const affinity = latchRunConversationAffinity(
            runConversationId,
            runConversationUrl,
            url,
            "conversation URL update",
          );
          runConversationId = affinity.conversationId;
          runConversationUrl = affinity.conversationUrl;
        }
        lastUrl = url;
        await emitRuntimeHint();
      },
      logger,
    });
    conversationUrlMonitor = activeConversationUrlMonitor;
    const updateConversationHint = conversationUrlMonitor.update;
    const ensureRunConversationPinnedAfterSubmit = async (
      committedConversationUrl: string | undefined,
    ): Promise<void> => {
      if (!committedConversationUrl) {
        throw new BrowserAutomationError(
          "ChatGPT did not verify the submitted turn's conversation URL.",
          { stage: "conversation-affinity", code: "conversation-commit-unverified" },
        );
      }
      const committedConversationAffinity = latchRunConversationAffinity(
        runConversationId,
        runConversationUrl,
        committedConversationUrl,
        "submitted prompt commit",
      );
      const initialUrl = await raceWithDisconnect(
        assertChatGptTabOrigin(Runtime, "post-submit conversation pin"),
      );
      assertRunConversationId(
        committedConversationAffinity.conversationId,
        committedConversationAffinity.conversationUrl,
        initialUrl,
        "response handling",
      );
      runConversationId = committedConversationAffinity.conversationId;
      runConversationUrl = committedConversationAffinity.conversationUrl;
      lastUrl = initialUrl;
      await emitRuntimeHint();
      await (postSubmitConversationUrlPromise ??
        activeConversationUrlMonitor.schedule("post-submit", config.timeoutMs ?? 120_000));
      const confirmedUrl = await raceWithDisconnect(
        assertChatGptTabOrigin(Runtime, "post-submit conversation confirmation"),
      );
      assertRunConversationId(
        runConversationId,
        runConversationUrl,
        confirmedUrl,
        "response handling",
      );
      lastUrl = confirmedUrl;
      await emitRuntimeHint();
      await assertPageAffinity("post-submit response handling");
    };
    await captureRuntimeSnapshot();
    const modelStrategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
    if (config.desiredModel && modelStrategy !== "ignore" && !isResumingConversation) {
      modelSelectionEvidence = await raceWithDisconnect(
        withRetries(
          () =>
            ensureModelSelection(Runtime, config.desiredModel as string, logger, modelStrategy, {
              expectedConversationId: runConversationId,
              assertPageAffinity,
              implicitDefault: config.modelIsImplicitDefault,
            }),
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
        // Login has already been verified above. Preserve the picker failure instead of
        // misdiagnosing an unavailable model as missing cookies.
        throw normalizeAuthenticatedModelSelectionError(error);
      });
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      logger(
        `Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`,
      );
    } else if (modelStrategy === "ignore" || isResumingConversation) {
      modelSelectionEvidence = buildSkippedModelSelectionEvidence(
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
    if (shouldApplyThinkingTimeSelection(config)) {
      const thinkingTargetModel = modelStrategy === "select" ? config.desiredModel : null;
      thinkingSelectionEvidence = await raceWithDisconnect(
        withRetries(
          () =>
            ensureThinkingTime(Runtime, config.thinkingTime, logger, thinkingTargetModel, {
              expectedConversationId: runConversationId,
              expectedConversationUrl: runConversationUrl,
              assertPageAffinity,
            }),
          {
            retries: 2,
            delayMs: 300,
            onRetry: (attempt, error) => {
              if (options.verbose) {
                logger(
                  `[retry] Thinking time (${config.thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                );
              }
            },
          },
        ),
      );
    }
    const profileLockTimeoutMs = manualLogin ? (config.profileLockTimeoutMs ?? 0) : 0;
    let profileLock: ProfileRunLock | null = null;
    const acquireProfileLockIfNeeded = async () => {
      if (profileLockTimeoutMs <= 0) return;
      profileLock = await cancellation.acquire(
        () =>
          acquireProfileRunLock(userDataDir, {
            timeoutMs: profileLockTimeoutMs,
            logger,
            signal: options.signal,
          }),
        async (lock) => {
          await lock?.release();
        },
      );
    };
    const releaseProfileLockIfHeld = async () => {
      if (!profileLock) return;
      const handle = profileLock;
      profileLock = null;
      await withoutBrowserCancellation(() => handle.release()).catch(() => undefined);
    };
    const submitOnce = async (prompt: string, submissionAttachments: BrowserAttachment[]) => {
      await assertPageAffinity("prompt preparation");
      await claimBrowserTarget(Runtime, targetClaimId);
      const baselineSnapshot = await readAssistantSnapshot(
        Runtime,
        undefined,
        runConversationId,
        undefined,
        runConversationUrl,
      ).catch(() => null);
      const baselineAssistantText =
        typeof baselineSnapshot?.text === "string" ? baselineSnapshot.text.trim() : "";
      const attachmentNames = submissionAttachments.map((a) => path.basename(a.path));
      const attachmentExpectations = submissionAttachments.map((a) => ({
        name: path.basename(a.path),
        generatedBundle: a.generatedBundle === true,
      }));
      let attachmentNavigationUrl: string | undefined;
      await raceWithDisconnect(clearPromptComposer(Runtime, logger, assertPageAffinity));
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      if (submissionAttachments.length > 0) {
        if (!DOM) {
          throw new Error("Chrome DOM domain unavailable while uploading attachments.");
        }
        await assertAttachedConversation("attachment preparation");
        attachmentNavigationUrl = await raceWithDisconnect(captureComposerNavigationUrl(Runtime));
        await clearComposerAttachments(Runtime, 5_000, logger, assertPageAffinity);
        for (
          let attachmentIndex = 0;
          attachmentIndex < submissionAttachments.length;
          attachmentIndex += 1
        ) {
          const attachment = submissionAttachments[attachmentIndex];
          await assertPageAffinity("attachment upload");
          await raceWithDisconnect(
            assertComposerPlusStayedInPlace(Runtime, attachmentNavigationUrl),
          );
          logger(`Uploading attachment: ${attachment.displayPath}`);
          const uiConfirmed = await uploadAttachmentFile(
            {
              runtime: Runtime,
              dom: DOM,
              input: Input,
              assertPageAffinity,
              expectedConversationId: runConversationId,
              expectedAccountDigest: chatGptAccountDigest ?? undefined,
            },
            attachment,
            logger,
            { expectedCount: attachmentIndex + 1, navigationUrl: attachmentNavigationUrl },
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
        // Scale timeout based on number of files: base 45s + 20s per additional file.
        const baseTimeout = config.inputTimeoutMs ?? 30_000;
        const perFileTimeout = 20_000;
        const waitBudget =
          Math.max(baseTimeout, 45_000) + (submissionAttachments.length - 1) * perFileTimeout;
        const attachmentWaitBudget = Math.max(config.attachmentTimeoutMs ?? 0, waitBudget);
        await waitForAttachmentCompletion(Runtime, attachmentWaitBudget, attachmentNames, logger);
        await assertPageAffinity("attachment completion wait");
        logger("All attachments uploaded");
      }
      if (deepResearch) {
        await raceWithDisconnect(
          withRetries(
            () =>
              activateDeepResearch(Runtime, Input, logger, {
                expectedConversationId: runConversationId,
                expectedConversationUrl: runConversationUrl,
                assertPageAffinity,
              }),
            {
              retries: 2,
              delayMs: 500,
              onRetry: (attempt, error) => {
                if (options.verbose) {
                  logger(
                    `[retry] Deep Research activation attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                  );
                }
              },
            },
          ),
        );
        await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
        logger(
          `Prompt textarea ready (after Deep Research activation, ${prompt.length.toLocaleString()} chars queued)`,
        );
      }
      let baselineTurns = await readConversationTurnCount(Runtime, logger);
      // Learned: return baselineTurns so assistant polling can ignore earlier content.
      const providerState: Record<string, unknown> = {
        runtime: Runtime,
        input: Input,
        page: Page,
        logger,
        timeoutMs: config.timeoutMs,
        inputTimeoutMs: config.inputTimeoutMs ?? undefined,
        attachmentTimeoutMs: config.attachmentTimeoutMs ?? undefined,
        baselineTurns: baselineTurns ?? undefined,
        attachmentNames: attachmentExpectations,
        attachmentNavigationUrl,
        onPromptSubmitted: markPromptSubmitted,
        assertPageAffinity,
        expectedConversationId: runConversationId,
        expectedConversationUrl: runConversationUrl,
        webSearch: config.researchMode === "search",
      };
      const deepResearchTargetBaseline =
        deepResearch && client
          ? await captureDeepResearchTargetBaseline(client, logger)
          : undefined;
      await assertPageAffinity("prompt submission");
      const previousUserMessageIds = await readUserMessageIds(Runtime, config.inputTimeoutMs);
      await runProviderSubmissionFlow(chatgptDomProvider, {
        prompt,
        evaluate: async () => undefined,
        delay,
        log: logger,
        state: providerState,
      });
      await markPromptSubmitted();
      await ensureRunConversationPinnedAfterSubmit(
        typeof providerState.committedConversationUrl === "string"
          ? providerState.committedConversationUrl
          : undefined,
      );
      const providerBaselineTurns = providerState.baselineTurns;
      const renderedPromptHash = await readSubmittedPromptFingerprint(
        Runtime,
        previousUserMessageIds,
        config.inputTimeoutMs,
      );
      if (renderedPromptHash) {
        submittedPromptHash = renderedPromptHash;
        await emitRuntimeHint();
      }
      if (typeof providerBaselineTurns === "number" && Number.isFinite(providerBaselineTurns)) {
        baselineTurns = providerBaselineTurns;
      }
      if (attachmentNames.length > 0) {
        const verified = await waitForUserTurnAttachments(
          Runtime,
          attachmentNames,
          20_000,
          logger,
          {
            minTurnIndex: baselineTurns ?? undefined,
            expectedPrompt: prompt,
            expectedConversationId: runConversationId,
          },
        ).catch((error) => {
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
        baselineTurns,
        baselineAssistantText,
        deepResearchTargetKeys: deepResearchTargetBaseline?.targetKeys,
        deepResearchTargetBaselineCaptured: deepResearchTargetBaseline?.captured,
      };
    };
    const reloadPromptComposer = async () => {
      logger("[browser] Composer became unresponsive; reloading page and retrying once.");
      await assertPageAffinity("prompt composer reload");
      await raceWithDisconnect(Page.reload({ ignoreCache: true }));
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    };

    let baselineTurns: number | null = null;
    let baselineAssistantText: string | null = null;
    let deepResearchTargetKeys: string[] = [];
    let deepResearchTargetBaselineCaptured = false;
    await acquireProfileLockIfNeeded();
    try {
      const submission = await runSubmissionWithRecovery({
        prompt: promptText,
        attachments,
        fallbackSubmission,
        submit: (submissionPrompt, submissionAttachments) =>
          raceWithDisconnect(submitOnce(submissionPrompt, submissionAttachments)),
        reloadPromptComposer,
        prepareFallbackSubmission: async () => {
          await raceWithDisconnect(clearPromptComposer(Runtime, logger, assertPageAffinity));
          await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
        },
        logger,
      });
      baselineTurns = submission.baselineTurns;
      baselineAssistantText = submission.baselineAssistantText;
      deepResearchTargetKeys = submission.deepResearchTargetKeys ?? [];
      deepResearchTargetBaselineCaptured = submission.deepResearchTargetBaselineCaptured ?? false;
    } finally {
      await releaseProfileLockIfHeld();
    }
    const imageArtifactMinTurnIndex = baselineTurns;
    if (deepResearch) {
      await raceWithDisconnect(
        waitForResearchPlanAutoConfirm(Runtime, logger, undefined, {
          expectedConversationId: runConversationId,
          expectedConversationUrl: runConversationUrl,
          assertPageAffinity,
          Page,
          client,
          ignoredTargetKeys: deepResearchTargetKeys,
          targetBaselineCaptured: deepResearchTargetBaselineCaptured,
          minTurnIndex: baselineTurns,
          onPlan: async (plan) => {
            researchPlan = plan;
            await emitRuntimeHint();
          },
        }),
      );
      const researchResult = await raceWithDisconnect(
        waitForDeepResearchCompletion(
          Runtime,
          logger,
          config.timeoutMs,
          baselineTurns,
          Page,
          client,
          {
            ignoredTargetKeys: deepResearchTargetKeys,
            targetBaselineCaptured: deepResearchTargetBaselineCaptured,
            expectedConversationId: runConversationId,
            expectedConversationUrl: runConversationUrl,
            assertPageAffinity,
          },
        ),
      );
      await updateConversationHint("post-deep-research", 15_000).catch(() => false);
      await assertPageAffinity("post-Deep Research finalization");
      runStatus = "complete";
      const durationMs = Date.now() - startedAt;
      const tokens = estimateTokenCount(researchResult.text);
      const reportArtifact = await saveOptionalArtifact(
        () =>
          saveDeepResearchReportArtifact({
            sessionId: options.sessionId,
            reportMarkdown: researchResult.text,
            conversationUrl: lastUrl,
            logger,
          }),
        logger,
      );
      const providerCapture = await runProviderNativeCapture({
        Runtime,
        config,
        conversationUrl: lastUrl,
        sessionId: options.sessionId,
        answerMarkdown: researchResult.text,
        logger,
      });
      const transcriptArtifact = await saveOptionalArtifact(
        () =>
          saveBrowserTranscriptArtifact({
            sessionId: options.sessionId,
            prompt: promptText,
            answerMarkdown: researchResult.text,
            conversationUrl: lastUrl,
            artifacts: appendArtifacts(
              appendArtifacts(undefined, [reportArtifact]),
              providerCapture.artifacts,
            ),
            logger,
          }),
        logger,
      );
      const savedArtifacts = appendArtifacts(
        appendArtifacts(undefined, [reportArtifact, transcriptArtifact]),
        providerCapture.artifacts,
      );
      const archive = await maybeArchiveCompletedConversation({
        Runtime,
        logger,
        config,
        accountDigest: chatGptAccountDigest,
        conversationUrl: lastUrl,
        followUpCount: 0,
        requiredArtifactsSaved: Boolean(reportArtifact && transcriptArtifact),
      });
      return {
        answerText: researchResult.text,
        answerMarkdown: researchResult.text,
        answerHtml: researchResult.html,
        artifacts: savedArtifacts,
        providerNativeCapture: providerCapture.summary,
        archive,
        modelSelection: modelSelectionEvidence,
        thinkingSelection: thinkingSelectionEvidence,
        tookMs: durationMs,
        answerTokens: tokens,
        answerChars: researchResult.text.length,
        chromePid: chrome.pid,
        chromePort: chrome.port,
        chromeHost,
        userDataDir,
        chromeTargetId: lastTargetId,
        tabUrl: lastUrl,
        conversationId: runConversationId,
        promptSubmitted,
        submittedPromptHash,
        ownedRecoveryTarget,
        controllerPid: process.pid,
        chatGptAccountDigest: chatGptAccountDigest ?? undefined,
        researchPlan,
      };
    }
    // Helper to normalize text for echo detection (collapse whitespace, lowercase)
    const normalizeForComparison = (text: string): string =>
      text.toLowerCase().replace(/\s+/g, " ").trim();
    const readRunAssistantSnapshot = async (minTurnIndex: number | undefined, action: string) => {
      await assertPageAffinity(action);
      return readAssistantSnapshot(
        Runtime,
        minTurnIndex,
        runConversationId,
        undefined,
        runConversationUrl,
      ).catch(() => null);
    };
    const waitForFreshAssistantResponse = async (baselineNormalized: string, timeoutMs: number) => {
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : "";
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await readRunAssistantSnapshot(
          baselineTurns ?? undefined,
          "fresh assistant response read",
        );
        throwIfAssistantUiError(snapshot);
        const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
        if (text) {
          const normalized = normalizeForComparison(text);
          const isBaseline =
            normalized === baselineNormalized ||
            (baselinePrefix.length > 0 && normalized.startsWith(baselinePrefix));
          if (!isBaseline) {
            return {
              text,
              html: snapshot?.html ?? undefined,
              meta: {
                turnId: snapshot?.turnId ?? undefined,
                messageId: snapshot?.messageId ?? undefined,
              },
            };
          }
        }
        await delay(350);
      }
      return null;
    };
    const waitWithThinkingMonitor = async <T>(operation: () => Promise<T>): Promise<T> => {
      stopThinkingMonitor?.();
      stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, {
        intervalMs: options.heartbeatIntervalMs,
      });
      try {
        return await operation();
      } finally {
        stopThinkingMonitor?.();
        stopThinkingMonitor = null;
      }
    };
    const recheckDelayMs = Math.max(0, config.assistantRecheckDelayMs ?? 0);
    const recheckTimeoutMs = Math.max(0, config.assistantRecheckTimeoutMs ?? 0);
    const attemptAssistantRecheck = async () => {
      if (!recheckDelayMs) return null;
      logger(
        `[browser] Assistant response timed out; waiting ${formatElapsed(recheckDelayMs)} before rechecking conversation.`,
      );
      await raceWithDisconnect(delay(recheckDelayMs));
      await assertPageAffinity("assistant recheck preparation");
      await updateConversationHint("assistant-recheck", 15_000).catch(() => false);
      await captureRuntimeSnapshot().catch(() => undefined);
      await assertPageAffinity("assistant conversation URL read");
      const conversationUrl = await readConversationUrl(Runtime);
      if (conversationUrl && (runConversationId || runConversationUrl)) {
        assertRunConversationId(
          runConversationId,
          runConversationUrl,
          conversationUrl,
          "assistant recheck",
        );
      }
      if (conversationUrl && isConversationUrl(conversationUrl)) {
        logger(`[browser] Rechecking assistant response at ${conversationUrl}`);
        await assertPageAffinity("assistant conversation reload");
        await raceWithDisconnect(Page.navigate({ url: conversationUrl }));
        await raceWithDisconnect(
          waitForResumedConversationHydration(Runtime, recheckTimeoutMs || 30_000, logger, {
            requirePriorTurns: true,
            requirePromptReady: false,
            expectedConversationUrl: conversationUrl,
          }),
        );
      }
      // Validate session before attempting recheck - sessions can expire during the delay
      await assertPageAffinity("assistant session validation");
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
              userDataDir,
              chromeTargetId: lastTargetId,
              tabUrl: lastUrl,
              conversationId: runConversationId,
              promptSubmitted,
              submittedPromptHash,
              ownedRecoveryTarget,
              controllerPid: process.pid,
              chatGptAccountDigest: chatGptAccountDigest ?? undefined,
            },
          },
        );
      }
      const timeoutMs = recheckTimeoutMs > 0 ? recheckTimeoutMs : config.timeoutMs;
      const rechecked = await waitWithThinkingMonitor(() =>
        raceWithDisconnect(
          waitForAssistantOrGeneratedImageResponse({
            Runtime,
            waitForText: () =>
              waitForAssistantResponseWithReload(
                Runtime,
                Page,
                timeoutMs,
                logger,
                baselineTurns ?? undefined,
                runConversationId,
                runConversationUrl,
                assertPageAffinity,
              ),
            timeoutMs,
            logger,
            minTurnIndex: baselineTurns ?? undefined,
            expectedConversationId: runConversationId,
            expectedConversationUrl: runConversationUrl,
            assertPageAffinity,
            imageOutputRequested,
          }),
        ),
      );
      logger("Recovered assistant response after delayed recheck");
      return rechecked;
    };
    const imageOutputRequested = Boolean(
      options.generateImagePath ||
      options.outputPath ||
      (options as { generateImage?: string }).generateImage,
    );
    const captureAssistantTurn = async (
      turnPrompt: string,
      label: string,
    ): Promise<BrowserConversationTurn & { answerHtml: string }> => {
      let turnAnswer: AssistantAnswer;
      try {
        await updateConversationHint("assistant-wait", 15_000).catch(() => false);
        turnAnswer = await waitWithThinkingMonitor(() =>
          raceWithDisconnect(
            waitForAssistantOrGeneratedImageResponse({
              Runtime,
              waitForText: () =>
                waitForAssistantResponseWithReload(
                  Runtime,
                  Page,
                  config.timeoutMs,
                  logger,
                  baselineTurns ?? undefined,
                  runConversationId,
                  runConversationUrl,
                  assertPageAffinity,
                ),
              timeoutMs: config.timeoutMs,
              logger,
              minTurnIndex: baselineTurns ?? undefined,
              expectedConversationId: runConversationId,
              expectedConversationUrl: runConversationUrl,
              assertPageAffinity,
              imageOutputRequested,
            }),
          ),
        );
      } catch (error) {
        if (isAssistantResponseTimeoutError(error)) {
          const rechecked = await attemptAssistantRecheckOrRethrow(attemptAssistantRecheck);
          if (rechecked) {
            turnAnswer = rechecked;
          } else {
            await updateConversationHint("assistant-timeout", 15_000).catch(() => false);
            await captureRuntimeSnapshot().catch(() => undefined);
            const diagnostics = await captureBrowserDiagnostics(
              Runtime,
              logger,
              "assistant-timeout",
              {
                Page,
                sessionId: options.sessionId,
              },
            ).catch(() => undefined);
            const runtime = {
              chromePid: chrome.pid,
              chromePort: chrome.port,
              chromeHost,
              userDataDir,
              chromeTargetId: lastTargetId,
              tabUrl: lastUrl,
              conversationId: runConversationId,
              promptSubmitted,
              submittedPromptHash,
              ownedRecoveryTarget,
              controllerPid: process.pid,
              chatGptAccountDigest: chatGptAccountDigest ?? undefined,
            };
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
      // Ensure we store the final conversation URL even if the UI updated late.
      await updateConversationHint("post-response", 15_000);
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
          const refreshed = await waitForFreshAssistantResponse(baselineNormalized, 15_000);
          if (refreshed) {
            turnAnswer = refreshed;
          }
        }
      }
      let turnAnswerText = turnAnswer.text;
      const turnAnswerHtml = turnAnswer.html ?? "";
      const copiedMarkdown = await raceWithDisconnect(
        withRetries(
          async () => {
            const attempt = await captureAssistantMarkdown(
              Runtime,
              turnAnswer.meta,
              logger,
              runConversationId,
              assertPageAffinity,
              runConversationUrl,
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
        ),
      ).catch(async () => {
        await assertPageAffinity("assistant markdown copy fallback");
        return null;
      });
      let turnAnswerMarkdown = copiedMarkdown ?? turnAnswerText;

      const promptEchoMatcher = buildPromptEchoMatcher(turnPrompt);
      ({ answerText: turnAnswerText, answerMarkdown: turnAnswerMarkdown } =
        await maybeRecoverLongAssistantResponse({
          runtime: Runtime,
          baselineTurns,
          answerText: turnAnswerText,
          answerMarkdown: turnAnswerMarkdown,
          logger,
          allowMarkdownUpdate: !copiedMarkdown,
          expectedConversationId: runConversationId,
          expectedConversationUrl: runConversationUrl,
          assertPageAffinity,
        }));

      // Final sanity check: ensure we didn't accidentally capture the user prompt instead of the assistant turn.
      const finalSnapshot = await readRunAssistantSnapshot(
        baselineTurns ?? undefined,
        "final assistant response read",
      );
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

      // Detect prompt echo using normalized comparison (whitespace-insensitive).
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
      const isPromptEcho = alignedEcho.isEcho;
      if (isPromptEcho) {
        logger("Detected prompt echo in response; waiting for actual assistant response...");
        const deadline = Date.now() + 15_000;
        let bestText: string | null = null;
        let stableCount = 0;
        while (Date.now() < deadline) {
          const snapshot = await readRunAssistantSnapshot(
            baselineTurns ?? undefined,
            "prompt-echo assistant response read",
          );
          throwIfAssistantUiError(snapshot);
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
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (bestText) {
          logger("Recovered assistant response after detecting prompt echo");
          turnAnswerText = bestText;
          turnAnswerMarkdown = bestText;
        }
      }
      const minAnswerChars = 16;
      if (turnAnswerText.trim().length > 0 && turnAnswerText.trim().length < minAnswerChars) {
        const deadline = Date.now() + 12_000;
        let bestText = turnAnswerText.trim();
        let stableCycles = 0;
        while (Date.now() < deadline) {
          const snapshot = await readRunAssistantSnapshot(
            baselineTurns ?? undefined,
            "short assistant response read",
          );
          throwIfAssistantUiError(snapshot);
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
        if (bestText.length > turnAnswerText.trim().length) {
          logger("Refreshed short assistant response from latest DOM snapshot");
          turnAnswerText = bestText;
          turnAnswerMarkdown = bestText;
        }
      }
      answerMessageId = turnAnswer.meta.messageId ?? undefined;
      return {
        label,
        answerText: turnAnswerText,
        answerMarkdown: turnAnswerMarkdown,
        answerHtml: turnAnswerHtml,
      };
    };

    const turns: BrowserConversationTurn[] = [];
    const initialTurn = await captureAssistantTurn(promptText, "Initial response");
    turns.push(initialTurn);
    answerText = initialTurn.answerText;
    answerMarkdown = initialTurn.answerMarkdown;
    answerHtml = initialTurn.answerHtml;

    for (let index = 0; index < followUpPrompts.length; index += 1) {
      const followUpPrompt = followUpPrompts[index];
      logger(`[browser] Sending follow-up ${index + 1}/${followUpPrompts.length}`);
      await acquireProfileLockIfNeeded();
      try {
        await raceWithDisconnect(clearPromptComposer(Runtime, logger, assertPageAffinity));
        await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
        const submission = await runSubmissionWithRecovery({
          prompt: followUpPrompt,
          attachments: [],
          submit: (submissionPrompt, submissionAttachments) =>
            raceWithDisconnect(submitOnce(submissionPrompt, submissionAttachments)),
          reloadPromptComposer,
          prepareFallbackSubmission: async () => {
            await raceWithDisconnect(clearPromptComposer(Runtime, logger, assertPageAffinity));
            await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
          },
          logger,
        });
        baselineTurns = submission.baselineTurns;
        baselineAssistantText = submission.baselineAssistantText;
      } finally {
        await releaseProfileLockIfHeld();
      }
      const turn = await captureAssistantTurn(followUpPrompt, `Follow-up ${index + 1}`);
      turns.push({ ...turn, prompt: followUpPrompt });
      answerText = turn.answerText;
      answerMarkdown = turn.answerMarkdown;
      answerHtml = turn.answerHtml;
    }

    if (turns.length > 1) {
      const formatted = formatBrowserTurnTranscript(turns);
      answerText = formatted.answerText;
      answerMarkdown = formatted.answerMarkdown;
      answerHtml = "";
    }
    if (connectionClosedUnexpectedly) {
      // Bail out on mid-run disconnects so the session stays reattachable.
      throw new Error("Chrome disconnected before completion");
    }
    const localDownloadBehaviorLockScope = {
      browserId: (await resolveRemoteChromeBrowserIdentity({ host: chromeHost, port: chrome.port }))
        .browserId,
    };
    const imageArtifacts = await collectGeneratedImageArtifacts({
      Browser: client.Browser,
      Client: client,
      Page,
      Runtime,
      Network,
      logger,
      minTurnIndex: imageArtifactMinTurnIndex,
      sessionId: options.sessionId,
      generateImagePath: options.generateImagePath,
      outputPath: options.outputPath,
      answerText,
      waitTimeoutMs: options.config?.timeoutMs,
      expectedConversationId: runConversationId,
      expectedConversationUrl: runConversationUrl,
      assertPageAffinity,
      expectedAccountDigest: chatGptAccountDigest ?? undefined,
      downloadBehaviorLockScope: localDownloadBehaviorLockScope,
      checkBlockingUiWarning: () =>
        throwChatGptUiWarningIfPresent({
          Runtime,
          logger,
          stage: "image-artifact-wait",
          waitTarget: "generated image artifacts",
          runtime: {
            chromePid: chrome.pid,
            chromePort: chrome.port,
            chromeHost,
            userDataDir,
            chromeTargetId: lastTargetId,
            tabUrl: lastUrl,
            conversationId: runConversationId,
            promptSubmitted,
            submittedPromptHash,
            ownedRecoveryTarget,
            controllerPid: process.pid,
            chatGptAccountDigest: chatGptAccountDigest ?? undefined,
          },
        }),
    });
    answerText = imageArtifacts.answerText || answerText;
    if (imageArtifacts.markdownSuffix) {
      answerMarkdown += imageArtifacts.markdownSuffix;
    }
    const fileArtifacts = await collectChatGptFileArtifacts({
      Browser: client.Browser,
      Client: client,
      Page,
      Runtime,
      Network,
      answerText: [answerText, answerMarkdown, answerHtml].filter(Boolean).join("\n"),
      logger,
      minTurnIndex: imageArtifactMinTurnIndex,
      sessionId: options.sessionId,
      expectedConversationId: runConversationId,
      expectedConversationUrl: runConversationUrl,
      assertPageAffinity,
      expectedAccountDigest: chatGptAccountDigest ?? undefined,
      downloadBehaviorLockScope: localDownloadBehaviorLockScope,
    });
    const savedImageArtifacts = appendArtifacts(undefined, imageArtifacts.savedImages);
    const savedBrowserArtifacts = appendArtifacts(savedImageArtifacts, fileArtifacts.savedFiles);
    const providerCapture = await runProviderNativeCapture({
      Runtime,
      config,
      conversationUrl: lastUrl,
      sessionId: options.sessionId,
      answerMarkdown,
      answerMessageId,
      logger,
    });
    const browserArtifactsWithCapture = appendArtifacts(
      savedBrowserArtifacts,
      providerCapture.artifacts,
    );
    const transcriptArtifact = await saveOptionalArtifact(
      () =>
        saveBrowserTranscriptArtifact({
          sessionId: options.sessionId,
          prompt: promptText,
          answerMarkdown,
          conversationUrl: lastUrl,
          artifacts: browserArtifactsWithCapture,
          logger,
        }),
      logger,
    );
    const savedArtifacts = appendArtifacts(browserArtifactsWithCapture, [transcriptArtifact]);
    const archive = await maybeArchiveCompletedConversation({
      Runtime,
      logger,
      config,
      accountDigest: chatGptAccountDigest,
      conversationUrl: lastUrl,
      followUpCount: followUpPrompts.length,
      requiredArtifactsSaved:
        Boolean(transcriptArtifact) &&
        imageArtifacts.savedImages.length === imageArtifacts.imageCount &&
        fileArtifacts.savedFiles.length === fileArtifacts.fileCount,
    });
    runStatus = "complete";
    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);
    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      artifacts: savedArtifacts,
      providerNativeCapture: providerCapture.summary,
      generatedImages: imageArtifacts.generatedImages,
      savedImages: imageArtifacts.savedImages,
      downloadableFiles: fileArtifacts.files,
      savedFiles: fileArtifacts.savedFiles,
      archive,
      modelSelection: modelSelectionEvidence,
      thinkingSelection: thinkingSelectionEvidence,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      userDataDir,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      conversationId: runConversationId,
      promptSubmitted,
      submittedPromptHash,
      ownedRecoveryTarget,
      controllerPid: process.pid,
      chatGptAccountDigest: chatGptAccountDigest ?? undefined,
    };
  } catch (error) {
    if (options.signal?.aborted || error instanceof BrowserRunCancelledError) {
      runStatus = "cancelled";
      throw new BrowserRunCancelledError();
    }
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
    connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;
    const preservedErrorKind = classifyPreservedBrowserError(normalizedError, config.headless);
    if (preservedErrorKind === "cloudflare-challenge") {
      if (usingCopiedProfile) {
        logger(
          "Cloudflare challenge detected; closing Chrome and removing the copied profile because copy-profile runs cannot be retained.",
        );
        throw new BrowserAutomationError(
          "Cloudflare challenge detected. Copy-profile runs cannot be retained; complete the check in the source Chrome profile, then rerun.",
          { stage: "cloudflare-challenge", reattachable: false },
          normalizedError,
        );
      }
      preserveBrowserOnError = true;
      const runtime = {
        chromePid: chrome.pid,
        chromePort: chrome.port,
        chromeHost,
        userDataDir,
        chromeTargetId: lastTargetId,
        tabUrl: lastUrl,
        promptSubmitted,
        submittedPromptHash,
        ownedRecoveryTarget,
        controllerPid: process.pid,
        chatGptAccountDigest: chatGptAccountDigest ?? undefined,
      };
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
    if (preservedErrorKind === "reattachable-capture") {
      if (usingCopiedProfile) {
        logger(
          "Assistant capture incomplete; closing Chrome and removing the copied profile because copy-profile runs cannot be reattached.",
        );
        const details =
          normalizedError instanceof BrowserAutomationError
            ? { ...normalizedError.details, runtime: undefined, reattachable: false }
            : { stage: "assistant-recheck", reattachable: false };
        throw new BrowserAutomationError(normalizedError.message, details, normalizedError);
      }
      const archive =
        !socketClosed && browserRuntime
          ? await maybeArchiveInterruptedConversation({
              Runtime: browserRuntime,
              logger,
              config,
              accountDigest: chatGptAccountDigest,
              conversationUrl: lastUrl,
              followUpCount: followUpPrompts.length,
            })
          : null;
      if (archive?.conversationUrl) {
        lastUrl = archive.conversationUrl;
      }
      preserveBrowserOnError = archive?.archived !== true;
      await emitRuntimeHint();
      logger(
        archive?.archived
          ? "Assistant capture incomplete; archived conversation and closing browser."
          : "Assistant capture incomplete; leaving browser open for reattach.",
      );
      throw withInterruptedArchiveDetails(normalizedError, archive);
    }
    if (!socketClosed) {
      const archive = browserRuntime
        ? await maybeArchiveInterruptedConversation({
            Runtime: browserRuntime,
            logger,
            config,
            accountDigest: chatGptAccountDigest,
            conversationUrl: lastUrl,
            followUpCount: followUpPrompts.length,
          })
        : null;
      if (archive?.conversationUrl) {
        lastUrl = archive.conversationUrl;
        await emitRuntimeHint();
      }
      preserveBrowserOnError = promptSubmitted && archive?.archived !== true;
      logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
      if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
        logger(normalizedError.stack);
      }
      throw withInterruptedArchiveDetails(normalizedError, archive);
    }
    if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
      logger(`Chrome connection lost before completion: ${normalizedError.message}`);
      logger(normalizedError.stack);
    }
    await emitRuntimeHint();
    if (
      normalizedError instanceof BrowserAutomationError &&
      (normalizedError.details as { stage?: string } | undefined)?.stage === "connection-lost"
    ) {
      throw normalizedError;
    }
    const liveness = await probeChromeTargetLiveness({
      host: chromeHost,
      port: chrome.port,
      targetId: lastTargetId ?? isolatedTargetId,
    });
    const recoverable = isRecoverableChromeDisconnect(liveness);
    throw new BrowserAutomationError(
      connectionLostUserMessage({ recoverable }),
      {
        stage: "connection-lost",
        recoverableDisconnect: recoverable,
        disconnectCause: recoverable ? "cdp-client-disconnect" : "chrome-closed",
        runtime: {
          chromePid: chrome.pid,
          chromePort: chrome.port,
          chromeHost,
          userDataDir,
          chromeTargetId: lastTargetId,
          tabUrl: liveness.matchedUrl ?? lastUrl,
          conversationId:
            (liveness.matchedUrl ?? lastUrl)
              ? extractConversationIdFromUrl(liveness.matchedUrl ?? lastUrl ?? "")
              : undefined,
          promptSubmitted,
          submittedPromptHash,
          ownedRecoveryTarget,
          controllerPid: process.pid,
          chatGptAccountDigest: chatGptAccountDigest ?? undefined,
          researchPlan,
        },
      },
      normalizedError,
    );
  } finally {
    await withoutBrowserCancellation(async () => {
      stopThinkingMonitor?.();
      await conversationUrlMonitor?.stop();
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
      const shouldCloseOwnedRunTarget = shouldCloseOwnedRunTargetAfterRun({
        runStatus,
        ownsTarget,
        keepBrowser: effectiveKeepBrowser,
        closeOwnedTabOnComplete: options.closeOwnedTabOnComplete,
        closeOwnedTabOnCancel: options.closeOwnedTabOnCancel,
        preserveForRecovery: preserveBrowserOnError,
      });
      let keepBrowserOpen =
        (manualLogin && runStatus === "cancelled") ||
        shouldKeepLocalBrowserOpen({
          effectiveKeepBrowser,
          preserveBrowserOnError,
          usingCopiedProfile,
        });
      let cleanupProfileLock: ProfileRunLock | null = null;
      let browserTerminationHandledByLease = false;
      let tabLeaseReleaseError: Error | undefined;
      if (!keepBrowserOpen && manualLogin && tabLease) {
        const cleanupLockTimeoutMs = Math.max(0, config.profileLockTimeoutMs ?? 0);
        if (cleanupLockTimeoutMs > 0) {
          cleanupProfileLock = await acquireProfileRunLock(userDataDir, {
            timeoutMs: cleanupLockTimeoutMs,
            logger,
            sessionId: options.sessionId,
          }).catch(() => null);
        }
      }
      const closeOwnedRunTarget = async () => {
        if (!shouldCloseOwnedRunTarget || !isolatedTargetId || !chrome?.port) {
          return;
        }
        const safeToClose =
          !keepBrowserOpen ||
          Boolean(
            await ensureChromePageTargetAfterClose(
              chrome.port,
              isolatedTargetId,
              logger,
              chromeHost,
            ),
          );
        if (!safeToClose) {
          logger(
            `[browser] Leaving completed browser tab open because Chrome has no replacement page target.`,
          );
          return;
        }
        const closeConfirmed = await closeTab(chrome.port, isolatedTargetId, logger, chromeHost);
        if (!closeConfirmed && keepBrowserOpen) {
          const replacementTargetId = await createChromePageTarget(chrome.port, logger, chromeHost);
          if (!replacementTargetId) {
            logger("[browser] Chrome page retention could not be verified after cleanup.");
          }
        }
      };
      const cleanupBlankTabs = async () => {
        if (
          !shouldCleanupBlankTabsAfterLastLease({
            runStatus,
            ownsTarget,
            connectionClosedUnexpectedly,
            manualLogin,
            keepBrowser: effectiveKeepBrowser,
            chromePort: chrome?.port,
          }) ||
          !chrome?.port
        ) {
          return;
        }
        await closeBlankChromeTabs(chrome.port, logger, chromeHost, {
          excludeTargetIds: [isolatedTargetId, lastTargetId],
          preserveOneBlank: true,
        });
      };
      if (tabLease) {
        const handle = tabLease;
        tabLease = null;
        const terminateSharedChrome =
          !keepBrowserOpen && manualLogin && !connectionClosedUnexpectedly
            ? async () => terminateRecordedChromeForProfile(userDataDir, logger).catch(() => false)
            : undefined;
        const releaseResult = await releaseLocalBrowserTabLease({
          lease: handle,
          closeOwnedRunTarget,
          cleanupBlankTabs,
          terminateSharedChrome,
          sessionId: options.sessionId,
          chromePid: chrome.pid,
          chromePort: chrome.port,
          chromeTargetId: isolatedTargetId,
          launchDisposition: reusedChrome ? "reused" : "launched",
          logger,
        });
        keepBrowserOpen ||= releaseResult.keepBrowserOpen;
        browserTerminationHandledByLease = releaseResult.terminationHandled;
        tabLeaseReleaseError = releaseResult.releaseError;
      } else {
        await closeOwnedRunTarget();
        await cleanupBlankTabs();
      }
      removeDialogHandler?.();
      removeTerminationHooks?.();
      if (!keepBrowserOpen) {
        if (!connectionClosedUnexpectedly) {
          try {
            if (!browserTerminationHandledByLease) {
              await chrome.kill();
            }
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
      } else {
        detachKeptChromeProcess(chrome);
        if (!connectionClosedUnexpectedly) {
          logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
        }
      }
      if (cleanupProfileLock) {
        const handle = cleanupProfileLock;
        cleanupProfileLock = null;
        await handle.release().catch(() => undefined);
      }
      if (tabLeaseReleaseError) {
        // oxlint-disable-next-line eslint/no-unsafe-finally -- This cleanup failure must override a successful browser result or a live MCP owner can remain locked.
        throw new Error(
          "Failed to release the ChatGPT browser slot registry lock; restart Oracle/Codex MCP before another browser run.",
          { cause: tabLeaseReleaseError },
        );
      }
    });
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
  failFastOnLoginCta,
  timeoutMs,
  profileDir,
  keepBrowser,
}: {
  runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  appliedCookies: number;
  manualLogin: boolean;
  failFastOnLoginCta?: boolean;
  timeoutMs: number;
  profileDir?: string;
  keepBrowser?: boolean;
}): Promise<void> {
  if (!manualLogin) {
    await ensureLoggedIn(runtime, logger, { appliedCookies });
    return;
  }
  const waitMs = resolveManualLoginWaitMs(timeoutMs, Boolean(keepBrowser));
  const deadline = Date.now() + waitMs;
  let lastNotice = 0;
  while (Date.now() < deadline) {
    try {
      await ensureLoggedIn(runtime, logger, { appliedCookies, failFastOnLoginCta });
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
  const setupCommand = formatManualLoginSetupCommand(profileDir ?? defaultManualLoginProfileDir());
  throw new Error(
    "Manual login mode timed out waiting for ChatGPT session. " +
      `Browser mode is using Oracle's private Chrome profile at ${profileDir ?? "(default profile)"}, not your normal Chrome profile. ` +
      `Run first-time setup, sign in there, then retry: ${setupCommand}`,
  );
}

async function maybeRecoverLongAssistantResponse({
  runtime,
  baselineTurns,
  answerText,
  answerMarkdown,
  logger,
  allowMarkdownUpdate,
  expectedConversationId,
  expectedConversationUrl,
  assertPageAffinity,
}: {
  runtime: ChromeClient["Runtime"];
  baselineTurns: number | null;
  answerText: string;
  answerMarkdown: string;
  logger: BrowserLogger;
  allowMarkdownUpdate: boolean;
  expectedConversationId?: string;
  expectedConversationUrl?: string;
  assertPageAffinity?: (action: string) => Promise<void>;
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
    await assertPageAffinity?.("delayed assistant response read");
    const laterSnapshot = await readAssistantSnapshot(
      runtime,
      baselineTurns ?? undefined,
      expectedConversationId,
      undefined,
      expectedConversationUrl,
    ).catch(() => null);
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

export type BrowserChrome = LaunchedChrome & { host?: string };

function detachKeptChromeProcess(chrome: Pick<LaunchedChrome, "process">): void {
  try {
    chrome.process?.unref();
  } catch {
    // Best-effort only; cleanup should not mask the original browser result.
  }
}

export async function acquireManualLoginChromeForRun(
  userDataDir: string,
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
  sessionId?: string,
  deps: {
    maybeReuse?: typeof maybeReuseRunningChrome;
    launch?: typeof launchChrome;
  } = {},
): Promise<{ chrome: BrowserChrome; reusedChrome: LaunchedChrome | null }> {
  const maybeReuse = deps.maybeReuse ?? maybeReuseRunningChrome;
  const launch = deps.launch ?? launchChrome;
  const lockTimeoutMs = Math.max(0, config.profileLockTimeoutMs ?? 0);
  let launchLock: ProfileRunLock | null = null;

  if (lockTimeoutMs > 0) {
    launchLock = await acquireProfileRunLock(userDataDir, {
      timeoutMs: lockTimeoutMs,
      logger,
      sessionId,
    });
  }

  try {
    const reusedChrome = await maybeReuse(userDataDir, logger, {
      waitForPortMs: config.reuseChromeWaitMs,
      chromePath: config.chromePath,
    });
    const chrome =
      reusedChrome ??
      (await launch(
        {
          ...config,
          remoteChrome: config.remoteChrome,
        },
        userDataDir,
        logger,
      ));

    // Persist while the launch lock is still held so parallel callers reuse
    // this Chrome instead of racing to start another one on the same profile.
    if (chrome.port) {
      await writeDevToolsActivePort(userDataDir, chrome.port);
      if (!reusedChrome && chrome.pid) {
        await writeChromePid(userDataDir, chrome.pid);
      }
    }

    return { chrome, reusedChrome };
  } finally {
    if (launchLock) {
      await launchLock.release().catch(() => undefined);
    }
  }
}

function resolveAccountAffinityProbeTimeoutMs(inputTimeoutMs: number | undefined): number {
  return typeof inputTimeoutMs === "number" && Number.isFinite(inputTimeoutMs)
    ? Math.max(0, inputTimeoutMs)
    : 0;
}

function resolveWrapperExpectedAccountEmail(): string | undefined {
  const rawEmail = process.env.ORACLE_WRAPPER_EXPECTED_ACCOUNT_EMAIL;
  if (!rawEmail?.trim()) return undefined;
  const email = normalizeChatGptAccountEmail(rawEmail);
  if (!email) {
    throw new BrowserAutomationError("Configured ChatGPT account email is invalid.", {
      stage: "remote-browser-identity",
    });
  }
  return email;
}

async function assertRemoteChatGptAccountAffinity(
  Runtime: ChromeClient["Runtime"],
  accountDigest: string | null | undefined,
  action: string,
  remainingMs?: number,
): Promise<void> {
  const expectedAccountDigest = normalizeChatGptAccountDigest(accountDigest);
  if (!expectedAccountDigest) {
    throw new BrowserAutomationError(
      `Remote Chrome account identity is unavailable before ${action}.`,
      { stage: "remote-browser-identity" },
    );
  }
  if ((await readChatGptAccountDigest(Runtime, remainingMs)) !== expectedAccountDigest) {
    throw new BrowserAutomationError(`Remote Chrome account identity changed before ${action}.`, {
      stage: "remote-browser-identity",
    });
  }
}

async function runRemoteBrowserMode(
  promptText: string,
  attachments: BrowserAttachment[],
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
  options: BrowserRunOptions,
  cancellation: BrowserCancellation,
): Promise<BrowserRunResult> {
  const startedAt = Date.now();

  const remoteChromeConfig = config.remoteChrome;
  if (!remoteChromeConfig) {
    throw new Error(
      "Remote Chrome configuration missing. Pass --remote-chrome <host:port> to use this mode.",
    );
  }
  const { host, port } = remoteChromeConfig;
  const configuredBrowserId = config.remoteChromeBrowserId?.trim();
  const configuredGeneralAccountDigest = normalizeChatGptAccountDigest(
    config.expectedAccountDigest,
  );
  if (config.expectedAccountDigest != null && !configuredGeneralAccountDigest) {
    throw new BrowserAutomationError("Expected ChatGPT account identity is invalid.", {
      stage: "remote-browser-identity",
    });
  }
  const configuredRemoteAccountDigest = normalizeChatGptAccountDigest(
    config.remoteChromeAccountDigest,
  );
  if (config.remoteChromeAccountDigest != null && !configuredRemoteAccountDigest) {
    throw new BrowserAutomationError("Remote Chrome account identity is invalid.", {
      stage: "remote-browser-identity",
    });
  }
  if (
    configuredGeneralAccountDigest &&
    configuredRemoteAccountDigest &&
    configuredGeneralAccountDigest !== configuredRemoteAccountDigest
  ) {
    throw new BrowserAutomationError("Stored ChatGPT account identity is conflicting.", {
      stage: "remote-browser-identity",
    });
  }
  const expectedAccountDigest = configuredRemoteAccountDigest ?? configuredGeneralAccountDigest;
  let expectedBrowserId = configuredBrowserId;
  let browserWSEndpoint = config.remoteChromeBrowserWSEndpoint ?? undefined;
  const liveIdentity = await resolveRemoteChromeBrowserIdentity({ host, port });
  if (expectedBrowserId) {
    if (!browserWSEndpoint) {
      throw new BrowserAutomationError("Remote Chrome browser identity is missing its WebSocket.", {
        stage: "remote-browser-identity",
      });
    }
    if (browserIdFromWebSocketEndpoint(browserWSEndpoint) !== expectedBrowserId) {
      throw new BrowserAutomationError(
        "Remote Chrome browser identity does not match its WebSocket.",
        {
          stage: "remote-browser-identity",
        },
      );
    }
    if (liveIdentity.browserId !== expectedBrowserId) {
      throw new BrowserAutomationError(
        "Remote Chrome browser identity changed before attachment.",
        {
          stage: "remote-browser-identity",
        },
      );
    }
  } else {
    expectedBrowserId = liveIdentity.browserId;
    config.remoteChromeBrowserId = expectedBrowserId;
  }
  browserWSEndpoint = liveIdentity.browserWSEndpoint;
  config.remoteChromeBrowserWSEndpoint = browserWSEndpoint;
  if (process.env.ORACLE_WRAPPER_REMOTE_ONLY === "1" && !configuredBrowserId) {
    throw new BrowserAutomationError(
      "The agent wrapper requires a verified remote Chrome browser identity.",
      {
        stage: "remote-browser-identity",
      },
    );
  }
  if (
    process.env.ORACLE_WRAPPER_REMOTE_ONLY === "1" &&
    config.resumeConversationUrl &&
    !expectedAccountDigest
  ) {
    throw new BrowserAutomationError(
      "Stored remote Chrome session has no verified account identity; start a fresh browser conversation through the agent wrapper.",
      { stage: "remote-browser-identity" },
    );
  }
  logger(`Connecting to remote Chrome at ${host}:${port}`);

  let client: ChromeClient | null = null;
  let browserRuntime: ChromeClient["Runtime"] | null = null;
  let remoteTargetId: string | null = null;
  let tabLease: BrowserTabLease | null = null;
  let lastUrl: string | undefined;
  let runConversationId = resolveInitialRunConversationId(config);
  let runConversationUrl = resolveInitialRunConversationUrl(config);
  let postSubmitConversationUrlPromise: Promise<boolean> | null = null;
  let promptSubmitted = false;
  let submittedPromptHash: string | null = null;
  let ownedRecoveryTarget: BrowserRunResult["ownedRecoveryTarget"];
  const targetClaimId = randomUUID();
  let modelSelectionEvidence: BrowserModelSelectionEvidence | undefined;
  let thinkingSelectionEvidence: BrowserThinkingSelectionEvidence | undefined;
  let researchPlan: BrowserResearchPlanMetadata | undefined;
  let attachedExistingTab = false;
  let attachedTabDescription: string | null = null;
  let ownsTarget = true;
  let conversationUrlMonitor: ConversationUrlMonitor | null = null;
  const runtimeHintCb = options.runtimeHintCb;
  const emitRuntimeHint = async () => {
    if (!runtimeHintCb) return;
    try {
      await runtimeHintCb(
        {
          chromePort: port,
          chromeHost: host,
          chromeBrowserWSEndpoint: browserWSEndpoint,
          chatGptAccountDigest: config.remoteChromeAccountDigest ?? undefined,
          chromeProfileRoot,
          chromeTargetId: remoteTargetId ?? undefined,
          tabUrl: lastUrl,
          conversationId:
            runConversationId ?? (lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined),
          promptSubmitted,
          submittedPromptHash,
          ownedRecoveryTarget,
          controllerPid: process.pid,
          researchPlan,
        },
        modelSelectionEvidence,
      );
      await tabLease?.update({
        chromeHost: host,
        chromePort: port,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: lastUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
    }
  };
  const markPromptSubmitted = async (): Promise<void> => {
    promptSubmitted = true;
    submittedPromptHash = null;
    await emitRuntimeHint();
    postSubmitConversationUrlPromise =
      conversationUrlMonitor?.schedule("post-submit", config.timeoutMs ?? 120_000) ?? null;
  };
  const accountAffinityProbeTimeoutMs = () =>
    resolveAccountAffinityProbeTimeoutMs(config.inputTimeoutMs);
  let answerText = "";
  let answerMarkdown = "";
  let answerMessageId: string | undefined;
  let answerHtml = "";
  let connectionClosedUnexpectedly = false;
  let runStatus: "attempted" | "complete" | "cancelled" = "attempted";
  let completedResult: BrowserRunResult | undefined;
  let preserveBrowserOnError = false;
  let stopThinkingMonitor: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let connection: Awaited<ReturnType<typeof connectToRemoteChrome>> | null = null;
  const chromeProfileRoot = config.remoteChromeProfileRoot ?? undefined;
  const followUpPrompts = normalizeBrowserFollowUpPrompts(options.followUpPrompts);

  try {
    const initialWrapperExpectedEmail = resolveWrapperExpectedAccountEmail();
    if (initialWrapperExpectedEmail) {
      const accountVerificationConnection = await connectToRemoteChrome(
        host,
        port,
        logger,
        CHATGPT_URL,
        browserWSEndpoint,
        {
          approvalWaitMs: config.attachRunning && browserWSEndpoint ? 20_000 : undefined,
        },
      );
      let accountVerificationFailed = false;
      let accountVerificationError: unknown;
      try {
        const { Page, Runtime } = accountVerificationConnection.client;
        await Promise.all([Page.enable(), Runtime.enable()]);
        await navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger);
        await assertChatGptAccountEmail(
          Runtime,
          initialWrapperExpectedEmail,
          "Oracle remote browser initialization",
          accountAffinityProbeTimeoutMs(),
        );
      } catch (error) {
        accountVerificationFailed = true;
        accountVerificationError = error;
      }
      try {
        await accountVerificationConnection.close();
      } catch (closeError) {
        if (accountVerificationFailed) {
          throw new AggregateError(
            [accountVerificationError, closeError],
            "Remote ChatGPT account verification and target cleanup failed.",
          );
        }
        throw closeError;
      }
      if (accountVerificationFailed) {
        throw accountVerificationError;
      }
    }
    const remoteLeaseProfileDir = config.browserTabRef
      ? null
      : resolveRemoteTabLeaseProfileDir(config);
    if (remoteLeaseProfileDir) {
      await mkdir(remoteLeaseProfileDir, { recursive: true });
      tabLease = await cancellation.acquire(
        () =>
          acquireBrowserTabLease(remoteLeaseProfileDir, {
            maxConcurrentTabs: config.maxConcurrentTabs,
            timeoutMs: config.timeoutMs,
            logger,
            sessionId: options.sessionId,
            chromeHost: host,
            chromePort: port,
            signal: options.signal,
          }),
        (lease) => lease.release(),
      );
    }
    if (config.browserTabRef) {
      const tabRef = config.browserTabRef;
      const attached = await cancellation.acquire(
        () =>
          connectToExistingChatGptTab({
            host,
            port,
            ref: tabRef,
            browserId: expectedBrowserId,
            browserWSEndpoint,
            approvalWaitMs: config.approvalWaitMs,
            accountDigest: expectedAccountDigest,
          }),
        (attached) => attached.client.close(),
      );
      const attachedConversationId = expectedConversationIdForRef(tabRef, attached.tab);
      if (attachedConversationId && attached.tab.url) {
        const affinity = latchRunConversationAffinity(
          runConversationId,
          runConversationUrl,
          attached.tab.url,
          "attached tab selection",
        );
        runConversationId = affinity.conversationId;
        runConversationUrl = affinity.conversationUrl;
      }
      client = cancellation.client(attached.client);
      remoteTargetId = attached.targetId ?? null;
      lastUrl = attached.tab.url || lastUrl;
      attachedExistingTab = true;
      ownsTarget = false;
      attachedTabDescription = "Attached to an existing remote ChatGPT tab.";
    } else {
      connection = await cancellation.acquire(
        () =>
          connectToRemoteChrome(host, port, logger, "about:blank", browserWSEndpoint, {
            approvalWaitMs: browserWSEndpoint ? config.approvalWaitMs : undefined,
            fallbackToDefault: false,
          }),
        (connection) => connection.close(),
      );
      client = cancellation.client(connection.client);
      remoteTargetId = connection.targetId ?? null;
      ownsTarget = Boolean(connection.targetId);
      if (connection.targetId && (!config.keepBrowser || options.closeOwnedTabOnComplete)) {
        ownedRecoveryTarget = {
          host,
          port,
          targetId: connection.targetId,
          browserWSEndpoint,
          claimId: targetClaimId,
        };
      }
    }
    if (tabLease && remoteTargetId) {
      await tabLease.update({
        chromeHost: host,
        chromePort: port,
        chromeTargetId: remoteTargetId,
      });
    }
    const markConnectionLost = () => {
      connectionClosedUnexpectedly = true;
    };
    client.on("disconnect", markConnectionLost);
    const { Network, Page, Runtime, Input, DOM, Target } = client;

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    if (config.browserTabRef) await claimBrowserTarget(Runtime, targetClaimId);
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);
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
        if (runConversationId || runConversationUrl) {
          const affinity = latchRunConversationAffinity(
            runConversationId,
            runConversationUrl,
            url,
            "conversation URL update",
          );
          runConversationId = affinity.conversationId;
          runConversationUrl = affinity.conversationUrl;
        }
        lastUrl = url;
        await emitRuntimeHint();
      },
      logger,
    });
    conversationUrlMonitor = activeConversationUrlMonitor;

    // Skip cookie sync for remote Chrome - it already has cookies.
    // For a stored session, verify the signed-in account before touching its conversation state.
    if (expectedAccountDigest) {
      if (!attachedExistingTab) {
        await navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger);
      }
      await ensureNotBlocked(Runtime, config.headless, logger);
      await ensureLoggedIn(Runtime, logger, { remoteSession: true });
      const observedAccountDigest = await readChatGptAccountDigest(
        Runtime,
        accountAffinityProbeTimeoutMs(),
      );
      if (observedAccountDigest !== expectedAccountDigest) {
        throw new BrowserAutomationError(
          "Remote Chrome account identity changed before submission.",
          {
            stage: "remote-browser-identity",
          },
        );
      }
    }
    logger("Skipping cookie sync for remote Chrome (using existing session)");
    await clearStaleChatGptConversationCookies(Network, Target, logger, {
      preserveConversationIds: conversationCookieIdsToPreserve(config, lastUrl),
    });

    if (config.resumeConversationUrl) {
      await navigateToChatGPT(Page, Runtime, config.resumeConversationUrl, logger);
    } else if (!attachedExistingTab) {
      await navigateToChatGPT(Page, Runtime, config.url, logger);
    }
    await ensureNotBlocked(Runtime, config.headless, logger);
    await ensureLoggedIn(Runtime, logger, { remoteSession: true });
    const wrapperExpectedEmail = resolveWrapperExpectedAccountEmail();
    const observedAccountDigest = wrapperExpectedEmail
      ? await assertChatGptAccountEmail(
          Runtime,
          wrapperExpectedEmail,
          "Oracle prompt submission",
          accountAffinityProbeTimeoutMs(),
        )
      : await readChatGptAccountDigest(Runtime, accountAffinityProbeTimeoutMs());
    if (expectedAccountDigest && observedAccountDigest !== expectedAccountDigest) {
      throw new BrowserAutomationError(
        "Remote Chrome account identity changed before submission.",
        {
          stage: "remote-browser-identity",
        },
      );
    }
    config.expectedAccountDigest = observedAccountDigest;
    config.remoteChromeAccountDigest = observedAccountDigest;
    const assertAttachedConversation = async (action: string): Promise<void> => {
      const url = await assertChatGptTabOrigin(Runtime, action);
      if (runConversationId || runConversationUrl) {
        assertRunConversationId(runConversationId, runConversationUrl, url, action);
      }
    };
    const assertPageAffinity = async (action: string): Promise<void> => {
      await assertAttachedConversation(action);
      if (wrapperExpectedEmail) {
        await assertChatGptAccountEmail(
          Runtime,
          wrapperExpectedEmail,
          action,
          accountAffinityProbeTimeoutMs(),
        );
      }
      await assertRemoteChatGptAccountAffinity(
        Runtime,
        config.remoteChromeAccountDigest,
        action,
        accountAffinityProbeTimeoutMs(),
      );
    };
    const ensureRunConversationPinnedAfterSubmit = async (
      committedConversationUrl: string | undefined,
    ): Promise<void> => {
      if (!committedConversationUrl) {
        throw new BrowserAutomationError(
          "ChatGPT did not verify the submitted turn's conversation URL.",
          { stage: "conversation-affinity", code: "conversation-commit-unverified" },
        );
      }
      const committedConversationAffinity = latchRunConversationAffinity(
        runConversationId,
        runConversationUrl,
        committedConversationUrl,
        "submitted prompt commit",
      );
      const initialUrl = await assertChatGptTabOrigin(Runtime, "post-submit conversation pin");
      assertRunConversationId(
        committedConversationAffinity.conversationId,
        committedConversationAffinity.conversationUrl,
        initialUrl,
        "response handling",
      );
      runConversationId = committedConversationAffinity.conversationId;
      runConversationUrl = committedConversationAffinity.conversationUrl;
      lastUrl = initialUrl;
      await emitRuntimeHint();
      await (postSubmitConversationUrlPromise ??
        activeConversationUrlMonitor.schedule("post-submit", config.timeoutMs ?? 120_000));
      const confirmedUrl = await assertChatGptTabOrigin(
        Runtime,
        "post-submit conversation confirmation",
      );
      assertRunConversationId(
        runConversationId,
        runConversationUrl,
        confirmedUrl,
        "response handling",
      );
      lastUrl = confirmedUrl;
      await emitRuntimeHint();
      await assertPageAffinity("post-submit response handling");
    };
    if (attachedTabDescription) logger(attachedTabDescription);
    await emitRuntimeHint();
    await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
    if (config.resumeConversationUrl) {
      await waitForResumedConversationHydration(Runtime, config.inputTimeoutMs, logger, {
        requirePriorTurns: true,
        expectedConversationUrl: config.resumeConversationUrl,
      });
    }
    const chatMode = await ensureChatMode(Runtime, Input, config.inputTimeoutMs, logger, {
      resetWorkConversation:
        attachedExistingTab && !config.resumeConversationUrl
          ? async () => {
              await navigateToChatGPT(Page, Runtime, config.url, logger);
              runConversationId = undefined;
              runConversationUrl = undefined;
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
        if (runConversationId || runConversationUrl) {
          assertRunConversationId(
            runConversationId,
            runConversationUrl,
            result.value,
            "runtime hint capture",
          );
        }
        lastUrl = result.value;
      }
      await emitRuntimeHint();
    } catch {
      // ignore
    }

    const modelStrategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
    if (config.desiredModel && modelStrategy !== "ignore" && !config.resumeConversationUrl) {
      modelSelectionEvidence = await withRetries(
        () =>
          ensureModelSelection(Runtime, config.desiredModel as string, logger, modelStrategy, {
            expectedConversationId: runConversationId,
            assertPageAffinity,
            implicitDefault: config.modelIsImplicitDefault,
          }),
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
      modelSelectionEvidence = buildSkippedModelSelectionEvidence(
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
    if (shouldApplyThinkingTimeSelection(config)) {
      const thinkingTargetModel = modelStrategy === "select" ? config.desiredModel : null;
      thinkingSelectionEvidence = await withRetries(
        () =>
          ensureThinkingTime(Runtime, config.thinkingTime, logger, thinkingTargetModel, {
            expectedConversationId: runConversationId,
            expectedConversationUrl: runConversationUrl,
            assertPageAffinity,
          }),
        {
          retries: 2,
          delayMs: 300,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Thinking time (${config.thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        },
      );
    }

    const submitOnce = async (prompt: string, submissionAttachments: BrowserAttachment[]) => {
      await assertPageAffinity("submission preparation");
      await claimBrowserTarget(Runtime, targetClaimId);
      const baselineSnapshot = await readAssistantSnapshot(
        Runtime,
        undefined,
        runConversationId,
        undefined,
        runConversationUrl,
      ).catch(() => null);
      const baselineAssistantText =
        typeof baselineSnapshot?.text === "string" ? baselineSnapshot.text.trim() : "";
      const attachmentNames = submissionAttachments.map((a) => path.basename(a.path));
      const attachmentExpectations = submissionAttachments.map((a) => ({
        name: path.basename(a.path),
        generatedBundle: a.generatedBundle === true,
      }));
      let attachmentNavigationUrl: string | undefined;
      await clearPromptComposer(Runtime, logger, assertPageAffinity);
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
      if (submissionAttachments.length > 0) {
        if (!DOM) {
          throw new Error("Chrome DOM domain unavailable while uploading attachments.");
        }
        attachmentNavigationUrl = await captureComposerNavigationUrl(Runtime);
        await clearComposerAttachments(Runtime, 5_000, logger, assertPageAffinity);
        // Use remote file transfer for remote Chrome (reads local files and injects via CDP)
        for (const attachment of submissionAttachments) {
          await assertPageAffinity("attachment upload");
          await assertComposerPlusStayedInPlace(Runtime, attachmentNavigationUrl);
          logger(`Uploading attachment: ${attachment.displayPath}`);
          await uploadAttachmentViaDataTransfer(
            {
              runtime: Runtime,
              dom: DOM,
              navigationUrl: attachmentNavigationUrl,
              assertPageAffinity,
              expectedConversationId: runConversationId,
              expectedAccountDigest: config.remoteChromeAccountDigest ?? undefined,
            },
            attachment,
            logger,
          );
          await delay(500);
        }
        // Scale timeout based on number of files: base 30s + 15s per additional file
        const baseTimeout = config.inputTimeoutMs ?? 30_000;
        const perFileTimeout = 15_000;
        const waitBudget =
          Math.max(baseTimeout, 30_000) + (submissionAttachments.length - 1) * perFileTimeout;
        const attachmentWaitBudget = Math.max(config.attachmentTimeoutMs ?? 0, waitBudget);
        await waitForAttachmentCompletion(Runtime, attachmentWaitBudget, attachmentNames, logger);
        await assertPageAffinity("attachment completion wait");
        logger("All attachments uploaded");
      }
      if (deepResearch) {
        await withRetries(
          () =>
            activateDeepResearch(Runtime, Input, logger, {
              expectedConversationId: runConversationId,
              expectedConversationUrl: runConversationUrl,
              assertPageAffinity,
            }),
          {
            retries: 2,
            delayMs: 500,
            onRetry: (attempt, error) => {
              if (options.verbose) {
                logger(
                  `[retry] Deep Research activation attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                );
              }
            },
          },
        );
        await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
        logger(
          `Prompt textarea ready (after Deep Research activation, ${prompt.length.toLocaleString()} chars queued)`,
        );
      }
      let baselineTurns = await readConversationTurnCount(Runtime, logger);
      const providerState: Record<string, unknown> = {
        runtime: Runtime,
        input: Input,
        page: Page,
        logger,
        timeoutMs: config.timeoutMs,
        inputTimeoutMs: config.inputTimeoutMs ?? undefined,
        attachmentTimeoutMs: config.attachmentTimeoutMs ?? undefined,
        baselineTurns: baselineTurns ?? undefined,
        attachmentNames: attachmentExpectations,
        attachmentNavigationUrl,
        onPromptSubmitted: markPromptSubmitted,
        assertPageAffinity,
        expectedConversationId: runConversationId,
        expectedConversationUrl: runConversationUrl,
        webSearch: config.researchMode === "search",
      };
      const deepResearchTargetBaseline =
        deepResearch && client
          ? await captureDeepResearchTargetBaseline(client, logger)
          : undefined;
      await assertPageAffinity("prompt submission");
      const previousUserMessageIds = await readUserMessageIds(Runtime, config.inputTimeoutMs);
      await runProviderSubmissionFlow(chatgptDomProvider, {
        prompt,
        evaluate: async () => undefined,
        delay,
        log: logger,
        state: providerState,
      });
      await markPromptSubmitted();
      await ensureRunConversationPinnedAfterSubmit(
        typeof providerState.committedConversationUrl === "string"
          ? providerState.committedConversationUrl
          : undefined,
      );
      const providerBaselineTurns = providerState.baselineTurns;
      const renderedPromptHash = await readSubmittedPromptFingerprint(
        Runtime,
        previousUserMessageIds,
        config.inputTimeoutMs,
      );
      if (renderedPromptHash) {
        submittedPromptHash = renderedPromptHash;
        await emitRuntimeHint();
      }
      if (typeof providerBaselineTurns === "number" && Number.isFinite(providerBaselineTurns)) {
        baselineTurns = providerBaselineTurns;
      }
      return {
        baselineTurns,
        baselineAssistantText,
        deepResearchTargetKeys: deepResearchTargetBaseline?.targetKeys,
        deepResearchTargetBaselineCaptured: deepResearchTargetBaseline?.captured,
      };
    };
    const reloadPromptComposer = async () => {
      logger("[browser] Composer became unresponsive; reloading page and retrying once.");
      await assertPageAffinity("prompt composer reload");
      await Page.reload({ ignoreCache: true });
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
    };

    let baselineTurns: number | null = null;
    let baselineAssistantText: string | null = null;
    let deepResearchTargetKeys: string[] = [];
    let deepResearchTargetBaselineCaptured = false;
    const submission = await runSubmissionWithRecovery({
      prompt: promptText,
      attachments,
      fallbackSubmission: options.fallbackSubmission,
      submit: submitOnce,
      reloadPromptComposer,
      prepareFallbackSubmission: async () => {
        await clearPromptComposer(Runtime, logger, assertPageAffinity);
        await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
      },
      logger,
    });
    baselineTurns = submission.baselineTurns;
    baselineAssistantText = submission.baselineAssistantText;
    deepResearchTargetKeys = submission.deepResearchTargetKeys ?? [];
    deepResearchTargetBaselineCaptured = submission.deepResearchTargetBaselineCaptured ?? false;
    const imageArtifactMinTurnIndex = baselineTurns;
    if (deepResearch) {
      await waitForResearchPlanAutoConfirm(Runtime, logger, undefined, {
        expectedConversationId: runConversationId,
        expectedConversationUrl: runConversationUrl,
        assertPageAffinity,
        Page,
        client,
        ignoredTargetKeys: deepResearchTargetKeys,
        targetBaselineCaptured: deepResearchTargetBaselineCaptured,
        minTurnIndex: baselineTurns,
        onPlan: async (plan) => {
          researchPlan = plan;
          await emitRuntimeHint();
        },
      });
      const researchResult = await waitForDeepResearchCompletion(
        Runtime,
        logger,
        config.timeoutMs,
        baselineTurns,
        Page,
        client,
        {
          ignoredTargetKeys: deepResearchTargetKeys,
          targetBaselineCaptured: deepResearchTargetBaselineCaptured,
          expectedConversationId: runConversationId,
          expectedConversationUrl: runConversationUrl,
          assertPageAffinity,
        },
      );
      await activeConversationUrlMonitor.update("post-deep-research", 15_000).catch(() => false);
      await assertPageAffinity("post-Deep Research finalization");
      const durationMs = Date.now() - startedAt;
      const tokens = estimateTokenCount(researchResult.text);
      const reportArtifact = await saveOptionalArtifact(
        () =>
          saveDeepResearchReportArtifact({
            sessionId: options.sessionId,
            reportMarkdown: researchResult.text,
            conversationUrl: lastUrl,
            logger,
          }),
        logger,
      );
      const providerCapture = await runProviderNativeCapture({
        Runtime,
        config,
        conversationUrl: lastUrl,
        sessionId: options.sessionId,
        answerMarkdown: researchResult.text,
        logger,
      });
      const transcriptArtifact = await saveOptionalArtifact(
        () =>
          saveBrowserTranscriptArtifact({
            sessionId: options.sessionId,
            prompt: promptText,
            answerMarkdown: researchResult.text,
            conversationUrl: lastUrl,
            artifacts: appendArtifacts(
              appendArtifacts(undefined, [reportArtifact]),
              providerCapture.artifacts,
            ),
            logger,
          }),
        logger,
      );
      const savedArtifacts = appendArtifacts(
        appendArtifacts(undefined, [reportArtifact, transcriptArtifact]),
        providerCapture.artifacts,
      );
      const archive = await maybeArchiveCompletedConversation({
        Runtime,
        logger,
        config,
        accountDigest: config.remoteChromeAccountDigest,
        conversationUrl: lastUrl,
        followUpCount: 0,
        requiredArtifactsSaved: Boolean(reportArtifact && transcriptArtifact),
      });
      runStatus = "complete";
      completedResult = {
        answerText: researchResult.text,
        answerMarkdown: researchResult.text,
        answerHtml: researchResult.html,
        artifacts: savedArtifacts,
        providerNativeCapture: providerCapture.summary,
        archive,
        modelSelection: modelSelectionEvidence,
        thinkingSelection: thinkingSelectionEvidence,
        tookMs: durationMs,
        answerTokens: tokens,
        answerChars: researchResult.text.length,
        chromePort: port,
        chromeHost: host,
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chatGptAccountDigest: config.remoteChromeAccountDigest ?? undefined,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: lastUrl,
        conversationId: runConversationId,
        promptSubmitted,
        submittedPromptHash,
        ownedRecoveryTarget,
        controllerPid: process.pid,
        researchPlan,
      };
      return completedResult;
    }
    // Helper to normalize text for echo detection (collapse whitespace, lowercase)
    const normalizeForComparison = (text: string): string =>
      text.toLowerCase().replace(/\s+/g, " ").trim();
    const readRunAssistantSnapshot = async (minTurnIndex: number | undefined, action: string) => {
      await assertPageAffinity(action);
      return readAssistantSnapshot(
        Runtime,
        minTurnIndex,
        runConversationId,
        undefined,
        runConversationUrl,
      ).catch(() => null);
    };
    const waitForFreshAssistantResponse = async (baselineNormalized: string, timeoutMs: number) => {
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : "";
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await readRunAssistantSnapshot(
          baselineTurns ?? undefined,
          "fresh assistant response read",
        );
        throwIfAssistantUiError(snapshot);
        const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
        if (text) {
          const normalized = normalizeForComparison(text);
          const isBaseline =
            normalized === baselineNormalized ||
            (baselinePrefix.length > 0 && normalized.startsWith(baselinePrefix));
          if (!isBaseline) {
            return {
              text,
              html: snapshot?.html ?? undefined,
              meta: {
                turnId: snapshot?.turnId ?? undefined,
                messageId: snapshot?.messageId ?? undefined,
              },
            };
          }
        }
        await delay(350);
      }
      return null;
    };
    const waitWithThinkingMonitor = async <T>(operation: () => Promise<T>): Promise<T> => {
      stopThinkingMonitor?.();
      stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, {
        intervalMs: options.heartbeatIntervalMs,
      });
      try {
        return await operation();
      } finally {
        stopThinkingMonitor?.();
        stopThinkingMonitor = null;
      }
    };
    const recheckDelayMs = Math.max(0, config.assistantRecheckDelayMs ?? 0);
    const recheckTimeoutMs = Math.max(0, config.assistantRecheckTimeoutMs ?? 0);
    const attemptAssistantRecheck = async () => {
      if (!recheckDelayMs) return null;
      logger(
        `[browser] Assistant response timed out; waiting ${formatElapsed(recheckDelayMs)} before rechecking conversation.`,
      );
      await delay(recheckDelayMs);
      await assertPageAffinity("assistant recheck preparation");
      await assertPageAffinity("assistant conversation URL read");
      const conversationUrl = await readConversationUrl(Runtime);
      if (conversationUrl && (runConversationId || runConversationUrl)) {
        assertRunConversationId(
          runConversationId,
          runConversationUrl,
          conversationUrl,
          "assistant recheck",
        );
      }
      if (conversationUrl && isConversationUrl(conversationUrl)) {
        lastUrl = conversationUrl;
        logger(`[browser] Rechecking assistant response at ${conversationUrl}`);
        await assertPageAffinity("assistant conversation reload");
        await Page.navigate({ url: conversationUrl });
        await waitForResumedConversationHydration(Runtime, recheckTimeoutMs || 30_000, logger, {
          requirePriorTurns: true,
          requirePromptReady: false,
          expectedConversationUrl: conversationUrl,
        });
      }
      // Validate session before attempting recheck - sessions can expire during the delay
      await assertPageAffinity("assistant session validation");
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
              conversationId: runConversationId,
              promptSubmitted,
              submittedPromptHash,
              ownedRecoveryTarget,
              controllerPid: process.pid,
              chatGptAccountDigest: config.remoteChromeAccountDigest ?? undefined,
            },
          },
        );
      }
      await emitRuntimeHint();
      const timeoutMs = recheckTimeoutMs > 0 ? recheckTimeoutMs : config.timeoutMs;
      const rechecked = await waitWithThinkingMonitor(() =>
        waitForAssistantOrGeneratedImageResponse({
          Runtime,
          waitForText: () =>
            waitForAssistantResponseWithReload(
              Runtime,
              Page,
              timeoutMs,
              logger,
              baselineTurns ?? undefined,
              runConversationId,
              runConversationUrl,
              assertPageAffinity,
            ),
          timeoutMs,
          logger,
          minTurnIndex: baselineTurns ?? undefined,
          expectedConversationId: runConversationId,
          expectedConversationUrl: runConversationUrl,
          assertPageAffinity,
          imageOutputRequested,
        }),
      );
      logger("Recovered assistant response after delayed recheck");
      return rechecked;
    };
    const imageOutputRequested = Boolean(
      options.generateImagePath ||
      options.outputPath ||
      (options as { generateImage?: string }).generateImage,
    );
    const captureAssistantTurn = async (
      turnPrompt: string,
      label: string,
    ): Promise<BrowserConversationTurn & { answerHtml: string }> => {
      let turnAnswer: AssistantAnswer;
      try {
        await activeConversationUrlMonitor.update("assistant-wait", 15_000).catch(() => false);
        turnAnswer = await waitWithThinkingMonitor(() =>
          waitForAssistantOrGeneratedImageResponse({
            Runtime,
            waitForText: () =>
              waitForAssistantResponseWithReload(
                Runtime,
                Page,
                config.timeoutMs,
                logger,
                baselineTurns ?? undefined,
                runConversationId,
                runConversationUrl,
                assertPageAffinity,
              ),
            timeoutMs: config.timeoutMs,
            logger,
            minTurnIndex: baselineTurns ?? undefined,
            expectedConversationId: runConversationId,
            expectedConversationUrl: runConversationUrl,
            assertPageAffinity,
            imageOutputRequested,
          }),
        );
      } catch (error) {
        if (isAssistantResponseTimeoutError(error)) {
          const rechecked = await attemptAssistantRecheckOrRethrow(attemptAssistantRecheck);
          if (rechecked) {
            turnAnswer = rechecked;
          } else {
            await activeConversationUrlMonitor
              .update("assistant-timeout", 15_000)
              .catch(() => false);
            const diagnostics = await captureBrowserDiagnostics(
              Runtime,
              logger,
              "assistant-timeout",
              {
                Page,
                sessionId: options.sessionId,
              },
            ).catch(() => undefined);
            const runtime = {
              chromePort: port,
              chromeHost: host,
              chromeBrowserWSEndpoint: browserWSEndpoint,
              chromeProfileRoot,
              chromeTargetId: remoteTargetId ?? undefined,
              tabUrl: lastUrl,
              conversationId: runConversationId,
              promptSubmitted,
              submittedPromptHash,
              ownedRecoveryTarget,
              controllerPid: process.pid,
              chatGptAccountDigest: config.remoteChromeAccountDigest ?? undefined,
            };
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
      await assertPageAffinity("post-response finalization");
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
          const refreshed = await waitForFreshAssistantResponse(baselineNormalized, 15_000);
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
            runConversationId,
            assertPageAffinity,
            runConversationUrl,
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
      ).catch(async () => {
        await assertPageAffinity("assistant markdown copy fallback");
        return null;
      });

      let turnAnswerMarkdown = copiedMarkdown ?? turnAnswerText;
      ({ answerText: turnAnswerText, answerMarkdown: turnAnswerMarkdown } =
        await maybeRecoverLongAssistantResponse({
          runtime: Runtime,
          baselineTurns,
          answerText: turnAnswerText,
          answerMarkdown: turnAnswerMarkdown,
          logger,
          allowMarkdownUpdate: !copiedMarkdown,
          expectedConversationId: runConversationId,
          expectedConversationUrl: runConversationUrl,
          assertPageAffinity,
        }));

      // Final sanity check: ensure we didn't accidentally capture the user prompt instead of the assistant turn.
      const finalSnapshot = await readRunAssistantSnapshot(
        baselineTurns ?? undefined,
        "final assistant response read",
      );
      const finalText = typeof finalSnapshot?.text === "string" ? finalSnapshot.text.trim() : "";
      if (
        finalText &&
        finalText !== turnAnswerMarkdown.trim() &&
        finalText !== turnPrompt.trim() &&
        finalText.length >= turnAnswerMarkdown.trim().length
      ) {
        logger("Refreshed assistant response via final DOM snapshot");
        turnAnswerText = finalText;
        turnAnswerMarkdown = finalText;
      }

      // Detect prompt echo using normalized comparison (whitespace-insensitive).
      const promptEchoMatcher = buildPromptEchoMatcher(turnPrompt);
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
      const isPromptEcho = alignedEcho.isEcho;
      if (isPromptEcho) {
        logger("Detected prompt echo in response; waiting for actual assistant response...");
        const deadline = Date.now() + 15_000;
        let bestText: string | null = null;
        let stableCount = 0;
        while (Date.now() < deadline) {
          const snapshot = await readRunAssistantSnapshot(
            baselineTurns ?? undefined,
            "prompt-echo assistant response read",
          );
          throwIfAssistantUiError(snapshot);
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
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (bestText) {
          logger("Recovered assistant response after detecting prompt echo");
          turnAnswerText = bestText;
          turnAnswerMarkdown = bestText;
        }
      }
      answerMessageId = turnAnswer.meta.messageId ?? undefined;
      return {
        label,
        answerText: turnAnswerText,
        answerMarkdown: turnAnswerMarkdown,
        answerHtml: turnAnswerHtml,
      };
    };

    const turns: BrowserConversationTurn[] = [];
    const initialTurn = await captureAssistantTurn(promptText, "Initial response");
    turns.push(initialTurn);
    answerText = initialTurn.answerText;
    answerMarkdown = initialTurn.answerMarkdown;
    answerHtml = initialTurn.answerHtml;

    for (let index = 0; index < followUpPrompts.length; index += 1) {
      const followUpPrompt = followUpPrompts[index];
      logger(`[browser] Sending follow-up ${index + 1}/${followUpPrompts.length}`);
      await clearPromptComposer(Runtime, logger, assertPageAffinity);
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
      const submission = await runSubmissionWithRecovery({
        prompt: followUpPrompt,
        attachments: [],
        submit: submitOnce,
        reloadPromptComposer,
        prepareFallbackSubmission: async () => {
          await clearPromptComposer(Runtime, logger, assertPageAffinity);
          await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
        },
        logger,
      });
      baselineTurns = submission.baselineTurns;
      baselineAssistantText = submission.baselineAssistantText;
      const turn = await captureAssistantTurn(followUpPrompt, `Follow-up ${index + 1}`);
      turns.push({ ...turn, prompt: followUpPrompt });
      answerText = turn.answerText;
      answerMarkdown = turn.answerMarkdown;
      answerHtml = turn.answerHtml;
    }

    if (turns.length > 1) {
      const formatted = formatBrowserTurnTranscript(turns);
      answerText = formatted.answerText;
      answerMarkdown = formatted.answerMarkdown;
      answerHtml = "";
    }
    const canSaveBrowserDownloadsLocally = isLocalChromeHost(host);
    const imageArtifacts = await collectGeneratedImageArtifacts({
      Browser: canSaveBrowserDownloadsLocally ? client.Browser : undefined,
      Client: canSaveBrowserDownloadsLocally ? client : undefined,
      Page: canSaveBrowserDownloadsLocally ? Page : undefined,
      Runtime,
      Network,
      logger,
      minTurnIndex: imageArtifactMinTurnIndex,
      sessionId: options.sessionId,
      generateImagePath: options.generateImagePath,
      outputPath: options.outputPath,
      answerText,
      waitTimeoutMs: options.config?.timeoutMs,
      expectedConversationId: runConversationId,
      expectedConversationUrl: runConversationUrl,
      assertPageAffinity,
      expectedAccountDigest: config.remoteChromeAccountDigest ?? undefined,
      downloadBehaviorLockScope: { browserId: expectedBrowserId, browserWSEndpoint },
      checkBlockingUiWarning: () =>
        throwChatGptUiWarningIfPresent({
          Runtime,
          logger,
          stage: "image-artifact-wait",
          waitTarget: "generated image artifacts",
          runtime: {
            chromePort: port,
            chromeHost: host,
            chromeBrowserWSEndpoint: browserWSEndpoint,
            chromeProfileRoot,
            chromeTargetId: remoteTargetId ?? undefined,
            tabUrl: lastUrl,
            conversationId: runConversationId,
            promptSubmitted,
            submittedPromptHash,
            ownedRecoveryTarget,
            controllerPid: process.pid,
            chatGptAccountDigest: config.remoteChromeAccountDigest ?? undefined,
          },
        }),
    });
    answerText = imageArtifacts.answerText || answerText;
    if (imageArtifacts.markdownSuffix) {
      answerMarkdown += imageArtifacts.markdownSuffix;
    }
    const fileArtifacts = await collectChatGptFileArtifacts({
      Browser: client.Browser,
      Client: client,
      Page,
      Runtime,
      Network,
      answerText: [answerText, answerMarkdown, answerHtml].filter(Boolean).join("\n"),
      logger,
      minTurnIndex: imageArtifactMinTurnIndex,
      sessionId: options.sessionId,
      expectedConversationId: runConversationId,
      expectedConversationUrl: runConversationUrl,
      assertPageAffinity,
      expectedAccountDigest: config.remoteChromeAccountDigest ?? undefined,
      downloadBehaviorLockScope: { browserId: expectedBrowserId, browserWSEndpoint },
    });
    const savedImageArtifacts = appendArtifacts(undefined, imageArtifacts.savedImages);
    const savedBrowserArtifacts = appendArtifacts(savedImageArtifacts, fileArtifacts.savedFiles);
    const providerCapture = await runProviderNativeCapture({
      Runtime,
      config,
      conversationUrl: lastUrl,
      sessionId: options.sessionId,
      answerMarkdown,
      answerMessageId,
      logger,
    });
    const browserArtifactsWithCapture = appendArtifacts(
      savedBrowserArtifacts,
      providerCapture.artifacts,
    );
    const transcriptArtifact = await saveOptionalArtifact(
      () =>
        saveBrowserTranscriptArtifact({
          sessionId: options.sessionId,
          prompt: promptText,
          answerMarkdown,
          conversationUrl: lastUrl,
          artifacts: browserArtifactsWithCapture,
          logger,
        }),
      logger,
    );
    const savedArtifacts = appendArtifacts(browserArtifactsWithCapture, [transcriptArtifact]);
    const archive = await maybeArchiveCompletedConversation({
      Runtime,
      logger,
      config,
      accountDigest: config.remoteChromeAccountDigest,
      conversationUrl: lastUrl,
      followUpCount: followUpPrompts.length,
      requiredArtifactsSaved:
        Boolean(transcriptArtifact) &&
        imageArtifacts.savedImages.length === imageArtifacts.imageCount &&
        fileArtifacts.savedFiles.length === fileArtifacts.fileCount,
    });
    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);

    runStatus = "complete";
    completedResult = {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      browserTransport: "cdp",
      chromePid: undefined,
      chromePort: port,
      chromeHost: host,
      chromeBrowserWSEndpoint: browserWSEndpoint,
      chatGptAccountDigest: config.remoteChromeAccountDigest ?? undefined,
      chromeProfileRoot,
      userDataDir: undefined,
      chromeTargetId: remoteTargetId ?? undefined,
      tabUrl: lastUrl,
      conversationId: runConversationId,
      promptSubmitted,
      submittedPromptHash,
      ownedRecoveryTarget,
      artifacts: savedArtifacts,
      providerNativeCapture: providerCapture.summary,
      generatedImages: imageArtifacts.generatedImages,
      savedImages: imageArtifacts.savedImages,
      downloadableFiles: fileArtifacts.files,
      savedFiles: fileArtifacts.savedFiles,
      archive,
      modelSelection: modelSelectionEvidence,
      thinkingSelection: thinkingSelectionEvidence,
      controllerPid: process.pid,
    };
    return completedResult;
  } catch (error) {
    if (options.signal?.aborted || error instanceof BrowserRunCancelledError) {
      runStatus = "cancelled";
      throw new BrowserRunCancelledError();
    }
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
    connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;
    const preservedErrorKind = classifyPreservedBrowserError(normalizedError, config.headless);

    if (!socketClosed) {
      const archive = browserRuntime
        ? await maybeArchiveInterruptedConversation({
            Runtime: browserRuntime,
            logger,
            config,
            accountDigest: config.remoteChromeAccountDigest,
            conversationUrl: lastUrl,
            followUpCount: followUpPrompts.length,
          })
        : null;
      if (archive?.conversationUrl) {
        lastUrl = archive.conversationUrl;
        await emitRuntimeHint();
      }
      preserveBrowserOnError =
        promptSubmitted ||
        preservedErrorKind === "cloudflare-challenge" ||
        (preservedErrorKind === "reattachable-capture" && archive?.archived !== true);
      logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
      if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
        logger(normalizedError.stack);
      }
      throw withInterruptedArchiveDetails(normalizedError, archive);
    }

    const liveness = await probeChromeTargetLiveness({
      host,
      port,
      targetId: remoteTargetId,
      browserWSEndpoint,
    });
    const recoverable = isRecoverableChromeDisconnect(liveness);
    preserveBrowserOnError = recoverable && promptSubmitted;
    throw new BrowserAutomationError(connectionLostUserMessage({ recoverable, remote: true }), {
      stage: "connection-lost",
      recoverableDisconnect: recoverable,
      disconnectCause: recoverable ? "cdp-client-disconnect" : "chrome-closed",
      runtime: {
        chromeHost: host,
        chromePort: port,
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chatGptAccountDigest: config.remoteChromeAccountDigest ?? undefined,
        chromeProfileRoot,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: liveness.matchedUrl ?? lastUrl,
        conversationId:
          (liveness.matchedUrl ?? lastUrl)
            ? extractConversationIdFromUrl(liveness.matchedUrl ?? lastUrl ?? "")
            : undefined,
        promptSubmitted,
        submittedPromptHash,
        ownedRecoveryTarget,
        controllerPid: process.pid,
        researchPlan,
      },
    });
  } finally {
    await withoutBrowserCancellation(async () => {
      // Fork hardening: count every cleanup failure and surface it as a run warning.
      let cleanupFailureCount = 0;
      stopThinkingMonitor?.();
      try {
        await conversationUrlMonitor?.stop();
      } catch {
        cleanupFailureCount += 1;
      }
      try {
        removeDialogHandler?.();
      } catch {
        cleanupFailureCount += 1;
      }
      const keepRemoteBrowser = Boolean(config.keepBrowser);
      const shouldCloseOwnedRemoteTarget = shouldCloseOwnedRunTargetAfterRun({
        runStatus,
        ownsTarget,
        keepBrowser: keepRemoteBrowser,
        closeOwnedTabOnComplete: options.closeOwnedTabOnComplete,
        closeOwnedTabOnCancel: options.closeOwnedTabOnCancel,
        preserveForRecovery: preserveBrowserOnError,
      });
      const closeConnection = async () => {
        let preserveTarget = !shouldCloseOwnedRemoteTarget;
        if (!preserveTarget && keepRemoteBrowser && client && remoteTargetId) {
          try {
            const { targetInfos } = await client.Target.getTargets();
            if (
              !targetInfos.some(
                (target) => target.type === "page" && target.targetId !== remoteTargetId,
              )
            ) {
              const replacement = await client.Target.createTarget({ url: "about:blank" });
              if (!replacement.targetId) preserveTarget = true;
            }
          } catch {
            preserveTarget = true;
          }
          if (preserveTarget) {
            cleanupFailureCount += 1;
            logger(
              "[browser] Leaving the completed remote browser tab open because Chrome has no replacement page target.",
            );
          }
        }
        await closeRemoteConnectionAfterRun({
          connectionClosedUnexpectedly,
          connection,
          client,
          preserveTarget,
        });
      };
      if (tabLease) {
        const handle = tabLease;
        tabLease = null;
        try {
          await handle.release({ onRelease: closeConnection });
        } catch {
          cleanupFailureCount += 1;
          await closeRemoteConnectionAfterRun({
            connectionClosedUnexpectedly,
            connection,
            client,
            preserveTarget: true,
          }).catch(() => undefined);
        }
      } else {
        try {
          await closeConnection();
        } catch {
          cleanupFailureCount += 1;
        }
      }
      if (cleanupFailureCount > 0 && !completedResult) {
        logger("[browser] Browser cleanup could not be fully confirmed.");
      }
      appendBrowserCleanupWarning(completedResult, cleanupFailureCount);
      // Don't kill remote Chrome - it's not ours to manage
      const totalSeconds = (Date.now() - startedAt) / 1000;
      logger(`Remote session complete • ${totalSeconds.toFixed(1)}s total`);
    });
  }
}

export { estimateTokenCount } from "./utils.js";
export { resolveBrowserConfig, DEFAULT_BROWSER_CONFIG } from "./config.js";

export const __test__ = {
  assertRemoteChatGptAccountAffinity,
  appendBrowserCleanupWarning,
  assertManualLoginProfileReadyForRun,
  closeRemoteConnectionAfterRun,
  classifyChatGptUiWarningText,
  collectChatGptUiWarnings,
  createAssistantTimeoutError,
  detachKeptChromeProcess,
  formatManualLoginSetupCommand,
  isAssistantResponseTimeoutError,
  isManualLoginProfileInitialized,
  isImageOnlyUiChromeText,
  listIgnoredRemoteChromeFlags,
  normalizeAuthenticatedModelSelectionError,
  conversationCookieIdsToPreserve,
  extractExactChatGptConversationId,
  resolveInitialRunConversationUrl,
  assertRunConversationId,
  resolveInitialRunConversationId,
  resolveAttachmentUploadTimeoutMs,
  pollGeneratedImageOrTextAssistantResponse,
  resolveManualLoginWaitMs,
  shouldApplyThinkingTimeSelection,
  shouldCleanupBlankTabsAfterLastLease,
  shouldCloseOwnedRunTargetAfterRun,
  shouldKeepLocalBrowserOpen,
  releaseLocalBrowserTabLease,
  waitForAssistantResponseWithReload,
  resolveAccountAffinityProbeTimeoutMs,
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

export async function acquireManualLoginChromeForRunForTest(
  userDataDir: string,
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
  sessionId: string | undefined,
  deps: {
    maybeReuse?: typeof maybeReuseRunningChrome;
    launch?: typeof launchChrome;
  },
): Promise<{ chrome: BrowserChrome; reusedChrome: LaunchedChrome | null }> {
  return acquireManualLoginChromeForRun(userDataDir, config, logger, sessionId, deps);
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

async function waitForAssistantResponseWithReload(
  Runtime: ChromeClient["Runtime"],
  Page: ChromeClient["Page"],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
  expectedConversationId?: string,
  expectedConversationUrl?: string,
  assertPageAffinity?: (action: string) => Promise<void>,
) {
  try {
    await assertPageAffinity?.("assistant response read");
    return await waitForAssistantResponse(
      Runtime,
      timeoutMs,
      logger,
      minTurnIndex,
      expectedConversationId,
      expectedConversationUrl,
    );
  } catch (error) {
    if (!shouldReloadAfterAssistantError(error)) {
      throw error;
    }
    await assertPageAffinity?.("assistant conversation URL read");
    const conversationUrl = await readConversationUrl(Runtime);
    if (!conversationUrl || !isConversationUrl(conversationUrl)) {
      throw error;
    }
    if (expectedConversationId || expectedConversationUrl) {
      assertRunConversationId(
        expectedConversationId,
        expectedConversationUrl,
        conversationUrl,
        "assistant conversation reload",
      );
    }
    logger("Assistant response stalled; reloading conversation and retrying once");
    await assertPageAffinity?.("assistant conversation reload");
    await Page.navigate({ url: conversationUrl });
    await waitForResumedConversationHydration(Runtime, timeoutMs, logger, {
      requirePriorTurns: true,
      requirePromptReady: false,
      expectedConversationUrl: expectedConversationUrl ?? conversationUrl,
    });
    await assertPageAffinity?.("assistant response retry read");
    return await waitForAssistantResponse(
      Runtime,
      timeoutMs,
      logger,
      minTurnIndex,
      expectedConversationId,
      expectedConversationUrl,
    );
  }
}

function shouldReloadAfterAssistantError(error: unknown): boolean {
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
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (!message) return false;
  return (
    message === "response timeout" ||
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
  const expression = buildConversationTurnCountExpression();
  const attempts = 4;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { result } = await Runtime.evaluate({
        expression,
        returnByValue: true,
      });
      const raw = typeof result?.value === "number" ? result.value : Number(result?.value);
      if (!Number.isFinite(raw)) {
        throw new Error("Turn count not numeric");
      }
      return Math.max(0, Math.floor(raw));
    } catch (error) {
      if (attempt < attempts - 1) {
        await delay(150);
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
  const tmpDir = os.tmpdir();
  if (shouldPreferSystemTmpDir(process.platform, tmpDir, os.homedir())) {
    try {
      await mkdir("/tmp", { recursive: true });
      return "/tmp";
    } catch {
      // Fall back to the inherited tmpdir if /tmp is unavailable.
    }
  }
  return tmpDir;
}

function shouldPreferSystemTmpDir(
  platform: NodeJS.Platform,
  tmpDir: string,
  homeDir: string,
): boolean {
  if (platform !== "linux" || !tmpDir || !homeDir) return false;
  const relativeToHome = path.relative(homeDir, tmpDir);
  if (!relativeToHome || relativeToHome.startsWith("..") || path.isAbsolute(relativeToHome)) {
    return false;
  }
  const firstSegment = relativeToHome.split(path.sep, 1)[0];
  return Boolean(firstSegment?.startsWith("."));
}

export function shouldPreferSystemTmpDirForTest(
  platform: NodeJS.Platform,
  tmpDir: string,
  homeDir: string,
): boolean {
  return shouldPreferSystemTmpDir(platform, tmpDir, homeDir);
}
