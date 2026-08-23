import CDP from "chrome-remote-interface";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { BrowserAutomationError } from "../oracle/errors.js";
import type {
  BrowserRunWarning,
  BrowserRuntimeMetadata,
  BrowserSessionConfig,
} from "../sessionStore.js";
import {
  waitForAssistantResponse,
  captureAssistantMarkdown,
  navigateToChatGPT,
  ensureNotBlocked,
  ensureLoggedIn,
  readChatGptAccountDigest,
  ensurePromptReady,
  waitForResumedConversationHydration,
  ensureChatGptScopeRetained,
} from "./pageActions.js";
import type { BrowserLogger, ChromeClient } from "./types.js";
import {
  launchChrome,
  connectToChrome,
  positionChromeWindowOffscreen,
  connectToRemoteChromeTarget,
  listRemoteChromeTargets,
} from "./chromeLifecycle.js";
import { resolveBrowserConfig } from "./config.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import { CHATGPT_URL } from "./constants.js";
import { delay } from "./utils.js";
import {
  buildConversationTurnListExpression,
  captureConversationUserTurnBinding,
  readBoundConversationTurn,
  type BoundConversationTurn,
  type ConversationTurnBinding,
} from "./conversationTurns.js";
import {
  browserIdFromWebSocketEndpoint,
  cleanupStaleProfileState,
  resolveRemoteChromeBrowserIdentity,
} from "./profileState.js";
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
import { waitForDeepResearchCompletion } from "./actions/deepResearch.js";
import { classifyTurnTerminal, createTerminalGateState } from "./actions/assistantResponse.js";
import { assertChatGptIdentity } from "./chatgptAccountRouter.js";
import {
  acquireOpenBrowserUseRunLock,
  connectOpenBrowserUseTab,
  prepareOpenBrowserUseChatGptRoute,
  prepareOpenBrowserUseConversationRoute,
  registerOpenBrowserUseTerminationHooks,
  resolveStoredOpenBrowserUseAffinity,
  resolveStoredOpenBrowserUseTabAffinity,
  waitForOpenBrowserUseConversationUrl,
  type OpenBrowserUseConnection,
} from "./openBrowserUse.js";

export interface ReattachDeps {
  listTargets?: () => Promise<TargetInfoLite[]>;
  connect?: (options?: unknown) => Promise<ChromeClient>;
  waitForAssistantResponse?: typeof waitForAssistantResponse;
  captureAssistantMarkdown?: typeof captureAssistantMarkdown;
  waitForDeepResearchCompletion?: typeof waitForDeepResearchCompletion;
  waitForConversationHydration?: typeof waitForResumedConversationHydration;
  acquireOpenBrowserUseRunLock?: typeof acquireOpenBrowserUseRunLock;
  connectOpenBrowserUseTab?: typeof connectOpenBrowserUseTab;
  prepareOpenBrowserUseChatGptRoute?: typeof prepareOpenBrowserUseChatGptRoute;
  prepareOpenBrowserUseConversationRoute?: typeof prepareOpenBrowserUseConversationRoute;
  waitForOpenBrowserUseConversationUrl?: typeof waitForOpenBrowserUseConversationUrl;
  recoverSession?: (
    runtime: BrowserRuntimeMetadata,
    config: BrowserSessionConfig | undefined,
  ) => Promise<ReattachResult>;
  promptPreview?: string;
  promptText?: string;
  followUpPrompts?: string[];
  promptBinding?: ConversationTurnBinding;
}

export interface ReattachResult {
  answerText: string;
  answerMarkdown: string;
  runtime?: BrowserRuntimeMetadata;
  warnings?: BrowserRunWarning[];
}
function storedConversationTurnBinding(
  runtime: BrowserRuntimeMetadata,
  explicit?: ConversationTurnBinding,
): ConversationTurnBinding | null {
  const binding: ConversationTurnBinding = {
    promptDigest: explicit?.promptDigest ?? runtime.promptDigest,
    promptTurnIndex: explicit?.promptTurnIndex ?? runtime.promptTurnIndex,
    promptTurnId: explicit?.promptTurnId ?? runtime.promptTurnId,
    promptMessageId: explicit?.promptMessageId ?? runtime.promptMessageId,
    assistantTurnIndex: explicit?.assistantTurnIndex ?? runtime.assistantTurnIndex,
    assistantTurnId: explicit?.assistantTurnId ?? runtime.assistantTurnId,
    assistantMessageId: explicit?.assistantMessageId ?? runtime.assistantMessageId,
  };
  return Object.values(binding).some((value) => value !== undefined) ? binding : null;
}

