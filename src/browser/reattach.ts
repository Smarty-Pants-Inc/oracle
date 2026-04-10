import CDP from "chrome-remote-interface";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import {
  waitForAssistantResponse,
  captureAssistantMarkdown,
  readAssistantSnapshot,
  navigateToChatGPT,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
  ensureModelSelection,
  clearPromptComposer,
  submitPrompt,
  clearComposerAttachments,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  waitForUserTurnAttachments,
} from "./pageActions.js";
import type { BrowserAttachment, BrowserLogger, ChromeClient } from "./types.js";
import {
  launchChrome,
  connectToChrome,
  connectWithNewTab,
  closeTab,
  hideChromeWindow,
  captureFrontmostProcess,
  startChromeFocusGuard,
  connectToRemoteChromeTarget,
  listRemoteChromeTargets,
} from "./chromeLifecycle.js";
import { maybeReuseRunningChrome } from "./index.js";
import { resolveBrowserConfig } from "./config.js";
import { syncCookies } from "./cookies.js";
import { CHATGPT_URL, DEFAULT_MODEL_STRATEGY } from "./constants.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { cleanupStaleProfileState } from "./profileState.js";
import { ensureThinkingTime } from "./actions/thinkingTime.js";
import { readDevToolsActivePortInfo } from "./detect.js";
import {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  withTimeout,
  openConversationFromSidebar,
  openConversationFromSidebarWithRetry,
  waitForLocationChange,
  readConversationTurnIndex,
  buildPromptEchoMatcher,
  recoverPromptEcho,
  alignPromptEchoMarkdown,
  type TargetInfoLite,
} from "./reattachHelpers.js";
import { delay, estimateTokenCount, withRetries } from "./utils.js";

export interface ReattachDeps {
  listTargets?: () => Promise<TargetInfoLite[]>;
  connect?: (options?: unknown) => Promise<ChromeClient>;
  waitForAssistantResponse?: typeof waitForAssistantResponse;
  captureAssistantMarkdown?: typeof captureAssistantMarkdown;
  ensurePromptReady?: typeof ensurePromptReady;
  ensureModelSelection?: typeof ensureModelSelection;
  ensureThinkingTime?: typeof ensureThinkingTime;
  clearPromptComposer?: typeof clearPromptComposer;
  submitPrompt?: typeof submitPrompt;
  clearComposerAttachments?: typeof clearComposerAttachments;
  uploadAttachmentFile?: typeof uploadAttachmentFile;
  waitForAttachmentCompletion?: typeof waitForAttachmentCompletion;
  waitForUserTurnAttachments?: typeof waitForUserTurnAttachments;
  recoverSession?: (
    runtime: BrowserRuntimeMetadata,
    config: BrowserSessionConfig | undefined,
  ) => Promise<ReattachResult>;
  promptPreview?: string;
}

export interface ReattachResult {
  answerText: string;
  answerMarkdown: string;
  answerTokens?: number;
  tookMs?: number;
  runtime?: BrowserRuntimeMetadata;
}

export interface ContinueBrowserSessionOptions {
  prompt: string;
  attachments?: BrowserAttachment[];
  fallbackSubmission?: { prompt: string; attachments: BrowserAttachment[] };
}

async function readCurrentHref(Runtime: ChromeClient["Runtime"]): Promise<string> {
  const { result } = await Runtime.evaluate({
    expression: "location.href",
    returnByValue: true,
  });
  return typeof result?.value === "string" ? result.value : "";
}

function mergeRuntimeMetadata(
  runtime: BrowserRuntimeMetadata,
  updates: {
    chromePid?: number;
    chromeHost?: string;
    chromePort?: number;
    chromeTargetId?: string | null;
    tabUrl?: string;
    userDataDir?: string;
    controllerPid?: number;
  },
): BrowserRuntimeMetadata {
  const tabUrl = updates.tabUrl || runtime.tabUrl;
  return {
    ...runtime,
    chromePid: updates.chromePid ?? runtime.chromePid,
    chromeHost: updates.chromeHost ?? runtime.chromeHost,
    chromePort: updates.chromePort ?? runtime.chromePort,
    chromeTargetId:
      updates.chromeTargetId === null
        ? undefined
        : (updates.chromeTargetId ?? runtime.chromeTargetId),
    tabUrl,
    conversationId: tabUrl ? extractConversationIdFromUrl(tabUrl) : runtime.conversationId,
    userDataDir: updates.userDataDir ?? runtime.userDataDir,
    controllerPid: updates.controllerPid ?? runtime.controllerPid,
  };
}

async function closeClient(client: ChromeClient | null | undefined): Promise<void> {
  if (!client || typeof client.close !== "function") {
    return;
  }
  try {
    await client.close();
  } catch {
    // ignore
  }
}

