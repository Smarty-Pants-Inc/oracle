import type { LaunchedChrome } from "chrome-launcher";
import CDP from "chrome-remote-interface";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import {
  waitForAssistantResponse,
  captureAssistantMarkdown,
  navigateToChatGPT,
  ensureNotBlocked,
  ensureLoggedIn,
  readChatGptAccountDigest,
  ensurePromptReady,
  waitForResumedConversationHydration,
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
import { CHATGPT_ORIGINS } from "./conversationUrl.js";
import { buildConversationTurnListExpression } from "./conversationTurns.js";
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
import { normalizeChatGptAccountDigest } from "./chatgptAccount.js";
class ReattachAffinityError extends Error {}

export interface ReattachDeps {
  listTargets?: () => Promise<TargetInfoLite[]>;
  connect?: (options?: unknown) => Promise<ChromeClient>;
  waitForAssistantResponse?: typeof waitForAssistantResponse;
  captureAssistantMarkdown?: typeof captureAssistantMarkdown;
  waitForDeepResearchCompletion?: typeof waitForDeepResearchCompletion;
  waitForConversationHydration?: typeof waitForResumedConversationHydration;
  recoverSession?: (
    runtime: BrowserRuntimeMetadata,
    config: BrowserSessionConfig | undefined,
  ) => Promise<ReattachResult>;
  promptPreview?: string;
}

export interface ReattachResult {
  answerText: string;
  answerMarkdown: string;
}

function reattachConversationId(runtime: BrowserRuntimeMetadata): string | undefined {
  return runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? "");
}

function remainingReattachMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function assertReattachPageAffinity(
  Runtime: ChromeClient["Runtime"],
  expectedConversationId: string | undefined,
  expectedAccountDigest: string | undefined,
  deadline: number,
  action: string,
): Promise<void> {
  const { result } = await Runtime.evaluate({ expression: "location.href", returnByValue: true });
  const href = typeof result?.value === "string" ? result.value : "";
  let currentUrl: URL;
  try {
    currentUrl = new URL(href);
  } catch {
    throw new ReattachAffinityError(`ChatGPT page origin is unavailable before ${action}.`);
  }
  if (!(CHATGPT_ORIGINS as readonly string[]).includes(currentUrl.origin)) {
    throw new ReattachAffinityError(`ChatGPT page origin changed before ${action}.`);
  }
  if (expectedConversationId && extractConversationIdFromUrl(href) !== expectedConversationId) {
    throw new ReattachAffinityError(`ChatGPT conversation changed before ${action}.`);
  }
  if (expectedAccountDigest) {
    const remainingMs = remainingReattachMs(deadline);
    if (remainingMs <= 0) {
      throw new Error(`Reattach deadline elapsed before ${action}.`);
    }
    if ((await readChatGptAccountDigest(Runtime, remainingMs)) !== expectedAccountDigest) {
      throw new ReattachAffinityError(`ChatGPT account identity changed before ${action}.`);
    }
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
  let closeAttachedConnection: (() => Promise<void>) | null = null;
  const closeAttached = async (): Promise<void> => {
    const close = closeAttachedConnection;
    closeAttachedConnection = null;
    await close?.().catch(() => undefined);
  };

  const expectedBrowserId = config?.remoteChromeBrowserId?.trim();
  const configuredBrowserWSEndpoint = config?.remoteChromeBrowserWSEndpoint?.trim();
  const rawConfiguredAccountDigest = config?.expectedAccountDigest;
  const configuredAccountDigest = normalizeChatGptAccountDigest(rawConfiguredAccountDigest);
  if (rawConfiguredAccountDigest != null && !configuredAccountDigest) {
    throw new Error("Stored ChatGPT account identity is invalid.");
  }
  const rawRemoteAccountDigest = config?.remoteChromeAccountDigest;
  const remoteAccountDigest = normalizeChatGptAccountDigest(rawRemoteAccountDigest);
  if (rawRemoteAccountDigest != null && !remoteAccountDigest) {
    throw new Error("Stored remote Chrome account identity is invalid.");
  }
  const runtimeBrowserWSEndpoint = runtime.chromeBrowserWSEndpoint?.trim();
  const rawRuntimeAccountDigest = runtime.chatGptAccountDigest;
  const runtimeAccountDigest = normalizeChatGptAccountDigest(rawRuntimeAccountDigest);
  if (rawRuntimeAccountDigest != null && !runtimeAccountDigest) {
    throw new Error("Stored ChatGPT account identity is invalid.");
  }
  if (
    (configuredAccountDigest &&
      remoteAccountDigest &&
      configuredAccountDigest !== remoteAccountDigest) ||
    (configuredAccountDigest &&
      runtimeAccountDigest &&
      configuredAccountDigest !== runtimeAccountDigest) ||
    (remoteAccountDigest && runtimeAccountDigest && remoteAccountDigest !== runtimeAccountDigest)
  ) {
    throw new Error("Stored ChatGPT account identity is conflicting.");
  }
  const configuredRemoteChrome = config?.remoteChrome ?? undefined;
  const wrapperRemoteSession = process.env.ORACLE_WRAPPER_REMOTE_ONLY === "1";
  const identityBoundRemoteSession = Boolean(
    wrapperRemoteSession ||
    configuredRemoteChrome ||
    expectedBrowserId ||
    configuredBrowserWSEndpoint ||
    remoteAccountDigest,
  );
  const expectedRemoteAccountDigest = remoteAccountDigest ?? configuredAccountDigest;
  if (identityBoundRemoteSession) {
    if (
      !expectedBrowserId ||
      !configuredBrowserWSEndpoint ||
      !configuredRemoteChrome ||
      !expectedRemoteAccountDigest
    ) {
      throw new Error(
        "Stored remote Chrome session has no verified browser and account identity; start a fresh browser conversation through the agent wrapper.",
      );
    }
    if (browserIdFromWebSocketEndpoint(configuredBrowserWSEndpoint) !== expectedBrowserId) {
      throw new Error("Stored remote Chrome browser identity does not match its WebSocket.");
    }
    if (
      runtimeBrowserWSEndpoint &&
      browserIdFromWebSocketEndpoint(runtimeBrowserWSEndpoint) !== expectedBrowserId
    ) {
      throw new Error("Stored remote Chrome browser identity is conflicting.");
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

    const timeoutMs = config?.timeoutMs ?? 120_000;
    const responseDeadline = Date.now() + timeoutMs;
    const expectedConversationId = reattachConversationId(runtime);
    const expectedReattachAccountDigest = identityBoundRemoteSession
      ? expectedRemoteAccountDigest
      : (runtimeAccountDigest ?? configuredAccountDigest);
    const assertPageAffinity = async (action: string): Promise<void> => {
      await assertReattachPageAffinity(
        Runtime,
        expectedConversationId,
        expectedReattachAccountDigest,
        responseDeadline,
        action,
      );
    };
    const ensureConversationOpen = async () => {
      const { result } = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      const href = typeof result?.value === "string" ? result.value : "";
      if (href.includes("/c/")) {
        const currentId = extractConversationIdFromUrl(href);
        if (!expectedConversationId || (currentId && currentId === expectedConversationId)) {
          return;
        }
      }
      const opened = await openConversationFromSidebarWithRetry(
        Runtime,
        {
          conversationId: expectedConversationId,
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
    const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
    await withTimeout(
      Runtime.evaluate({ expression: "1+1", returnByValue: true }),
      pingTimeoutMs,
      "Reattach target did not respond",
    );
    await assertReattachPageAffinity(
      Runtime,
      undefined,
      expectedReattachAccountDigest,
      responseDeadline,
      "session reattach navigation",
    );
    await ensureConversationOpen();
    await assertPageAffinity("session reattach");
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
    await assertPageAffinity("reattach hydration");
    const minTurnIndex =
      (await readPromptPreviewTurnIndex(Runtime, deps.promptPreview)) ??
      (deps.promptPreview ? null : await readConversationTurnIndex(Runtime, logger));
    if (config?.researchMode === "deep") {
      const waitForDeepResearch =
        deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
      const researchResult = await withTimeout(
        waitForDeepResearch(Runtime, logger, timeoutMs, minTurnIndex ?? undefined, Page, client, {
          requireScopedTargetOwner: true,
          expectedConversationId,
          assertPageAffinity,
        }),
        timeoutMs + 5_000,
        "Reattach Deep Research response timed out",
      );
      await assertPageAffinity("reattach Deep Research final return");
      await closeAttached();
      return {
        answerText: researchResult.text,
        answerMarkdown: researchResult.text,
      };
    }
    const promptEcho = buildPromptEchoMatcher(deps.promptPreview);
    await assertPageAffinity("reattach response wait");
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
    await assertPageAffinity("reattach response capture");
    const recovered = await recoverPromptEcho(
      Runtime,
      answer,
      promptEcho,
      logger,
      minTurnIndex,
      timeoutMs,
      { expectedConversationId, assertPageAffinity },
    );
    const markdown =
      (await withTimeout(
        captureMarkdown(
          Runtime,
          recovered.meta,
          logger,
          expectedConversationId,
          assertPageAffinity,
        ),
        15_000,
        "Reattach markdown capture timed out",
      )) ?? recovered.text;
    const aligned = alignPromptEchoMarkdown(recovered.text, markdown, promptEcho, logger);

    await assertPageAffinity("reattach final return");
    await closeAttached();
    return { answerText: aligned.answerText, answerMarkdown: aligned.answerMarkdown };
  } catch (error) {
    await closeAttached();
    if (identityBoundRemoteSession || error instanceof ReattachAffinityError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger(
      `Existing Chrome reattach failed (${message}); reopening browser to locate the session.`,
    );
    return recoverSession(runtime, config);
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

  let chrome: (LaunchedChrome & { host?: string }) | null = null;
  let client: ChromeClient | null = null;
  let completed = false;
  const cleanup = async (): Promise<void> => {
    if (client && typeof client.close === "function") {
      await client.close().catch(() => undefined);
      client = null;
    }
    const shouldStopChrome = !resolved.keepBrowser || !completed;
    if (!shouldStopChrome) return;
    if (chrome) {
      try {
        await Promise.resolve(chrome.kill());
      } catch {
        // Best-effort cleanup; continue with profile cleanup.
      }
    }
    if (manualLogin) {
      if (chrome) {
        await cleanupStaleProfileState(userDataDir, logger, {
          lockRemovalMode: "never",
        }).catch(() => undefined);
      }
    } else {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  try {
    chrome = await launchChrome(resolved, userDataDir, logger);
    const chromeHost = chrome.host ?? "127.0.0.1";
    client = await connectToChrome(chrome.port, logger, chromeHost);
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

    const timeoutMs = resolved.timeoutMs ?? 120_000;
    const responseDeadline = Date.now() + timeoutMs;
    const expectedConversationId = reattachConversationId(runtime);
    const configuredAccountDigest = normalizeChatGptAccountDigest(resolved.expectedAccountDigest);
    if (resolved.expectedAccountDigest != null && !configuredAccountDigest) {
      throw new Error("Stored ChatGPT account identity is invalid.");
    }
    const runtimeAccountDigest = normalizeChatGptAccountDigest(runtime.chatGptAccountDigest);
    if (runtime.chatGptAccountDigest != null && !runtimeAccountDigest) {
      throw new Error("Stored ChatGPT account identity is invalid.");
    }
    if (
      configuredAccountDigest &&
      runtimeAccountDigest &&
      configuredAccountDigest !== runtimeAccountDigest
    ) {
      throw new Error("Stored ChatGPT account identity is conflicting.");
    }
    const expectedAccountDigest = runtimeAccountDigest ?? configuredAccountDigest;
    const assertPageAffinity = async (action: string): Promise<void> => {
      await assertReattachPageAffinity(
        Runtime,
        expectedConversationId,
        expectedAccountDigest,
        responseDeadline,
        action,
      );
    };
    await navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger);
    await ensureNotBlocked(Runtime, resolved.headless, logger);
    await ensureLoggedIn(Runtime, logger, { appliedCookies });
    await assertReattachPageAffinity(
      Runtime,
      undefined,
      expectedAccountDigest,
      responseDeadline,
      "new Chrome reattach navigation",
    );
    if (resolved.url !== CHATGPT_URL) {
      await navigateToChatGPT(Page, Runtime, resolved.url, logger);
      await ensureNotBlocked(Runtime, resolved.headless, logger);
      await assertReattachPageAffinity(
        Runtime,
        undefined,
        expectedAccountDigest,
        responseDeadline,
        "new Chrome configured page navigation",
      );
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
          conversationId: expectedConversationId,
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

    const expectedConversationUrl =
      conversationUrl ??
      (expectedConversationId ? `${CHATGPT_URL}/c/${expectedConversationId}` : undefined);
    const waitForHydration =
      deps.waitForConversationHydration ?? waitForResumedConversationHydration;
    await waitForHydration(Runtime, resolved.inputTimeoutMs, logger, {
      requirePriorTurns: true,
      requirePromptReady: false,
      expectedConversationUrl,
    });
    await assertPageAffinity("new Chrome reattach hydration");
    const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
    const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
    const minTurnIndex =
      (await readPromptPreviewTurnIndex(Runtime, deps.promptPreview)) ??
      (deps.promptPreview ? null : await readConversationTurnIndex(Runtime, logger));
    if (resolved.researchMode === "deep") {
      const waitForDeepResearch =
        deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
      const researchResult = await waitForDeepResearch(
        Runtime,
        logger,
        timeoutMs,
        minTurnIndex ?? undefined,
        Page,
        client,
        {
          requireScopedTargetOwner: true,
          expectedConversationId,
          assertPageAffinity,
        },
      );
      await assertPageAffinity("new Chrome reattach Deep Research final return");
      completed = true;
      return {
        answerText: researchResult.text,
        answerMarkdown: researchResult.text,
      };
    }
    const promptEcho = buildPromptEchoMatcher(deps.promptPreview);
    await assertPageAffinity("new Chrome reattach response wait");
    const answer = await waitForResponse(
      Runtime,
      timeoutMs,
      logger,
      minTurnIndex ?? undefined,
      expectedConversationId,
    );
    await assertPageAffinity("new Chrome reattach response capture");
    const recovered = await recoverPromptEcho(
      Runtime,
      answer,
      promptEcho,
      logger,
      minTurnIndex,
      timeoutMs,
      { expectedConversationId, assertPageAffinity },
    );
    const markdown =
      (await captureMarkdown(
        Runtime,
        recovered.meta,
        logger,
        expectedConversationId,
        assertPageAffinity,
      )) ?? recovered.text;
    const aligned = alignPromptEchoMarkdown(recovered.text, markdown, promptEcho, logger);

    await assertPageAffinity("new Chrome reattach final return");
    completed = true;
    return { answerText: aligned.answerText, answerMarkdown: aligned.answerMarkdown };
  } finally {
    await cleanup();
  }
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
};