function hasExactConversationPromptBinding(binding: ConversationTurnBinding | null): boolean {
  return Boolean(
    binding?.promptTurnId ||
    binding?.promptMessageId ||
    (binding?.promptDigest && Number.isInteger(binding.promptTurnIndex)),
  );
}

function resolveReattachPromptText(
  runtime: BrowserRuntimeMetadata,
  deps: ReattachDeps,
): string | undefined {
  const submittedPrompt = runtime.submittedPromptText?.trim();
  if (submittedPrompt) return submittedPrompt;
  const hasPlannedFollowUps = (deps.followUpPrompts ?? []).some((prompt) => prompt.trim());
  return hasPlannedFollowUps ? undefined : deps.promptText?.trim() || undefined;
}

function hasPotentialSubmittedPrompt(runtime: BrowserRuntimeMetadata): boolean {
  return runtime.promptSubmitted === true || Boolean(runtime.submittedPromptText?.trim());
}

function assertPlannedFollowUpsComplete(runtime: BrowserRuntimeMetadata, deps: ReattachDeps): void {
  const followUps = (deps.followUpPrompts ?? []).map((prompt) => prompt.trim()).filter(Boolean);
  if (followUps.length === 0) return;
  const submittedPromptIndex = runtime.submittedPromptIndex;
  if (
    typeof submittedPromptIndex !== "number" ||
    !Number.isInteger(submittedPromptIndex) ||
    submittedPromptIndex < 0 ||
    submittedPromptIndex > followUps.length
  ) {
    throw new BrowserAutomationError(
      "Stored browser reattach cannot prove which planned prompt completed; refusing to mark the multi-turn session complete.",
      { stage: "browser-follow-ups", code: "follow-up-affinity-missing" },
    );
  }
  const remainingFollowUps = followUps.length - submittedPromptIndex;
  if (remainingFollowUps > 0) {
    throw new BrowserAutomationError(
      `Captured the exact submitted turn, but ${remainingFollowUps} planned browser follow-up${remainingFollowUps === 1 ? "" : "s"} remain; refusing to mark the session complete automatically.`,
      {
        stage: "browser-follow-ups",
        code: "follow-ups-pending",
        submittedPromptIndex,
        remainingFollowUps,
      },
    );
  }
  throw new BrowserAutomationError(
    "The final planned follow-up is bound, but reattach cannot prove the full multi-turn transcript; refusing to mark the session complete.",
    {
      stage: "browser-follow-ups",
      code: "follow-up-transcript-unavailable",
      submittedPromptIndex,
    },
  );
}

const BOUND_TURN_TERMINAL_CONFIG = { barConfirmCycles: 3, minStableMs: 1_200 };

async function waitForBoundAssistantTurn(
  Runtime: ChromeClient["Runtime"],
  binding: ConversationTurnBinding,
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<NonNullable<BoundConversationTurn["assistant"]>> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let gate = createTerminalGateState(Date.now());
  let loggedWaiting = false;
  for (;;) {
    const resolved = await readBoundConversationTurn(Runtime, binding);
    if (resolved.status !== "matched") {
      throw new BrowserAutomationError(
        `The stored ChatGPT user turn is ${resolved.status}; refusing to capture another turn.`,
        { stage: "chatgpt-turn-affinity", code: `turn-affinity-${resolved.status}` },
      );
    }
    const { assistant, hasLaterUserTurn } = resolved.turn;
    if (hasLaterUserTurn && !assistant?.text) {
      throw new BrowserAutomationError(
        "A later ChatGPT user turn exists before the stored turn received an assistant response.",
        { stage: "chatgpt-turn-affinity", code: "turn-affinity-interrupted" },
      );
    }
    if (assistant?.text) {
      if (hasLaterUserTurn) return assistant;
      const decision = classifyTurnTerminal(
        gate,
        {
          now: Date.now(),
          len: assistant.text.length,
          contentKey: `${assistant.messageId ?? assistant.turnId ?? assistant.index}::${assistant.text}`,
          stopVisible: false,
          barVisible: assistant.completionVisible === true,
          strongThinkingActive: false,
        },
        BOUND_TURN_TERMINAL_CONFIG,
      );
      gate = decision.state;
      if (decision.terminal) return assistant;
    } else {
      gate = createTerminalGateState(Date.now());
    }
    if (Date.now() >= deadline) {
      throw new BrowserAutomationError(
        "The stored ChatGPT turn has no completed assistant response yet.",
        { stage: "assistant-timeout", code: "bound-turn-incomplete" },
      );
    }
    if (!loggedWaiting) {
      logger("Waiting for the exact stored ChatGPT turn to complete...");
      loggedWaiting = true;
    }
    await delay(400);
  }
}