async function withHiddenExistingChrome<T>(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  action: (liveRuntime: BrowserRuntimeMetadata) => Promise<T>,
): Promise<T> {
  const resolved = resolveBrowserConfig(config ?? {});
  const liveRuntime = (await refreshAttachRuntime(runtime).catch(() => runtime)) ?? runtime;
  if (process.platform !== "darwin" || resolved.headless || !resolved.hideWindow) {
    return action(liveRuntime);
  }
  if (!liveRuntime.chromePid) {
    return action(liveRuntime);
  }

  const frontmostTarget = await captureFrontmostProcess(logger);
  const chrome = { pid: liveRuntime.chromePid } as Parameters<typeof hideChromeWindow>[0];
  const stopChromeFocusGuard = startChromeFocusGuard(chrome, logger, frontmostTarget);
  try {
    await hideChromeWindow(chrome, logger, frontmostTarget);
    return await action(liveRuntime);
  } finally {
    stopChromeFocusGuard();
    await hideChromeWindow(chrome, logger).catch(() => undefined);
  }
}

async function connectReopenedChrome(
  chrome: { port: number },
  chromeHost: string,
  logger: BrowserLogger,
  strictTabIsolation: boolean,
): Promise<{ client: ChromeClient; isolatedTargetId: string | null }> {
  if (!strictTabIsolation) {
    return {
      client: await connectToChrome(chrome.port, logger, chromeHost),
      isolatedTargetId: null,
    };
  }
  const connection = await connectWithNewTab(chrome.port, logger, undefined, chromeHost, {
    fallbackToDefault: false,
    retries: 3,
    retryDelayMs: 500,
  });
  return {
    client: connection.client,
    isolatedTargetId: connection.targetId ?? null,
  };
}

async function cleanupReopenedChromeLaunch(
  chrome: { kill?: () => Promise<void> | void },
  userDataDir: string,
  manualLogin: boolean,
  logger: BrowserLogger,
): Promise<void> {
  try {
    await chrome.kill?.();
  } catch {
    // ignore kill failures
  }
  if (manualLogin) {
    await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
      () => undefined,
    );
  } else {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function refreshAttachRuntime(
  runtime: BrowserRuntimeMetadata,
): Promise<BrowserRuntimeMetadata | null> {
  if (!runtime.chromeProfileRoot) {
    return runtime;
  }
  const host = runtime.chromeHost ?? "127.0.0.1";
  const activePort = await readDevToolsActivePortInfo(runtime.chromeProfileRoot, {
    host,
  });
  if (!activePort) {
    return runtime;
  }
  return {
    ...runtime,
    chromeHost: host,
    chromePort: activePort.port,
    chromeBrowserWSEndpoint: activePort.browserWSEndpoint,
  };
}

function inferPortFromBrowserWSEndpoint(browserWSEndpoint?: string): number | undefined {
  if (!browserWSEndpoint) {
    return undefined;
  }
  try {
    const parsed = new URL(browserWSEndpoint);
    const port = Number.parseInt(parsed.port, 10);
    if (Number.isFinite(port) && port > 0) {
      return port;
    }
  } catch {
    // ignore malformed ws endpoints and fall back to caller defaults
  }
  return undefined;
}

interface ExistingRuntimeConnection {
  client: ChromeClient;
  close: () => Promise<void>;
  host: string;
  port: number;
  liveRuntime: BrowserRuntimeMetadata;
  target?: TargetInfoLite;
}

async function connectToExistingRuntime(
  runtime: BrowserRuntimeMetadata,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<ExistingRuntimeConnection> {
  const liveRuntime = runtime;
  const host = liveRuntime.chromeHost ?? "127.0.0.1";
  const port =
    liveRuntime.chromePort ?? inferPortFromBrowserWSEndpoint(liveRuntime.chromeBrowserWSEndpoint);
  const resolvedPort = port ?? 9222;
  const browserWSEndpoint = liveRuntime.chromeBrowserWSEndpoint ?? undefined;
  const listTargets =
    deps.listTargets ??
    (async () =>
      (await listRemoteChromeTargets({
        host,
        port: resolvedPort,
        browserWSEndpoint,
      })) as TargetInfoLite[]);
  const targetList = (await listTargets()) as TargetInfoLite[];
  const target = pickTarget(targetList, liveRuntime);
  const useBrowserSocketTarget = Boolean(browserWSEndpoint && target?.targetId);
  if (useBrowserSocketTarget && !deps.connect) {
    const connection = await connectToRemoteChromeTarget(host, resolvedPort, logger, {
      browserWSEndpoint,
      targetId: target?.targetId,
      closeTargetOnDispose: false,
    });
    return {
      client: connection.client,
      close: connection.close,
      host,
      port: resolvedPort,
      liveRuntime,
      target,
    };
  }
  const client = (await (deps.connect ?? ((options?: unknown) => CDP(options as CDP.Options)))(
    useBrowserSocketTarget
      ? {
          target: browserWSEndpoint,
          local: true,
          targetId: target?.targetId,
        }
      : {
          host,
          port: resolvedPort,
          target: target?.targetId,
        },
  )) as unknown as ChromeClient;
  return {
    client,
    close: async () => closeClient(client),
    host,
    port: resolvedPort,
    liveRuntime,
    target,
  };
}

async function ensureConversationOpenForRuntime(
  Runtime: ChromeClient["Runtime"],
  runtime: BrowserRuntimeMetadata,
  promptPreview?: string,
): Promise<void> {
  const href = await readCurrentHref(Runtime);
  if (isFreshChatHomeUrl(href) && !runtime.conversationId) {
    return;
  }
  if (href.includes("/c/")) {
    const currentId = extractConversationIdFromUrl(href);
    if (!runtime.conversationId || (currentId && currentId === runtime.conversationId)) {
      return;
    }
  }
  const opened = await openConversationFromSidebarWithRetry(
    Runtime,
    {
      conversationId: runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? ""),
      preferProjects: true,
      promptPreview,
    },
    15_000,
  );
  if (!opened) {
    throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
  }
  await waitForLocationChange(Runtime, 15_000);
}

function isFreshChatHomeUrl(url: string): boolean {
  if (!url || url.includes("/c/")) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" || parsed.pathname === "";
  } catch {
    return url === "https://chatgpt.com" || url === "https://chatgpt.com/";
  }
}

async function captureConversationResponse(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  deps: ReattachDeps,
  timeoutMs: number,
  promptPreview?: string,
): Promise<ReattachResult> {
  const startedAt = Date.now();
  const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
  const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
  const minTurnIndex = await readConversationTurnIndex(Runtime, logger);
  const promptEcho = buildPromptEchoMatcher(promptPreview);
  const answer = await withTimeout(
    waitForResponse(Runtime, timeoutMs, logger, minTurnIndex ?? undefined),
    timeoutMs + 5_000,
    "Reattach response timed out",
  );
  const recovered = await recoverPromptEcho(
    Runtime,
    answer,
    promptEcho,
    logger,
    minTurnIndex,
    timeoutMs,
  );
  const copiedMarkdown =
    (await withTimeout(
      captureMarkdown(Runtime, recovered.meta, logger, minTurnIndex ?? undefined),
      15_000,
      "Reattach markdown capture timed out",
    )) ?? null;
  const aligned = alignPromptEchoMarkdown(
    recovered.text,
    copiedMarkdown ?? recovered.text,
    promptEcho,
    logger,
  );
  let answerText = aligned.answerMarkdown || aligned.answerText;
  let answerMarkdown = aligned.answerMarkdown || aligned.answerText;
  if (isTransientReattachAnswer(answerText)) {
    const refreshed = await recoverTransientReattachAnswer({
      Runtime,
      captureMarkdown,
      logger,
      matcher: promptEcho,
      minTurnIndex,
      timeoutMs,
    });
    if (refreshed) {
      answerText = refreshed.answerText;
      answerMarkdown = refreshed.answerMarkdown;
    }
  } else {
    const refreshed = await recoverExpandedReattachAnswer({
      Runtime,
      captureMarkdown,
      logger,
      matcher: promptEcho,
      minTurnIndex,
      timeoutMs,
      currentText: answerText,
      currentMarkdown: answerMarkdown,
      currentMeta: recovered.meta,
    });
    if (refreshed) {
      answerText = refreshed.answerText;
      answerMarkdown = refreshed.answerMarkdown;
    }
  }
  return {
    answerText,
    answerMarkdown,
    answerTokens: estimateTokenCount(answerText),
    tookMs: Date.now() - startedAt,
  };
}

function isTransientReattachAnswer(text: string): boolean {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return true;
  }
  const withoutPrefix = normalized.replace(/^chatgpt said:\s*/, "").trim();
  if (!withoutPrefix) {
    return true;
  }
  if (withoutPrefix === "thinking") {
    return true;
  }
  return /^thought for\b.+?(?:seconds?|minutes?|hours?|secs?|mins?|hrs?|ms|s|m|h)(?:\s+thinking)?$/.test(
    withoutPrefix,
  );
}

function shouldPromoteExpandedReattachAnswer(nextText: string, currentText: string): boolean {
  const next = String(nextText || "").trim();
  const current = String(currentText || "").trim();
  if (!next) {
    return false;
  }
  if (!current) {
    return true;
  }
  if (next === current || next.length <= current.length) {
    return false;
  }
  const normalizedNext = next.toLowerCase().replace(/\s+/g, " ").trim();
  const normalizedCurrent = current.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalizedCurrent) {
    return true;
  }
  if (normalizedNext.includes(normalizedCurrent)) {
    return true;
  }
  return next.length >= current.length + Math.max(24, Math.floor(current.length * 0.15));
}