async function captureBoundAssistantResult(
  Runtime: ChromeClient["Runtime"],
  assistant: NonNullable<BoundConversationTurn["assistant"]>,
  captureMarkdown: typeof captureAssistantMarkdown,
  logger: BrowserLogger,
): Promise<Pick<ReattachResult, "answerText" | "answerMarkdown">> {
  const markdown =
    assistant.messageId || assistant.turnId
      ? await withTimeout(
          captureMarkdown(
            Runtime,
            { messageId: assistant.messageId, turnId: assistant.turnId },
            logger,
          ),
          15_000,
          "Reattach markdown capture timed out",
        ).catch(() => null)
      : null;
  return { answerText: assistant.text, answerMarkdown: markdown ?? assistant.text };
}

export async function resumeBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps = {},
): Promise<ReattachResult> {
  if (config?.browserTransport === "obu" || runtime.browserTransport === "obu") {
    return resumeBrowserSessionViaObu(runtime, config, logger, deps);
  }
  const recoverSession =
    deps.recoverSession ??
    (async (runtimeMeta, configMeta) =>
      resumeBrowserSessionViaNewChrome(runtimeMeta, configMeta, logger, deps));
  let closeAttachedConnection: (() => Promise<void>) | null = null;
  const closeAttached = async (): Promise<void> => {
    const close = closeAttachedConnection;
    closeAttachedConnection = null;
    await close?.().catch(() => undefined);
  };

  const expectedBrowserId = config?.remoteChromeBrowserId?.trim();
  const configuredBrowserWSEndpoint = config?.remoteChromeBrowserWSEndpoint?.trim();
  const expectedAccountDigest = config?.remoteChromeAccountDigest?.trim();
  const runtimeBrowserWSEndpoint = runtime.chromeBrowserWSEndpoint?.trim();
  const runtimeAccountDigest = runtime.chatGptAccountDigest?.trim();
  const configuredRemoteChrome = config?.remoteChrome ?? undefined;
  const wrapperRemoteSession = process.env.ORACLE_WRAPPER_REMOTE_ONLY === "1";
  const identityBoundRemoteSession = Boolean(
    wrapperRemoteSession ||
    configuredRemoteChrome ||
    expectedBrowserId ||
    configuredBrowserWSEndpoint ||
    expectedAccountDigest ||
    runtimeAccountDigest,
  );
  if (identityBoundRemoteSession) {
    if (
      !expectedBrowserId ||
      !configuredBrowserWSEndpoint ||
      !configuredRemoteChrome ||
      !expectedAccountDigest
    ) {
      throw new Error(
        "Stored remote Chrome session has no verified browser and account identity; start a fresh browser conversation through the agent wrapper.",
      );
    }
    if (browserIdFromWebSocketEndpoint(configuredBrowserWSEndpoint) !== expectedBrowserId) {
      throw new Error("Stored remote Chrome browser identity does not match its WebSocket.");
    }
    if (!/^[a-f0-9]{64}$/.test(expectedAccountDigest)) {
      throw new Error("Stored remote Chrome account identity is invalid.");
    }
    if (
      runtimeBrowserWSEndpoint &&
      browserIdFromWebSocketEndpoint(runtimeBrowserWSEndpoint) !== expectedBrowserId
    ) {
      throw new Error("Stored remote Chrome browser identity is conflicting.");
    }
    if (runtimeAccountDigest && runtimeAccountDigest !== expectedAccountDigest) {
      throw new Error("Stored remote Chrome account identity is conflicting.");
    }
  }

  if (!identityBoundRemoteSession && !runtime.chromePort && !runtime.chromeBrowserWSEndpoint) {
    logger("No running Chrome detected; reopening browser to locate the session.");
    return recoverSession(runtime, config);
  }

  try {
    let liveRuntime: BrowserRuntimeMetadata;
    let browserWSEndpoint: string | undefined;
    if (identityBoundRemoteSession) {
      const liveIdentity = await resolveRemoteChromeBrowserIdentity(configuredRemoteChrome!);
      if (liveIdentity.browserId !== expectedBrowserId) {
        throw new Error("Remote Chrome browser identity changed before session reattach.");
      }
      liveRuntime = {
        ...runtime,
        chromeHost: configuredRemoteChrome!.host,
        chromePort: configuredRemoteChrome!.port,
        chromeBrowserWSEndpoint: liveIdentity.browserWSEndpoint,
      };
      browserWSEndpoint = liveIdentity.browserWSEndpoint;
    } else {
      liveRuntime = (await refreshAttachRuntime(runtime).catch(() => runtime)) ?? runtime;
      browserWSEndpoint = liveRuntime.chromeBrowserWSEndpoint ?? undefined;
    }
    const host = liveRuntime.chromeHost ?? "127.0.0.1";
    const port =
      liveRuntime.chromePort ?? inferPortFromBrowserWSEndpoint(liveRuntime.chromeBrowserWSEndpoint);
    const listTargets =
      deps.listTargets ??
      (async () =>
        (await listRemoteChromeTargets({
          host,
          port: port ?? 9222,
          browserWSEndpoint,
        })) as TargetInfoLite[]);
    const targetList = (await listTargets()) as TargetInfoLite[];
    const target = pickTarget(targetList, liveRuntime);
    const connection =
      browserWSEndpoint && !deps.connect
        ? await connectToRemoteChromeTarget(host, port ?? 9222, logger, {
            browserWSEndpoint,
            targetId: target?.targetId ?? target?.id,
            closeTargetOnDispose: false,
          })
        : await (async () => {
            const client = (await (
              deps.connect ?? ((options?: unknown) => CDP(options as CDP.Options))
            )(
              browserWSEndpoint
                ? {
                    target: browserWSEndpoint,
                    local: true,
                    targetId: target?.targetId ?? target?.id,
                  }
                : {
                    host,
                    port,
                    target: target?.targetId ?? target?.id,
                  },
            )) as unknown as ChromeClient;
            return { client, close: () => client.close() };
          })();
    closeAttachedConnection = () => connection.close();

    const client: ChromeClient = connection.client;
    const { Runtime, DOM, Page } = client;
    if (Runtime?.enable) {
      await Runtime.enable();
    }
    if (DOM && typeof DOM.enable === "function") {
      await DOM.enable();
    }
    if (Page && typeof Page.enable === "function") {
      await Page.enable();
    }

    const ensureConversationOpen = async () => {
      const { result } = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      const href = typeof result?.value === "string" ? result.value : "";
      if (href.includes("/c/")) {
        const currentId = extractConversationIdFromUrl(href);
        if (!runtime.conversationId || (currentId && currentId === runtime.conversationId)) {
          return;
        }
      }
      const opened = await openConversationFromSidebarWithRetry(
        Runtime,
        {
          conversationId:
            runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? ""),
          preferProjects: true,
          promptPreview: deps.promptPreview,
        },
        15_000,
      );
      if (!opened) {
        throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
      }
      await waitForLocationChange(Runtime, 15_000);
    };

    const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
    const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
    const timeoutMs = config?.timeoutMs ?? 120_000;
    const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
    await withTimeout(
      Runtime.evaluate({ expression: "1+1", returnByValue: true }),
      pingTimeoutMs,
      "Reattach target did not respond",
    );
    if (identityBoundRemoteSession) {
      const observedAccountDigest = await readChatGptAccountDigest(Runtime);
      if (observedAccountDigest !== expectedAccountDigest) {
        throw new Error("Remote Chrome account identity changed before session reattach.");
      }
    }
    await ensureConversationOpen();
    const waitForHydration =
      deps.waitForConversationHydration ?? waitForResumedConversationHydration;
    const expectedConversationUrl = buildConversationUrl(
      runtime,
      resolveBrowserConfig(config ?? {}).url,
    );
    await waitForHydration(Runtime, timeoutMs, logger, {
      requirePriorTurns: true,
      requirePromptReady: false,
      expectedConversationUrl: expectedConversationUrl ?? undefined,
    });
    const turnBinding = storedConversationTurnBinding(runtime, deps.promptBinding);
    if (turnBinding && !hasExactConversationPromptBinding(turnBinding)) {
      throw new BrowserAutomationError(
        "Stored Chrome reattach has no exact prompt turn affinity.",
        { stage: "chatgpt-turn-affinity", code: "turn-affinity-missing" },
      );
    }
    const assertCaptureAffinity = async (): Promise<void> => {
      if (expectedConversationUrl) {
        await ensureChatGptScopeRetained(Runtime, expectedConversationUrl);
      }
      if (identityBoundRemoteSession) {
        const observedAccountDigest = await readChatGptAccountDigest(Runtime);
        if (observedAccountDigest !== expectedAccountDigest) {
          throw new Error("Remote Chrome account identity changed before response capture.");
        }
      }
    };
    if (turnBinding && config?.researchMode !== "deep") {
      const assistant = await waitForBoundAssistantTurn(Runtime, turnBinding, timeoutMs, logger);
      await assertCaptureAffinity();
      const result = await captureBoundAssistantResult(Runtime, assistant, captureMarkdown, logger);
      assertPlannedFollowUpsComplete(liveRuntime, deps);
      await closeAttached();
      return result;
    }
    const minTurnIndex =
      (await readPromptPreviewTurnIndex(Runtime, deps.promptPreview)) ??
      (deps.promptPreview ? null : await readConversationTurnIndex(Runtime, logger));
    if (config?.researchMode === "deep") {
      const waitForDeepResearch =
        deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
      const researchResult = await withTimeout(
        waitForDeepResearch(Runtime, logger, timeoutMs, minTurnIndex ?? undefined, Page, client, {
          requireScopedTargetOwner: true,
        }),
        timeoutMs + 5_000,
        "Reattach Deep Research response timed out",
      );
      if (turnBinding) {
        await waitForBoundAssistantTurn(Runtime, turnBinding, timeoutMs, logger);
      }
      await assertCaptureAffinity();
      assertPlannedFollowUpsComplete(liveRuntime, deps);
      await closeAttached();
      return {
        answerText: researchResult.text,
        answerMarkdown: researchResult.text,
      };
    }
    const promptEcho = buildPromptEchoMatcher(deps.promptPreview);
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
    const markdown =
      (await withTimeout(
        captureMarkdown(Runtime, recovered.meta, logger),
        15_000,
        "Reattach markdown capture timed out",
      )) ?? recovered.text;
    const aligned = alignPromptEchoMarkdown(recovered.text, markdown, promptEcho, logger);
    assertPlannedFollowUpsComplete(liveRuntime, deps);

    await closeAttached();
    return { answerText: aligned.answerText, answerMarkdown: aligned.answerMarkdown };
  } catch (error) {
    await closeAttached();
    if (identityBoundRemoteSession) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger(
      `Existing Chrome reattach failed (${message}); reopening browser to locate the session.`,
    );
    return recoverSession(runtime, config);
  }
}
async function resumeBrowserSessionViaObu(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<ReattachResult> {
  let conversationUrl = buildConversationUrl(runtime, resolveBrowserConfig(config ?? {}).url);
  const affinity = conversationUrl
    ? resolveStoredOpenBrowserUseAffinity({
        runtime,
        configs: [config],
        conversationUrl,
        conversationUrls: [config?.resumeConversationUrl, config?.chatgptUrl, config?.url],
      })
    : resolveStoredOpenBrowserUseTabAffinity({ runtime, configs: [config] });
  let expectedConversationId = conversationUrl
    ? extractConversationIdFromUrl(conversationUrl)
    : undefined;
  const acquireLock = deps.acquireOpenBrowserUseRunLock ?? acquireOpenBrowserUseRunLock;
  const connectTab = deps.connectOpenBrowserUseTab ?? connectOpenBrowserUseTab;
  const prepareRoute =
    deps.prepareOpenBrowserUseConversationRoute ??
    deps.prepareOpenBrowserUseChatGptRoute ??
    prepareOpenBrowserUseConversationRoute;
  const waitForConversationUrl =
    deps.waitForOpenBrowserUseConversationUrl ?? waitForOpenBrowserUseConversationUrl;

  const lock = await acquireLock({
    timeoutMs: config?.profileLockTimeoutMs ?? 300_000,
    logger,
  });
  let connection: OpenBrowserUseConnection | null = null;
  let connectionReady: Promise<OpenBrowserUseConnection> | null = null;
  const removeTerminationHooks = registerOpenBrowserUseTerminationHooks({
    connection: () => connection ?? connectionReady,
    releaseLock: () => lock.release(),
    logger,
  });
  let completed = false;
  let routeRetained = false;
  let thrownError: BrowserAutomationError | null = null;
  let assistantBinding: Pick<
    BrowserRuntimeMetadata,
    "assistantTurnIndex" | "assistantTurnId" | "assistantMessageId"
  > = {};
  let turnBinding = storedConversationTurnBinding(runtime, deps.promptBinding);
  const expectation = {
    email: affinity.email,
    workspaceName: affinity.workspaceName,
    accountDigest: affinity.accountDigest,
    workspaceDigest: affinity.workspaceDigest,
  };
  const runtimeForConnection = (useConnection = routeRetained): BrowserRuntimeMetadata => ({
    ...runtime,
    browserTransport: "obu",
    obuSessionId: useConnection
      ? (connection?.sessionId ?? affinity.sessionId)
      : affinity.sessionId,
    obuTabId: useConnection ? (connection?.tabId ?? affinity.tabId) : affinity.tabId,
    chatGptAccountEmail: affinity.email,
    chatGptWorkspaceName: affinity.workspaceName,
    chatGptAccountDigest: affinity.accountDigest,
    chatGptWorkspaceDigest: affinity.workspaceDigest,
    ...(turnBinding ?? {}),
    ...assistantBinding,
    tabUrl: conversationUrl ?? runtime.tabUrl,
    conversationId: expectedConversationId ?? runtime.conversationId,
  });
  const finalizeCompletedConnection = async (): Promise<BrowserRunWarning[] | undefined> => {
    if (!connection) return undefined;
    try {
      await connection.finalize(false);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof BrowserAutomationError ? error.details : undefined;
      logger(`[browser] Reattached answer captured, but task-tab finalization failed: ${message}`);
      return [
        {
          code: "obu-tab-finalize-failed",
          severity: "warning",
          message,
          ...(details ? { details: { ...details } } : {}),
        },
      ];
    }
  };
  try {
    connectionReady = connectTab({
      oracleSessionId: `reattach-${runtime.conversationId ?? "session"}`,
      obuSessionId: affinity.sessionId,
      obuTabId: affinity.tabId,
      exactTabOnly: !conversationUrl,
      conversationUrl,
      timeoutMs: config?.inputTimeoutMs,
      logger,
    });
    connection = await connectionReady;
    routeRetained = true;
    const { Runtime, DOM, Page } = connection.client;
    await Promise.all([Runtime.enable?.(), DOM?.enable?.(), Page?.enable?.()].filter(Boolean));
    if (!conversationUrl) {
      conversationUrl = await waitForConversationUrl({
        connection,
        timeoutMs: config?.inputTimeoutMs ?? 30_000,
      });
      expectedConversationId = extractConversationIdFromUrl(conversationUrl);
    }
    await prepareRoute({ connection, expectation, targetUrl: conversationUrl, logger });
    routeRetained = true;
    const timeoutMs = config?.timeoutMs ?? 120_000;
    const waitForHydration =
      deps.waitForConversationHydration ?? waitForResumedConversationHydration;
    await waitForHydration(Runtime, timeoutMs, logger, {
      requirePriorTurns: true,
      requirePromptReady: false,
      expectedConversationUrl: conversationUrl,
    });
    const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
    const activePromptText = resolveReattachPromptText(runtime, deps);
    const hasExactPromptBinding = hasExactConversationPromptBinding(turnBinding);
    const recoveryPromptTurnIndex =
      typeof turnBinding?.promptTurnIndex === "number" &&
      Number.isInteger(turnBinding.promptTurnIndex) &&
      turnBinding.promptTurnIndex >= 0
        ? turnBinding.promptTurnIndex
        : null;
    if (
      !hasExactPromptBinding &&
      hasPotentialSubmittedPrompt(runtime) &&
      activePromptText &&
      recoveryPromptTurnIndex !== null
    ) {
      const recovered = await captureConversationUserTurnBinding(
        Runtime,
        activePromptText,
        recoveryPromptTurnIndex,
        {
          expectedTurnIndex: recoveryPromptTurnIndex,
          attachmentNames: runtime.submittedAttachmentNames,
        },
      );
      if (recovered) {
        turnBinding = { ...turnBinding, ...recovered };
        logger(
          "[browser] Recovered exact prompt turn affinity from the stored main-Chrome conversation.",
        );
      }
    }
    const hasPromptBinding = hasExactConversationPromptBinding(turnBinding);
    if (!turnBinding || !hasPromptBinding) {
      throw new BrowserAutomationError(
        "Stored main-Chrome reattach has no exact prompt turn affinity.",
        { stage: "chatgpt-turn-affinity", code: "turn-affinity-missing" },
      );
    }
    if (config?.researchMode !== "deep") {
      const assistant = await waitForBoundAssistantTurn(Runtime, turnBinding, timeoutMs, logger);
      await ensureChatGptScopeRetained(Runtime, conversationUrl);
      await assertChatGptIdentity(Runtime, expectation);
      assistantBinding = {
        assistantTurnIndex: assistant.index,
        ...(assistant.turnId ? { assistantTurnId: assistant.turnId } : {}),
        ...(assistant.messageId ? { assistantMessageId: assistant.messageId } : {}),
      };
      const result = await captureBoundAssistantResult(Runtime, assistant, captureMarkdown, logger);
      assertPlannedFollowUpsComplete(runtimeForConnection(), deps);
      const warnings = await finalizeCompletedConnection();
      completed = true;
      return { ...result, runtime: runtimeForConnection(), warnings };
    }
    const minTurnIndex =
      (await readPromptPreviewTurnIndex(Runtime, deps.promptPreview)) ??
      (deps.promptPreview ? null : await readConversationTurnIndex(Runtime, logger));
    if (config?.researchMode === "deep") {
      const waitForDeepResearch =
        deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
      const researchResult = await withTimeout(
        waitForDeepResearch(
          Runtime,
          logger,
          timeoutMs,
          minTurnIndex ?? undefined,
          Page,
          connection.client,
          { requireScopedTargetOwner: true },
        ),
        timeoutMs + 5_000,
        "Reattach Deep Research response timed out",
      );
      const exactAssistant = await waitForBoundAssistantTurn(
        Runtime,
        turnBinding,
        timeoutMs,
        logger,
      );
      await ensureChatGptScopeRetained(Runtime, conversationUrl);
      await assertChatGptIdentity(Runtime, expectation);
      assistantBinding = {
        assistantTurnIndex: exactAssistant.index,
        ...(exactAssistant.turnId ? { assistantTurnId: exactAssistant.turnId } : {}),
        ...(exactAssistant.messageId ? { assistantMessageId: exactAssistant.messageId } : {}),
      };
      const result = { answerText: researchResult.text, answerMarkdown: researchResult.text };
      assertPlannedFollowUpsComplete(runtimeForConnection(), deps);
      const warnings = await finalizeCompletedConnection();
      completed = true;
      return { ...result, runtime: runtimeForConnection(), warnings };
    }
    const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
    const promptEcho = buildPromptEchoMatcher(deps.promptPreview);
    const answer = await withTimeout(
      waitForResponse(
        Runtime,
        timeoutMs,
        logger,
        minTurnIndex ?? undefined,
        expectedConversationId,
      ),
      timeoutMs + 5_000,
      "Reattach response timed out",
    );
    await ensureChatGptScopeRetained(Runtime, conversationUrl);
    await assertChatGptIdentity(Runtime, expectation);
    const recovered = await recoverPromptEcho(
      Runtime,
      answer,
      promptEcho,
      logger,
      minTurnIndex,
      timeoutMs,
    );
    const markdown =
      (await withTimeout(
        captureMarkdown(Runtime, recovered.meta, logger),
        15_000,
        "Reattach markdown capture timed out",
      )) ?? recovered.text;
    await ensureChatGptScopeRetained(Runtime, conversationUrl);
    const aligned = alignPromptEchoMarkdown(recovered.text, markdown, promptEcho, logger);
    assertPlannedFollowUpsComplete(runtimeForConnection(), deps);
    const warnings = await finalizeCompletedConnection();
    completed = true;
    return {
      answerText: aligned.answerText,
      answerMarkdown: aligned.answerMarkdown,
      runtime: runtimeForConnection(),
      warnings,
    };
  } catch (error) {
    let failure = error;
    if (connection) {
      try {
        if (conversationUrl) {
          await ensureChatGptScopeRetained(connection.client.Runtime, conversationUrl);
        }
        await assertChatGptIdentity(connection.client.Runtime, expectation);
      } catch (routeError) {
        if (routeError instanceof BrowserAutomationError) failure = routeError;
        routeRetained = false;
      }
    }
    const details = failure instanceof BrowserAutomationError ? failure.details : undefined;
    const delayedConversationUrl =
      details?.stage === "chatgpt-scope" && details?.code === "conversation-affinity-unavailable";
    if (
      details?.stage === "main-chrome-account-router" ||
      (details?.stage === "chatgpt-scope" && !delayedConversationUrl) ||
      details?.stage === "open-browser-use"
    ) {
      routeRetained = false;
    }
    thrownError = new BrowserAutomationError(
      failure instanceof Error ? failure.message : String(failure),
      { ...details, stage: details?.stage ?? "reattach", runtime: runtimeForConnection() },
      failure,
    );
    throw thrownError;
  } finally {
    removeTerminationHooks();
    try {
      await connection?.finalize(!completed && routeRetained);
    } catch (error) {
      if (thrownError?.details) {
        (thrownError.details as Record<string, unknown>).cleanupFailure =
          error instanceof BrowserAutomationError
            ? { message: error.message, details: error.details }
            : { message: error instanceof Error ? error.message : String(error) };
      } else {
        logger(
          `[browser] Failed to finalize main-Chrome reattach tab: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await lock.release().catch(() => undefined);
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

async function resumeBrowserSessionViaNewChrome(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<ReattachResult> {
  const resolved = resolveBrowserConfig(config ?? {});
  const manualLogin = Boolean(resolved.manualLogin);
  const userDataDir = manualLogin
    ? (resolved.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile"))
    : await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
  }
  const chrome = await launchChrome(resolved, userDataDir, logger);
  const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
  const client = await connectToChrome(chrome.port, logger, chromeHost);
  const { Network, Page, Runtime, DOM, Target } = client;

  if (Runtime?.enable) {
    await Runtime.enable();
  }
  if (DOM && typeof DOM.enable === "function") {
    await DOM.enable();
  }
  if (!resolved.headless && resolved.hideWindow) {
    await positionChromeWindowOffscreen(client, logger);
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

  await clearStaleChatGptConversationCookies(Network, Target, logger, {
    preserveConversationIds: [
      runtime.conversationId,
      extractConversationIdFromUrl(runtime.tabUrl ?? ""),
      extractConversationIdFromUrl(resolved.url),
    ],
  });

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
    const opened = await openConversationFromSidebarWithRetry(
      Runtime,
      {
        conversationId:
          runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? ""),
        preferProjects:
          resolved.url !== CHATGPT_URL ||
          Boolean(
            runtime.tabUrl && (/\/g\//.test(runtime.tabUrl) || runtime.tabUrl.includes("/project")),
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

  const waitForHydration = deps.waitForConversationHydration ?? waitForResumedConversationHydration;
  await waitForHydration(Runtime, resolved.inputTimeoutMs, logger, {
    requirePriorTurns: true,
    requirePromptReady: false,
    expectedConversationUrl: conversationUrl ?? undefined,
  });
  const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
  const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
  const turnBinding = storedConversationTurnBinding(runtime, deps.promptBinding);
  if (turnBinding && !hasExactConversationPromptBinding(turnBinding)) {
    throw new BrowserAutomationError("Stored Chrome reattach has no exact prompt turn affinity.", {
      stage: "chatgpt-turn-affinity",
      code: "turn-affinity-missing",
    });
  }
  const timeoutMs = resolved.timeoutMs ?? 120_000;
  const cleanup = async () => {
    if (client && typeof client.close === "function") {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
    if (!resolved.keepBrowser) {
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
  };
  if (turnBinding && resolved.researchMode !== "deep") {
    const assistant = await waitForBoundAssistantTurn(Runtime, turnBinding, timeoutMs, logger);
    if (conversationUrl) await ensureChatGptScopeRetained(Runtime, conversationUrl);
    const result = await captureBoundAssistantResult(Runtime, assistant, captureMarkdown, logger);
    assertPlannedFollowUpsComplete(runtime, deps);
    await cleanup();
    return result;
  }
  const minTurnIndex =
    (await readPromptPreviewTurnIndex(Runtime, deps.promptPreview)) ??
    (deps.promptPreview ? null : await readConversationTurnIndex(Runtime, logger));
  if (resolved.researchMode === "deep") {
    const waitForDeepResearch = deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
    const researchResult = await waitForDeepResearch(
      Runtime,
      logger,
      timeoutMs,
      minTurnIndex ?? undefined,
      Page,
      client,
      {
        requireScopedTargetOwner: true,
      },
    );
    if (turnBinding) {
      await waitForBoundAssistantTurn(Runtime, turnBinding, timeoutMs, logger);
    }
    if (conversationUrl) await ensureChatGptScopeRetained(Runtime, conversationUrl);
    const result = { answerText: researchResult.text, answerMarkdown: researchResult.text };
    assertPlannedFollowUpsComplete(runtime, deps);
    await cleanup();
    return result;
  }
  const promptEcho = buildPromptEchoMatcher(deps.promptPreview);
  const answer = await waitForResponse(Runtime, timeoutMs, logger, minTurnIndex ?? undefined);
  const recovered = await recoverPromptEcho(
    Runtime,
    answer,
    promptEcho,
    logger,
    minTurnIndex,
    timeoutMs,
  );
  const markdown = (await captureMarkdown(Runtime, recovered.meta, logger)) ?? recovered.text;
  const aligned = alignPromptEchoMarkdown(recovered.text, markdown, promptEcho, logger);
  assertPlannedFollowUpsComplete(runtime, deps);
  await cleanup();
  return { answerText: aligned.answerText, answerMarkdown: aligned.answerMarkdown };
}

async function readPromptPreviewTurnIndex(
  Runtime: ChromeClient["Runtime"],
  promptPreview?: string | null,
): Promise<number | null> {
  const preview = promptPreview?.trim();
  if (!preview) {
    return null;
  }
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const needle = ${JSON.stringify(preview.toLowerCase().replace(/\s+/g, " ").slice(0, 120))};
      if (!needle) return null;
      const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      const turns = ${buildConversationTurnListExpression()};
      let matched = null;
      for (const [index, node] of turns.entries()) {
        const attr = (node.getAttribute('data-message-author-role') || node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
        const isUser = attr === 'user' || Boolean(node.querySelector('[data-message-author-role="user"]'));
        if (!isUser) continue;
        const text = normalize(node.innerText || node.textContent || '');
        if (text.length > 0 && (text.includes(needle) || needle.includes(text.slice(0, needle.length)))) {
          matched = index;
        }
      }
      return matched;
    })()`,
    returnByValue: true,
  });
  return typeof result?.value === "number" ? result.value : null;
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  openConversationFromSidebar,
  readPromptPreviewTurnIndex,
  resolveReattachPromptText,
  waitForBoundAssistantTurn,
};