async function recoverTransientReattachAnswer({
  Runtime,
  captureMarkdown,
  logger,
  matcher,
  minTurnIndex,
  timeoutMs,
}: {
  Runtime: ChromeClient["Runtime"];
  captureMarkdown: typeof captureAssistantMarkdown;
  logger: BrowserLogger;
  matcher: ReturnType<typeof buildPromptEchoMatcher>;
  minTurnIndex: number | null;
  timeoutMs: number;
}): Promise<{ answerText: string; answerMarkdown: string } | null> {
  const deadline = Date.now() + Math.min(timeoutMs, 15_000);
  let bestSnapshot: {
    text: string;
    meta: { turnId?: string | null; messageId?: string | null };
  } | null = null;
  let stableCount = 0;
  while (Date.now() < deadline) {
    const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex ?? undefined).catch(
      () => null,
    );
    const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
    if (!text || isTransientReattachAnswer(text) || matcher?.isEcho(text)) {
      await delay(350);
      continue;
    }
    if (!bestSnapshot || text.length > bestSnapshot.text.length) {
      bestSnapshot = {
        text,
        meta: {
          turnId: snapshot?.turnId ?? undefined,
          messageId: snapshot?.messageId ?? undefined,
        },
      };
      stableCount = 0;
    } else if (text === bestSnapshot.text) {
      stableCount += 1;
    }
    if (stableCount >= 2) {
      break;
    }
    await delay(350);
  }
  if (!bestSnapshot) {
    return null;
  }
  const markdown =
    (await captureMarkdown(
      Runtime,
      {
        messageId: bestSnapshot.meta.messageId ?? undefined,
        turnId: bestSnapshot.meta.turnId ?? undefined,
      },
      logger,
      minTurnIndex ?? undefined,
    ).catch(() => null)) ?? bestSnapshot.text;
  logger("Recovered follow-up assistant response after transient thinking scaffold");
  return {
    answerText: bestSnapshot.text,
    answerMarkdown: markdown,
  };
}

async function recoverExpandedReattachAnswer({
  Runtime,
  captureMarkdown,
  logger,
  matcher,
  minTurnIndex,
  timeoutMs,
  currentText,
  currentMarkdown,
  currentMeta,
}: {
  Runtime: ChromeClient["Runtime"];
  captureMarkdown: typeof captureAssistantMarkdown;
  logger: BrowserLogger;
  matcher: ReturnType<typeof buildPromptEchoMatcher>;
  minTurnIndex: number | null;
  timeoutMs: number;
  currentText: string;
  currentMarkdown: string;
  currentMeta: { turnId?: string | null; messageId?: string | null };
}): Promise<{ answerText: string; answerMarkdown: string } | null> {
  const deadline = Date.now() + Math.min(timeoutMs, 8_000);
  let bestSnapshot = {
    text: currentText.trim(),
    meta: {
      turnId: currentMeta.turnId ?? undefined,
      messageId: currentMeta.messageId ?? undefined,
    },
  };
  let improved = false;
  let stableCount = 0;
  let emptyPolls = 0;
  while (Date.now() < deadline) {
    const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex ?? undefined).catch(
      () => null,
    );
    const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
    if (!text || isTransientReattachAnswer(text) || matcher?.isEcho(text)) {
      emptyPolls += 1;
      if (emptyPolls >= 3) {
        break;
      }
      await delay(350);
      continue;
    }
    emptyPolls = 0;
    if (shouldPromoteExpandedReattachAnswer(text, bestSnapshot.text)) {
      bestSnapshot = {
        text,
        meta: {
          turnId: snapshot?.turnId ?? undefined,
          messageId: snapshot?.messageId ?? undefined,
        },
      };
      improved = true;
      stableCount = 0;
    } else if (text === bestSnapshot.text) {
      stableCount += 1;
    }
    if (stableCount >= (improved ? 2 : 3)) {
      break;
    }
    await delay(350);
  }
  if (!improved) {
    return null;
  }
  const markdown =
    (await captureMarkdown(
      Runtime,
      {
        messageId: bestSnapshot.meta.messageId ?? undefined,
        turnId: bestSnapshot.meta.turnId ?? undefined,
      },
      logger,
      minTurnIndex ?? undefined,
    ).catch(() => null)) ??
    currentMarkdown ??
    bestSnapshot.text;
  const aligned = alignPromptEchoMarkdown(bestSnapshot.text, markdown, matcher, logger);
  logger("Recovered expanded assistant response during reattach");
  return {
    answerText: aligned.answerMarkdown || aligned.answerText,
    answerMarkdown: aligned.answerMarkdown || aligned.answerText,
  };
}

async function applyConversationSettings(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  config: BrowserSessionConfig | undefined,
  deps: ReattachDeps,
): Promise<void> {
  const ensurePromptReadyForFollowup = deps.ensurePromptReady ?? ensurePromptReady;
  const ensureModel = deps.ensureModelSelection ?? ensureModelSelection;
  const ensureThinking = deps.ensureThinkingTime ?? ensureThinkingTime;
  const modelStrategy = config?.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
  if (config?.desiredModel && modelStrategy !== "ignore") {
    await withRetries(
      () => ensureModel(Runtime, config.desiredModel as string, logger, modelStrategy),
      {
        retries: 2,
        delayMs: 300,
        onRetry: (attempt, error) => {
          if (logger.verbose) {
            logger(
              `[retry] Model picker attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
            );
          }
        },
      },
    );
    await ensurePromptReadyForFollowup(Runtime, config.inputTimeoutMs ?? 60_000, logger);
  } else if (modelStrategy === "ignore") {
    logger("Model picker: skipped (strategy=ignore)");
  }
  const thinkingTime = config?.thinkingTime;
  if (thinkingTime) {
    await withRetries(() => ensureThinking(Runtime, thinkingTime, logger), {
      retries: 2,
      delayMs: 300,
      onRetry: (attempt, error) => {
        if (logger.verbose) {
          logger(
            `[retry] Thinking time (${thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
          );
        }
      },
    });
  }
}

async function submitFollowupPrompt(
  Runtime: ChromeClient["Runtime"],
  DOM: ChromeClient["DOM"] | undefined,
  Input: ChromeClient["Input"],
  logger: BrowserLogger,
  options: ContinueBrowserSessionOptions,
  config: BrowserSessionConfig | undefined,
  deps: ReattachDeps,
): Promise<string> {
  const ensurePromptReadyForFollowup = deps.ensurePromptReady ?? ensurePromptReady;
  const clearComposer = deps.clearPromptComposer ?? clearPromptComposer;
  const submit = deps.submitPrompt ?? submitPrompt;
  const clearAttachments = deps.clearComposerAttachments ?? clearComposerAttachments;
  const uploadAttachment = deps.uploadAttachmentFile ?? uploadAttachmentFile;
  const waitForAttachments = deps.waitForAttachmentCompletion ?? waitForAttachmentCompletion;
  const waitForSentAttachments = deps.waitForUserTurnAttachments ?? waitForUserTurnAttachments;
  const submitOnce = async (prompt: string, attachments: BrowserAttachment[] = []) => {
    let promptSubmitted = false;
    try {
      await ensurePromptReadyForFollowup(Runtime, config?.inputTimeoutMs ?? 60_000, logger);
      await clearComposer(Runtime, logger);
      const attachmentNames = attachments.map((attachment) => path.basename(attachment.path));
      let attachmentWaitTimedOut = false;
      let inputOnlyAttachments = false;
      if (attachments.length > 0) {
        if (!DOM) {
          throw new Error("Chrome DOM domain unavailable while uploading attachments.");
        }
        await clearAttachments(Runtime, 5_000, logger);
        for (let attachmentIndex = 0; attachmentIndex < attachments.length; attachmentIndex += 1) {
          const attachment = attachments[attachmentIndex];
          logger(`Uploading attachment: ${attachment.displayPath}`);
          const uiConfirmed = await uploadAttachment(
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
        const baseTimeout = config?.inputTimeoutMs ?? 30_000;
        const perFileTimeout = 20_000;
        const waitBudget =
          Math.max(baseTimeout, 45_000) + (attachments.length - 1) * perFileTimeout;
        try {
          await waitForAttachments(Runtime, waitBudget, attachmentNames, logger);
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
      const baselineTurns = await readConversationTurnIndex(Runtime, logger);
      await submit(
        {
          runtime: Runtime,
          input: Input,
          baselineTurns: baselineTurns ?? undefined,
          inputTimeoutMs: config?.inputTimeoutMs ?? undefined,
        },
        prompt,
        logger,
      );
      promptSubmitted = true;
      if (attachmentNames.length === 0) {
        return;
      }
      if (attachmentWaitTimedOut) {
        logger("Attachment confirmation timed out; skipping user-turn attachment verification.");
        return;
      }
      if (inputOnlyAttachments) {
        logger(
          "Attachment UI did not render before send; skipping user-turn attachment verification.",
        );
        return;
      }
      const verified = await waitForSentAttachments(Runtime, attachmentNames, 20_000, logger);
      if (!verified) {
        throw new Error("Sent user message did not expose attachment UI after upload.");
      }
      logger("Verified attachments present on sent user message");
    } catch (error) {
      if (promptSubmitted) {
        throw new BrowserAutomationError(
          error instanceof Error ? error.message : "Follow-up verification failed after send.",
          {
            stage: "followup-post-submit",
            promptSubmitted: true,
            submittedPrompt: prompt,
          },
          error,
        );
      }
      throw error;
    }
  };
  try {
    await submitOnce(options.prompt, options.attachments ?? []);
    return options.prompt;
  } catch (error) {
    const isPromptTooLarge =
      error instanceof BrowserAutomationError &&
      (error.details as { code?: string } | undefined)?.code === "prompt-too-large";
    if (options.fallbackSubmission && isPromptTooLarge) {
      logger("[browser] Inline prompt too large; retrying with file uploads.");
      await submitOnce(options.fallbackSubmission.prompt, options.fallbackSubmission.attachments);
      return options.fallbackSubmission.prompt;
    }
    throw error;
  }
}

export async function resumeBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps = {},
): Promise<ReattachResult> {
  const recoverSession =
    deps.recoverSession ??
    (async (runtimeMeta, configMeta) =>
      resumeBrowserSessionViaNewChrome(runtimeMeta, configMeta, logger, deps));

  if (!runtime.chromePort && !runtime.chromeBrowserWSEndpoint) {
    logger("No running Chrome detected; reopening browser to locate the session.");
    return recoverSession(runtime, config);
  }

  let closeConnection: (() => Promise<void>) | undefined;
  try {
    return await withHiddenExistingChrome(runtime, config, logger, async (liveRuntime) => {
      const connection = await connectToExistingRuntime(liveRuntime, logger, deps);
      closeConnection = connection.close;
      const { client, host, port, target } = connection;
      const { Runtime, DOM } = client;
      if (Runtime?.enable) {
        await Runtime.enable();
      }
      if (DOM && typeof DOM.enable === "function") {
        await DOM.enable();
      }

      const timeoutMs = config?.timeoutMs ?? 120_000;
      const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
      await withTimeout(
        Runtime.evaluate({ expression: "1+1", returnByValue: true }),
        pingTimeoutMs,
        "Reattach target did not respond",
      );
      await ensureConversationOpenForRuntime(Runtime, liveRuntime, deps.promptPreview);
      const result = await captureConversationResponse(
        Runtime,
        logger,
        deps,
        timeoutMs,
        deps.promptPreview,
      );
      const href = await readCurrentHref(Runtime);
      await connection.close().catch(() => undefined);

      return {
        ...result,
        runtime: mergeRuntimeMetadata(liveRuntime, {
          chromeHost: host,
          chromePort: port,
          chromeTargetId: target?.targetId,
          tabUrl: href || liveRuntime.tabUrl,
        }),
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(
      `Existing Chrome reattach failed (${message}); reopening browser to locate the session.`,
    );
    if (closeConnection) {
      await closeConnection().catch(() => undefined);
    }
    return recoverSession(runtime, config);
  }
}

async function resumeBrowserSessionViaNewChrome(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<ReattachResult> {
  const resolved = resolveBrowserConfig(config ?? {});
  const ensurePromptReadyForFollowup = deps.ensurePromptReady ?? ensurePromptReady;
  const manualLogin = Boolean(resolved.manualLogin);
  const userDataDir = manualLogin
    ? (resolved.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile"))
    : await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
  }
  const shouldHideChromeWindow = !resolved.headless && resolved.hideWindow;
  const frontmostTarget = shouldHideChromeWindow ? await captureFrontmostProcess(logger) : null;
  const reusedChrome = manualLogin
    ? await maybeReuseRunningChrome(userDataDir, logger, {
        waitForPortMs: resolved.reuseChromeWaitMs,
      })
    : null;
  const chrome = reusedChrome ?? (await launchChrome(resolved, userDataDir, logger));
  const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
  const strictTabIsolation = Boolean(manualLogin && reusedChrome);
  let stopChromeFocusGuard: (() => void) | null = null;
  if (shouldHideChromeWindow) {
    await hideChromeWindow(chrome, logger, frontmostTarget);
    stopChromeFocusGuard = startChromeFocusGuard(chrome, logger, frontmostTarget);
  }
  try {
    const { client, isolatedTargetId } = await connectReopenedChrome(
      chrome,
      chromeHost,
      logger,
      strictTabIsolation,
    );
    const { Network, Page, Runtime, DOM } = client;

    if (Runtime?.enable) {
      await Runtime.enable();
    }
    if (DOM && typeof DOM.enable === "function") {
      await DOM.enable();
    }

    let appliedCookies = 0;
    if (!manualLogin && resolved.cookieSync) {
      appliedCookies = await syncCookies(Network, resolved.url, resolved.chromeProfile, logger, {
        allowErrors: resolved.allowCookieErrors,
        filterNames: resolved.cookieNames ?? undefined,
        inlineCookies: resolved.inlineCookies ?? undefined,
        cookiePath: resolved.chromeCookiePath ?? undefined,
        waitMs: resolved.cookieSyncWaitMs ?? 0,
      });
    }

    await navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger);
    await ensureNotBlocked(Runtime, resolved.headless, logger);
    await ensureLoggedIn(Runtime, logger, { appliedCookies });
    if (resolved.url !== CHATGPT_URL) {
      await navigateToChatGPT(Page, Runtime, resolved.url, logger);
      await ensureNotBlocked(Runtime, resolved.headless, logger);
    }
    await ensurePromptReadyForFollowup(Runtime, resolved.inputTimeoutMs, logger);

    const conversationUrl = buildConversationUrl(runtime, resolved.url);
    if (conversationUrl) {
      logger(`Reopening conversation at ${conversationUrl}`);
      await navigateToChatGPT(Page, Runtime, conversationUrl, logger);
      await ensureNotBlocked(Runtime, resolved.headless, logger);
      await ensurePromptReadyForFollowup(Runtime, resolved.inputTimeoutMs, logger);
    } else {
      const opened = await openConversationFromSidebarWithRetry(
        Runtime,
        {
          conversationId:
            runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? ""),
          preferProjects:
            resolved.url !== CHATGPT_URL ||
            Boolean(
              runtime.tabUrl &&
              (/\/g\//.test(runtime.tabUrl) || runtime.tabUrl.includes("/project")),
            ),
          promptPreview: deps.promptPreview,
        },
        15_000,
      );
      if (!opened) {
        throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
      }
      await waitForLocationChange(Runtime, 15_000);
    }

    const result = await captureConversationResponse(
      Runtime,
      logger,
      deps,
      resolved.timeoutMs ?? 120_000,
      deps.promptPreview,
    );
    const href = await readCurrentHref(Runtime);
    await closeClient(client);
    if (isolatedTargetId && chrome.port) {
      await closeTab(chrome.port, isolatedTargetId, logger, chromeHost).catch(() => undefined);
    }

    if (!resolved.keepBrowser && !reusedChrome) {
      try {
        await chrome.kill();
      } catch {
        // ignore
      }
      if (manualLogin) {
        await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
          () => undefined,
        );
      } else {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    return {
      ...result,
      runtime: mergeRuntimeMetadata(runtime, {
        chromePid: chrome.pid,
        chromeHost,
        chromePort: chrome.port,
        chromeTargetId: isolatedTargetId ? null : undefined,
        tabUrl: href || conversationUrl || runtime.tabUrl,
        userDataDir,
        controllerPid: process.pid,
      }),
    };
  } finally {
    if (shouldHideChromeWindow) {
      await hideChromeWindow(chrome, logger).catch(() => undefined);
    }
    stopChromeFocusGuard?.();
  }
}

export async function continueBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  options: ContinueBrowserSessionOptions,
  deps: ReattachDeps = {},
): Promise<ReattachResult> {
  const prompt = options.prompt.trim();
  if (!prompt) {
    throw new Error("Prompt text is required to continue a browser session.");
  }

  const recoverSession =
    deps.recoverSession ??
    (async (runtimeMeta, configMeta) =>
      continueBrowserSessionViaNewChrome(runtimeMeta, configMeta, logger, options, deps));

  if (!runtime.chromePort && !runtime.chromeBrowserWSEndpoint) {
    logger("No running Chrome detected; reopening browser to continue the session.");
    return recoverSession(runtime, config);
  }

  let closeConnection: (() => Promise<void>) | undefined;
  let targetId: string | undefined;
  let promptSubmitted = false;
  let submittedPromptPreview = prompt;
  try {
    return await withHiddenExistingChrome(runtime, config, logger, async (liveRuntime) => {
      const connection = await connectToExistingRuntime(liveRuntime, logger, deps);
      closeConnection = connection.close;
      const { client, host, port, target } = connection;
      targetId = target?.targetId;
      const { Runtime, DOM, Input } = client;
      if (Runtime?.enable) {
        await Runtime.enable();
      }
      if (DOM && typeof DOM.enable === "function") {
        await DOM.enable();
      }

      const timeoutMs = config?.timeoutMs ?? 120_000;
      const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
      await withTimeout(
        Runtime.evaluate({ expression: "1+1", returnByValue: true }),
        pingTimeoutMs,
        "Follow-up target did not respond",
      );
      await ensureConversationOpenForRuntime(Runtime, liveRuntime, deps.promptPreview);
      await applyConversationSettings(Runtime, logger, config, deps);
      submittedPromptPreview = await submitFollowupPrompt(
        Runtime,
        DOM,
        Input,
        logger,
        options,
        config,
        deps,
      );
      promptSubmitted = true;
      const result = await captureConversationResponse(
        Runtime,
        logger,
        deps,
        timeoutMs,
        submittedPromptPreview,
      );
      const href = await readCurrentHref(Runtime);
      await connection.close().catch(() => undefined);

      return {
        ...result,
        runtime: mergeRuntimeMetadata(liveRuntime, {
          chromeHost: host,
          chromePort: port,
          chromeTargetId: target?.targetId,
          tabUrl: href || liveRuntime.tabUrl,
        }),
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (closeConnection) {
      await closeConnection().catch(() => undefined);
    }
    const postSubmitDetails =
      error instanceof BrowserAutomationError
        ? (error.details as { promptSubmitted?: boolean; submittedPrompt?: string } | undefined)
        : undefined;
    const errorPromptSubmitted = postSubmitDetails?.promptSubmitted === true;
    if (postSubmitDetails?.submittedPrompt) {
      submittedPromptPreview = postSubmitDetails.submittedPrompt;
    }
    if (promptSubmitted || errorPromptSubmitted) {
      const { recoverSession: _recoverSession, ...resumeDeps } = deps;
      logger(
        `Existing Chrome follow-up lost DevTools after sending the prompt (${message}); reopening browser to resume without resending.`,
      );
      const liveRuntime = (await refreshAttachRuntime(runtime).catch(() => runtime)) ?? runtime;
      return resumeBrowserSession(
        mergeRuntimeMetadata(liveRuntime, {
          chromeTargetId: targetId,
        }),
        config,
        logger,
        {
          ...resumeDeps,
          promptPreview: submittedPromptPreview,
        },
      );
    }
    logger(
      `Existing Chrome follow-up failed (${message}); reopening browser to continue the session.`,
    );
    return recoverSession(runtime, config);
  }
}

async function continueBrowserSessionViaNewChrome(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  options: ContinueBrowserSessionOptions,
  deps: ReattachDeps,
): Promise<ReattachResult> {
  const resolved = resolveBrowserConfig(config ?? {});
  const manualLogin = Boolean(resolved.manualLogin);
  const userDataDir = manualLogin
    ? (resolved.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile"))
    : await mkdtemp(path.join(os.tmpdir(), "oracle-followup-"));
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
  }
  const shouldHideChromeWindow = !resolved.headless && resolved.hideWindow;
  const frontmostTarget = shouldHideChromeWindow ? await captureFrontmostProcess(logger) : null;
  const reusedChrome = manualLogin
    ? await maybeReuseRunningChrome(userDataDir, logger, {
        waitForPortMs: resolved.reuseChromeWaitMs,
      })
    : null;
  const chrome = reusedChrome ?? (await launchChrome(resolved, userDataDir, logger));
  const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
  const strictTabIsolation = Boolean(manualLogin && reusedChrome);
  let stopChromeFocusGuard: (() => void) | null = null;
  if (shouldHideChromeWindow) {
    await hideChromeWindow(chrome, logger, frontmostTarget);
    stopChromeFocusGuard = startChromeFocusGuard(chrome, logger, frontmostTarget);
  }
  try {
    const { client, isolatedTargetId } = await connectReopenedChrome(
      chrome,
      chromeHost,
      logger,
      strictTabIsolation,
    );
    const { Network, Page, Runtime, DOM, Input } = client;

    if (Runtime?.enable) {
      await Runtime.enable();
    }
    if (DOM && typeof DOM.enable === "function") {
      await DOM.enable();
    }

    let appliedCookies = 0;
    if (!manualLogin && resolved.cookieSync) {
      appliedCookies = await syncCookies(Network, resolved.url, resolved.chromeProfile, logger, {
        allowErrors: resolved.allowCookieErrors,
        filterNames: resolved.cookieNames ?? undefined,
        inlineCookies: resolved.inlineCookies ?? undefined,
        cookiePath: resolved.chromeCookiePath ?? undefined,
        waitMs: resolved.cookieSyncWaitMs ?? 0,
      });
    }

    await navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger);
    await ensureNotBlocked(Runtime, resolved.headless, logger);
    await ensureLoggedIn(Runtime, logger, { appliedCookies });
    if (resolved.url !== CHATGPT_URL) {
      await navigateToChatGPT(Page, Runtime, resolved.url, logger);
      await ensureNotBlocked(Runtime, resolved.headless, logger);
    }
    await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);

    const conversationUrl = buildConversationUrl(runtime, resolved.url);
    if (conversationUrl) {
      logger(`Reopening conversation at ${conversationUrl}`);
      await navigateToChatGPT(Page, Runtime, conversationUrl, logger);
      await ensureNotBlocked(Runtime, resolved.headless, logger);
      await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);
    } else {
      await ensureConversationOpenForRuntime(Runtime, runtime, deps.promptPreview);
    }

    await applyConversationSettings(Runtime, logger, resolved, deps);
    let submittedPrompt: string;
    try {
      submittedPrompt = await submitFollowupPrompt(
        Runtime,
        DOM,
        Input,
        logger,
        options,
        resolved,
        deps,
      );
    } catch (error) {
      const postSubmitDetails =
        error instanceof BrowserAutomationError
          ? (error.details as { promptSubmitted?: boolean; submittedPrompt?: string } | undefined)
          : undefined;
      const promptWasSubmitted = postSubmitDetails?.promptSubmitted === true;
      if (!promptWasSubmitted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger(
        `[browser] Follow-up submission completed but verification failed (${message}); continuing to observe the response without resending.`,
      );
      submittedPrompt = postSubmitDetails?.submittedPrompt ?? options.prompt;
    }
    const launchedRuntime = mergeRuntimeMetadata(runtime, {
      chromePid: chrome.pid,
      chromeHost,
      chromePort: chrome.port,
      tabUrl: conversationUrl || runtime.tabUrl,
      userDataDir,
      controllerPid: process.pid,
    });
    let result: ReattachResult;
    let resumedAfterObservationFailure = false;
    try {
      result = await captureConversationResponse(
        Runtime,
        logger,
        deps,
        resolved.timeoutMs ?? 120_000,
        submittedPrompt,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resumedAfterObservationFailure = true;
      await closeClient(client);
      logger(
        `[browser] Follow-up observation failed after send (${message}); reattaching without resending.`,
      );
      try {
        result = await resumeBrowserSession(launchedRuntime, resolved, logger, {
          ...deps,
          promptPreview: submittedPrompt,
        });
      } finally {
        if (!resolved.keepBrowser && !reusedChrome) {
          await cleanupReopenedChromeLaunch(chrome, userDataDir, manualLogin, logger);
        }
      }
    }
    if (resumedAfterObservationFailure) {
      return {
        ...result,
        runtime: result.runtime ?? launchedRuntime,
      };
    }
    const href = await readCurrentHref(Runtime);
    await closeClient(client);
    if (isolatedTargetId && chrome.port) {
      await closeTab(chrome.port, isolatedTargetId, logger, chromeHost).catch(() => undefined);
    }

    if (!resolved.keepBrowser && !reusedChrome) {
      await cleanupReopenedChromeLaunch(chrome, userDataDir, manualLogin, logger);
    }

    return {
      ...result,
      runtime:
        result.runtime ??
        mergeRuntimeMetadata(launchedRuntime, {
          chromeTargetId: isolatedTargetId ? null : undefined,
          tabUrl: href || conversationUrl || runtime.tabUrl,
        }),
    };
  } finally {
    if (shouldHideChromeWindow) {
      await hideChromeWindow(chrome, logger).catch(() => undefined);
    }
    stopChromeFocusGuard?.();
  }
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  mergeRuntimeMetadata,
  openConversationFromSidebar,
};
